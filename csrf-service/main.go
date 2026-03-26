// CSRF Service — Gateway-level CSRF protection for the BookStore platform.
// Provides token generation and ext_authz validation via Istio.
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
	"github.com/bookstore/csrf-service/internal/handler"
	"github.com/bookstore/csrf-service/internal/middleware"
	"github.com/bookstore/csrf-service/internal/origin"
	"github.com/bookstore/csrf-service/internal/ratelimit"
	"github.com/bookstore/csrf-service/internal/store"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	cfg := config.Load()

	// Initialize dependencies
	tokenStore := store.NewRedisStore(cfg.RedisAddr, cfg.RedisPassword, cfg.TokenTTL, cfg.FailClosed)
	metrics := middleware.NewMetrics()
	originValidator := origin.NewValidator(cfg.AllowedOrigins, cfg.RequireOrigin)

	// Rate limiter shares the same Redis connection config
	redisClient := redis.NewClient(&redis.Options{
		Addr:     cfg.RedisAddr,
		Password: cfg.RedisPassword,
		DB:       0,
	})
	rateLimiter := ratelimit.NewRedisLimiter(redisClient, cfg.RateLimitPerMin)

	h := handler.New(tokenStore, metrics, originValidator, rateLimiter,
		cfg.AllowedAudiences, cfg.ValidateAudience)

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
		"mode", failMode,
		"tokenTTL", cfg.TokenTTL,
		"rateLimit", cfg.RateLimitPerMin,
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
	tokenStore.Close()
	redisClient.Close()
	slog.Info("CSRF service stopped")
}
