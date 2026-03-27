package introspect

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func setupTest(t *testing.T, handler http.HandlerFunc, failOpen bool) (*KeycloakIntrospector, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	rc := redis.NewClient(&redis.Options{Addr: mr.Addr()})

	ts := httptest.NewServer(handler)
	t.Cleanup(func() { ts.Close(); mr.Close(); rc.Close() })

	ki := NewKeycloakIntrospector(
		ts.URL+"/introspect",
		"test-client", "test-secret",
		rc, 15*time.Second, failOpen, 5*time.Second,
	)
	return ki, mr
}

func TestIsActive_ActiveToken(t *testing.T) {
	ki, _ := setupTest(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]bool{"active": true})
	}, true)

	active, err := ki.IsActive(context.Background(), "valid-jwt-token")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !active {
		t.Error("expected active=true")
	}
}

func TestIsActive_InactiveToken(t *testing.T) {
	ki, _ := setupTest(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]bool{"active": false})
	}, true)

	active, err := ki.IsActive(context.Background(), "revoked-jwt-token")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if active {
		t.Error("expected active=false for revoked token")
	}
}

func TestIsActive_CacheHit(t *testing.T) {
	var callCount atomic.Int32
	ki, mr := setupTest(t, func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		json.NewEncoder(w).Encode(map[string]bool{"active": true})
	}, true)

	// Pre-populate cache
	hash := tokenHash("cached-token")
	mr.Set(cachePrefix+hash, "1")

	active, err := ki.IsActive(context.Background(), "cached-token")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !active {
		t.Error("expected active=true from cache")
	}
	if callCount.Load() != 0 {
		t.Errorf("expected 0 Keycloak calls (cache hit), got %d", callCount.Load())
	}
}

func TestIsActive_CacheMiss_ThenHit(t *testing.T) {
	var callCount atomic.Int32
	ki, _ := setupTest(t, func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		json.NewEncoder(w).Encode(map[string]bool{"active": true})
	}, true)

	// First call — cache miss, calls Keycloak
	active1, _ := ki.IsActive(context.Background(), "new-token")
	if !active1 {
		t.Error("first call should return active")
	}

	// Second call — cache hit, no Keycloak call
	active2, _ := ki.IsActive(context.Background(), "new-token")
	if !active2 {
		t.Error("second call should return active from cache")
	}

	if callCount.Load() != 1 {
		t.Errorf("expected exactly 1 Keycloak call, got %d", callCount.Load())
	}
}

func TestIsActive_KeycloakDown_FailOpen(t *testing.T) {
	ki, _ := setupTest(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}, true) // failOpen=true

	active, err := ki.IsActive(context.Background(), "any-token")
	if err == nil {
		t.Error("expected error when Keycloak is down")
	}
	if !active {
		t.Error("fail-open should return active=true on error")
	}
}

func TestIsActive_KeycloakDown_FailClosed(t *testing.T) {
	ki, _ := setupTest(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}, false) // failOpen=false

	active, err := ki.IsActive(context.Background(), "any-token")
	if err == nil {
		t.Error("expected error when Keycloak is down")
	}
	if active {
		t.Error("fail-closed should return active=false on error")
	}
}

func TestIsActive_InvalidResponse(t *testing.T) {
	ki, _ := setupTest(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("not json"))
	}, true)

	active, err := ki.IsActive(context.Background(), "any-token")
	if err == nil {
		t.Error("expected error for invalid JSON response")
	}
	if !active {
		t.Error("fail-open should return active=true on parse error")
	}
}

func TestIsActive_RedisDown_StillCallsKeycloak(t *testing.T) {
	var callCount atomic.Int32
	ki, mr := setupTest(t, func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		json.NewEncoder(w).Encode(map[string]bool{"active": true})
	}, true)

	// Kill Redis
	mr.Close()

	active, err := ki.IsActive(context.Background(), "redis-down-token")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !active {
		t.Error("should return active from Keycloak even with Redis down")
	}
	if callCount.Load() != 1 {
		t.Errorf("expected 1 Keycloak call, got %d", callCount.Load())
	}
}

func TestIsActive_SendsBasicAuth(t *testing.T) {
	ki, _ := setupTest(t, func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "test-client" || pass != "test-secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		json.NewEncoder(w).Encode(map[string]bool{"active": true})
	}, true)

	active, err := ki.IsActive(context.Background(), "auth-test-token")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !active {
		t.Error("expected active=true with correct basic auth")
	}
}

func TestIsActive_CachesInactiveToken(t *testing.T) {
	var callCount atomic.Int32
	ki, _ := setupTest(t, func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		json.NewEncoder(w).Encode(map[string]bool{"active": false})
	}, true)

	// First call — caches inactive result
	active1, _ := ki.IsActive(context.Background(), "disabled-user-token")
	if active1 {
		t.Error("should be inactive")
	}

	// Second call — returns cached inactive without calling Keycloak
	active2, _ := ki.IsActive(context.Background(), "disabled-user-token")
	if active2 {
		t.Error("cached result should still be inactive")
	}

	if callCount.Load() != 1 {
		t.Errorf("expected 1 Keycloak call (second should be cached), got %d", callCount.Load())
	}
}

func TestNoopIntrospector(t *testing.T) {
	n := &NoopIntrospector{}
	active, err := n.IsActive(context.Background(), "any")
	if err != nil {
		t.Fatal(err)
	}
	if !active {
		t.Error("noop should always return active")
	}
}
