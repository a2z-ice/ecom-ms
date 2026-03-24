// Package store provides the TokenStore interface and its Redis implementation.
package store

import (
	"context"
	"crypto/subtle"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const keyPrefix = "csrf:"

// TokenStore defines the operations for CSRF token storage.
type TokenStore interface {
	// Generate creates a new CSRF token for the user and stores it with TTL.
	Generate(ctx context.Context, userID string) (string, error)
	// Validate checks if the provided token matches the stored token.
	// Returns true if valid (or on Redis error — fail-open).
	Validate(ctx context.Context, userID, token string) (bool, error)
	// Ping checks Redis connectivity.
	Ping(ctx context.Context) error
	// Close releases the underlying connection.
	Close() error
}

// RedisStore implements TokenStore backed by Redis.
type RedisStore struct {
	client *redis.Client
	ttl    time.Duration
}

// NewRedisStore creates a Redis-backed token store.
func NewRedisStore(addr, password string, ttl time.Duration) *RedisStore {
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
	return &RedisStore{client: client, ttl: ttl}
}

func (s *RedisStore) Generate(ctx context.Context, userID string) (string, error) {
	token := uuid.New().String()
	if err := s.client.Set(ctx, keyPrefix+userID, token, s.ttl).Err(); err != nil {
		slog.Warn("Failed to store CSRF token in Redis", "user", userID, "error", err)
		return token, err // Return token anyway (fail-open)
	}
	return token, nil
}

func (s *RedisStore) Validate(ctx context.Context, userID, token string) (bool, error) {
	stored, err := s.client.Get(ctx, keyPrefix+userID).Result()
	if err != nil {
		if err == redis.Nil {
			return false, nil // No token stored
		}
		slog.Warn("Redis error during CSRF validation — failing open", "user", userID, "error", err)
		return true, err // Fail-open
	}

	valid := subtle.ConstantTimeCompare([]byte(stored), []byte(token)) == 1
	if valid {
		if err := s.client.Expire(ctx, keyPrefix+userID, s.ttl).Err(); err != nil {
			slog.Warn("Failed to refresh CSRF token TTL", "user", userID, "error", err)
		}
	}
	return valid, nil
}

func (s *RedisStore) Ping(ctx context.Context) error {
	return s.client.Ping(ctx).Err()
}

func (s *RedisStore) Close() error {
	return s.client.Close()
}
