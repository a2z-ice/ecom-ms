// CSRF Service — Gateway-level CSRF protection for the BookStore platform.
// Provides token generation and ext_authz validation via Istio.
// Supports three modes: "redis" (legacy UUID), "hmac" (pure stateless), "hybrid" (HMAC + Redis L3).
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bookstore/csrf-service/internal/config"
	"github.com/bookstore/csrf-service/internal/cuckoo"
	"github.com/bookstore/csrf-service/internal/handler"
	"github.com/bookstore/csrf-service/internal/introspect"
	"github.com/bookstore/csrf-service/internal/middleware"
	"github.com/bookstore/csrf-service/internal/origin"
	"github.com/bookstore/csrf-service/internal/ratelimit"
	"github.com/bookstore/csrf-service/internal/store"
	"github.com/bookstore/csrf-service/internal/token"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	cfg := config.Load()

	metrics := middleware.NewMetrics()
	originValidator := origin.NewValidator(cfg.AllowedOrigins, cfg.RequireOrigin)

	// Redis client (shared by rate limiter, introspector, and L3/legacy store)
	redisClient := redis.NewClient(&redis.Options{
		Addr:         cfg.RedisAddr,
		Password:     cfg.RedisPassword,
		DB:           0,
		DialTimeout:  2 * time.Second,
		ReadTimeout:  1 * time.Second,
		WriteTimeout: 1 * time.Second,
		PoolSize:     100,
		MinIdleConns: 20,
	})

	// Initialize token store based on mode
	var tokenStore store.TokenStore
	var stopKeyRotation func()
	var stopCuckooRotation func()

	switch cfg.Mode {
	case "hmac", "hybrid":
		// HMAC key ring
		kr, err := token.NewKeyRing(cfg.HMACKey, cfg.TokenTTL)
		if err != nil {
			slog.Error("Failed to initialize HMAC key ring", "error", err)
			os.Exit(1)
		}
		stopKeyRotation = kr.StartAutoRotation(time.Duration(cfg.KeyRotateHours) * time.Hour)

		gen := token.NewGenerator(kr, cfg.TokenTTL)
		cf := cuckoo.NewRollingFilter(cfg.CuckooCapacity)
		stopCuckooRotation = cf.StartAutoRotation(cfg.TokenTTL)

		var l3Redis *redis.Client
		if cfg.Mode == "hybrid" {
			l3Redis = redisClient
		}

		tokenStore = store.NewHybridStore(gen, cf, l3Redis, cfg.TokenTTL, cfg.FailClosed, cfg.XORMasking)

		slog.Info("CSRF service using HMAC mode",
			"mode", cfg.Mode,
			"xorMasking", cfg.XORMasking,
			"cuckooCapacity", cfg.CuckooCapacity,
			"keyRotateHours", cfg.KeyRotateHours,
		)

	default: // "redis" — legacy mode
		tokenStore = store.NewRedisStore(cfg.RedisAddr, cfg.RedisPassword, cfg.TokenTTL, cfg.FailClosed)
		slog.Info("CSRF service using legacy Redis mode")
	}

	// Rate limiter
	var rateLimiter ratelimit.Limiter
	switch cfg.RateLimitMode {
	case "local":
		rateLimiter = ratelimit.NewLocalLimiter(cfg.RateLimitPerMin)
		slog.Info("Using in-memory rate limiter")
	default:
		rateLimiter = ratelimit.NewRedisLimiter(redisClient, cfg.RateLimitPerMin)
		slog.Info("Using Redis rate limiter")
	}

	// Introspector
	var introspector introspect.Introspector
	if cfg.IntrospectEnabled && cfg.IntrospectURL != "" {
		introspector = introspect.NewKeycloakIntrospector(
			cfg.IntrospectURL,
			cfg.IntrospectClientID,
			cfg.IntrospectClientSecret,
			redisClient,
			cfg.IntrospectCacheTTL,
			cfg.IntrospectFailOpen,
			cfg.IntrospectTimeout,
		)
		slog.Info("JWT introspection enabled",
			"url", cfg.IntrospectURL,
			"cacheTTL", cfg.IntrospectCacheTTL,
			"failOpen", cfg.IntrospectFailOpen,
		)
	} else {
		introspector = &introspect.NoopIntrospector{}
	}

	h := handler.New(tokenStore, metrics, originValidator, rateLimiter, introspector,
		cfg.AllowedAudiences, cfg.ValidateAudience, cfg.SlidingTTL)

	// Verify Redis connectivity
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := tokenStore.Ping(ctx); err != nil {
		if cfg.FailClosed {
			slog.Warn("Redis not reachable at startup — will fail-closed", "error", err)
		} else {
			slog.Warn("Redis not reachable at startup — will fail-open", "error", err)
		}
	} else {
		slog.Info("Connected to Redis", "addr", cfg.RedisAddr)
	}

	failMode := "fail-open"
	if cfg.FailClosed {
		failMode = "fail-closed"
	}
	slog.Info("CSRF service configuration",
		"mode", cfg.Mode,
		"failMode", failMode,
		"tokenTTL", cfg.TokenTTL,
		"slidingTTL", cfg.SlidingTTL,
		"rateLimit", cfg.RateLimitPerMin,
		"rateLimitMode", cfg.RateLimitMode,
		"validateAudience", cfg.ValidateAudience,
		"requireOrigin", cfg.RequireOrigin,
		"allowedOrigins", cfg.AllowedOrigins,
	)

	// Wire routes
	mux := http.NewServeMux()
	mux.HandleFunc("GET /csrf/token", h.GenerateToken)
	mux.HandleFunc("GET /healthz", h.Healthz)
	mux.HandleFunc("GET /livez", h.Livez)
	mux.Handle("GET /metrics", promhttp.Handler())
	mux.HandleFunc("/", h.ExtAuthzCheck)

	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Start server
	go func() {
		slog.Info("CSRF service starting", "port", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("Server failed", "error", err)
			os.Exit(1)
		}
	}()

	// Graceful shutdown
	sigCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down gracefully (10s drain)...")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	srv.Shutdown(shutdownCtx)
	if stopKeyRotation != nil {
		stopKeyRotation()
	}
	if stopCuckooRotation != nil {
		stopCuckooRotation()
	}
	tokenStore.Close()
	redisClient.Close()
	slog.Info("CSRF service stopped")
}
