// Package jwt provides JWT claim extraction without signature verification.
// Istio RequestAuthentication validates the JWT upstream; this package only
// decodes the base64url payload to read the "sub" claim.
package jwt

import (
	"encoding/base64"
	"encoding/json"
	"strings"
)

// ExtractSub decodes the JWT payload and returns the "sub" claim.
// Returns empty string if the Authorization header is missing, malformed,
// or does not contain a sub claim.
func ExtractSub(authHeader string) string {
	if !strings.HasPrefix(authHeader, "Bearer ") {
		return ""
	}
	token := strings.TrimPrefix(authHeader, "Bearer ")
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}

	var claims struct {
		Sub string `json:"sub"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ""
	}
	return claims.Sub
}
