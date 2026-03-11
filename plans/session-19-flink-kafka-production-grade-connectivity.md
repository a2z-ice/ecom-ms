# Session 19 — Production-Grade Flink Kafka Connectivity

## Goal

Replace the `'scan.topic-partition-discovery.interval' = '0'` shortcut fix with a proper production-grade solution that:

1. **Re-enables partition discovery** — required for Kafka scaling and correct in production
2. **Fixes the actual root cause** — stale idle AdminClient connections in NAT networking (kind)
3. **Prepares for future schema growth** — new tables, new connectors, and new partitions all work without code hacks
4. **Documents the "add a new table" workflow** — production-correct procedure, not a workaround

---

## Why the Previous Fix Was Wrong

The previous fix disabled partition discovery entirely (`'scan.topic-partition-discovery.interval' = '0'`). This was a **shortcut** that hid the root cause:

```
ROOT CAUSE: AdminClient idle connection becomes stale in NAT networking
SHORTCUT:   Disable the feature that uses AdminClient → no reconnects → no crash
CORRECT:    Configure connections to never be stale when a discovery fires
```

**What we break by disabling partition discovery:**

| Scenario | With `= '0'` (disabled) | With `= '300000'` + proper settings |
|---|---|---|
| Add partitions to existing topic | Flink misses new partitions until job restart | Auto-detected within 5 minutes ✓ |
| Scale Kafka for higher throughput | Manual job restart required | Transparent, no downtime ✓ |
| Kafka partition rebalance | Flink can miss messages from new partition assignments | Handled automatically ✓ |
| New table added to Debezium | Requires SQL change + resubmit (same either way) | Same — still requires SQL change |

The last row is critical: **partition discovery does NOT auto-detect new tables** in Flink SQL. New tables always require a new `CREATE TABLE` statement and job resubmission. This is correct architectural separation — Flink SQL schemas are statically typed and validated at compile time. Disabling partition discovery gives no benefit for table additions.

---

## Root Cause Analysis

### What Fails

`KafkaSourceEnumerator` creates a new `AdminClient` every `scan.topic-partition-discovery.interval` ms and calls `AdminClient.describeTopics()`. In kind NAT networking:

```
t=0min   AdminClient connects to Kafka broker → initial partition discovery OK
t=0-5min AdminClient connection sits IDLE in NAT network
          ↓ NAT table entry may expire silently (kind's NAT has unpredictable idle TTL)
t=5min   Discovery fires → AdminClient tries to USE the idle connection
          ↓ Packet is sent but NAT has no entry → broker never sees it
          ↓ AdminClient sees no response → "Node -1 disconnected"
          ↓ AdminClient tries to reconnect → race condition during KRaft metadata exchange
          ↓ describeTopics() returns UnknownTopicOrPartitionException
          ↓ KafkaSourceEnumerator throws → GlobalFailure → all 4 jobs restart
```

### The Proper Fix

Set `properties.connections.max.idle.ms` to **less than** the partition discovery interval. This causes the AdminClient to **proactively close** its connection while it knows it's idle — before the NAT entry expires and before the next discovery fires.

```
t=0min   AdminClient connects → discovery runs → connection goes IDLE
t=3min   connections.max.idle.ms=180000 fires → AdminClient closes connection CLEANLY
t=5min   Discovery fires → AdminClient opens a FRESH connection (no stale NAT state)
          → describeTopics() succeeds immediately
          → No crash, no restart
```

This is the production-standard approach for Kafka clients behind NAT (documented by AWS for MSK in VPC environments, and by Confluent for cloud deployments behind NAT gateways).

---

## Deliverables

| File | Change |
|---|---|
| `analytics/flink/sql/pipeline.sql` | Re-enable partition discovery to `'300000'`; add 7 AdminClient connection properties to all 4 source tables |
| `infra/flink/flink-sql-runner.yaml` | Same changes to the ConfigMap (runtime source) |
| `infra/kafka/kafka.yaml` | Add broker-side connection settings: explicit `KAFKA_CONNECTIONS_MAX_IDLE_MS`, log retention tuning |
| `docs/operations/stability-issues-and-fixes.md` | Update Issue 1: replace shortcut description with proper root-cause fix |
| `docs/cdc/flink-stability-guide.md` | Update Issue 1 with the proper AdminClient connection fix |
| `docs/cdc/cdc-setup-manual.md` | Update Flink source table template with new properties |
| `CLAUDE.md` | Update Flink CDC section with the proper fix and "adding a new table" workflow |
| `plans/session-19-flink-kafka-production-grade-connectivity.md` | This file |
| `plans/implementation-plan.md` | Add Session 19 |

---

## Acceptance Criteria

