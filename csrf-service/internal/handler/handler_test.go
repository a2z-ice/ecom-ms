package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/bookstore/csrf-service/internal/introspect"
	"github.com/bookstore/csrf-service/internal/middleware"
	"github.com/bookstore/csrf-service/internal/origin"
	"github.com/bookstore/csrf-service/internal/ratelimit"
	"github.com/bookstore/csrf-service/internal/store"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
)

// mockIntrospector for testing introspection behavior
type mockIntrospector struct {
	active bool
	err    error
	called int
}

func (m *mockIntrospector) IsActive(_ context.Context, _ string) (bool, error) {
	m.called++
	return m.active, m.err
}

func setupHandler(t *testing.T) (*Handler, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	s := store.NewRedisStore(mr.Addr(), "", 30*time.Minute, false)
	reg := prometheus.NewRegistry()
	m := middleware.NewMetricsWithRegisterer(reg)
	ov := origin.NewValidator([]string{"https://myecom.net:30000", "https://localhost:30000"}, false)
	rl := &ratelimit.NoopLimiter{}
	intr := &introspect.NoopIntrospector{}
	t.Cleanup(func() { mr.Close(); s.Close() })
	return New(s, m, ov, rl, intr, []string{"ui-client"}, false), mr
}

func setupHandlerFailClosed(t *testing.T) (*Handler, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	s := store.NewRedisStore(mr.Addr(), "", 30*time.Minute, true)
	reg := prometheus.NewRegistry()
	m := middleware.NewMetricsWithRegisterer(reg)
	ov := origin.NewValidator([]string{"https://myecom.net:30000"}, false)
	rl := &ratelimit.NoopLimiter{}
	intr := &introspect.NoopIntrospector{}
	t.Cleanup(func() { mr.Close(); s.Close() })
	return New(s, m, ov, rl, intr, []string{"ui-client"}, false), mr
}

func makeJWT(sub string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"sub":"%s","iss":"test","aud":"ui-client"}`, sub)))
	return fmt.Sprintf("%s.%s.fakesignature", header, payload)
}

func makeJWTWithAud(sub, aud string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"sub":"%s","iss":"test","aud":"%s"}`, sub, aud)))
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

func TestGenerateToken_RateLimited(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	s := store.NewRedisStore(mr.Addr(), "", 30*time.Minute, false)
	reg := prometheus.NewRegistry()
	m := middleware.NewMetricsWithRegisterer(reg)
	ov := origin.NewValidator([]string{"https://myecom.net:30000"}, false)

	// Create a Redis client for rate limiter pointing to same miniredis
	rlClient := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	rl := ratelimit.NewRedisLimiter(rlClient, 3) // Allow only 3 per minute
	intr := &introspect.NoopIntrospector{}
	t.Cleanup(func() { mr.Close(); s.Close(); rlClient.Close() })
	h := New(s, m, ov, rl, intr, []string{"ui-client"}, false)

	jwt := makeJWT("rate-user")
	// First 3 should succeed
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest("GET", "/csrf/token", nil)
		req.Header.Set("Authorization", "Bearer "+jwt)
		w := httptest.NewRecorder()
		h.GenerateToken(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("request %d: expected 200, got %d", i+1, w.Code)
		}
	}
	// 4th should be rate limited
	req := httptest.NewRequest("GET", "/csrf/token", nil)
	req.Header.Set("Authorization", "Bearer "+jwt)
	w := httptest.NewRecorder()
	h.GenerateToken(w, req)
	if w.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", w.Code)
	}
	if w.Header().Get("Retry-After") != "60" {
		t.Errorf("expected Retry-After: 60, got %q", w.Header().Get("Retry-After"))
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

	// Verify token was consumed (single-use)
	if mr.Exists("csrf:user-3") {
		t.Error("token should have been consumed (deleted from Redis)")
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

// ── Origin validation tests ─────────────────────────────────────────────────

func TestExtAuthzCheck_OriginAllowed(t *testing.T) {
	h, mr := setupHandler(t)
	mr.Set("csrf:user-oa", "tok")
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWT("user-oa"))
	req.Header.Set("X-Csrf-Token", "tok")
	req.Header.Set("Origin", "https://myecom.net:30000")
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for allowed origin, got %d", w.Code)
	}
}

func TestExtAuthzCheck_OriginRejected(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWT("user-or"))
	req.Header.Set("X-Csrf-Token", "tok")
	req.Header.Set("Origin", "https://evil.com")
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for rejected origin, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "origin") {
		t.Errorf("expected 'origin' in body, got %q", w.Body.String())
	}
}

func TestExtAuthzCheck_OriginMissing_Permissive(t *testing.T) {
	h, mr := setupHandler(t) // RequireOrigin=false
	mr.Set("csrf:user-om", "tok")
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWT("user-om"))
	req.Header.Set("X-Csrf-Token", "tok")
	// No Origin header
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 (permissive: missing origin allowed), got %d", w.Code)
	}
}

func TestExtAuthzCheck_RefererFallback(t *testing.T) {
	h, mr := setupHandler(t)
	mr.Set("csrf:user-rf", "tok")
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWT("user-rf"))
	req.Header.Set("X-Csrf-Token", "tok")
	req.Header.Set("Referer", "https://myecom.net:30000/catalog?page=2")
	// No Origin header — should fallback to Referer
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 (Referer fallback), got %d", w.Code)
	}
}

// ── Fail-closed tests ───────────────────────────────────────────────────────

