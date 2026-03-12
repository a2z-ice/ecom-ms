# Session 28 — Architecture Hardening: Technical Review

## Executive Summary

This session conducted a comprehensive architecture review across 8 dimensions — Security, Observability, Data Isolation, 15-Factor Compliance, TLS/Encryption, Reliability, Resiliency, and Test Coverage — and implemented 13 improvements. Two items (GitHub CI pipeline and AlertManager webhook receivers) are deferred to a future session.

---

## 1. Security Hardening

### S1 — Keycloak Container Security Context

**Problem:** Keycloak Deployment had pod-level `securityContext` (runAsNonRoot, runAsUser, fsGroup) but lacked container-level hardening — `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, and `capabilities.drop: ["ALL"]` were missing. The `wait-for-db` init container also lacked resource limits on some axes.

**Fix:** Added container-level `securityContext` to the Keycloak container:
```yaml
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
```
Added `emptyDir: {}` volumes for `/tmp` and `/opt/keycloak/data/tmp` since Keycloak writes temporary files during startup (theme compilation, class caching). Without these writable tmpfs mounts, the `readOnlyRootFilesystem: true` setting would cause startup failures.

**File:** `infra/keycloak/keycloak.yaml`

### S2 — Superset Container Security Context + Image Pin

**Problem:** Superset containers (both init `superset-init` and main `superset`) had no `securityContext` at all. The image tag was `:latest` — non-reproducible and vulnerable to supply chain drift.

**Fix:**
1. Added `securityContext` (readOnlyRootFilesystem, allowPrivilegeEscalation: false, capabilities drop ALL) to both containers
2. Added `/tmp` emptyDir volume for Python temporary files
3. Pinned image from `apache/superset:latest` → `apache/superset:4.1.2`

**File:** `infra/superset/superset.yaml`

### S3 — Image Version Pinning

**Problem:** Multiple infrastructure components used `:latest` or loosely-versioned tags. In production, this creates:
- **Non-reproducible builds**: `docker pull` on different days yields different images
- **Supply chain risk**: A compromised `:latest` tag propagates automatically
- **Debugging difficulty**: Can't correlate behavior to a specific version

**Pinned versions:**

| Service | Before | After |
|---|---|---|
| Kafka | `confluentinc/cp-kafka:latest` | `confluentinc/cp-kafka:7.9.0` |
| Kafka Topics Init | `confluentinc/cp-kafka:latest` | `confluentinc/cp-kafka:7.9.0` |
| Grafana | `grafana/grafana:latest` | `grafana/grafana:11.6.0` |
| AlertManager | `prom/alertmanager:latest` | `prom/alertmanager:v0.28.1` |
| Schema Registry | `confluentinc/cp-schema-registry:latest` | `confluentinc/cp-schema-registry:7.9.0` |
| PgAdmin | `dpage/pgadmin4:latest` | `dpage/pgadmin4:8.16` |
| Redis | `redis:7-alpine` | `redis:7.4-alpine` |
| Superset | `apache/superset:latest` | `apache/superset:4.1.2` |

**Files:** `infra/kafka/kafka.yaml`, `infra/kafka/kafka-topics-init.yaml`, `infra/observability/grafana/grafana.yaml`, `infra/observability/alertmanager/alertmanager.yaml`, `infra/schema-registry/schema-registry.yaml`, `infra/pgadmin/pgadmin.yaml`, `infra/redis/redis.yaml`, `infra/superset/superset.yaml`

---

## 2. Observability Improvements

### O1 — Trace ID Injection into Application Logs

**Problem:** The inventory-service (Python FastAPI) emitted structured JSON logs but did not include OpenTelemetry trace context (trace ID, span ID). This made it impossible to correlate a specific log line with the distributed trace that produced it — a critical gap for production debugging.

**How it works:**

The OpenTelemetry `LoggingInstrumentor` patches Python's `logging.LogRecord` to inject three attributes into every log record:
- `otelTraceID` — 32-hex-char W3C trace ID (e.g., `a1b2c3d4e5f6...`)
- `otelSpanID` — 16-hex-char span ID
- `otelTraceSampled` — boolean indicating if the trace was sampled

The `JsonFormatter` is configured to include these fields and rename them to `trace.id`, `span.id`, and `trace.sampled` in the output JSON:

```python
_json_formatter = JsonFormatter(
    fmt="%(asctime)s %(levelname)s %(name)s %(message)s %(otelTraceID)s %(otelSpanID)s %(otelTraceSampled)s",
    rename_fields={
        "otelTraceID": "trace.id",
        "otelSpanID": "span.id",
        "otelTraceSampled": "trace.sampled",
    },
)
```

**ecom-service (Java Spring Boot):** Already covered. The OpenTelemetry Java agent auto-injects `trace_id` and `span_id` into the SLF4J MDC. The ECS (Elastic Common Schema) JSON formatter used by ecom-service includes all MDC entries automatically.

**Dependency added:** `opentelemetry-instrumentation-logging = "^0.49b0"` in `inventory-service/pyproject.toml`

**Files:** `inventory-service/app/main.py`, `inventory-service/pyproject.toml`

### O2 — Loki & Tempo Persistent Storage

**Problem:** Both Loki (log aggregation) and Tempo (trace storage) used `emptyDir: {}` volumes. Pod restarts wiped all historical logs and traces — unacceptable for production debugging where you need to review logs from hours or days ago.

**Fix:** Migrated both to PersistentVolumeClaims backed by `local-hostpath` StorageClass:

1. **PersistentVolumes** (2Gi each): `loki-pv` at `/data/loki`, `tempo-pv` at `/data/tempo` — both with `DirectoryOrCreate` type and `Retain` reclaim policy
2. **PersistentVolumeClaims**: `loki-pvc` and `tempo-pvc` in the `otel` namespace
3. **Volume mount change**: Deployment volumes switched from `emptyDir: {}` to `persistentVolumeClaim: { claimName: <pvc> }`
4. **Data directory creation**: `scripts/cluster-up.sh` updated to create `data/loki` and `data/tempo` alongside other data directories

**Files:** `infra/storage/persistent-volumes.yaml`, `infra/observability/loki/loki.yaml`, `infra/observability/tempo/tempo.yaml`, `scripts/cluster-up.sh`

### O5 — Probabilistic Trace Sampling

**Problem:** The OTel Collector forwarded 100% of traces to Tempo. In production under load, this creates:
- Excessive storage consumption in Tempo
- Network overhead between Collector and Tempo
- No meaningful information gain (most traces are identical happy-path requests)

**Fix:** Added `probabilistic_sampler` processor to the OTel Collector traces pipeline:

```yaml
probabilistic_sampler:
  sampling_percentage: 25
