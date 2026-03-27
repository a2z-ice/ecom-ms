// Package ratelimit provides per-user rate limiting backed by Redis.
package ratelimit

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

const keyPrefix = "ratelimit:csrf:"

// Limiter checks per-user rate limits for CSRF token generation.
type Limiter interface {
	// Allow checks if the user is within the rate limit.
	// Returns true if allowed. Fails open on Redis errors.
	Allow(ctx context.Context, userID string) (bool, error)
}

// RedisLimiter implements Limiter using a sliding window counter in Redis.
type RedisLimiter struct {
	client     *redis.Client
	maxPerMin  int
	windowSize time.Duration
}

// NewRedisLimiter creates a rate limiter backed by Redis.
func NewRedisLimiter(client *redis.Client, maxPerMin int) *RedisLimiter {
	return &RedisLimiter{
		client:     client,
		maxPerMin:  maxPerMin,
		windowSize: 2 * time.Minute, // TTL covers current + next minute bucket
	}
}

func (l *RedisLimiter) Allow(ctx context.Context, userID string) (bool, error) {
	// Key includes the current minute bucket for sliding window
	bucket := time.Now().Truncate(time.Minute).Unix()
	key := fmt.Sprintf("%s%s:%d", keyPrefix, userID, bucket)

	count, err := l.client.Incr(ctx, key).Result()
	if err != nil {
		slog.Warn("Redis error during rate limit check — failing open", "user", userID, "error", err)
		return true, err // Fail-open: don't block on Redis errors
	}

	// Set TTL on first increment
	if count == 1 {
		l.client.Expire(ctx, key, l.windowSize)
	}

	return count <= int64(l.maxPerMin), nil
}

// NoopLimiter always allows (used in tests or when rate limiting is disabled).
type NoopLimiter struct{}

func (n *NoopLimiter) Allow(_ context.Context, _ string) (bool, error) {
	return true, nil
}
