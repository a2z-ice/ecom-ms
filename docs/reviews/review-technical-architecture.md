# Technical Architecture Review

**Project:** BookStore E-Commerce Microservices Platform
**Reviewer:** Senior Technical Architect
**Date:** 2026-03-08
**Scope:** Full architecture review for production readiness
**Current State:** Sessions 1-22 complete, 130/130 E2E tests passing

---

## 1. Architecture Diagram

```
                            +---------------------------------------------------------------------+
                            |                        kind Cluster (3 nodes)                        |
                            |                                                                     |
  +--------------+          |  +---------------------------------------------------------+        |
  |   Browser     |          |  |              Istio Ambient Mesh (ztunnel mTLS)           |        |
  |  (React SPA)  |          |  |                                                         |        |
  +------+-------+          |  |  +--------------------------------------------------+   |        |
         |                   |  |  |         Kubernetes Gateway API (Istio)            |   |        |
         | :30000            |  |  |         bookstore-gateway (infra ns)              |   |        |
         |                   |  |  +------+----------+--------------+-----------+-----+   |        |
         |                   |  |         |              |              |                  |        |
         v                   |  |         v              v              v                  |        |
  +--------------+          |  |  +------------+ +------------+ +--------------+         |        |
  | Host:30000   |----------+--+->| ui-service | |ecom-service| |  inventory-  |         |        |
  | (NodePort)   |          |  |  | (nginx)    | |(Spring Boot| |  service     |         |        |
  +--------------+          |  |  | ecom ns    | | 4.0.3)     | |  (FastAPI)   |         |        |
                            |  |  |            | | ecom ns    | |  inventory ns|         |        |
                            |  |  |  /ecom/* --+>|            | |              |         |        |
                            |  |  |  /inven/*--+-+------------+-+>             |         |        |
                            |  |  +------------+ |            | |              |         |        |
                            |  |                 | POST       | |              |         |        |
                            |  |                 | /reserve --+>| (mTLS, L4)   |         |        |
                            |  |                 |            | |              |         |        |
                            |  |                 +------+-----+ +------+------+         |        |
                            |  |                        |              |                  |        |
                            |  |                  +-----v-----+  +----v------+           |        |
                            |  |                  |  ecom-db   |  |inventory- |           |        |
                            |  |                  |  (PG 17)   |  |db (PG 17) |           |        |
                            |  |                  |  ecom ns   |  |inv ns     |           |        |
                            |  |                  +-----+------+  +----+------+           |        |
                            |  |                        |              |                  |        |
                            |  |                  +-----v--------------v------+           |        |
                            |  |                  |       Debezium Server     |           |        |
                            |  |                  |  (2 pods: ecom + inv)     |           |        |
                            |  |                  |  infra ns                 |           |        |
                            |  |                  +-------------+------------+            |        |
                            |  |                                | CDC events              |        |
                            |  |                          +-----v-----+                   |        |
                            |  |                          |   Kafka   |                   |        |
                            |  |                          |  (KRaft)  |                   |        |
                            |  |                          |  infra ns |                   |        |
                            |  |                          +-----+-----+                   |        |
                            |  |                                |                         |        |
                            |  |    +---------------------------v------------------+      |        |
                            |  |    |         Flink SQL Pipeline (4 jobs)          |      |        |
                            |  |    |    JobManager + TaskManager + SQL Gateway    |      |        |
                            |  |    |    analytics ns                              |      |        |
                            |  |    +---------------------------+-----------------+      |        |
                            |  |                                | JDBC upsert            |        |
                            |  |                          +-----v------+                  |        |
                            |  |                          |analytics-db|                  |        |
                            |  |                          |  (PG 17)   |                  |        |
                            |  |                          +-----+------+                  |        |
                            |  |                                |                         |        |
                            |  |                          +-----v------+                  |        |
                            |  |                          |  Superset  |                  |        |
                            |  |                          |  (3 dashb) |                  |        |
                            |  |                          +------------+                  |        |
                            |  |                                                         |        |
                            |  |  +------------+  +----------+  +----------+             |        |
                            |  |  |  Keycloak   |  |  Redis   |  | PgAdmin  |             |        |
                            |  |  | identity ns |  | infra ns |  | infra ns |             |        |
                            |  |  +------------+  +----------+  +----------+             |        |
                            |  |                                                         |        |
                            |  |  +--------------------------------------------------+   |        |
                            |  |  |  Observability: Prometheus | Kiali | OTel Coll   |   |        |
                            |  |  |  observability ns + istio-system                  |   |        |
                            |  |  +--------------------------------------------------+   |        |
                            |  +---------------------------------------------------------+        |
                            +---------------------------------------------------------------------+

  External Ports (NodePort via kind extraPortMappings):
    30000  Main Gateway (all services)     32200  Flink Web Dashboard
    31111  PgAdmin                          32300  Debezium ecom health
    32000  Superset                         32301  Debezium inventory health
    32100  Kiali (/kiali)                   32400  Keycloak Admin Console
```

