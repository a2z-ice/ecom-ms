// Package config loads service configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all service configuration.
type Config struct {
	Port             string
	RedisAddr        string
	RedisPassword    string
	TokenTTL         time.Duration
	SlidingTTL       bool
	FailClosed       bool
	AllowedOrigins   []string
	RequireOrigin    bool
	AllowedAudiences []string
	ValidateAudience bool
	RateLimitPerMin        int
	IntrospectEnabled      bool
	IntrospectURL          string
	IntrospectClientID     string
	IntrospectClientSecret string
	IntrospectCacheTTL     time.Duration
	IntrospectFailOpen     bool
	IntrospectTimeout      time.Duration

	// Hybrid HMAC mode (Session 30)
	Mode             string        // "redis" (legacy), "hmac" (stateless), "hybrid" (recommended)
	HMACKey          string        // Base64-encoded 256-bit key (from CSRF_HMAC_KEY)
	KeyRotateHours   int           // Auto-rotate interval (default: 24)
	XORMasking       bool          // Enable BREACH XOR masking (default: true)
	CuckooCapacity   uint          // Cuckoo filter capacity (default: 1000000)
	RateLimitMode    string        // "redis" or "local" (default: "local")
}

// Load reads configuration from environment variables with sensible defaults.
func Load() Config {
	host := envOrDefault("CSRF_REDIS_HOST", "redis.infra.svc.cluster.local")
	port := envOrDefault("CSRF_REDIS_PORT", "6379")

	ttlMin, _ := strconv.Atoi(envOrDefault("CSRF_TOKEN_TTL_MINUTES", "10"))
	if ttlMin <= 0 {
		ttlMin = 10
	}

	rateLimit, _ := strconv.Atoi(envOrDefault("CSRF_RATE_LIMIT", "60"))
	if rateLimit <= 0 {
		rateLimit = 10
	}

	cuckooCapacity := envInt("CSRF_CUCKOO_CAPACITY", 1000000)

	return Config{
		Port:             envOrDefault("PORT", "8080"),
		RedisAddr:        fmt.Sprintf("%s:%s", host, port),
		RedisPassword:    envOrDefault("CSRF_REDIS_PASSWORD", ""),
		TokenTTL:         time.Duration(ttlMin) * time.Minute,
		SlidingTTL:       envOrDefault("CSRF_SLIDING_TTL", "true") == "true",
		FailClosed:       envOrDefault("CSRF_FAIL_CLOSED", "false") == "true",
		AllowedOrigins:   parseCSV(envOrDefault("CSRF_ALLOWED_ORIGINS", "https://myecom.net:30000,https://localhost:30000,https://idp.keycloak.net:30000")),
		RequireOrigin:    envOrDefault("CSRF_REQUIRE_ORIGIN", "false") == "true",
		AllowedAudiences: parseCSV(envOrDefault("CSRF_ALLOWED_AUDIENCES", "ui-client")),
		ValidateAudience: envOrDefault("CSRF_VALIDATE_AUDIENCE", "false") == "true",
		RateLimitPerMin:        rateLimit,
		IntrospectEnabled:      envOrDefault("INTROSPECT_ENABLED", "false") == "true",
		IntrospectURL:          envOrDefault("INTROSPECT_URL", ""),
		IntrospectClientID:     envOrDefault("INTROSPECT_CLIENT_ID", ""),
		IntrospectClientSecret: envOrDefault("INTROSPECT_CLIENT_SECRET", ""),
		IntrospectCacheTTL:     time.Duration(envInt("INTROSPECT_CACHE_TTL_SECONDS", 15)) * time.Second,
		IntrospectFailOpen:     envOrDefault("INTROSPECT_FAIL_OPEN", "true") == "true",
		IntrospectTimeout:      time.Duration(envInt("INTROSPECT_TIMEOUT_MS", 3000)) * time.Millisecond,

		Mode:           envOrDefault("CSRF_MODE", "hybrid"),
		HMACKey:        envOrDefault("CSRF_HMAC_KEY", ""),
		KeyRotateHours: envInt("CSRF_KEY_ROTATE_HOURS", 24),
		XORMasking:     envOrDefault("CSRF_XOR_MASKING", "true") == "true",
		CuckooCapacity: uint(cuckooCapacity),
		RateLimitMode:  envOrDefault("CSRF_RATELIMIT_MODE", "local"),
	}
}

func envInt(key string, defaultVal int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return defaultVal
}

func envOrDefault(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}

func parseCSV(s string) []string {
	parts := strings.Split(s, ",")
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			result = append(result, p)
		}
	}
	return result
}
