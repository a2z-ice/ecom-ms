# Testing Production Improvements — Step-by-Step Guide

This guide covers manual testing for all Session 23-24 production improvements.

---

## E2E Test Stability & Back-Channel Logout (Latest)

### What Changed

**E2E Test Stability (155/155 tests passing, zero flaky):**
- Added `e2e/global-setup.ts` — runs once before all tests:
  - Resets inventory: `UPDATE inventory SET quantity = 50, reserved = 0`
  - Clears cart items: `DELETE FROM cart_items`
  - Uses `kubectl exec` to access DBs directly (bypasses API rate limits)
- Rewrote `e2e/fixtures/base.ts` — per-test cart clearing via DB:
  - `clearCartViaDb()` runs before every test (kubectl exec → psql DELETE)
  - OIDC sessionStorage injection via `addInitScript` (reads `user1-session.json`)
  - Replaced API-based cart clearing (caused HTTP 429 from Bucket4j rate limits)
- All spec files hardened:
  - Replaced `waitForTimeout()` with proper Playwright assertions
  - Added auth wait guards (`logout` button visible)
  - Added stock-loaded wait guards (`In Stock` badge visible)
  - Used `waitForResponse` for POST /cart confirmation
  - Made tests self-contained (each test adds its own items)

**Back-Channel Logout:**
- `ui/src/auth/AuthContext.tsx` — `logout()` rewritten:
  - Gets current user from `userManager.getUser()`
  - POSTs `client_id` + `refresh_token` to Keycloak's `/protocol/openid-connect/logout`
  - This ends the Keycloak SSO session server-side (no browser redirect needed)
  - Then clears local session: `removeUser()` + `setUser(null)`
  - Navigates to home: `window.location.href = origin + '/'`
  - No Keycloak UI interaction needed — single click logout
- Previous approach (broken): `signoutRedirect()` after `removeUser()` stripped `id_token_hint` → Keycloak showed confirmation page requiring user action

### New E2E Tests (3 tests in `auth.spec.ts`)
1. **logout clears session without Keycloak redirect** — intercepts the POST, verifies `client_id=ui-client` and `refresh_token=` in body
2. **after logout, SSO session is ended** — fresh browser context shows Login button (not auto-logged-in)
3. **after logout, protected API returns 401** — unauthenticated GET /cart returns 401

### How to Test
```bash
cd e2e && npm run test          # all 155 tests
npx playwright test auth.spec.ts  # auth + logout tests only
```

### Key Files Modified
- `e2e/global-setup.ts` (NEW)
- `e2e/fixtures/base.ts` (rewritten)
- `e2e/auth.spec.ts` (rewritten with 3 new back-channel logout tests)
- `e2e/cart.spec.ts` (self-contained tests)
- `e2e/checkout.spec.ts` (removed duplicate helpers)
- `e2e/cdc.spec.ts` (added wait guards)
- `e2e/stock-management.spec.ts` (replaced waitForTimeout, added guards)
- `e2e/mtls-enforcement.spec.ts` (added wait guards)
- `e2e/ui-fixes.spec.ts` (removed duplicate helpers)
- `ui/src/auth/AuthContext.tsx` (back-channel logout)

---

## Prerequisites

```bash
# Cluster must be running with all services
kubectl get pods -A --no-headers | grep Running | wc -l  # Should be 20+

# Docker images built and loaded
kind load docker-image bookstore/ecom-service:latest --name bookstore
kind load docker-image bookstore/inventory-service:latest --name bookstore
kind load docker-image bookstore/ui-service:latest --name bookstore
```

---

## 1. Circuit Breaker (ecom-service)

### What it does
Resilience4j circuit breaker on the ecom→inventory `POST /reserve` call. Opens after 10 failures (50% threshold), stays open for 10s.

### How to test

**Unit tests (automated):**
```bash
cd ecom-service
mvn test -Dtest='com.bookstore.ecom.client.InventoryClientTest'
# 7 tests: reserve success, circuit opens after failures, 409/404/500 handling
```

**Manual verification:**
```bash
# Check that normal checkout still works
# 1. Login at http://localhost:30000
# 2. Add a book to cart
# 3. Checkout — should succeed

# Verify circuit breaker config in logs
kubectl logs -n ecom deploy/ecom-service | grep -i "circuit"
```