### Communication Patterns Summary

| Pattern | From | To | Protocol | Auth |
|---------|------|----|----------|------|
| Sync REST | Browser | UI/ecom/inventory | HTTP via Gateway | JWT (OIDC PKCE) |
| Sync REST (internal) | ecom-service | inventory-service | HTTP/1.1 | Istio mTLS (SPIFFE) |
| Async Event | ecom-service | Kafka | TCP | None (infra ns) |
| Async Event | Kafka | inventory-service | TCP | None (consumer group) |
| CDC Stream | ecom-db/inv-db | Debezium Server | PostgreSQL replication | DB credentials |
| CDC Stream | Debezium | Kafka | TCP | None (infra ns) |
| Stream Processing | Kafka | Flink | TCP | None |
| JDBC Sink | Flink | analytics-db | PostgreSQL | DB credentials |

---

## 2. Service Architecture Review

### 2.1 ecom-service (Spring Boot 4.0.3)

**Code Organization: GOOD**

Clean layered architecture following Spring conventions:
- `controller/` -- REST endpoints with OpenAPI annotations
- `service/` -- Business logic with `@Transactional` boundaries
- `repository/` -- Spring Data JPA interfaces
- `model/` -- JPA entities (Book, CartItem, Order, OrderItem)
- `dto/` -- Request/response DTOs (records)
- `config/` -- SecurityConfig, KafkaConfig, LiquibaseConfig, RestClientConfig
- `exception/` -- GlobalExceptionHandler with ProblemDetail responses
- `kafka/` -- OrderEventPublisher
- `client/` -- InventoryClient (RestClient)

**API Design: GOOD**

- RESTful resource naming (`/books`, `/cart`, `/cart/{itemId}`, `/admin/books`)
- Proper HTTP verbs (GET/POST/PUT/DELETE)
- Pagination via Spring `Pageable` for list endpoints
- ProblemDetail (RFC 9457) for error responses
- OpenAPI/Swagger documentation with annotations
- Context path `/ecom` correctly set

**Strengths:**
- Stateless JWT validation with custom JWKS URI vs issuer URI split (internal JWKS fetch, external issuer validation)
- Kafka producer with `acks=all`, 3 retries, custom Jackson 3.x serializer
- `@PreAuthorize("hasRole('ADMIN')")` for admin endpoints
- Liquibase migrations with init container pattern (not embedded)
- HikariCP connection pool properly configured (10 max, 2 min idle, 30s timeout)
- Actuator health endpoints (liveness/readiness) correctly exposed

**Concerns:**

1. **No circuit breaker on inventory reserve call (P0).** The `InventoryClient.reserve()` catches exceptions and wraps them as `BusinessException`, but there is no circuit breaker, timeout configuration, or retry policy. If inventory-service is down, every checkout blocks until TCP timeout. Spring Boot 4.0 supports `RestClient` with Resilience4j circuit breakers.

2. **No connection timeout on RestClient (P0).** The `RestClientConfig` forces HTTP/1.1 (correct) but sets no connect/read timeout. Java's `HttpClient` default is infinite. A slow/stuck inventory-service will hold the calling thread indefinitely.

3. **Kafka publish is fire-and-forget after DB commit (P2).** `OrderService.checkout()` commits the order to the database, then publishes `order.created` to Kafka asynchronously. If Kafka is down, the event is logged as an error but the order is already committed. The CDC pipeline (Debezium) captures the same order via WAL, so this is partially mitigated, but the explicit `order.created` event for the inventory consumer will be lost. This is a known trade-off but should be documented as a design decision.

