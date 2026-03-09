# Security, Performance & Code Quality Review

**Date:** 2026-03-08
**Scope:** Full-stack review of the BookStore microservices platform
**Status:** Sessions 1-22 complete, 130/130 E2E tests passing

---

## A. SECURITY REVIEW

### A1. Authentication & Authorization

#### A1.1 OIDC/PKCE Implementation

| Finding | Severity | Details |
|---------|----------|---------|
| Token stored in sessionStorage, not memory | **P1 High** | `ui/src/auth/oidcConfig.ts` line 22: `userStore: new WebStorageStateStore({ store: window.sessionStorage })`. CLAUDE.md claims "tokens in memory only (never localStorage)" but sessionStorage is still DOM-accessible storage, vulnerable to XSS. A true in-memory store would use `new InMemoryWebStorage()` from `oidc-client-ts`. sessionStorage survives page reloads within a tab, which increases the exposure window. |
| `directAccessGrantsEnabled: true` on ui-client | **P2 Medium** | `infra/keycloak/realm-export.json` line 47: The public OIDC client (`ui-client`) has Resource Owner Password Credentials (ROPC) grant enabled. This allows password-based token acquisition, bypassing PKCE. Documented as needed for "curl-based token tests and API reference docs" but should be disabled in production. |
| No audience validation in inventory-service | **P2 Medium** | `inventory-service/app/middleware/auth.py` line 33: `options={"verify_aud": False}`. Tokens issued for any Keycloak client in the same realm are accepted. An attacker with a token from a different client could call inventory endpoints. Both services should validate the expected `aud` (audience) claim. |
| No audience validation in ecom-service | **P2 Medium** | `ecom-service/src/main/java/com/bookstore/ecom/config/SecurityConfig.java` line 41: Spring Security's `JwtValidators.createDefaultWithIssuer()` validates issuer but not audience. Any valid Keycloak token from the `bookstore` realm is accepted regardless of the intended audience. |
| Client-side role check for admin UI | **P3 Low** | `ui/src/auth/AuthContext.tsx` lines 100-108: `isAdmin` is computed by manually decoding the JWT on the client (no signature verification). This is acceptable since server-side authorization is enforced via `@PreAuthorize` and `require_role()`, but the `atob` decode has no error boundary for malformed tokens beyond a try/catch that returns false. Acceptable as defense-in-depth. |

**Recommended fixes:**
- **P1**: Change `oidcConfig.ts` to use `new InMemoryWebStorage()` instead of `window.sessionStorage`. This was the original design intent per CLAUDE.md. Effort: **S**
- **P2 (ROPC)**: Set `directAccessGrantsEnabled: false` in `realm-export.json` for production deployments. Create a separate confidential client for API testing. Effort: **S**
- **P2 (audience)**: Configure audience mappers in Keycloak for each service client, then enable `verify_aud` in both services. Effort: **M**

#### A1.2 JWT Validation

| Finding | Severity | Details |
|---------|----------|---------|
| JWKS cached forever with no refresh | **P1 High** | `inventory-service/app/middleware/auth.py` lines 13-20: `_jwks_cache` is a global dict set once and never refreshed. If Keycloak rotates signing keys (e.g., key compromise, scheduled rotation), the inventory-service will reject all new tokens until pod restart. |
| JWTError detail leak | **P3 Low** | `inventory-service/app/middleware/auth.py` line 41: `detail=f"Invalid or expired token: {exc}"` exposes internal JWT error details to callers. Production should return a generic "Invalid token" message. |

**Recommended fixes:**
- **P1**: Add TTL-based JWKS cache (e.g., 5-minute expiry) or use `httpx` with `Cache-Control` headers. Alternatively, catch verification failures and retry with a fresh JWKS fetch. Effort: **S**
- **P3**: Return generic error message; log the detailed error server-side. Effort: **S**

#### A1.3 Session Management

| Finding | Severity | Details |
|---------|----------|---------|
| No CSRF implementation despite spec requiring it | **P2 Medium** | CLAUDE.md specifies "CSRF tokens required for state-changing UI requests, stored in Redis" and `SecurityConfig.java` line 49 notes "CSRF handled at gateway/UI level." However, searching the codebase reveals no CSRF token generation, no X-CSRF-Token header attachment in `ui/src/api/client.ts`, and no CSRF middleware in any service. The Bucket4j dependency exists in `ecom-service/pom.xml` but no rate-limiting filter is implemented. CSRF is effectively absent. |
| Silent token renewal may fail silently | **P3 Low** | `ui/src/auth/oidcConfig.ts` configures `automaticSilentRenew: true` with `silent_redirect_uri` pointing to `/silent-renew.html`, but no `silent-renew.html` file was found in the project. If silent renewal fails, the user session degrades silently until the next navigation. |

**Recommended fixes:**
- **P2**: Implement CSRF protection. For a stateless API with JWT Bearer tokens, CSRF is inherently mitigated (Bearer tokens are not automatically attached by browsers like cookies). The current architecture is actually safe because tokens are attached via `Authorization` header, not cookies. Recommend documenting this explicitly and removing the misleading CLAUDE.md claim, OR implementing double-submit cookie CSRF if cookies are ever used for auth. Effort: **S** (documentation) or **M** (implementation)
- **P3**: Create `ui/public/silent-renew.html` for iframe-based silent renewal, or remove the config. Effort: **S**

