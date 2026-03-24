package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// setupTestRedis creates a miniredis instance and wires the global rdb client.
func setupTestRedis(t *testing.T) *miniredis.Miniredis {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	rdb = redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { mr.Close() })
	return mr
}

// makeJWT creates a fake JWT with the given sub claim (no signature verification needed).
func makeJWT(sub string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"sub":"%s","iss":"test"}`, sub)))
	return fmt.Sprintf("%s.%s.fakesignature", header, payload)
}

// ── extractSubFromJWT tests ─────────────────────────────────────────────────

func TestExtractSubFromJWT(t *testing.T) {
	tests := []struct {
		name     string
		header   string
		expected string
	}{
		{"valid JWT", "Bearer " + makeJWT("user-123"), "user-123"},
		{"valid JWT with UUID sub", "Bearer " + makeJWT("d4d573f8-178d-4843-92e2-d0e3596ee18e"), "d4d573f8-178d-4843-92e2-d0e3596ee18e"},
		{"missing Bearer prefix", makeJWT("user-123"), ""},
		{"empty string", "", ""},
		{"Bearer only", "Bearer ", ""},
		{"malformed JWT - 2 parts", "Bearer header.payload", ""},
		{"malformed base64", "Bearer x.!!!invalid!!!.z", ""},
		{"valid base64 but no sub", "Bearer " + base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`)) + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"iss":"test"}`)) + ".sig", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractSubFromJWT(tt.header)
			if got != tt.expected {
				t.Errorf("extractSubFromJWT(%q) = %q, want %q", tt.header, got, tt.expected)
			}
		})
	}
}

// ── handleGenerateToken tests ───────────────────────────────────────────────

func TestHandleGenerateToken_NoJWT(t *testing.T) {
	setupTestRedis(t)
	req := httptest.NewRequest("GET", "/csrf/token", nil)
	w := httptest.NewRecorder()
	handleGenerateToken(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestHandleGenerateToken_ValidJWT(t *testing.T) {
	mr := setupTestRedis(t)
	jwt := makeJWT("test-user")
	req := httptest.NewRequest("GET", "/csrf/token", nil)
	req.Header.Set("Authorization", "Bearer "+jwt)
	w := httptest.NewRecorder()
	handleGenerateToken(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var body map[string]string
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	token := body["token"]
	if token == "" {
		t.Error("expected non-empty token")
	}
	if len(token) < 10 {
		t.Errorf("token too short: %q", token)
	}

	// Verify token is stored in Redis
	stored, err := mr.Get("csrf:test-user")
	if err != nil {
		t.Fatal(err)
	}
	if stored != token {
		t.Errorf("Redis stored %q, response was %q", stored, token)
	}
}

// ── handleExtAuthzCheck tests ───────────────────────────────────────────────

func TestExtAuthzCheck_SafeMethods(t *testing.T) {
	setupTestRedis(t)
	for _, method := range []string{"GET", "HEAD", "OPTIONS", "TRACE"} {
		t.Run(method, func(t *testing.T) {
			req := httptest.NewRequest(method, "/", nil)
			w := httptest.NewRecorder()
			handleExtAuthzCheck(w, req)
			if w.Code != http.StatusOK {
				t.Errorf("%s: expected 200, got %d", method, w.Code)
			}
		})
	}
}

func TestExtAuthzCheck_MutatingNoAuth(t *testing.T) {
	setupTestRedis(t)
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	w := httptest.NewRecorder()
	handleExtAuthzCheck(w, req)

	// No JWT — pass through (backend handles 401)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 (pass-through), got %d", w.Code)
	}
}

func TestExtAuthzCheck_MutatingWithAuth_NoCsrf(t *testing.T) {
	setupTestRedis(t)
	jwt := makeJWT("user-1")
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+jwt)
	w := httptest.NewRecorder()
	handleExtAuthzCheck(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "CSRF") {
		t.Errorf("expected CSRF in body, got %q", w.Body.String())
	}
}

func TestExtAuthzCheck_MutatingWithAuth_InvalidCsrf(t *testing.T) {
	mr := setupTestRedis(t)
	mr.Set("csrf:user-2", "correct-token")
	jwt := makeJWT("user-2")

	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("X-Csrf-Token", "wrong-token")
	w := httptest.NewRecorder()
	handleExtAuthzCheck(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}
}

func TestExtAuthzCheck_MutatingWithAuth_ValidCsrf(t *testing.T) {
	mr := setupTestRedis(t)
	mr.Set("csrf:user-3", "valid-token-abc")
	jwt := makeJWT("user-3")

	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("X-Csrf-Token", "valid-token-abc")
	w := httptest.NewRecorder()
	handleExtAuthzCheck(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestExtAuthzCheck_PUT_RequiresCsrf(t *testing.T) {
	setupTestRedis(t)
	jwt := makeJWT("user-4")
	req := httptest.NewRequest("PUT", "/inven/admin/stock/123", nil)
	req.Header.Set("Authorization", "Bearer "+jwt)
	w := httptest.NewRecorder()
	handleExtAuthzCheck(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for PUT without CSRF, got %d", w.Code)
	}
}

func TestExtAuthzCheck_DELETE_RequiresCsrf(t *testing.T) {
	setupTestRedis(t)
	jwt := makeJWT("user-5")
	req := httptest.NewRequest("DELETE", "/ecom/admin/books/123", nil)
	req.Header.Set("Authorization", "Bearer "+jwt)
	w := httptest.NewRecorder()
	handleExtAuthzCheck(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for DELETE without CSRF, got %d", w.Code)
	}
}

func TestExtAuthzCheck_NoStoredToken(t *testing.T) {
	setupTestRedis(t) // Empty Redis — no token stored
	jwt := makeJWT("user-6")
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("X-Csrf-Token", "some-token")
	w := httptest.NewRecorder()
	handleExtAuthzCheck(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 (no stored token), got %d", w.Code)
	}
}

// ── handleHealthz tests ─────────────────────────────────────────────────────

func TestHealthz_RedisUp(t *testing.T) {
	setupTestRedis(t)
	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	handleHealthz(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "ok") {
		t.Errorf("expected 'ok' in body, got %q", w.Body.String())
	}
}

func TestHealthz_RedisDown(t *testing.T) {
	mr := setupTestRedis(t)
	mr.Close() // Kill Redis
	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	handleHealthz(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 when Redis is down, got %d", w.Code)
	}
}

// ── handleLivez tests ───────────────────────────────────────────────────────

func TestLivez(t *testing.T) {
	req := httptest.NewRequest("GET", "/livez", nil)
	w := httptest.NewRecorder()
	handleLivez(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}