4. **Cart items not cleaned up on orphaned carts (P3).** Cart items persist in the database indefinitely. No TTL, no cleanup job. For a POC this is acceptable; for production, add a scheduled cleanup or use Redis-backed carts with TTL.

5. **No request/response logging middleware (P3).** The `application.yml` sets `com.bookstore: DEBUG` but no structured request/response logging (correlation IDs, request timing). Spring Boot 4.0 supports `HttpExchangeRepository` for this.

### 2.2 inventory-service (Python FastAPI)

**Code Organization: GOOD**

Minimal, well-structured FastAPI application:
- `main.py` -- App factory with CORS, lifespan, routers
- `config.py` -- Pydantic `BaseSettings` for env var loading
- `database.py` -- SQLAlchemy async engine + session factory
- `api/stock.py` -- Public stock endpoints + internal reserve
- `api/admin.py` -- Admin stock management
- `middleware/auth.py` -- JWT validation with JWKS caching
- `kafka/consumer.py` -- Async Kafka consumer + producer
- `models/inventory.py` -- SQLAlchemy model with computed `available` property
- `schemas/inventory.py` -- Pydantic request/response models

**API Design: GOOD**

- RESTful conventions with proper HTTP status codes (404, 409, 400, 403)
- Bulk stock endpoint (`GET /stock/bulk?book_ids=...`) avoids N+1 UI queries
- Internal `/stock/reserve` endpoint uses `SELECT ... FOR UPDATE` for atomic reservation
- Root path `/inven` correctly configured
- Comprehensive OpenAPI documentation with examples

**Strengths:**
- Async throughout (SQLAlchemy async, aiokafka, httpx)
- JWKS cache prevents repeated HTTP calls on every request
- `with_for_update()` row-level locks for inventory reservation (prevents double-booking)
- Manual Kafka commit (`enable_auto_commit=False`) -- at-least-once delivery
- Proper dependency injection via FastAPI `Depends()`
- CORS correctly configured for both `localhost:30000` and `myecom.net:30000`

**Concerns:**

1. **JWKS cache never invalidates (P0).** The `_jwks_cache` is a module-level global set once and never refreshed. If Keycloak rotates its signing keys, the service will reject all JWTs until restarted. Production systems should use a TTL cache (e.g., 5-minute cache with background refresh) or handle `JWTError` by invalidating the cache and retrying once.

2. **Single Kafka consumer with no error recovery (P0).** The `run_consumer()` function starts a single `AIOKafkaConsumer` as an `asyncio.Task`. If the consumer encounters an unrecoverable error (Kafka broker goes down, network partition), it logs the error and raises -- killing the task. The lifespan context only handles `CancelledError` on shutdown. There is no automatic reconnection or supervision loop. If the consumer dies mid-operation, all `order.created` events will queue in Kafka but stock will not be deducted until the pod is restarted.

3. **No audience validation in JWT (P2).** `jwt.decode()` sets `verify_aud: False`. While this works because the service relies on issuer validation + role claims, it means any valid Keycloak token from ANY client in the realm can call admin endpoints. In production, audience validation should be enabled to scope tokens to specific services.

4. **No structured logging (P3).** Uses basic `logging.basicConfig()` with a simple format string. No JSON structured logging, no correlation IDs, no request ID propagation.

5. **No request rate limiting (P3).** Unlike ecom-service (which has Redis-based rate limiting configured in its secret), inventory-service has no rate limiting.

### 2.3 UI Service (React 19.2 + Vite + Nginx)

**Code Organization: GOOD**

Standard React SPA structure:
- `auth/` -- OIDC configuration and AuthContext provider
- `api/` -- HTTP client with token injection, typed API modules
- `pages/` -- Page components (Catalog, Search, Cart, Checkout, Admin)
- `components/` -- Shared components (NavBar, StockBadge, AdminRoute, ProtectedRoute)
- `hooks/` -- Custom hooks (useGuestCart)

**Strengths:**
- OIDC PKCE flow correctly implemented (code flow, not implicit)
- Token storage in sessionStorage (cleared on tab close)
- Dynamic `redirect_uri` from `window.location.origin` (works at both localhost and myecom.net)
- `crypto.subtle` availability check with fallback relay
- Guest cart in localStorage with merge-on-login
- Admin route guard checks decoded JWT roles (client-side UX only; server enforces authorization)
- Nginx security headers (X-Frame-Options, X-Content-Type-Options, CSP, Referrer-Policy)
- Nginx reverse proxy for `/ecom/` and `/inven/` (avoids CORS for same-origin API calls)
- gzip compression enabled

