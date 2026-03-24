package jwt

import (
	"encoding/base64"
	"fmt"
	"testing"
)

func makeJWT(sub string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"sub":"%s","iss":"test"}`, sub)))
	return fmt.Sprintf("%s.%s.fakesignature", header, payload)
}

func TestExtractSub(t *testing.T) {
	tests := []struct {
		name     string
		header   string
		expected string
	}{
		{"valid JWT", "Bearer " + makeJWT("user-123"), "user-123"},
		{"valid JWT with UUID", "Bearer " + makeJWT("d4d573f8-178d-4843-92e2-d0e3596ee18e"), "d4d573f8-178d-4843-92e2-d0e3596ee18e"},
		{"missing Bearer prefix", makeJWT("user-123"), ""},
		{"empty string", "", ""},
		{"Bearer only", "Bearer ", ""},
		{"malformed JWT - 2 parts", "Bearer header.payload", ""},
		{"malformed base64", "Bearer x.!!!invalid!!!.z", ""},
		{"valid base64 but no sub",
			"Bearer " + base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`)) +
				"." + base64.RawURLEncoding.EncodeToString([]byte(`{"iss":"test"}`)) + ".sig",
			""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ExtractSub(tt.header)
			if got != tt.expected {
				t.Errorf("ExtractSub(%q) = %q, want %q", tt.header, got, tt.expected)
			}
		})
	}
}
