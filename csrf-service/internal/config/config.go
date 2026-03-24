// Package config loads service configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"time"
)

// Config holds all service configuration.
type Config struct {
	Port          string
	RedisAddr     string
	RedisPassword string
	TokenTTL      time.Duration
}

// Load reads configuration from environment variables with sensible defaults.
func Load() Config {
	host := envOrDefault("CSRF_REDIS_HOST", "redis.infra.svc.cluster.local")
	port := envOrDefault("CSRF_REDIS_PORT", "6379")
	return Config{
		Port:          envOrDefault("PORT", "8080"),
		RedisAddr:     fmt.Sprintf("%s:%s", host, port),
		RedisPassword: envOrDefault("CSRF_REDIS_PASSWORD", ""),
		TokenTTL:      30 * time.Minute,
	}
}

func envOrDefault(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}
