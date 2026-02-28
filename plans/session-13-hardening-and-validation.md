# Session 13 — Final Hardening & Validation

**Goal:** Production-readiness pass: resource constraints, pod resilience, and a full smoke-test run.

## Deliverables

- Resource `requests` and `limits` added to every Deployment:
  - `ecom-service`: `cpu: 250m/500m`, `memory: 512Mi/1Gi`
  - `inventory-service`: `cpu: 100m/300m`, `memory: 128Mi/256Mi`
  - `ui-service`: `cpu: 50m/100m`, `memory: 64Mi/128Mi`
  - Infrastructure services: sized appropriately
- `infra/kubernetes/pdb/pdb.yaml` — `PodDisruptionBudget` for ecom-service and inventory-service (`minAvailable: 1`)
- `infra/kubernetes/hpa/hpa.yaml` — `HorizontalPodAutoscaler` for ecom-service and inventory-service (CPU threshold 70%)
- `scripts/smoke-test.sh` — hits every endpoint, checks HTTP status, verifies Kafka consumer lag is 0
- `scripts/sanity-test.sh` — comprehensive cluster health check (pods + routes + Kafka + Debezium)
- `scripts/stack-up.sh` — one-command full bootstrap (cluster + infra + keycloak + connectors + observability)
- `scripts/cluster-down.sh` — clean teardown; `--purge-data` flag to delete host data volumes
- `docs/runbook.md` — bring-up from scratch, re-register Debezium connectors, reset Keycloak

## Acceptance Criteria

- [x] All pods have resource requests and limits
- [x] `kubectl describe hpa` shows targets and current replicas
- [x] `smoke-test.sh` exits 0 on a fresh cluster boot
- [x] All Playwright E2E tests still pass after hardening changes

## Status: Complete ✓