```

This samples 25% of traces deterministically (based on trace ID hash), meaning:
- The same trace ID is always sampled or not — consistent across services
- 75% reduction in trace storage with no loss of error/anomaly visibility (errors are typically surfaced via logs and metrics, not just traces)

The processor is inserted in the traces pipeline between `memory_limiter` and `batch`:
```yaml
traces:
  receivers: [otlp]
  processors: [memory_limiter, probabilistic_sampler, batch]
  exporters: [otlphttp/tempo, debug]
```

**File:** `infra/observability/otel-collector.yaml`

---

## 3. Reliability Improvements

### R1 — Replica Scaling

**Problem:** All application Deployments ran with `replicas: 1`. A single pod failure = complete service outage until the replacement pod starts (typically 30-90 seconds for Spring Boot, 10-20 seconds for FastAPI/nginx).

**Fix:** Scaled to `replicas: 2` for:
- `ecom-service` (Spring Boot) — handles all e-commerce API traffic
- `inventory-service` (FastAPI) — handles stock queries and reserve operations
- `ui-service` (nginx) — serves the React SPA

**Not scaled:** Keycloak (requires Infinispan/JGroups cluster discovery configuration — non-trivial, deferred).

**Impact on rate limiting:** Each ecom-service replica maintains independent in-memory Bucket4j counters. With 2 replicas, the effective per-user rate limit doubles (e.g., 10 checkouts/min becomes 20 across the pair). For this POC environment, this is acceptable. The circuit breaker (E2) provides graceful degradation if the rate limiter itself fails. For true distributed rate limiting, migrate to `bucket4j-redis` with `LettuceBasedProxyManager`.

**Files:** `ecom-service/k8s/ecom-service.yaml`, `inventory-service/k8s/inventory-service.yaml`, `ui/k8s/ui-service.yaml`

### R3 — PodDisruptionBudgets

**Problem:** Only ecom-service and inventory-service had PDBs. Other critical services (ui-service, keycloak, kafka, redis, flink-jobmanager) lacked them, meaning a `kubectl drain` during node maintenance could evict all pods simultaneously.

**Fix:** Added 5 new PDBs:

| PDB | Namespace | Selector | minAvailable |
|---|---|---|---|
| ui-service-pdb | ecom | app: ui-service | 1 |
| keycloak-pdb | identity | app: keycloak | 1 |
| kafka-pdb | infra | app: kafka | 1 |
| redis-pdb | infra | app: redis | 1 |
| flink-jobmanager-pdb | analytics | app: flink-jobmanager | 1 |

`minAvailable: 1` ensures at least one pod survives voluntary disruptions (node drain, cluster upgrade). It does NOT protect against involuntary disruptions (node crash, OOM kill).

**File:** `infra/kubernetes/pdb/pdb.yaml`

### R4 — CNPG Backup Configuration Placeholders

**Problem:** The 4 CloudNativePG clusters had no backup configuration. In production, this means no point-in-time recovery capability if data is corrupted or accidentally deleted.

**Fix:** Added commented-out `backup` section to all 4 CNPG Cluster CRs with:
- Barman object store configuration (S3-compatible)
- WAL archiving with gzip compression
- Retention policy (7 days)
- Scheduled backup (daily at 02:00 UTC)

The configuration is commented out because it requires:
1. An S3-compatible object store (MinIO, AWS S3, or similar)
2. A Kubernetes Secret with S3 credentials
3. Network access from kind nodes to the object store

When ready to enable, uncomment and provide the actual S3 endpoint and credentials.

```yaml
# backup:
#   barmanObjectStore:
#     destinationPath: "s3://<bucket>/cnpg/<cluster-name>/"
#     endpointURL: "http://minio.infra.svc:9000"
#     s3Credentials:
#       accessKeyId: { name: cnpg-s3-creds, key: ACCESS_KEY_ID }
#       secretAccessKey: { name: cnpg-s3-creds, key: SECRET_ACCESS_KEY }
#     wal: { compression: gzip }
#   retentionPolicy: "7d"
# scheduledBackup:
#   schedule: "0 2 * * *"
```

**Files:** `infra/cnpg/ecom-db-cluster.yaml`, `infra/cnpg/inventory-db-cluster.yaml`, `infra/cnpg/analytics-db-cluster.yaml`, `infra/cnpg/keycloak-db-cluster.yaml`

### R5 — Prometheus Health Probes

**Problem:** The Prometheus Deployment had no Kubernetes readiness or liveness probes. Kubernetes had no way to detect if Prometheus was unhealthy or not ready to receive scrape requests. A hung Prometheus process would continue receiving traffic even if unable to process it.

**Fix:** Added standard Prometheus health check endpoints as probes:

```yaml
readinessProbe:
  httpGet:
    path: /-/ready
    port: 9090
  initialDelaySeconds: 10
  periodSeconds: 10
