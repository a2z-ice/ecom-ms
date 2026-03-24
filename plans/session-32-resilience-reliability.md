# Session 32 — Resilience & Reliability

## Goal
Add graceful shutdown, retention policies, and missing HPA metric.

## Deliverables

| # | Item | Files |
|---|------|-------|
| 1 | Kafka preStop hook | `infra/kafka/kafka.yaml` |
| 2 | Redis preStop hook | `infra/redis/redis.yaml` |
| 3 | Flink JM preStop hook | `infra/flink/flink-cluster.yaml` |
| 4 | Flink TM preStop hook | `infra/flink/flink-cluster.yaml` |
| 5 | Debezium ecom preStop hook | `infra/debezium/debezium-server-ecom.yaml` |
| 6 | Debezium inventory preStop hook | `infra/debezium/debezium-server-inventory.yaml` |
| 7 | Inventory HPA memory metric (80%) | `infra/kubernetes/hpa/hpa.yaml` |
| 8 | Tempo retention 72h | `infra/observability/tempo/tempo.yaml` |
| 9 | Loki retention 72h + compactor | `infra/observability/loki/loki.yaml` |
| 10 | E2E tests | `e2e/resilience-hardening.spec.ts` |

## Acceptance Criteria
- All 6 stateful services have preStop hooks
- Inventory HPA has memory metric at 80%
- Tempo/Loki retention 72h
- All existing tests pass

## Status: COMPLETE
