# Session 26 — Reliability & Resiliency Grade A + Navigation Enhancement

## Goal

Close remaining reliability/resiliency gaps identified in the architecture deep dive so all 8 scorecard dimensions reach grade A. Add sticky navigation to `docs/index.html`.

## Deliverables

| # | File | Change |
|---|------|--------|
| 1 | `infra/storage/persistent-volumes.yaml` | Add `prometheus-pv` (2Gi, `/data/prometheus`) |
| 2 | `infra/observability/prometheus/prometheus.yaml` | Add PVC `prometheus-pvc`, replace `emptyDir`, add `--storage.tsdb.retention.time=15d` |
| 3 | `scripts/cluster-up.sh` | Add `prometheus` to `mkdir -p` data dir list |
| 4 | `ecom-service/k8s/ecom-service.yaml` | Rolling update strategy + topology spread + terminationGracePeriodSeconds |
| 5 | `inventory-service/k8s/inventory-service.yaml` | Rolling update strategy + topology spread + terminationGracePeriodSeconds |
| 6 | `ui/k8s/ui-service.yaml` | Rolling update strategy + topology spread + terminationGracePeriodSeconds |
| 7 | `infra/superset/superset.yaml` | Add livenessProbe (HTTP /health:8088) |
| 8 | `ecom-service/src/main/resources/application.yml` | HikariCP: max-lifetime, idle-timeout, leak-detection-threshold |
| 9 | `inventory-service/app/database.py` | SQLAlchemy: pool_pre_ping=True, pool_recycle=1800 |
| 10 | `infra/kgateway/routes/ecom-route.yaml` | Timeouts: request 30s, backendRequest 25s |
| 11 | `infra/kgateway/routes/inven-route.yaml` | Timeouts: request 15s, backendRequest 10s (all rules) |
| 12 | `infra/kgateway/routes/keycloak-route.yaml` | Timeouts: request 30s, backendRequest 25s |
| 13 | `infra/kgateway/routes/ui-route.yaml` | Timeouts: request 10s, backendRequest 5s |
| 14 | `docs/index.html` | Sticky nav, section anchors, documentation cards, CSS vendor prefix fix |
| 15 | `docs/architecture.html` | Scorecard Reliability/Resiliency A- → A |
| 16 | `plans/session-26-reliability-resiliency-grade-a.md` | This file |
| 17 | `plans/implementation-plan.md` | Add Session 26 section |

## Docker Rebuilds Required

- **ecom-service** — `application.yml` changes baked into JAR
- **inventory-service** — `database.py` changes baked into image
- UI does NOT need rebuild (only K8s manifest changes)

## Acceptance Criteria

- [x] `kubectl get pvc -n observability` — `prometheus-pvc` Bound
- [x] `kubectl get deploy ecom-service -n ecom -o jsonpath='{.spec.strategy}'` — maxSurge:1, maxUnavailable:0
- [x] `kubectl describe deploy superset -n analytics | grep Liveness` — HTTP /health probe
- [x] `kubectl get httproute ecom-route -n ecom -o yaml | grep -A2 timeouts` — shows 30s
- [x] All 3 app deployments have topologySpreadConstraints
- [x] All 3 app deployments have terminationGracePeriodSeconds: 30
- [x] docs/index.html has sticky nav, section anchors, documentation cards
- [x] docs/architecture.html scorecard shows all 8 dimensions at grade A
- [x] E2E tests pass
- [x] Smoke test passes

## Status: Complete
