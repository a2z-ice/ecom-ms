# Apache Flink Streaming SQL Pipeline

**Version**: Flink 1.20 (flink:1.20-scala_2.12-java17)
**Namespace**: `analytics`
**Dashboard**: http://localhost:32200
**Purpose**: Continuously consumes Debezium CDC events from Kafka and writes them to the analytics PostgreSQL database using Flink SQL, enabling real-time reporting via Apache Superset.

---

## Table of Contents

1. [What is Apache Flink?](#1-what-is-apache-flink)
2. [Architecture Overview](#2-architecture-overview)
3. [Cluster Components](#3-cluster-components)
4. [Custom Docker Image](#4-custom-docker-image)
5. [The SQL Pipeline](#5-the-sql-pipeline)
6. [Source Tables — Kafka Connectors](#6-source-tables--kafka-connectors)
7. [Sink Tables — JDBC Connectors](#7-sink-tables--jdbc-connectors)
8. [Pipeline INSERT Statements](#8-pipeline-insert-statements)
9. [Checkpoint and Fault Tolerance](#9-checkpoint-and-fault-tolerance)
10. [SQL Submission Process](#10-sql-submission-process)
11. [Analytics Database Schema](#11-analytics-database-schema)
12. [Flink Web Dashboard](#12-flink-web-dashboard)
13. [Production Resilience Patterns](#13-production-resilience-patterns)
14. [Customization Guide](#14-customization-guide)
15. [Operations Guide](#15-operations-guide)
16. [Troubleshooting](#16-troubleshooting)
17. [Screenshot Reference](#17-screenshot-reference)

---

## 1. What is Apache Flink?

Apache Flink is a **distributed stream processing framework** for stateful computations over unbounded and bounded data streams. In this platform, Flink plays the role of the streaming ETL layer between Kafka (event source) and the analytics PostgreSQL database (query target).

### Core Concepts

| Concept | Description |
|---------|-------------|
| **DataStream API** | Low-level Java/Scala API for custom operator graphs |
| **Table API / SQL** | High-level relational API; this platform uses SQL exclusively |
| **Job** | One compiled execution plan (DAG) submitted to the cluster |
| **JobManager** | Coordinator: schedules tasks, handles checkpoints, restarts |
| **TaskManager** | Worker: executes actual operator instances (tasks) |
| **Task Slot** | Isolated execution unit within a TaskManager; controls parallelism |
| **Checkpoint** | Periodic snapshot of all operator state for fault recovery |
| **Session Cluster** | Long-running cluster that accepts multiple job submissions |

### Why Flink Instead of Custom Consumers?

Before Session 18, this platform used a Python consumer (`analytics/consumer/`) that read from Kafka and wrote to analytics-db. It was replaced with Flink for these reasons:

- **Exactly-once delivery**: Flink + Kafka source + JDBC sink forms a complete exactly-once pipeline. The Python consumer had no deduplication.
- **Declarative SQL**: Add or modify pipelines by changing SQL; no redeployment of application code.
- **Built-in fault recovery**: Checkpoints allow Flink to restart from the last consistent snapshot — no data loss on crash.
- **Backpressure handling**: Flink propagates backpressure from the sink (PostgreSQL) back to the source (Kafka), preventing data loss under load.
- **Monitoring**: Flink Web Dashboard provides real-time throughput, latency, checkpoint history, and operator topology.

---

## 2. Architecture Overview

```
+─────────────────── ecom-db (PostgreSQL) ─────────────────────+
│  public.orders   public.order_items   public.books           │
+──────────────────────────────┬───────────────────────────────+
                               │ WAL (logical replication)
                               v
+─────────── Debezium Server (debezium-server-ecom pod) ────────+
│  Reads WAL, emits JSON CDC events to Kafka topics            │
+──────────────────────────────┬───────────────────────────────+
                               │ Kafka topics:
                               │  ecom-connector.public.orders
                               │  ecom-connector.public.order_items
                               │  ecom-connector.public.books
                               v
+─────────────────────── Kafka (KRaft) ─────────────────────────+
│                       infra namespace                         │
+──────────────────────────────┬───────────────────────────────+
                               │ Consumer group: flink-analytics-consumer
                               v
+─────────────── Flink Session Cluster (analytics ns) ──────────+
│                                                               │
│  JobManager + SQL Gateway (port 9091)                        │
│     - Receives SQL via flink-sql-runner Job                   │
│     - Compiles SQL to execution DAG                           │
│     - Schedules tasks on TaskManager                          │
│                                                               │
│  TaskManager (4 slots)                                        │
│     - Runs Kafka source operators (poll + deserialize)        │
│     - Runs filter/transform operators (WHERE, CAST)           │
│     - Runs JDBC sink operators (buffer + upsert to PG)        │
│                                                               │
│  Checkpoints → PVC (/opt/flink/checkpoints)                   │
│     Exactly-once, every 30 seconds                           │
+──────────────────────────────┬───────────────────────────────+
                               │ JDBC (INSERT ... ON CONFLICT DO UPDATE)
                               v
+─────────────── analytics-db (PostgreSQL) ─────────────────────+
│  fact_orders   fact_order_items   dim_books   fact_inventory  │
+──────────────────────────────┬───────────────────────────────+
                               │ SQL SELECT / JOIN
                               v
                      Apache Superset
                  (3 dashboards, 16 charts)
```

### inventory-db feeds a parallel path:

```
inventory-db → Debezium Server (debezium-server-inventory) → Kafka
  topic: inventory-connector.public.inventory
    → Flink → fact_inventory → Superset Inventory Analytics dashboard
```

---

## 3. Cluster Components

The Flink cluster is deployed as a **Session Cluster** in the `analytics` namespace. This means:
- The cluster runs continuously (no job-specific lifecycle).
- Multiple jobs can be submitted and managed independently.
- Checkpoints persist across job restarts.

### JobManager

**File**: `infra/flink/flink-cluster.yaml` (lines 1–168)

The JobManager pod runs **two containers** in a sidecar pattern:

```
Pod: flink-jobmanager
├── container: jobmanager         — Flink JobManager process, port 8081
└── container: sql-gateway        — SQL Gateway process, port 9091
```

**JobManager responsibilities**:
- Accepts job submissions via REST API (port 8081)
- Compiles Flink SQL to an operator DAG
- Assigns tasks to TaskManager slots
- Coordinates distributed checkpointing
- Restarts failed tasks (with exponential backoff)
- Exposes the Web Dashboard (port 8081)

**SQL Gateway responsibilities**:
- Provides a REST endpoint (port 9091) for SQL submission
- Acts as the bridge between `sql-client.sh` and the running cluster
- Waits for JobManager to be ready before starting

SQL Gateway startup sequence:

```bash
# The sql-gateway container polls until JobManager REST API is healthy
until curl -sf http://localhost:8081/overview > /dev/null 2>&1; do
  sleep 3
done
bin/sql-gateway.sh start-foreground \
  -Dsql-gateway.endpoint.rest.address=0.0.0.0 \
  -Dsql-gateway.endpoint.rest.port=9091 \
  -Dexecution.target=remote
```

### TaskManager

**File**: `infra/flink/flink-cluster.yaml` (lines 216–297)

The TaskManager executes the actual streaming operators:

```yaml
taskmanager.numberOfTaskSlots: 4
taskmanager.memory.process.size: 1024m
```

With 4 slots and parallelism.default: 1, this cluster supports up to 4 concurrent jobs running in parallel. Each Flink SQL `INSERT INTO` statement becomes one streaming job.

### Configuration — FLINK_PROPERTIES

All Flink configuration is passed via the `FLINK_PROPERTIES` environment variable (a multi-line YAML string). This avoids mounting a ConfigMap and keeps configuration visible in the Deployment manifest:

```yaml
env:
  - name: FLINK_PROPERTIES
    value: |
      jobmanager.rpc.address: flink-jobmanager
      jobmanager.memory.process.size: 900m
      parallelism.default: 1
      state.backend.type: hashmap
      execution.checkpointing.dir: file:///opt/flink/checkpoints
      execution.checkpointing.interval: 30s
      execution.checkpointing.mode: EXACTLY_ONCE
      rest.port: 8081
      rest.address: 0.0.0.0
```

**Note on deprecated keys**: Flink 1.20 uses:
- `state.backend.type: hashmap` (NOT `state.backend: filesystem`)
- `execution.checkpointing.dir` (NOT `state.checkpoints.dir`)

Using the deprecated keys causes a silent startup failure where checkpoints are not written.

### Kubernetes Services

| Service | Type | Port | Purpose |
|---------|------|------|---------|
| `flink-jobmanager` | ClusterIP | 6123/6124/8081/9091 | Internal: RPC, blob, REST, SQL Gateway |
| `flink-jobmanager-nodeport` | NodePort | 32200→8081 | External: Web Dashboard |

### PersistentVolumeClaim

```yaml
# infra/flink/flink-pvc.yaml
kind: PersistentVolumeClaim
  name: flink-checkpoints-pvc
  namespace: analytics
spec:
  storageClassName: local-hostpath
  resources.requests.storage: 2Gi
```

Mounted at `/opt/flink/checkpoints` in both JobManager and TaskManager pods. Backed by `data/flink/` on the host via kind `extraMounts`.

---

## 4. Custom Docker Image

**File**: `analytics/flink/Dockerfile`

The official `flink:1.20-scala_2.12-java17` image does not include Kafka or JDBC connectors. The custom image downloads them at build time and bakes them into `/opt/flink/lib/`, where Flink automatically loads all JARs.

```dockerfile
# Stage 1: Download connector JARs (alpine is multi-arch: amd64 + arm64)
FROM alpine:3.19 AS downloader

RUN apk add --no-cache curl

WORKDIR /jars

# Flink Kafka connector (for Flink 1.20)
RUN curl -fsSL -o flink-connector-kafka-3.4.0-1.20.jar \
  "https://repo1.maven.org/maven2/org/apache/flink/flink-connector-kafka/3.4.0-1.20/flink-connector-kafka-3.4.0-1.20.jar"

# Flink JDBC connector (for Flink 1.20)
RUN curl -fsSL -o flink-connector-jdbc-3.3.0-1.20.jar \
  "https://repo1.maven.org/maven2/org/apache/flink/flink-connector-jdbc/3.3.0-1.20/flink-connector-jdbc-3.3.0-1.20.jar"

# PostgreSQL JDBC driver
RUN curl -fsSL -o postgresql-42.7.10.jar \
  "https://repo1.maven.org/maven2/org/postgresql/postgresql/42.7.10/postgresql-42.7.10.jar"

# Kafka clients (required by Flink Kafka connector at runtime)
RUN curl -fsSL -o kafka-clients-3.9.2.jar \
  "https://repo1.maven.org/maven2/org/apache/kafka/kafka-clients/3.9.2/kafka-clients-3.9.2.jar"

# Stage 2: Flink runtime image with connectors baked in
FROM flink:1.20-scala_2.12-java17

# The base flink image already runs as non-root user 'flink' (UID 9999)
# Copy connector JARs to auto-classpath location
COPY --from=downloader /jars/*.jar /opt/flink/lib/
```

### Why Flink 1.20 (Not 2.x)?

Flink 2.0 was released in December 2025 and removed the `SinkFunction` API (FLIP-200). The `flink-connector-jdbc` library (version 3.3.0) depends on `SinkFunction` internally. As of March 2026, no JDBC connector release exists for Flink 2.x on Maven Central. Upgrading requires waiting for `flink-connector-jdbc:4.x`.

| Component | Current | Notes |
|-----------|---------|-------|
| Flink base | 1.20-scala_2.12-java17 | Stays until JDBC 4.x releases |
| flink-connector-kafka | 3.4.0-1.20 | Compatible with Flink 1.20 |
| flink-connector-jdbc | 3.3.0-1.20 | No Flink 2.x release available |
| kafka-clients | 3.9.2 | Latest stable |
| postgresql driver | 42.7.10 | Latest stable |

### Building and Loading

```bash
# Build the image
docker build -t bookstore/flink:latest ./analytics/flink

# Load into kind cluster (replaces docker push for local development)
kind load docker-image bookstore/flink:latest --name bookstore

# Restart the cluster to pick up the new image
kubectl rollout restart deployment/flink-jobmanager deployment/flink-taskmanager -n analytics
```

---

## 5. The SQL Pipeline

**File**: `analytics/flink/sql/pipeline.sql`
**Also in**: `infra/flink/flink-sql-runner.yaml` (ConfigMap `flink-pipeline-sql`)

The pipeline is written entirely in Flink SQL. It consists of three parts:
1. **Source tables** — declare Kafka topics as SQL tables (virtual schema, no data stored)
2. **Sink tables** — declare PostgreSQL tables as SQL tables (actual writes happen here)
3. **INSERT statements** — define the streaming pipelines (one per topic)

### Debezium Envelope Format

Every message from Debezium Server follows this JSON envelope:

```json
{
  "before": null,
  "after": {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "user_id": "abc",
    "total": 49.99,
    "status": "PENDING",
    "created_at": "2026-03-01T14:22:10.123456Z"
  },
  "op": "c",
  "source": {
    "version": "3.4.1.Final",
    "connector": "postgresql",
    "name": "ecom-connector",
    "ts_ms": 1740839330123,
    "snapshot": "false",
    "db": "ecomdb",
    "schema": "public",
    "table": "orders"
  }
}
```

**`op` field values**:
- `c` — CREATE (INSERT on source)
- `u` — UPDATE on source
- `d` — DELETE on source
- `r` — READ (initial snapshot)

### Format Choice: `json` vs `debezium-json`

Flink has a built-in `debezium-json` format specifically for Debezium envelopes. This platform uses plain `json` instead:

| Format | Pros | Cons |
|--------|------|------|
| `debezium-json` | Built-in upsert/delete semantics | Requires `REPLICA IDENTITY FULL` for UPDATE events (needs non-null `before` field) |
| `json` (plain) | Works with default `REPLICA IDENTITY DEFAULT` | Manual field extraction via `after ROW<...>` |

Since the source PostgreSQL tables use `REPLICA IDENTITY DEFAULT` (the Debezium default), `debezium-json` would fail on UPDATE events because `before` is null. Plain `json` lets us declare `after` as a ROW type and extract fields directly.

---

## 6. Source Tables — Kafka Connectors

Each source table declares:
- `after ROW<...>` — the Debezium `after` object containing the new column values
- `op STRING` — the operation type (used for optional filtering)
- A `WITH` clause pointing to the Kafka topic

### Orders Source Table

```sql
CREATE TABLE kafka_orders (
  after ROW<
    id         STRING,
    user_id    STRING,
    total      DOUBLE,
    status     STRING,
    created_at STRING   -- ISO 8601, converted in INSERT
  >,
  op STRING
) WITH (
  'connector'                              = 'kafka',
  'topic'                                  = 'ecom-connector.public.orders',
  'properties.bootstrap.servers'           = 'kafka.infra.svc.cluster.local:9092',
  'properties.group.id'                    = 'flink-analytics-consumer',
  'format'                                 = 'json',
  'json.ignore-parse-errors'               = 'true',
  'scan.startup.mode'                      = 'earliest-offset',
  'scan.topic-partition-discovery.interval' = '300000',
  'properties.connections.max.idle.ms'     = '180000',
  -- ... (6 more connection resilience properties)
);
```

### Key Source Table Options Explained

| Option | Value | Reason |
|--------|-------|--------|
| `connector` | `kafka` | Use the Kafka connector |
| `format` | `json` | Parse raw JSON (not Debezium-specific format) |
| `json.ignore-parse-errors` | `true` | Skip tombstone/control messages silently |
| `scan.startup.mode` | `earliest-offset` | On first run, replay all history from the beginning |
| `scan.topic-partition-discovery.interval` | `300000` | Re-check for new partitions every 5 minutes |
| `properties.connections.max.idle.ms` | `180000` | AdminClient connection idle timeout (see Section 13) |

### Timestamp Fields

Debezium sends PostgreSQL `TIMESTAMP WITH TIME ZONE` columns as ISO 8601 strings:

```
"2026-02-26T18:58:09.811060Z"
```

Flink SQL cannot parse this directly with `TIMESTAMP(3)`. The source table declares `created_at` as `STRING` and converts it in the INSERT statement:

```sql
CAST(REPLACE(REPLACE(after.created_at, 'T', ' '), 'Z', '') AS TIMESTAMP(3))
-- Step 1: "2026-02-26T18:58:09.811060Z"
-- Step 2: REPLACE 'T' → "2026-02-26 18:58:09.811060Z"
-- Step 3: REPLACE 'Z' → "2026-02-26 18:58:09.811060"
-- Step 4: CAST        → TIMESTAMP(3) 2026-02-26 18:58:09.811
```

### Numeric Fields

Debezium Server is configured with:
```properties
debezium.source.decimal.handling.mode=double
```

This converts PostgreSQL `NUMERIC`/`DECIMAL` columns to JSON `float64`. In Flink SQL, these map to `DOUBLE`. No casting is needed.

---

## 7. Sink Tables — JDBC Connectors

Sink tables declare the PostgreSQL target schema and use `PRIMARY KEY NOT ENFORCED` to enable upsert mode.

### Orders Sink Table

```sql
CREATE TABLE sink_fact_orders (
  id         STRING,
  user_id    STRING,
  total      DOUBLE,
  status     STRING,
  created_at TIMESTAMP(3),
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'connector'                  = 'jdbc',
  'url'                        = 'jdbc:postgresql://analytics-db.analytics.svc.cluster.local:5432/analyticsdb?stringtype=unspecified',
  'table-name'                 = 'fact_orders',
  'username'                   = '${ANALYTICS_DB_USER}',
  'password'                   = '${ANALYTICS_DB_PASSWORD}',
  'sink.buffer-flush.max-rows' = '1',
  'sink.buffer-flush.interval' = '1s'
);
```

### Key Sink Table Options Explained

| Option | Value | Reason |
|--------|-------|--------|
| `PRIMARY KEY NOT ENFORCED` | on `id` | Enables upsert mode: `INSERT ... ON CONFLICT (id) DO UPDATE` |
| `?stringtype=unspecified` | in JDBC URL | Allows PostgreSQL to cast `VARCHAR → UUID` implicitly without explicit `::uuid` cast |
| `sink.buffer-flush.max-rows` | `1` | Flush immediately on every row (low-latency mode) |
| `sink.buffer-flush.interval` | `1s` | Also flush on timer (ensures no data stays buffered) |
| `TIMESTAMP(3)` | for timestamps | JDBC connector does not support `TIMESTAMP_LTZ(3)` — use plain `TIMESTAMP(3)` |

### Credential Injection

The JDBC sink uses `${ANALYTICS_DB_USER}` and `${ANALYTICS_DB_PASSWORD}` placeholders. These are substituted by `envsubst` before SQL submission:

```bash
# In the flink-sql-runner Job container
envsubst < /sql/pipeline.sql > /tmp/pipeline-resolved.sql
bin/sql-client.sh gateway -e ... -f /tmp/pipeline-resolved.sql
```

The actual values come from Kubernetes Secrets:
```yaml
- name: ANALYTICS_DB_USER
  valueFrom:
    secretKeyRef:
      name: analytics-db-secret
      key: POSTGRES_USER
```

---

## 8. Pipeline INSERT Statements

Each `INSERT INTO` statement creates one streaming job in Flink:

```
kafka_orders        → INSERT INTO → sink_fact_orders        [Job 1]
kafka_order_items   → INSERT INTO → sink_fact_order_items   [Job 2]
kafka_books         → INSERT INTO → sink_dim_books           [Job 3]
kafka_inventory     → INSERT INTO → sink_fact_inventory     [Job 4]
```

### Orders Pipeline

```sql
INSERT INTO sink_fact_orders
SELECT after.id, after.user_id, after.total, after.status,
       CAST(REPLACE(REPLACE(after.created_at, 'T', ' '), 'Z', '') AS TIMESTAMP(3))
FROM kafka_orders
WHERE after IS NOT NULL;
```

`WHERE after IS NOT NULL` filters out:
- DELETE events (`op = 'd'`): Debezium sets `after` to `null` on deletes
- Tombstone messages: Kafka compaction markers with null payload
- Schema change events from Debezium Server

### Order Items Pipeline

```sql
INSERT INTO sink_fact_order_items
SELECT after.id, after.order_id, after.book_id, after.quantity, after.price_at_purchase
FROM kafka_order_items
WHERE after IS NOT NULL;
```

No timestamp conversion needed — `order_items` has no timestamp columns in the analytics sink.

### Books Pipeline (Dimension Table)

```sql
INSERT INTO sink_dim_books
SELECT after.id, after.title, after.author, after.price, after.description,
       after.cover_url, after.isbn, after.genre, after.published_year,
       CAST(REPLACE(REPLACE(after.created_at, 'T', ' '), 'Z', '') AS TIMESTAMP(3))
FROM kafka_books
WHERE after IS NOT NULL;
```

`dim_books` is the dimension table. It is populated during Debezium's initial snapshot (all 10 books) and kept updated by subsequent CDC events.

### Inventory Pipeline

```sql
INSERT INTO sink_fact_inventory
SELECT after.book_id, after.quantity, after.reserved,
       CAST(REPLACE(REPLACE(after.updated_at, 'T', ' '), 'Z', '') AS TIMESTAMP(3))
FROM kafka_inventory
WHERE after IS NOT NULL;
```

This pipeline reads from the `inventory-connector.public.inventory` topic (produced by `debezium-server-inventory`).

### Operator Execution Graph

When all 4 INSERT statements are submitted together, Flink compiles them into one execution plan. The Web Dashboard shows the dataflow graph:

```
[KafkaSource: kafka_orders] → [Calc] → [SinkFunction: JdbcDynamicTableSink]
[KafkaSource: kafka_books]  → [Calc] → [SinkFunction: JdbcDynamicTableSink]
...
```

Each source-to-sink path runs on one TaskManager slot. With `parallelism.default: 1` and `taskmanager.numberOfTaskSlots: 4`, all 4 pipelines run concurrently.

---

## 9. Checkpoint and Fault Tolerance

### Configuration

```yaml
state.backend.type: hashmap           # In-memory state (appropriate for stateless pipelines)
execution.checkpointing.dir: file:///opt/flink/checkpoints
execution.checkpointing.interval: 30s  # Checkpoint every 30 seconds
execution.checkpointing.mode: EXACTLY_ONCE
```

### How Checkpointing Works

1. JobManager triggers a checkpoint by injecting a **barrier** into each Kafka partition's event stream.
2. Each operator processes all events before the barrier, then snapshots its state.
3. The JDBC sink flushes buffered rows to PostgreSQL before acknowledging the checkpoint.
4. Once all operators report success, the checkpoint is complete and durable.
5. Kafka consumer offsets are included in the checkpoint (not committed to Kafka separately).

```
Time →
[Event A] [Event B] [Barrier CP-42] [Event C] [Event D] [Barrier CP-43]
           ↑                          ↑
   CP-42 starts here           CP-43 starts here
   State snapshot taken        Previous state confirmed durable
```

### Recovery

If the TaskManager crashes:
1. JobManager detects the lost heartbeat.
2. Waits for a new TaskManager (or restarts the pod via Kubernetes).
3. Restores operator state from the latest completed checkpoint.
4. Kafka source seeks back to the offset stored in the checkpoint.
5. Replays events from the checkpoint position.
6. JDBC sink uses upsert (ON CONFLICT DO UPDATE) — re-processing the same events is safe.

The PVC at `/opt/flink/checkpoints` survives pod restarts because it is backed by a host directory (`data/flink/`). After Kubernetes restarts the pod, Flink automatically recovers from the last checkpoint.

### Checkpoint Storage

```
data/flink/                         (host path)
└── flink-checkpoints/
    └── <job-id>/
        └── chk-1/
        └── chk-2/
        └── chk-42/                 (latest)
            ├── _metadata           (checkpoint metadata)
            └── ...                 (operator state files)
```

---

## 10. SQL Submission Process

The SQL pipeline is submitted by a **Kubernetes Job** (`flink-sql-runner`) that runs to completion and exits.

**File**: `infra/flink/flink-sql-runner.yaml`

### Submission Flow

```
kubectl apply -f flink-sql-runner.yaml
         │
         v
[initContainer: wait-for-sql-gateway]
  Polls: curl http://flink-jobmanager:9091/v1/info
  Retries every 5s until SQL Gateway responds
         │
         v
[container: sql-runner]
  1. envsubst < /sql/pipeline.sql > /tmp/pipeline-resolved.sql
     (replaces ${ANALYTICS_DB_USER} and ${ANALYTICS_DB_PASSWORD})
  2. bin/sql-client.sh gateway \
       -e http://flink-jobmanager:9091 \
       -f /tmp/pipeline-resolved.sql
     (submits all CREATE TABLE + INSERT INTO statements)
  3. Exits 0 on success
         │
         v
[SQL Gateway]
  Parses SQL statements
  For each CREATE TABLE: registers table in session catalog
  For each INSERT INTO: submits a streaming job to JobManager
         │
         v
[JobManager]
  Compiles each INSERT INTO to an operator DAG
  Assigns tasks to TaskManager slots
  4 streaming jobs start RUNNING
```

### The ConfigMap Pattern

The SQL lives in a ConfigMap so changes can be deployed without rebuilding the Docker image:

```yaml
# infra/flink/flink-sql-runner.yaml
kind: ConfigMap
metadata:
  name: flink-pipeline-sql
data:
  pipeline.sql: |
    -- full SQL content here
```

This ConfigMap is mounted as a volume at `/sql/pipeline.sql` in the sql-runner Job.

### Re-submitting the Pipeline

The sql-runner Job is immutable in Kubernetes — once it completes, it cannot be re-run. To resubmit:

```bash
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=180s
```

**Important**: Resubmitting the pipeline to a running cluster ADDS new jobs. It does not replace the existing ones. Always stop existing jobs first if making schema changes:

```bash
# Stop all running jobs via REST API
for job_id in $(curl -sf http://localhost:32200/jobs | python3 -c "import sys,json; [print(j['id']) for j in json.load(sys.stdin)['jobs']]"); do
  curl -X PATCH "http://localhost:32200/jobs/${job_id}?mode=cancel"
done

# Then resubmit
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f infra/flink/flink-sql-runner.yaml
```

---

## 11. Analytics Database Schema

**File**: `analytics/schema/analytics-ddl.sql`

The analytics DB schema must be applied BEFORE Flink starts. The JDBC sink requires that target tables exist.

### Fact and Dimension Tables

```sql
CREATE TABLE IF NOT EXISTS dim_books (
    id             UUID PRIMARY KEY,
    title          VARCHAR(255),
    author         VARCHAR(255),
    price          DOUBLE PRECISION,
    description    TEXT,
    cover_url      TEXT,
    isbn           VARCHAR(20),
    genre          VARCHAR(100),
    published_year INT,
    created_at     TIMESTAMP WITH TIME ZONE,
    synced_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fact_orders (
    id         UUID PRIMARY KEY,
    user_id    VARCHAR(255),
    total      DOUBLE PRECISION,
    status     VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE,
    synced_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fact_order_items (
    id                UUID PRIMARY KEY,
    order_id          UUID,
    book_id           UUID,
    quantity          INT,
    price_at_purchase DOUBLE PRECISION,
    synced_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fact_inventory (
    book_id    UUID PRIMARY KEY,
    quantity   INT,
    reserved   INT,
    updated_at TIMESTAMP WITH TIME ZONE,
    synced_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

**Design decisions**:
- **No FK constraints**: CDC delivery order is not guaranteed (books row may arrive after order_items row). FKs would cause constraint violations on out-of-order delivery.
- **Upsert safe**: All tables have UUIDs as primary keys. JDBC connector generates `INSERT ... ON CONFLICT (id) DO UPDATE SET ...`. Re-processing is idempotent.
- **`synced_at`**: Added by PostgreSQL default, not by Flink. Tracks when a row was last written to analytics-db.

### Analytical Views (10 total)

| View | Purpose | Used By |
|------|---------|---------|
| `vw_product_sales_volume` | Units sold + revenue per book | Book Store Analytics dashboard |
| `vw_sales_over_time` | Daily revenue trend | Sales & Revenue dashboard |
| `vw_revenue_by_author` | Revenue grouped by author | Sales & Revenue dashboard |
| `vw_revenue_by_genre` | Revenue grouped by genre | Sales & Revenue dashboard |
| `vw_order_status_distribution` | Orders by status (PENDING/COMPLETED/CANCELLED) | Sales & Revenue dashboard |
| `vw_inventory_health` | Stock levels with Critical/Low/OK labels | Inventory Analytics dashboard |
| `vw_avg_order_value` | Daily average order value | Sales & Revenue dashboard |
| `vw_top_books_by_revenue` | Top revenue-generating books with rank | Book Store Analytics dashboard |
| `vw_inventory_turnover` | (units sold / stock) × 100 per book | Inventory Analytics dashboard |
| `vw_book_price_distribution` | Books bucketed into price ranges | Inventory Analytics dashboard |

Example — Inventory Health view:

```sql
CREATE OR REPLACE VIEW vw_inventory_health AS
SELECT
    b.title,
    b.author,
    i.quantity AS stock_quantity,
    i.reserved,
    GREATEST(i.quantity - i.reserved, 0) AS available,
    CASE
        WHEN GREATEST(i.quantity - i.reserved, 0) = 0 THEN 'Critical'
        WHEN GREATEST(i.quantity - i.reserved, 0) <= 3 THEN 'Low'
        ELSE 'OK'
    END AS stock_status
FROM fact_inventory i
JOIN dim_books b ON b.id = i.book_id
ORDER BY available ASC;
```

---

## 12. Flink Web Dashboard

Access the Flink Web Dashboard at **http://localhost:32200**.

The dashboard is the primary tool for monitoring and operating the streaming pipeline.

### Overview Page

```
http://localhost:32200/

+──────────────────────────────────────────────────────────────+
│ Apache Flink Dashboard         Flink 1.20.0                  │
├──────────────┬───────────────────────────────────────────────┤
│ Overview     │ Running Jobs: 4                               │
│              │ Total Task Slots: 4                           │
│              │ Available Task Slots: 0                       │
│              │ TaskManagers: 1                               │
│              │ Finished Jobs: 0  Failed Jobs: 0              │
├──────────────┴───────────────────────────────────────────────┤
│ Running Jobs                                                  │
│  [RUNNING]  INSERT INTO sink_fact_orders ...      12m 33s    │
│  [RUNNING]  INSERT INTO sink_fact_order_items ... 12m 33s    │
│  [RUNNING]  INSERT INTO sink_dim_books ...        12m 33s    │
│  [RUNNING]  INSERT INTO sink_fact_inventory ...   12m 33s    │
└──────────────────────────────────────────────────────────────+
```

### Job Detail Page

Clicking a job reveals:
- **Dataflow graph**: visual operator DAG with parallelism and status
- **Timeline**: when each subtask started, duration
- **Metrics**: records-in/out per second, bytes in/out, backpressure ratio
- **Checkpoints**: history of completed/failed checkpoints with duration and size
- **Exceptions**: recent task-level errors and recovery attempts

### REST API Reference

The REST API mirrors the dashboard and supports automation:

```bash
# List all running jobs
curl -sf http://localhost:32200/jobs | python3 -m json.tool

# Get job details
curl -sf http://localhost:32200/jobs/<job-id> | python3 -m json.tool

# Get checkpoint details for a job
curl -sf http://localhost:32200/jobs/<job-id>/checkpoints | python3 -m json.tool

# Get metrics for a job's vertex
curl -sf "http://localhost:32200/jobs/<job-id>/vertices/<vertex-id>/metrics?get=Records.numRecordsOut"

# Cancel a job
curl -X PATCH "http://localhost:32200/jobs/<job-id>?mode=cancel"

# Get JobManager overview (cluster health)
curl -sf http://localhost:32200/overview | python3 -m json.tool
```

---

## 13. Production Resilience Patterns

### AdminClient Connection Resilience

This is the most important production fix in the pipeline configuration.

**The Problem**: Flink's Kafka connector uses an AdminClient for partition discovery. By default, discovery runs every 300 seconds (5 minutes). The AdminClient connection sits idle during this interval. In kind (running inside Docker), connections go through Docker's NAT layer which silently expires idle TCP connections after ~4 minutes. When the AdminClient tries to reuse the expired connection, it hits a race condition in Kafka KRaft metadata handling, producing `UnknownTopicOrPartitionException`. Flink retries but may lose partition assignments temporarily.

**The Fix**: Configure the AdminClient to proactively close its connection after 3 minutes (180,000ms) — shorter than the NAT expiry time. Each 5-minute discovery cycle then opens a fresh connection instead of reusing a potentially stale one:

```sql
-- Applied to all 4 source tables
'scan.topic-partition-discovery.interval'           = '300000',  -- 5 min discovery
'properties.connections.max.idle.ms'                = '180000',  -- 3 min idle → close before NAT expires
'properties.reconnect.backoff.ms'                   = '1000',
'properties.reconnect.backoff.max.ms'               = '10000',
'properties.request.timeout.ms'                     = '30000',
'properties.socket.connection.setup.timeout.ms'     = '10000',
'properties.socket.connection.setup.timeout.max.ms' = '30000',
'properties.metadata.max.age.ms'                    = '300000'
```

**Kafka broker side** (complements the client-side fix):
```yaml
# infra/kafka/kafka.yaml
KAFKA_CONNECTIONS_MAX_IDLE_MS: "600000"   # 10 min idle timeout on broker
KAFKA_SOCKET_KEEPALIVE_ENABLE: "true"    # TCP keepalives
```

### Exactly-Once Delivery

The pipeline achieves exactly-once delivery via the coordination of:

1. **Kafka consumer**: Sources are transactional; offsets stored in Flink checkpoint (not Kafka `__consumer_offsets`)
2. **Flink barrier checkpointing**: All operators align to a barrier before snapshotting state
3. **JDBC sink upsert**: `INSERT ... ON CONFLICT (id) DO UPDATE` makes re-processing idempotent
4. **Checkpoint on PVC**: Survives pod restarts; Flink recovers from last barrier position

### Partition Discovery

`scan.topic-partition-discovery.interval = '300000'` is enabled (non-zero). This means Flink periodically calls Kafka AdminClient to check if new partitions were added to the topics. This is the production-correct behavior — if Kafka topic partitions are scaled up, Flink automatically starts consuming from new partitions without job restart.

**Note**: Partition discovery handles *partition scaling* only. Adding a *new Kafka topic* always requires adding a new source table and INSERT statement, plus job resubmission.

---

## 14. Customization Guide

### 14.1 Adding a New Table to the Pipeline

This is the most common customization. Follow all 5 steps:

**Example**: Add CDC from `public.reviews` table in ecom-db.

**Step 1: Add DB migration** (ecom-service Liquibase):
```xml
<!-- ecom-service/src/main/resources/db/changelog/006-create-reviews.yaml -->
- createTable:
    tableName: reviews
    columns:
      - column: {name: id, type: UUID, defaultValueComputed: gen_random_uuid()}
      - column: {name: book_id, type: UUID}
      - column: {name: user_id, type: VARCHAR(255)}
      - column: {name: rating, type: INT}
      - column: {name: comment, type: TEXT}
      - column: {name: created_at, type: TIMESTAMP WITH TIME ZONE, defaultValueComputed: NOW()}
```

**Step 2: Update Debezium Server config** (add table to include list):
```properties
# In infra/debezium/debezium-server-ecom.yaml ConfigMap
debezium.source.table.include.list=public.orders,public.order_items,public.books,public.reviews
```

```bash
kubectl apply -f infra/debezium/debezium-server-ecom.yaml
kubectl rollout restart deployment/debezium-server-ecom -n infra
```

**Step 3: Create Kafka topic** (add to kafka-topics-init.yaml):
```yaml
# In infra/kafka/kafka-topics-init.yaml Job spec
kafka-topics --bootstrap-server localhost:9092 --create \
  --topic ecom-connector.public.reviews --partitions 1 --replication-factor 1 || true
```

**Step 4: Add DDL to analytics-db**:
```sql
-- analytics/schema/analytics-ddl.sql
CREATE TABLE IF NOT EXISTS fact_reviews (
    id         UUID PRIMARY KEY,
    book_id    UUID,
    user_id    VARCHAR(255),
    rating     INT,
    comment    TEXT,
    created_at TIMESTAMP WITH TIME ZONE
);
```

Apply it:
```bash
cat analytics/schema/analytics-ddl.sql | kubectl exec -i -n analytics deploy/analytics-db \
  -- psql -U analyticsuser -d analyticsdb
```

**Step 5: Add to Flink SQL pipeline** (both files):

In `analytics/flink/sql/pipeline.sql`:
```sql
-- Source table
CREATE TABLE kafka_reviews (
  after ROW<
    id         STRING,
    book_id    STRING,
    user_id    STRING,
    rating     INT,
    comment    STRING,
    created_at STRING
  >,
  op STRING
) WITH (
  'connector'                               = 'kafka',
  'topic'                                   = 'ecom-connector.public.reviews',
  'properties.bootstrap.servers'            = 'kafka.infra.svc.cluster.local:9092',
  'properties.group.id'                     = 'flink-analytics-consumer',
  'format'                                  = 'json',
  'json.ignore-parse-errors'                = 'true',
  'scan.startup.mode'                       = 'earliest-offset',
  'scan.topic-partition-discovery.interval' = '300000',
  'properties.connections.max.idle.ms'      = '180000',
  'properties.reconnect.backoff.ms'         = '1000',
  'properties.reconnect.backoff.max.ms'     = '10000',
  'properties.request.timeout.ms'           = '30000',
  'properties.socket.connection.setup.timeout.ms'     = '10000',
  'properties.socket.connection.setup.timeout.max.ms' = '30000',
  'properties.metadata.max.age.ms'          = '300000'
);

-- Sink table
CREATE TABLE sink_fact_reviews (
  id         STRING,
  book_id    STRING,
  user_id    STRING,
  rating     INT,
  comment    STRING,
  created_at TIMESTAMP(3),
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'connector'                  = 'jdbc',
  'url'                        = 'jdbc:postgresql://analytics-db.analytics.svc.cluster.local:5432/analyticsdb?stringtype=unspecified',
  'table-name'                 = 'fact_reviews',
  'username'                   = '${ANALYTICS_DB_USER}',
  'password'                   = '${ANALYTICS_DB_PASSWORD}',
  'sink.buffer-flush.max-rows' = '1',
  'sink.buffer-flush.interval' = '1s'
);

-- Pipeline
INSERT INTO sink_fact_reviews
SELECT after.id, after.book_id, after.user_id, after.rating, after.comment,
       CAST(REPLACE(REPLACE(after.created_at, 'T', ' '), 'Z', '') AS TIMESTAMP(3))
FROM kafka_reviews
WHERE after IS NOT NULL;
```

Copy the same content into the `flink-pipeline-sql` ConfigMap in `infra/flink/flink-sql-runner.yaml`.

Resubmit the pipeline:
```bash
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=180s
```

### 14.2 Adding a Transformation

Suppose you want to enrich the orders sink with a `revenue_tier` classification:

```sql
-- Modify the INSERT INTO sink_fact_orders statement
INSERT INTO sink_fact_orders
SELECT
  after.id,
  after.user_id,
  after.total,
  after.status,
  CAST(REPLACE(REPLACE(after.created_at, 'T', ' '), 'Z', '') AS TIMESTAMP(3)),
  CASE
    WHEN after.total >= 100.0 THEN 'HIGH'
    WHEN after.total >= 50.0  THEN 'MEDIUM'
    ELSE 'LOW'
  END AS revenue_tier   -- new column
FROM kafka_orders
WHERE after IS NOT NULL;
```

Also add `revenue_tier VARCHAR(10)` to the `sink_fact_orders` table definition and the `fact_orders` DDL in analytics-db.

### 14.3 Increasing Parallelism

The current pipeline runs at `parallelism.default: 1`. To increase throughput, raise parallelism to 2:

```yaml
# In flink-cluster.yaml FLINK_PROPERTIES
parallelism.default: 2
taskmanager.numberOfTaskSlots: 8   # 2 parallelism × 4 tables = 8 slots needed
taskmanager.memory.process.size: 1536m
```

Also update the TaskManager resource requests/limits accordingly.

Parallelism can also be set per-table:
```sql
-- Override in the INSERT statement
INSERT INTO sink_fact_orders /*+ OPTIONS('parallelism' = '2') */
SELECT ...
```

### 14.4 Changing Checkpoint Interval

For higher throughput at the cost of longer recovery time (more events to replay):

```yaml
# Reduce checkpoint frequency from 30s to 5 minutes
execution.checkpointing.interval: 300s
```

For lower latency but higher checkpoint overhead:
```yaml
execution.checkpointing.interval: 10s
```

### 14.5 Adding a Lookup Join (Enrichment)

Flink SQL supports lookup joins for real-time enrichment. For example, enriching order events with the book title at write time:

```sql
-- Declare books as a lookup table (JDBC connector)
CREATE TABLE lookup_books (
  id    STRING,
  title STRING,
  genre STRING,
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'connector'         = 'jdbc',
  'url'               = 'jdbc:postgresql://ecom-db.ecom.svc.cluster.local:5432/ecomdb?stringtype=unspecified',
  'table-name'        = 'books',
  'username'          = '${ECOM_DB_USER}',
  'password'          = '${ECOM_DB_PASSWORD}',
  'lookup.cache.max-rows' = '1000',
  'lookup.cache.ttl'      = '60s'
);

-- Enriched insert using FOR SYSTEM_TIME AS OF
INSERT INTO sink_fact_order_items_enriched
SELECT
  oi.after.id,
  oi.after.order_id,
  oi.after.book_id,
  b.title AS book_title,
  b.genre,
  oi.after.quantity,
  oi.after.price_at_purchase
FROM kafka_order_items AS oi
LEFT JOIN lookup_books FOR SYSTEM_TIME AS OF PROCTIME() AS b
  ON oi.after.book_id = b.id
WHERE oi.after IS NOT NULL;
```

**Note**: Lookup joins introduce a dependency on the source service DB from the analytics pipeline. Use with caution in production.

---

## 15. Operations Guide

### Verify Cluster Health

```bash
# Check pod status
kubectl get pods -n analytics

# Expected output:
# NAME                                  READY   STATUS    RESTARTS
# analytics-db-xxx                      1/1     Running   0
# flink-jobmanager-xxx                  2/2     Running   0   ← 2 containers (jm + sql-gateway)
# flink-taskmanager-xxx                 1/1     Running   0

# Check all 4 jobs are RUNNING
curl -sf http://localhost:32200/jobs | python3 -c "
import sys, json
jobs = json.load(sys.stdin)['jobs']
print(f'Jobs: {len(jobs)}')
for j in jobs:
    print(f\"  {j['id']}: {j['status']}\")
"
```

### Verify CDC is Working

```bash
# Use the built-in verify script
bash scripts/verify-cdc.sh

# Manual check: insert a test order and poll analytics-db
kubectl exec -n ecom deploy/ecom-db -- psql -U ecomuser -d ecomdb \
  -c "INSERT INTO orders (id, user_id, total, status, created_at) VALUES (gen_random_uuid(), 'test', 9.99, 'PENDING', NOW())"

# Poll analytics-db (should appear within 1-2 seconds)
for i in $(seq 1 10); do
  COUNT=$(kubectl exec -n analytics deploy/analytics-db -- psql -U analyticsuser -d analyticsdb \
    -t -c "SELECT COUNT(*) FROM fact_orders WHERE status='PENDING'")
  echo "Attempt $i: $COUNT rows"
  [ "$COUNT" -gt 0 ] && break
  sleep 2
done
```

### Restart After Cluster Recovery

After Docker Desktop restart, Flink jobs are lost (JM memory is cleared):

```bash
# 1. Wait for JM + TM pods to be Running
kubectl rollout status deployment/flink-jobmanager -n analytics --timeout=120s
kubectl rollout status deployment/flink-taskmanager -n analytics --timeout=120s

# 2. Wait for SQL Gateway
until curl -sf http://localhost:32200/overview > /dev/null 2>&1; do
  sleep 5; echo "Waiting for JobManager..."
done

# 3. Re-submit pipeline
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=180s
```

The Flink checkpoint files on PVC are still valid. Flink will automatically recover state and resume from the last checkpoint offset.

### View Job Logs

```bash
# JobManager logs (coordinator activity, checkpoint events)
kubectl logs -n analytics deploy/flink-jobmanager -c jobmanager --tail=100

# SQL Gateway logs (SQL submission, query parsing)
kubectl logs -n analytics deploy/flink-jobmanager -c sql-gateway --tail=100

# TaskManager logs (operator execution, errors)
kubectl logs -n analytics deploy/flink-taskmanager --tail=100

# sql-runner Job logs (submission output)
kubectl logs -n analytics -l job-name=flink-sql-runner
```

### Monitor Checkpoints

```bash
# List checkpoint summary for all running jobs
curl -sf http://localhost:32200/jobs | python3 -c "
import sys, json, subprocess
jobs = json.load(sys.stdin)['jobs']
for j in [x for x in jobs if x['status'] == 'RUNNING']:
    result = subprocess.run(
        ['curl', '-sf', f\"http://localhost:32200/jobs/{j['id']}/checkpoints\"],
        capture_output=True, text=True
    )
    cp = json.loads(result.stdout)
    latest = cp.get('latest', {}).get('completed', {})
    print(f\"Job {j['id'][:8]}: checkpoint #{latest.get('id','?')} at {latest.get('trigger_timestamp','?')}\")
"
```

---

## 16. Troubleshooting

### Jobs Not Appearing After Submission

**Symptom**: `curl /jobs` returns empty array after flink-sql-runner completes.

**Cause 1**: SQL Gateway was not ready when submission ran.
**Fix**: Check sql-runner pod logs. If it shows "SQL Gateway not ready", wait 30s and resubmit.

**Cause 2**: TaskManager is not registered with JobManager.
**Fix**:
```bash
kubectl rollout restart deployment/flink-taskmanager -n analytics
sleep 30
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f infra/flink/flink-sql-runner.yaml
```

### `UnknownTopicOrPartitionException` in Logs

**Symptom**: TaskManager logs contain `UnknownTopicOrPartitionException` every 5 minutes.

**Cause**: AdminClient connection expired by NAT before partition discovery ran.
**Fix**: Ensure all 7 connection resilience properties are set on source tables (see Section 13). These are already set in the current pipeline.

### Jobs FAILING Repeatedly

**Symptom**: Job shows status RESTARTING or FAILED in the dashboard.

```bash
# Get exception details
curl -sf http://localhost:32200/jobs/<job-id>/exceptions | python3 -m json.tool
```

**Common causes**:
- analytics-db unreachable: `kubectl get pods -n analytics -l app=analytics-db`
- JDBC credential mismatch: verify `${ANALYTICS_DB_USER}` was substituted correctly
- Table does not exist: apply DDL before submitting pipeline

### Checkpoint Failures

**Symptom**: Checkpoint history shows `FAILED` status.

```bash
# Check checkpoint failure reason
curl -sf http://localhost:32200/jobs/<job-id>/checkpoints | \
  python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin).get('latest',{}), indent=2))"
```

**Cause**: PVC is full or not mounted.
**Fix**: `kubectl exec -n analytics deploy/flink-jobmanager -- df -h /opt/flink/checkpoints`

### Pipeline Producing Stale Data

**Symptom**: `fact_orders` in analytics-db is missing recent orders.

1. Verify Debezium Server is healthy: `curl http://localhost:32300/q/health`
2. Check Kafka topic has new messages:
   ```bash
   kubectl exec -n infra deploy/kafka -- kafka-console-consumer \
     --bootstrap-server localhost:9092 \
     --topic ecom-connector.public.orders \
     --from-beginning --max-messages 3
   ```
3. Check Flink job is consuming:
   ```bash
   curl -sf http://localhost:32200/jobs/<job-id>/vertices | python3 -m json.tool
   # Look for numRecordsIn > 0 on Kafka source vertex
   ```

---

## 17. Screenshot Reference

The following sections of the Flink Web Dashboard are referenced in this document:

| Screenshot | URL | What to Look For |
|------------|-----|-----------------|
| Overview | `http://localhost:32200/` | Running Jobs: 4, Available Slots: 0 |
| Job List | `http://localhost:32200/#/job/running` | All 4 jobs in RUNNING state |
| Job Graph | `http://localhost:32200/jobs/<id>` | Operator DAG: Kafka source → filter → JDBC sink |
| Checkpoints | `http://localhost:32200/jobs/<id>/checkpoints` | Latest checkpoint: COMPLETED, age < 60s |
| TaskManager | `http://localhost:32200/taskmanagers` | 1 TM, Slots: 4 total / 4 used |
| Metrics | `http://localhost:32200/jobs/<id>/metrics` | Records In/Out > 0 after data insert |

---

## Related Documents

- `docs/cdc/debezium-flink-cdc.md` — architecture overview of the full CDC pipeline
- `docs/cdc/debezium-server-guide.md` — Debezium Server configuration and operations
- `docs/cdc/step-by-step-flink-upgrade-and-debezium-server-migration.md` — migration guide from Kafka Connect + Flink 1.18 to Debezium Server + Flink 1.20
- `docs/operations/stability-issues-and-fixes.md` — all production stability fixes (Issues 1–17)
- `analytics/flink/sql/pipeline.sql` — authoritative SQL pipeline source
- `infra/flink/flink-sql-runner.yaml` — Kubernetes manifests (ConfigMap + Job)
- `infra/flink/flink-cluster.yaml` — JobManager + TaskManager Deployments and Services
