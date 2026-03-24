# CSRF Service Production Readiness Audit

**Gap analysis, scoring, and remediation plan for the gateway-level CSRF microservice**

---

## 1. Executive Summary

The csrf-service is a functional POC with solid fundamentals (fail-open resilience, proper security context, distroless image, gateway-level enforcement). However, it has gaps in 3 critical areas that must be addressed before production deployment: server hardening, high availability, and observability.

**Overall Score: 62/100** (POC-grade, not production-grade yet)

### Scoring Breakdown

| Category | Score | Max | Notes |
|----------|-------|-----|-------|
| Security | 14 | 20 | Good: non-root, drop-all-caps, fail-open. Gap: timing-safe compare, no rate limiting |
| Resilience | 10 | 20 | Good: fail-open, context timeouts. Gap: no graceful shutdown, no circuit breaker, single replica |
| Observability | 4 | 20 | Good: structured JSON logging. Gap: no Prometheus metrics, no OTel tracing, no Redis health check |
| Kubernetes | 16 | 20 | Good: probes, security context, resource limits. Gap: 1 replica, no HPA, no PDB |
| Code Quality | 12 | 10 | Good: clean code, proper error handling. Minor: expire error not logged |
| Testing | 6 | 10 | Good: 11 E2E tests. Gap: no unit tests, no integration tests |

---

## 2. What's Already Production-Grade (Strengths)

- **Fail-open design**: Redis errors don't block requests. JWT remains primary defense. When Redis is unreachable, the service logs a warning and returns HTTP 200, allowing the request through. This prevents a Redis outage from becoming a total platform outage.

- **Gateway-level enforcement**: Protects ALL services (Java, Python, future Node.js) from one place. The Istio `AuthorizationPolicy` with `action: CUSTOM` routes every gateway request through the csrf-service via ext_authz. No per-service CSRF middleware needed.

- **Security context**: Non-root (`runAsUser: 65532`), `readOnlyRootFilesystem: true`, `drop: ["ALL"]` capabilities, `seccompProfile: RuntimeDefault`. This matches or exceeds the security posture of ecom-service and inventory-service.

- **Distroless image**: `gcr.io/distroless/static:nonroot` — minimal attack surface, no shell, no package manager, no libc. Smallest possible Go runtime image.

- **Static binary**: `CGO_ENABLED=0` produces a fully static binary with no C dependencies. Deterministic builds, no dynamic linking surprises.

- **Structured logging**: `slog.NewJSONHandler` produces machine-parseable JSON logs on stdout, compatible with the platform's log aggregation pipeline (OTel Collector -> Loki).

- **Context timeouts**: 2-second timeout for all Redis operations (`context.WithTimeout`), 5-second timeout for startup health check. Prevents goroutine leaks from hung Redis connections.

- **Proper error responses**: ProblemDetail-style JSON (RFC 9457) on 403 responses with `type`, `title`, `status`, and `detail` fields.

- **UUID v4 tokens**: `google/uuid` uses `crypto/rand` internally, providing 122 bits of cryptographic randomness per token. Not guessable.

- **Istio integration**: `AuthorizationPolicy` with `action: CUSTOM` and `provider: csrf-ext-authz` — the correct Istio 1.28+ approach for gateway-level ext_authz.

- **HTTPRoute configuration**: Clean `csrf-route.yaml` exposes `GET /csrf/token` through the gateway on `api.service.net`.

- **PeerAuthentication**: PERMISSIVE on port 8080 for gateway ext_authz compatibility (gateway connects directly, not through mesh).

---

## 3. Critical Issues (Must Fix)

### 3.1 No Graceful Shutdown

- **Current**: `http.ListenAndServe()` at line 62 blocks forever; SIGTERM kills in-flight requests immediately
- **Impact**: During rolling updates, active ext_authz checks are terminated mid-flight, causing 503 errors for users. Since every mutating request passes through this service, even a brief disruption affects checkout, cart operations, and admin actions.
- **Fix**: Implement `signal.NotifyContext()` + `server.Shutdown()` with 10-second drain period

Before (line 62 in `main.go`):
```go
if err := http.ListenAndServe(":"+port, mux); err != nil {
    slog.Error("Server failed", "error", err)
    os.Exit(1)
}
```

After:
```go
srv := &http.Server{Addr: ":" + port, Handler: mux}
go func() {
    if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
        slog.Error("Server failed", "error", err)
        os.Exit(1)
    }
}()
ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
defer stop()
<-ctx.Done()
slog.Info("Shutting down gracefully...")
shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
defer cancel()
srv.Shutdown(shutdownCtx)
```

### 3.2 HTTP Server Missing Timeouts

- **Current**: No `ReadTimeout`, `WriteTimeout`, `IdleTimeout` configured on the HTTP server
- **Impact**: Vulnerable to Slowloris attacks; connections can hang indefinitely, exhausting file descriptors. Although Istio mesh provides some protection, the service itself should be defensively hardened.
- **Fix**: Configure `*http.Server` with explicit timeouts