---

## 2. HTTP Timeouts (ecom-service → inventory-service)

### What it does
Connect timeout: 5s, Read timeout: 10s on RestClient calls to inventory-service.

### How to test

**Unit tests:**
```bash
mvn test -Dtest='com.bookstore.ecom.client.InventoryClientTest'
# Tests verify timeout exceptions are wrapped as BusinessException
```

**Manual verification:**
```bash
# The timeouts are configured in RestClientConfig.java
# Check via ecom-service startup logs
kubectl logs -n ecom deploy/ecom-service | head -50
```

---

## 3. Cache-Control Headers (Book Catalog)

### What it does
`GET /ecom/books` and `GET /ecom/books/search` return `Cache-Control: max-age=60, public`.
`GET /ecom/books/{id}` does NOT have Cache-Control.

### How to test

**Unit tests:**
```bash
mvn test -Dtest='com.bookstore.ecom.controller.BookControllerTest'
# 4 tests verify Cache-Control headers
```

**Integration tests:**
```bash
mvn test -Dtest='com.bookstore.ecom.integration.BookApiIntegrationTest'
# 10 tests including Cache-Control verification
```

**Manual curl:**
```bash
# List books — should have Cache-Control
curl -sI http://api.service.net:30000/ecom/books | grep -i cache-control
# Expected: Cache-Control: max-age=60, public

# Search books — should have Cache-Control
curl -sI "http://api.service.net:30000/ecom/books/search?q=java" | grep -i cache-control
# Expected: Cache-Control: max-age=60, public

# Single book — should NOT have Cache-Control
curl -sI http://api.service.net:30000/ecom/books/00000000-0000-0000-0000-000000000001 | grep -i cache-control
# Expected: (empty)
```

---

## 4. N+1 Query Fix (@EntityGraph)

### What it does
`@EntityGraph(attributePaths = {"book"})` on CartItemRepository queries eliminates N+1 selects when loading cart items.

### How to test

**Unit tests:**
```bash
mvn test -Dtest='com.bookstore.ecom.service.CartServiceTest'
# 10 tests verify cart operations with eager-loaded books
```

**Manual verification:**
```bash
# Enable SQL logging temporarily
kubectl exec -n ecom deploy/ecom-service -- env | grep -i sql
# Add 3 items to cart, then GET /ecom/cart
# Check logs — should see 1 SELECT with JOIN, not 1+3 queries
kubectl logs -n ecom deploy/ecom-service --tail=50 | grep SELECT
```

---

## 5. Graceful Shutdown

### What it does
- ecom-service: `server.shutdown: graceful`, 20s timeout
- inventory-service: `--timeout-graceful-shutdown 20`
- All services have `preStop: sleep 5` hook

### How to test

```bash
# Check ecom-service config
kubectl exec -n ecom deploy/ecom-service -- cat /workspace/application.yml 2>/dev/null | grep shutdown
# Or check via env
kubectl describe pod -n ecom -l app=ecom-service | grep -A2 preStop

# Check inventory-service CMD
kubectl describe pod -n inventory -l app=inventory-service | grep -A5 "Command\|Args"

# Verify preStop hook exists on all 3 services
for ns_app in "ecom ecom-service" "inventory inventory-service" "ecom ui-service"; do
  ns=$(echo $ns_app | cut -d' ' -f1)
  app=$(echo $ns_app | cut -d' ' -f2)
  echo "=== ${app} ==="
  kubectl get pod -n $ns -l app=$app -o jsonpath='{.items[0].spec.containers[0].lifecycle.preStop}' 2>/dev/null
  echo
done
```

---

## 6. Startup Probes

### What it does
Startup probes allow slow-starting pods to boot without being killed by liveness probes.
- ecom-service: `/ecom/actuator/health/liveness`, 150s max (30 * 5s)
- inventory-service: `/inven/health`, 100s max (20 * 5s)

### How to test

```bash
# Verify startup probes are configured
kubectl describe pod -n ecom -l app=ecom-service | grep -A5 "Startup"
kubectl describe pod -n inventory -l app=inventory-service | grep -A5 "Startup"
```

