# Session 29 — CDC Pipeline Production-Grade Hardening

## Goal

Harden the CDC pipeline (PostgreSQL → Debezium → Kafka → Flink → Analytics DB) against data loss, silent corruption, and operational blindness. Covers Flink restart resilience, Kafka producer idempotency, CDC observability (Debezium metrics, Kafka consumer lag, Flink Prometheus reporter), CDC latency measurement, CDC-specific alerts, and Debezium PDBs.

## Deliverables

| # | Item | Plan Ref | Complexity | Status |
|---|---|---|---|---|
| 1 | Flink restart strategy + SQL runner backoffLimit:3 | 1.1 | S | Done |
| 2 | Kafka producer idempotency (ecom-service) | 1.2 | S | Done |
| 3 | Kafka consumer lag exporter (kafka-exporter) | 2.1 | S | Done |
| 4 | Debezium Prometheus metrics (Micrometer) | 2.2 | S | Done |
| 5 | Flink Prometheus reporter | 2.3 | M | Done |
| 6 | CDC end-to-end latency view | 2.4 | S | Done |
| 7 | CDC-specific Prometheus alert rules | 2.5 | S | Done |
| 8 | Debezium PodDisruptionBudgets | 3.3 | S | Done |
| 9 | NetworkPolicy updates for new exporters | — | S | Done |

## Acceptance Criteria

1. `backoffLimit: 3` on flink-sql-runner Job
2. Flink restart strategy: fixed-delay, 10 attempts, 30s delay
3. Kafka producer has `enable.idempotence=true`
4. kafka-exporter pod running, Prometheus scraping consumer lag metrics
5. Debezium `/q/metrics` returns Prometheus metrics
6. Flink JobManager+TaskManager expose metrics on port 9249
7. `vw_cdc_latency` view exists in analytics DDL
8. Prometheus has CDC alert rules (Flink, Kafka lag, Debezium)
9. Debezium PDBs exist (`minAvailable: 1`)
10. All existing E2E tests pass
11. CDC flow works: `bash scripts/verify-cdc.sh`

## Build & Deploy

```bash
# Rebuild Flink image (new Prometheus metrics JAR)
docker build -t bookstore/flink:latest ./analytics/flink
kind load docker-image bookstore/flink:latest --name bookstore

# Rebuild ecom-service (idempotent producer)
docker build -t bookstore/ecom-service:latest ./ecom-service
kind load docker-image bookstore/ecom-service:latest --name bookstore

# Apply infra manifests
kubectl apply -f infra/flink/flink-cluster.yaml
kubectl apply -f infra/flink/flink-sql-runner.yaml
kubectl apply -f infra/debezium/debezium-server-ecom.yaml
kubectl apply -f infra/debezium/debezium-server-inventory.yaml
kubectl apply -f infra/kafka/kafka-exporter.yaml
kubectl apply -f infra/kubernetes/pdb/pdb.yaml
kubectl apply -f infra/kubernetes/network-policies/infra-netpol.yaml
kubectl apply -f infra/kubernetes/network-policies/observability-netpol.yaml
kubectl apply -f infra/observability/prometheus/prometheus.yaml

# Restart affected deployments
kubectl rollout restart deploy/flink-jobmanager -n analytics
kubectl rollout restart deploy/flink-taskmanager -n analytics
kubectl rollout restart deploy/debezium-server-ecom -n infra
kubectl rollout restart deploy/debezium-server-inventory -n infra
kubectl rollout restart deploy/prometheus -n observability
```

## Verification

```bash
# Flink jobs running
curl -s http://localhost:32200/jobs | jq '.jobs[] | select(.status=="RUNNING")'

# Debezium metrics
curl -s http://localhost:32300/q/metrics | head -20
curl -s http://localhost:32301/q/metrics | head -20

# CDC flow
bash scripts/verify-cdc.sh

# Smoke test
bash scripts/smoke-test.sh
```

## Status: Done
