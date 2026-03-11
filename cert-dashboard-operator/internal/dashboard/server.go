package dashboard

import (
	"context"
	"embed"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed templates/*
var templateFS embed.FS

// Config holds dashboard server configuration.
type Config struct {
	Port                int
	Namespaces          []string
	YellowThresholdDays int
	RedThresholdDays    int
}

// ConfigFromEnv reads dashboard configuration from environment variables.
func ConfigFromEnv() Config {
	port := 8080
	if p, err := strconv.Atoi(os.Getenv("DASHBOARD_PORT")); err == nil {
		port = p
	}

	yellowDays := 10
	if d, err := strconv.Atoi(os.Getenv("YELLOW_THRESHOLD_DAYS")); err == nil {
		yellowDays = d
	}

	redDays := 5
	if d, err := strconv.Atoi(os.Getenv("RED_THRESHOLD_DAYS")); err == nil {
		redDays = d
	}

	var namespaces []string
	if ns := os.Getenv("NAMESPACES"); ns != "" {
		namespaces = strings.Split(ns, ",")
	}

	return Config{
		Port:                port,
		Namespaces:          namespaces,
		YellowThresholdDays: yellowDays,
		RedThresholdDays:    redDays,
	}
}

// Server is the dashboard HTTP server.
type Server struct {
	config    Config
	watcher   CertProvider
	mux       *http.ServeMux
	streamsMu sync.RWMutex
	streams   map[string]chan SSEEvent
}

// NewServer creates a new dashboard server.
func NewServer(config Config) (*Server, error) {
	watcher, err := NewCertWatcher(config.Namespaces)
	if err != nil {
		return nil, fmt.Errorf("creating cert watcher: %w", err)
	}

	return NewServerWithProvider(config, watcher), nil
}

// NewServerWithProvider creates a server with a custom CertProvider (for testing).
func NewServerWithProvider(config Config, provider CertProvider) *Server {
	s := &Server{
		config:  config,
		watcher: provider,
		mux:     http.NewServeMux(),
		streams: make(map[string]chan SSEEvent),
	}

	s.mux.HandleFunc("GET /", s.handleIndex)
	s.mux.HandleFunc("GET /style.css", s.handleStatic("templates/style.css", "text/css"))
	s.mux.HandleFunc("GET /app.js", s.handleStatic("templates/app.js", "application/javascript"))
	s.mux.HandleFunc("GET /api/certs", s.handleGetCerts)
	s.mux.HandleFunc("POST /api/renew", s.requireAuth(s.handleRenew))
	s.mux.HandleFunc("GET /api/sse/{streamId}", s.handleSSE)
	s.mux.HandleFunc("GET /healthz", s.handleHealthz)
	s.mux.Handle("GET /metrics", MetricsHandler())

	return s
}

// Run starts the server and blocks until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	go s.watcher.Start(ctx)

	addr := fmt.Sprintf(":%d", s.config.Port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       120 * time.Second,
		// WriteTimeout intentionally omitted — SSE streams are long-lived
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdownCtx)
	}()

	log.Printf("Dashboard server listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	data, err := templateFS.ReadFile("templates/index.html")
	if err != nil {
		http.Error(w, "template not found", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(data)
}

func (s *Server) handleStatic(path, contentType string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, err := templateFS.ReadFile(path)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.Write(data)
	}
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"ok"}`))
}
