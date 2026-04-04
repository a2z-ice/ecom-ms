# Comprehensive Security, Performance & Resilience Audit

**Date:** 2026-03-29
**Scope:** Full-stack review of the BookStore microservices platform (Sessions 1-25+)
**Methodology:** OWASP Top 10, NIST SP 800-53, CIS Kubernetes Benchmarks, CNCF best practices
**Platform State:** ~200+ E2E tests passing, 5 microservices, Istio Ambient mesh, kind cluster

---

## Executive Summary

This platform demonstrates **strong architectural foundations** with sophisticated cloud-native security patterns (Istio mTLS, OIDC/PKCE, gateway-level CSRF, NetworkPolicies). However, critical gaps exist in **disaster recovery, infrastructure redundancy, and operational security** that must be addressed before production deployment.

| Domain | Grade | Key Risk |
|--------|-------|----------|
| **Security** | B+ | Hardcoded secrets in Git; no vulnerability scanning pipeline |
| **Performance** | B- | Flink parallelism=1; undersized JVM resources; no code splitting |
| **Reliability** | B | Strong HA for databases; single-instance Kafka/Redis/Keycloak |
| **Resilience** | B- | Good circuit breakers; fire-and-forget event publishing; no chaos testing |
| **Disaster Recovery** | D | Backup config commented out; no automated backups; no tested restore |

**Critical findings:** 6 | **High:** 12 | **Medium:** 22 | **Low:** 11

---

## Table of Contents

