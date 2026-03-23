# CDC Pipeline Production-Grade Hardening (Session 29)

## Overview

This document describes the production-grade improvements made to the Change Data Capture (CDC) pipeline in Session 29. The pipeline flows from PostgreSQL source databases through Debezium Server, Kafka, Flink SQL, into the analytics database, and finally into Superset dashboards.

```
PostgreSQL (CNPG HA) --> Debezium Server 3.4 --> Kafka KRaft --> Flink SQL 1.20 --> Analytics DB --> Superset
```

The existing pipeline had a solid foundation but several critical gaps that would cause **data loss**, **silent corruption**, or **operational blindness** at production scale. Session 29 addresses these gaps across resilience, observability, and availability.

---

## What Changed: Before vs After

### 1. Flink Restart Strategy & Job Submission Resilience

| Aspect | Before | After |
|--------|--------|-------|
| SQL Runner `backoffLimit` | `0` (no retries — if SQL Gateway is temporarily unavailable, pipeline never starts) | `3` (retries up to 3 times with exponential backoff) |
| Restart strategy | None (a transient JDBC sink failure kills streaming jobs permanently) | `fixed-delay`: 10 attempts, 30s delay between retries |
| Tolerable failed checkpoints | `0` (any checkpoint failure kills the job) | `3` (tolerates up to 3 consecutive failures before aborting) |

**Why this matters**: The Flink SQL Runner is a Kubernetes Job that submits 4 streaming INSERT statements to the Flink cluster via the SQL Gateway. If the SQL Gateway isn't ready when the Job runs (common during cold starts), `backoffLimit: 0` means the Job fails permanently and no CDC data ever reaches analytics-db. The restart strategy prevents transient JDBC connection hiccups from killing long-running streaming jobs.

**Files changed**:
- `infra/flink/flink-sql-runner.yaml` — `backoffLimit: 0` to `3`
- `infra/flink/flink-cluster.yaml` — Added `restart-strategy.*` and `tolerable-failed-checkpoints` to both JobManager and TaskManager `FLINK_PROPERTIES`

### 2. Kafka Producer Idempotency (ecom-service)

| Aspect | Before | After |
|--------|--------|-------|
| `enable.idempotence` | Not set (default: `false`) | `true` |
| `max.in.flight.requests.per.connection` | Not set (default: `5`) | Explicitly set to `5` |

**Why this matters**: The ecom-service publishes `order.created` events to Kafka on checkout. With `acks=all` and `retries=3` but **no idempotent producer**, a retry after a network timeout could produce **duplicate messages**. Kafka's idempotent producer assigns a sequence number to each message, allowing the broker to deduplicate retries transparently. This guarantees exactly-once delivery from producer to broker.

**Files changed**:
- `ecom-service/src/main/java/com/bookstore/ecom/config/KafkaConfig.java` — Added `ENABLE_IDEMPOTENCE_CONFIG` and `MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION`

### 3. Kafka Consumer Lag Monitoring (kafka-exporter)

| Aspect | Before | After |
|--------|--------|-------|
| Consumer lag visibility | None — no way to know if Flink is falling behind | kafka-exporter (`danielqsj/kafka-exporter:v1.9.0`) deployed in infra namespace |
| Prometheus metrics | No Kafka broker metrics in Prometheus | `kafka_consumergroup_lag`, `kafka_topic_partition_current_offset`, and more |
| NetworkPolicy | N/A | Ingress from observability (Prometheus scraping on port 9308), egress to Kafka (port 9092) |

**Why this matters**: Without consumer lag monitoring, there's no way to detect if the Flink analytics pipeline is falling behind on message consumption. A growing lag means analytics dashboards show stale data, and eventually Kafka may delete unconsumed messages (depending on retention settings). The kafka-exporter provides real-time lag metrics per consumer group and topic partition.

**New files**:
- `infra/kafka/kafka-exporter.yaml` — Deployment + ClusterIP Service
- `infra/kubernetes/network-policies/infra-netpol.yaml` — kafka-exporter ingress/egress rules

