# CSRF Service

Gateway-level CSRF token service for the BookStore platform. Provides centralized CSRF protection for all backend services (ecom-service, inventory-service, and any future services) via Istio's ext_authz mechanism.

## Architecture

```
Browser → Istio Gateway → AuthorizationPolicy (CUSTOM action)
                               ↓
                         csrf-service (ext_authz)
                          /           \
                   Safe methods    Mutating methods
                   (GET/HEAD/...)  (POST/PUT/DELETE/PATCH)
                       ↓                  ↓
                   Return 200        Validate X-CSRF-Token
                   (pass through)    against Redis
                                     /         \
                                  Valid       Invalid
                                  200          403
```

## Prerequisites

- Go 1.25+
- Docker
- kind cluster with bookstore context
- Redis running in the `infra` namespace

## Quick Start

### Run locally (for development)

```bash
# Start a local Redis
docker run -d --name csrf-redis -p 6379:6379 redis:7-alpine

# Set environment variables
export CSRF_REDIS_HOST=localhost
export CSRF_REDIS_PORT=6379
export CSRF_REDIS_PASSWORD=

# Run the service
go run main.go
```

The service starts at `http://localhost:8080`.

### Run tests

```bash
go test -v ./...
```

Expected: 19 tests pass (uses miniredis — no real Redis needed).

### Build Docker image

```bash
docker build -t bookstore/csrf-service:latest .
```

### Deploy to Kubernetes (kind cluster)

```bash
# Build, test, and deploy in one command:
bash scripts/csrf-service-up.sh

# Or step by step:
docker build -t bookstore/csrf-service:latest .
kind load docker-image bookstore/csrf-service:latest --name bookstore
kubectl apply -f k8s/csrf-service.yaml
kubectl rollout status deploy/csrf-service -n infra --timeout=60s
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/csrf/token` | JWT required | Generate a CSRF token (stored in Redis, 10min sliding TTL) |
| `GET` | `/healthz` | None | Readiness probe (checks Redis connectivity) |
| `GET` | `/livez` | None | Liveness probe (always returns 200) |
| `GET` | `/metrics` | None | Prometheus metrics |
| `*` | `/` | ext_authz | Envoy ext_authz check handler (validates CSRF on mutations) |

## Configuration

All configuration via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CSRF_REDIS_HOST` | `redis.infra.svc.cluster.local` | Redis hostname |
| `CSRF_REDIS_PORT` | `6379` | Redis port |
| `CSRF_REDIS_PASSWORD` | (empty) | Redis password |
| `PORT` | `8080` | HTTP server port |

Environment variable names use the `CSRF_` prefix to avoid collision with Kubernetes auto-injected service env vars (`REDIS_PORT=tcp://...`).

## Prometheus Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `csrf_requests_total` | Counter | `method`, `result` | Total requests by handler and outcome |
| `csrf_redis_errors_total` | Counter | — | Total Redis errors (connection, timeout) |
| `csrf_request_duration_seconds` | Histogram | `handler` | Request latency |

## Kubernetes Resources

Deployed to the `infra` namespace:

- **Secret**: `csrf-service-secret` (Redis connection credentials)
- **Deployment**: 2 replicas, distroless image, non-root (65532), read-only filesystem
- **Service**: ClusterIP on port 8080
- **HPA**: 2-5 replicas, CPU 70% target
- **PDB**: minAvailable 1
- **PeerAuthentication**: PERMISSIVE on port 8080 (gateway compatibility)
- **NetworkPolicy**: Ingress from gateway only, egress to Redis + DNS only

## Istio Integration

The service integrates with Istio via three layers:

1. **extensionProvider** in Istio mesh config — registers `csrf-ext-authz` provider
2. **AuthorizationPolicy** (`infra/istio/csrf-envoy-filter.yaml`) — CUSTOM action targeting the gateway
3. **HTTPRoute** (`infra/kgateway/routes/csrf-route.yaml`) — exposes `GET /csrf/token`

## Project Structure

```
csrf-service/
├── main.go                        # Thin wiring: config → store → handler → server
├── internal/
│   ├── config/config.go           # Config struct + env var loading
│   ├── jwt/
│   │   ├── extract.go             # JWT sub claim extraction (base64 decode only)
│   │   └── extract_test.go        # 8 JWT extraction tests
│   ├── store/
│   │   ├── redis.go               # TokenStore interface + Redis implementation
│   │   └── redis_test.go          # 6 store tests (miniredis)
│   ├── handler/
│   │   ├── token.go               # GET /csrf/token handler
│   │   ├── authz.go               # ext_authz check handler
│   │   ├── health.go              # /healthz (readiness) + /livez (liveness)
│   │   └── handler_test.go        # 11 handler tests
│   └── middleware/
│       └── metrics.go             # Prometheus metrics registration
├── Dockerfile                     # Multi-stage: golang:1.25-alpine → distroless
├── go.mod                         # Dependencies: uuid, go-redis, prometheus, miniredis
├── go.sum                         # Checksums
├── README.md                      # This file
├── scripts/
│   └── csrf-service-up.sh         # Build, test, deploy script
└── k8s/
    └── csrf-service.yaml          # Secret + Deployment + Service
```

### Package Responsibilities

| Package | Responsibility |
|---------|---------------|
| `main` | Wiring: load config, create store, create handlers, start server, graceful shutdown |
| `internal/config` | Environment variable loading into typed Config struct |
| `internal/jwt` | JWT payload decoding (base64 only — Istio verifies signatures) |
| `internal/store` | `TokenStore` interface + Redis implementation (generate, validate, ping) |
| `internal/handler` | HTTP handlers (token generation, ext_authz check, health probes) |
| `internal/middleware` | Prometheus metrics (counters, histograms) |

## Security

- Tokens: UUID v4 (122 bits cryptographic randomness)
- Comparison: timing-safe (`subtle.ConstantTimeCompare`)
- JWT: Base64 decode only (signature verified by Istio upstream)
- Fail-open: Redis errors allow requests through (JWT remains primary defense)
- Container: non-root, read-only filesystem, all capabilities dropped, seccompProfile RuntimeDefault