livenessProbe:
  httpGet:
    path: /-/healthy
    port: 9090
  initialDelaySeconds: 30
  periodSeconds: 15
```

These are Prometheus's built-in health endpoints:
- `/-/ready`: Returns 200 when Prometheus has completed initial TSDB loading and is ready to serve queries
- `/-/healthy`: Returns 200 when the process is alive and functional

**File:** `infra/observability/prometheus/prometheus.yaml`

---

## 4. Resiliency Improvements

### E2 — Rate Limiter Circuit Breaker

**Problem:** The `RateLimitConfig` rate limiting filter could throw unexpected exceptions (e.g., JWT decode errors, ConcurrentHashMap corruption under extreme contention). An unhandled exception would result in a 500 error, blocking legitimate users.

**Fix:** Implemented a circuit breaker pattern wrapping the rate limit resolution:

**Circuit breaker states:**
1. **CLOSED** (normal): Rate limiting active. Each successful request resets the failure counter.
2. **OPEN** (degraded): Rate limiting bypassed — all requests allowed through. Triggered after 5 failures within 60 seconds.
3. **HALF-OPEN** (recovery): After 30 seconds in OPEN state, the next request attempts rate limiting again. Success → CLOSED; failure → OPEN.

**Configuration constants:**
- `CB_FAILURE_THRESHOLD = 5` — failures before opening the circuit
- `CB_WINDOW_MS = 60_000` — sliding window for counting failures
- `CB_RESET_MS = 30_000` — time in OPEN state before attempting recovery

**Key design decisions:**
- **Fail-open, not fail-closed**: When the circuit opens, requests pass through without rate limiting. This is intentional — availability is prioritized over rate protection. A brief window without rate limits is preferable to blocking all users.
- **Thread-safe**: Uses `AtomicInteger` and `AtomicLong` for lock-free concurrent access.
- **Deprecated API fix**: Migrated from `Bandwidth.simple()` (deprecated in Bucket4j 8.x) to `Bandwidth.builder().capacity().refillGreedy()`.

**File:** `ecom-service/src/main/java/com/bookstore/ecom/config/RateLimitConfig.java`

### E5 — Dead Letter Queue Consumer + Admin Visibility

**Problem:** When the inventory-service Kafka consumer fails to process an `order.created` event (e.g., book ID not found, database error), the message is sent to the `order.created.dlq` topic. But no one monitors the DLQ — failed messages silently accumulate with no visibility or retry mechanism.

**Fix:** Three-part implementation:

#### 1. DLQ Consumer (`inventory-service/app/kafka/dlq_consumer.py`)

A supervised async Kafka consumer that:
- Consumes from `order.created.dlq` topic with group ID `inventory-dlq-monitor`
- Stores the last 100 messages in an in-memory `deque` (bounded, O(1) append/evict)
- Records offset, partition, timestamp, and the original event payload
- Runs with exponential backoff on errors (5s → 10s → 20s → 40s → 60s max)
- Graceful shutdown on `asyncio.CancelledError`

#### 2. Admin API Endpoints (`inventory-service/app/api/admin.py`)

| Method | Path | Description |
|---|---|---|
| `GET /admin/stock/dlq` | List DLQ messages | Returns `{ totalCount, messages[] }` — last 100 messages with metadata |
| `POST /admin/stock/dlq/{msg_id}/retry` | Retry a DLQ message | Re-publishes the original event back to `order.created` topic |

Both endpoints require `admin` Keycloak role (same auth as existing admin endpoints).

The retry mechanism:
1. Looks up the DLQ message by ID in the in-memory store
2. Extracts the original event from the DLQ envelope
3. Creates a new `AIOKafkaProducer`, sends the event to `order.created`, and closes the producer
4. Returns `{ status: "retried", id, topic }`

#### 3. Lifespan Integration (`inventory-service/app/main.py`)

The DLQ consumer runs as an `asyncio.Task` alongside the main order consumer:
```python
_dlq_task = asyncio.create_task(run_dlq_consumer_supervised())
```
On shutdown, both tasks are cancelled and awaited for clean termination.

**Files:** `inventory-service/app/kafka/dlq_consumer.py` (new), `inventory-service/app/api/admin.py`, `inventory-service/app/main.py`

---

## 5. Test Coverage

### C1 — k6 Load Test Scripts

**Problem:** No load testing framework existed. Performance regressions could only be detected anecdotally.

**Fix:** Created `load-tests/` directory with 3 k6 scripts:

| Script | Target | VUs | Duration | Thresholds |
|---|---|---|---|---|
| `k6-books.js` | `GET /ecom/books` | 10 | 30s | p95 < 500ms, error rate < 1% |
| `k6-stock.js` | `GET /inven/stock/bulk` | 10 | 30s | p95 < 300ms, error rate < 1% |
| `k6-checkout.js` | Cart + checkout flow | 3 | 30s | p95 < 2000ms, error rate < 5% |

**Usage:**
```bash
k6 run load-tests/k6-books.js        # public endpoint, no auth needed
k6 run load-tests/k6-stock.js        # public endpoint
k6 run load-tests/k6-checkout.js     # requires KC_TOKEN env var for auth
```

**Files:** `load-tests/k6-books.js`, `load-tests/k6-stock.js`, `load-tests/k6-checkout.js`, `load-tests/README.md`

---

## 6. Deferred Items (Future Session Checklist)

### GitHub CI Pipeline
- [ ] GitHub Actions workflow for ecom-service: `mvn test`, `mvn package`, Docker build
- [ ] GitHub Actions workflow for inventory-service: `poetry install`, `pytest`, Docker build
- [ ] GitHub Actions workflow for ui-service: `npm install`, `npm run lint`, `npm run build`, Docker build
- [ ] Integration test step (kind cluster + E2E tests)
- [ ] Container image scanning (Trivy or Snyk)

### AlertManager Webhook Receivers
- [ ] Slack webhook receiver for critical alerts (pod crash, DB failover, certificate expiry < 3d)
- [ ] Email receiver for warning-level alerts (high error rate, disk > 80%)
- [ ] PagerDuty integration for P1 alerts (all DBs down, gateway unreachable)
- [ ] Alert routing: `severity: critical` → Slack + PagerDuty, `severity: warning` → Slack + Email

---

## 7. Files Modified Summary

| File | Change |
|---|---|
| `ecom-service/k8s/ecom-service.yaml` | replicas: 1 → 2 |
| `ecom-service/src/main/java/.../RateLimitConfig.java` | Circuit breaker + Bandwidth API fix |
| `infra/cnpg/*-cluster.yaml` (4 files) | Backup config placeholders |
| `infra/kafka/kafka.yaml` | Image pin: 7.9.0 |
| `infra/kafka/kafka-topics-init.yaml` | Image pin: 7.9.0 |
| `infra/keycloak/keycloak.yaml` | Container securityContext |
| `infra/kubernetes/pdb/pdb.yaml` | 5 new PDBs |
| `infra/observability/alertmanager/alertmanager.yaml` | Image pin: v0.28.1 |
| `infra/observability/grafana/grafana.yaml` | Image pin: 11.6.0 |
| `infra/observability/loki/loki.yaml` | PVC + PV |
| `infra/observability/otel-collector.yaml` | Probabilistic sampler 25% |
| `infra/observability/prometheus/prometheus.yaml` | Readiness + liveness probes |
| `infra/observability/tempo/tempo.yaml` | PVC + PV |
| `infra/pgadmin/pgadmin.yaml` | Image pin: 8.16 |
| `infra/redis/redis.yaml` | Image pin: 7.4-alpine |
| `infra/schema-registry/schema-registry.yaml` | Image pin: 7.9.0 |
| `infra/storage/persistent-volumes.yaml` | loki-pv + tempo-pv |
| `infra/superset/superset.yaml` | securityContext + image pin: 4.1.2 |
| `inventory-service/app/api/admin.py` | DLQ admin endpoints |
| `inventory-service/app/kafka/dlq_consumer.py` | New: DLQ consumer |
| `inventory-service/app/main.py` | LoggingInstrumentor + DLQ task |
| `inventory-service/k8s/inventory-service.yaml` | replicas: 1 → 2 |
| `inventory-service/pyproject.toml` | OTel logging dependency |
| `ui/k8s/ui-service.yaml` | replicas: 1 → 2 |
| `scripts/cluster-up.sh` | loki + tempo data dirs |
| `load-tests/*` | New: k6 load test scripts |
