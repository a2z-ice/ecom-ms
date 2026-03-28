package store

import (
	"context"
	"encoding/base64"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/bookstore/csrf-service/internal/cuckoo"
	"github.com/bookstore/csrf-service/internal/token"
	"github.com/redis/go-redis/v9"
)

func setupHybrid(t *testing.T) (*HybridStore, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}

	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	kr, _ := token.NewKeyRing(base64.StdEncoding.EncodeToString(key), 10*time.Minute)
	gen := token.NewGenerator(kr, 10*time.Minute)
	cf := cuckoo.NewRollingFilter(10000)
	rc := redis.NewClient(&redis.Options{Addr: mr.Addr()})

	hs := NewHybridStore(gen, cf, rc, 10*time.Minute, false, false)
	return hs, mr
}

func setupHybridNoRedis(t *testing.T) *HybridStore {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	kr, _ := token.NewKeyRing(base64.StdEncoding.EncodeToString(key), 10*time.Minute)
	gen := token.NewGenerator(kr, 10*time.Minute)
	cf := cuckoo.NewRollingFilter(10000)
	return NewHybridStore(gen, cf, nil, 10*time.Minute, false, false)
}

func TestHybridGenerateNoRedis(t *testing.T) {
	hs := setupHybridNoRedis(t)
	tok, err := hs.Generate(context.Background(), "user-1", "https://origin.com")
	if err != nil {
		t.Fatal(err)
	}
	if tok == "" {
		t.Fatal("expected non-empty token")
	}
}

func TestHybridGenerateAndValidate(t *testing.T) {
	hs, mr := setupHybrid(t)
	defer mr.Close()
	ctx := context.Background()

	tok, err := hs.Generate(ctx, "user-1", "")
	if err != nil {
		t.Fatal(err)
	}

	valid, err := hs.Validate(ctx, "user-1", tok, "")
	if err != nil {
		t.Fatal(err)
	}
	if !valid {
		t.Fatal("expected valid token")
	}
}

func TestHybridSingleUse(t *testing.T) {
	hs, mr := setupHybrid(t)
	defer mr.Close()
	ctx := context.Background()

	tok, _ := hs.Generate(ctx, "user-1", "")

	// First use: valid
	valid, _ := hs.Validate(ctx, "user-1", tok, "")
	if !valid {
		t.Fatal("expected valid on first use")
	}

	// Second use: consumed
	valid, _ = hs.Validate(ctx, "user-1", tok, "")
	if valid {
		t.Fatal("expected invalid on second use (single-use)")
	}
}

func TestHybridUserBinding(t *testing.T) {
	hs, mr := setupHybrid(t)
	defer mr.Close()
	ctx := context.Background()

	tok, _ := hs.Generate(ctx, "user-1", "")

	// Wrong user
	valid, _ := hs.Validate(ctx, "user-2", tok, "")
	if valid {
		t.Fatal("expected invalid for wrong user")
	}
}

func TestHybridOriginBinding(t *testing.T) {
	hs, mr := setupHybrid(t)
	defer mr.Close()
	ctx := context.Background()

	tok, _ := hs.Generate(ctx, "user-1", "https://origin-a.com")

	// Wrong origin
	valid, _ := hs.Validate(ctx, "user-1", tok, "https://origin-b.com")
	if valid {
		t.Fatal("expected invalid for wrong origin")
	}

	// Correct origin (need new token since first was consumed or rejected)
	tok2, _ := hs.Generate(ctx, "user-1", "https://origin-a.com")
	valid, _ = hs.Validate(ctx, "user-1", tok2, "https://origin-a.com")
	if !valid {
		t.Fatal("expected valid for matching origin")
	}
}

func TestHybridEmptyOriginAcceptsAny(t *testing.T) {
	hs, mr := setupHybrid(t)
	defer mr.Close()
	ctx := context.Background()

	// Token with no origin binding
	tok, _ := hs.Generate(ctx, "user-1", "")

	valid, _ := hs.Validate(ctx, "user-1", tok, "https://any-origin.com")
	if !valid {
		t.Fatal("expected valid when token has no origin binding")
	}
}

