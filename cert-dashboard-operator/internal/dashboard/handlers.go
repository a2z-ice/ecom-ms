package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
)

// RenewRequest is the POST body for /api/renew.
type RenewRequest struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
}

// RenewResponse is the response for /api/renew.
type RenewResponse struct {
	StreamID string `json:"streamId"`
}

// SSEEvent is a server-sent event.
type SSEEvent struct {
	Event string `json:"event"`
	Phase string `json:"phase,omitempty"`
	Msg   string `json:"message"`
	Done  bool   `json:"done,omitempty"`
}

// Active SSE streams
var (
	streamsMu sync.RWMutex
	streams   = make(map[string]chan SSEEvent)
)

func (s *Server) handleGetCerts(w http.ResponseWriter, r *http.Request) {
	certs := s.watcher.GetCerts()
	if certs == nil {
		certs = []CertInfo{}
	}

	// Apply threshold config
	for i := range certs {
		switch {
		case certs[i].DaysRemain <= s.config.RedThresholdDays:
			certs[i].Status = "red"
		case certs[i].DaysRemain <= s.config.YellowThresholdDays:
			certs[i].Status = "yellow"
		default:
			certs[i].Status = "green"
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(certs)
}

func (s *Server) handleRenew(w http.ResponseWriter, r *http.Request) {
	var req RenewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.Name == "" || req.Namespace == "" {
		http.Error(w, `{"error":"name and namespace required"}`, http.StatusBadRequest)
		return
	}

	// Find the certificate to get secretName
	certs := s.watcher.GetCerts()
	var secretName string
	for _, c := range certs {
		if c.Name == req.Name && c.Namespace == req.Namespace {
			secretName = c.SecretName
			break
		}
	}
	if secretName == "" {
		http.Error(w, `{"error":"certificate not found"}`, http.StatusNotFound)
		return
	}

	streamID := uuid.New().String()

	ch := make(chan SSEEvent, 20)
	streamsMu.Lock()
	streams[streamID] = ch
	streamsMu.Unlock()

	// Start renewal in background — use Background context since the POST request ends immediately
	go s.performRenewal(context.Background(), req.Name, req.Namespace, secretName, streamID, ch)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(RenewResponse{StreamID: streamID})
}

func (s *Server) performRenewal(ctx context.Context, name, namespace, secretName, streamID string, ch chan SSEEvent) {
	defer func() {
		time.Sleep(2 * time.Second)
		streamsMu.Lock()
		delete(streams, streamID)
		streamsMu.Unlock()
		close(ch)
	}()

	// Get current revision
	revBefore, err := s.watcher.GetRevision(ctx, name, namespace)
	if err != nil {
		ch <- SSEEvent{Event: "status", Phase: "error", Msg: fmt.Sprintf("Failed to get current revision: %v", err)}
		ch <- SSEEvent{Event: "complete", Msg: "Renewal failed", Done: true}
		return
	}

	ch <- SSEEvent{Event: "status", Phase: "deleting-secret", Msg: fmt.Sprintf("Deleting TLS secret '%s' to trigger renewal...", secretName)}

	// Delete the secret
	if err := s.watcher.DeleteSecret(ctx, namespace, secretName); err != nil {
		ch <- SSEEvent{Event: "status", Phase: "error", Msg: fmt.Sprintf("Failed to delete secret: %v", err)}
		ch <- SSEEvent{Event: "complete", Msg: "Renewal failed", Done: true}
		return
	}

	ch <- SSEEvent{Event: "status", Phase: "waiting-issuing", Msg: "Secret deleted. Waiting for cert-manager to issue new certificate..."}

	// Wait for the certificate to become Ready
	if err := s.watcher.WaitForReady(ctx, name, namespace, 60*time.Second); err != nil {
		ch <- SSEEvent{Event: "status", Phase: "error", Msg: fmt.Sprintf("Timeout waiting for certificate: %v", err)}
		ch <- SSEEvent{Event: "complete", Msg: "Renewal timed out", Done: true}
		return
	}

	ch <- SSEEvent{Event: "status", Phase: "issued", Msg: "New certificate issued by cert-manager."}

	// Get new revision
	revAfter, _ := s.watcher.GetRevision(ctx, name, namespace)
	ch <- SSEEvent{Event: "status", Phase: "ready", Msg: fmt.Sprintf("Certificate is Ready. Revision: %d → %d", revBefore, revAfter)}

	// Refresh the watcher's cache
	s.watcher.refresh(ctx)

	ch <- SSEEvent{Event: "complete", Msg: "Renewal complete", Done: true}
	log.Printf("Certificate %s/%s renewed successfully (revision %d → %d)", namespace, name, revBefore, revAfter)
}

func (s *Server) handleSSE(w http.ResponseWriter, r *http.Request) {
	streamID := r.PathValue("streamId")
	if streamID == "" {
		http.Error(w, "streamId required", http.StatusBadRequest)
		return
	}

	streamsMu.RLock()
	ch, ok := streams[streamID]
	streamsMu.RUnlock()

	if !ok {
		http.Error(w, "stream not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	// Send initial keepalive
	fmt.Fprintf(w, ": keepalive\n\n")
	flusher.Flush()

	ctx := r.Context()
	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-keepalive.C:
			fmt.Fprintf(w, ": keepalive\n\n")
			flusher.Flush()
		case evt, open := <-ch:
			if !open {
				return
			}
			data, _ := json.Marshal(evt)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", evt.Event, string(data))
			flusher.Flush()
			if evt.Done {
				return
			}
		}
	}
}
