// Package jwt provides JWT claim extraction without signature verification.
// Istio RequestAuthentication validates the JWT upstream; this package only
// decodes the base64url payload to read claims.
package jwt

import (
	"encoding/base64"
	"encoding/json"
	"strings"
)

// Claims holds the decoded JWT claims relevant to CSRF validation.
type Claims struct {
	Sub string   `json:"sub"`
	Aud Audience `json:"aud"`
	Iss string   `json:"iss"`
}

// Audience handles the JWT "aud" claim which can be a string or []string per RFC 7519.
type Audience []string

func (a *Audience) UnmarshalJSON(data []byte) error {
	// Try as string first
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		*a = Audience{s}
		return nil
	}
	// Try as array
	var arr []string
	if err := json.Unmarshal(data, &arr); err != nil {
		return err
	}
	*a = Audience(arr)
	return nil
}

// ExtractSub decodes the JWT payload and returns the "sub" claim.
// Returns empty string if the Authorization header is missing, malformed,
// or does not contain a sub claim.
func ExtractSub(authHeader string) string {
	claims := ExtractClaims(authHeader)
	return claims.Sub
}

// ExtractClaims decodes the JWT payload and returns all relevant claims.
func ExtractClaims(authHeader string) Claims {
	if !strings.HasPrefix(authHeader, "Bearer ") {
		return Claims{}
	}
	token := strings.TrimPrefix(authHeader, "Bearer ")
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Claims{}
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Claims{}
	}

	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return Claims{}
	}
	return claims
}

// ValidateAudience checks if any of the JWT's audience values match the allowed list.
func ValidateAudience(claims Claims, allowed []string) bool {
	if len(claims.Aud) == 0 || len(allowed) == 0 {
		return false
	}
	for _, claimAud := range claims.Aud {
		for _, a := range allowed {
			if claimAud == a {
				return true
			}
		}
	}
	return false
}
