package jwt

import (
	"encoding/base64"
	"fmt"
	"testing"
)

func makeTestJWT(payload string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`))
	encodedPayload := base64.RawURLEncoding.EncodeToString([]byte(payload))
	return fmt.Sprintf("%s.%s.fakesignature", header, encodedPayload)
}

func TestExtractSub(t *testing.T) {
	tests := []struct {
		name     string
		header   string
		expected string
	}{
		{"valid JWT", "Bearer " + makeTestJWT(`{"sub":"user-123","iss":"test"}`), "user-123"},
		{"valid JWT with UUID", "Bearer " + makeTestJWT(`{"sub":"d4d573f8-178d-4843-92e2-d0e3596ee18e","iss":"test"}`), "d4d573f8-178d-4843-92e2-d0e3596ee18e"},
		{"missing Bearer prefix", makeTestJWT(`{"sub":"user-123"}`), ""},
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

func TestExtractClaims(t *testing.T) {
	t.Run("all claims", func(t *testing.T) {
		jwt := "Bearer " + makeTestJWT(`{"sub":"user-1","iss":"keycloak","aud":"ui-client"}`)
		c := ExtractClaims(jwt)
		if c.Sub != "user-1" {
			t.Errorf("Sub = %q, want user-1", c.Sub)
		}
		if c.Iss != "keycloak" {
			t.Errorf("Iss = %q, want keycloak", c.Iss)
		}
		if len(c.Aud) != 1 || c.Aud[0] != "ui-client" {
			t.Errorf("Aud = %v, want [ui-client]", c.Aud)
		}
	})

	t.Run("aud as array", func(t *testing.T) {
		jwt := "Bearer " + makeTestJWT(`{"sub":"user-2","aud":["ui-client","account"]}`)
		c := ExtractClaims(jwt)
		if len(c.Aud) != 2 {
			t.Errorf("Aud length = %d, want 2", len(c.Aud))
		}
	})

	t.Run("missing aud", func(t *testing.T) {
		jwt := "Bearer " + makeTestJWT(`{"sub":"user-3","iss":"test"}`)
		c := ExtractClaims(jwt)
		if len(c.Aud) != 0 {
			t.Errorf("Aud = %v, want empty", c.Aud)
		}
	})

	t.Run("empty header", func(t *testing.T) {
		c := ExtractClaims("")
		if c.Sub != "" {
			t.Errorf("Sub = %q, want empty", c.Sub)
		}
	})
}

func TestValidateAudience(t *testing.T) {
	tests := []struct {
		name    string
		aud     Audience
		allowed []string
		want    bool
	}{
		{"match single", Audience{"ui-client"}, []string{"ui-client"}, true},
		{"match in array", Audience{"ui-client", "account"}, []string{"ui-client"}, true},
		{"no match", Audience{"other-client"}, []string{"ui-client"}, false},
		{"empty aud", Audience{}, []string{"ui-client"}, false},
		{"empty allowed", Audience{"ui-client"}, []string{}, false},
		{"multiple allowed", Audience{"account"}, []string{"ui-client", "account"}, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			claims := Claims{Sub: "test", Aud: tt.aud}
			got := ValidateAudience(claims, tt.allowed)
			if got != tt.want {
				t.Errorf("ValidateAudience() = %v, want %v", got, tt.want)
			}
		})
	}
}
