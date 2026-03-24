package handler

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/bookstore/csrf-service/internal/middleware"
	"github.com/bookstore/csrf-service/internal/store"
	"github.com/prometheus/client_golang/prometheus"
)

func setupHandler(t *testing.T) (*Handler, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	s := store.NewRedisStore(mr.Addr(), "", 30*time.Minute)
	// Use a separate Prometheus registry per test to avoid duplicate registration panics
	reg := prometheus.NewRegistry()
	m := middleware.NewMetricsWithRegisterer(reg)
	t.Cleanup(func() { mr.Close(); s.Close() })
	return New(s, m), mr
}

func makeJWT(sub string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"sub":"%s","iss":"test"}`, sub)))
	return fmt.Sprintf("%s.%s.fakesignature", header, payload)
}

// ── GenerateToken tests ─────────────────────────────────────────────────────

func TestGenerateToken_NoJWT(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest("GET", "/csrf/token", nil)
	w := httptest.NewRecorder()
	h.GenerateToken(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestGenerateToken_ValidJWT(t *testing.T) {
	h, mr := setupHandler(t)
	req := httptest.NewRequest("GET", "/csrf/token", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWT("test-user"))
	w := httptest.NewRecorder()
	h.GenerateToken(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var body map[string]string
	json.NewDecoder(w.Body).Decode(&body)
	if body["token"] == "" {
		t.Error("expected non-empty token")
	}
	stored, _ := mr.Get("csrf:test-user")
	if stored != body["token"] {
		t.Errorf("Redis=%q, response=%q", stored, body["token"])
	}
}

// ── ExtAuthzCheck tests ─────────────────────────────────────────────────────

func TestExtAuthzCheck_SafeMethods(t *testing.T) {
	h, _ := setupHandler(t)
	for _, method := range []string{"GET", "HEAD", "OPTIONS", "TRACE"} {
		t.Run(method, func(t *testing.T) {
			req := httptest.NewRequest(method, "/", nil)
			w := httptest.NewRecorder()
			h.ExtAuthzCheck(w, req)
			if w.Code != http.StatusOK {
				t.Errorf("%s: expected 200, got %d", method, w.Code)
			}
		})
	}
}

func TestExtAuthzCheck_MutatingNoAuth(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 (pass-through), got %d", w.Code)
	}
}

func TestExtAuthzCheck_MutatingNoCsrf(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWT("user-1"))
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "CSRF") {
		t.Errorf("expected CSRF in body, got %q", w.Body.String())
	}
}

func TestExtAuthzCheck_InvalidCsrf(t *testing.T) {
	h, mr := setupHandler(t)
	mr.Set("csrf:user-2", "correct-token")
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWT("user-2"))
	req.Header.Set("X-Csrf-Token", "wrong-token")
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}
}

func TestExtAuthzCheck_ValidCsrf(t *testing.T) {
	h, mr := setupHandler(t)
	mr.Set("csrf:user-3", "valid-token")
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWT("user-3"))
	req.Header.Set("X-Csrf-Token", "valid-token")
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestExtAuthzCheck_PUT(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest("PUT", "/inven/admin/stock/123", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWT("user-4"))
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for PUT without CSRF, got %d", w.Code)
	}
}

func TestExtAuthzCheck_DELETE(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest("DELETE", "/ecom/admin/books/123", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWT("user-5"))
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for DELETE without CSRF, got %d", w.Code)
	}
}

func TestExtAuthzCheck_NoStoredToken(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWT("user-6"))
	req.Header.Set("X-Csrf-Token", "some-token")
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 (no stored token), got %d", w.Code)
	}
}

// ── Health tests ────────────────────────────────────────────────────────────

func TestHealthz_RedisUp(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	h.Healthz(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "ok") {
		t.Errorf("expected 'ok' in body, got %q", w.Body.String())
	}
}

func TestHealthz_RedisDown(t *testing.T) {
	h, mr := setupHandler(t)
	mr.Close()
	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	h.Healthz(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", w.Code)
	}
}

func TestLivez(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest("GET", "/livez", nil)
	w := httptest.NewRecorder()
	h.Livez(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}
