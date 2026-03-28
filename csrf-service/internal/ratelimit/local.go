package ratelimit

import (
	"context"
	"sync"
	"time"
)

// LocalLimiter implements Limiter using in-memory token buckets per user.
// No Redis dependency. State is per-pod (not shared across replicas).
type LocalLimiter struct {
	maxPerMin int
	buckets   map[string]*bucket
	mu        sync.Mutex
}

type bucket struct {
	count    int
	windowAt int64 // Unix minute bucket
}

// NewLocalLimiter creates an in-memory rate limiter.
func NewLocalLimiter(maxPerMin int) *LocalLimiter {
	l := &LocalLimiter{
		maxPerMin: maxPerMin,
		buckets:   make(map[string]*bucket),
	}
	// Background cleanup every 2 minutes to prevent memory leak
	go l.cleanup()
	return l
}

func (l *LocalLimiter) Allow(_ context.Context, userID string) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now().Truncate(time.Minute).Unix()
	b, ok := l.buckets[userID]
	if !ok || b.windowAt != now {
		l.buckets[userID] = &bucket{count: 1, windowAt: now}
		return true, nil
	}

	b.count++
	return b.count <= l.maxPerMin, nil
}

func (l *LocalLimiter) cleanup() {
	for {
		time.Sleep(2 * time.Minute)
		l.mu.Lock()
		now := time.Now().Truncate(time.Minute).Unix()
		for k, b := range l.buckets {
			if now-b.windowAt > 120 { // 2 minutes old
				delete(l.buckets, k)
			}
		}
		l.mu.Unlock()
	}
}
