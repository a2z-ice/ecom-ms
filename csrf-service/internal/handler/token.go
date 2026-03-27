// Package handler provides HTTP handlers for the CSRF service.
package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/bookstore/csrf-service/internal/introspect"
	"github.com/bookstore/csrf-service/internal/jwt"
	"github.com/bookstore/csrf-service/internal/middleware"
	"github.com/bookstore/csrf-service/internal/origin"
	"github.com/bookstore/csrf-service/internal/ratelimit"
	"github.com/bookstore/csrf-service/internal/store"
)

// Handler holds dependencies for all HTTP handlers.
type Handler struct {
	Store            store.TokenStore
	Metrics          *middleware.Metrics
	Origin           *origin.Validator
	RateLimiter      ratelimit.Limiter
	Introspector     introspect.Introspector
	AllowedAudiences []string
	ValidateAudience bool
}

// New creates a Handler with injected dependencies.
func New(s store.TokenStore, m *middleware.Metrics, ov *origin.Validator, rl ratelimit.Limiter, intr introspect.Introspector, allowedAud []string, validateAud bool) *Handler {
	return &Handler{
		Store:            s,
		Metrics:          m,
		Origin:           ov,
		RateLimiter:      rl,
		Introspector:     intr,
		AllowedAudiences: allowedAud,
		ValidateAudience: validateAud,
	}
}

// GenerateToken creates a new CSRF token for the authenticated user.
func (h *Handler) GenerateToken(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	defer h.Metrics.ObserveDuration("generate", start)

	authHeader := r.Header.Get("Authorization")
	claims := jwt.ExtractClaims(authHeader)
	if claims.Sub == "" {
		h.Metrics.RequestsTotal.WithLabelValues("generate", "unauthorized").Inc()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"type":"about:blank","title":"Unauthorized","status":401,"detail":"Missing or invalid JWT"}`)
		return
	}

	// Audience validation (opt-in)
	if h.ValidateAudience {
		if !jwt.ValidateAudience(claims, h.AllowedAudiences) {
			h.Metrics.RequestsTotal.WithLabelValues("generate", "bad_audience").Inc()
			h.Metrics.AnomalyTotal.WithLabelValues("bad_audience").Inc()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprint(w, `{"type":"about:blank","title":"Forbidden","status":403,"detail":"JWT audience not allowed"}`)
			return
		}
	}

	// Rate limiting
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	allowed, rlErr := h.RateLimiter.Allow(ctx, claims.Sub)
	if rlErr != nil {
		h.Metrics.RedisErrorsTotal.Inc()
		h.Metrics.RateLimitTotal.WithLabelValues("error_failopen").Inc()
	} else if !allowed {
		h.Metrics.RequestsTotal.WithLabelValues("generate", "rate_limited").Inc()
		h.Metrics.RateLimitTotal.WithLabelValues("rejected").Inc()
		h.Metrics.AnomalyTotal.WithLabelValues("rapid_regeneration").Inc()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "60")
		w.WriteHeader(http.StatusTooManyRequests)
		fmt.Fprint(w, `{"type":"about:blank","title":"Too Many Requests","status":429,"detail":"Rate limit exceeded"}`)
		return
	} else {
		h.Metrics.RateLimitTotal.WithLabelValues("allowed").Inc()
	}

	reqOrigin := r.Header.Get("Origin")
	token, err := h.Store.Generate(ctx, claims.Sub, reqOrigin)
	if err != nil {
		h.Metrics.RedisErrorsTotal.Inc()
	}

	if token == "" {
		// Fail-closed: Redis error and no token returned
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"type":"about:blank","title":"Service Unavailable","status":503,"detail":"Security validation temporarily unavailable"}`)
		return
	}

	h.Metrics.RequestsTotal.WithLabelValues("generate", "ok").Inc()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": token})
}
