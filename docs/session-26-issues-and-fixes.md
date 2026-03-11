# Session 26 — Issues & Fixes: Side-by-Side Comparison

## Context
During Session 26 (Reliability & Resiliency Grade A), we upgraded the architecture scorecard from A- to A across Reliability and Resiliency dimensions. This document catalogs every issue discovered and the corresponding fix.

---

## Issues & Fixes

| # | Issue | Before (Problem) | After (Fix) | Files Changed |
|---|-------|-------------------|-------------|---------------|
| **A1** | **Prometheus data lost on pod restart** | `emptyDir: {}` — all TSDB metrics wiped when pod restarts | PersistentVolumeClaim (`prometheus-pvc`, 2Gi) backed by host `data/prometheus/` dir + 15-day retention | `infra/observability/prometheus/prometheus.yaml`, `infra/storage/persistent-volumes.yaml` |
| **A1b** | **Prometheus PV permission denied** | Prometheus runs as UID 65534 (nobody); hostPath dir owned by root inside kind node | Added `initContainers` with `runAsUser: 0` that runs `chown -R 65534:65534 /prometheus` before main container starts | `infra/observability/prometheus/prometheus.yaml` |
| **A1c** | **Prometheus data dir missing on fresh bootstrap** | `cluster-up.sh` and `up.sh` did not create `data/prometheus/` directory | Added `prometheus` to `mkdir -p` list in both `cluster-up.sh` (line 38) and `up.sh` `bootstrap_fresh()` (line 63) | `scripts/cluster-up.sh`, `scripts/up.sh` |
| **A2** | **No explicit rolling update strategy** | K8s default strategy (25% maxUnavailable) — could terminate pods before replacements are ready | Explicit `strategy: {type: RollingUpdate, rollingUpdate: {maxSurge: 1, maxUnavailable: 0}}` — new pod must be Ready before old is terminated | `ecom-service/k8s/ecom-service.yaml`, `inventory-service/k8s/inventory-service.yaml`, `ui/k8s/ui-service.yaml` |
| **A3** | **Superset had no liveness probe** | Only readinessProbe; container could hang indefinitely without restart | Added `livenessProbe: httpGet /health:8088` (initialDelay 60s, period 30s, failureThreshold 5) | `infra/superset/superset.yaml` |
| **A4a** | **HikariCP connection pool defaults** | No `max-lifetime`, `idle-timeout`, or `leak-detection-threshold` — stale connections could accumulate | Added `max-lifetime: 1800000` (30min), `idle-timeout: 600000` (10min), `leak-detection-threshold: 30000` (30s) | `ecom-service/src/main/resources/application.yml` |
| **A4b** | **SQLAlchemy no connection health check** | No `pool_pre_ping` — stale DB connections would fail on first use after idle period | Added `pool_pre_ping=True` (validates connections before use) and `pool_recycle=1800` (recycle after 30min) | `inventory-service/app/database.py` |
| **B1** | **No HTTPRoute timeouts** | Gateway routes had no explicit timeout — requests could hang indefinitely | Added `timeouts: {request: Ns, backendRequest: Ms}` on all 4 routes: ecom (30s/25s), inventory (15s/10s), keycloak (30s/25s), ui (10s/5s) | `infra/kgateway/routes/ecom-route.yaml`, `inven-route.yaml`, `keycloak-route.yaml`, `ui-route.yaml` |
| **B2** | **No topology spread constraints** | All replicas could schedule on same node — single node failure takes down service | Added `topologySpreadConstraints` with `ScheduleAnyway` policy across `kubernetes.io/hostname` on all 3 app deployments | `ecom-service/k8s/ecom-service.yaml`, `inventory-service/k8s/inventory-service.yaml`, `ui/k8s/ui-service.yaml` |
| **B3** | **No explicit terminationGracePeriodSeconds** | K8s default 30s but undocumented — unclear if aligned with preStop(5s) + shutdown(20s) | Explicit `terminationGracePeriodSeconds: 30` on all 3 app deployments, documenting the budget: preStop(5s) + graceful shutdown(20s) = 25s < 30s | Same 3 deployment YAMLs |
| **C1** | **No navigation in docs/index.html** | Visitors had no way to jump between sections or find the Architecture Deep Dive | Added sticky top nav with 7 section links + Deep Dive cross-link; smooth scroll; section anchor IDs on all h2 elements | `docs/index.html` |
| **C2** | **No documentation discovery** | Only a CTA banner linking to one page | Replaced CTA with Documentation section containing 3 card links (Deep Dive, GitHub, Architecture Gist) | `docs/index.html` |
| **C3** | **Scorecard showed A- for Reliability/Resiliency** | CSS class `b` with 85% fill bar and "A-" text | Changed to class `a` with 95% fill bar and "A" text | `docs/architecture.html` |
| **C4** | **CSS vendor prefix warning** | Only `-webkit-background-clip: text` without standard property | Added `background-clip: text` alongside the webkit prefix | `docs/index.html` |

---

## Recovery Issues During Deployment

| # | Issue | Root Cause | Fix Applied |
|---|-------|-----------|-------------|
| **R1** | Keycloak returning HTTP 500 after cluster recovery | `keycloak-db` PostgreSQL had corrupted WAL checkpoint (`PANIC: could not locate a valid checkpoint record`) from unclean Docker restart | Scaled down keycloak + keycloak-db, cleared `data/keycloak-db/`, scaled back up, re-imported realm via `keycloak-import.sh` |
| **R2** | Debezium Server crash loop (`Producer is closed forcefully`) | After Docker restart, Kafka offsets lost; Debezium re-snapshots 28 orders + 28 order_items + 10 books; Kafka producer times out during high-volume initial snapshot | Restarted Kafka first (clear stale state), then restarted Debezium; second attempt completes snapshot successfully because Kafka is freshly ready |
| **R3** | Debezium NodePort returning empty reply (curl exit 52) | ztunnel HBONE interception after Docker restart; even with PERMISSIVE PeerAuthentication on port 8080, ztunnel needs pod re-registration | Restart ztunnel DaemonSet first, then restart Debezium pods so they register fresh HBONE listeners |

---

## Verification Results

### Smoke Test: 33/33 Passed
All pod health, HTTPS endpoints, Kafka lag, Debezium health, admin access control, TLS certificate, and HTTP→HTTPS redirect checks pass.

### Full-Stack Test: 66/66 Passed
Pre-flight, bootstrap validation, cert dashboard, 21 pod checks, 15 route checks, 8 API tests, 13 CDC pipeline checks (Debezium + Flink + analytics DB tables + Kafka topics), and smoke test all pass.

### E2E Tests: 275 Passed, 1 Flaky, 1 Skipped
The flaky test (`cart.spec.ts:12 — authenticated user can add a book to cart`) is a known cart cold-start issue that passes on retry.