---

## 7. JWKS Cache with TTL (inventory-service)

### What it does
Caches JWKS keys for 5 minutes using `cachetools.TTLCache`. On JWT validation failure, invalidates cache and retries once.

### How to test

**Unit tests:**
```bash
cd inventory-service
poetry run pytest tests/test_auth.py -v
# 6 tests: cache hit, TTL expiry, retry on JWTError, etc.
```

**Manual verification:**
```bash
# Make an authenticated request and check logs for cache message
TOKEN=$(curl -s -X POST "http://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=ui-client&username=admin1&password=CHANGE_ME" \
  -H "Content-Type: application/x-www-form-urlencoded" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

curl -s http://api.service.net:30000/inven/admin/stock \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | head -20

# Check logs for JWKS cache message
kubectl logs -n inventory deploy/inventory-service | grep -i "jwks"
# Expected: "JWKS fetched and cached (TTL=300s)"
```

---

## 8. Kafka Consumer Supervision

### What it does
Consumer restarts with exponential backoff (1s → 2s → 4s → ... → 60s max) on crashes. CancelledError propagates cleanly for graceful shutdown.

### How to test

**Unit tests:**
```bash
poetry run pytest tests/test_consumer.py -v
# 5 tests: restart after exception, backoff increasing, backoff capped, etc.
```

**Manual verification:**
```bash
# Check consumer is running
kubectl logs -n inventory deploy/inventory-service | grep -i "consumer"
# Expected: "Starting Kafka consumer (supervised)..."

# Do a checkout to trigger consumer processing
# Then check logs for inventory.updated events
kubectl logs -n inventory deploy/inventory-service | grep -i "inventory.updated"
```

---

## 9. Health & Readiness Endpoints (inventory-service)

### What it does
- `GET /inven/health` → liveness (always returns `{"status": "ok"}`)
- `GET /inven/health/ready` → readiness (checks DB with `SELECT 1`)

### How to test

**Unit tests:**
```bash
poetry run pytest tests/test_health.py -v
# 3 tests: health ok, ready ok, ready 503 when DB down
```

**Manual curl:**
```bash
# Liveness probe
curl -s http://api.service.net:30000/inven/health
# Expected: {"status":"ok"}

# Readiness probe
curl -s http://api.service.net:30000/inven/health/ready
# Expected: {"status":"ready"}
```

---

## 10. Prometheus Metrics (inventory-service)

### What it does
`prometheus-fastapi-instrumentator` exposes request metrics at `GET /inven/metrics`.

### How to test

```bash
curl -s http://api.service.net:30000/inven/metrics | head -20
# Expected: Prometheus text format with http_request_duration_seconds metrics
```

---

## 11. Structured JSON Logging

### What it does
- ecom-service: ECS format via `logging.structured.format.console: ecs`
- inventory-service: JSON via `python-json-logger`

### How to test

```bash
# ecom-service — JSON logs
kubectl logs -n ecom deploy/ecom-service --tail=5
# Expected: structured JSON with @timestamp, log.level, message fields

# inventory-service — JSON logs
kubectl logs -n inventory deploy/inventory-service --tail=5
# Expected: structured JSON with timestamp, level, logger fields
```

---

## 12. React ErrorBoundary & 404 Page

### What it does
- `ErrorBoundary` component wraps all Routes — catches React rendering errors
- `/nonexistent-page` → NotFoundPage with "Page Not Found" heading and "Browse Catalog" link

### How to test

**E2E tests:**
```bash
cd e2e && npx playwright test production-improvements.spec.ts --grep "404"
```

**Manual browser testing:**
```
1. Open http://localhost:30000/nonexistent-page
2. Verify "Page Not Found" heading appears
3. Verify "Browse Catalog" link points to /
4. Verify NavBar is still visible
5. Click "Browse Catalog" — should go to catalog
```

---

## 13. Admin Code Splitting (React.lazy)

### What it does
Admin pages load as separate JS chunks via `React.lazy()`. Catalog page does not download admin JS.

### How to test

```bash
# Build and check chunk output
cd ui && npm run build
# Look for admin chunks in dist/assets/
ls -la dist/assets/ | grep -i admin
# Expected: AdminDashboard-*.js, AdminBooksPage-*.js, etc.
```