1. [Security Audit](#1-security-audit)
2. [Performance Analysis](#2-performance-analysis)
3. [Reliability & High Availability](#3-reliability--high-availability)
4. [Resilience & Fault Tolerance](#4-resilience--fault-tolerance)
5. [Disaster Recovery & Data Durability](#5-disaster-recovery--data-durability)
6. [Observability & Operational Readiness](#6-observability--operational-readiness)
7. [Prioritized Remediation Roadmap](#7-prioritized-remediation-roadmap)

---

## 1. Security Audit

### 1.1 Authentication & Authorization

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| S-1 | Hardcoded placeholder passwords in K8s Secrets | **HIGH** | All secrets manifests | Base64-encoded `CHANGE_ME` committed to Git across 10+ Secret manifests (Keycloak, Redis, CNPG, ecom, inventory, csrf). Decodable in seconds. Violates "secrets never in version control" principle. |
| S-2 | No JWT token binding (cnf claim) validation | **MEDIUM** | ecom-service, inventory-service | JWT signature and issuer/audience validated, but no confirmation claim binding. Stolen tokens usable from any client context. |
| S-3 | Keycloak admin default credentials not enforced | **MEDIUM** | `infra/keycloak/keycloak.yaml` | Bootstrap admin password is `CHANGE_ME` with no enforcement mechanism to prevent production deployment with defaults. |
| S-4 | Gateway allows all namespaces to attach HTTPRoutes | **MEDIUM** | `infra/kgateway/gateway.yaml` | `allowedRoutes.namespaces.from: All` — any namespace can create routes, enabling traffic hijacking from compromised service accounts. |

**What's working well:**
- OIDC Authorization Code Flow with PKCE correctly implemented
- Tokens stored in memory (never localStorage)
- Istio Ambient mTLS STRICT mode across all app namespaces
- CSRF protection via dedicated gateway-level ext_authz service with Redis-backed sliding TTL
- Per-user rate limiting with endpoint-specific tiers (checkout: 10/min, cart: 60/min, books: 200/min)

### 1.2 Secrets Management

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| S-5 | No external secrets management (Vault, ESO, Sealed Secrets) | **HIGH** | Cluster-wide | All secrets are plain K8s Secrets with base64 encoding. No encryption at rest, no rotation policy, no audit trail. |
| S-6 | Duplicate database credentials across secret types | **MEDIUM** | CNPG clusters | Each DB maintains TWO secrets (basic-auth for CNPG + Opaque for app) with identical passwords, doubling attack surface. |
| S-7 | K8s Secrets not encrypted at rest in etcd | **LOW** | kind cluster | Default etcd storage is plaintext. Mitigated by NetworkPolicies and local-only development, but required for production. |

### 1.3 Container Security

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| S-8 | Base images not pinned to SHA256 digests | **MEDIUM** | All Dockerfiles | Using tags (`eclipse-temurin:21-jdk-alpine`, `python:3.12-slim`) instead of digests. Silent image mutations possible. |
| S-9 | No container image vulnerability scanning | **MEDIUM** | CI/CD pipeline | No Trivy, Grype, or similar scanner in build pipeline. No SBOM generation. |

**What's working well:**
- All containers run as non-root with read-only filesystems
- `allowPrivilegeEscalation: false` and `capabilities.drop: ["ALL"]` everywhere
- csrf-service uses distroless base (zero attack surface)
- Multi-stage Dockerfiles separate build/runtime

### 1.4 Network Security

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| S-10 | OTel namespace uses PERMISSIVE mTLS | **MEDIUM** | `infra/istio/security/peer-auth.yaml` | Istio CNI overrides `ambient.istio.io/redirection: disabled` annotation, requiring PERMISSIVE fallback. Mitigated by NetworkPolicy. |
| S-11 | NodePort services accept plaintext from host | **MEDIUM** | Keycloak, Superset, Grafana, PgAdmin, Flink, Debezium | Port-level PERMISSIVE mTLS required for kind hostPort mapping. Acceptable for development; must not expose in production. |
| S-12 | Kafka uses plaintext with no ACLs | **HIGH** | `infra/kafka/kafka.yaml` | `PLAINTEXT:PLAINTEXT` listener protocol. Any pod in the cluster can produce/consume any topic. No SASL authentication. |

**What's working well:**
- Default deny-all NetworkPolicies across all namespaces (11 policies)
- Port-level granularity in network policies
- STRICT PeerAuthentication for all app namespaces
- Gateway TLS termination with cert-manager auto-rotation (30d cert, 7d renewBefore)
- HTTP-to-HTTPS redirect on port 30080

### 1.5 Input Validation & Injection

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| S-13 | Search query parameter has no length limit | **MEDIUM** | `BookController.searchBooks()` | `@RequestParam String q` accepted without `@Size` constraint. Risk: ReDoS, resource exhaustion, cache poisoning. Rate limiting provides partial mitigation. |
| S-14 | Cart quantity has no upper bound | **LOW** | `CartRequest` | `@Min(1)` validated but no `@Max`. Users could request 999,999 units. |

**What's working well:**
- All database access via ORM (JPA/SQLAlchemy) — no raw SQL injection vectors
- UUID type safety on all resource endpoints prevents path traversal
- Jakarta Bean Validation (`@Valid`) on all request DTOs
- Bulk stock API caps at 50 IDs with UUID parsing validation

### 1.6 API & Application Security

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| S-15 | Swagger conditionally enabled via env var | **MEDIUM** | ecom-service `SecurityConfig` | `SWAGGER_ENABLED=false` in prod, but accidental `true` exposes full API docs. No runtime guard against production enablement. |
| S-16 | No security headers on backend APIs | **LOW** | ecom-service, inventory-service | `X-Frame-Options`, `X-Content-Type-Options` only set in UI Nginx, not in API responses. |
| S-17 | PII not masked in application logs | **MEDIUM** | All services | User IDs, order data, and cart contents logged via OTel without redaction. Structured logging present but no PII filter. |
| S-18 | No dependency vulnerability scanning | **MEDIUM** | All services | No OWASP Dependency-Check (Maven), Safety/Bandit (Python), or govulncheck (Go) in build process. No Dependabot or Snyk integration. |
| S-19 | Explicit RBAC roles/bindings not defined | **MEDIUM** | Cluster-wide | Relies on Istio AuthorizationPolicy for pod-to-pod auth. No K8s RBAC Role/RoleBinding manifests for service accounts. |

**What's working well:**
- GlobalExceptionHandler returns RFC 7807 ProblemDetail (no stack traces leaked)
- CORS whitelist restricted to known origins
- Content-Security-Policy header in UI Nginx
- Actuator endpoints appropriately scoped

### 1.7 Supply Chain Security

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| S-20 | Python dependencies use caret ranges | **LOW** | `inventory-service/pyproject.toml` | `^0.115.0` allows minor/patch upgrades. `poetry.lock` committed (good), but caret ranges risk unexpected changes on fresh installs. |

**What's working well:**
- Maven parent version pinned (Spring Boot 4.0.3)
- Go modules use exact versions in go.sum
- poetry.lock committed to version control

---

## 2. Performance Analysis

### 2.1 Database Performance

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| P-1 | Connection pool undersized | **MEDIUM** | ecom-service Hikari | `maximum-pool-size: 10`, `minimum-idle: 2`. With HPA scaling to 5 pods, total pool = 50 connections. Under load, connection exhaustion likely during cart/checkout spikes. |
| P-2 | Missing database indexes on frequent queries | **MEDIUM** | ecom-service schema | No indexes on `orders.user_id`, `order_items.order_id`, `books.genre`, `books.author`, `cart_items.user_id`. Full table scans on user order history and catalog search. |
| P-3 | Order query not paginated | **MEDIUM** | `OrderRepository` | `findByUserIdOrderByCreatedAtDesc()` loads ALL orders into memory. Good `@EntityGraph` usage, but unbounded result set risks OOM for high-volume users. |
| P-4 | Database storage undersized | **MEDIUM** | CNPG clusters | `storage: 2Gi` for ecom-db and inventory-db. WAL retention at 256MB leaves ~1GB safe window. Risk of unplanned downtime if storage fills. |

### 2.2 Caching Strategy

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| P-5 | Redis memory too small with wrong eviction policy | **MEDIUM** | `infra/redis/redis.yaml` | 200MB with `allkeys-lru` — evicts CSRF tokens during traffic spikes without distinguishing importance. Should use `volatile-lru` (only evict keys with TTL) and increase to 512MB. |
| P-6 | Missing HTTP cache headers on book detail endpoint | **MEDIUM** | `BookController.getBook()` | `/books` and `/search` have `Cache-Control: max-age=60`, but `/books/{id}` has none. Every book detail page triggers a fresh backend request. |
| P-7 | Redundant Redis persistence (AOF + RDB) | **LOW** | `infra/redis/redis.yaml` | Both `appendonly yes` and `save 60 1` enabled. Redundant I/O under write load. Pick one strategy. |

### 2.3 Compute Resources

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| P-8 | ecom-service JVM resources undersized | **HIGH** | `ecom-service/k8s/ecom-service.yaml` | 250m CPU request / 512Mi memory for Spring Boot + JPA + Liquibase + OTel agent. `-XX:MaxRAMPercentage=75.0` → 750MB heap in 1Gi limit. GC pauses >100ms likely during checkout under load. |
| P-9 | Inventory service single UVicorn worker | **MEDIUM** | `inventory-service/Dockerfile` | `--workers 1` with 100m CPU request. Single worker = single concurrent request handler. Should be 2 workers with 200m CPU request. |
| P-10 | HPA minReplicas=1 conflicts with PDB | **MEDIUM** | `infra/kubernetes/hpa/hpa.yaml` | ecom-service and inventory-service HPA `minReplicas: 1`, but PDB requires `minAvailable: 1` and rolling update has `maxUnavailable: 0`. Scaling to 1 pod makes zero-downtime updates impossible. |

### 2.4 Flink Pipeline (Critical Bottleneck)

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| P-11 | Flink parallelism=1 serializes all CDC processing | **CRITICAL** | `infra/flink/flink-cluster.yaml` | All 4 CDC sources (orders, order_items, books, inventory) processed by single thread. Analytics DB starves under any meaningful throughput. |
| P-12 | Flink checkpoints on emptyDir (ephemeral) | **MEDIUM** | `infra/flink/flink-cluster.yaml` | Checkpoint volume is `emptyDir: {}` — lost on pod restart. Job must replay from Kafka consumer offset, causing CDC lag spike. |
| P-13 | Flink JobManager memory overcommitted | **MEDIUM** | `infra/flink/flink-cluster.yaml` | `jobmanager.memory.process.size: 900m` declared but container limit is 1Gi. OOMKill risk as metadata grows. |
| P-14 | No TaskManager deployment | **MEDIUM** | Flink architecture | All jobs run in-process on JobManager. No distributed parallelism possible. |

### 2.5 Kafka & Messaging

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| P-15 | Topic partitions undersized | **MEDIUM** | `infra/kafka/kafka-topics-init.yaml` | 3 partitions for all topics. With HPA scaling to 5 ecom-service pods, 2 consumers idle. Should be 6 partitions for even distribution. |

### 2.6 Frontend Performance

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| P-16 | No Vite code splitting configured | **MEDIUM** | `ui/vite.config.ts` | No `manualChunks` — single bundle includes React, React Router, oidc-client-ts. Every page load fetches entire app (~200-300KB gzipped). |
| P-17 | No image lazy loading or optimization | **LOW** | UI components | Book cover images loaded eagerly without `loading="lazy"`, responsive `srcSet`, or WebP format. |

### 2.7 Service-to-Service Communication

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| P-18 | Inventory read timeout too generous | **LOW** | `RestClientConfig.java` | 10s read timeout on inventory reserve call. Checkout UX degrades significantly if inventory service is slow. Consider 3s with circuit breaker fallback. |

### 2.8 Observability Overhead

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| P-19 | OTel trace sampling at 25% misses tail errors | **MEDIUM** | `otel-collector.yaml` | `sampling_percentage: 25` drops 75% of traces. Error-heavy traces likely missed. Consider 100% to Tempo (designed for high volume) or tail-based sampling with error priority. |

---

## 3. Reliability & High Availability

### 3.1 Infrastructure Single Points of Failure

| # | Finding | Severity | Component | Replicas | Impact on Failure |
|---|---------|----------|-----------|----------|-------------------|
| R-1 | Kafka single broker | **CRITICAL** | `infra/kafka/kafka.yaml` | 1 | ALL event processing stops. No order→inventory flow. CDC pipeline halts. |
| R-2 | Redis single instance | **CRITICAL** | `infra/redis/redis.yaml` | 1 | CSRF token store lost (hybrid HMAC mode degrades gracefully). Rate limiting state lost. |
| R-3 | Keycloak single instance | **HIGH** | `infra/keycloak/keycloak.yaml` | 1 | New logins fail. Token refresh fails. Existing sessions survive until JWKS cache expires (~5 min). |
| R-4 | Flink JobManager single instance | **HIGH** | `infra/flink/flink-cluster.yaml` | 1 | Analytics pipeline stops. No automatic job recovery. |

**What's working well:**
- All 4 PostgreSQL databases: 2 instances with CNPG (auto-failover ~30s)
- Synchronous replication with slot syncing (zero data loss on primary failure)
- Logical replication slot sync for Debezium (survives CNPG failover)
- ecom-service, inventory-service, ui-service, csrf-service: 2 replicas with PDB
- `topologySpreadConstraints` with `maxSkew: 1` across nodes
- Rolling update strategy: `maxSurge: 1, maxUnavailable: 0`

### 3.2 Health Check Assessment

| Service | Startup | Readiness | Liveness | Dependency Checks | Issues |
|---------|---------|-----------|----------|-------------------|--------|
| ecom-service | 150s window | Actuator readiness | Actuator liveness | DB, Kafka | None |
| inventory-service | 150s window | `/health/ready` + SELECT 1 | `/health` | DB | None |
| csrf-service | None | `/healthz` (Redis ping) | `/livez` | Redis | Missing startup probe |
| ui-service | None | `/nginx-health` | `/nginx-health` | None | Does NOT check backend connectivity |
| Keycloak | 120s window | `/realms/master` | `/realms/master` | DB | Probe too lenient |
| Kafka | None | TCP 9092 | exec probe (slow) | None | Exec probe ~45-90s failure detection |
| Flink | None | `/overview` | `/overview` | None | failureThreshold=5, 150s detection window |

---

## 4. Resilience & Fault Tolerance

### 4.1 Circuit Breakers & Retries

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| R-5 | Kafka event publishing is fire-and-forget | **CRITICAL** | `OrderEventPublisher.java` | `kafkaTemplate.send()` failures only logged, not retried. Order committed to DB but `order.created` event lost — inventory never deducted. Data inconsistency between order and stock. |
| R-6 | No circuit breaker on CSRF service calls | **MEDIUM** | UI → csrf-service | If csrf-service is slow/down, all form submissions blocked. No timeout/fallback in gateway ext_authz path. |
| R-7 | CSRF HMAC key rotation has no versioning | **MEDIUM** | `csrf-service` | Single active HMAC key. Key rotation immediately invalidates all in-flight tokens. Should support 2 concurrent key versions. |

**What's working well:**
- Resilience4j circuit breaker on ecom→inventory calls (50% failure threshold, 10s open state, 3 half-open calls)
- Kafka consumer retries with exponential backoff (3 retries, 0.5s base)
- Dead Letter Queue for failed inventory processing
- CSRF service fail-open on Redis errors (JWT remains primary defense)
- Gateway-level timeouts (30s request, 25s backend)
- RestClient connect timeout (5s) and read timeout (10s)

### 4.2 Idempotency

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| R-8 | Cart addToCart is not idempotent | **MEDIUM** | `CartService.java` | `existing.setQuantity(existing.getQuantity() + request.quantity())` — retried requests increment quantity twice. Should use set-semantics or idempotency key. |
| R-9 | Order idempotency key is optional | **LOW** | `OrderService.checkout()` | Client must provide `Idempotency-Key` header. Without it, retried checkouts create duplicate orders. |
| R-10 | Kafka consumer may produce duplicate `inventory.updated` events | **LOW** | `inventory-service/consumer.py` | Offset committed AFTER producing event. If commit fails, reprocessing produces duplicate. Mitigated by `SELECT FOR UPDATE` quantity check. |

**What's working well:**
- Order idempotency key support (when provided)
- Kafka consumer uses `enable_auto_commit=False` with manual commit
- Row-level locking (`SELECT ... FOR UPDATE`) prevents double stock deduction
- Debezium CDC events include `source.lsn` and `source.txId` for deduplication

### 4.3 Graceful Degradation Scenarios

| Failure | Behavior | Grade |
|---------|----------|-------|
| Database down | Pod marked unready, traffic stopped by K8s | A |
| Redis down | CSRF fails open (HMAC mode), rate limiting bypassed | B+ |
| Kafka down | Orders created but inventory not deducted (fire-and-forget) | D |
| Keycloak down | Existing sessions work until JWKS cache expires (~5 min). New logins fail immediately. | C+ |
| Inventory service down | Circuit breaker opens after 5 failures. Checkout returns error. | B |
| Flink down | Analytics pipeline stops. Kafka messages accumulate. No user-facing impact. | B+ |
| Debezium down | CDC events stop. Data accumulates in WAL. Auto-resumes from offset on restart. | A- |

---

## 5. Disaster Recovery & Data Durability

### 5.1 Backup & Restore

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| R-11 | CNPG backup configuration commented out | **CRITICAL** | All `infra/cnpg/*-cluster.yaml` | `backup:` section commented out. No automated backup of any database. Complete data loss on cluster deletion. |
| R-12 | No automated backup scheduling | **HIGH** | Operations | `scripts/backup.sh` exists and works (dumps all 4 DBs + Kafka offsets + Keycloak realm), but requires manual execution. No CronJob. |
| R-13 | Backups stored on local filesystem only | **HIGH** | `scripts/backup.sh` | Backups written to `backups/` on host. If host is lost, backups are lost. No off-site storage (S3, GCS, etc.). |
| R-14 | No automated restore testing | **HIGH** | Operations | `scripts/restore.sh` exists but no evidence of regular restore testing. No RTO measurement. No data consistency validation post-restore. |
| R-15 | No WAL archiving to remote storage | **MEDIUM** | CNPG clusters | WAL retained locally (256MB `wal_keep_size`). A node loss = WAL loss. No remote archival. |
| R-16 | DLQ messages stored in-memory | **HIGH** | `inventory-service/dlq_consumer.py` | `deque(maxlen=100)` — failed order events lost on pod restart. Impossible to replay. |

### 5.2 RTO/RPO Assessment

| Component | Current RPO | Current RTO | Target (Production) |
|-----------|-------------|-------------|---------------------|
| PostgreSQL (CNPG) | 0 (sync replication) | ~30s (auto-failover) | RPO: 0, RTO: <60s |
| Kafka | ~5s (flush interval) | Manual restart | RPO: 0, RTO: <60s |
| Redis | Total loss (no persistence guarantees) | ~30s (pod restart + cache rebuild) | RPO: N/A (cache), RTO: <30s |
| Flink State | Total loss (emptyDir) | Manual job resubmission | RPO: Kafka offset, RTO: <5m |
| Full Cluster | Hours-Days (manual scripts) | Manual: `bash scripts/up.sh` | RPO: <1h, RTO: <30m |

**No SLO/SLI/Error Budget defined.**

---

## 6. Observability & Operational Readiness

### 6.1 Alerting

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| R-17 | AlertManager webhook is non-functional | **MEDIUM** | `infra/observability/alertmanager/` | Webhook points to AlertManager's own health endpoint (circular). No actual notification delivery. |
| R-18 | Missing critical alerts | **MEDIUM** | Prometheus rules | No alerts for: Kafka broker down, Redis unavailable, CNPG replication lag, Debezium connector lag, order event publish failures. |

**What's working well:**
- Prometheus scraping all services (15s interval)
- Alert rules for: HighErrorRate, ServiceDown, FlinkJobNotRunning, DebeziumPodNotReady
- Full OTel pipeline: traces (Tempo), logs (Loki), metrics (Prometheus)
- Grafana dashboards: Application Logs (5 panels), service metrics
- Kiali service mesh visualization

### 6.2 Runbooks & Chaos Engineering

| # | Finding | Severity | Component | Details |
|---|---------|----------|-----------|---------|
| R-19 | No runbooks for critical failure scenarios | **MEDIUM** | Operations | Only `docs/operations/restart-app.md` exists. No runbooks for: Kafka failure, DB failover, Debezium stuck, DLQ replay, certificate expiry. |
| R-20 | No chaos engineering tests | **MEDIUM** | Testing | No Chaos Mesh, Gremlin, or Istio fault injection configured. Circuit breaker behavior untested under real failure conditions. |
| R-21 | No canary/blue-green deployment support | **LOW** | Deployment | Standard K8s rolling updates only. No Istio traffic splitting or Flagger integration. |

---

## 7. Prioritized Remediation Roadmap

### Phase 1: CRITICAL (Week 1 - Deploy Blockers)

| Priority | Finding | Action | Effort |
|----------|---------|--------|--------|
| C1 | R-11: Backups disabled | Enable CNPG barman backup to S3/MinIO. Add ScheduledBackup CronJob (daily 2 AM). | 2 days |
| C2 | R-5: Fire-and-forget event publishing | Implement transactional outbox pattern OR abort checkout transaction on Kafka failure. | 3 days |
| C3 | S-1/S-5: Hardcoded secrets in Git | Deploy External Secrets Operator or Sealed Secrets. Remove all base64 CHANGE_ME from manifests. Add pre-commit hook. | 2 days |
| C4 | P-11: Flink parallelism=1 | Set `parallelism.default: 4`. Deploy TaskManager pods. Use RocksDB state backend. | 1 day |
| C5 | R-1: Kafka single broker | Scale to 3 replicas with `min.insync.replicas=2`, `replication-factor=3`. | 2 days |
| C6 | R-16: DLQ in-memory storage | Persist DLQ messages to database table. Add replay endpoint. | 1 day |

### Phase 2: HIGH (Week 2-3)

| Priority | Finding | Action | Effort |
|----------|---------|--------|--------|
| H1 | R-2: Redis single instance | Deploy Redis Sentinel (3 nodes) or Redis Cluster. | 2 days |
| H2 | R-3: Keycloak single instance | Scale to 2 replicas (DB already HA). Configure Infinispan distributed cache. | 1 day |
| H3 | P-8: JVM undersized | Increase to 500m CPU / 768Mi request, 1000m / 1.5Gi limit. Set MaxRAMPercentage=50. | 2 hours |
| H4 | R-12/R-13: No automated backups | Create CronJob for `scripts/backup.sh`. Configure S3 destination. Test restore. | 1 day |
| H5 | P-10: HPA min=1 conflicts PDB | Set `minReplicas: 2` for ecom-service and inventory-service. | 30 min |
| H6 | S-12: Kafka no ACLs | Enable SASL_PLAINTEXT + AclAuthorizer. Create per-service ACLs. | 1 day |
| H7 | R-4: Flink single JobManager | Enable HA mode with shared checkpoint storage. | 1 day |
| H8 | P-2: Missing DB indexes | Add Liquibase migration for indexes on `orders.user_id`, `order_items.order_id`, `cart_items.user_id`, `books.genre`, `books.author`. | 2 hours |
| H9 | R-14: No restore testing | Automate monthly restore validation on separate namespace. Measure RTO. | 1 day |
| H10 | S-4: Gateway allows all namespaces | Restrict `allowedRoutes.namespaces.from: Selector` with label whitelist. | 1 hour |
| H11 | P-12: Flink checkpoints ephemeral | Create PVC for Flink checkpoints and savepoints. | 2 hours |
| H12 | R-17: AlertManager non-functional | Configure real webhook receiver (Slack, PagerDuty, email). | 2 hours |

### Phase 3: MEDIUM (Month 2)

| Priority | Finding | Action | Effort |
|----------|---------|--------|--------|
| M1 | S-8/S-9: Image security | Pin all base images to SHA256 digests. Add Trivy scanning to build pipeline. | 1 day |
| M2 | S-18: No vulnerability scanning | Add OWASP Dependency-Check (Maven), Safety (Python), govulncheck (Go). | 1 day |
| M3 | S-17: PII in logs | Add PII masking filter to logging pipeline (user IDs, order data). | 1 day |
| M4 | P-5: Redis eviction policy | Switch to `volatile-lru`, increase to 512MB. | 1 hour |
| M5 | P-16: No code splitting | Configure Vite `manualChunks` for react-vendor, router, oidc. | 2 hours |
| M6 | P-19: Low trace sampling | Increase to 100% or implement tail-based sampling with error priority. | 2 hours |
| M7 | R-8: Cart not idempotent | Add idempotency key or switch to set-semantics for quantity. | 4 hours |
| M8 | P-1: Connection pool undersized | Increase Hikari to `max-pool-size: 20`, `min-idle: 5`. | 30 min |
| M9 | P-3: Unbounded order query | Add pagination to `findByUserIdOrderByCreatedAtDesc()`. | 2 hours |
| M10 | P-9: Single UVicorn worker | Increase to 2 workers, adjust CPU request to 200m. | 1 hour |
| M11 | R-7: CSRF key rotation | Implement key versioning (accept last 2 keys during rotation). | 4 hours |
| M12 | S-19: No K8s RBAC | Create minimal Role/RoleBinding per service account per namespace. | 1 day |
| M13 | R-18: Missing alerts | Add Prometheus rules for Kafka, Redis, CNPG lag, Debezium lag. | 4 hours |
| M14 | R-19: No runbooks | Document failure playbooks for Kafka, DB failover, Debezium, DLQ replay. | 2 days |
| M15 | S-13: Search query unbounded | Add `@Size(max=100)` to search parameter. Add `@Transactional(timeout=5)`. | 1 hour |

### Phase 4: LOW (Backlog / When Time Permits)

| Finding | Action |
|---------|--------|
| S-7: etcd encryption | Enable encryption-at-rest (production K8s only) |
| S-16: Backend security headers | Add X-Frame-Options, X-Content-Type-Options to APIs |
| P-7: Redis dual persistence | Choose AOF or RDB, not both |
| P-17: Image lazy loading | Add `loading="lazy"` and responsive `srcSet` to book images |
| P-18: Inventory timeout | Tighten read timeout from 10s to 3s |
| R-9: Optional idempotency key | Make `Idempotency-Key` header required on checkout |
| R-20: Chaos engineering | Deploy Chaos Mesh. Test circuit breakers under real failure. |
| R-21: Canary deployments | Evaluate Flagger for automated canary analysis |
| S-2: JWT token binding | Add `cnf` claim validation for high-value operations |

---

## Appendix A: Positive Findings (Strengths)

These patterns are well-implemented and should be preserved:

| Area | Pattern | Details |
|------|---------|---------|
| **Auth** | OIDC PKCE + In-Memory Tokens | Correct implementation of Authorization Code Flow with PKCE. Tokens never touch localStorage. |
| **Auth** | Gateway-Level CSRF | Dedicated Go service via Istio ext_authz. Redis-backed sliding TTL. HMAC hybrid mode. Auto-regeneration in 403 response. |
| **Network** | Istio Ambient mTLS STRICT | Automatic encryption + identity for all service-to-service traffic. Zero cert management burden. |
| **Network** | Default-Deny NetworkPolicies | 11 policies with port-level granularity across all namespaces. DNS egress explicitly allowed. |
| **Network** | TLS + cert-manager | Self-signed CA chain with 30d leaf certs, 7d renewBefore. HTTP→HTTPS redirect. |
| **Database** | CNPG HA | 4 PostgreSQL clusters, each with 1 primary + 1 standby. Sync replication. Auto-failover. Logical slot sync for Debezium. |
| **Container** | Hardened Security Context | Non-root, read-only FS, no privilege escalation, all capabilities dropped. Distroless for csrf-service. |
| **Resilience** | Circuit Breaker | Resilience4j on inventory calls. Configurable failure threshold, wait duration, half-open testing. |
| **Resilience** | Kafka Consumer Retry + DLQ | 3 retries with exponential backoff. Failed messages sent to DLQ topic. Admin API for DLQ inspection. |
| **Resilience** | Order Idempotency | `findByIdempotencyKey()` returns existing order on retry (when key provided). |
| **Deployment** | Zero-Downtime Rollouts | `maxSurge: 1, maxUnavailable: 0` with PodDisruptionBudgets across all services. |
| **Observability** | Full OTel Stack | Traces (Tempo), Logs (Loki), Metrics (Prometheus). Grafana dashboards. Kiali mesh visualization. |
| **CDC** | Debezium + Flink SQL | Change Data Capture from PostgreSQL to analytics DB. Offset-based recovery. WAL-level integration. |
| **Operations** | Idempotent Scripts | `up.sh` auto-detects state (fresh/degraded/healthy). `restart-after-docker.sh` handles full recovery. |

## Appendix B: Grading Methodology

- **CRITICAL**: Production blocker. Data loss, security breach, or complete service failure likely.
- **HIGH**: Significant risk under normal production load. Should be fixed before go-live.
- **MEDIUM**: Causes degraded experience or increases attack surface. Fix within first quarter.
- **LOW**: Best practice improvement. Fix when convenient.

Grades per domain use weighted severity: Critical=4, High=3, Medium=2, Low=1. Domain grade = 100 - (weighted sum / max possible * 100), mapped to letter grades.