---

### A2. Network Security

#### A2.1 Istio mTLS

| Finding | Severity | Details |
|---------|----------|---------|
| PERMISSIVE mode on 6 services | **P3 Low** | NodePort-exposed services (Superset, Flink, Debezium x2, PgAdmin, Keycloak) use `portLevelMtls: PERMISSIVE` in `infra/istio/security/peer-auth.yaml`. This is architecturally necessary for kind NodePort access from the host. In a production cloud deployment, these should be behind an ingress controller with TLS termination, eliminating the need for PERMISSIVE. |
| No mTLS on observability namespace | **P2 Medium** | No `PeerAuthentication` resource exists for the `observability` namespace in `infra/istio/security/peer-auth.yaml`. Prometheus in this namespace communicates without enforced mTLS. |
| L4-only AuthorizationPolicies | **P3 Low** | All policies in `infra/istio/security/authz-policies/` are namespace-scoped (L4) because Istio Ambient mode without waypoint proxy cannot enforce L7. This is a correct architectural decision well-documented in the codebase. For production, consider deploying waypoint proxies for fine-grained L7 authorization. |

**Recommended fixes:**
- **P2**: Add `PeerAuthentication` with `mode: STRICT` for the `observability` namespace. Effort: **S**
- **P3**: For production, replace NodePort exposure with proper ingress + TLS termination; deploy Istio waypoint proxies for L7 authorization. Effort: **L**

#### A2.2 NetworkPolicy Coverage

| Finding | Severity | Details |
|---------|----------|---------|
| No NetworkPolicies for infra, identity, analytics, observability | **P2 Medium** | Only `ecom` and `inventory` namespaces have NetworkPolicies (in `infra/kubernetes/network-policies/`). The `infra` namespace (Kafka, Redis, Debezium, PgAdmin), `identity` (Keycloak), `analytics` (Flink, Superset, analytics-db), and `observability` (Prometheus) have no network isolation. Any pod in those namespaces can reach any other pod. |
| PgAdmin unrestricted access | **P2 Medium** | PgAdmin at port 31111 has no NetworkPolicy and only PERMISSIVE PeerAuthentication. It can connect to any database. In production, PgAdmin should be behind authentication and network-restricted. |
| Egress to internet not restricted | **P3 Low** | No egress policies block outbound internet access from service pods. In production, egress should be restricted to known destinations. |

**Recommended fixes:**
- **P2**: Add default-deny NetworkPolicies to all namespaces with explicit allow rules. Priority: `infra` (Kafka, Redis) and `analytics`. Effort: **M**
- **P2**: Restrict PgAdmin access via NetworkPolicy (admin namespace only) or remove from production. Effort: **S**

#### A2.3 Gateway & CORS

| Finding | Severity | Details |
|---------|----------|---------|
| No rate limiting implemented | **P1 High** | Bucket4j dependency is in `ecom-service/pom.xml` (lines 77-85) but no rate-limiting filter, configuration, or middleware exists anywhere in the codebase. All endpoints are unthrottled. This exposes the platform to brute force, credential stuffing, and DoS attacks. |
| Swagger UI publicly exposed | **P2 Medium** | `ecom-service/src/main/java/com/bookstore/ecom/config/SecurityConfig.java` lines 55-56: `/swagger-ui/**` and `/v3/api-docs/**` are `permitAll()`. In production, API documentation should be access-controlled or disabled entirely. |
| CORS allows all methods on inventory-service | **P3 Low** | `inventory-service/app/main.py` line 127: `allow_methods=["GET", "PUT", "POST", "DELETE"]`. While CORS is a browser-enforced policy and backend authorization exists, the broad method allowance could be tightened to only methods actually needed by the UI. |
| No TLS termination (HTTP only) | **P2 Medium** | All external traffic is HTTP. The Gateway listener in `infra/kgateway/gateway.yaml` is `protocol: HTTP`. For production, TLS termination at the gateway is essential. In the current kind/dev setup this is acceptable. |

**Recommended fixes:**
- **P1**: Implement Bucket4j rate limiting filter (dependency already present). Key endpoints: `/checkout` (low limit), `/cart` (medium), `/books` (high). Use Redis as token bucket store (already deployed). Effort: **M**
- **P2**: Disable Swagger UI in production profile (`springdoc.swagger-ui.enabled: false` in `application.yml`). Effort: **S**
- **P2**: Add TLS certificate and HTTPS listener to the Gateway for production. Effort: **M**

---

### A3. Application Security (OWASP Top 10)

#### A3.1 Injection (A03:2021)

| Finding | Severity | Details |
|---------|----------|---------|
| SQL injection protected via parameterized queries | **OK** | Spring Data JPA uses parameterized queries. The JPQL search query in `ecom-service/src/main/java/com/bookstore/ecom/repository/BookRepository.java` uses `:q` parameter binding. SQLAlchemy in inventory-service uses `where()` clauses with bound parameters. No raw SQL concatenation found. |
| Book search uses LIKE with user input | **P3 Low** | `BookRepository.search()` line 16: `LIKE LOWER(CONCAT('%', :q, '%'))` -- while parameterized (safe from injection), a `%` character in the query could cause unexpected matching. Consider escaping `%` and `_` in the search parameter. |

