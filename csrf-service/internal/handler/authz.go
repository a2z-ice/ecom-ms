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

	// Mutating method — validate Origin header first
	if h.Origin != nil {
		result := h.Origin.Validate(r)
		if result.Missing {
			h.Metrics.OriginChecksTotal.WithLabelValues("missing").Inc()
			h.Metrics.AnomalyTotal.WithLabelValues("origin_missing").Inc()
			if !result.Allowed {
				// RequireOrigin=true and origin is missing
				h.Metrics.RequestsTotal.WithLabelValues("authz_mutate", "origin_required").Inc()
				writeForbidden(w, "Origin header required for mutating requests")
				return
			}
		} else if !result.Allowed {
			h.Metrics.OriginChecksTotal.WithLabelValues("rejected").Inc()
			h.Metrics.AnomalyTotal.WithLabelValues("origin_mismatch").Inc()
			h.Metrics.RequestsTotal.WithLabelValues("authz_mutate", "origin_rejected").Inc()
			writeForbidden(w, "Request origin not allowed")
			return
		} else {
			h.Metrics.OriginChecksTotal.WithLabelValues("allowed").Inc()
		}
	}

	// Extract JWT claims
	authHeader := r.Header.Get("Authorization")
	claims := jwt.ExtractClaims(authHeader)
	if claims.Sub == "" {
		// No JWT — let the backend handle auth (will return 401)
		h.Metrics.RequestsTotal.WithLabelValues("authz_noauth", "ok").Inc()
		w.WriteHeader(http.StatusOK)
		return
	}

	// Audience validation (opt-in)
	if h.ValidateAudience {
		if !jwt.ValidateAudience(claims, h.AllowedAudiences) {
			h.Metrics.RequestsTotal.WithLabelValues("authz_mutate", "bad_audience").Inc()
			h.Metrics.AnomalyTotal.WithLabelValues("bad_audience").Inc()
			writeForbidden(w, "JWT audience not allowed")
			return
		}
	}

	csrfToken := r.Header.Get("X-Csrf-Token")
	if csrfToken == "" {
		h.Metrics.RequestsTotal.WithLabelValues("authz_mutate", "missing_token").Inc()
		writeForbidden(w, "Invalid or missing CSRF token")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	reqOrigin := r.Header.Get("Origin")
	valid, err := h.Store.Validate(ctx, claims.Sub, csrfToken, reqOrigin)
	if err != nil {
		h.Metrics.RedisErrorsTotal.Inc()
		if valid {
			// Fail-open: Redis error but validation returned true
			h.Metrics.RequestsTotal.WithLabelValues("authz_mutate", "redis_error_failopen").Inc()
			w.WriteHeader(http.StatusOK)
			return
		}
		// Fail-closed: Redis error and validation returned false
		h.Metrics.RequestsTotal.WithLabelValues("authz_mutate", "redis_error_failclosed").Inc()
		writeServiceUnavailable(w)
		return
	}

	if !valid {
		h.Metrics.RequestsTotal.WithLabelValues("authz_mutate", "invalid_token").Inc()
		h.Metrics.AnomalyTotal.WithLabelValues("cross_user_token").Inc()
		writeForbidden(w, "Invalid or missing CSRF token")
		return
	}

	h.Metrics.RequestsTotal.WithLabelValues("authz_mutate", "ok").Inc()
	w.WriteHeader(http.StatusOK)
}

func writeForbidden(w http.ResponseWriter, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	fmt.Fprintf(w, `{"type":"about:blank","title":"Forbidden","status":403,"detail":"%s"}`, detail)
}

func writeServiceUnavailable(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	fmt.Fprint(w, `{"type":"about:blank","title":"Service Unavailable","status":503,"detail":"Security validation temporarily unavailable"}`)
}
