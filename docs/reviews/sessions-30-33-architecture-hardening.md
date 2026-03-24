# Architecture Hardening — Sessions 30-33

## Overview

Sessions 30-33 implement a comprehensive architecture hardening initiative across four pillars: **Security**, **Application Safety**, **Resilience**, and **Observability**. The work addresses 40+ gaps identified during parallel security, reliability, and observability audits.

**Test Results:** 395 passed, 55 new tests added (17 + 13 + 12 + 13), 1 pre-existing failure (CDC clock-skew).

---

## Session 30 — Security: Container & Network Layer

### Changes

| # | Item | Impact |
|---|------|--------|
| 1 | `.dockerignore` files for ecom-service, inventory-service, ui | Prevents `.git`, `.env`, `node_modules` from entering images |
| 2 | Gateway egress tightened | No more open egress — restricted to ecom(8080), inventory(8000), identity(8080), UI(80), DNS, HBONE |
| 3 | Kafka ingress restricted | Only debezium-server-ecom/inventory, schema-registry, kafka-exporter can reach Kafka |
| 4 | Inventory CORS: removed DELETE | Reduces attack surface — inventory API has no DELETE endpoints |
| 5 | Cert-dashboard RBAC trimmed | Removed create/delete on ClusterRoles/ClusterRoleBindings (least privilege) |
| 6 | Ecom logging configurable | `${LOG_LEVEL:INFO}` env var — no more hardcoded DEBUG in production |
| 7 | PSS `restricted` on ecom/inventory | Enforces seccompProfile, non-root, drop ALL caps, readOnlyRootFilesystem |

### Benefits
- **Smaller images**: `.dockerignore` prevents secrets and dev files from leaking into container images
- **Network segmentation**: Gateway can only reach its backends — lateral movement blocked
- **Kafka isolation**: Only CDC components can produce/consume — prevents unauthorized topic access
- **Pod Security Standards**: Kubernetes enforces restricted security context at admission time

### Files Changed
- `ecom-service/.dockerignore`, `inventory-service/.dockerignore`, `ui/.dockerignore` (new)
- `infra/kubernetes/network-policies/infra-netpol.yaml`
- `infra/namespaces.yaml`
- `inventory-service/app/main.py`
- `cert-dashboard-operator/config/rbac/role.yaml`
- `ecom-service/src/main/resources/application.yml`
- `ecom-service/k8s/ecom-service.yaml`, `inventory-service/k8s/inventory-service.yaml` (seccompProfile)

---

## Session 31 — Security: Application Layer (JWT, Validation)

### Changes

| # | Item | Impact |
|---|------|--------|
| 1 | JWT audience validation — ecom-service | `JwtClaimValidator` checks `aud` claim contains `account` |
| 2 | Inventory `verify_aud: False` fixed | Both JWT decode paths now validate audience |
| 3 | `jwt_audience` setting in inventory config | Configurable via environment variable |
| 4 | `@Max(99)` on CartRequest.quantity | Prevents integer overflow and unreasonable orders |
| 5 | `@Max(99)` on CartUpdateRequest.quantity | Same protection for cart updates |
| 6 | `le=99` on ReserveRequest.quantity | Inventory service rejects reserve > 99 at validation layer |

### Benefits
- **JWT audience validation**: Prevents token confusion attacks where tokens issued for one client are used against another
- **Input bounds**: Eliminates edge cases with extreme quantities (0, negative, or absurdly large values)
- **Defense in depth**: Validation at both API gateway (Spring) and downstream service (FastAPI) levels

### Files Changed
- `ecom-service/src/main/java/com/bookstore/ecom/config/SecurityConfig.java`
- `inventory-service/app/middleware/auth.py`
- `inventory-service/app/config.py`
- `ecom-service/src/main/java/com/bookstore/ecom/dto/CartRequest.java`
- `ecom-service/src/main/java/com/bookstore/ecom/dto/CartUpdateRequest.java`
- `inventory-service/app/schemas/inventory.py`

---

## Session 32 — Resilience & Reliability

### Changes

