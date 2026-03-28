package store

import (
	"context"
	"crypto/subtle"
	"log/slog"
	"strings"
	"time"

	"github.com/bookstore/csrf-service/internal/cuckoo"
	"github.com/bookstore/csrf-service/internal/token"
	"github.com/redis/go-redis/v9"
)

// HybridStore implements TokenStore using HMAC tokens (stateless generation)
// and a tiered Cuckoo filter (single-use enforcement):
//   L1: In-memory Cuckoo filter (per-pod, fast)
//   L2: HMAC signature verification (stateless, no I/O)
//   L3: Redis Cuckoo filter (cross-pod dedup, optional)
type HybridStore struct {
	generator  *token.Generator
	cuckooL1   *cuckoo.RollingFilter
	redisL3    *redis.Client // nil if Redis unavailable or disabled
	ttl        time.Duration
	failClosed bool
	xorMask    bool
}

// NewHybridStore creates a hybrid store.
// redisClient can be nil to run fully stateless (L1+L2 only).
func NewHybridStore(
	gen *token.Generator,
	cuckooL1 *cuckoo.RollingFilter,
	redisClient *redis.Client,
	ttl time.Duration,
	failClosed bool,
	xorMask bool,
) *HybridStore {
	return &HybridStore{
		generator:  gen,
		cuckooL1:   cuckooL1,
		redisL3:    redisClient,
		ttl:        ttl,
		failClosed: failClosed,
		xorMask:    xorMask,
	}
}

// Generate creates a new HMAC-signed CSRF token. No Redis I/O.
// If XOR masking is enabled, the returned token is masked (BREACH protection).
func (s *HybridStore) Generate(_ context.Context, userID, origin string) (string, error) {
	tok, _, err := s.generator.Generate(userID, origin)
	if err != nil {
		return "", err
	}

	if s.xorMask {
		masked, err := token.Mask(tok)
		if err != nil {
			slog.Warn("XOR masking failed, returning raw token", "error", err)
			return tok, nil
		}
		return masked, nil
	}

	return tok, nil
}

// Validate checks a token using the tiered approach:
// 1. If token looks like UUID → fall back to Redis (legacy backward compat)
// 2. XOR unmask if enabled
// 3. HMAC verify (L2)
// 4. Check L1 Cuckoo (consumed?)
// 5. Check L3 Redis Cuckoo (consumed cross-pod?)
// 6. Mark consumed in L1 + async L3
func (s *HybridStore) Validate(ctx context.Context, userID, reqToken, origin string) (bool, error) {
	// Legacy UUID detection: UUIDs are 36 chars with hyphens at positions 8,13,18,23
	if isLegacyUUID(reqToken) {
		return s.validateLegacyRedis(ctx, userID, reqToken, origin)
	}

	// XOR unmask if enabled
	rawToken := reqToken
	if s.xorMask {
		unmasked, err := token.Unmask(reqToken)
		if err != nil {
			// Could be a raw HMAC token (masking wasn't applied) — try as-is
			rawToken = reqToken
		} else {
			rawToken = unmasked
		}
	}

	// L2: HMAC verify
	payload, err := s.generator.Verify(rawToken)
	if err != nil {
		return false, nil // Invalid/expired/tampered → reject silently
	}

	// Check user binding
	if payload.Sub != userID {
		return false, nil
	}

	// Check origin binding (if both present)
	if payload.Org != "" && origin != "" {
		if subtle.ConstantTimeCompare([]byte(payload.Org), []byte(origin)) != 1 {
			return false, nil
		}
	}

	jti := payload.Jti[:]

	// L1: Check in-memory Cuckoo (already consumed on this pod?)
	if s.cuckooL1.Lookup(jti) {
		return false, nil // Already consumed
	}

	// L3: Check Redis Cuckoo (consumed on another pod?)
	if s.redisL3 != nil {
		consumed, err := s.redisL3.SIsMember(ctx, "csrf:consumed", string(jti)).Result()
		if err != nil {
			slog.Warn("L3 Redis lookup failed", "error", err)
			if s.failClosed {
				return false, err
			}
			// Fail-open: proceed with L1 only
		} else if consumed {
			s.cuckooL1.Insert(jti) // Promote to L1
			return false, nil
		}
	}

	// Mark consumed: L1 immediately
	s.cuckooL1.Insert(jti)

	// L3: mark consumed async (cross-pod)
	if s.redisL3 != nil {
		go func() {
			asyncCtx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
			defer cancel()
			pipe := s.redisL3.Pipeline()
			pipe.SAdd(asyncCtx, "csrf:consumed", string(jti))
			pipe.Expire(asyncCtx, "csrf:consumed", 2*s.ttl) // Expire the set after 2x TTL
			if _, err := pipe.Exec(asyncCtx); err != nil {
				slog.Warn("L3 Redis mark-consumed failed", "error", err)
			}
		}()
	}

	return true, nil
}

// RefreshTTL is a no-op for hybrid store — TTL is embedded in the HMAC token.
func (s *HybridStore) RefreshTTL(_ context.Context, _ string) error {
	return nil // TTL is in the token's `iat` field
}

// Ping checks Redis connectivity (for health probes).
func (s *HybridStore) Ping(ctx context.Context) error {
	if s.redisL3 == nil {
		return nil // No Redis = always healthy
	}
	return s.redisL3.Ping(ctx).Err()
}

// Close releases the Redis connection.
func (s *HybridStore) Close() error {
	if s.redisL3 != nil {
		return s.redisL3.Close()
	}
	return nil
}

// validateLegacyRedis handles legacy UUID tokens stored in Redis.
// This provides backward compatibility during rolling upgrades.
func (s *HybridStore) validateLegacyRedis(ctx context.Context, userID, reqToken, origin string) (bool, error) {
	if s.redisL3 == nil {
		return false, nil // No Redis → can't validate legacy tokens
	}

	stored, err := s.redisL3.Get(ctx, keyPrefix+userID).Result()
	if err != nil {
		if err == redis.Nil {
			return false, nil
		}
		if s.failClosed {
			return false, err
		}
		return true, err // Fail-open
	}

	storedToken := stored
	storedOrigin := ""
	if idx := strings.Index(stored, "|"); idx >= 0 {
		storedToken = stored[:idx]
		storedOrigin = stored[idx+1:]
	}

	valid := subtle.ConstantTimeCompare([]byte(storedToken), []byte(reqToken)) == 1
	if valid && storedOrigin != "" && origin != "" {
		valid = subtle.ConstantTimeCompare([]byte(storedOrigin), []byte(origin)) == 1
	}

	if valid {
		s.redisL3.Del(ctx, keyPrefix+userID)
	}
	return valid, nil
}

// isLegacyUUID checks if a token looks like a UUID v4 (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).
func isLegacyUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	return s[8] == '-' && s[13] == '-' && s[18] == '-' && s[23] == '-'
}
