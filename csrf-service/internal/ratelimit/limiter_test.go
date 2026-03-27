package ratelimit

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func setupTestLimiter(t *testing.T, maxPerMin int) (*RedisLimiter, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	l := NewRedisLimiter(client, maxPerMin)
	t.Cleanup(func() { mr.Close(); client.Close() })
	return l, mr
}

func TestAllow_WithinLimit(t *testing.T) {
	l, _ := setupTestLimiter(t, 5)
	for i := 0; i < 5; i++ {
		allowed, err := l.Allow(context.Background(), "user-1")
		if err != nil {
			t.Fatal(err)
		}
		if !allowed {
			t.Errorf("request %d should be allowed", i+1)
		}
	}
}

func TestAllow_ExceedsLimit(t *testing.T) {
	l, _ := setupTestLimiter(t, 3)
	for i := 0; i < 3; i++ {
		l.Allow(context.Background(), "user-2")
	}
	allowed, err := l.Allow(context.Background(), "user-2")
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Error("4th request should be rejected (limit is 3)")
	}
}

func TestAllow_DifferentUsers(t *testing.T) {
	l, _ := setupTestLimiter(t, 2)
	// User A uses up limit
	l.Allow(context.Background(), "user-a")
	l.Allow(context.Background(), "user-a")
	allowed, _ := l.Allow(context.Background(), "user-a")
	if allowed {
		t.Error("user-a should be limited")
	}

	// User B should still be allowed
	allowed, _ = l.Allow(context.Background(), "user-b")
	if !allowed {
		t.Error("user-b should be allowed (independent limit)")
	}
}

func TestAllow_RedisDown_FailOpen(t *testing.T) {
	l, mr := setupTestLimiter(t, 5)
	mr.Close()
	allowed, err := l.Allow(context.Background(), "user-down")
	if err == nil {
		t.Error("expected error when Redis is down")
	}
	if !allowed {
		t.Error("should fail-open when Redis is down")
	}
}

func TestNoopLimiter(t *testing.T) {
	l := &NoopLimiter{}
	for i := 0; i < 100; i++ {
		allowed, err := l.Allow(context.Background(), "anyone")
		if err != nil {
			t.Fatal(err)
		}
		if !allowed {
			t.Error("noop limiter should always allow")
		}
	}
}
