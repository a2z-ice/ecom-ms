package store

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

func setupTestStore(t *testing.T) (*RedisStore, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	s := NewRedisStore(mr.Addr(), "", 30*time.Minute, false)
	t.Cleanup(func() { mr.Close(); s.Close() })
	return s, mr
}

func setupTestStoreFailClosed(t *testing.T) (*RedisStore, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	s := NewRedisStore(mr.Addr(), "", 30*time.Minute, true)
	t.Cleanup(func() { mr.Close(); s.Close() })
	return s, mr
}

func TestGenerate(t *testing.T) {
	s, mr := setupTestStore(t)
	token, err := s.Generate(context.Background(), "user-1", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(token) < 10 {
		t.Errorf("token too short: %q", token)
	}
	stored, err := mr.Get("csrf:user-1")
	if err != nil {
		t.Fatal(err)
	}
	if stored != token {
		t.Errorf("stored=%q, generated=%q", stored, token)
	}
}

func TestGenerate_WithOrigin(t *testing.T) {
	s, mr := setupTestStore(t)
	token, err := s.Generate(context.Background(), "user-origin", "https://myecom.net:30000")
	if err != nil {
		t.Fatal(err)
	}
	stored, err := mr.Get("csrf:user-origin")
	if err != nil {
		t.Fatal(err)
	}
	expected := token + "|https://myecom.net:30000"
	if stored != expected {
		t.Errorf("stored=%q, expected=%q", stored, expected)
	}
}

func TestValidate_Valid(t *testing.T) {
	s, mr := setupTestStore(t)
	mr.Set("csrf:user-2", "correct-token")
	valid, err := s.Validate(context.Background(), "user-2", "correct-token", "")
	if err != nil {
		t.Fatal(err)
	}
	if !valid {
		t.Error("expected valid")
	}
}

func TestValidate_Invalid(t *testing.T) {
	s, mr := setupTestStore(t)
	mr.Set("csrf:user-3", "correct-token")
	valid, err := s.Validate(context.Background(), "user-3", "wrong-token", "")
	if err != nil {
		t.Fatal(err)
	}
	if valid {
		t.Error("expected invalid")
	}
}

func TestValidate_NoToken(t *testing.T) {
	s, _ := setupTestStore(t)
	valid, err := s.Validate(context.Background(), "user-4", "any-token", "")
	if err != nil {
		t.Fatal(err)
	}
	if valid {
		t.Error("expected invalid when no token stored")
	}
}

func TestValidate_SingleUse(t *testing.T) {
	s, mr := setupTestStore(t)
	mr.Set("csrf:user-su", "one-time-token")

	// First validation should succeed
	valid, err := s.Validate(context.Background(), "user-su", "one-time-token", "")
	if err != nil {
		t.Fatal(err)
	}
	if !valid {
		t.Error("first validation should succeed")
	}

	// Second validation should fail (token consumed)
	valid, err = s.Validate(context.Background(), "user-su", "one-time-token", "")
	if err != nil {
		t.Fatal(err)
	}
	if valid {
		t.Error("second validation should fail — token was consumed")
	}
}

func TestValidate_OriginBound(t *testing.T) {
	s, mr := setupTestStore(t)
	mr.Set("csrf:user-ob", "tok123|https://myecom.net:30000")

	// Correct origin should pass
	valid, err := s.Validate(context.Background(), "user-ob", "tok123", "https://myecom.net:30000")
	if err != nil {
		t.Fatal(err)
	}
	if !valid {
		t.Error("expected valid with correct origin")
	}
}

func TestValidate_WrongOrigin(t *testing.T) {
	s, mr := setupTestStore(t)
	mr.Set("csrf:user-wo", "tok456|https://myecom.net:30000")

	valid, err := s.Validate(context.Background(), "user-wo", "tok456", "https://evil.com")
	if err != nil {
		t.Fatal(err)
	}
	if valid {
		t.Error("expected invalid with wrong origin")
	}
}

func TestValidate_EmptyOriginBackwardCompat(t *testing.T) {
	s, mr := setupTestStore(t)
	// Legacy format: no origin bound
	mr.Set("csrf:user-legacy", "legacy-token")

	valid, err := s.Validate(context.Background(), "user-legacy", "legacy-token", "https://any.com")
	if err != nil {
		t.Fatal(err)
	}
	if !valid {
		t.Error("legacy token without origin should be valid from any origin")
	}
}

func TestValidate_FailClosed_RedisDown(t *testing.T) {
	s, mr := setupTestStoreFailClosed(t)
	mr.Close()

	valid, err := s.Validate(context.Background(), "user-fc", "token", "")
	if err == nil {
		t.Error("expected error when Redis is down")
	}
	if valid {
		t.Error("fail-closed should return false on Redis error")
	}
}

func TestValidate_FailOpen_RedisDown(t *testing.T) {
	s, mr := setupTestStore(t) // fail-open (default)
	mr.Close()

	valid, err := s.Validate(context.Background(), "user-fo", "token", "")
	if err == nil {
		t.Error("expected error when Redis is down")
	}
	if !valid {
		t.Error("fail-open should return true on Redis error")
	}
}

func TestGenerate_FailClosed_RedisDown(t *testing.T) {
	s, mr := setupTestStoreFailClosed(t)
	mr.Close()

	token, err := s.Generate(context.Background(), "user-gfc", "")
	if err == nil {
		t.Error("expected error when Redis is down")
	}
	if token != "" {
		t.Errorf("fail-closed should return empty token, got %q", token)
	}
}

func TestGenerate_FailOpen_RedisDown(t *testing.T) {
	s, mr := setupTestStore(t) // fail-open
	mr.Close()

	token, err := s.Generate(context.Background(), "user-gfo", "")
	if err == nil {
		t.Error("expected error when Redis is down")
	}
	if token == "" {
		t.Error("fail-open should still return a token")
	}
}

func TestPing(t *testing.T) {
	s, _ := setupTestStore(t)
	if err := s.Ping(context.Background()); err != nil {
		t.Errorf("expected nil, got %v", err)
	}
}

func TestPing_Down(t *testing.T) {
	s, mr := setupTestStore(t)
	mr.Close()
	if err := s.Ping(context.Background()); err == nil {
		t.Error("expected error when Redis is down")
	}
}

// ── RefreshTTL tests ─────────────────────────────────────────────────────────

func TestRefreshTTL_ExistingKey(t *testing.T) {
	s, mr := setupTestStore(t)
	// Store a token with TTL
	mr.Set("csrf:user-ttl", "test-token")
	mr.SetTTL("csrf:user-ttl", 5*time.Minute)

	// Refresh TTL — should reset to full 30 minutes
	err := s.RefreshTTL(context.Background(), "user-ttl")
	if err != nil {
		t.Fatal(err)
	}

	ttl := mr.TTL("csrf:user-ttl")
	// After refresh, TTL should be close to the store's configured TTL (30min)
	if ttl < 25*time.Minute {
		t.Errorf("expected TTL near 30min after refresh, got %v", ttl)
	}
}

func TestRefreshTTL_MissingKey(t *testing.T) {
	s, _ := setupTestStore(t)
	// Key does not exist — should not error
	err := s.RefreshTTL(context.Background(), "nonexistent-user")
	if err != nil {
		t.Errorf("expected no error for missing key, got %v", err)
	}
}

func TestRefreshTTL_RedisDown(t *testing.T) {
	s, mr := setupTestStore(t)
	mr.Close()
	err := s.RefreshTTL(context.Background(), "user-down")
	if err == nil {
		t.Error("expected error when Redis is down")
	}
}
