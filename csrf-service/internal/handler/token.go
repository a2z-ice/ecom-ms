// Package handler provides HTTP handlers for the CSRF service.
package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/bookstore/csrf-service/internal/jwt"
	"github.com/bookstore/csrf-service/internal/middleware"
	"github.com/bookstore/csrf-service/internal/store"
)

// Handler holds dependencies for all HTTP handlers.
type Handler struct {
	Store   store.TokenStore
	Metrics *middleware.Metrics
}

// New creates a Handler with injected dependencies.
func New(s store.TokenStore, m *middleware.Metrics) *Handler {
	return &Handler{Store: s, Metrics: m}
}

// GenerateToken creates a new CSRF token for the authenticated user.
func (h *Handler) GenerateToken(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	defer h.Metrics.ObserveDuration("generate", start)

	userID := jwt.ExtractSub(r.Header.Get("Authorization"))
	if userID == "" {
		h.Metrics.RequestsTotal.WithLabelValues("generate", "unauthorized").Inc()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"type":"about:blank","title":"Unauthorized","status":401,"detail":"Missing or invalid JWT"}`)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	token, err := h.Store.Generate(ctx, userID)
	if err != nil {
		h.Metrics.RedisErrorsTotal.Inc()
	}

	h.Metrics.RequestsTotal.WithLabelValues("generate", "ok").Inc()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": token})
}