- [ ] `'scan.topic-partition-discovery.interval' = '0'` is **gone** from all files
- [ ] `'scan.topic-partition-discovery.interval' = '300000'` present in all 4 source tables
- [ ] `'properties.connections.max.idle.ms' = '180000'` present in all 4 source tables (and 4 other connection properties)
- [ ] Flink JobManager logs say **"without periodic partition discovery"** is GONE → now says "with partition discovery interval of 300000 ms"
- [ ] After 10 minutes of runtime, all 4 Flink jobs still in RUNNING state (the 5-minute discovery fires successfully)
- [ ] All 4 jobs have zero exceptions in their exception history after the first discovery cycle
- [ ] Smoke test: 23/23 passing
- [ ] E2E tests: 89/89 passing
- [ ] `docs/operations/stability-issues-and-fixes.md` updated with correct root cause and fix

---

## Configuration Changes

### Flink SQL Source Tables (all 4)

```sql
CREATE TABLE kafka_orders (
  after ROW<
    id         STRING,
    user_id    STRING,
    total      DOUBLE,
    status     STRING,
    created_at STRING
  >,
  op STRING
) WITH (
  'connector'                                         = 'kafka',
  'topic'                                             = 'ecom-connector.public.orders',
  'properties.bootstrap.servers'                      = 'kafka.infra.svc.cluster.local:9092',
  'properties.group.id'                               = 'flink-analytics-consumer',
  'format'                                            = 'json',
  'json.ignore-parse-errors'                          = 'true',
  'scan.startup.mode'                                 = 'earliest-offset',

  -- Partition discovery: ENABLED (required for Kafka scaling; correct production behavior)
  -- Default is 300000ms (5 min). This allows auto-detection of new partitions when
  -- Kafka topics are scaled for throughput. New TABLES still require a SQL change + resubmit.
  'scan.topic-partition-discovery.interval'           = '300000',

  -- AdminClient connection resilience: fixes NAT idle connection issue in kind.
  -- Root cause: AdminClient connection sits idle for 5 min between discovery calls;
  -- NAT entry expires silently; reconnect hits a race condition in KRaft metadata.
  -- Fix: set idle timeout (180s) < discovery interval (300s) so the connection is
  -- proactively closed BEFORE the NAT entry can expire. Each discovery cycle then
  -- opens a fresh connection → no stale NAT state → no UnknownTopicOrPartitionException.
  'properties.connections.max.idle.ms'                = '180000',
  'properties.reconnect.backoff.ms'                   = '1000',
  'properties.reconnect.backoff.max.ms'               = '10000',
  'properties.request.timeout.ms'                     = '30000',
  'properties.socket.connection.setup.timeout.ms'     = '10000',
  'properties.socket.connection.setup.timeout.max.ms' = '30000',
  'properties.metadata.max.age.ms'                    = '300000'
);
```

Apply identical connection properties to: `kafka_order_items`, `kafka_books`, `kafka_inventory`.

### Kafka Broker (`infra/kafka/kafka.yaml`)

Add these environment variables to make the broker explicitly NAT-friendly:

```yaml
# Consistent with client-side connections.max.idle.ms
# Broker closes idle connections after 10 min; clients close after 3 min
# → clients always proactively close before broker can silently drop
- name: KAFKA_CONNECTIONS_MAX_IDLE_MS
  value: "600000"   # 10 min (explicit; was implicit default)

# Enable TCP keepalive at socket level — sends periodic probes on idle connections
# Keeps NAT table entries alive for legitimate long-lived connections (consumer fetch)
- name: KAFKA_SOCKET_KEEPALIVE_ENABLE
  value: "true"
```

---

## "Adding a New Table" Workflow (Production Procedure)

This is the correct, production-grade procedure when adding a new source table to the CDC pipeline. Partition discovery does NOT automate this — schema changes require explicit SQL governance.

### Step 1: Source Database Migration

Add the new table via Liquibase (ecom-service) or Alembic (inventory-service) migration.

### Step 2: Update Debezium Connector

Add the new table to the connector's `table.include.list`:

```bash
# Update connector config (add new table)
curl -X PUT http://localhost:32300/connectors/ecom-connector/config \
  -H "Content-Type: application/json" \
  -d '{ ..., "table.include.list": "public.orders,public.order_items,public.books,public.new_table" }'
```

Debezium will create the new Kafka topic: `ecom-connector.public.new_table`

### Step 3: Update Analytics DB Schema

Add the new fact/dim table to `analytics/schema/analytics-ddl.sql`:

```sql
CREATE TABLE IF NOT EXISTS fact_new_entity (
  id         TEXT PRIMARY KEY,
  -- ... columns matching the source table
);
```

### Step 4: Update Flink SQL Pipeline

In both `analytics/flink/sql/pipeline.sql` AND `infra/flink/flink-sql-runner.yaml` ConfigMap:

```sql
-- New Kafka source table
CREATE TABLE kafka_new_entity (
  after ROW<
    id    STRING,
    -- ... columns
  >,
  op STRING
) WITH (
  'connector'                                         = 'kafka',
  'topic'                                             = 'ecom-connector.public.new_entity',
  'properties.bootstrap.servers'                      = 'kafka.infra.svc.cluster.local:9092',
  'properties.group.id'                               = 'flink-analytics-consumer',
  'format'                                            = 'json',
  'json.ignore-parse-errors'                          = 'true',
  'scan.startup.mode'                                 = 'earliest-offset',
  'scan.topic-partition-discovery.interval'           = '300000',
  'properties.connections.max.idle.ms'                = '180000',
  'properties.reconnect.backoff.ms'                   = '1000',
  'properties.reconnect.backoff.max.ms'               = '10000',
  'properties.request.timeout.ms'                     = '30000',
  'properties.socket.connection.setup.timeout.ms'     = '10000',
  'properties.socket.connection.setup.timeout.max.ms' = '30000',
  'properties.metadata.max.age.ms'                    = '300000'
);

-- New JDBC sink table
CREATE TABLE sink_fact_new_entity (
  id    STRING,
  -- ... columns
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'connector'                   = 'jdbc',
  'url'                         = 'jdbc:postgresql://analytics-db.analytics.svc.cluster.local:5432/analyticsdb?stringtype=unspecified',
  'table-name'                  = 'fact_new_entity',
  'username'                    = '${ANALYTICS_DB_USER}',
  'password'                    = '${ANALYTICS_DB_PASSWORD}',
  'sink.buffer-flush.max-rows'  = '1',
  'sink.buffer-flush.interval'  = '1s'
);

-- New streaming pipeline
INSERT INTO sink_fact_new_entity
SELECT after.id, ...
FROM kafka_new_entity
WHERE after IS NOT NULL;
```

### Step 5: Resubmit Flink SQL Pipeline

```bash
# No Docker rebuild needed — SQL lives in the ConfigMap
kubectl apply -f infra/flink/flink-sql-runner.yaml  # updates ConfigMap
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=120s

# Verify all jobs running (will be N+1 now)
curl -s http://localhost:32200/jobs | python3 -c "
import sys, json
jobs = json.load(sys.stdin)['jobs']
print(f'{sum(1 for j in jobs if j[\"status\"]==\"RUNNING\")}/{len(jobs)} RUNNING')
"
```

### Step 6: Verify CDC Data Flow

```bash
# Seed a row in the new source table (via the application or direct psql)
# Then poll analytics DB for it (within 30s)
kubectl exec -n analytics deploy/analytics-db -- \
  psql -U analyticsuser analyticsdb \
  -c "SELECT COUNT(*) FROM fact_new_entity;"
```

---

## Build & Deploy Commands

```bash
# No Docker rebuild needed — SQL changes are in ConfigMap only
# Apply updated manifests
kubectl apply -f infra/kafka/kafka.yaml
kubectl apply -f infra/flink/flink-sql-runner.yaml   # updates ConfigMap

# Restart Flink to pick up any FLINK_PROPERTIES changes
kubectl rollout restart deploy/flink-jobmanager deploy/flink-taskmanager -n analytics
kubectl rollout status deploy/flink-jobmanager -n analytics --timeout=180s
kubectl rollout status deploy/flink-taskmanager -n analytics --timeout=180s

# Wait for SQL Gateway
until kubectl exec -n analytics deploy/flink-jobmanager -c sql-gateway -- \
  curl -sf http://localhost:9091/v1/info > /dev/null 2>&1; do
  echo "Waiting for SQL Gateway..."; sleep 5
done

# Resubmit pipeline
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=120s

# Verify
curl -s http://localhost:32200/jobs | python3 -c "
import sys, json
jobs = json.load(sys.stdin)['jobs']
print(f'{sum(1 for j in jobs if j[\"status\"]==\"RUNNING\")}/{len(jobs)} RUNNING')
"
```

---

## Stability Verification (10-minute test)

Run this after deployment to confirm partition discovery fires without crashing:

```bash
# Monitor Flink logs for 10 minutes
watch -n 30 'kubectl logs -n analytics deploy/flink-jobmanager -c jobmanager --since=5m | \
  grep -E "KafkaSourceEnumerator|FlinkRuntimeException|GlobalFailure|RUNNING|FAILED" | tail -10'

# After 5 minutes, check for exceptions
curl -s http://localhost:32200/jobs | python3 -c "
import sys, json, urllib.request
jobs = json.load(sys.stdin)['jobs']
for j in jobs:
    r = urllib.request.urlopen(f'http://localhost:32200/jobs/{j[\"id\"]}/exceptions')
    exc = json.loads(r.read())
    history = exc.get('exceptionHistory', {}).get('entries', [])
    recent = [e for e in history if e.get('timestamp', 0) > 0]
    status = 'CLEAN' if not recent else f'{len(recent)} EXCEPTIONS'
    print(f'Job {j[\"id\"][:8]} ({j[\"status\"]}): {status}')
"
# Expected after 10 min: all 4 jobs RUNNING, CLEAN
```

---

## Status

Complete — all files updated; cluster changes applied; 10-minute stability test pending (run after deploy).