**Concerns:**

1. **CSP is very permissive for connect-src (P2).** The Content-Security-Policy allows `connect-src 'self' http://api.service.net:30000 http://idp.keycloak.net:30000`. While correct for the local setup, production should use HTTPS and stricter CSP directives.

2. **No error boundary (P2).** The React app has no top-level `ErrorBoundary` component. An uncaught render error will crash the entire SPA with a white screen.

3. **sessionStorage instead of InMemoryWebStorage (P3).** CLAUDE.md states "Tokens stored in memory only (never localStorage)" and the established pattern says `InMemoryWebStorage`, but `oidcConfig.ts` actually uses `window.sessionStorage`. SessionStorage persists across page reloads within the same tab. This is a security trade-off documented in Session 15 -- tokens survive page refresh but are cleared on tab close. For a strict zero-persistence requirement, revert to `InMemoryWebStorage`.

4. **No service worker for silent renew (P3).** `silent_redirect_uri` points to `/silent-renew.html` but this file does not appear to exist in the codebase. If token refresh fails, users will be silently logged out.

---

## 3. Data Architecture

### 3.1 Database-per-Service Enforcement: EXCELLENT

Strict data isolation is well-implemented:
- **ecom-db** (ecom namespace): books, cart_items, orders, order_items
- **inventory-db** (inventory namespace): inventory
- **analytics-db** (analytics namespace): fact tables + dimension tables + views
- **keycloak-db** (identity namespace): Keycloak internal tables

Cross-database access is prevented at three levels:
1. Separate PostgreSQL instances (not just schemas)
2. Kubernetes NetworkPolicies restrict DB access to owning service + Debezium
3. Istio AuthorizationPolicies enforce namespace-level L4 access

### 3.2 CDC Pipeline Design: GOOD

```
ecom-db -------> Debezium Server ecom --> Kafka --> Flink SQL --> analytics-db
                  (pgoutput, WAL)           |        (4 jobs)
                                            |
inventory-db --> Debezium Server inv -------+
                  (pgoutput, WAL)
```

**Strengths:**
- Debezium Server per source DB (no shared Kafka Connect cluster)
- `wal_level=logical` enabled via PostgreSQL args (not initdb)
- Plain JSON format in Flink (not debezium-json) -- avoids REPLICA IDENTITY FULL requirement
- JDBC upsert sink with `PRIMARY KEY ... NOT ENFORCED` for idempotent writes
- `?stringtype=unspecified` in JDBC URL handles varchar-to-UUID casts
- Exactly-once checkpointing (30s interval, hashmap state backend, PVC-backed)
- Partition discovery enabled with connection resilience settings
- 10 analytical views in analytics-db for Superset dashboards
- No FK constraints in analytics schema (correct: CDC delivery order not guaranteed)

**Concerns:**

1. **Debezium offset storage on emptyDir (P1).** `debezium-server-ecom.yaml` uses `emptyDir: {}` for the data volume where `offsets.dat` is stored. On pod restart, offsets are lost and Debezium re-snapshots. For low-volume POC data this is fine, but for production: (a) this causes full re-processing of all existing rows after every restart, which amplifies load; (b) use a PVC for offset persistence, or switch to `KafkaOffsetBackingStore`.

2. **Flink JDBC credentials via environment variable substitution (P2).** The `pipeline.sql` uses `${ANALYTICS_DB_USER}` / `${ANALYTICS_DB_PASSWORD}` which are injected at job submission time. These values are stored in the Flink job graph -- visible in the Flink Web Dashboard. This is a known limitation of Flink SQL's JDBC connector.

3. **`sink.buffer-flush.max-rows = 1` (P2).** Every row is flushed immediately to PostgreSQL. For higher throughput in production, batch flushes (e.g., 100 rows or 5s interval) would reduce JDBC round-trips significantly.

4. **No schema evolution strategy (P2).** There is no documented plan for handling column additions/removals in source tables. Adding a column to `orders` requires coordinated changes in: Liquibase migration, Flink source/sink table definitions, analytics DDL, and Superset datasets. A schema registry (Confluent Schema Registry or Apicurio) would formalize this.