**E2E test:**
```bash
cd e2e && npx playwright test production-improvements.spec.ts --grep "code splitting"
```

---

## 14. Nginx Asset Caching

### What it does
`/assets/` location serves files with `Cache-Control: public, max-age=31536000, immutable`.

### How to test

```bash
# Find an asset URL
ASSET_URL=$(curl -s http://localhost:30000/ | grep -oP 'src="/assets/[^"]+' | head -1 | sed 's/src="//')
echo "Asset URL: $ASSET_URL"

# Check headers
curl -sI "http://localhost:30000${ASSET_URL}" | grep -i cache-control
# Expected: Cache-Control: public, max-age=31536000, immutable
```

---

## 15. NetworkPolicies

### What it does
Default-deny ingress + explicit allow rules for all namespaces (infra, identity, analytics, observability).

### How to test

```bash
# List all network policies
kubectl get networkpolicy -A
# Expected: policies in ecom, inventory, infra, identity, analytics, observability

# Verify traffic still flows (these should all return 200)
curl -s -o /dev/null -w "%{http_code}" http://api.service.net:30000/ecom/books
curl -s -o /dev/null -w "%{http_code}" http://api.service.net:30000/inven/health
curl -s -o /dev/null -w "%{http_code}" http://localhost:30000/
echo ""
```

---

## 16. Schema Registry

### What it does
Confluent Schema Registry deployed alongside Kafka for CDC schema governance.
Debezium publishes with `schemas.enable=true` — messages include schema metadata.

### How to test

```bash
# Check Schema Registry health
kubectl exec -n infra deploy/kafka -- curl -s http://schema-registry.infra.svc.cluster.local:8081/subjects | python3 -m json.tool
# Expected: list of registered subjects

# Check Schema Registry pod
kubectl get pod -n infra -l app=schema-registry
# Expected: Running
```

---

## 17. Grafana Dashboards

### What it does
Grafana at `http://localhost:32500` with pre-provisioned dashboards:
- Service Health (request rates, error rates, p50/p99 latency)
- Cluster Overview (pods by phase, restarts, CPU/memory usage)

### How to test

```bash
# Health check
curl -s http://localhost:32500/api/health | python3 -m json.tool
# Expected: {"commit":"...","database":"ok","version":"..."}

# Login
open http://localhost:32500
# Credentials: admin / CHANGE_ME

# Check dashboards via API
curl -s http://localhost:32500/api/search \
  -H "Authorization: Basic $(echo -n admin:CHANGE_ME | base64)" | python3 -m json.tool
# Expected: 2 dashboards (service-health, cluster-overview)
```

---

## 18. AlertManager

### What it does
Prometheus AlertManager with 4 alert rules:
- HighErrorRate (>5% 5xx for 2min)
- PodRestartLoop (>3 restarts/hour for 5min)
- HighLatency (p99 >1s for 5min)
- KafkaConsumerLag (>100 for 5min)

### How to test

```bash
# Check AlertManager health
kubectl exec -n observability deploy/alertmanager -- wget -qO- http://localhost:9093/-/ready
# Expected: OK

# Check Prometheus alert rules
kubectl exec -n observability deploy/prometheus -- wget -qO- http://localhost:9090/api/v1/rules | python3 -m json.tool | head -30
# Expected: 4 alert rules listed
```

---

## 19. Rate Limiting (Bucket4j)

### What it does
In-memory token bucket rate limiting per user/IP:
- `/ecom/checkout`: 5 req/min
- `/ecom/cart`: 30 req/min
- `/ecom/admin/**`: 20 req/min
- `/ecom/books/**`: 100 req/min

### How to test

```bash
# Send 105 rapid requests to /ecom/books — last few should get 429
for i in $(seq 1 105); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" http://api.service.net:30000/ecom/books)
  if [ "$CODE" = "429" ]; then
    echo "Rate limited at request $i"
    break
  fi
done
# Expected: "Rate limited at request 101" (approximately)

# Check 429 response body
curl -s http://api.service.net:30000/ecom/books -H "X-Forwarded-For: rate-test-ip" | python3 -m json.tool
# After limit: {"type":"about:blank","title":"Too Many Requests","status":429,"detail":"Rate limit exceeded. Try again later."}
```

