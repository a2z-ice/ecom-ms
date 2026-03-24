package main

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
)

const (
	redisKeyPrefix = "csrf:"
	tokenTTL       = 30 * time.Minute
)

// Exported for testing
var (
	rdb         *redis.Client
	safeMethods = map[string]bool{
		"GET": true, "HEAD": true, "OPTIONS": true, "TRACE": true,
	}
)

// ── Prometheus metrics ──────────────────────────────────────────────────────

var (
	requestsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "csrf_requests_total",
		Help: "Total CSRF service requests by method and result",
	}, []string{"method", "result"})

	redisErrorsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "csrf_redis_errors_total",
		Help: "Total Redis errors (connection, timeout, etc.)",
	})

	requestDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "csrf_request_duration_seconds",
		Help:    "Request duration in seconds",
		Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0},
	}, []string{"handler"})
)

func init() {
	prometheus.MustRegister(requestsTotal, redisErrorsTotal, requestDuration)
}

// ── Main ────────────────────────────────────────────────────────────────────

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	redisHost := envOrDefault("CSRF_REDIS_HOST", "redis.infra.svc.cluster.local")
	redisPort := envOrDefault("CSRF_REDIS_PORT", "6379")
	redisPass := envOrDefault("CSRF_REDIS_PASSWORD", "")

	rdb = redis.NewClient(&redis.Options{
		Addr:         fmt.Sprintf("%s:%s", redisHost, redisPort),
		Password:     redisPass,
		DB:           0,
		DialTimeout:  2 * time.Second,
		ReadTimeout:  1 * time.Second,
		WriteTimeout: 1 * time.Second,
		PoolSize:     10,
		MinIdleConns: 2,
	})

	// Verify Redis connectivity at startup
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		slog.Warn("Redis not reachable at startup — will fail-open", "error", err)
	} else {
		slog.Info("Connected to Redis", "addr", fmt.Sprintf("%s:%s", redisHost, redisPort))
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /csrf/token", handleGenerateToken)
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /livez", handleLivez)
	mux.Handle("GET /metrics", promhttp.Handler())
	// ext_authz check: Envoy sends the original method/path as headers.
	// All non-matched routes hit this handler.
	mux.HandleFunc("/", handleExtAuthzCheck)

	port := envOrDefault("PORT", "8080")
	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Start server in background goroutine
	go func() {
		slog.Info("CSRF service starting", "port", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("Server failed", "error", err)
			os.Exit(1)
		}
	}()

	// Graceful shutdown on SIGTERM/SIGINT
	sigCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	<-sigCtx.Done()

	slog.Info("Shutting down gracefully (10s drain)...")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("Shutdown error", "error", err)
	}
	if err := rdb.Close(); err != nil {
		slog.Warn("Redis client close error", "error", err)
	}
	slog.Info("CSRF service stopped")
}

// ── Handlers ────────────────────────────────────────────────────────────────

// handleGenerateToken generates a CSRF token for the authenticated user.
// JWT signature is already verified by Istio RequestAuthentication.
func handleGenerateToken(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	defer func() { requestDuration.WithLabelValues("generate").Observe(time.Since(start).Seconds()) }()

	userID := extractSubFromJWT(r.Header.Get("Authorization"))
	if userID == "" {
		requestsTotal.WithLabelValues("generate", "unauthorized").Inc()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"type":"about:blank","title":"Unauthorized","status":401,"detail":"Missing or invalid JWT"}`)
		return
	}

	token := uuid.New().String()
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	if err := rdb.Set(ctx, redisKeyPrefix+userID, token, tokenTTL).Err(); err != nil {
		redisErrorsTotal.Inc()
		slog.Warn("Failed to store CSRF token in Redis — returning token anyway", "user", userID, "error", err)
	}

	requestsTotal.WithLabelValues("generate", "ok").Inc()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": token})
}

// handleExtAuthzCheck is called by Envoy ext_authz for every request.
// Safe methods pass through immediately. Mutating methods require valid CSRF token.
func handleExtAuthzCheck(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	defer func() { requestDuration.WithLabelValues("authz").Observe(time.Since(start).Seconds()) }()

	method := r.Method
	if safeMethods[method] {
		requestsTotal.WithLabelValues("authz_safe", "ok").Inc()
		w.WriteHeader(http.StatusOK)
		return
	}

	// Mutating method — validate CSRF token
	authHeader := r.Header.Get("Authorization")
	csrfToken := r.Header.Get("X-Csrf-Token")

	userID := extractSubFromJWT(authHeader)
	if userID == "" {
		// No JWT — let the backend handle auth (will return 401)
		requestsTotal.WithLabelValues("authz_noauth", "ok").Inc()
		w.WriteHeader(http.StatusOK)
		return
	}

	if csrfToken == "" {
		requestsTotal.WithLabelValues("authz_mutate", "missing_token").Inc()
		writeForbidden(w)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	stored, err := rdb.Get(ctx, redisKeyPrefix+userID).Result()
	if err != nil {
		if err == redis.Nil {
			requestsTotal.WithLabelValues("authz_mutate", "no_stored_token").Inc()
			writeForbidden(w)
			return
		}
		// Redis error — fail-open
		redisErrorsTotal.Inc()
		slog.Warn("Redis error during CSRF validation — failing open", "user", userID, "error", err)
		requestsTotal.WithLabelValues("authz_mutate", "redis_error_failopen").Inc()
		w.WriteHeader(http.StatusOK)
		return
	}

	// Timing-safe comparison to prevent side-channel attacks
	if subtle.ConstantTimeCompare([]byte(stored), []byte(csrfToken)) != 1 {
		requestsTotal.WithLabelValues("authz_mutate", "invalid_token").Inc()
		writeForbidden(w)
		return
	}

	// Valid — refresh TTL
	if err := rdb.Expire(ctx, redisKeyPrefix+userID, tokenTTL).Err(); err != nil {
		redisErrorsTotal.Inc()
		slog.Warn("Failed to refresh CSRF token TTL", "user", userID, "error", err)
	}
	requestsTotal.WithLabelValues("authz_mutate", "ok").Inc()
	w.WriteHeader(http.StatusOK)
}

// handleHealthz checks Redis connectivity (used as readiness probe).
func handleHealthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 1*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"status":"error","detail":"Redis unreachable"}`)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"status":"ok"}`)
}

// handleLivez always returns 200 (used as liveness probe).
func handleLivez(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"status":"ok"}`)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

func writeForbidden(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	fmt.Fprint(w, `{"type":"about:blank","title":"Forbidden","status":403,"detail":"Invalid or missing CSRF token"}`)
}

// extractSubFromJWT decodes the JWT payload (base64) to get the "sub" claim.
// No signature verification — Istio RequestAuthentication already validated the JWT.
func extractSubFromJWT(authHeader string) string {
	if !strings.HasPrefix(authHeader, "Bearer ") {
		return ""
	}
	token := strings.TrimPrefix(authHeader, "Bearer ")
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}

	var claims struct {
		Sub string `json:"sub"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ""
	}
	return claims.Sub
}

func envOrDefault(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}
