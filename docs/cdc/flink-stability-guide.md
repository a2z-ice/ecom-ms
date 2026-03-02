# Flink CDC Stability Guide

This document covers three stability issues found in the Flink 1.20 CDC pipeline, their root causes, the exact fixes applied, and how to verify the pipeline is healthy.

---

## Overview

The CDC pipeline looks like this:

```
PostgreSQL (WAL)
    ↓ Debezium (Change Data Capture)
    ↓ Kafka (4 topics: orders, order_items, books, inventory)
    ↓ Flink SQL (4 streaming INSERT jobs)
    ↓ JDBC sink
    ↓ analytics-db (PostgreSQL)
    ↓ Superset dashboards
```

Flink runs as a **Session Cluster** (JobManager + TaskManager Deployments). SQL is submitted via a one-shot Kubernetes Job (`flink-sql-runner`) that connects to the SQL Gateway sidecar and submits `pipeline.sql`.

---

## Issue 1: `FlinkRuntimeException: Failed to list subscribed topic partitions`

### Symptom

The Flink JobManager logs show a repeating exception every 5 minutes:

```
org.apache.flink.util.FlinkRuntimeException: Failed to list subscribed topic partitions due to
    at KafkaSourceEnumerator.checkPartitionChanges(...)
Caused by: java.lang.RuntimeException: Failed to get metadata for topics [ecom-connector.public.orders].
    at KafkaSubscriberUtils.getTopicMetadata(...)
Caused by: java.util.concurrent.ExecutionException:
    org.apache.kafka.common.errors.UnknownTopicOrPartitionException:
    This server does not host this topic-partition.
```

And shortly before it:

```
INFO NetworkClient - [AdminClient clientId=flink-analytics-consumer-enumerator-admin-client]
    Node -1 disconnected.
```

The job then triggers a global failure and tries to recover:

```
INFO JobMaster - Trying to recover from a global failure.
FlinkException: Global failure triggered by OperatorCoordinator for 'Source: kafka_orders...'
```

### Root Cause

**Flink's `KafkaSourceEnumerator` runs periodic partition discovery every 5 minutes by default.**

When `scan.topic-partition-discovery.interval` is not set in the Kafka source table DDL, the connector falls back to `KafkaSourceOptions.PARTITION_DISCOVERY_INTERVAL_MS` which **defaults to 300000ms (5 minutes)**.

Every 5 minutes, Flink creates a new `AdminClient` and calls `AdminClient.describeTopics()` to check if new partitions were added. This AdminClient reconnects to `bootstrap.servers` from scratch. In a local kind cluster with Confluent Platform KRaft Kafka, this reconnection is unstable — the broker transiently returns `UnknownTopicOrPartitionException` during the metadata exchange.

The sequence:

```
t=0m   → Flink starts, initial partition discovery OK (3 partitions each topic)
t=5m   → Periodic discovery fires → AdminClient reconnects → Node -1 disconnected
         → describeTopics() fails → UnknownTopicOrPartitionException
         → KafkaSourceEnumerator.checkPartitionChanges() throws
         → SourceCoordinatorContext.handleUncaughtExceptionFromAsyncCall()
         → Global failure → job restarts
t=10m  → Same cycle repeats
```

**Why `Node -1`?** In Kafka clients, "Node -1" is a virtual bootstrap node used only during initial connection. If the AdminClient reconnects but fails to complete bootstrap before the request times out, it keeps reporting "Node -1 disconnected" — indicating a transient TCP-level connection failure during metadata exchange.

**Why does this happen in kind?** The kind cluster's NAT networking adds latency and can drop TCP connections during idle periods. The AdminClient's connection is idle for 5 minutes between discovery cycles, and the broker's connection idle timeout (`connections.max.idle.ms` = 9 min by default) may or may not have cleaned it up. The reconnect attempt hits a race condition in Kafka's KRaft metadata propagation.

### Fix

Disable periodic partition discovery entirely. Our CDC topics are pre-created with fixed partitions — we never dynamically add partitions to running topics. The initial partition discovery at startup (which always runs) is sufficient.

**In `analytics/flink/sql/pipeline.sql` and the ConfigMap in `infra/flink/flink-sql-runner.yaml`:**