#### A3.2 Broken Access Control (A01:2021)

| Finding | Severity | Details |
|---------|----------|---------|
| CartItem ownership check uses string comparison | **OK** | `ecom-service/src/main/java/com/bookstore/ecom/service/CartService.java` lines 50-52: `item.getUserId().equals(userId)` -- correctly verifies ownership before delete/update operations. Returns same 404 for both "not found" and "not yours" (prevents enumeration). |
| Book deletion has dangling FK warning only | **P2 Medium** | `ecom-service/src/main/java/com/bookstore/ecom/controller/AdminBookController.java` `deleteBook()` will fail with a database constraint violation if orders reference the book, but this is caught as a generic 500 error rather than a meaningful 409 Conflict. |
| Inventory reserve endpoint relies on L4 auth only | **P3 Low** | `inventory-service/app/api/stock.py` `reserve_stock()` has no JWT requirement -- it relies on Istio L4 namespace authorization and HTTPRoute exclusion. If a pod in the `ecom` namespace is compromised, it could call reserve without authentication. Consider adding JWT verification as defense-in-depth. |

#### A3.3 XSS Prevention (A07:2021)

| Finding | Severity | Details |
|---------|----------|---------|
| CSP configured in nginx | **OK** | `ui/nginx/default.conf` has `Content-Security-Policy` with `script-src 'self'` (no `unsafe-eval`). |
| `style-src 'unsafe-inline'` in CSP | **P3 Low** | `ui/nginx/default.conf` line 14: Allows inline styles which could be exploited in certain XSS scenarios. The React components use inline `style={{}}` props which require this. Consider using CSS modules or styled-components to eliminate `unsafe-inline`. |
| React's built-in escaping | **OK** | React automatically escapes rendered content. No `dangerouslySetInnerHTML` usage found. |

#### A3.4 Other OWASP Concerns

| Finding | Severity | Details |
|---------|----------|---------|
| Security headers present | **OK** | `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` all set in `ui/nginx/default.conf`. |
| No request size limits | **P2 Medium** | No `client_max_body_size` in `ui/nginx/default.conf`. No `spring.servlet.multipart.max-file-size` in `ecom-service/src/main/resources/application.yml`. The `BookRequest` DTO accepts unbounded `description` and `coverUrl` strings. |
| Kafka producer fire-and-forget pattern | **P2 Medium** | `ecom-service/src/main/java/com/bookstore/ecom/kafka/OrderEventPublisher.java` uses async `whenComplete` callback. If Kafka publish fails after the order is committed to DB, the order exists without a corresponding Kafka event. The checkout transaction commits before publish confirmation. Consider transactional outbox pattern. |
| Order total computed server-side | **OK** | `ecom-service/src/main/java/com/bookstore/ecom/service/OrderService.java` line 54: Price is read from the DB (`cartItem.getBook().getPrice()`), not from client input. Prevents price manipulation. |

#### A3.5 Container Security

| Finding | Severity | Details |
|---------|----------|---------|
| Non-root users in all Dockerfiles | **OK** | All three service Dockerfiles (`ecom-service/Dockerfile`, `inventory-service/Dockerfile`, `ui/Dockerfile`) create and switch to non-root users. |
| PostgreSQL runs as root initially | **P3 Low** | `infra/postgres/ecom-db.yaml`: PostgreSQL container starts as root before dropping to UID 999. This is the standard postgres image behavior. The `fsGroup: 999` is set correctly. Consider using Bitnami PostgreSQL image which runs as non-root from the start. |
| `readOnlyRootFilesystem` on DB containers | **P3 Low** | DB deployment manifests in `infra/postgres/` do not set `readOnlyRootFilesystem: true`. PostgreSQL needs writable filesystem for WAL, but the data volume could be more precisely scoped. |

#### A3.6 Secret Management

| Finding | Severity | Details |
|---------|----------|---------|
| Placeholder secrets committed to repo | **P1 High** | `infra/postgres/ecom-db.yaml` line 21: `POSTGRES_PASSWORD: Q0hBTkdFX01F` (base64 of `CHANGE_ME`). All database secrets use `CHANGE_ME` passwords committed to Git. While documented as placeholders, this is a supply chain risk -- the cluster can be deployed with default passwords. |
| Keycloak user passwords in realm-export.json | **P1 High** | `infra/keycloak/realm-export.json` lines 117, 133: `"value": "CHANGE_ME"` for both `user1` and `admin1`. These plaintext passwords are in version control. |
| Service client secrets as placeholders | **P2 Medium** | `infra/keycloak/realm-export.json` lines 80, 97: `REPLACE_ECOM_SERVICE_SECRET` and `REPLACE_INVENTORY_SERVICE_SECRET`. While marked as replaceable, the mechanism for injecting real secrets is not automated. |

**Recommended fixes:**
- **P1**: Use external secret management (Sealed Secrets, External Secrets Operator, or Vault). Generate unique secrets at deploy time. Add `CHANGE_ME` detection to CI pipeline. Effort: **M**

---

### A4. Supply Chain Security