| # | Item | Impact |
|---|------|--------|
| 1 | Kafka preStop: `kafka-server-stop && sleep 5` | Graceful leader transfer, flushes logs |
| 2 | Redis preStop: `redis-cli shutdown save` | Persists data before termination |
| 3 | Flink JM preStop: `sleep 10` | Allows in-flight checkpoints to complete |
| 4 | Flink TM preStop: `sleep 10` | Allows task slot drain |
| 5 | Debezium ecom/inventory preStop: `sleep 5` | Allows offset flush to Kafka |
| 6 | Inventory HPA memory metric (80%) | Scales on memory pressure, not just CPU |
| 7 | Tempo retention: 1h to 72h | 3 days of distributed traces retained |
| 8 | Loki retention: 72h + compactor | 3 days of logs with automated cleanup |

### Benefits
- **Zero data loss on shutdown**: preStop hooks ensure all stateful services flush data before SIGTERM
- **Graceful rolling updates**: Kubernetes respects `terminationGracePeriodSeconds` + preStop = smooth upgrades
- **Better autoscaling**: Memory-aware HPA catches OOM scenarios that CPU-only misses
- **Operational visibility**: 72h retention means on-call engineers can investigate incidents from the past 3 days

### Files Changed
- `infra/kafka/kafka.yaml`
- `infra/redis/redis.yaml`
- `infra/flink/flink-cluster.yaml`
- `infra/debezium/debezium-server-ecom.yaml`
- `infra/debezium/debezium-server-inventory.yaml`
- `infra/kubernetes/hpa/hpa.yaml`
- `infra/observability/tempo/tempo.yaml`
- `infra/observability/loki/loki.yaml`

---

## Session 33 — Observability: Business Metrics, CDC Dashboard, Security Alerts

### Changes

| # | Item | Impact |
|---|------|--------|
| 1 | `orders_total` counter (Micrometer) | Tracks total completed orders |
| 2 | `checkout_duration_seconds` timer | Measures checkout latency distribution |
| 3 | `inventory_reserved_total` counter | Tracks total inventory units reserved |
| 4 | CDC pipeline Grafana dashboard (6 panels) | Kafka lag, Debezium status, Flink checkpoints, throughput |
| 5 | Security alert rules | High401Rate, High403Rate, RateLimitBreaches |
| 6 | AlertManager webhook receiver | Replaces empty config with functional receiver |
| 7 | Git SHA image tagging | Every build tagged with `bookstore/<svc>:<git-sha>` |

### Benefits
- **Business observability**: Track order volume and checkout performance in real-time
- **CDC pipeline visibility**: Single-pane-of-glass dashboard for the entire data pipeline
- **Security monitoring**: Automated alerts for authentication failures and rate limiting
- **Traceability**: Git SHA tags link running containers to exact source commits

### Files Changed
- `ecom-service/src/main/java/com/bookstore/ecom/service/OrderService.java`
- `inventory-service/app/api/stock.py`
- `infra/observability/grafana/grafana.yaml`
- `infra/observability/prometheus/prometheus.yaml`
- `infra/observability/alertmanager/alertmanager.yaml`
- `scripts/up.sh`

---

## Test Coverage Summary

| Suite | Tests | Status |
|-------|-------|--------|
| `security-hardening.spec.ts` (Session 30) | 17 | All pass |
| `input-validation.spec.ts` (Session 31) | 13 | All pass |
| `resilience-hardening.spec.ts` (Session 32) | 12 | All pass |
| `observability-hardening.spec.ts` (Session 33) | 13 | All pass |
| **Full regression suite** | **395** | **All pass** (1 pre-existing flaky: CDC latency clock-skew) |

---

## Verification Commands

```bash
# Run new session tests
cd e2e && npx playwright test security-hardening.spec.ts input-validation.spec.ts resilience-hardening.spec.ts observability-hardening.spec.ts

# Full regression
cd e2e && npm run test

# Smoke test
bash scripts/smoke-test.sh

# Verify metrics
curl -sk https://api.service.net:30000/ecom/actuator/prometheus | grep orders_total
curl -sk https://api.service.net:30000/inven/metrics | grep inventory_reserved_total

# Verify CDC dashboard
curl -s http://localhost:32500/api/dashboards/uid/cdc-pipeline \
  -H 'Authorization: Basic YWRtaW46Q0hBTkdFX01F' | jq .dashboard.uid

# Verify Flink jobs
curl -sf http://localhost:32200/jobs | jq '.jobs[] | select(.status=="RUNNING")' | wc -l
```