```go
srv := &http.Server{
    Addr:         ":" + port,
    Handler:      mux,
    ReadTimeout:  5 * time.Second,
    WriteTimeout: 10 * time.Second,
    IdleTimeout:  60 * time.Second,
}
```

### 3.3 Bootstrap Integration Missing

- **Current**: csrf-service is NOT in `scripts/up.sh` or `scripts/infra-up.sh`
- **Impact**: Fresh cluster bootstrap doesn't deploy the CSRF service; the `csrf-ext-authz` extension provider is unreachable. Because `failOpen: true` is set on the AuthorizationPolicy, the system degrades gracefully — but CSRF protection is silently absent.
- **Fix**: Add docker build + kind load + kubectl apply steps to `up.sh` and/or `infra-up.sh`:

```bash
# In scripts/up.sh or infra-up.sh
docker build -t bookstore/csrf-service:latest ./csrf-service
kind load docker-image bookstore/csrf-service:latest --name bookstore
kubectl apply -f csrf-service/k8s/csrf-service.yaml
kubectl apply -f infra/istio/csrf-envoy-filter.yaml
kubectl apply -f infra/kgateway/routes/csrf-route.yaml
```

---

## 4. High-Priority Issues (Should Fix)

### 4.1 Single Replica (No HA)

- **Current**: `replicas: 1` in `csrf-service/k8s/csrf-service.yaml` — single point of failure
- **Impact**: Pod eviction, node drain, or OOM kill means ext_authz calls timeout. With `failOpen: true`, requests pass through but CSRF protection is silently disabled.
- **Fix**: Scale to `replicas: 2` minimum, add PodDisruptionBudget (`minAvailable: 1`), and HPA (2-5 replicas, 70% CPU target)
- **Comparison**: ecom-service uses `replicas: 2` with HPA

```yaml
# PodDisruptionBudget
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: csrf-service-pdb
  namespace: infra
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: csrf-service
```

### 4.2 No Prometheus Metrics

- **Current**: No `/metrics` endpoint, no request counters, no latency histograms
- **Impact**: Cannot monitor error rates, Redis latency, token generation rate, or validation failures. The csrf-service is invisible to Grafana dashboards.
- **Fix**: Add `prometheus/client_golang` with:
  - Counter: `csrf_requests_total{method,status}`
  - Counter: `csrf_redis_errors_total`
  - Histogram: `csrf_request_duration_seconds{handler}`

### 4.3 No Unit Tests

- **Current**: Zero Go test files in `csrf-service/`
- **Impact**: Regressions undetected; `extractSubFromJWT`, token validation logic, Redis error paths, and safe-method detection are untested at the unit level
- **Fix**: Add `main_test.go` with table-driven tests:
  - `TestExtractSubFromJWT` — valid JWT, missing Bearer, malformed base64, missing sub claim
  - `TestSafeMethodDetection` — GET/HEAD/OPTIONS/TRACE pass, POST/PUT/DELETE/PATCH fail
  - `TestTokenValidation` — matching token, mismatched token, expired token, Redis error

### 4.4 Redis Client Missing Pool/Timeout Config

- **Current**: Default `redis.Options{}` with no `DialTimeout`, `ReadTimeout`, `WriteTimeout`, or pool size configuration
- **Impact**: Under load, Redis connections may exhaust the default pool; slow queries block goroutines indefinitely
- **Fix**: Configure explicit pool and timeouts

```go
rdb = redis.NewClient(&redis.Options{
    Addr:         addr,
    Password:     redisPass,
    DB:           0,
    DialTimeout:  2 * time.Second,
    ReadTimeout:  1 * time.Second,
    WriteTimeout: 1 * time.Second,
    PoolSize:     10,
    MinIdleConns: 2,
})
```

---

## 5. Medium-Priority Issues (Nice to Have)

### 5.1 Non-Timing-Safe Token Comparison

- **Current**: `stored != csrfToken` at line 135 uses standard string comparison
- **Impact**: Theoretically exploitable via timing side-channel attack. Very low risk with UUID tokens (122 bits of entropy), but defense-in-depth recommends constant-time comparison.
- **Fix**: Use `crypto/subtle`:
```go
if subtle.ConstantTimeCompare([]byte(stored), []byte(csrfToken)) != 1 {
```

### 5.2 Redis Expire Error Not Logged

- **Current**: `rdb.Expire(ctx, redisKeyPrefix+userID, tokenTTL)` at line 143 discards the error
- **Impact**: Silent failures in TTL refresh could lead to unexpected token expiration
- **Fix**: Log the error for observability:
```go
if err := rdb.Expire(ctx, redisKeyPrefix+userID, tokenTTL).Err(); err != nil {
    slog.Warn("Failed to refresh CSRF token TTL", "user", userID, "error", err)
}
```

### 5.3 Health Endpoint Doesn't Check Redis