| Finding | Severity | Details |
|---------|----------|---------|
| No dependency scanning | **P2 Medium** | No Dependabot, Snyk, or Trivy configuration. `python-jose` in `inventory-service/pyproject.toml` is a known concern (unmaintained; `PyJWT` or `joserfc` are preferred alternatives). |
| No container image scanning | **P2 Medium** | No Trivy, Grype, or Snyk container scan in the build pipeline. Base images (`eclipse-temurin:21-jre-alpine`, `python:3.12-slim`, `nginx:1.27-alpine`) are not pinned to digest. |
| No SBOM generation | **P3 Low** | No SBOM (Software Bill of Materials) generation. For compliance, consider `syft` or `cyclonedx`. |
| `npm install` without lockfile enforcement | **P3 Low** | `ui/Dockerfile` line 6 uses `npm install` not `npm ci`. `npm install` may modify `package-lock.json`, introducing non-reproducible builds. |

**Recommended fixes:**
- **P2**: Add Trivy scanning to CI for both dependencies and container images. Replace `python-jose` with `PyJWT`. Pin base images to SHA256 digests. Effort: **M**
- **P3**: Change `npm install` to `npm ci` in `ui/Dockerfile`. Effort: **S**

---

### A5. Compliance Readiness

| Finding | Severity | Details |
|---------|----------|---------|
| No audit logging | **P2 Medium** | No structured audit trail for admin actions (book CRUD, stock changes, order access). Only application-level `log.info` statements exist. No correlation IDs across services. |
| No data encryption at rest | **P2 Medium** | PostgreSQL data directories are unencrypted on-disk (`hostPath` volumes in `infra/storage/persistent-volumes.yaml`). For PCI-DSS or SOC2 compliance, encryption at rest is required. |
| PII in logs | **P3 Low** | `ecom-service/src/main/java/com/bookstore/ecom/service/OrderService.java` line 79: `log.info("Order created: orderId={} userId={} total={}", ...)` logs the userId (Keycloak subject UUID). While UUIDs are pseudonymized, correlation with Keycloak makes this PII under GDPR. |
| No data retention policy | **P3 Low** | No mechanism to purge old orders, cart items, or analytics data. GDPR right-to-erasure requires the ability to delete user data. |

---

## B. PERFORMANCE REVIEW

### B1. Application Performance

#### B1.1 Database Query Patterns

| Finding | Severity | Details |
|---------|----------|---------|
| N+1 query risk in CartItem -> Book | **P2 Medium** | `ecom-service/src/main/java/com/bookstore/ecom/model/CartItem.java` line 27: `@ManyToOne(fetch = FetchType.LAZY)` on `book`. `CartService.getCart()` returns `List<CartItem>` which is serialized to JSON. Jackson serialization triggers lazy loading of each `Book` entity individually (N+1). Fix: use `@EntityGraph` or `JOIN FETCH` in `CartItemRepository.findByUserId()`. |
| N+1 in Order -> OrderItems -> Book | **P2 Medium** | `ecom-service/src/main/java/com/bookstore/ecom/model/OrderItem.java` line 26: `@ManyToOne(fetch = FetchType.LAZY)` on `book`. When `Order` is serialized in `OrderResponse.from(order)`, each book in each order item is loaded individually. |
| Book search uses LIKE without full-text index | **P3 Low** | `ecom-service/src/main/java/com/bookstore/ecom/repository/BookRepository.java` line 16: `LIKE '%query%'` which cannot use B-tree indexes. With 10 books this is irrelevant, but at scale consider PostgreSQL `pg_trgm` GIN index or full-text search (`tsvector`). |
| Inventory bulk query efficient | **OK** | `inventory-service/app/api/stock.py` line 63: uses `Inventory.book_id.in_(ids)` -- single query with IN clause, limited to 50 IDs. |

**Recommended fixes:**
- **P2**: Add `@EntityGraph(attributePaths = {"book"})` to `CartItemRepository.findByUserId()`. Same for order item queries. Effort: **S**
- **P3**: Add `pg_trgm` index for book search at scale. Effort: **S**

#### B1.2 Connection Pooling

| Finding | Severity | Details |
|---------|----------|---------|
| HikariCP configured with sensible defaults | **OK** | `ecom-service/src/main/resources/application.yml` lines 16-18: `maximum-pool-size: 10`, `minimum-idle: 2`, `connection-timeout: 30000`. Appropriate for a single-replica service. |
| asyncpg pool small for Kafka consumer | **P3 Low** | `inventory-service/app/database.py` line 7: `pool_size=5, max_overflow=10`. The Kafka consumer processes messages sequentially (`enable_auto_commit=False`, single consumer), so pool utilization is low. However, if concurrent admin API + consumer activity occurs, 5 base connections may be tight. |
| No connection pool metrics | **P3 Low** | Neither HikariCP metrics (via Micrometer) nor SQLAlchemy pool metrics are exposed to Prometheus. Connection pool exhaustion would be invisible. |

#### B1.3 Caching Strategy

| Finding | Severity | Details |
|---------|----------|---------|
| Redis deployed but unused by application | **P1 High** | Redis is deployed in the `infra` namespace. `ecom-service/src/main/resources/application.yml` lines 49-53 configure `spring.data.redis` with host/port/password. However, no Redis client usage, no `@Cacheable`, no `RedisTemplate` bean, and no caching logic exists in the codebase. The Bucket4j rate-limiter (which would use Redis) is also unimplemented. Redis is consuming cluster resources with zero utilization. |
| No HTTP caching headers for book catalog | **P2 Medium** | `ecom-service/src/main/java/com/bookstore/ecom/controller/BookController.java` `listBooks()` returns books without `Cache-Control` or `ETag` headers. The catalog is read-heavy and changes infrequently -- a 60-second cache would reduce DB load significantly. |
| JWKS cached forever in inventory-service | **P2 Medium** | (Also a security issue -- see A1.2.) The JWKS is fetched once and cached permanently. No TTL, no refresh, no background update. |