Add to every Kafka source table's `WITH` clause:

```sql
'scan.topic-partition-discovery.interval' = '0'
```

Setting this to `0` makes `Duration::toMillis()` return `0`, and since the scheduling check is `if (partitionDiscoveryIntervalMs > 0)`, the periodic task is never scheduled.

**Before (broken — fires every 5 min):**

```sql
CREATE TABLE kafka_orders ( ... ) WITH (
  'connector'                    = 'kafka',
  'topic'                        = 'ecom-connector.public.orders',
  'properties.bootstrap.servers' = 'kafka.infra.svc.cluster.local:9092',
  'properties.group.id'          = 'flink-analytics-consumer',
  'format'                       = 'json',
  'json.ignore-parse-errors'     = 'true',
  'scan.startup.mode'            = 'earliest-offset'
  -- no scan.topic-partition-discovery.interval → defaults to 300000ms
);
```

**After (fixed — partition discovery only at startup):**

```sql
CREATE TABLE kafka_orders ( ... ) WITH (
  'connector'                               = 'kafka',
  'topic'                                   = 'ecom-connector.public.orders',
  'properties.bootstrap.servers'            = 'kafka.infra.svc.cluster.local:9092',
  'properties.group.id'                     = 'flink-analytics-consumer',
  'format'                                  = 'json',
  'json.ignore-parse-errors'                = 'true',
  'scan.startup.mode'                       = 'earliest-offset',
  'scan.topic-partition-discovery.interval' = '0'   -- disables periodic AdminClient calls
);
```

### Verification

Check the JobManager log — it must say `without periodic partition discovery`:

```bash
kubectl logs -n analytics deploy/flink-jobmanager --container jobmanager | grep "KafkaSourceEnumerator"
```

Expected output (fixed):
```
INFO KafkaSourceEnumerator - Starting the KafkaSourceEnumerator for consumer group
  flink-analytics-consumer without periodic partition discovery.
INFO KafkaSourceEnumerator - Discovered new partitions: [ecom-connector.public.orders-0,
  ecom-connector.public.orders-1, ecom-connector.public.orders-2]
```

Old broken output:
```
INFO KafkaSourceEnumerator - Starting the KafkaSourceEnumerator for consumer group
  flink-analytics-consumer with partition discovery interval of 300000 ms.
```

---

## Issue 2: Deprecated Flink Configuration Keys

### Symptom

JobManager and TaskManager logs show deprecation warnings:

```
WARN JobMaster - filesystem state backend has been deprecated. Please use 'hashmap' state backend instead.
```

And the configuration file uses deprecated keys recognized by Flink 1.20 but scheduled for removal.

### Root Cause

Two configuration keys were renamed between Flink 1.18 and 1.20:

| Deprecated (old) | Current (new) |
|---|---|
| `state.backend` | `state.backend.type` |
| `state.checkpoints.dir` | `execution.checkpointing.dir` |

And the value `filesystem` for the state backend was renamed to `hashmap` (both refer to `HashMapStateBackend`):

| Deprecated value | Current value | Backend loaded |
|---|---|---|
| `filesystem` | `hashmap` | `HashMapStateBackend` (in-heap state) |
| `memory` | `hashmap` | `HashMapStateBackend` |
| `rocksdb` | `rocksdb` | `EmbeddedRocksDBStateBackend` |

**Note:** The state backend change (`filesystem` → `hashmap`) is **semantically equivalent** — both load `HashMapStateBackend`. Checkpoints are still written to the PVC at `execution.checkpointing.dir`. Only the log warning changes.

### Fix

**In `infra/flink/flink-cluster.yaml`** (both JobManager and TaskManager `FLINK_PROPERTIES`):

```yaml
# Before
state.backend: filesystem
state.checkpoints.dir: file:///opt/flink/checkpoints

# After
state.backend.type: hashmap
execution.checkpointing.dir: file:///opt/flink/checkpoints
```

**In `infra/flink/flink-config.yaml`** (reference file — not mounted, kept in sync):

Same change as above.

### Verification

```bash
kubectl logs -n analytics deploy/flink-jobmanager --container jobmanager | grep -E "state.backend|deprecated"
```