### 3.3 Data Consistency Patterns

- **Checkout flow:** Synchronous inventory reserve (mTLS) before order commit. If reserve fails, order is not created. This is a simple two-phase pattern (not saga) -- adequate for the current scope.
- **Stock deduction:** Async via Kafka consumer (`order.created` event). The Kafka consumer uses `SELECT ... FOR UPDATE` + manual commit for at-least-once processing.
- **Potential issue (P2):** The reserve call and the subsequent async stock deduction are separate operations. On checkout, ecom-service reserves stock (increments `reserved`), then the Kafka consumer decrements `quantity`. If the Kafka consumer fails to process an event, `reserved` stays inflated but `quantity` is not decremented -- stock appears lower than actual. This is an acceptable trade-off with manual reconciliation.

---

## 4. Communication Patterns

### 4.1 Sync (REST) vs Async (Kafka)

**Well-chosen separation:**
- Synchronous for operations requiring immediate consistency (inventory reserve during checkout)
- Asynchronous for operations tolerating eventual consistency (stock deduction, CDC to analytics)
- Event-driven decoupling between ecom-service and inventory-service for post-checkout processing

### 4.2 Service Mesh (Istio Ambient)

**Configuration: GOOD**

- PeerAuthentication: STRICT mTLS on all application namespaces
- portLevelMtls: PERMISSIVE for NodePort-exposed services (Debezium, Superset, Flink, PgAdmin, Keycloak)
- RequestAuthentication: JWT validation against Keycloak JWKS in ecom and inventory namespaces
- AuthorizationPolicies: L4-only (namespace + SPIFFE principal), correctly avoiding L7 rules without waypoint proxy
- Named ServiceAccounts: `ecom-service` and `inventory-service`

**Notable design decisions:**
- L7 authorization is delegated to application code (Spring Security, FastAPI middleware) rather than Istio, because Ambient mode ztunnel cannot enforce L7 without a waypoint proxy. This is the correct approach.
- HTTPRoute restricts external access to specific paths/methods (e.g., no external POST /reserve)

### 4.3 Circuit Breaker / Retry / Timeout Patterns: MISSING

**This is the most significant gap in the architecture.**

| Pattern | ecom-service | inventory-service |
|---------|-------------|-------------------|
| Circuit breaker | Not configured | N/A |
| Retry policy | Kafka: 3 retries | Kafka: none |
| Connect timeout | Not set (infinite default) | Not applicable |
| Read timeout | Not set (infinite default) | Not applicable |
| Bulkhead | Not configured | Not configured |
| Rate limiting | Redis (Bucket4j) | None |

The `InventoryClient` has no timeouts. If inventory-service hangs, the checkout thread is blocked indefinitely. Spring Boot 4.0 + Resilience4j can add circuit breaker + timeout with minimal code change.

### 4.4 API Versioning Strategy: NOT IMPLEMENTED

No API versioning is in place. All endpoints are unversioned (`/books`, `/stock`, etc.). For a POC this is acceptable. For production, consider:
- URL path versioning (`/v1/books`) or
- Accept header versioning (`Accept: application/vnd.bookstore.v1+json`)

---

## 5. Production Readiness Assessment

### 5.1 Health Checks and Probes

| Service | Readiness | Liveness | Startup |
|---------|-----------|----------|---------|
| ecom-service | `/ecom/actuator/health/readiness` | `/ecom/actuator/health/liveness` | None |
| inventory-service | `/inven/health` | `/inven/health` | None |
| ui-service | `/nginx-health` | `/nginx-health` | None |
| ecom-db | `pg_isready` exec | `pg_isready` exec | None |
| inventory-db | `pg_isready` exec | `pg_isready` exec | None |
| kafka | TCP socket :9092 | None | None |
| redis | `redis-cli ping` exec | `redis-cli ping` exec | None |
| debezium-server-* | `/q/health/ready` | `/q/health/live` | None |
| flink-jobmanager | `/overview` | `/overview` | None |