**Other changes**:
- `scripts/infra-up.sh` — Added kafka-exporter deployment step
- `infra/observability/prometheus/prometheus.yaml` — Added `kafka-exporter` scrape config

### 4. Flink Prometheus Metrics Reporter

| Aspect | Before | After |
|--------|--------|-------|
| Flink metrics in Prometheus | None — Flink dashboard (:32200) is visual only | `flink-metrics-prometheus` reporter on port 9249 for both JobManager and TaskManager |
| Metrics JAR | Not included in Flink image | `flink-metrics-prometheus-1.20.0.jar` baked into custom Flink Docker image |
| Service port | N/A | Port 9249 added to `flink-jobmanager` ClusterIP Service |

**Why this matters**: The Flink Web Dashboard is useful for ad-hoc debugging but provides no historical data, no alerting, and no integration with the existing Prometheus/Grafana stack. With the Prometheus reporter, all Flink internal metrics (checkpoint durations, record throughput, buffer pool usage, GC times) flow into Prometheus for dashboarding and alerting.

**Files changed**:
- `analytics/flink/Dockerfile` — Added `flink-metrics-prometheus-1.20.0.jar` download in the builder stage
- `infra/flink/flink-cluster.yaml` — Added `metrics.reporter.prom.*` to FLINK_PROPERTIES, port 9249 to containers and service
- `infra/observability/prometheus/prometheus.yaml` — Added `flink-jobmanager` and `flink-taskmanager` scrape configs
- `infra/kubernetes/network-policies/analytics-netpol.yaml` — Allow Prometheus (observability namespace) to scrape Flink metrics on port 9249

### 5. Debezium Observability

| Aspect | Before | After |
|--------|--------|-------|
| Health monitoring | `/q/health` endpoint only (UP/DOWN) | Same — Debezium Server 3.4 lacks Quarkus Micrometer extension for `/q/metrics` |
| Consumer lag tracking | None | Tracked indirectly via kafka-exporter (consumer group lag for Debezium offset topics) |
| Alert rules | None | `DebeziumPodNotReady` alert rule in Prometheus (uses `kube_pod_status_ready` metric) |

**Discovery**: Debezium Server 3.4 bundles OpenTelemetry Prometheus exporter JARs but does **not** include the Quarkus Micrometer extension. The `quarkus.micrometer.export.prometheus.enabled=true` config is silently ignored — `/q/metrics` returns 404. Full Prometheus metrics from Debezium would require a JMX exporter sidecar (deferred to a future session).

**Files changed**:
- `infra/debezium/debezium-server-ecom.yaml` — Documented limitation in ConfigMap comments
- `infra/debezium/debezium-server-inventory.yaml` — Same

### 6. CDC End-to-End Latency Measurement

| Aspect | Before | After |
|--------|--------|-------|
| Latency visibility | `synced_at DEFAULT NOW()` column exists but no comparison view | `vw_cdc_latency` view: calculates `latency_seconds = synced_at - created_at` |

**Why this matters**: The `synced_at` column (set by PostgreSQL on INSERT via Flink JDBC sink) and `created_at` column (from the source order) together measure how long it takes for a database change to flow through the entire CDC pipeline. The view makes this latency queryable for P50/P95/P99 dashboarding in Grafana or Superset.

**Files changed**:
- `analytics/schema/analytics-ddl.sql` — Added `vw_cdc_latency` view

### 7. CDC Data Quality Tables

| Aspect | Before | After |
|--------|--------|-------|
| Parse error tracking | `json.ignore-parse-errors=true` silently drops malformed messages | `cdc_parse_errors` table ready for future DLQ capture |
| Drift detection | No mechanism to detect source-to-analytics drift | `cdc_reconciliation_log` table ready for future reconciliation CronJob |

**Why this matters**: The Flink SQL sources use `json.ignore-parse-errors=true` which silently drops any message that doesn't match the expected schema. This is necessary to skip tombstone/control messages, but it also hides legitimate data corruption. The tables provide the schema for a future dead-letter-queue capture job and a row-count reconciliation CronJob.