---

## 20. Kafka Dead Letter Topic

### What it does
Failed order processing (after 3 retries) sends the message to `order.created.dlq` topic.

### How to test

```bash
# Check if DLQ topic exists (auto-create is disabled, so this may return empty)
kubectl exec -n infra deploy/kafka -- kafka-topics --bootstrap-server localhost:9092 --list | grep dlq
# Note: DLQ topic is created on first failed message; may not exist if all processing succeeded
```

---

## 21. OpenTelemetry Tracing

### What it does
- ecom-service: OTel Java agent auto-instrumentation via `-javaagent:/otel/opentelemetry-javaagent.jar`
- inventory-service: OTel Python SDK with OTLP gRPC exporter

### How to test

```bash
# Check ecom-service has OTel agent configured
kubectl describe pod -n ecom -l app=ecom-service | grep OTEL
# Expected: OTEL_SERVICE_NAME=ecom-service, OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector...

# Check inventory-service OTel config
kubectl describe pod -n inventory -l app=inventory-service | grep OTEL
# Expected: OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME

# Note: Traces are exported to OTel Collector (if deployed) — without collector, the agent
# logs connection errors but does NOT affect application functionality.
kubectl logs -n ecom deploy/ecom-service | grep -i "otel\|opentelemetry" | head -5
```

---

## 22. HPA Behavior Configuration

### What it does
HorizontalPodAutoscaler with:
- Scale down: 300s stabilization, max 50% pods removed per 60s
- Scale up: 30s stabilization, max 100% pods added per 30s

### How to test

```bash
kubectl get hpa -n ecom -o yaml | grep -A20 behavior
# Expected: scaleDown stabilizationWindowSeconds: 300, scaleUp: 30
```

---

## 23. JVM Memory Flags (ecom-service)

### What it does
`-XX:MaxRAMPercentage=75.0 -XX:+UseG1GC` via `JAVA_TOOL_OPTIONS` env var.

### How to test

```bash
kubectl describe pod -n ecom -l app=ecom-service | grep JAVA_TOOL_OPTIONS
# Expected: -XX:MaxRAMPercentage=75.0 -XX:+UseG1GC -javaagent:/otel/opentelemetry-javaagent.jar
```

---

## Running All Automated Tests

### Unit Tests (ecom-service — 42 tests)
```bash
cd ecom-service && mvn test
# 26 unit + 16 integration = 42 tests
```

### Unit Tests (inventory-service — 21 tests)
```bash
cd inventory-service && poetry run pytest -v
# 21 tests: auth (6), consumer (5), health (3), stock (7)
```

### E2E Tests (155 tests)
```bash
cd e2e && npm run test
# 155 tests (includes production-improvements.spec.ts + back-channel logout tests)
```

### Quick Smoke Test
```bash
bash scripts/smoke-test.sh
```

---

## Summary of Test Coverage

| Area | Unit Tests | Integration Tests | E2E Tests | Manual |
|------|-----------|-------------------|-----------|--------|
| Circuit breaker | 7 | - | checkout tests | - |
| Cache-Control | 4 | 2 | 3 (API headers) | curl |
| N+1 fix | 10 | - | cart tests | SQL logs |
| JWKS cache | 6 | - | auth tests | curl + logs |
| Consumer supervision | 5 | - | CDC tests | logs |
| Health endpoints | 3 | - | 2 | curl |
| Prometheus metrics | - | - | 1 | curl |
| Rate limiting | - | - | 1 (rapid) | curl loop |
| 404 page | - | - | 3 | browser |
| Code splitting | - | - | 2 | build output |
| Grafana | - | - | 3 | browser |
| NetworkPolicies | - | - | 3 | curl |
| Schema Registry | - | - | - | kubectl |
| Graceful shutdown | - | - | - | kubectl describe |
| Startup probes | - | - | - | kubectl describe |
| JSON logging | - | - | - | kubectl logs |
| OTel tracing | - | - | - | kubectl describe |
| HPA behavior | - | - | - | kubectl get |
| JVM flags | - | - | - | kubectl describe |
