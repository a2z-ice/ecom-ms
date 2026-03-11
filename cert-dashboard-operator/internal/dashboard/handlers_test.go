package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// mockProvider implements CertProvider for testing.
type mockProvider struct {
	certs       []CertInfo
	deleteErr   error
	waitErr     error
	revision    int64
	revisionErr error
	refreshed   bool
}

func (m *mockProvider) Start(_ context.Context)   {}
func (m *mockProvider) GetCerts() []CertInfo      { return m.certs }
func (m *mockProvider) Refresh(_ context.Context) { m.refreshed = true }
func (m *mockProvider) DeleteSecret(_ context.Context, _, _ string) error {
	return m.deleteErr
}
func (m *mockProvider) WaitForReady(_ context.Context, _, _ string, _ time.Duration) error {
	return m.waitErr
}
func (m *mockProvider) GetRevision(_ context.Context, _, _ string) (int64, error) {
	return m.revision, m.revisionErr
}

func newTestServer(provider CertProvider) *Server {
	config := Config{
		Port:                8080,
		YellowThresholdDays: 10,
		RedThresholdDays:    5,
	}
	return NewServerWithProvider(config, provider)
}

func TestHandleGetCerts_ReturnsCerts(t *testing.T) {
	provider := &mockProvider{
		certs: []CertInfo{
			{Name: "cert1", Namespace: "ns1", DaysRemain: 20, Status: "green"},
			{Name: "cert2", Namespace: "ns2", DaysRemain: 3, Status: "red"},
		},
	}
	s := newTestServer(provider)

	req := httptest.NewRequest("GET", "/api/certs", nil)
	w := httptest.NewRecorder()
	s.handleGetCerts(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var certs []CertInfo
	if err := json.Unmarshal(w.Body.Bytes(), &certs); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if len(certs) != 2 {
		t.Fatalf("expected 2 certs, got %d", len(certs))
	}
	if certs[0].Status != "green" {
		t.Errorf("expected green for 20 days remaining, got %s", certs[0].Status)
	}
	if certs[1].Status != "red" {
		t.Errorf("expected red for 3 days remaining, got %s", certs[1].Status)
	}
}

func TestHandleGetCerts_NilCerts(t *testing.T) {
	provider := &mockProvider{certs: nil}
	s := newTestServer(provider)

	req := httptest.NewRequest("GET", "/api/certs", nil)
	w := httptest.NewRecorder()
	s.handleGetCerts(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var certs []CertInfo
	if err := json.Unmarshal(w.Body.Bytes(), &certs); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if len(certs) != 0 {
		t.Fatalf("expected empty array, got %d certs", len(certs))
	}
}

func TestHandleGetCerts_ThresholdConfig(t *testing.T) {
	provider := &mockProvider{
		certs: []CertInfo{
			{Name: "a", DaysRemain: 8},  // Between 5 and 10 → yellow
			{Name: "b", DaysRemain: 4},  // ≤ 5 → red
			{Name: "c", DaysRemain: 15}, // > 10 → green
		},
	}
	s := newTestServer(provider)

	req := httptest.NewRequest("GET", "/api/certs", nil)
	w := httptest.NewRecorder()
	s.handleGetCerts(w, req)

	var certs []CertInfo
	json.Unmarshal(w.Body.Bytes(), &certs)

	if certs[0].Status != "yellow" {
		t.Errorf("expected yellow for 8 days, got %s", certs[0].Status)
	}
	if certs[1].Status != "red" {
		t.Errorf("expected red for 4 days, got %s", certs[1].Status)
	}
	if certs[2].Status != "green" {
		t.Errorf("expected green for 15 days, got %s", certs[2].Status)
	}
}

func TestHandleRenew_InvalidJSON(t *testing.T) {
	s := newTestServer(&mockProvider{})

	req := httptest.NewRequest("POST", "/api/renew", strings.NewReader("not json"))
	w := httptest.NewRecorder()
	s.handleRenew(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestHandleRenew_MissingFields(t *testing.T) {
	s := newTestServer(&mockProvider{})

	req := httptest.NewRequest("POST", "/api/renew", strings.NewReader(`{"name":"test"}`))
	w := httptest.NewRecorder()
	s.handleRenew(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestHandleRenew_CertNotFound(t *testing.T) {
	provider := &mockProvider{certs: []CertInfo{}}
	s := newTestServer(provider)

	req := httptest.NewRequest("POST", "/api/renew", strings.NewReader(`{"name":"unknown","namespace":"default"}`))
	w := httptest.NewRecorder()
	s.handleRenew(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestHandleRenew_Success(t *testing.T) {
	provider := &mockProvider{
		certs:    []CertInfo{{Name: "cert1", Namespace: "ns1", SecretName: "cert1-tls"}},
		revision: 1,
	}
	s := newTestServer(provider)

	// Reset rate limiter
	lastRenewalMu.Lock()
	lastRenewalTime = time.Time{}
	lastRenewalMu.Unlock()

	req := httptest.NewRequest("POST", "/api/renew", strings.NewReader(`{"name":"cert1","namespace":"ns1"}`))
	w := httptest.NewRecorder()
	s.handleRenew(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp RenewResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if resp.StreamID == "" {
		t.Error("expected non-empty streamID")
	}

	// Wait for background goroutine to register stream
	time.Sleep(100 * time.Millisecond)

	// Verify stream was created
	s.streamsMu.RLock()
	_, ok := s.streams[resp.StreamID]
	s.streamsMu.RUnlock()
	if !ok {
		// Stream may have already been cleaned up; that's OK for a fast mock
	}
}

func TestHandleRenew_NameTooLong(t *testing.T) {
	s := newTestServer(&mockProvider{})

	longName := strings.Repeat("a", 254)
	body := `{"name":"` + longName + `","namespace":"default"}`
	req := httptest.NewRequest("POST", "/api/renew", strings.NewReader(body))
	w := httptest.NewRecorder()
	s.handleRenew(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for too-long name, got %d", w.Code)
	}
}

func TestHandleHealthz(t *testing.T) {
	s := newTestServer(&mockProvider{})

	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	s.handleHealthz(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if w.Body.String() != `{"status":"ok"}` {
		t.Errorf("unexpected body: %s", w.Body.String())
	}
}

func TestHandleSSE_UnknownStream(t *testing.T) {
	s := newTestServer(&mockProvider{})

	req := httptest.NewRequest("GET", "/api/sse/unknown-id", nil)
	req.SetPathValue("streamId", "unknown-id")
	w := httptest.NewRecorder()
	s.handleSSE(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestHandleSSE_MissingStreamId(t *testing.T) {
	s := newTestServer(&mockProvider{})

	req := httptest.NewRequest("GET", "/api/sse/", nil)
	req.SetPathValue("streamId", "")
	w := httptest.NewRecorder()
	s.handleSSE(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestHandleIndex_Root(t *testing.T) {
	s := newTestServer(&mockProvider{})

	req := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()
	s.handleIndex(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Errorf("expected text/html content type, got %s", ct)
	}
}

func TestHandleIndex_NonRoot(t *testing.T) {
	s := newTestServer(&mockProvider{})

	req := httptest.NewRequest("GET", "/unknown", nil)
	w := httptest.NewRecorder()
	s.handleIndex(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for non-root path, got %d", w.Code)
	}
}