Expected output (fixed — no deprecation warning):
```
INFO GlobalConfiguration - Loading configuration property: state.backend.type, hashmap
INFO StateBackendLoader - State backend loader loads the state backend as HashMapStateBackend
```

Old broken output:
```
INFO GlobalConfiguration - Loading configuration property: state.backend.type, filesystem
WARN JobMaster - filesystem state backend has been deprecated. Please use 'hashmap' state backend instead.
```

---

## Issue 3: Missing Kafka Topics Cause Immediate Job Failure

### Symptom

All 4 Flink streaming jobs fail immediately on startup:

```
java.lang.RuntimeException: Failed to get metadata for topics [ecom-connector.public.orders].
  Caused by: org.apache.kafka.common.errors.UnknownTopicOrPartitionException:
    This server does not host this topic-partition.
```

But this time at startup (t=0), not 5 minutes in.

### Root Cause

This is a different problem from Issue 1 — the Kafka topics **don't exist** at all. This happens when:

1. `scripts/up.sh --fresh` is run but the `kafka-topics-init` Job was not re-applied after Kafka restart
2. Kafka pod restarts but its PVC is intact — the topics survive, but they were never created on a fresh cluster
3. Debezium connectors were registered before Kafka topics were created

The CDC topic names must match the Debezium connector configuration:

```
ecom-connector.public.books
ecom-connector.public.orders
ecom-connector.public.order_items
inventory-connector.public.inventory
```

### Fix

Verify topics exist:

```bash
kubectl exec -n infra deploy/kafka -- kafka-topics \
  --bootstrap-server localhost:9092 --list | grep connector
```

If missing, rerun the topic init job:

```bash
kubectl delete job kafka-topics-init -n infra --ignore-not-found
kubectl apply -f infra/kafka/kafka-topics-init.yaml
kubectl wait --for=condition=complete job/kafka-topics-init -n infra --timeout=60s
```

Then verify:

```bash
kubectl exec -n infra deploy/kafka -- kafka-topics \
  --bootstrap-server localhost:9092 --describe \
  --topic ecom-connector.public.orders
```

Expected:
```
Topic: ecom-connector.public.orders  PartitionCount: 3  ReplicationFactor: 1
  Partition: 0  Leader: 1  Replicas: 1  Isr: 1
  Partition: 1  Leader: 1  Replicas: 1  Isr: 1
  Partition: 2  Leader: 1  Replicas: 1  Isr: 1
```

---

## Applying All Fixes

After changing `flink-sql-runner.yaml` (ConfigMap) or `flink-cluster.yaml` (FLINK_PROPERTIES), follow this procedure:

### Step 1: Apply manifest changes

```bash
cd /path/to/repo
kubectl apply -f infra/flink/flink-cluster.yaml
kubectl apply -f infra/flink/flink-sql-runner.yaml
```

### Step 2: Restart Flink pods (picks up FLINK_PROPERTIES changes)

```bash
kubectl rollout restart deploy/flink-jobmanager deploy/flink-taskmanager -n analytics
kubectl rollout status deploy/flink-jobmanager deploy/flink-taskmanager -n analytics --timeout=180s
```

### Step 3: Wait for SQL Gateway

```bash
until kubectl exec -n analytics deploy/flink-jobmanager -c sql-gateway -- \
  curl -sf http://localhost:9091/v1/info > /dev/null 2>&1; do
  echo "SQL Gateway not ready, waiting..."; sleep 5
done
echo "SQL Gateway ready."
```

### Step 4: Resubmit SQL pipeline

```bash
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=120s
```

### Step 5: Verify 4 RUNNING jobs with no exceptions

```bash
curl -s http://localhost:32200/jobs | python3 -c "
import sys, json
d = json.load(sys.stdin)
r = [j for j in d['jobs'] if j['status']=='RUNNING']
f = [j for j in d['jobs'] if j['status']=='FAILED']
print(f'RUNNING: {len(r)}, FAILED: {len(f)}')
"
```

Expected: `RUNNING: 4, FAILED: 0`

### Step 6: Verify no periodic partition discovery

```bash
kubectl logs -n analytics deploy/flink-jobmanager --container jobmanager | \
  grep "KafkaSourceEnumerator"
```

