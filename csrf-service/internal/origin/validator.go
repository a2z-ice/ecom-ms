// Package origin validates request Origin and Referer headers against an allowed list.
package origin

import (
	"net/http"
	"net/url"
)

// Validator checks Origin (or Referer fallback) against allowed origins.
type Validator struct {
	allowed map[string]bool
	require bool // Reject if both Origin and Referer are missing on mutating requests
}

// NewValidator creates an OriginValidator from the allowed list.
func NewValidator(origins []string, require bool) *Validator {
	m := make(map[string]bool, len(origins))
	for _, o := range origins {
		m[o] = true
	}
	return &Validator{allowed: m, require: require}
}

// Result holds the origin validation outcome.
type Result struct {
	Allowed bool   // Whether the origin is in the allowed list
	Origin  string // The resolved origin (from Origin or Referer header)
	Missing bool   // True if both Origin and Referer were absent
}

// Validate checks the request's Origin header (falling back to Referer).
func (v *Validator) Validate(r *http.Request) Result {
	origin := r.Header.Get("Origin")
	// Browsers send "null" (the literal string) for privacy-sensitive cross-origin
	// navigations (e.g., OIDC form submissions). Treat as missing.
	if origin == "" || origin == "null" {
		origin = ""
		// Fallback: extract scheme://host from Referer
		ref := r.Header.Get("Referer")
		if ref != "" {
			if u, err := url.Parse(ref); err == nil && u.Host != "" {
				origin = u.Scheme + "://" + u.Host
			}
		}
	}

	if origin == "" {
		return Result{Allowed: !v.require, Origin: "", Missing: true}
	}

	return Result{Allowed: v.allowed[origin], Origin: origin, Missing: false}
}
