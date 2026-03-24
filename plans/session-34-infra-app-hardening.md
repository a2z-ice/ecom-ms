# Session 34 — Infrastructure & Application Hardening

## Goal
Harden Kafka/Redis production configs, add namespace resource limits, fix Kafka consumer commit safety, add checkout idempotency, disable Swagger in production.

## Deliverables

| # | Deliverable | Status |
|---|------------|--------|
| 34.1 | Kafka production configs (compression, retention, min ISR, unclean election, partitions) | Done |
| 34.2 | Kafka liveness probe improvement (exec instead of TCP) | Done |
| 34.3 | Redis production configs (maxmemory, eviction, keepalive) | Done |
| 34.4 | Spring Redis connection pool (Lettuce + commons-pool2) | Done |
| 34.5 | ResourceQuota + LimitRange for ecom/inventory namespaces | Done |
| 34.6 | Kafka consumer commit error handling | Done |
| 34.7 | DLQ consumer manual commit | Done |
| 34.8 | Checkout idempotency key | Done |
| 34.9 | Disable Swagger in production | Done |
| 34.10 | E2E tests (~15 tests) | Done |

## Acceptance Criteria

- [x] `kafka-configs --describe` shows `compression.type=lz4`, `log.retention.hours=168`
- [x] Kafka liveness probe uses exec
- [x] `redis-cli CONFIG GET maxmemory` returns 200mb
- [x] ResourceQuota/LimitRange exist in ecom and inventory namespaces
- [x] `consumer.commit()` wrapped in try/except in consumer.py
- [x] DLQ consumer has `enable_auto_commit=False`
- [x] Checkout with same Idempotency-Key returns same order
- [x] Swagger returns non-200 in cluster
- [x] All existing E2E tests pass + new tests pass

## Build & Deploy

```bash
# Rebuild ecom-service (idempotency + Swagger changes)
docker build -t bookstore/ecom-service:latest ./ecom-service
kind load docker-image bookstore/ecom-service:latest --name bookstore

# Rebuild inventory-service (consumer commit changes)
docker build -t bookstore/inventory-service:latest ./inventory-service
kind load docker-image bookstore/inventory-service:latest --name bookstore

# Apply infra changes
kubectl apply -f infra/kafka/kafka.yaml
kubectl apply -f infra/redis/redis.yaml
kubectl apply -f infra/kubernetes/resource-limits/

# Restart services
kubectl rollout restart deploy/ecom-service -n ecom
kubectl rollout restart deploy/inventory-service -n inventory
kubectl rollout restart deploy/kafka -n infra
kubectl rollout restart deploy/redis -n infra
```

## Status: Complete