**Gaps:**
- No startup probes on any service (P1). Services with slow initialization (ecom-service, Keycloak) rely on high `initialDelaySeconds` instead. Startup probes would allow faster detection of genuinely stuck pods.
- Kafka has no liveness probe (P1). Only readiness (TCP socket).
- `inventory-service` readiness and liveness use the same endpoint (`/health`) with the same check. The readiness probe should verify database connectivity; the liveness probe should only verify the process is alive.

### 5.2 Graceful Shutdown: NOT CONFIGURED

**No service defines graceful shutdown behavior:**
- No `preStop` hooks on any Deployment
- No `terminationGracePeriodSeconds` overrides (defaults to 30s)
- No connection draining configuration

For Spring Boot, add `server.shutdown=graceful` + `spring.lifecycle.timeout-per-shutdown-phase=20s` to `application.yml`. For FastAPI/uvicorn, add `--timeout-graceful-shutdown 20`. For Nginx, the default SIGTERM + SIGQUIT handling is adequate, but in-flight requests may be dropped without `preStop: sleep 5` (allowing Kubernetes to deregister the endpoint first).

### 5.3 Resource Limits: GOOD

All containers have resource requests and limits. Summary:

| Service | CPU Request | CPU Limit | Memory Request | Memory Limit |
|---------|------------|-----------|----------------|--------------|
| ecom-service | 250m | 500m | 512Mi | 1Gi |
| inventory-service | 100m | 300m | 128Mi | 256Mi |
| ui-service | 50m | 100m | 64Mi | 128Mi |
| ecom-db | 100m | 500m | 256Mi | 512Mi |
| kafka | 250m | 1000m | 768Mi | 2Gi |
| redis | 50m | 200m | 64Mi | 256Mi |
| flink-jm | 200m | 500m | 768Mi | 1Gi |
| flink-tm | 200m | 500m | 768Mi | 1Gi |
| debezium-* | 200m | 500m | 256Mi | 512Mi |

**Note:** Kafka has `KAFKA_HEAP_OPTS=-Xmx512m -Xms256m` to prevent OOMKill -- good practice with a 2Gi limit.

### 5.4 HPA Configuration: PRESENT BUT MINIMAL

Two HPAs defined:
- `ecom-service-hpa`: 1-5 replicas, CPU 70%, Memory 80%
- `inventory-service-hpa`: 1-3 replicas, CPU 70%

**Gaps:**
- No HPA for ui-service (P3)
- No scale-down stabilization window (`behavior` field) -- default is 5 minutes, which may cause flapping
- No custom metrics (RPS, p99 latency) -- only CPU/memory, which are lagging indicators

### 5.5 PDB Configuration: PRESENT

Two PDBs defined:
- `ecom-service-pdb`: minAvailable 1
- `inventory-service-pdb`: minAvailable 1

**Gap:** PDBs with `minAvailable: 1` combined with HPA `minReplicas: 1` means the PDB is effectively a no-op during normal operations (only 1 replica exists, so the PDB is already satisfied). PDBs are only useful when multiple replicas are running.

### 5.6 Logging Standards: BASIC

| Service | Format | Structured | Correlation ID |
|---------|--------|------------|----------------|
| ecom-service | Pattern (console) | No | No |
| inventory-service | basicConfig format | No | No |
| ui-service | Nginx access log | Default | No |

**Gap (P1):** No structured (JSON) logging in any service. No distributed correlation IDs (trace ID propagation). The OTel Collector is deployed but neither service is configured to send traces to it. Prometheus metrics endpoint is exposed by ecom-service but not by inventory-service.

### 5.7 Metrics and Alerting

**Metrics collection:**
- Prometheus deployed in `observability` namespace
- ecom-service exposes `/actuator/prometheus` (Micrometer)
- Kiali connected to Prometheus for service mesh telemetry
- OTel Collector deployed but not connected to services

**Alerting: NOT CONFIGURED**
- No Prometheus AlertManager
- No alerting rules
- No PagerDuty/Slack integration
- No Grafana dashboards (Grafana not deployed)

### 5.8 Security Assessment

**Strengths:**
- mTLS everywhere via Istio Ambient (STRICT mode)
- JWT validation in both backend services
- RBAC with Keycloak realm roles (customer, admin)
- Containers run as non-root with dropped capabilities
- readOnlyRootFilesystem on application services (with /tmp emptyDir)
- Secrets via Kubernetes Secrets (not hardcoded)
- NetworkPolicies with default-deny in ecom and inventory namespaces
- OIDC PKCE flow (no implicit grant)