**Files changed**:
- `analytics/schema/analytics-ddl.sql` — Added `cdc_parse_errors` and `cdc_reconciliation_log` tables

### 8. CDC-Specific Prometheus Alert Rules

| Aspect | Before | After |
|--------|--------|-------|
| CDC alerting | None — only HTTP/pod alerts existed | 4 CDC-specific alert rules |

**New alert rules**:

| Alert | Expression | For | Severity |
|-------|-----------|-----|----------|
| `FlinkJobNotRunning` | `up{job=~"flink-jobmanager\|flink-taskmanager"} == 0` | 2m | critical |
| `FlinkCheckpointsFailing` | `increase(flink_jobmanager_job_numberOfFailedCheckpoints[10m]) > 3` | 5m | warning |
| `KafkaConsumerLagHigh` | `kafka_consumergroup_lag{group="flink-analytics-consumer"} > 1000` | 5m | warning |
| `DebeziumPodNotReady` | `kube_pod_status_ready{namespace="infra",pod=~"debezium-server-.*"} == 0` | 2m | critical |

**Files changed**:
- `infra/observability/prometheus/prometheus.yaml` — Added `cdc_alerts` rule group

### 9. Debezium PodDisruptionBudgets

| Aspect | Before | After |
|--------|--------|-------|
| Debezium eviction protection | None — pods could be evicted during node drain | PDBs with `minAvailable: 1` for both Debezium Server pods |

**Why this matters**: During a Kubernetes node drain (e.g., cluster upgrade), pods without PDBs can be evicted simultaneously. For Debezium Server, this means CDC event capture stops entirely during the drain. The PDB ensures at least one Debezium pod remains available.

**Files changed**:
- `infra/kubernetes/pdb/pdb.yaml` — Added `debezium-server-ecom-pdb` and `debezium-server-inventory-pdb`

### 10. Port Conflict Resolution in Bootstrap

| Aspect | Before | After |
|--------|--------|-------|
| Port conflict handling | `kind create cluster` fails with "port already allocated" if another Docker container uses any of our 11 host ports | `free_required_ports()` function detects conflicting containers, shows them, prompts to stop, and verifies ports are free before cluster creation |

**Why this matters**: Developers often run multiple kind clusters. If another cluster (e.g., `k8s-ai`) binds port 30000, the bookstore bootstrap fails with an opaque Docker error. The new function provides clear feedback and automated resolution.

**Files changed**:
- `scripts/up.sh` — Added `free_required_ports()` function, called before `kind create cluster`
- `scripts/cluster-up.sh` — Same function added for standalone cluster creation

---

## Architecture Diagram (After)

```
                        ┌─────────────────────────────────────────────────────────┐
                        │                    Prometheus                            │
                        │  Scrapes: kafka-exporter, flink-jm, flink-tm, apps      │
                        │  Alerts: FlinkJobNotRunning, KafkaLagHigh, Debezium...  │
                        └─────────┬───────────────┬───────────────┬───────────────┘
                                  │               │               │
                    ┌─────────────▼──┐   ┌────────▼──────┐  ┌────▼──────────────┐
                    │ kafka-exporter │   │ Flink :9249   │  │ kube-state-metrics│
                    │ :9308          │   │ Prom reporter │  │ (pod readiness)   │
                    └─────────┬──────┘   └────────┬──────┘  └───────────────────┘
                              │                   │
    ┌──────────┐    ┌─────────▼──────────────────▼───────────┐    ┌──────────────┐
    │ ecom-db  │───▶│                 Kafka KRaft             │───▶│ Flink SQL    │
    │ (CNPG HA)│    │  (idempotent producers, RF=1)          │    │ (restart:    │
    └──────────┘    │                                         │    │  fixed-delay │
    ┌──────────┐    │  Topics: ecom-connector.public.*        │    │  10 attempts │
    │ inven-db │───▶│          inventory-connector.public.*   │    │  30s delay)  │
    │ (CNPG HA)│    └─────────────────────────────────────────┘    └──────┬───────┘
    └──────────┘                                                          │
         ▲                                                                ▼
    Debezium Server 3.4                                        ┌──────────────────┐
    (2 pods, PDB protected,                                    │  analytics-db    │
     Kafka-backed offsets,                                     │  + vw_cdc_latency│
     health at /q/health)                                      │  + cdc_parse_err │
                                                               │  + cdc_recon_log │
                                                               └──────────────────┘
```