- **Current**: `/healthz` always returns `{"status":"ok"}` regardless of Redis connectivity
- **Impact**: Kubernetes readiness probe passes even when Redis is completely down, so the pod continues receiving traffic but cannot validate tokens (falls back to fail-open)
- **Fix**: Add Redis ping to readiness probe (separate from liveness — liveness should stay simple to avoid restart loops):
```go
func handleReadiness(w http.ResponseWriter, _ *http.Request) {
    ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
    defer cancel()
    if err := rdb.Ping(ctx).Err(); err != nil {
        w.WriteHeader(http.StatusServiceUnavailable)
        json.NewEncoder(w).Encode(map[string]string{"status": "degraded", "redis": err.Error()})
        return
    }
    w.Header().Set("Content-Type", "application/json")
    fmt.Fprint(w, `{"status":"ok","redis":"connected"}`)
}
```

### 5.4 No OpenTelemetry Tracing

- **Current**: No trace context propagation; W3C `traceparent` header is not forwarded
- **Impact**: CSRF validation requests are invisible in Kiali service graph and Tempo traces
- **Fix**: Add OTel HTTP middleware for W3C trace-context propagation, matching the pattern used by ecom-service (Java agent) and inventory-service (Python SDK)

### 5.5 No Rate Limiting on Token Generation

- **Current**: `GET /csrf/token` has no rate limit
- **Impact**: A compromised or malicious client could flood Redis with token writes, consuming memory
- **Fix**: Add simple in-memory rate limiter (`golang.org/x/time/rate`) or rely on gateway-level rate limiting

### 5.6 CPU Request Too Low

- **Current**: `cpu: 25m` request in the Deployment
- **Impact**: May be throttled under concurrent ext_authz checks during traffic spikes
- **Fix**: Increase to `cpu: 50m` to provide adequate baseline

---

## 6. Comparison with Other Services

| Feature | csrf-service | ecom-service | cert-dashboard-operator |
|---------|-------------|-------------|------------------------|
| Language | Go 1.25 | Java 21 (Spring Boot 4.0.3) | Go 1.24 |
| Replicas | 1 | 2 | 1 |
| HPA | No | Yes (2-5) | No |
| PDB | No | Yes (minAvailable: 1) | No |
| Graceful shutdown | No | Yes (Spring lifecycle) | Yes (context cancel) |
| HTTP timeouts | No | Yes (Spring defaults) | No |
| Prometheus metrics | No | Yes (/actuator/prometheus) | No |
| OTel tracing | No | Yes (Java agent) | No |
| Unit tests | No | Yes (42 tests) | No |
| E2E tests | Yes (11 tests) | Yes (full suite) | Yes (29 tests) |
| Security context | Excellent | Excellent | Excellent |
| Distroless image | Yes | No (Eclipse Temurin) | Yes |
| Health probes | Basic (/healthz) | Full (liveness + readiness + startup) | Basic (/healthz) |
| NetworkPolicy | No | Yes | No |
| Rate limiting | No | Yes (Bucket4j) | No |

---

## 7. Remediation Roadmap

### Phase 1 -- Critical (Day 1)

- [ ] Graceful shutdown with `signal.NotifyContext` + 10s drain
- [ ] HTTP server timeouts (`ReadTimeout`, `WriteTimeout`, `IdleTimeout`)
- [ ] Add csrf-service to `scripts/up.sh` and `scripts/infra-up.sh` bootstrap

### Phase 2 -- High Priority (Week 1)

- [ ] Scale to `replicas: 2`
- [ ] Add HPA (2-5 replicas, 70% CPU target)
- [ ] Add PodDisruptionBudget (`minAvailable: 1`)
- [ ] Add Prometheus metrics (`/metrics` endpoint)
- [ ] Configure Redis client pool and timeouts

### Phase 3 -- Medium Priority (Week 2)

- [ ] Add unit tests (`main_test.go`, table-driven)
- [ ] Timing-safe token comparison (`crypto/subtle`)
- [ ] OTel tracing middleware
- [ ] Readiness probe with Redis health check
- [ ] Log `rdb.Expire()` errors
- [ ] Increase CPU request to 50m

---

## 8. Verdict

> The csrf-service is a **well-designed POC** with the right architectural decisions (gateway-level enforcement, fail-open, proper K8s security). It is NOT production-grade yet -- primarily due to missing graceful shutdown, single replica, and no observability metrics. The remediation is straightforward (estimated 1-2 days of work) and does not require architectural changes.

---

## Appendix: File Reference

| File | Purpose |
|------|---------|
| `csrf-service/main.go` | Service implementation (185 lines) |
| `csrf-service/Dockerfile` | Multi-stage build, distroless runtime |
| `csrf-service/go.mod` | Go 1.25, google/uuid, go-redis/v9 |
| `csrf-service/k8s/csrf-service.yaml` | Secret + Deployment + Service |
| `infra/istio/csrf-envoy-filter.yaml` | AuthorizationPolicy (ext_authz CUSTOM) |
| `infra/kgateway/routes/csrf-route.yaml` | HTTPRoute for /csrf/token |
| `e2e/csrf.spec.ts` | 11 E2E tests (Playwright) |