**Concerns:**
- Secrets in YAML manifests are base64-encoded placeholders (`CHANGE_ME`) -- acceptable for POC, but production requires external secret management (Vault, Sealed Secrets, or ExternalSecrets)
- No network policies for infra, analytics, identity, or observability namespaces (P2)
- PostgreSQL containers do not set `readOnlyRootFilesystem: true` (P3) -- acceptable since PostgreSQL needs writable data directory
- `REDIS_PASSWORD` passed via command-line argument (visible in `ps aux`) (P3)

---

## 6. Recommendations

### P0 -- Critical (Fix before any production deployment)

| # | Issue | Effort | Detail |
|---|-------|--------|--------|
| 1 | Add connect/read timeouts to InventoryClient RestClient | 1h | `HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5))` + `JdkClientHttpRequestFactory.setReadTimeout(Duration.ofSeconds(10))` in `RestClientConfig.java` |
| 2 | Add circuit breaker to inventory reserve call | 2h | Add Resilience4j dependency + `@CircuitBreaker` annotation or `RestClient.builder()` with `Resilience4jCircuitBreakerFactory` |
| 3 | Fix JWKS cache TTL in inventory-service | 1h | Replace global `_jwks_cache` with `cachetools.TTLCache(maxsize=1, ttl=300)` and add cache-miss retry on `JWTError` |
| 4 | Add Kafka consumer supervision/restart in inventory-service | 2h | Wrap `run_consumer()` in a retry loop with exponential backoff. Use `asyncio.create_task()` with task exception handler that re-creates the consumer. |

### P1 -- High (Required for production-grade reliability)

| # | Issue | Effort | Detail |
|---|-------|--------|--------|
| 5 | Configure graceful shutdown for all services | 2h | ecom-service: `server.shutdown=graceful` in `application.yml`. inventory-service: `--timeout-graceful-shutdown 20` in uvicorn CMD. All Deployments: `preStop: exec: command: [sleep, 5]` for endpoint deregistration. |
| 6 | Add startup probes to slow-starting services | 1h | ecom-service, Keycloak, Kafka, Flink. Allows reducing `initialDelaySeconds` on liveness probes. |
| 7 | Implement structured JSON logging | 4h | ecom-service: Logback JSON encoder. inventory-service: `python-json-logger`. Add trace/request ID propagation. |
| 8 | Persist Debezium offsets | 2h | Replace `emptyDir` data volume with a PVC backed by `local-hostpath` StorageClass. Add PV to `persistent-volumes.yaml`. |
| 9 | Add network policies for infra/analytics/identity namespaces | 4h | Default-deny + explicit allow rules, matching the pattern in ecom/inventory namespaces. |
| 10 | Separate readiness/liveness probes in inventory-service | 1h | Readiness probe: check DB connectivity (`SELECT 1`). Liveness: keep simple `/health` check. |

### P2 -- Medium (Production best practices)

| # | Issue | Effort | Detail |
|---|-------|--------|--------|
| 11 | Add React ErrorBoundary | 1h | Wrap `AppWithAuth` in an ErrorBoundary that shows a fallback UI and reports errors. |
| 12 | Add Prometheus metrics to inventory-service | 2h | `prometheus-fastapi-instrumentator` or `starlette-prometheus`. Expose `/metrics` endpoint. |
| 13 | Deploy Grafana with pre-built dashboards | 4h | Standard Kubernetes dashboards + custom service dashboards (request rate, error rate, latency). |
| 14 | Deploy AlertManager with basic alerts | 4h | Pod restart alerts, error rate > 5%, latency p99 > 1s, Kafka consumer lag > 100, disk usage > 80%. |
| 15 | Add API versioning | 2h | At minimum, add `/v1/` prefix to all endpoints. Can be done at Gateway HTTPRoute level without service changes. |
| 16 | Document schema evolution strategy | 2h | Write a runbook covering how to add/modify columns across the CDC pipeline (Liquibase/Alembic -> Debezium -> Flink SQL -> analytics DDL -> Superset). |
| 17 | Increase Flink JDBC sink batch size | 30m | Change `sink.buffer-flush.max-rows` from `1` to `100` and `sink.buffer-flush.interval` from `1s` to `5s` in `pipeline.sql`. |
| 18 | Add audience validation to JWT checks | 1h | Both services: validate `aud` claim matches expected client ID or service identifier. |
| 19 | Enable JWT audience in Keycloak | 1h | Add audience mapper to `ui-client` and create service-specific client scopes if needed. |
| 20 | Add HPA scale-down stabilization | 30m | Add `behavior.scaleDown.stabilizationWindowSeconds: 300` to both HPAs. |

