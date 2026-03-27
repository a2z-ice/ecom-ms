// Package introspect provides JWT token introspection via Keycloak's
// RFC 7662 token introspection endpoint. Results are cached in Redis
// to minimize latency and Keycloak load.
package introspect

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const cachePrefix = "introspect:"

// Introspector checks whether a JWT token is still active via the
// authorization server's introspection endpoint (RFC 7662).
type Introspector interface {
	// IsActive returns true if the token is active (user not disabled,
	// session not terminated, token not revoked).
	IsActive(ctx context.Context, rawToken string) (bool, error)
}

// KeycloakIntrospector calls Keycloak's token introspection endpoint
// with Redis caching for performance.
type KeycloakIntrospector struct {
	httpClient   *http.Client
	introspectURL string
	clientID      string
	clientSecret  string
	redis         *redis.Client
	cacheTTL      time.Duration
	failOpen      bool
}

// NewKeycloakIntrospector creates a new introspector backed by Keycloak.
func NewKeycloakIntrospector(
	introspectURL, clientID, clientSecret string,
	redisClient *redis.Client,
	cacheTTL time.Duration,
	failOpen bool,
	timeout time.Duration,
) *KeycloakIntrospector {
	return &KeycloakIntrospector{
		httpClient: &http.Client{
			Timeout: timeout,
		},
		introspectURL: introspectURL,
		clientID:      clientID,
		clientSecret:  clientSecret,
		redis:         redisClient,
		cacheTTL:      cacheTTL,
		failOpen:      failOpen,
	}
}

func (k *KeycloakIntrospector) IsActive(ctx context.Context, rawToken string) (bool, error) {
	cacheKey := cachePrefix + tokenHash(rawToken)

	// Check Redis cache first
	cached, err := k.redis.Get(ctx, cacheKey).Result()
	if err == nil {
		return cached == "1", nil
	}
	if err != redis.Nil {
		slog.Warn("Redis cache read error during introspection", "error", err)
		// Fall through to Keycloak call
	}

	// Cache miss — call Keycloak
	active, err := k.callKeycloak(ctx, rawToken)
	if err != nil {
		slog.Warn("Keycloak introspection failed", "error", err)
		if k.failOpen {
			return true, err // Allow request through
		}
		return false, err // Block request
	}

	// Cache the result
	value := "0"
	if active {
		value = "1"
	}
	if cacheErr := k.redis.Set(ctx, cacheKey, value, k.cacheTTL).Err(); cacheErr != nil {
		slog.Warn("Failed to cache introspection result", "error", cacheErr)
	}

	return active, nil
}

func (k *KeycloakIntrospector) callKeycloak(ctx context.Context, rawToken string) (bool, error) {
	form := url.Values{
		"token":           {rawToken},
		"token_type_hint": {"access_token"},
	}

	req, err := http.NewRequestWithContext(ctx, "POST", k.introspectURL, strings.NewReader(form.Encode()))
	if err != nil {
		return false, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(k.clientID, k.clientSecret)

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return false, fmt.Errorf("introspection call: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return false, fmt.Errorf("introspection returned %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Active bool `json:"active"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return false, fmt.Errorf("decode response: %w", err)
	}

	return result.Active, nil
}

// tokenHash returns a short hash of the token for use as a Redis cache key.
func tokenHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:8]) // 16 hex chars
}