func TestHybridRedisDown(t *testing.T) {
	hs, mr := setupHybrid(t)
	mr.Close() // Redis down
	ctx := context.Background()

	// Generate should still work (HMAC, no Redis)
	tok, err := hs.Generate(ctx, "user-1", "")
	if err != nil {
		t.Fatal(err)
	}

	// Validate should still work (L1 Cuckoo + HMAC, fail-open on Redis)
	valid, _ := hs.Validate(ctx, "user-1", tok, "")
	if !valid {
		t.Fatal("expected valid with Redis down (fail-open)")
	}
}

func TestHybridTampered(t *testing.T) {
	hs, mr := setupHybrid(t)
	defer mr.Close()
	ctx := context.Background()

	tok, _ := hs.Generate(ctx, "user-1", "")
	chars := []byte(tok)
	chars[len(chars)/2] ^= 0xFF
	tampered := string(chars)

	valid, _ := hs.Validate(ctx, "user-1", tampered, "")
	if valid {
		t.Fatal("expected invalid for tampered token")
	}
}

func TestHybridLegacyUUID(t *testing.T) {
	hs, mr := setupHybrid(t)
	defer mr.Close()
	ctx := context.Background()

	// Simulate legacy UUID token in Redis
	legacyToken := "550e8400-e29b-41d4-a716-446655440000"
	mr.Set("csrf:user-1", legacyToken)

	valid, err := hs.Validate(ctx, "user-1", legacyToken, "")
	if err != nil {
		t.Fatal(err)
	}
	if !valid {
		t.Fatal("expected valid for legacy UUID token")
	}

	// Should be consumed (single-use)
	valid, _ = hs.Validate(ctx, "user-1", legacyToken, "")
	if valid {
		t.Fatal("expected invalid after legacy token consumed")
	}
}

func TestHybridLegacyUUIDWithOrigin(t *testing.T) {
	hs, mr := setupHybrid(t)
	defer mr.Close()
	ctx := context.Background()

	legacyToken := "550e8400-e29b-41d4-a716-446655440000"
	mr.Set("csrf:user-1", legacyToken+"|https://origin.com")

	// Wrong origin
	valid, _ := hs.Validate(ctx, "user-1", legacyToken, "https://wrong.com")
	if valid {
		t.Fatal("expected invalid for wrong origin on legacy token")
	}
}

func TestHybridRefreshTTLIsNoop(t *testing.T) {
	hs := setupHybridNoRedis(t)
	err := hs.RefreshTTL(context.Background(), "user-1")
	if err != nil {
		t.Fatal("expected no error from noop RefreshTTL")
	}
}

func TestHybridPingNoRedis(t *testing.T) {
	hs := setupHybridNoRedis(t)
	err := hs.Ping(context.Background())
	if err != nil {
		t.Fatal("expected no error from Ping without Redis")
	}
}

func TestHybridPingWithRedis(t *testing.T) {
	hs, mr := setupHybrid(t)
	defer mr.Close()
	err := hs.Ping(context.Background())
	if err != nil {
		t.Fatal(err)
	}
}

func TestHybridXORMasking(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	kr, _ := token.NewKeyRing(base64.StdEncoding.EncodeToString(key), 10*time.Minute)
	gen := token.NewGenerator(kr, 10*time.Minute)
	cf := cuckoo.NewRollingFilter(10000)
	hs := NewHybridStore(gen, cf, nil, 10*time.Minute, false, true) // XOR enabled

	ctx := context.Background()

	tok1, _ := hs.Generate(ctx, "user-1", "")
	tok2, _ := hs.Generate(ctx, "user-1", "")

	// Masked tokens should differ (different random XOR)
	if tok1 == tok2 {
		t.Fatal("expected different masked tokens")
	}

	// Both should validate
	valid1, _ := hs.Validate(ctx, "user-1", tok1, "")
	if !valid1 {
		t.Fatal("expected masked token 1 to validate")
	}

	valid2, _ := hs.Validate(ctx, "user-1", tok2, "")
	if !valid2 {
		t.Fatal("expected masked token 2 to validate")
	}
}

func TestIsLegacyUUID(t *testing.T) {
	tests := []struct {
		input    string
		expected bool
	}{
		{"550e8400-e29b-41d4-a716-446655440000", true},
		{"not-a-uuid", false},
		{"", false},
		{"550e8400e29b41d4a716446655440000", false}, // no hyphens
		{"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", false}, // right length but no hyphens
	}
	for _, tt := range tests {
		if got := isLegacyUUID(tt.input); got != tt.expected {
			t.Errorf("isLegacyUUID(%q) = %v, want %v", tt.input, got, tt.expected)
		}
	}
}
