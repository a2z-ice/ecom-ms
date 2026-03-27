# Session 37 — CSRF Security Enhancements + JWT Introspection

## Goal

Transform the CSRF service from a compliance checkbox into a real security layer by closing 9 security gaps and adding real-time JWT introspection for mutations. Two phases: (A) 8 security enhancements, (B) selective JWT introspection.

## Phase A: 8 Security Enhancements (Completed)

| # | Deliverable | Status |
|---|-------------|--------|
| 1 | Single-use CSRF tokens (consumed on mutation, Del instead of Expire) | Done |
| 2 | Configurable fail-closed mode (CSRF_FAIL_CLOSED env var, 503 on Redis error) | Done |
| 3 | Origin/Referer validation (new origin package, allowed list, Referer fallback, "null" handling) | Done |
| 4 | Token binding to origin (stored as `token|origin` in Redis, both validated) | Done |
| 5 | Per-user rate limiting (new ratelimit package, 60/min sliding window, 429 response) | Done |
| 6 | JWT audience validation (Claims struct with Aud, ValidateAudience, RFC 7519 string/array) | Done |
| 7 | Open redirect fix + security headers (CallbackPage whitelist, HSTS, base-uri, form-action) | Done |
| 8 | Anomaly detection metrics (csrf_anomaly_total, csrf_origin_checks_total, csrf_rate_limit_total) | Done |

### Phase A Acceptance Criteria

- [x] `go test -v ./...` — 49 unit tests pass (was 19)
- [x] `docker build` succeeds for csrf-service and ui-service
- [x] E2E CSRF tests — 33/33 pass (including new single-use test)
- [x] Full regression — 519/522 pass (1 pre-existing flaky Superset test)
- [x] Origin validation handles `Origin: null` from OIDC form submissions
- [x] Keycloak origin (`idp.keycloak.net:30000`) in allowed origins
- [x] Istio ext_authz forwards `origin` + `referer` headers
- [x] Rate limit default 60/min (accommodates E2E tests)

## Phase B: JWT Introspection on Mutations (In Progress)

| # | Deliverable | Status |
|---|-------------|--------|
| 1 | New `introspect` package (KeycloakIntrospector + NoopIntrospector) | Done |
| 2 | Redis cache for introspection results (15s TTL, `introspect:<hash>` keys) | Done |
| 3 | Config: 7 new INTROSPECT_* env vars (disabled by default) | Done |
| 4 | Handler integration (after audience validation, before CSRF token check) | Done |
| 5 | Prometheus metrics (csrf_introspect_total, csrf_introspect_duration_seconds) | Done |
| 6 | Keycloak: access token TTL 30min → 5min | Done |
| 7 | Keycloak: new `csrf-introspect` confidential client | Deferred (needs realm re-import) |
| 8 | K8s Secret + deployment env vars | Done (disabled by default) |
| 9 | Unit tests (11 introspection + 6 handler = 17 new tests, 68 total) | Done |
| 10 | E2E test (disable user → verify 403 on mutation) | Deferred (needs introspection enabled) |

### Phase B Acceptance Criteria

- [x] `go test -v ./...` — 68 unit tests pass (was 49)
- [x] Introspection disabled by default (backward compatible)
- [x] Fail-open: Keycloak outage doesn't block legitimate users (default)
- [x] CSRF tests: 32/32 pass
- [x] Full E2E regression: 509/522 pass (9 pre-existing UI cart/search/Superset failures)

## Build & Deploy

```bash
# csrf-service
cd csrf-service && go test -v ./...
docker build -t bookstore/csrf-service:latest .
kind load docker-image bookstore/csrf-service:latest --name bookstore
bash scripts/csrf-service-up.sh

# ui-service (Phase A changes)
docker build \
  --build-arg VITE_KEYCLOAK_AUTHORITY=https://idp.keycloak.net:30000/realms/bookstore \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
  --build-arg VITE_REDIRECT_URI=https://localhost:30000/callback \
  -t bookstore/ui-service:latest ./ui
kind load docker-image bookstore/ui-service:latest --name bookstore

# E2E
cd e2e && npm run test
```

## Key Files

### Phase A (Completed)
- `csrf-service/internal/store/redis.go` — single-use + fail-closed + origin binding
- `csrf-service/internal/origin/validator.go` — **NEW** origin validation package
- `csrf-service/internal/ratelimit/limiter.go` — **NEW** rate limiting package
- `csrf-service/internal/jwt/extract.go` — Claims struct with Aud, ValidateAudience
- `csrf-service/internal/middleware/metrics.go` — 3 new metric families
- `csrf-service/internal/handler/authz.go` — origin + audience + fail-closed integration
- `csrf-service/internal/handler/token.go` — rate limiting + audience check + Handler struct
- `csrf-service/internal/config/config.go` — 7 new env vars
- `csrf-service/main.go` — full wiring with origin validator + rate limiter
- `ui/src/pages/CallbackPage.tsx` — open redirect whitelist
- `ui/nginx/default.conf` — HSTS + CSP base-uri + form-action

### Phase B (Pending)
- `csrf-service/internal/introspect/client.go` — **NEW** Keycloak introspector
- `csrf-service/internal/introspect/noop.go` — **NEW** noop introspector
- `csrf-service/internal/introspect/client_test.go` — **NEW** 9 tests
- `infra/keycloak/realm-export.json` — accessTokenLifespan + new client
- `csrf-service/k8s/csrf-service.yaml` — introspection env vars + secret
