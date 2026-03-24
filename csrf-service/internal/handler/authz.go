package handler

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/bookstore/csrf-service/internal/jwt"
)

// SafeMethods are HTTP methods that do not require CSRF validation.
var SafeMethods = map[string]bool{
	"GET": true, "HEAD": true, "OPTIONS": true, "TRACE": true,
}

// ExtAuthzCheck is called by Envoy ext_authz for every request.
// Safe methods pass through immediately. Mutating methods require valid CSRF token.
func (h *Handler) ExtAuthzCheck(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	defer h.Metrics.ObserveDuration("authz", start)

	if SafeMethods[r.Method] {
		h.Metrics.RequestsTotal.WithLabelValues("authz_safe", "ok").Inc()
		w.WriteHeader(http.StatusOK)
		return
	}

	// Mutating method — validate CSRF token
	userID := jwt.ExtractSub(r.Header.Get("Authorization"))
	if userID == "" {
		// No JWT — let the backend handle auth (will return 401)
		h.Metrics.RequestsTotal.WithLabelValues("authz_noauth", "ok").Inc()
		w.WriteHeader(http.StatusOK)
		return
	}

	csrfToken := r.Header.Get("X-Csrf-Token")
	if csrfToken == "" {
		h.Metrics.RequestsTotal.WithLabelValues("authz_mutate", "missing_token").Inc()
		writeForbidden(w)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	valid, err := h.Store.Validate(ctx, userID, csrfToken)
	if err != nil {
		h.Metrics.RedisErrorsTotal.Inc()
		// Validate returns true on Redis error (fail-open)
		if valid {
			h.Metrics.RequestsTotal.WithLabelValues("authz_mutate", "redis_error_failopen").Inc()
			w.WriteHeader(http.StatusOK)
			return
		}
	}

	if !valid {
		h.Metrics.RequestsTotal.WithLabelValues("authz_mutate", "invalid_token").Inc()
		writeForbidden(w)
		return
	}

	h.Metrics.RequestsTotal.WithLabelValues("authz_mutate", "ok").Inc()
	w.WriteHeader(http.StatusOK)
}

func writeForbidden(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	fmt.Fprint(w, `{"type":"about:blank","title":"Forbidden","status":403,"detail":"Invalid or missing CSRF token"}`)
}
