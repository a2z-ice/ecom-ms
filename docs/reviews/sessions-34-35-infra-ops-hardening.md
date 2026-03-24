# Sessions 34-35: Infrastructure & Operational Excellence

## Overview

Sessions 34-35 focused on infrastructure production-readiness, application resilience, and operational excellence for the BookStore microservices platform.

## Session 34 — Infrastructure & Application Hardening

### 34.1 Kafka Production Configs
- Added `compression.type=lz4` for reduced disk/network I/O
- Explicit `log.retention.hours=168` (7 days)
- `delete.retention.ms=86400000` (24h tombstone retention)
- `min.insync.replicas=1` (documents single-broker intent)
- `unclean.leader.election.enable=false` (prevents data loss)
- `num.partitions=3` (explicit default for auto-created topics)

### 34.2 Kafka Liveness Probe
- Replaced TCP socket probe with exec probe using `kafka-broker-api-versions`
- More reliable — validates actual broker API availability, not just port binding
- Readiness probe remains TCP (DNS chicken-and-egg)

### 34.3 Redis Production Configs
- `maxmemory 200mb` — prevents OOMKill (container limit 256Mi)
- `maxmemory-policy allkeys-lru` — LRU eviction for cache/session store
- `tcp-backlog 511` — matches Linux default
- `timeout 300` — closes idle connections after 5 min
- `tcp-keepalive 60` — detects dead connections

### 34.4 Spring Redis Connection Pool
- Added Lettuce connection pooling (max-active: 8, max-idle: 4, min-idle: 1)
- Added `commons-pool2` dependency (required for Lettuce pooling)
- Connection and command timeouts (3s connect, 5s command)

### 34.5 ResourceQuota & LimitRange
- **ecom namespace**: 2 CPU / 4Gi requests, 4 CPU / 8Gi limits, 10 pods max
- **inventory namespace**: 1500m CPU / 3Gi requests, 3 CPU / 6Gi limits, 10 pods max
- LimitRange defaults: 500m/512Mi limits, 100m/128Mi requests per container
- Applied via `infra-up.sh`

### 34.6 Kafka Consumer Commit Safety
- Wrapped `consumer.commit()` in try/except in main consumer
- Reprocessing is safe: `_deduct_stock` uses `SELECT ... FOR UPDATE` + quantity check
- Error logged with orderId for debugging

### 34.7 DLQ Consumer Manual Commit
- Changed from `enable_auto_commit=True` to `False`
- Added explicit `consumer.commit()` after processing, wrapped in try/except
- Prevents message loss on consumer crash between auto-commit intervals

### 34.8 Checkout Idempotency Key
- New `idempotency_key` column (VARCHAR(64), unique) on `orders` table
- Liquibase migration `006-add-idempotency-key.yaml`
- `Idempotency-Key` request header (optional, backward compatible)
- If key exists → return existing order (HTTP 200, no side effects)
- If key absent → normal checkout flow

### 34.9 Swagger Disabled in Production
- `SWAGGER_ENABLED=false` env var in Kubernetes deployment
- SecurityConfig conditionally permits Swagger paths only when enabled
- springdoc `api-docs.enabled` and `swagger-ui.enabled` driven by same env var

## Session 35 — Operational Excellence & Documentation

### 35.1 Backup Script
- `scripts/backup.sh` creates timestamped backups in `backups/<timestamp>/`
- Dumps all 4 CNPG databases in parallel via `pg_dump`
- Snapshots Kafka consumer group offsets
- Exports Keycloak realm
- Reports file sizes and total backup size

### 35.2 Restore Script
- `scripts/restore.sh <timestamp>` restores from backup
- Confirmation prompt before overwriting (skip with `--yes`)
- Drops and recreates public schema before restore
- Lists available backups if timestamp not found

### 35.3 Developer Documentation
- **CONTRIBUTING.md** — Prerequisites, Quick Start, Project Structure, Development Workflow, Code Conventions, Testing Requirements, Debugging Tips, Session Planning Convention
- **docs/guides/performance-baseline.md** — Measurement methodology, k6 test templates, resource baselines, known bottlenecks, capacity planning
- **docs/guides/api-error-reference.md** — All HTTP error codes for both services, Idempotency-Key documentation, response format examples

## Files Changed

### Session 34
| File | Change |
|------|--------|
| `infra/kafka/kafka.yaml` | Production configs + exec liveness probe |
| `infra/redis/redis.yaml` | maxmemory, eviction, keepalive |
| `ecom-service/src/main/resources/application.yml` | Lettuce pool config |
| `ecom-service/pom.xml` | commons-pool2 dependency |
| `infra/kubernetes/resource-limits/*.yaml` | New: ResourceQuota + LimitRange |
| `scripts/infra-up.sh` | Apply resource limits step |
| `inventory-service/app/kafka/consumer.py` | Commit error handling |
| `inventory-service/app/kafka/dlq_consumer.py` | Manual commit |
| `ecom-service/.../model/Order.java` | idempotencyKey field |
| `ecom-service/.../repository/OrderRepository.java` | findByIdempotencyKey |
| `ecom-service/.../controller/OrderController.java` | Idempotency-Key header |
| `ecom-service/.../service/OrderService.java` | Idempotency logic |
| `ecom-service/.../config/SecurityConfig.java` | Conditional Swagger |
| `ecom-service/k8s/ecom-service.yaml` | SWAGGER_ENABLED=false |
| `ecom-service/.../db/changelog/006-add-idempotency-key.yaml` | New migration |
| `e2e/infra-app-hardening.spec.ts` | ~15 E2E tests |

### Session 35
| File | Change |
|------|--------|
| `scripts/backup.sh` | New: database backup |
| `scripts/restore.sh` | New: database restore |
| `CONTRIBUTING.md` | New: developer guide |
| `docs/guides/performance-baseline.md` | New: performance docs |
| `docs/guides/api-error-reference.md` | New: API error reference |
| `e2e/ops-excellence.spec.ts` | ~8 E2E tests |

## Test Coverage
- Session 34: ~15 new E2E tests (infra-app-hardening.spec.ts)
- Session 35: ~8 new E2E tests (ops-excellence.spec.ts)
- All existing tests must continue to pass
