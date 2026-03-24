package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	redisKeyPrefix = "csrf:"
	tokenTTL       = 30 * time.Minute
)

var (
	rdb         *redis.Client
	safeMethods = map[string]bool{
		"GET": true, "HEAD": true, "OPTIONS": true, "TRACE": true,
	}
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	redisHost := envOrDefault("CSRF_REDIS_HOST", "redis.infra.svc.cluster.local")
	redisPort := envOrDefault("CSRF_REDIS_PORT", "6379")
	redisPass := envOrDefault("CSRF_REDIS_PASSWORD", "")

	rdb = redis.NewClient(&redis.Options{
		Addr:     fmt.Sprintf("%s:%s", redisHost, redisPort),
		Password: redisPass,
		DB:       0,
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
	// ext_authz check: Envoy sends the original method/path as headers
	// All non-matched routes hit this handler
	mux.HandleFunc("/", handleExtAuthzCheck)

	port := envOrDefault("PORT", "8080")
	slog.Info("CSRF service starting", "port", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		slog.Error("Server failed", "error", err)
		os.Exit(1)
	}
}

// handleGenerateToken generates a CSRF token for the authenticated user.
// JWT signature is already verified by Istio RequestAuthentication.
func handleGenerateToken(w http.ResponseWriter, r *http.Request) {
	userID := extractSubFromJWT(r.Header.Get("Authorization"))
	if userID == "" {
		http.Error(w, `{"type":"about:blank","title":"Unauthorized","status":401,"detail":"Missing or invalid JWT"}`, http.StatusUnauthorized)
		return
	}

	token := uuid.New().String()
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	if err := rdb.Set(ctx, redisKeyPrefix+userID, token, tokenTTL).Err(); err != nil {
		slog.Warn("Failed to store CSRF token in Redis — returning token anyway", "user", userID, "error", err)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": token})
}

// handleExtAuthzCheck is called by Envoy ext_authz for every request.
// Safe methods pass through immediately. Mutating methods require valid CSRF token.
func handleExtAuthzCheck(w http.ResponseWriter, r *http.Request) {
	// ext_authz sends the original request method in the request itself
	method := r.Method
	if safeMethods[method] {
		w.WriteHeader(http.StatusOK)
		return
	}

	// Mutating method — validate CSRF token
	authHeader := r.Header.Get("Authorization")
	csrfToken := r.Header.Get("X-Csrf-Token")

	userID := extractSubFromJWT(authHeader)
	if userID == "" {
		// No JWT — let the backend handle auth (will return 401)
		w.WriteHeader(http.StatusOK)
		return
	}

	if csrfToken == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"type":"about:blank","title":"Forbidden","status":403,"detail":"Invalid or missing CSRF token"}`)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	stored, err := rdb.Get(ctx, redisKeyPrefix+userID).Result()
	if err != nil {
		if err == redis.Nil {
			// No token stored — reject
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprint(w, `{"type":"about:blank","title":"Forbidden","status":403,"detail":"Invalid or missing CSRF token"}`)
			return
		}
		// Redis error — fail-open
		slog.Warn("Redis error during CSRF validation — failing open", "user", userID, "error", err)
		w.WriteHeader(http.StatusOK)
		return
	}

	if stored != csrfToken {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"type":"about:blank","title":"Forbidden","status":403,"detail":"Invalid or missing CSRF token"}`)
		return
	}

	// Valid — refresh TTL
	rdb.Expire(ctx, redisKeyPrefix+userID, tokenTTL)
	w.WriteHeader(http.StatusOK)
}

func handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"status":"ok"}`)
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

	// Base64url decode the payload (second part)
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
