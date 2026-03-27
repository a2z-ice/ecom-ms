// Package store provides the TokenStore interface and its Redis implementation.
package store

import (
	"context"
	"crypto/subtle"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const keyPrefix = "csrf:"

// TokenStore defines the operations for CSRF token storage.
type TokenStore interface {
	// Generate creates a new CSRF token for the user and stores it with TTL.
	// The origin is bound to the token for origin-based validation.
	Generate(ctx context.Context, userID, origin string) (string, error)
	// Validate checks if the provided token matches the stored token.
	// Tokens are single-use: consumed (deleted) on successful validation.
	Validate(ctx context.Context, userID, token, origin string) (bool, error)
	// RefreshTTL extends the TTL of an existing token without reading its value.
	// Returns nil if the key does not exist (no token to refresh).
	RefreshTTL(ctx context.Context, userID string) error
	// Ping checks Redis connectivity.
	Ping(ctx context.Context) error
	// Close releases the underlying connection.
	Close() error
}

// RedisStore implements TokenStore backed by Redis.
type RedisStore struct {
	client     *redis.Client
	ttl        time.Duration
	failClosed bool
}

// NewRedisStore creates a Redis-backed token store.
func NewRedisStore(addr, password string, ttl time.Duration, failClosed bool) *RedisStore {
	client := redis.NewClient(&redis.Options{
		Addr:         addr,
		Password:     password,
		DB:           0,
		DialTimeout:  2 * time.Second,
		ReadTimeout:  1 * time.Second,
		WriteTimeout: 1 * time.Second,
		PoolSize:     10,
		MinIdleConns: 2,
	})
	return &RedisStore{client: client, ttl: ttl, failClosed: failClosed}
}

func (s *RedisStore) Generate(ctx context.Context, userID, origin string) (string, error) {
	token := uuid.New().String()
	// Store as "token|origin" for origin-binding validation
	value := token
	if origin != "" {
		value = token + "|" + origin
	}
	if err := s.client.Set(ctx, keyPrefix+userID, value, s.ttl).Err(); err != nil {
		slog.Warn("Failed to store CSRF token in Redis", "user", userID, "error", err)
		if s.failClosed {
			return "", err
		}
		return token, err // Fail-open: return token anyway
	}
	return token, nil
}

func (s *RedisStore) Validate(ctx context.Context, userID, token, origin string) (bool, error) {
	stored, err := s.client.Get(ctx, keyPrefix+userID).Result()
	if err != nil {
		if err == redis.Nil {
			return false, nil // No token stored
		}
		if s.failClosed {
			slog.Warn("Redis error during CSRF validation — failing closed", "user", userID, "error", err)
			return false, err
		}
		slog.Warn("Redis error during CSRF validation — failing open", "user", userID, "error", err)
		return true, err // Fail-open
	}

	// Parse stored value: "token" (legacy) or "token|origin" (origin-bound)
	storedToken := stored
	storedOrigin := ""
	if idx := strings.Index(stored, "|"); idx >= 0 {
		storedToken = stored[:idx]
		storedOrigin = stored[idx+1:]
	}

	valid := subtle.ConstantTimeCompare([]byte(storedToken), []byte(token)) == 1

	// Validate origin binding if both stored and request origins are present
	if valid && storedOrigin != "" && origin != "" {
		valid = subtle.ConstantTimeCompare([]byte(storedOrigin), []byte(origin)) == 1
	}

	if valid {
		// Single-use: consume token by deleting it from Redis
		if err := s.client.Del(ctx, keyPrefix+userID).Err(); err != nil {
			slog.Warn("Failed to consume CSRF token", "user", userID, "error", err)
		}
	}
	return valid, nil
}

func (s *RedisStore) RefreshTTL(ctx context.Context, userID string) error {
	_, err := s.client.Expire(ctx, keyPrefix+userID, s.ttl).Result()
	if err != nil {
		slog.Warn("Failed to refresh CSRF token TTL", "user", userID, "error", err)
		return err
	}
	return nil
}

func (s *RedisStore) Ping(ctx context.Context) error {
	return s.client.Ping(ctx).Err()
}

func (s *RedisStore) Close() error {
	return s.client.Close()
}
