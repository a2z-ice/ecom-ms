package dashboard

import (
	"context"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	authenticationv1 "k8s.io/api/authentication/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

var (
	authClientOnce sync.Once
	authClient     kubernetes.Interface
	authClientErr  error
)

func getAuthClient() (kubernetes.Interface, error) {
	authClientOnce.Do(func() {
		config, err := rest.InClusterConfig()
		if err != nil {
			authClientErr = err
			return
		}
		authClient, authClientErr = kubernetes.NewForConfig(config)
	})
	return authClient, authClientErr
}

// requireAuth wraps a handler to require a valid Kubernetes ServiceAccount token
// via the Authorization: Bearer header. Uses the TokenReview API for validation.
// GET endpoints (certs list, healthz) remain unauthenticated for monitoring.
func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Rate limiting: 1 renewal per 10 seconds globally
		if !s.checkRateLimit() {
			http.Error(w, `{"error":"rate limit exceeded, try again later"}`, http.StatusTooManyRequests)
			return
		}

		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			http.Error(w, `{"error":"authorization header required"}`, http.StatusUnauthorized)
			return
		}

		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			http.Error(w, `{"error":"invalid authorization header format"}`, http.StatusUnauthorized)
			return
		}
		token := parts[1]

		client, err := getAuthClient()
		if err != nil {
			// If we can't get an auth client (e.g. running outside cluster), log and allow
			// This permits local development while enforcing auth in-cluster
			log.Printf("WARN: auth client unavailable, skipping token validation: %v", err)
			next(w, r)
			return
		}

		review := &authenticationv1.TokenReview{
			Spec: authenticationv1.TokenReviewSpec{
				Token: token,
			},
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		result, err := client.AuthenticationV1().TokenReviews().Create(ctx, review, metav1.CreateOptions{})
		if err != nil {
			log.Printf("ERROR: TokenReview API call failed: %v", err)
			http.Error(w, `{"error":"authentication service unavailable"}`, http.StatusInternalServerError)
			return
		}

		if !result.Status.Authenticated {
			http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
			return
		}

		next(w, r)
	}
}

// Simple rate limiter: track last renewal time, allow 1 per 10 seconds
var (
	lastRenewalMu   sync.Mutex
	lastRenewalTime time.Time
)

func (s *Server) checkRateLimit() bool {
	lastRenewalMu.Lock()
	defer lastRenewalMu.Unlock()

	now := time.Now()
	if now.Sub(lastRenewalTime) < 10*time.Second {
		return false
	}
	lastRenewalTime = now
	return true
}