Must contain: `without periodic partition discovery` (NOT `with partition discovery interval of 300000 ms`)

### Step 7: Verify CDC data in analytics-db

```bash
kubectl exec -n analytics deploy/analytics-db -- \
  psql -U analyticsuser -d analyticsdb \
  -c "SELECT COUNT(*) as books FROM dim_books; SELECT COUNT(*) as inventory FROM fact_inventory;"
```

Expected: 10 books, 10 inventory rows (from Debezium initial snapshot).

---

## Quick Health Check Commands

```bash
# 1. Flink jobs status
curl -s http://localhost:32200/jobs | python3 -c "
import sys,json
d=json.load(sys.stdin)
for j in d['jobs']:
    print(j['status'], j['id'][:8])
"

# 2. Check partition discovery disabled
kubectl logs -n analytics deploy/flink-jobmanager --container jobmanager | \
  grep "KafkaSourceEnumerator" | tail -4

# 3. Check for errors (excluding benign "job not found" from stale UI polls)
kubectl logs -n analytics deploy/flink-jobmanager --container jobmanager | \
  grep -E "ERROR|WARN" | \
  grep -v "not found" | \
  tail -10

# 4. Kafka topics
kubectl exec -n infra deploy/kafka -- \
  kafka-topics --bootstrap-server localhost:9092 --list | grep connector

# 5. Analytics DB row counts
kubectl exec -n analytics deploy/analytics-db -- \
  psql -U analyticsuser -d analyticsdb \
  -c "SELECT 'orders' t, COUNT(*) n FROM fact_orders
      UNION ALL SELECT 'books', COUNT(*) FROM dim_books
      UNION ALL SELECT 'inventory', COUNT(*) FROM fact_inventory
      UNION ALL SELECT 'order_items', COUNT(*) FROM fact_order_items;"

# 6. Flink checkpoint state (should show recent checkpoint timestamps)
curl -s http://localhost:32200/jobs | python3 -c "
import sys,json
jobs=json.load(sys.stdin)['jobs']
running=[j['id'] for j in jobs if j['status']=='RUNNING']
print('Running job IDs:', running[:2])
"
# Then for one job ID:
# curl -s http://localhost:32200/jobs/<id>/checkpoints | python3 -m json.tool | grep -E "status|timestamp" | head -10
```

---

## Files Changed

| File | Change |
|---|---|
| `analytics/flink/sql/pipeline.sql` | Added `'scan.topic-partition-discovery.interval' = '0'` to all 4 Kafka source tables |
| `infra/flink/flink-sql-runner.yaml` | Same change in ConfigMap (ConfigMap is the actual source used by the sql-runner Job) |
| `infra/flink/flink-cluster.yaml` | `state.backend: filesystem` → `state.backend.type: hashmap`; `state.checkpoints.dir` → `execution.checkpointing.dir` (both JM and TM) |
| `infra/flink/flink-config.yaml` | Same config key fixes (reference file, kept in sync) |

---

## Why These Issues Were Hard to Spot

1. **Issue 1 only triggered at t+5min** — jobs appear healthy at startup, then fail 5 minutes later. Easy to miss during initial testing if you don't wait long enough.

2. **The error message is misleading** — `UnknownTopicOrPartitionException: This server does not host this topic-partition` sounds like a routing problem (wrong broker), but the real cause is a transient AdminClient reconnect failure. The topics DO exist and ARE on the single broker.

3. **"Node -1" is a red herring** — Node -1 is Kafka's bootstrap pseudo-node, always used for the initial connection. Seeing `Node -1 disconnected` means the reconnection attempt itself failed, not that there's a partition routing issue.

4. **Issue 2 had no functional impact** — the deprecated config keys worked fine (filesystem mapped to hashmap automatically), so the warnings didn't cause visible failures. Easy to overlook when jobs appear healthy.

5. **ConfigMap vs source file** — `pipeline.sql` is baked into the Docker image AND in `flink-sql-runner.yaml`'s ConfigMap. The ConfigMap is what's actually used at runtime (mounted at `/sql/pipeline.sql`). Both must be kept in sync, but only the ConfigMap change requires a sql-runner re-submission (no Docker rebuild needed).
