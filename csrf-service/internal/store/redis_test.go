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
	s := NewRedisStore(mr.Addr(), "", 30*time.Minute)
	t.Cleanup(func() { mr.Close(); s.Close() })
	return s, mr
}

func TestGenerate(t *testing.T) {
	s, mr := setupTestStore(t)
	token, err := s.Generate(context.Background(), "user-1")
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

func TestValidate_Valid(t *testing.T) {
	s, mr := setupTestStore(t)
	mr.Set("csrf:user-2", "correct-token")
	valid, err := s.Validate(context.Background(), "user-2", "correct-token")
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
	valid, err := s.Validate(context.Background(), "user-3", "wrong-token")
	if err != nil {
		t.Fatal(err)
	}
	if valid {
		t.Error("expected invalid")
	}
}

func TestValidate_NoToken(t *testing.T) {
	s, _ := setupTestStore(t)
	valid, err := s.Validate(context.Background(), "user-4", "any-token")
	if err != nil {
		t.Fatal(err)
	}
	if valid {
		t.Error("expected invalid when no token stored")
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