### P3 -- Low (Nice-to-have improvements)

| # | Issue | Effort | Detail |
|---|-------|--------|--------|
| 21 | Add cart item TTL / cleanup job | 2h | Scheduled job to delete cart items older than 7 days. |
| 22 | Add rate limiting to inventory-service | 2h | Middleware or dependency using Redis token bucket. |
| 23 | Add ui-service HPA | 30m | Min 1, max 3, CPU 70%. |
| 24 | Configure OTel Java agent for ecom-service | 2h | `JAVA_TOOL_OPTIONS=-javaagent:/otel/opentelemetry-javaagent.jar` with OTel Collector endpoint. |
| 25 | Configure OTel Python SDK for inventory-service | 2h | `opentelemetry-instrument` with OTLP exporter to OTel Collector. |
| 26 | Add silent-renew.html for OIDC token refresh | 1h | Create the HTML file referenced by `silent_redirect_uri` in `oidcConfig.ts`. |
| 27 | Reconcile CLAUDE.md token storage claim | 30m | CLAUDE.md says "InMemoryWebStorage" but code uses `sessionStorage`. Update documentation to match implementation. |
| 28 | Add Liveness probe to Kafka | 30m | Add `livenessProbe` matching the existing `readinessProbe` TCP socket check. |

---

## 7. Overall Assessment

### Strengths

The architecture demonstrates strong fundamentals for a microservices platform:

1. **Clean service boundaries** with strict database-per-service isolation, enforced at network, mesh, and application layers.
2. **Well-designed CDC pipeline** using Debezium Server + Kafka + Flink SQL, with idempotent upserts and exactly-once checkpointing.
3. **Defense-in-depth security** with mTLS (Istio), JWT validation (Keycloak), RBAC (roles), NetworkPolicies, AuthorizationPolicies, and hardened containers.
4. **Comprehensive E2E test suite** covering catalog, auth, cart, checkout, CDC, admin, mTLS enforcement, and infrastructure health (130 tests).
5. **Mature operational tooling** with idempotent bootstrap/recovery scripts, automated Keycloak realm import, and documented operational runbooks.
6. **Kubernetes-native patterns** throughout: init containers for migrations, PVCs for persistence, Secrets for credentials, Gateway API for ingress.

### Weaknesses

1. **Resilience patterns are absent** -- no circuit breakers, timeouts, or retries on inter-service REST calls.
2. **Observability is incomplete** -- Prometheus is deployed but only ecom-service exports metrics. No alerting. OTel Collector is deployed but not connected to services.
3. **Graceful shutdown is not configured** for any service.
4. **Logging is unstructured** across all services with no correlation ID propagation.

### Production Readiness Score

| Category | Score | Notes |
|----------|-------|-------|
| Security | 8/10 | Strong. Minor gaps in JWT audience validation and infra namespace NetworkPolicies. |
| Reliability | 5/10 | No circuit breakers, no graceful shutdown, single-point Kafka consumer. |
| Observability | 4/10 | Prometheus exists but metrics/tracing/alerting pipeline is incomplete. |
| Scalability | 6/10 | HPAs defined but minimal. Single Kafka partition. Single Flink TaskManager. |
| Data Integrity | 8/10 | Strong CDC pipeline. Idempotent upserts. Atomic inventory reservation. |
| Operability | 9/10 | Excellent scripts, documentation, and recovery procedures. |
| Test Coverage | 9/10 | 130 E2E tests covering all major flows including infrastructure health. |
| Code Quality | 8/10 | Clean architecture, consistent patterns, good API design. |

**Overall: 7.1/10** -- The platform has a solid architectural foundation with excellent operational tooling and test coverage. The primary gaps are in runtime resilience (circuit breakers, timeouts, graceful shutdown) and observability (structured logging, distributed tracing, alerting). Addressing the P0 and P1 items would bring this to production-ready status.
