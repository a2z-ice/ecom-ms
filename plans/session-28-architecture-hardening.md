# Session 28 — Architecture Hardening & Battle Testing

## Goal

Comprehensive architecture review across 8 dimensions (Security, Observability, Data Isolation, 15-Factor, TLS/Encryption, Reliability, Resiliency, Test Coverage) followed by implementation of all identified improvements except GitHub CI and AlertManager webhook receivers (deferred to future session).

## Review Dimensions & Findings

| Dimension | Grade Before | Grade After | Key Improvements |
|---|---|---|---|
| Security | A- | A | Keycloak/Superset container hardening, image version pinning |
| Observability | A- | A | Trace IDs in logs, probabilistic sampling, Loki/Tempo persistence |
| Data Isolation | A | A | Already excellent — no cross-DB access, per-service schemas |
| 15-Factor | A | A | Already compliant — all config via env vars |
| TLS / Encryption | A | A | Already complete — cert-manager, mTLS, HTTPS everywhere |
| Reliability | B+ | A- | PDBs for all critical services, replica scaling, Prometheus probes |
| Resiliency | B+ | A- | Circuit breaker rate limiting, DLQ consumer, CNPG backup config |
| Test Coverage | A | A | k6 load tests added |

## Deliverables

| # | Item | Category | Status |
|---|---|---|---|
| S1 | Keycloak container securityContext hardening | Security | Done |
| S2 | Superset container securityContext hardening + image pin | Security | Done |
| S3 | Image version pinning (Kafka, Grafana, AlertManager, Schema Registry, PgAdmin, Redis) | Security | Done |
| O1 | Trace IDs in inventory-service logs (LoggingInstrumentor + JsonFormatter) | Observability | Done |
| O2 | Loki/Tempo persistent storage (emptyDir → PVC) | Observability | Done |
| O5 | Probabilistic trace sampling (25%) in OTel Collector | Observability | Done |
| R1 | Scale ecom-service, inventory-service, ui-service to 2 replicas | Reliability | Done |
| R3 | PDBs for ui-service, keycloak, kafka, redis, flink-jobmanager | Reliability | Done |
| R4 | CNPG backup configuration placeholders (all 4 clusters) | Reliability | Done |
| R5 | Prometheus readiness + liveness probes | Reliability | Done |
| E2 | Rate limiter circuit breaker (graceful degradation) | Resiliency | Done |
| E5 | DLQ consumer + admin visibility endpoints | Resiliency | Done |
| C1 | k6 load test scripts (books, stock, checkout) | Test Coverage | Done |

## Deferred Items (Future Session)

- [ ] GitHub CI pipeline (build + test + lint for all 3 services)
- [ ] AlertManager webhook receivers (Slack, email, PagerDuty)

## Build & Deploy

```bash
# Build all 3 service images
docker build -t bookstore/ecom-service:latest ./ecom-service
docker build -t bookstore/inventory-service:latest ./inventory-service
docker build --build-arg VITE_KEYCLOAK_AUTHORITY=https://idp.keycloak.net:30000/realms/bookstore \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
  --build-arg VITE_REDIRECT_URI=https://localhost:30000/callback \
  -t bookstore/ui-service:latest ./ui

# Load images + full deploy
kind load docker-image bookstore/ecom-service:latest bookstore/inventory-service:latest bookstore/ui-service:latest --name bookstore

# Apply all infra changes
kubectl apply -f infra/storage/persistent-volumes.yaml
kubectl apply -f infra/kubernetes/pdb/pdb.yaml
kubectl apply -f infra/observability/prometheus/prometheus.yaml
kubectl apply -f infra/observability/loki/loki.yaml
kubectl apply -f infra/observability/tempo/tempo.yaml
kubectl apply -f infra/observability/otel-collector.yaml
kubectl apply -f infra/keycloak/keycloak.yaml
kubectl apply -f infra/superset/superset.yaml
kubectl apply -f infra/kafka/kafka.yaml
kubectl apply -f infra/kafka/kafka-topics-init.yaml
kubectl apply -f infra/observability/grafana/grafana.yaml
kubectl apply -f infra/observability/alertmanager/alertmanager.yaml
kubectl apply -f infra/schema-registry/schema-registry.yaml
kubectl apply -f infra/pgadmin/pgadmin.yaml
kubectl apply -f infra/redis/redis.yaml
kubectl apply -f infra/cnpg/ecom-db-cluster.yaml
kubectl apply -f infra/cnpg/inventory-db-cluster.yaml
kubectl apply -f infra/cnpg/analytics-db-cluster.yaml
kubectl apply -f infra/cnpg/keycloak-db-cluster.yaml

# Restart deployments to pick up new images
kubectl rollout restart deployment ecom-service -n ecom
kubectl rollout restart deployment inventory-service -n inventory
kubectl rollout restart deployment ui-service -n ecom

# Run E2E tests
cd e2e && npm run test
```

## Acceptance Criteria

- [ ] All pods running with correct replica counts (ecom: 2, inventory: 2, ui: 2)
- [ ] 7 PDBs created and protecting critical services
- [ ] Prometheus has readiness and liveness probes
- [ ] Keycloak and Superset containers have hardened securityContext
- [ ] All images pinned to specific versions (no `:latest` on infra components)
- [ ] Trace IDs (trace.id, span.id) present in inventory-service JSON logs
- [ ] OTel Collector sampling at 25% for traces
- [ ] Loki and Tempo using PVCs (data survives pod restarts)
- [ ] Rate limiter circuit breaker compiles and functions
- [ ] DLQ consumer running in inventory-service
- [ ] DLQ admin endpoints accessible (`GET /admin/stock/dlq`, `POST /admin/stock/dlq/{id}/retry`)
- [ ] k6 load test scripts present and documented
- [ ] CNPG clusters have commented-out backup config
- [ ] E2E tests: 130/130 passing

## Status

**In Progress** — Implementations complete, battle testing underway.