**Recommended fixes:**
- **P1**: Either implement Redis caching (`@Cacheable` on `BookService.findAll()`, `findById()`) and rate limiting, or remove Redis from the deployment to free resources. Effort: **M**
- **P2**: Add `Cache-Control: public, max-age=60` to book list/search responses. Effort: **S**

#### B1.4 Kafka Producer/Consumer Tuning

| Finding | Severity | Details |
|---------|----------|---------|
| Kafka producer acks=all, retries=3 | **OK** | `ecom-service/src/main/java/com/bookstore/ecom/config/KafkaConfig.java` lines 27-28: Good durability settings. `acks=all` ensures all ISR replicas acknowledge. |
| Consumer single-threaded, no parallelism | **P3 Low** | `inventory-service/app/kafka/consumer.py` `run_consumer()` runs as a single `asyncio.Task`. For the current 10-book catalog this is fine, but at scale, consumer group parallelism with multiple partitions would be needed. |
| No dead-letter topic for failed messages | **P2 Medium** | `inventory-service/app/kafka/consumer.py` line 85: `except Exception as exc: ... raise` -- any unhandled exception kills the consumer task. Messages that cause processing errors will block the consumer (it won't commit the offset). No DLQ mechanism to park poison messages. |
| Kafka event published outside transaction | **P2 Medium** | `ecom-service/src/main/java/com/bookstore/ecom/service/OrderService.java`: The DB transaction commits via `orderRepository.save()` (line 61), then `eventPublisher.publishOrderCreated()` is called (line 77). If the Kafka publish fails, the order exists in DB but no event is produced. The CDC pipeline (Debezium) provides eventual consistency for the orders table, but the `order.created` topic (consumed by inventory for stock deduction) would miss the event. |

**Recommended fixes:**
- **P2 (DLQ)**: Implement dead-letter topic handling: after N retries, publish failed messages to `order.created.dlq` and continue consuming. Effort: **M**
- **P2 (outbox)**: Consider transactional outbox pattern: write events to an outbox table within the same DB transaction, then a separate process publishes to Kafka. Debezium already captures the orders table, so this may be redundant if the inventory consumer can be redesigned to use CDC events instead. Effort: **L**

#### B1.5 Flink Pipeline

| Finding | Severity | Details |
|---------|----------|---------|
| Checkpointing at 30s intervals | **OK** | Exactly-once semantics with hashmap state backend. Appropriate for the data volume. |
| JDBC sink batch settings default | **P3 Low** | `analytics/flink/sql/pipeline.sql`: Flink JDBC sink uses default batch size/interval. For higher throughput, configure `sink.buffer-flush.max-rows` and `sink.buffer-flush.interval`. |

---

### B2. Infrastructure Performance

#### B2.1 Resource Requests/Limits

| Finding | Severity | Details |
|---------|----------|---------|
| PostgreSQL limits appropriate | **OK** | `infra/postgres/ecom-db.yaml` lines 81-86: `cpu: 100m/500m`, `memory: 256Mi/512Mi` -- reasonable for dev. |
| Resource specs needed on app Deployments | **P2 Medium** | The HPA in `infra/kubernetes/hpa/hpa.yaml` targets CPU 70% and memory 80%. Ensure resource requests are set on ecom-service and inventory-service Deployments to make HPA scaling meaningful. Without requests, HPA cannot calculate utilization percentage. |

#### B2.2 HPA Configuration

| Finding | Severity | Details |
|---------|----------|---------|
| HPA uses CPU and memory metrics | **OK** | `infra/kubernetes/hpa/hpa.yaml`: ecom-service 1-5 replicas at 70% CPU. inventory-service 1-3 replicas at 70% CPU. |
| No HPA behavior configuration | **P3 Low** | No `behavior` block for scale-down stabilization. Default Kubernetes stabilization window (300s) applies. For a bursty e-commerce workload, consider faster scale-up and slower scale-down. |
| Inventory HPA with single Kafka consumer | **P3 Low** | Scaling inventory-service replicas will create multiple Kafka consumer instances in the same group. Since `order.created` topic likely has only 1 partition, only one consumer will be active. HPA scaling is ineffective for the Kafka consumer workload. |

#### B2.3 JVM Tuning

| Finding | Severity | Details |
|---------|----------|---------|
| No JVM flags configured | **P2 Medium** | `ecom-service/Dockerfile` line 39: `ENTRYPOINT` has no JVM memory flags (`-Xmx`, `-Xms`). Container memory limit is set by Kubernetes, but the JVM may not respect it without `-XX:MaxRAMPercentage`. Default heap could be too small or too large relative to the container limit. |
| No GC configuration | **P3 Low** | JDK 21 defaults to G1GC which is good for most workloads. For low-latency requirements, consider ZGC. |

**Recommended fix:**
- **P2**: Add `JAVA_TOOL_OPTIONS: "-XX:MaxRAMPercentage=75.0 -XX:+UseG1GC"` to the ecom-service Deployment env vars. Effort: **S**

#### B2.4 Python Async Patterns

| Finding | Severity | Details |
|---------|----------|---------|
| Single uvicorn worker | **P2 Medium** | `inventory-service/Dockerfile` line 29: `--workers 1`. A single worker means a single event loop. CPU-bound operations (unlikely with this workload) would block all async I/O. For production, use multiple workers with `gunicorn` + `uvicorn.workers.UvicornWorker`. |
| Kafka consumer shares event loop with API | **P3 Low** | `inventory-service/app/main.py` line 25: The Kafka consumer runs as an `asyncio.Task` on the same event loop as FastAPI. A slow Kafka message processing could theoretically delay API responses. In practice, the current async DB operations yield control properly. |

---

### B3. Frontend Performance

| Finding | Severity | Details |
|---------|----------|---------|
| No code splitting / lazy loading | **P2 Medium** | `ui/src/App.tsx` eagerly imports all 11 page components (lines 7-17). Admin pages (5 components) are loaded for all users, including guests. Use `React.lazy()` + `Suspense` for route-based code splitting, especially for admin routes. |
| No asset caching headers in nginx | **P2 Medium** | `ui/nginx/default.conf` has no `location` block for static assets (`/assets/`). Vite generates hashed filenames, so aggressive caching (`Cache-Control: public, max-age=31536000, immutable`) is safe and would eliminate redundant downloads. |
| Cart page makes N+1 stock API calls | **P2 Medium** | `ui/src/pages/CartPage.tsx` lines 37, 64, 98: `Promise.all(items.map(i => booksApi.getStock(i.bookId)))` -- makes one HTTP request per cart item instead of using the bulk endpoint. `CatalogPage.tsx` correctly uses `getBulkStock()`, but `CartPage` does not. |
| No gzip for JavaScript/CSS | **P3 Low** | `ui/nginx/default.conf` line 37: `gzip_min_length 1000` might miss smaller JS chunks. Consider `gzip_min_length 256` and adding `text/javascript` and `application/wasm` to `gzip_types`. |

**Recommended fixes:**
- **P2**: Add lazy loading for admin routes with `React.lazy()`. Effort: **S**
- **P2**: Add nginx `location /assets/` block with immutable cache headers. Effort: **S**
- **P2**: Change CartPage to use `booksApi.getBulkStock()` instead of per-item calls. Effort: **S**

---

### B4. Load Testing Plan

**Recommended tools:** k6 (Grafana) for HTTP load testing, or Locust for Python-based scripting.

**Key scenarios to test:**

1. **Catalog browsing** (GET /ecom/books, GET /ecom/books/search) -- target: 500 RPS, p99 < 200ms
2. **Concurrent cart operations** (POST /ecom/cart, GET /ecom/cart) -- target: 100 RPS, p99 < 500ms
3. **Checkout under contention** (POST /ecom/checkout with same books) -- test inventory reservation locking under concurrent checkouts
4. **CDC pipeline throughput** -- bulk insert orders, measure end-to-end latency to analytics-db
5. **Authentication flow** -- OIDC token acquisition under load (Keycloak capacity)

**SLO definitions:**

| Metric | Target |
|--------|--------|
| Catalog API p99 latency | < 200ms |
| Checkout API p99 latency | < 2s |
| CDC event propagation latency (order to analytics-db) | < 5s |
| Error rate | < 0.1% |
| Availability | 99.9% |

---

## C. CODE QUALITY REVIEW

### C1. Code Organization

| Finding | Severity | Details |
|---------|----------|---------|
| Clean layered architecture in ecom-service | **OK** | Controller -> Service -> Repository pattern consistently applied. DTOs separate from entities. Exception handling centralized in `GlobalExceptionHandler`. |
| Clean module structure in inventory-service | **OK** | `api/`, `models/`, `schemas/`, `kafka/`, `middleware/` -- clear separation. Pydantic schemas separate from SQLAlchemy models. |
| UI component organization | **OK** | Pages, components, auth, API clients well separated. Hooks directory for reusable logic. |
| Missing service layer in inventory admin | **P3 Low** | `inventory-service/app/api/admin.py` contains business logic (DB queries, validation) directly in route handlers. Extract to a service/repository layer for consistency and testability. |

### C2. Testing Coverage

| Finding | Severity | Details |
|---------|----------|---------|
| Zero unit tests | **P1 High** | No unit test files found in `ecom-service/src/test/` or `inventory-service/tests/`. The `src/test/` directory does not exist in either service. All testing relies on 130 E2E (Playwright) tests. Unit tests are essential for: business logic validation, edge case coverage, fast feedback loops, and regression detection without cluster dependency. |
| E2E test suite comprehensive | **OK** | 130 tests across 15 spec files in `e2e/` covering catalog, search, auth, cart, checkout, CDC, Superset, Debezium/Flink, admin, stock management, mTLS, Istio gateway, Kiali, guest cart, and UI fixes. |
| No integration tests | **P2 Medium** | No service-level integration tests (e.g., Spring Boot `@SpringBootTest` with TestContainers, or pytest with a test database). Integration tests would catch issues like Liquibase migration errors, JPA mapping mismatches, and Kafka serialization problems without needing the full cluster. |
| E2E test data management | **P3 Low** | Tests rely on seeded data (10 books with fixed UUIDs). No test data cleanup between runs. Checkout tests create orders that persist. Over many runs, accumulated test data could affect test reliability. |

**Recommended fixes:**
- **P1**: Add unit tests. Priority targets: `CartService` (add, remove, quantity logic, ownership checks), `OrderService` (checkout flow, empty cart, inventory failure handling), `BookService` (CRUD, validation), inventory-service `_deduct_stock()` generator, `reserve_stock()` concurrency. Effort: **L** (initial setup + writing tests)
- **P2**: Add integration tests with TestContainers (Java) and pytest-asyncio + testcontainers-python. Effort: **M**

### C3. Code Smells

| Finding | Severity | Details |
|---------|----------|---------|
| Duplicated stock fetch logic in CartPage | **P2 Medium** | `ui/src/pages/CartPage.tsx` has three nearly identical `Promise.all(...booksApi.getStock(...))` blocks (lines 37-44, 63-71, 97-104). Extract to a `fetchStockMap(bookIds)` helper function. |
| Duplicated cart table rendering | **P2 Medium** | `ui/src/pages/CartPage.tsx` has two nearly identical `<table>` blocks -- one for guest cart (lines 143-183) and one for authenticated cart (lines 216-255). Extract to a shared `CartTable` component. |
| Status string literal for orders | **P3 Low** | `ecom-service/src/main/java/com/bookstore/ecom/model/Order.java` line 33: `String status = "PENDING"` and `OrderService.java` line 47: `"CONFIRMED"`. Should be an enum (`OrderStatus`) for type safety and preventing typos. |
| JPA entities exposed directly as JSON | **P3 Low** | `Book`, `CartItem`, `Order`, `OrderItem` in `ecom-service/src/main/java/com/bookstore/ecom/model/` are JPA entities returned directly as JSON responses. This couples the persistence model to the API contract. Changes to the DB schema directly affect API consumers. Consider DTO projection (partially done with `OrderResponse`; extend to `BookResponse`, `CartItemResponse`). |
| Exception types catch-all in InventoryClient | **P3 Low** | `ecom-service/src/main/java/com/bookstore/ecom/client/InventoryClient.java` line 53: catches generic `Exception`. The generic catch swallows connection timeouts, making them indistinguishable from other errors. Consider catching `ResourceAccessException` separately for better error reporting. |

**Recommended fixes:**
- **P2**: Extract `CartTable` component and `fetchStockMap` helper. Effort: **S**
- **P3**: Create `OrderStatus` enum. Effort: **S**
- **P3**: Introduce response DTOs that wrap/project JPA entities. Effort: **M**

### C4. Hardcoded Values

| Finding | Severity | Details |
|---------|----------|---------|
| Inventory service URL from env var | **OK** | `ecom-service/src/main/java/com/bookstore/ecom/config/RestClientConfig.java` line 15: Correctly uses `${INVENTORY_SERVICE_URL}` env var. |
| Stock badge thresholds hardcoded in UI | **P3 Low** | `StockBadge.tsx` and `CartPage.tsx` have hardcoded threshold `3` for "low stock". Consider making this configurable or sourcing from API. |
| Kafka topic name partially hardcoded | **P3 Low** | `ecom-service/src/main/java/com/bookstore/ecom/kafka/OrderEventPublisher.java` line 17: uses `${kafka.topics.order-created:order.created}` (configurable with default). But `inventory-service/app/kafka/consumer.py` line 59 hardcodes `"order.created"`. |
| Bulk stock limit hardcoded to 50 | **P3 Low** | `inventory-service/app/api/stock.py` line 54: `[:50]` truncation is hardcoded. Should be a configuration parameter. |

### C5. Developer Experience

| Finding | Severity | Details |
|---------|----------|---------|
| No CI/CD pipeline | **P2 Medium** | No `.github/workflows/`, `Jenkinsfile`, or `.gitlab-ci.yml`. The project relies entirely on manual `scripts/up.sh` for deployment. For production, CI should run unit tests, build images, scan for vulnerabilities, and deploy. |
| Excellent operational scripts | **OK** | Comprehensive set of idempotent scripts (`scripts/up.sh`, `scripts/down.sh`, `scripts/restart-after-docker.sh`, `scripts/smoke-test.sh`, `scripts/verify-cdc.sh`). Well-documented with inline comments. |
| CLAUDE.md is comprehensive | **OK** | Exceptionally thorough project documentation covering architecture, patterns, gotchas, port maps, and current state. |
| No local dev mode without cluster | **P2 Medium** | Developers must run the full kind cluster to work on any service. No `docker-compose.yml` for local development with just the databases + Kafka. No Spring Boot `dev` profile with embedded H2 or TestContainers. |
| OpenAPI documentation excellent | **OK** | Both ecom-service and inventory-service have thorough OpenAPI annotations with descriptions, examples, and error responses in controllers and schemas. |

**Recommended fixes:**
- **P2**: Add GitHub Actions CI pipeline: lint, unit test, build, image scan. Effort: **M**
- **P2**: Add `docker-compose.dev.yml` for lightweight local development (PostgreSQL + Kafka + Redis only). Effort: **M**

---

## Summary by Priority

### P0 Critical
(None found -- the platform has no exploitable critical vulnerabilities in its current deployment context.)

### P1 High (6 findings)
1. **Token stored in sessionStorage** instead of InMemoryWebStorage -- violates stated security model (`ui/src/auth/oidcConfig.ts` line 22)
2. **JWKS cache never refreshes** in inventory-service -- key rotation breaks auth (`inventory-service/app/middleware/auth.py` lines 13-20)
3. **No rate limiting** despite Bucket4j dependency -- DoS/brute-force exposure (`ecom-service/pom.xml` lines 77-85 vs. zero implementation)
4. **Placeholder secrets in Git** -- `CHANGE_ME` passwords in manifests and realm export (`infra/postgres/ecom-db.yaml`, `infra/keycloak/realm-export.json`)
5. **Redis deployed but completely unused** -- wasted resources, promised features undelivered (`ecom-service/src/main/resources/application.yml` lines 49-53)
6. **Zero unit tests** -- all quality assurance relies on E2E tests requiring full cluster (no `src/test/` or `tests/` directories)

### P2 Medium (22 findings)
1. No audience validation in JWT -- inventory-service (`auth.py` line 33)
2. No audience validation in JWT -- ecom-service (`SecurityConfig.java` line 41)
3. CSRF documented but unimplemented (CLAUDE.md vs. `api/client.ts`)
4. `directAccessGrantsEnabled: true` on public ui-client (`realm-export.json` line 47)
5. No mTLS on observability namespace (`peer-auth.yaml`)
6. Missing NetworkPolicies for infra, identity, analytics, observability namespaces
7. PgAdmin unrestricted access (port 31111, no NetworkPolicy)
8. Swagger UI publicly exposed (`SecurityConfig.java` lines 55-56)
9. No TLS termination (`gateway.yaml` HTTP only)
10. No request size limits (nginx, Spring)
11. Kafka event published outside DB transaction (`OrderService.java` lines 61, 77)
12. N+1 queries in CartItem -> Book (`CartItem.java` line 27, `CartService.java`)
13. N+1 queries in Order -> OrderItems -> Book (`OrderItem.java` line 26)
14. No HTTP caching headers for catalog (`BookController.java`)
15. No dead-letter topic for Kafka consumer (`consumer.py` line 85)
16. No JVM memory flags (`ecom-service/Dockerfile` line 39)
17. Single uvicorn worker (`inventory-service/Dockerfile` line 29)
18. No code splitting in UI (`App.tsx` lines 7-17)
19. No asset caching headers in nginx (`default.conf`)
20. CartPage N+1 stock API calls (`CartPage.tsx` lines 37, 64, 98)
21. No CI/CD pipeline
22. No integration tests
23. No local dev mode without cluster
24. No audit logging
25. Book delete returns 500 instead of 409 (`AdminBookController.java`)
26. Duplicated UI code in CartPage (`CartPage.tsx`)
27. Service client secret placeholders (`realm-export.json` lines 80, 97)
28. No data encryption at rest
29. HPA resource requests verification needed (`hpa.yaml`)
30. Dependency scanning / `python-jose` concern (`pyproject.toml`)
31. Container image scanning needed

### P3 Low (20+ findings)
- Various hardcoded values, minor code smells, CSP `unsafe-inline`, LIKE wildcard escaping, DB container security, data retention, PII in logs, SBOM generation, HPA behavior tuning, connection pool metrics, and other operational improvements detailed in sections above.

---

## Recommended Action Plan

### Phase 1 -- Quick Wins (1-2 days, all S effort)
1. Fix sessionStorage to InMemoryWebStorage in `ui/src/auth/oidcConfig.ts`
2. Add JWKS cache TTL in `inventory-service/app/middleware/auth.py`
3. Add JVM memory flags to ecom-service Deployment
4. Add nginx asset caching headers in `ui/nginx/default.conf`
5. Fix CartPage to use bulk stock endpoint in `ui/src/pages/CartPage.tsx`
6. Disable Swagger in production profile in `ecom-service/src/main/resources/application.yml`
7. Add PeerAuthentication for observability namespace in `infra/istio/security/peer-auth.yaml`
8. Change `npm install` to `npm ci` in `ui/Dockerfile`

### Phase 2 -- Medium Effort (1-2 weeks)
1. Implement Bucket4j rate limiting with Redis (or remove Redis if unused)
2. Add unit tests for core business logic (both services)
3. Add integration tests with TestContainers
4. Add CI pipeline (GitHub Actions)
5. Fix N+1 queries with `@EntityGraph` in `CartItemRepository`
6. Add NetworkPolicies for remaining namespaces
7. Implement Kafka dead-letter topic
8. Add `React.lazy()` code splitting for admin routes
9. Add `docker-compose.dev.yml` for local development
10. Implement audit logging for admin actions
11. Add HTTP `Cache-Control` headers for book catalog
12. Handle book delete FK constraint with 409 response

### Phase 3 -- Larger Investments (2-4 weeks)
1. External secret management (Sealed Secrets or Vault)
2. TLS termination at gateway
3. Transactional outbox pattern for Kafka events
4. Dependency and container image scanning in CI
5. Audience validation in Keycloak + both services
6. Waypoint proxy for L7 Istio authorization
7. Full DTO projection layer (decouple JPA entities from API)
8. Multiple uvicorn workers with gunicorn
9. CartTable component extraction and UI deduplication
