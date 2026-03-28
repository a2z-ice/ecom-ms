package ratelimit

import (
	"context"
	"testing"
)

func TestLocalAllow(t *testing.T) {
	l := NewLocalLimiter(5)
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		allowed, err := l.Allow(ctx, "user-1")
		if err != nil {
			t.Fatal(err)
		}
		if !allowed {
			t.Fatalf("expected allowed on attempt %d", i+1)
		}
	}

	// 6th should be denied
	allowed, err := l.Allow(ctx, "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("expected denied after limit exceeded")
	}
}

func TestLocalPerUser(t *testing.T) {
	l := NewLocalLimiter(2)
	ctx := context.Background()

	l.Allow(ctx, "user-1")
	l.Allow(ctx, "user-1")

	// user-1 at limit
	a1, _ := l.Allow(ctx, "user-1")
	if a1 {
		t.Fatal("expected user-1 denied")
	}

	// user-2 should be unaffected
	a2, _ := l.Allow(ctx, "user-2")
	if !a2 {
		t.Fatal("expected user-2 allowed (independent limit)")
	}
}

func TestLocalReturnsNoError(t *testing.T) {
	l := NewLocalLimiter(10)
	_, err := l.Allow(context.Background(), "user-1")
	if err != nil {
		t.Fatal("expected no error from local limiter")
	}
}

func TestLocalConcurrentSafety(t *testing.T) {
	l := NewLocalLimiter(1000)
	ctx := context.Background()
	done := make(chan bool, 200)

	for i := 0; i < 200; i++ {
		go func() {
			l.Allow(ctx, "user-concurrent")
			done <- true
		}()
	}
	for i := 0; i < 200; i++ {
		<-done
	}
}