---

## E2E Test Coverage

The `e2e/cdc-hardening.spec.ts` file provides 50 tests across 9 suites:

| Suite | Tests | What It Validates |
|-------|-------|-------------------|
| Flink Restart Strategy & Resilience | 7 | backoffLimit, fixed-delay config, tolerable checkpoints, EXACTLY_ONCE, 4 running jobs |
| Kafka Producer Idempotency | 2 | Pod running, Spring Boot health check (validates config loaded) |
| Kafka Consumer Lag Exporter | 6 | Pod, service, Prometheus metrics, consumer group lag, topic metrics, NetworkPolicy |
| Debezium Health & Observability | 6 | /q/health UP on both instances, /q/health/ready UP, Kafka-backed offset storage |
| Flink Prometheus Reporter | 7 | Config, container ports, service port, live metrics, NetworkPolicy |
| CDC Latency & Data Quality Tables | 6 | vw_cdc_latency view, cdc_parse_errors schema, cdc_reconciliation_log schema |
| CDC Prometheus Alert Rules | 8 | All 4 alert rules exist, all 3 scrape configs present |
| Debezium PDBs | 4 | PDB existence, minAvailable=1, correct pod selector |
| Pipeline End-to-End Health | 6 | Debezium UP, Kafka reachable, 4+ Flink jobs, analytics data, PVC bound |

---

## Files Modified

| File | Change |
|------|--------|
| `analytics/flink/Dockerfile` | Added `flink-metrics-prometheus-1.20.0.jar` |
| `analytics/schema/analytics-ddl.sql` | Added `cdc_parse_errors`, `cdc_reconciliation_log` tables, `vw_cdc_latency` view |
| `ecom-service/.../config/KafkaConfig.java` | Idempotent producer config |
| `infra/debezium/debezium-server-ecom.yaml` | Documented Micrometer limitation |
| `infra/debezium/debezium-server-inventory.yaml` | Same |
| `infra/flink/flink-cluster.yaml` | Restart strategy, Prometheus reporter, port 9249 |
| `infra/flink/flink-sql-runner.yaml` | `backoffLimit: 3` |
| `infra/kafka/kafka-exporter.yaml` | **New** — kafka-exporter Deployment + Service |
| `infra/kubernetes/network-policies/analytics-netpol.yaml` | Flink metrics scraping from Prometheus |
| `infra/kubernetes/network-policies/infra-netpol.yaml` | kafka-exporter ingress/egress |
| `infra/kubernetes/pdb/pdb.yaml` | 2 Debezium PDBs |
| `infra/observability/prometheus/prometheus.yaml` | 3 scrape configs + 4 CDC alert rules |
| `scripts/infra-up.sh` | kafka-exporter deploy step |
| `scripts/up.sh` | `free_required_ports()` function |
| `scripts/cluster-up.sh` | `free_required_ports()` function |
| `e2e/cdc-hardening.spec.ts` | **New** — 50 E2E tests |

---

## Future Work (Deferred)

These items were identified during the review but deferred to future sessions:

| Item | Why Deferred |
|------|-------------|
| Debezium JMX Prometheus exporter sidecar | Requires custom sidecar container; kafka-exporter covers the most critical metric (consumer lag) |
| Kafka multi-broker HA (RF=3) | Resource-intensive; requires StatefulSet migration + 3-node quorum |
| Schema Registry wiring | Already deployed but unused; requires Debezium custom image with Confluent converter JARs |
| Flink JobManager HA (Kubernetes-native) | Requires RBAC for ConfigMap/lease management |
| Source-to-analytics row count reconciliation CronJob | Schema ready (`cdc_reconciliation_log`); CronJob implementation pending |
| Transactional outbox pattern | Significant refactoring of ecom-service checkout flow |