func TestExtAuthzCheck_FailClosed_Returns503(t *testing.T) {
	h, mr := setupHandlerFailClosed(t)
	mr.Close() // Kill Redis
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWT("user-fc"))
	req.Header.Set("X-Csrf-Token", "some-token")
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 (fail-closed), got %d", w.Code)
	}
}

// ── Audience validation tests ───────────────────────────────────────────────

func TestExtAuthzCheck_AudienceValid(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	s := store.NewRedisStore(mr.Addr(), "", 30*time.Minute, false)
	reg := prometheus.NewRegistry()
	m := middleware.NewMetricsWithRegisterer(reg)
	ov := origin.NewValidator([]string{"https://myecom.net:30000"}, false)
	rl := &ratelimit.NoopLimiter{}
	t.Cleanup(func() { mr.Close(); s.Close() })
	// ValidateAudience=true
	h := New(s, m, ov, rl, &introspect.NoopIntrospector{}, []string{"ui-client"}, true)

	mr.Set("csrf:user-av", "tok")
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWTWithAud("user-av", "ui-client"))
	req.Header.Set("X-Csrf-Token", "tok")
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for valid audience, got %d", w.Code)
	}
}

func TestExtAuthzCheck_AudienceInvalid(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	s := store.NewRedisStore(mr.Addr(), "", 30*time.Minute, false)
	reg := prometheus.NewRegistry()
	m := middleware.NewMetricsWithRegisterer(reg)
	ov := origin.NewValidator([]string{"https://myecom.net:30000"}, false)
	rl := &ratelimit.NoopLimiter{}
	t.Cleanup(func() { mr.Close(); s.Close() })
	// ValidateAudience=true
	h := New(s, m, ov, rl, &introspect.NoopIntrospector{}, []string{"ui-client"}, true)

	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWTWithAud("user-ai", "wrong-client"))
	req.Header.Set("X-Csrf-Token", "tok")
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for invalid audience, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "audience") {
		t.Errorf("expected 'audience' in body, got %q", w.Body.String())
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

// ── Introspection tests ─────────────────────────────────────────────────────

func setupHandlerWithIntrospector(t *testing.T, intr introspect.Introspector) (*Handler, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	s := store.NewRedisStore(mr.Addr(), "", 30*time.Minute, false)
	reg := prometheus.NewRegistry()
	m := middleware.NewMetricsWithRegisterer(reg)
	ov := origin.NewValidator([]string{"https://myecom.net:30000", "https://localhost:30000"}, false)
	rl := &ratelimit.NoopLimiter{}
	t.Cleanup(func() { mr.Close(); s.Close() })
	return New(s, m, ov, rl, intr, []string{"ui-client"}, false), mr
}

func TestExtAuthzCheck_IntrospectionActive(t *testing.T) {
	mock := &mockIntrospector{active: true}
	h, mr := setupHandlerWithIntrospector(t, mock)
	mr.Set("csrf:user-ia", "tok")
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWT("user-ia"))
	req.Header.Set("X-Csrf-Token", "tok")
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for active token, got %d", w.Code)
	}
	if mock.called != 1 {
		t.Errorf("expected 1 introspection call, got %d", mock.called)
	}
}

func TestExtAuthzCheck_IntrospectionInactive(t *testing.T) {
	mock := &mockIntrospector{active: false}
	h, mr := setupHandlerWithIntrospector(t, mock)
	mr.Set("csrf:user-ii", "tok")
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWT("user-ii"))
	req.Header.Set("X-Csrf-Token", "tok")
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for inactive token, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "no longer valid") {
		t.Errorf("expected 'no longer valid' in body, got %q", w.Body.String())
	}
	// CSRF token should NOT be consumed (introspection rejected before CSRF check)
	if !mr.Exists("csrf:user-ii") {
		t.Error("CSRF token should not be consumed when introspection rejects")
	}
}

func TestExtAuthzCheck_IntrospectionError_FailOpen(t *testing.T) {
	mock := &mockIntrospector{active: true, err: errors.New("keycloak down")}
	h, mr := setupHandlerWithIntrospector(t, mock)
	mr.Set("csrf:user-ifo", "tok")
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWT("user-ifo"))
	req.Header.Set("X-Csrf-Token", "tok")
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 (fail-open on introspection error), got %d", w.Code)
	}
}

func TestExtAuthzCheck_IntrospectionError_FailClosed(t *testing.T) {
	mock := &mockIntrospector{active: false, err: errors.New("keycloak down")}
	h, _ := setupHandlerWithIntrospector(t, mock)
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	req.Header.Set("Authorization", "Bearer "+makeJWT("user-ifc"))
	req.Header.Set("X-Csrf-Token", "tok")
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 (fail-closed on introspection error), got %d", w.Code)
	}
}

func TestExtAuthzCheck_IntrospectionSkipped_SafeMethod(t *testing.T) {
	mock := &mockIntrospector{active: true}
	h, _ := setupHandlerWithIntrospector(t, mock)
	req := httptest.NewRequest("GET", "/ecom/books", nil)
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for GET, got %d", w.Code)
	}
	if mock.called != 0 {
		t.Errorf("introspection should not be called for GET, called %d times", mock.called)
	}
}

func TestExtAuthzCheck_IntrospectionSkipped_NoAuth(t *testing.T) {
	mock := &mockIntrospector{active: true}
	h, _ := setupHandlerWithIntrospector(t, mock)
	req := httptest.NewRequest("POST", "/ecom/cart", nil)
	// No Authorization header
	w := httptest.NewRecorder()
	h.ExtAuthzCheck(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 (pass-through for no auth), got %d", w.Code)
	}
	if mock.called != 0 {
		t.Errorf("introspection should not be called without JWT, called %d times", mock.called)
	}
}

