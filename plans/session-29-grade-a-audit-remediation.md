# Session 29 — Grade A Audit Remediation

**Date:** 2026-03-29
**Goal:** Lift Security, Performance, Resilience, and Disaster Recovery from B-/D to Grade A based on comprehensive audit findings.
**Scope:** ~40 changes across all services and infrastructure (skipping #3 Reliability — no Kafka/Redis/Keycloak multi-instance scaling)

---

## Deliverables

| # | Deliverable | Domain | Status |
|---|-------------|--------|--------|
| 1 | `scripts/generate-secrets.sh` — externalize all hardcoded secrets | Security | Done |
| 2 | Gateway namespace restriction (`from: Selector`) | Security | Done |
| 3 | Docker image digest pinning script + comments | Security | Done |
| 4 | RBAC Role/RoleBinding per service namespace | Security | Done |
| 5 | Search query `@Size(min=1, max=200)` validation | Security | Done |
| 6 | Security headers on ecom-service + inventory-service | Security | Done |
| 7 | PII masking (Logback converter + Python filter) | Security | Done |
| 8 | Dependency vulnerability scanning (`scripts/security-scan.sh`) | Security | Done |
| 9 | `.github/dependabot.yml` | Security | Done |
| 10 | Hikari pool: max=20, min-idle=5 | Performance | Done |
| 11 | Database indexes (007-add-query-indexes.yaml) | Performance | Done |
| 12 | Order query pagination | Performance | Done |
| 13 | Book detail cache control (5 min) | Performance | Done |
| 14 | JVM resources: 500m/768Mi, MaxRAMPercentage=50 | Performance | Done |
| 15 | UVicorn workers: 1→2 | Performance | Done |
| 16 | HPA minReplicas: 1→2 | Performance | Done |
| 17 | Flink parallelism: 1→4 | Performance | Done |
| 18 | Flink JobManager memory: 900m→1200m, limit 1→1.5Gi | Performance | Done |
| 19 | Redis: 200→512MB, allkeys-lru→volatile-lru | Performance | Done |
| 20 | Kafka partitions: 3→6 | Performance | Done |
| 21 | OTel sampling: 25→100% | Performance | Done |
| 22 | Vite code splitting (react-vendor, router, oidc) | Performance | Done |
| 23 | Transactional outbox pattern (008-create-outbox-table) | Resilience | Done |
| 24 | Cart set-semantics (idempotent addToCart) | Resilience | Done |
| 25 | DLQ persistence to database (003_create_dlq_messages) | Resilience | Done |
| 26 | MinIO S3-compatible backup store | DR | Done |
| 27 | CNPG barman backups enabled (all 4 clusters) | DR | Done |
| 28 | ScheduledBackup CRs (daily 02:00) | DR | Done |
| 29 | AlertManager webhook fixed (→ OTel collector) | DR | Done |
| 30 | Infrastructure alert rules (Redis, Kafka, CNPG, PVC) | DR | Done |
| 31 | Operational runbooks (5 docs) | DR | Done |
| 32 | `scripts/verify-backup.sh` | DR | Done |

---

## Acceptance Criteria

1. **Security**: No `CHANGE_ME` in cluster secrets after `generate-secrets.sh`. Gateway rejects routes from unlabeled namespaces. Search query >200 chars returns 400. Security headers present on all API responses.
2. **Performance**: Flink jobs run with parallelism=4. HPA min=2 for ecom/inventory. Redis eviction is volatile-lru at 512MB. UI build produces multiple chunk files.
3. **Resilience**: Checkout writes to outbox table (not fire-and-forget). DLQ messages survive pod restart. Duplicate addToCart doesn't increment quantity.
4. **Disaster Recovery**: MinIO running. CNPG backups complete to MinIO. AlertManager delivers alerts. Prometheus fires infrastructure alerts. Runbooks exist for all critical scenarios.

## Build & Deploy

```bash
# Build services (requires Docker)
docker build -t bookstore/ecom-service:latest ./ecom-service
docker build -t bookstore/inventory-service:latest ./inventory-service
docker build --build-arg VITE_KEYCLOAK_AUTHORITY=https://idp.keycloak.net:30000/realms/bookstore \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
  --build-arg VITE_REDIRECT_URI=https://localhost:30000/callback \
  -t bookstore/ui-service:latest ./ui

# Load + deploy
kind load docker-image bookstore/ecom-service:latest --name bookstore
kind load docker-image bookstore/inventory-service:latest --name bookstore
kind load docker-image bookstore/ui-service:latest --name bookstore

# Apply manifests
bash scripts/generate-secrets.sh
kubectl apply -f infra/namespaces.yaml
kubectl apply -f infra/kgateway/gateway.yaml
kubectl apply -f infra/kubernetes/rbac/
kubectl apply -f infra/kubernetes/hpa/hpa.yaml
kubectl apply -f infra/redis/redis.yaml
kubectl apply -f infra/flink/flink-cluster.yaml
kubectl apply -f infra/observability/otel-collector.yaml
kubectl apply -f infra/observability/alertmanager/alertmanager.yaml
kubectl apply -f infra/observability/prometheus/prometheus.yaml

# Restart services
kubectl rollout restart deploy/ecom-service -n ecom
kubectl rollout restart deploy/inventory-service -n inventory
kubectl rollout restart deploy/ui-service -n ecom

# Verify
bash scripts/smoke-test.sh
bash scripts/verify-backup.sh
cd e2e && npm run test
```

---

## Key Architecture Decisions

1. **Transactional outbox over fire-and-forget**: Events written to `outbox_events` table in same DB transaction as order. `OutboxPublisher` polls every 1s and sends to Kafka. Guarantees at-least-once delivery even during Kafka outages.

2. **MinIO over cloud S3**: Local kind cluster can't use AWS/GCS. MinIO provides S3-compatible API in-cluster. CNPG barman backup/restore works identically.

3. **Cart set-semantics**: Changed `addToCart` from increment to set. Retried requests are now idempotent. Frontend already sends desired quantity, not delta.

4. **DLQ persistence**: Moved from in-memory `deque(maxlen=100)` to PostgreSQL table. Messages survive pod restarts. Admin API updated to async DB queries.
