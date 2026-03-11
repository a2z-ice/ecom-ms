# How Apache Flink Works as Both Source and Sink in the CDC Pipeline

## Overview

Yes — Apache Flink acts as **both source and sink** simultaneously in this platform's CDC pipeline. This is one of Flink's core design principles: every pipeline has two sides, and Flink bridges them.

- **Source side**: Flink *reads from* Kafka topics (which contain Debezium CDC events)
- **Sink side**: Flink *writes to* the PostgreSQL analytics database via JDBC

Neither side is an application you write. Both are **connector plugins** declared entirely in SQL. Flink's runtime handles all the polling, buffering, retrying, offset tracking, and upsert logic automatically.

This document explains what "source" and "sink" mean in Flink's model, how each connector works internally, how they are connected by a streaming pipeline, and walks through the complete end-to-end flow step by step with the actual code from this platform.

---

## Table of Contents

1. [The Source–Sink Mental Model](#1-the-sourcesink-mental-model)
2. [What "Source" Means in Flink](#2-what-source-means-in-flink)
3. [What "Sink" Means in Flink](#3-what-sink-means-in-flink)
4. [The Connector Bridge](#4-the-connector-bridge)
5. [Step-by-Step: How a Row Travels from PostgreSQL to Analytics DB](#5-step-by-step-how-a-row-travels-from-postgresql-to-analytics-db)
6. [Deep Dive: The Kafka Source Connector](#6-deep-dive-the-kafka-source-connector)
7. [Deep Dive: The JDBC Sink Connector](#7-deep-dive-the-jdbc-sink-connector)
8. [How INSERT INTO Connects Source to Sink](#8-how-insert-into-connects-source-to-sink)
9. [What Happens Inside the TaskManager](#9-what-happens-inside-the-taskmanager)
10. [Exactly-Once: How Source and Sink Coordinate](#10-exactly-once-how-source-and-sink-coordinate)
11. [The Four Parallel Pipelines](#11-the-four-parallel-pipelines)
12. [Operator Execution Graph](#12-operator-execution-graph)
13. [Can Flink Replace Debezium?](#13-can-flink-replace-debezium)
14. [Step-by-Step: Replacing Debezium with Flink CDC in This Platform](#14-step-by-step-replacing-debezium-with-flink-cdc-in-this-platform)
15. [Is It a Good Idea? Production-Grade Analysis](#15-is-it-a-good-idea-production-grade-analysis)
16. [Step-by-Step: Adding a New Source-to-Sink Pipeline](#16-step-by-step-adding-a-new-source-to-sink-pipeline)
17. [Common Misunderstandings](#17-common-misunderstandings)

---

## 1. The Source–Sink Mental Model

Think of Flink as a **pipe** with an intake on one end and an outlet on the other:

```
[ External System A ]  →  [ Flink Source ]  →  [ Processing ]  →  [ Flink Sink ]  →  [ External System B ]
```

In this platform:

```
[ Kafka topic ]  →  [ Kafka Source Connector ]  →  [ Filter + Transform ]  →  [ JDBC Sink Connector ]  →  [ PostgreSQL ]
```

Flink itself does not *store* the data permanently. It moves data from one external system (Kafka) to another (PostgreSQL), applying transformations in the middle. The source and sink connectors are the adapters that translate Flink's internal data model to and from the external systems' protocols.

### Why This Design?

Without Flink, you would have to write application code that:
1. Connects to Kafka and polls messages
2. Parses JSON
3. Deduplicates events
4. Handles retries on DB failure
5. Tracks which Kafka offsets have been committed to the DB
6. Recovers correctly after a crash

Flink's source and sink connectors handle all of this. You declare **what** you want (SQL), not **how** to do it.

---

## 2. What "Source" Means in Flink

A **source** in Flink is any external system that Flink reads data *from*. In Flink SQL, a source is declared as a `CREATE TABLE` statement with a `WITH ('connector' = '...')` clause.

The source table is **not a real table** in any database. It is a **virtual schema** that tells Flink:
- Which connector plugin to load
- How to connect to the external system
- What the data looks like (column names and types)
- How to deserialize the raw bytes into Flink rows

When a source table appears in a `SELECT` or `INSERT INTO ... SELECT`, Flink:
1. Instantiates the source connector
2. Connects to the external system (Kafka broker)
3. Continuously polls for new records
4. Deserializes each record into a Flink row matching the declared schema
5. Passes the row downstream to the next operator

### Source Table in This Platform

```sql
-- This is a SOURCE table — Flink reads FROM Kafka
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
  'connector'          = 'kafka',                               -- connector plugin
  'topic'              = 'ecom-connector.public.orders',         -- Kafka topic
  'properties.bootstrap.servers' = 'kafka.infra.svc.cluster.local:9092',
  'properties.group.id'          = 'flink-analytics-consumer',  -- consumer group
  'format'             = 'json',                                -- deserializer
  'json.ignore-parse-errors'     = 'true',                      -- skip malformed messages
  'scan.startup.mode'            = 'earliest-offset',           -- start from beginning
  'scan.topic-partition-discovery.interval' = '300000',         -- check for new partitions every 5 min
  'properties.connections.max.idle.ms'      = '180000'          -- close idle connections (NAT fix)
  -- ... + 5 more resilience properties
);
```

The schema (`after ROW<...>`, `op STRING`) maps to the JSON structure of Debezium's CDC envelope. Flink uses this schema to know which JSON fields to extract. It does not validate or enforce types — if a field is missing or mistyped, `json.ignore-parse-errors: true` causes Flink to skip the row.

### What "Source" Does NOT Mean

- Flink does **not write** to a source table
- Flink does **not create** the Kafka topic
- Flink does **not store** data in the source table
- The source table only exists in Flink's session catalog (in memory) during the job's lifetime

---

## 3. What "Sink" Means in Flink

A **sink** in Flink is any external system that Flink writes data *to*. Like sources, sinks are declared as `CREATE TABLE` statements with a connector clause.

The sink table is also **not a real table** in the sense of a data-store inside Flink. It is a connector configuration that Flink uses to write rows to the external system (PostgreSQL).

When a sink table appears after `INSERT INTO`, Flink:
1. Instantiates the sink connector
2. Establishes a JDBC connection to PostgreSQL
3. Receives processed rows from the upstream operator
4. Buffers them in a small internal buffer
5. Flushes the buffer to PostgreSQL as SQL statements

### Sink Table in This Platform

```sql
-- This is a SINK table — Flink writes TO PostgreSQL
CREATE TABLE sink_fact_orders (
  id         STRING,
  user_id    STRING,
  total      DOUBLE,
  status     STRING,
  created_at TIMESTAMP(3),
  PRIMARY KEY (id) NOT ENFORCED  -- enables upsert mode
) WITH (
  'connector'                  = 'jdbc',                         -- connector plugin
  'url'                        = 'jdbc:postgresql://analytics-db.analytics.svc.cluster.local:5432/analyticsdb?stringtype=unspecified',
  'table-name'                 = 'fact_orders',                  -- physical PostgreSQL table
  'username'                   = '${ANALYTICS_DB_USER}',
  'password'                   = '${ANALYTICS_DB_PASSWORD}',
  'sink.buffer-flush.max-rows' = '1',                            -- flush every row immediately
  'sink.buffer-flush.interval' = '1s'                            -- also flush on timer
);
```

`PRIMARY KEY (id) NOT ENFORCED` is the key that switches the JDBC connector from **append mode** into **upsert mode**:

| Mode | Trigger | Generated SQL |
|------|---------|---------------|
| Append mode | No PRIMARY KEY declared | `INSERT INTO fact_orders VALUES (...)` |
| Upsert mode | PRIMARY KEY declared | `INSERT INTO fact_orders VALUES (...) ON CONFLICT (id) DO UPDATE SET ...` |

Upsert mode means re-processing the same CDC event twice (e.g., after a crash recovery) is safe — the second write just updates the row to the same values.

---

## 4. The Connector Bridge

Flink acts as the bridge between source and sink. The bridge has three layers:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Flink TaskManager                            │
│                                                                     │
│  ┌──────────────────┐    ┌───────────────┐    ┌──────────────────┐  │
│  │  Kafka Source    │    │   Operators   │    │   JDBC Sink      │  │
│  │  Connector       │    │               │    │   Connector      │  │
│  │                  │───>│ - Calc        │───>│                  │  │
│  │ - KafkaConsumer  │    │   (WHERE +    │    │ - BufferedWriter │  │
│  │ - JSON parser    │    │    field       │    │ - PreparedStmt   │  │
│  │ - Row builder    │    │    extraction) │    │ - UPSERT SQL     │  │
│  │ - Offset tracker │    │               │    │ - CP coordinator │  │
│  └──────────────────┘    └───────────────┘    └──────────────────┘  │
│         ↑                                              ↓             │
└─────────│──────────────────────────────────────────────│────────────┘
          │                                              │
     Kafka topics                              PostgreSQL analytics-db
  (read, track offset)                         (write, upsert rows)
```

The `INSERT INTO` SQL statement is the declaration that connects these three layers. Flink compiles it into this operator chain at job submission time.

---

## 5. Step-by-Step: How a Row Travels from PostgreSQL to Analytics DB

This is the complete journey of one database change from the moment a user places an order to when it appears in the analytics database.

---

### Step 1 — User Places an Order (Spring Boot → ecom-db)

A user clicks "Place Order" in the UI. The React frontend sends a `POST /ecom/checkout` request to the ecom-service Spring Boot application. Spring Boot creates a row in `ecom-db`:

```sql
-- ecom-db.public.orders (ecom namespace)
INSERT INTO orders (id, user_id, total, status, created_at)
VALUES (
  '7f3a2c91-0001-0001-0001-000000000001',
  '9d82bcb3-6e96-462c-bdb9-e677080e8920',
  49.99,
  'PENDING',
  '2026-03-06T10:22:10.123456+00:00'
);
```

PostgreSQL writes this INSERT to the **Write-Ahead Log (WAL)** with a Log Sequence Number (LSN), e.g., `0/15A3B30`. The WAL entry contains the full row data in binary format.

---

### Step 2 — Debezium Reads the WAL (ecom-db → Debezium Server pod)

The `debezium-server-ecom` pod (running in the `infra` namespace) maintains an open connection to `ecom-db` via the **pgoutput logical replication protocol**. PostgreSQL streams the WAL entry to Debezium through the replication slot `debezium_ecom_slot`.

Debezium decodes the binary WAL record:

```
WAL binary record (received from pgoutput):
  operation: INSERT
  relation:  public.orders
  new tuple: [id=7f3a..., user_id=9d82..., total=49.99, status=PENDING, created_at=...]
```

Debezium builds a **SourceRecord** (internal Debezium object):

```
SourceRecord {
  topic:  "ecom-connector.public.orders"
  key:    {"id": "7f3a2c91-0001-0001-0001-000000000001"}
  value:  {
    "before": null,
    "after": {
      "id": "7f3a2c91-0001-0001-0001-000000000001",
      "user_id": "9d82bcb3-6e96-462c-bdb9-e677080e8920",
      "total": 49.99,
      "status": "PENDING",
      "created_at": "2026-03-06T10:22:10.123456Z"
    },
    "op": "c",
    "source": {
      "version": "3.4.1.Final",
      "connector": "postgresql",
      "name": "ecom-connector",
      "ts_ms": 1741258930123,
      "snapshot": "false",
      "db": "ecomdb",
      "schema": "public",
      "table": "orders",
      "lsn": 22826800
    }
  }
}
```

---

### Step 3 — Debezium Publishes to Kafka (Debezium Server → Kafka)

Debezium's Kafka sink serializes the SourceRecord:
- Key: `org.apache.kafka.common.serialization.StringSerializer` → `{"id":"7f3a2c91-..."}`
- Value: `org.apache.kafka.common.serialization.StringSerializer` → the full JSON envelope

Debezium calls `KafkaProducer.send()`:

```
Kafka topic: ecom-connector.public.orders
Partition:   0  (determined by key hash)
Offset:      42 (assigned by Kafka broker)
Key:         {"id":"7f3a2c91-0001-0001-0001-000000000001"}
Value:       {"before":null,"after":{...},"op":"c","source":{...}}
```

Simultaneously, Debezium writes the WAL position to its offset file:
```
/debezium/data/offsets.dat:
  {"ecom-connector": {"sourcePartition": ..., "sourceOffset": {"lsn": 22826800}}}
```

This ensures if the pod restarts, it resumes from LSN `22826800` — not from the beginning.

---

### Step 4 — Flink Kafka Source Reads the Message

The Flink job (`INSERT INTO sink_fact_orders SELECT ... FROM kafka_orders`) is already running. The Kafka Source Connector is continuously polling the `ecom-connector.public.orders` topic in a loop:

```
KafkaConsumer.poll(timeout=100ms) → returns ConsumerRecords
```

The consumer finds the new record at offset 42 and passes it to the **JSON deserializer**. The deserializer uses the declared schema:

```sql
-- The schema tells Flink how to parse the JSON
CREATE TABLE kafka_orders (
  after ROW<id STRING, user_id STRING, total DOUBLE, status STRING, created_at STRING>,
  op STRING
)
```

The deserializer extracts:
```
Flink Row {
  after: Row { id="7f3a...", user_id="9d82...", total=49.99, status="PENDING", created_at="2026-03-06T10:22:10.123456Z" },
  op: "c"
}
```

Flink does **not** commit this Kafka offset yet. The offset is held in memory and only committed when the next checkpoint completes (see Step 7).

---

### Step 5 — Flink Applies the Transformation (Calc Operator)

The row passes through the **Calc operator** — Flink's name for a combined filter + projection operation. This operator executes the SQL logic from the `INSERT INTO` statement:

```sql
INSERT INTO sink_fact_orders
SELECT
  after.id,                    -- extract field from ROW type
  after.user_id,
  after.total,
  after.status,
  CAST(
    REPLACE(
      REPLACE(after.created_at, 'T', ' '),   -- "2026-03-06T10:22:10.123456Z" → "2026-03-06 10:22:10.123456Z"
      'Z', ''
    ),                                         -- → "2026-03-06 10:22:10.123456"
    AS TIMESTAMP(3)                            -- → TIMESTAMP 2026-03-06 10:22:10.123
  )
FROM kafka_orders
WHERE after IS NOT NULL;        -- filter: skip DELETE events and tombstones
```

The Calc operator checks `after IS NOT NULL` → true (this is an INSERT event with `op='c'`, so `after` contains data).

It produces a flat Flink row:
```
Flink Row (output) {
  id:         "7f3a2c91-0001-0001-0001-000000000001"
  user_id:    "9d82bcb3-6e96-462c-bdb9-e677080e8920"
  total:      49.99
  status:     "PENDING"
  created_at: TIMESTAMP(2026-03-06 10:22:10.123)
}
```

---

### Step 6 — Flink JDBC Sink Buffers and Writes to PostgreSQL

The row arrives at the **JDBC Sink Connector**. The sink is configured with:
```
'sink.buffer-flush.max-rows' = '1'   → flush immediately on every row
'sink.buffer-flush.interval' = '1s'  → also flush on 1-second timer
```

Because `max-rows=1`, the sink flushes immediately. It builds a `PreparedStatement`:

```sql
-- Generated by the JDBC sink connector (upsert mode, PRIMARY KEY = id)
INSERT INTO fact_orders (id, user_id, total, status, created_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (id)
DO UPDATE SET
  user_id    = EXCLUDED.user_id,
  total      = EXCLUDED.total,
  status     = EXCLUDED.status,
  created_at = EXCLUDED.created_at;
```

Parameters are bound:
```
$1 = '7f3a2c91-0001-0001-0001-000000000001'
$2 = '9d82bcb3-6e96-462c-bdb9-e677080e8920'
$3 = 49.99
$4 = 'PENDING'
$5 = 2026-03-06 10:22:10.123
```

The JDBC connection to `analytics-db` executes the statement. PostgreSQL inserts the row:

```sql
-- analytics-db.fact_orders (analytics namespace)
-- After the JDBC sink writes:
SELECT * FROM fact_orders WHERE id = '7f3a2c91-...';
--   id        | user_id   | total | status  | created_at
--   7f3a2c91  | 9d82bcb3  | 49.99 | PENDING | 2026-03-06 10:22:10.123
```

---

### Step 7 — Checkpoint: Coordinating Source and Sink

Every 30 seconds (`execution.checkpointing.interval: 30s`), the JobManager triggers a checkpoint. This is what makes the pipeline exactly-once:

```
JobManager → injects "checkpoint barrier" into each Kafka partition's event stream

                  Kafka partition 0:
[msg-40] [msg-41] [msg-42=BARRIER-CP42] [msg-43] [msg-44]
                        ↑
              Flink source pauses here, takes state snapshot

                  The barrier flows downstream:

KafkaSource → [BARRIER] → Calc → [BARRIER] → JDBCSink → [BARRIER]

When ALL operators acknowledge the barrier:
  1. KafkaSource records: "offset 42 is included in checkpoint CP-42"
  2. JDBCSink flushes all buffered rows to PostgreSQL
  3. JDBCSink records: "all rows up to CP-42 are written to PG"
  4. Checkpoint CP-42 is COMPLETE and DURABLE on PVC

JobManager then commits Kafka offsets:
  consumer group "flink-analytics-consumer" offset for topic "ecom-connector.public.orders" partition 0 → 43
```

After the checkpoint:
- Kafka knows Flink has processed up to offset 42
- The checkpoint file on PVC knows every operator's exact state at that moment
- If a crash occurs, Flink restores from the checkpoint and replays only messages from offset 43 onward

---

### Step 8 — Superset Reads the Analytics Data

Apache Superset (at `http://localhost:32000`) queries `analytics-db` directly via SQL. Because the JDBC sink uses `sink.buffer-flush.max-rows=1`, the row appears in `fact_orders` within milliseconds of Debezium emitting the event.

```sql
-- Superset executes this view (vw_sales_over_time)
SELECT DATE(created_at) AS sale_date, COUNT(*) AS order_count, SUM(total) AS daily_revenue
FROM fact_orders
WHERE status != 'CANCELLED'
GROUP BY DATE(created_at)
ORDER BY sale_date;

-- The new PENDING order is now counted in today's figures
```

### Complete Timeline

```
T+0ms    User clicks "Place Order"
T+5ms    Spring Boot inserts into ecom-db.public.orders (WAL written)
T+10ms   PostgreSQL streams WAL record to Debezium via replication slot
T+15ms   Debezium serializes and publishes to Kafka topic (offset 42)
T+18ms   Flink KafkaConsumer.poll() returns the new record
T+19ms   Flink JSON deserializer parses the Debezium envelope
T+20ms   Calc operator filters and transforms the row
T+21ms   JDBC sink executes UPSERT on analytics-db
T+22ms   Row is visible in fact_orders ← analytics pipeline complete
T+30s    Next checkpoint commits Kafka offset 42
```

End-to-end CDC latency for this platform: **< 50ms** under normal load.

---

## 6. Deep Dive: The Kafka Source Connector

The Kafka connector (`flink-connector-kafka-3.4.0-1.20.jar`) implements Flink's `Source` interface. Internally it wraps a standard `KafkaConsumer`.

### How the Connector Operates

```
┌─────────────────────────────────────────────────────────────────┐
│                    KafkaSource (per task slot)                   │
│                                                                 │
│  KafkaConsumer<byte[], byte[]>                                  │
│    - bootstrap.servers = kafka.infra.svc.cluster.local:9092     │
│    - group.id          = flink-analytics-consumer               │
│    - auto.offset.reset = earliest (from scan.startup.mode)      │
│    - enable.auto.commit = false  ← Flink manages offsets        │
│                                                                 │
│  Poll loop (runs continuously in TaskManager thread):           │
│    while (running) {                                            │
│      records = consumer.poll(100ms)                             │
│      for each record:                                           │
│        bytes = record.value()                                   │
│        flinkRow = jsonDeserializer.deserialize(bytes)           │
│        outputCollector.collect(flinkRow)  → next operator       │
│        inFlightOffsets.track(partition, offset)                 │
│    }                                                            │
│                                                                 │
│  On checkpoint (barrier received):                              │
│    state.put("offsets", inFlightOffsets.snapshot())             │
│    notifyCheckpointComplete()                                   │
│                                                                 │
│  Partition Discovery thread (every 300,000ms):                  │
│    AdminClient.listTopics() → find new partitions               │
│    if new partition found: add to KafkaConsumer assignment      │
└─────────────────────────────────────────────────────────────────┘
```

### Key Behavioral Details

**`enable.auto.commit = false`**: Flink disables Kafka's auto offset commit. Offsets are only committed after a successful checkpoint that includes the corresponding rows being written to the sink. This is what makes the pipeline exactly-once.

**`scan.startup.mode = earliest-offset`**: On the very first run (no checkpoint exists), Flink starts from offset 0 on every partition — reading all historical messages. This ensures the analytics DB is fully populated from the beginning, including Debezium's initial snapshot events.

**`json.ignore-parse-errors = true`**: Debezium produces several types of messages beyond row-change events: schema change events, heartbeat messages, transaction boundary markers. Most of these do not match the declared `after ROW<...>` schema and would cause parse failures. This option silently skips them instead of failing the job.

**`scan.topic-partition-discovery.interval = 300000`**: A background thread checks for new Kafka partitions every 5 minutes. If Kafka topic partitions are scaled from 1 to 4, Flink automatically starts consuming from the new partitions without job restart. This only handles partition scaling, not new topics.

### What the JSON Deserializer Does

Given the schema:
```sql
CREATE TABLE kafka_orders (
  after ROW<id STRING, user_id STRING, total DOUBLE, status STRING, created_at STRING>,
  op STRING
)
```

The JSON deserializer parses the raw Kafka message bytes as JSON and maps fields by name:

```
Input bytes: {"before":null,"after":{"id":"7f3a...","total":49.99,...},"op":"c","source":{...}}

JSON tree:
  root
  ├── "before" → null
  ├── "after"  → object → mapped to ROW<id, user_id, total, status, created_at>
  ├── "op"     → "c"    → mapped to STRING
  └── "source" → object → NOT in schema, ignored
```

The `source` field, `transaction` field, `before` field — all ignored because they are not in the declared schema. Only `after` and `op` are extracted.

---

## 7. Deep Dive: The JDBC Sink Connector

The JDBC connector (`flink-connector-jdbc-3.3.0-1.20.jar`) implements Flink's `Sink` interface. Internally it manages a JDBC connection and a `PreparedStatement`.

### How the Connector Operates

```
┌─────────────────────────────────────────────────────────────────┐
│                    JdbcSink (per task slot)                      │
│                                                                 │
│  JDBC Connection:                                               │
│    url: jdbc:postgresql://analytics-db:5432/analyticsdb         │
│         ?stringtype=unspecified                                  │
│    username / password: from env vars (injected by envsubst)    │
│                                                                 │
│  PreparedStatement (generated from sink table schema):          │
│    INSERT INTO fact_orders (id, user_id, total, status, created_at)
│    VALUES (?, ?, ?, ?, ?)                                       │
│    ON CONFLICT (id)                                             │
│    DO UPDATE SET                                                │
│      user_id=EXCLUDED.user_id, total=EXCLUDED.total,           │
│      status=EXCLUDED.status, created_at=EXCLUDED.created_at    │
│                                                                 │
│  Row buffer: List<Row>                                          │
│    - max-rows=1 → flush after every row                         │
│    - interval=1s → also flush on timer                          │
│                                                                 │
│  Write flow:                                                    │
│    receive(row) {                                               │
│      stmt.setString(1, row.getString(0))   // id               │
│      stmt.setString(2, row.getString(1))   // user_id          │
│      stmt.setDouble(3, row.getDouble(2))   // total            │
│      stmt.setString(4, row.getString(3))   // status           │
│      stmt.setTimestamp(5, row.getTimestamp(4)) // created_at   │
│      buffer.add(stmt)                                           │
│      if buffer.size >= maxRows: flush()                         │
│    }                                                            │
│                                                                 │
│    flush() {                                                    │
│      connection.executeBatch(buffer)  → PostgreSQL              │
│      buffer.clear()                                             │
│    }                                                            │
│                                                                 │
│  On checkpoint (barrier received):                              │
│    flush()   ← ensure all buffered rows are in PostgreSQL       │
│    notifyCheckpointComplete()                                   │
└─────────────────────────────────────────────────────────────────┘
```

### The `?stringtype=unspecified` JDBC URL Parameter

PostgreSQL is strict about type casting. The analytics-db schema declares primary keys as `UUID`:

```sql
CREATE TABLE fact_orders (
    id UUID PRIMARY KEY,
    ...
```

But the Flink pipeline passes `id` as `STRING` (because the Kafka source schema uses `STRING` for UUIDs). Without the parameter:

```
ERROR: column "id" is of type uuid but expression is of type character varying
HINT: You will need to rewrite or cast the expression
```

With `?stringtype=unspecified`, the JDBC driver tells PostgreSQL "treat this parameter as an untyped literal, not as `varchar`." PostgreSQL then applies its own implicit cast from the literal to `uuid`. The result is seamless UUID handling without `::uuid` casts in the SQL.

### Upsert Mode: How PRIMARY KEY Works

When the sink table declares `PRIMARY KEY (id) NOT ENFORCED`:
- `NOT ENFORCED` means Flink does not validate uniqueness internally (it trusts the downstream system)
- `PRIMARY KEY` tells the JDBC connector to generate UPSERT SQL instead of plain INSERT

Without `PRIMARY KEY`:
```sql
-- Append mode — will fail on duplicate IDs after Flink recovery
INSERT INTO fact_orders VALUES (...)
```

With `PRIMARY KEY (id) NOT ENFORCED`:
```sql
-- Upsert mode — idempotent, safe after recovery
INSERT INTO fact_orders VALUES (...)
ON CONFLICT (id)
DO UPDATE SET user_id=EXCLUDED.user_id, total=EXCLUDED.total, ...
```

Re-running the same event multiple times (due to checkpoint recovery replaying from an earlier Kafka offset) produces the same final state in PostgreSQL — idempotent behavior.

---

## 8. How INSERT INTO Connects Source to Sink

The `INSERT INTO ... SELECT ... FROM` statement is the declaration that **wires** a source table to a sink table through a set of operators. It is not a one-time batch operation — it creates a **continuous, never-ending streaming job**.

```sql
-- This single statement creates one streaming job that runs forever
INSERT INTO sink_fact_orders              -- ← SINK: write to here
SELECT
  after.id,
  after.user_id,
  after.total,
  after.status,
  CAST(REPLACE(REPLACE(after.created_at, 'T', ' '), 'Z', '') AS TIMESTAMP(3))
FROM kafka_orders                          -- ← SOURCE: read from here
WHERE after IS NOT NULL;                   -- ← FILTER: skip DELETEs
```

When Flink SQL compiles this statement, it produces an **operator DAG** (Directed Acyclic Graph):

```
[KafkaSource: kafka_orders]
        │
        │  Flink Rows: {after ROW<...>, op STRING}
        ↓
[Calc: WHERE after IS NOT NULL + SELECT after.id, ... CAST(...)]
        │
        │  Flink Rows: {id, user_id, total, status, created_at TIMESTAMP(3)}
        ↓
[JdbcSink: sink_fact_orders]
        │
        │  JDBC UPSERT SQL
        ↓
[analytics-db.fact_orders]
```

All four `INSERT INTO` statements in this platform's SQL file are compiled together. Flink optimizes the plan — operators that share the same source can be fused, reducing memory copies.

---

## 9. What Happens Inside the TaskManager

The TaskManager is the worker process that physically runs the operators. It has 4 task slots, each capable of running one operator chain independently.

For the 4 `INSERT INTO` statements, the TaskManager runs 4 parallel chains simultaneously:

```
TaskManager (1 pod, 4 slots, 1024m memory)
├── Slot 0: [KafkaSource:kafka_orders]    → [Calc] → [JdbcSink:fact_orders]
├── Slot 1: [KafkaSource:kafka_order_items] → [Calc] → [JdbcSink:fact_order_items]
├── Slot 2: [KafkaSource:kafka_books]     → [Calc] → [JdbcSink:dim_books]
└── Slot 3: [KafkaSource:kafka_inventory] → [Calc] → [JdbcSink:fact_inventory]
```

Each slot is an isolated thread of execution. They run concurrently and independently. A failure in Slot 0 (e.g., analytics-db connection timeout) does not affect Slot 3.

### Memory Allocation

```
taskmanager.memory.process.size: 1024m
  ├── Framework heap: ~128m (Flink internals)
  ├── Task heap: ~512m (operator state, row buffers)
  ├── Managed memory: ~256m (Flink-managed off-heap for sort/hash)
  ├── JVM metaspace: ~96m (class definitions)
  └── Network buffers: ~32m (inter-operator communication)
```

The Kafka source and JDBC sink in this pipeline are essentially stateless (state is in Kafka offsets and PG rows), so the Task heap usage per slot is very small (< 50MB per pipeline).

---

## 10. Exactly-Once: How Source and Sink Coordinate

The source and sink must coordinate during checkpointing to ensure no data is lost or duplicated.

### The Two-Phase Process

```
Phase 1 — Snapshot (source and sink simultaneously):

  JobManager triggers CP-42
           │
           ├──→ KafkaSource receives barrier
           │      Records current Kafka offset (e.g., 42)
           │      Stores in checkpoint state
           │
           └──→ JdbcSink receives barrier
                  Flushes remaining buffer to PostgreSQL
                  All rows up to barrier are now in PG
                  Records "flushed" in checkpoint state

Phase 2 — Confirmation:

  Both operators report success to JobManager
  JobManager writes checkpoint metadata to PVC:
    "Checkpoint 42: KafkaSource offset=42, JdbcSink flushed"
  JobManager commits Kafka consumer group offsets
    "flink-analytics-consumer on topic ecom-connector.public.orders partition 0 → offset 43"
```

### Recovery from Crash

If the TaskManager crashes between CP-42 and CP-43:

```
Normal flow:               Recovery flow:

[msg-40] → PG ✓           Flink restores checkpoint CP-42
[msg-41] → PG ✓           KafkaSource seeks to offset 43 (after 42)
[msg-42] → PG ✓           JdbcSink reconnects to PostgreSQL
  ← CP-42 committed ─┐
[msg-43] → CRASH      │    Replay:
[msg-44] → NOT SEEN   │    [msg-43] → UPSERT ON CONFLICT → same values → no change
                       │    [msg-44] → PG ✓
                      └── Kafka offset 43 is replayed (ON CONFLICT handles duplicate)
```

The `ON CONFLICT DO UPDATE` makes replaying msg-43 safe — if it was already written before the crash, the UPDATE simply sets the same values again.

---

## 11. The Four Parallel Pipelines

This platform runs 4 streaming pipelines in the same Flink Session Cluster, each declared by one `INSERT INTO` statement:

### Pipeline 1 — Orders

```
Source:  kafka_orders              topic: ecom-connector.public.orders
         Debezium: ecom-db → public.orders (INSERT/UPDATE/DELETE)

Transform:
         - Filter: WHERE after IS NOT NULL (skip deletes)
         - Project: extract id, user_id, total, status
         - Convert: CAST(REPLACE(REPLACE(created_at,'T',' '),'Z','') AS TIMESTAMP(3))

Sink:    sink_fact_orders          table: analytics-db.fact_orders
         Mode: UPSERT on id
```

### Pipeline 2 — Order Items

```
Source:  kafka_order_items         topic: ecom-connector.public.order_items
         Debezium: ecom-db → public.order_items

Transform:
         - Filter: WHERE after IS NOT NULL
         - Project: extract id, order_id, book_id, quantity, price_at_purchase
         - No timestamp conversion (no timestamp column in sink)

Sink:    sink_fact_order_items     table: analytics-db.fact_order_items
         Mode: UPSERT on id
```

### Pipeline 3 — Books (Dimension)

```
Source:  kafka_books               topic: ecom-connector.public.books
         Debezium: ecom-db → public.books (initial snapshot: all 10 books)

Transform:
         - Filter: WHERE after IS NOT NULL
         - Project: extract all book columns
         - Convert: created_at string → TIMESTAMP(3)

Sink:    sink_dim_books            table: analytics-db.dim_books
         Mode: UPSERT on id
         Note: initial snapshot populates this table with all 10 books
```

### Pipeline 4 — Inventory

```
Source:  kafka_inventory           topic: inventory-connector.public.inventory
         Debezium: inventory-db → public.inventory (from DIFFERENT DB/server)

Transform:
         - Filter: WHERE after IS NOT NULL
         - Project: extract book_id, quantity, reserved
         - Convert: updated_at string → TIMESTAMP(3)

Sink:    sink_fact_inventory       table: analytics-db.fact_inventory
         Mode: UPSERT on book_id   ← Note: PK is book_id, not id
```

Each pipeline is an independent streaming job. They are submitted together by the `flink-sql-runner` Job but run independently in separate task slots. A failure in Pipeline 4 does not affect Pipelines 1–3.

---

## 12. Operator Execution Graph

You can visualize the execution graph in the Flink Web Dashboard at `http://localhost:32200`. Click any running job to see the dataflow.

### Conceptual Graph for All 4 Pipelines

```
Pipeline 1 (orders):
  ┌────────────────────────────┐     ┌────────────────────┐     ┌────────────────────────┐
  │ KafkaSourceReader          │────>│ Calc               │────>│ JdbcDynamicTableSink   │
  │ topic: *.orders            │     │ WHERE after IS NOT │     │ table: fact_orders     │
  │ group: flink-analytics-... │     │ NULL               │     │ mode: UPSERT           │
  │ offset tracked in CP       │     │ CAST timestamp     │     │ flush: max-rows=1      │
  └────────────────────────────┘     └────────────────────┘     └────────────────────────┘

Pipeline 2 (order_items):
  ┌────────────────────────────┐     ┌────────────────────┐     ┌────────────────────────┐
  │ KafkaSourceReader          │────>│ Calc               │────>│ JdbcDynamicTableSink   │
  │ topic: *.order_items       │     │ WHERE after IS NOT │     │ table: fact_order_items│
  └────────────────────────────┘     │ NULL               │     │ mode: UPSERT           │
                                     └────────────────────┘     └────────────────────────┘

Pipeline 3 (books):
  ┌────────────────────────────┐     ┌────────────────────┐     ┌────────────────────────┐
  │ KafkaSourceReader          │────>│ Calc               │────>│ JdbcDynamicTableSink   │
  │ topic: *.books             │     │ WHERE after IS NOT │     │ table: dim_books       │
  └────────────────────────────┘     │ NULL + CAST        │     │ mode: UPSERT           │
                                     └────────────────────┘     └────────────────────────┘

Pipeline 4 (inventory):
  ┌────────────────────────────┐     ┌────────────────────┐     ┌────────────────────────┐
  │ KafkaSourceReader          │────>│ Calc               │────>│ JdbcDynamicTableSink   │
  │ topic: *.inventory         │     │ WHERE after IS NOT │     │ table: fact_inventory  │
  └────────────────────────────┘     │ NULL + CAST        │     │ mode: UPSERT           │
                                     └────────────────────┘     └────────────────────────┘
```

### What the Dashboard Shows

Navigate to a running job → click "Overview" tab:

```
Vertices (operators) in the graph:
  1. Source: KafkaSourceReader[kafka_orders]     → Records Received: 1,243
  2. Calc[WHERE after IS NOT NULL; SELECT ...]   → Records Sent: 1,242  (1 filtered out)
  3. Sink: JdbcDynamicTableSink[fact_orders]     → Records Written: 1,242

Metrics:
  Throughput: 0.2 records/sec (low during quiet period)
  Backpressure: 0.0% (sink is keeping up with source)
  Last checkpoint: CP-47 completed 12s ago, duration 340ms
```

A record count of `1,242` on the source vs `1,242` on the sink confirms no data loss.

---

## 13. Can Flink Replace Debezium?

**Yes — Flink can fully replace Debezium** using a separate open-source project called **Flink CDC** (formerly known as `flink-cdc-connectors`). With Flink CDC, Flink connects directly to PostgreSQL's Write-Ahead Log (WAL) without Kafka or Debezium in the middle.

### What Flink CDC Is

Flink CDC is a set of source connectors maintained by Alibaba and the Apache Flink community. It is **not** bundled with Apache Flink itself — it is a separate JAR you add to `/opt/flink/lib/`. It provides connectors for:

- PostgreSQL (`postgres-cdc`)
- MySQL (`mysql-cdc`)
- Oracle, MongoDB, SQL Server, TiDB, and others

Each connector implements the same logical replication protocol that Debezium uses (pgoutput for PostgreSQL). From PostgreSQL's perspective, Flink CDC looks identical to Debezium — it opens a replication slot and reads WAL events.

### How It Works (Architecture Comparison)

**Current architecture — Debezium + Kafka as middleware:**
```
PostgreSQL WAL
    │ (pgoutput protocol)
    ▼
Debezium Server pod        ← standalone process, manages replication slot
    │ (Kafka producer)
    ▼
Kafka topic                ← durable buffer, multiple consumers possible
    │ (Kafka consumer)
    ▼
Flink KafkaSource          ← reads JSON CDC events
    │
    ▼
Flink JdbcSink             ← upserts into analytics-db
```

**Alternative — Flink CDC (no Kafka, no Debezium):**
```
PostgreSQL WAL
    │ (pgoutput protocol — directly from Flink)
    ▼
Flink postgres-cdc source  ← Flink manages replication slot, reads WAL directly
    │
    ▼
Flink JdbcSink             ← upserts into analytics-db
```

Kafka and Debezium Server are eliminated entirely. Flink becomes responsible for everything: connecting to PostgreSQL, reading the WAL, tracking position (stored in Flink checkpoints instead of an offset file), and writing to the sink.

### The Flink CDC Source Table Syntax

With the `postgres-cdc` connector, the source table declaration changes from:

```sql
-- CURRENT: reads Debezium JSON from Kafka
CREATE TABLE kafka_orders (
  after ROW<id STRING, user_id STRING, total DOUBLE, status STRING, created_at STRING>,
  op STRING
) WITH (
  'connector'                    = 'kafka',
  'topic'                        = 'ecom-connector.public.orders',
  'properties.bootstrap.servers' = 'kafka.infra.svc.cluster.local:9092',
  'properties.group.id'          = 'flink-analytics-consumer',
  'format'                       = 'json',
  'json.ignore-parse-errors'     = 'true',
  'scan.startup.mode'            = 'earliest-offset',
  -- ... + 7 resilience properties
);
```

To:

```sql
-- ALTERNATIVE: reads WAL directly from PostgreSQL via Flink CDC
CREATE TABLE direct_orders (
  id         STRING,          -- columns declared flat (no "after ROW<>" wrapper)
  user_id    STRING,
  total      DOUBLE,
  status     STRING,
  created_at TIMESTAMP(3),   -- Flink CDC converts timestamps automatically
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'connector'      = 'postgres-cdc',
  'hostname'       = 'ecom-db.ecom.svc.cluster.local',
  'port'           = '5432',
  'username'       = '${ECOM_DB_USER}',
  'password'       = '${ECOM_DB_PASSWORD}',
  'database-name'  = 'ecomdb',
  'schema-name'    = 'public',
  'table-name'     = 'orders',
  'slot.name'      = 'flink_orders_slot',
  'decoding.plugin.name' = 'pgoutput'
);
```

Key differences in the source table declaration:

| Aspect | Kafka connector | postgres-cdc connector |
|--------|----------------|----------------------|
| Column schema | `after ROW<...>` + `op STRING` (Debezium envelope) | Flat columns matching the DB table directly |
| Timestamp type | `STRING` → manual `CAST(REPLACE(...))` | `TIMESTAMP(3)` automatically (no conversion needed) |
| Operation filtering | `WHERE after IS NOT NULL` | Handled internally — deletes/tombstones never surface |
| Startup | `scan.startup.mode = earliest-offset` | `scan.startup.mode = initial` (auto-snapshot on first run) |
| Credential scope | analytics-db only | source DB credentials required |

The INSERT INTO pipeline simplifies significantly because there is no envelope to unwrap:

```sql
-- CURRENT: unwrap "after" ROW, convert timestamp manually
INSERT INTO sink_fact_orders
SELECT after.id, after.user_id, after.total, after.status,
       CAST(REPLACE(REPLACE(after.created_at, 'T', ' '), 'Z', '') AS TIMESTAMP(3))
FROM kafka_orders
WHERE after IS NOT NULL;

-- ALTERNATIVE: columns are flat, timestamps already converted
INSERT INTO sink_fact_orders
SELECT id, user_id, total, status, created_at
FROM direct_orders;
-- No WHERE needed — Flink CDC already filters out deletes
```

---

## 14. Step-by-Step: Replacing Debezium with Flink CDC in This Platform

This section shows exactly what would need to change to remove Debezium Server and Kafka from the CDC pipeline and use Flink CDC instead.

### What Gets Removed

| Component | File | Action |
|-----------|------|--------|
| Debezium Server (ecom pod) | `infra/debezium/debezium-server-ecom.yaml` | Delete |
| Debezium Server (inventory pod) | `infra/debezium/debezium-server-inventory.yaml` | Delete |
| Kafka broker | `infra/kafka/kafka.yaml` | Delete (if only used for CDC) |
| Kafka topics init | `infra/kafka/kafka-topics-init.yaml` | Delete |
| Kind NodePorts 32300/32301 | `infra/kind/cluster.yaml` | Remove entries |
| Debezium health checks | `infra/debezium/register-connectors.sh` | Delete |
| Istio PERMISSIVE entries for Debezium | `infra/istio/security/peer-auth.yaml` | Remove |

**Note**: Kafka also carries `order.created` and `inventory.updated` application events published by ecom-service and inventory-service. If those are still needed, Kafka must be kept for application messaging even after removing the CDC path.

### Step 1 — Add the Flink CDC JAR to the Dockerfile

`flink-cdc-connector-postgres` is the JAR that provides `connector = 'postgres-cdc'`. Add it to `analytics/flink/Dockerfile`:

```dockerfile
FROM alpine:3.19 AS downloader
RUN apk add --no-cache curl
WORKDIR /jars

# Existing JARs (unchanged)
RUN curl -fsSL -o flink-connector-kafka-3.4.0-1.20.jar \
  "https://repo1.maven.org/maven2/org/apache/flink/flink-connector-kafka/3.4.0-1.20/flink-connector-kafka-3.4.0-1.20.jar"
RUN curl -fsSL -o flink-connector-jdbc-3.3.0-1.20.jar \
  "https://repo1.maven.org/maven2/org/apache/flink/flink-connector-jdbc/3.3.0-1.20/flink-connector-jdbc-3.3.0-1.20.jar"
RUN curl -fsSL -o postgresql-42.7.10.jar \
  "https://repo1.maven.org/maven2/org/postgresql/postgresql/42.7.10/postgresql-42.7.10.jar"
RUN curl -fsSL -o kafka-clients-3.9.2.jar \
  "https://repo1.maven.org/maven2/org/apache/kafka/kafka-clients/3.9.2/kafka-clients-3.9.2.jar"

# NEW: Flink CDC PostgreSQL connector
# Version 3.x supports Flink 1.18–1.20; check https://github.com/apache/flink-cdc for latest
RUN curl -fsSL -o flink-cdc-connector-postgres-3.2.0.jar \
  "https://repo1.maven.org/maven2/org/apache/flink/flink-cdc-connector-postgres/3.2.0/flink-cdc-connector-postgres-3.2.0.jar"

FROM flink:1.20-scala_2.12-java17
COPY --from=downloader /jars/*.jar /opt/flink/lib/
```

Rebuild:
```bash
docker build -t bookstore/flink:latest analytics/flink/
kind load docker-image bookstore/flink:latest --name bookstore
```

### Step 2 — Update analytics-db Secret Scope

The ecom-db and inventory-db credentials need to be accessible to Flink (currently Flink only has analytics-db credentials). Add them to the analytics namespace:

```bash
# Read source DB credentials
ECOM_USER=$(kubectl get secret -n ecom ecom-db-secret -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
ECOM_PASS=$(kubectl get secret -n ecom ecom-db-secret -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)
INV_USER=$(kubectl get secret -n inventory inventory-db-secret -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
INV_PASS=$(kubectl get secret -n inventory inventory-db-secret -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)

# Create combined secret in analytics namespace
kubectl create secret generic flink-source-db-credentials -n analytics \
  --from-literal=ECOM_DB_USER="$ECOM_USER" \
  --from-literal=ECOM_DB_PASSWORD="$ECOM_PASS" \
  --from-literal=INVENTORY_DB_USER="$INV_USER" \
  --from-literal=INVENTORY_DB_PASSWORD="$INV_PASS" \
  --dry-run=client -o yaml | kubectl apply -f -
```

Add these env vars to both `flink-jobmanager` and `flink-taskmanager` containers in `infra/flink/flink-cluster.yaml`:

```yaml
env:
  # existing
  - name: ANALYTICS_DB_USER
    valueFrom:
      secretKeyRef:
        name: analytics-db-secret
        key: POSTGRES_USER
  - name: ANALYTICS_DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: analytics-db-secret
        key: POSTGRES_PASSWORD
  # new: source DB credentials for Flink CDC
  - name: ECOM_DB_USER
    valueFrom:
      secretKeyRef:
        name: flink-source-db-credentials
        key: ECOM_DB_USER
  - name: ECOM_DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: flink-source-db-credentials
        key: ECOM_DB_PASSWORD
  - name: INVENTORY_DB_USER
    valueFrom:
      secretKeyRef:
        name: flink-source-db-credentials
        key: INVENTORY_DB_USER
  - name: INVENTORY_DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: flink-source-db-credentials
        key: INVENTORY_DB_PASSWORD
```

### Step 3 — Rewrite the SQL Pipeline

Replace `analytics/flink/sql/pipeline.sql` entirely. Remove all Kafka source table declarations and replace with `postgres-cdc` source tables. Remove the `after ROW<...>` schema and the `WHERE after IS NOT NULL` filter. Remove manual timestamp conversions.

```sql
-- ─────────────────────────────────────────────────────────────
-- SOURCE TABLES: Flink CDC reads directly from PostgreSQL WAL
-- No Kafka, no Debezium — Flink manages the replication slot
-- ─────────────────────────────────────────────────────────────

CREATE TABLE direct_orders (
  id         STRING,
  user_id    STRING,
  total      DOUBLE,
  status     STRING,
  created_at TIMESTAMP(3),
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'connector'            = 'postgres-cdc',
  'hostname'             = 'ecom-db.ecom.svc.cluster.local',
  'port'                 = '5432',
  'username'             = '${ECOM_DB_USER}',
  'password'             = '${ECOM_DB_PASSWORD}',
  'database-name'        = 'ecomdb',
  'schema-name'          = 'public',
  'table-name'           = 'orders',
  'slot.name'            = 'flink_orders_slot',
  'decoding.plugin.name' = 'pgoutput',
  'scan.startup.mode'    = 'initial'
);

CREATE TABLE direct_order_items (
  id                STRING,
  order_id          STRING,
  book_id           STRING,
  quantity          INT,
  price_at_purchase DOUBLE,
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'connector'            = 'postgres-cdc',
  'hostname'             = 'ecom-db.ecom.svc.cluster.local',
  'port'                 = '5432',
  'username'             = '${ECOM_DB_USER}',
  'password'             = '${ECOM_DB_PASSWORD}',
  'database-name'        = 'ecomdb',
  'schema-name'          = 'public',
  'table-name'           = 'order_items',
  'slot.name'            = 'flink_order_items_slot',
  'decoding.plugin.name' = 'pgoutput',
  'scan.startup.mode'    = 'initial'
);

CREATE TABLE direct_books (
  id             STRING,
  title          STRING,
  author         STRING,
  price          DOUBLE,
  description    STRING,
  cover_url      STRING,
  isbn           STRING,
  genre          STRING,
  published_year INT,
  created_at     TIMESTAMP(3),
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'connector'            = 'postgres-cdc',
  'hostname'             = 'ecom-db.ecom.svc.cluster.local',
  'port'                 = '5432',
  'username'             = '${ECOM_DB_USER}',
  'password'             = '${ECOM_DB_PASSWORD}',
  'database-name'        = 'ecomdb',
  'schema-name'          = 'public',
  'table-name'           = 'books',
  'slot.name'            = 'flink_books_slot',
  'decoding.plugin.name' = 'pgoutput',
  'scan.startup.mode'    = 'initial'
);

CREATE TABLE direct_inventory (
  book_id    STRING,
  quantity   INT,
  reserved   INT,
  updated_at TIMESTAMP(3),
  PRIMARY KEY (book_id) NOT ENFORCED
) WITH (
  'connector'            = 'postgres-cdc',
  'hostname'             = 'inventory-db.inventory.svc.cluster.local',
  'port'                 = '5432',
  'username'             = '${INVENTORY_DB_USER}',
  'password'             = '${INVENTORY_DB_PASSWORD}',
  'database-name'        = 'inventorydb',
  'schema-name'          = 'public',
  'table-name'           = 'inventory',
  'slot.name'            = 'flink_inventory_slot',
  'decoding.plugin.name' = 'pgoutput',
  'scan.startup.mode'    = 'initial'
);

-- ─────────────────────────────────────────────────────────────
-- SINK TABLES: unchanged from current implementation
-- ─────────────────────────────────────────────────────────────

CREATE TABLE sink_fact_orders (
  id STRING, user_id STRING, total DOUBLE, status STRING,
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

-- ... (sink_fact_order_items, sink_dim_books, sink_fact_inventory unchanged)

-- ─────────────────────────────────────────────────────────────
-- PIPELINES: massively simplified — no envelope unwrapping
-- ─────────────────────────────────────────────────────────────

INSERT INTO sink_fact_orders
SELECT id, user_id, total, status, created_at
FROM direct_orders;
-- No WHERE filter — Flink CDC handles delete/tombstone internally

INSERT INTO sink_fact_order_items
SELECT id, order_id, book_id, quantity, price_at_purchase
FROM direct_order_items;

INSERT INTO sink_dim_books
SELECT id, title, author, price, description, cover_url, isbn, genre, published_year, created_at
FROM direct_books;

INSERT INTO sink_fact_inventory
SELECT book_id, quantity, reserved, updated_at
FROM direct_inventory;
```

### Step 4 — Important: One Replication Slot Per Table

Notice each `direct_*` source table declares its own `slot.name`. This is a critical constraint of Flink CDC:

**Each postgres-cdc source table requires its own dedicated replication slot.**

With 4 source tables across 2 databases, you need 4 replication slots:
- `flink_orders_slot` on ecom-db
- `flink_order_items_slot` on ecom-db
- `flink_books_slot` on ecom-db
- `flink_inventory_slot` on inventory-db

Debezium uses **one** slot per database and multiplexes all tables through it. Flink CDC creates **one slot per table**. Verify the PostgreSQL `max_replication_slots` setting is high enough:

```bash
kubectl exec -n ecom deploy/ecom-db -- psql -U ecomuser -d ecomdb \
  -c "SHOW max_replication_slots;"
# Must be >= 3 for ecom-db (3 tables), >= 1 for inventory-db
# Default PostgreSQL setting is 10 — sufficient for this platform
```

### Step 5 — Deploy and Verify

```bash
# 1. Rebuild and load the Flink image (now includes flink-cdc-connector-postgres JAR)
docker build -t bookstore/flink:latest analytics/flink/
kind load docker-image bookstore/flink:latest --name bookstore

# 2. Apply updated cluster manifest (now has source DB env vars)
kubectl apply -f infra/flink/flink-cluster.yaml
kubectl rollout restart deployment/flink-jobmanager deployment/flink-taskmanager -n analytics
kubectl rollout status deployment/flink-jobmanager -n analytics --timeout=180s

# 3. Resubmit the pipeline (with updated SQL)
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=180s

# 4. Verify 4 jobs RUNNING
curl -sf http://localhost:32200/jobs | python3 -c "
import sys,json
jobs = json.load(sys.stdin)['jobs']
print([j['status'] for j in jobs])
"

# 5. Verify replication slots created on source DBs
kubectl exec -n ecom deploy/ecom-db -- psql -U ecomuser -d ecomdb \
  -c "SELECT slot_name, active FROM pg_replication_slots;"
# Expected: flink_orders_slot, flink_order_items_slot, flink_books_slot — all active=true

# 6. Verify data flows into analytics-db
kubectl exec -n analytics deploy/analytics-db -- psql -U analyticsuser -d analyticsdb \
  -c "SELECT COUNT(*) FROM dim_books;"
# Expected: 10 (seeded books from initial snapshot)
```

---

## 15. Is It a Good Idea? Production-Grade Analysis

The short answer: **it depends on your requirements**. Here is an honest, detailed comparison across every dimension that matters in production.

### Architecture Comparison

```
Option A (current): Debezium + Kafka + Flink
  PostgreSQL → Debezium Server → Kafka → Flink → analytics-db
  Components: 6 pods (2 Debezium + 1 Kafka + 1 JobManager + 1 TaskManager + 1 analytics-db)

Option B: Flink CDC direct
  PostgreSQL → Flink → analytics-db
  Components: 4 pods (1 JobManager + 1 TaskManager + 1 analytics-db + 0 Kafka/Debezium)
```

### Factor 1: Operational Simplicity

| | Debezium + Kafka | Flink CDC Direct |
|---|---|---|
| Pods to manage | 6+ | 4 |
| Health endpoints | `/q/health` (×2) + Kafka broker metrics + Flink REST | Flink REST only |
| Failure modes | Debezium crash, Kafka crash, connector error, offset loss | Flink crash only |
| Restart procedure | Restart Debezium pod; check slot/offset; wait for health | Restart Flink; recover from checkpoint |
| Debug tools | Debezium logs + Kafka consumer lag + Flink dashboard | Flink dashboard only |

**Verdict**: Flink CDC is simpler to operate. Fewer moving parts, fewer logs to read, fewer things that can go wrong independently.

### Factor 2: Kafka as a Shared Bus

This is the most important factor for this platform specifically.

The current Kafka broker is not used for CDC alone. Application services also publish events through it:

- `ecom-service` publishes `order.created` to Kafka
- `inventory-service` consumes `order.created` and publishes `inventory.updated`

If Kafka is removed (because CDC no longer needs it), these application-level events also lose their transport. The ecom-service and inventory-service would need to be rearchitected to communicate differently.

| | Debezium + Kafka | Flink CDC Direct |
|---|---|---|
| Kafka used for app events? | Yes — retained regardless | Kafka could be removed from CDC path, but app events still need it |
| Can Kafka be fully removed? | No (app events) | No (app events) |
| CDC independence | CDC and app events share Kafka | CDC bypasses Kafka; app events still need it |

**Verdict for this platform**: Kafka cannot be removed because `order.created` / `inventory.updated` events use it for application-level messaging. Removing Debezium from the CDC path would leave Kafka in place anyway, just unused by analytics. The complexity savings are smaller than they appear.

### Factor 3: Durability and Replay

| | Debezium + Kafka | Flink CDC Direct |
|---|---|---|
| CDC event buffer | Kafka (configurable retention: hours, days, weeks) | None — Flink checkpoint only |
| What happens if analytics-db is down for 2 hours? | Kafka buffers events; Flink resumes and drains the backlog | Flink checkpoint marks WAL position; PostgreSQL must retain WAL until Flink resumes |
| What limits replay window? | Kafka retention policy | PostgreSQL WAL retention (controlled by `max_wal_size` and the replication slot) |
| Who consumes the CDC stream? | Any number of Kafka consumers | Only Flink (one replication slot per table) |
| Can a second analytics system read the same CDC events? | Yes — add a new Kafka consumer | No — would need a second replication slot per table |

**Verdict**: Debezium + Kafka is significantly more durable. Kafka acts as an explicit, observable buffer with configurable retention. With Flink CDC direct, PostgreSQL must retain WAL until Flink recovers — and if the replication slot falls far behind, PostgreSQL disk usage grows unboundedly until Flink catches up or the slot is dropped.

### Factor 4: WAL Pressure and Replication Slot Risk

This is the most significant production risk with Flink CDC direct.

A PostgreSQL replication slot guarantees that WAL segments are **never deleted** until the slot's consumer has read them. With Debezium:
- One slot per database → minimal WAL retention pressure
- Debezium is a dedicated, always-running process → slot stays current

With Flink CDC:
- One slot **per table** → 3 slots on ecom-db, 1 on inventory-db
- If Flink crashes and takes more than `max_wal_size` worth of time to recover, PostgreSQL begins refusing new writes (to prevent disk exhaustion)

```
Scenario: Flink pod crashes, Kubernetes takes 5 minutes to reschedule it.
  ecom-db WAL production: ~10MB/min under load
  5 minutes × 4 slots × 10MB = 200MB of WAL held back

If Kubernetes takes 30 minutes (e.g., node failure + pod reschedule):
  30 minutes × ~10MB/min = ~300MB WAL retained per slot
  PostgreSQL disk: must hold all of this before Flink reconnects
```

With Debezium + Kafka, Debezium reconnects to PostgreSQL within seconds (it is a dedicated pod with fast restart), and Kafka buffers the backlog in the meantime. PostgreSQL WAL pressure is minimal.

**Verdict**: Replication slot accumulation is a real production risk with Flink CDC on busy databases. Requires careful monitoring of `pg_replication_slots.restart_lsn` lag.

### Factor 5: Multiple Downstream Consumers

| | Debezium + Kafka | Flink CDC Direct |
|---|---|---|
| Add a second analytics system (e.g., Elasticsearch) | Add a Kafka consumer group — no change to DB or Debezium | Add another replication slot per table; increases WAL pressure |
| Add real-time alerting on order events | Add a Kafka consumer — no change | Add another replication slot (or wire through Flink, adding complexity) |
| Add event auditing / replay | Kafka consumer with custom offset — no DB change | Not possible without a new slot |

**Verdict**: Kafka as a CDC event bus scales horizontally. Adding consumers is additive and zero-impact on the source DB. Flink CDC direct does not scale this way.

### Factor 6: Monitoring and Observability

| | Debezium + Kafka | Flink CDC Direct |
|---|---|---|
| CDC source health | `GET /q/health/ready` on each Debezium pod | Flink job status in Web Dashboard + `pg_replication_slots.active` |
| Kafka consumer lag | `kafka-consumer-groups --describe` → shows lag per partition | N/A |
| WAL lag | `pg_replication_slots.restart_lsn` | Same — but harder to correlate to Flink job status |
| End-to-end latency | Observable: Kafka timestamp → Flink processing time → analytics-db write time | Less granular: PostgreSQL commit → analytics-db write |
| Alerting on CDC failure | Debezium health check failing (HTTP 503) OR Kafka consumer lag growing | Flink job FAILED or RESTARTING state |

**Verdict**: Debezium + Kafka provides richer, more granular observability with independent health signals at each hop. Flink CDC collapses those signals into one.

### Factor 7: SQL Pipeline Complexity

| | Debezium + Kafka | Flink CDC Direct |
|---|---|---|
| Source table schema | Complex: `after ROW<...>`, `op STRING` (Debezium envelope) | Simple: flat columns matching DB schema |
| Timestamp conversion | Manual: `CAST(REPLACE(REPLACE(...,'T',' '),'Z','') AS TIMESTAMP(3))` | Automatic — Flink CDC converts natively |
| Delete event handling | `WHERE after IS NOT NULL` filter required | Handled internally |
| Understanding required | Must know Debezium JSON envelope format | Standard SQL table schema |

**Verdict**: Flink CDC produces significantly cleaner, more readable SQL. This is a genuine developer experience advantage.

### Factor 8: Exactly-Once Guarantees

Both approaches provide exactly-once delivery:

| | Debezium + Kafka | Flink CDC Direct |
|---|---|---|
| Source offset tracking | Kafka consumer offsets stored in Flink checkpoint | PostgreSQL WAL LSN stored in Flink checkpoint |
| Sink idempotency | JDBC upsert (ON CONFLICT DO UPDATE) | Same |
| Checkpoint recovery | Flink seeks Kafka to checkpointed offset | Flink seeks PostgreSQL WAL to checkpointed LSN |
| Guarantee | Exactly-once | Exactly-once |

**Verdict**: Equal. Both approaches achieve exactly-once delivery through Flink's checkpoint protocol.

### Summary: When to Choose Each

| Choose Debezium + Kafka when... | Choose Flink CDC Direct when... |
|--------------------------------|--------------------------------|
| Multiple downstream consumers of the same CDC events | Single analytics destination only |
| Need long-term CDC event retention and replay | Short recovery windows are acceptable |
| Source DB cannot afford extended WAL retention (busy, small disk) | DB has generous `max_wal_size` and fast Flink recovery |
| You want independent health monitoring per component | Operational simplicity is the top priority |
| Kafka is already in the architecture for app events | Kafka is not used for anything else |
| Team is familiar with Kafka and Debezium | Team prefers SQL-first, minimal infrastructure |

### Recommendation for This Platform

**Keep Debezium + Kafka.** The reasons are specific to this platform's architecture:

1. **Kafka is not removable**: `ecom-service` and `inventory-service` use Kafka for `order.created` / `inventory.updated` application events. Kafka stays regardless.

2. **WAL slot risk on ecom-db**: ecom-db has 3 tables in the CDC path. 3 Flink CDC replication slots creates triple the WAL retention pressure compared to Debezium's single slot.

3. **Future extensibility**: The current Kafka-based CDC bus can easily support a second consumer (Elasticsearch, audit log, real-time alerting) with zero impact on PostgreSQL. Flink CDC direct cannot.

4. **Debezium is already working**: The migration from Kafka Connect to Debezium Server in Session 22 removed the operational complexity of connector management. Debezium Server is now as simple as a `kubectl apply` with a ConfigMap — the main operational advantage of Flink CDC direct is already achieved.

If this platform used **no application-level Kafka events** and had only a **single analytics destination**, Flink CDC direct would be the cleaner choice. In that scenario, eliminating Kafka and Debezium entirely would be a genuine simplification. That is not the case here.

---

## 16. Step-by-Step: Adding a New Source-to-Sink Pipeline

To add a new table to the CDC pipeline (for example, capturing `public.reviews` from ecom-db into `fact_reviews` in analytics-db):

### Step 1 — Create the Source Table in ecom-db

Apply a Liquibase migration in ecom-service to create the table. The table must exist before Debezium can capture it.

### Step 2 — Update Debezium Server Configuration

In `infra/debezium/debezium-server-ecom.yaml`, update the ConfigMap to include the new table:

```properties
# Before
debezium.source.table.include.list=public.orders,public.order_items,public.books

# After
debezium.source.table.include.list=public.orders,public.order_items,public.books,public.reviews
```

Apply and restart:
```bash
kubectl apply -f infra/debezium/debezium-server-ecom.yaml
kubectl rollout restart deployment/debezium-server-ecom -n infra
```

### Step 3 — Create the Kafka Topic

```bash
kubectl exec -n infra deploy/kafka -- \
  kafka-topics --bootstrap-server localhost:9092 \
  --create --topic ecom-connector.public.reviews \
  --partitions 1 --replication-factor 1
```

Also add this to `infra/kafka/kafka-topics-init.yaml` so it is created on fresh cluster builds.

### Step 4 — Create the Sink Table in analytics-db

Add the DDL to `analytics/schema/analytics-ddl.sql`:

```sql
CREATE TABLE IF NOT EXISTS fact_reviews (
    id         UUID PRIMARY KEY,
    book_id    UUID,
    user_id    VARCHAR(255),
    rating     INT,
    comment    TEXT,
    created_at TIMESTAMP WITH TIME ZONE
);
```

Apply it immediately:
```bash
cat analytics/schema/analytics-ddl.sql | kubectl exec -i -n analytics deploy/analytics-db \
  -- psql -U analyticsuser -d analyticsdb
```

**This must happen before Flink submits the pipeline.** The JDBC sink requires the target table to exist — if it doesn't, the job fails immediately on startup.

### Step 5 — Declare the Flink Source Table

Add to `analytics/flink/sql/pipeline.sql` (and to the ConfigMap in `infra/flink/flink-sql-runner.yaml`):

```sql
-- SOURCE: Flink reads from this Kafka topic
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
```

### Step 6 — Declare the Flink Sink Table

```sql
-- SINK: Flink writes to this PostgreSQL table
CREATE TABLE sink_fact_reviews (
  id         STRING,
  book_id    STRING,
  user_id    STRING,
  rating     INT,
  comment    STRING,
  created_at TIMESTAMP(3),
  PRIMARY KEY (id) NOT ENFORCED   -- upsert mode
) WITH (
  'connector'                  = 'jdbc',
  'url'                        = 'jdbc:postgresql://analytics-db.analytics.svc.cluster.local:5432/analyticsdb?stringtype=unspecified',
  'table-name'                 = 'fact_reviews',
  'username'                   = '${ANALYTICS_DB_USER}',
  'password'                   = '${ANALYTICS_DB_PASSWORD}',
  'sink.buffer-flush.max-rows' = '1',
  'sink.buffer-flush.interval' = '1s'
);
```

### Step 7 — Wire Source to Sink with INSERT INTO

```sql
-- PIPELINE: connects kafka_reviews (source) to sink_fact_reviews (sink)
INSERT INTO sink_fact_reviews
SELECT
  after.id,
  after.book_id,
  after.user_id,
  after.rating,
  after.comment,
  CAST(REPLACE(REPLACE(after.created_at, 'T', ' '), 'Z', '') AS TIMESTAMP(3))
FROM kafka_reviews
WHERE after IS NOT NULL;
```

### Step 8 — Resubmit the Pipeline to Flink

Stop all existing jobs and resubmit with the new SQL:

```bash
# Stop existing jobs (they will be recreated)
for job_id in $(curl -sf http://localhost:32200/jobs | \
  python3 -c "import sys,json; [print(j['id']) for j in json.load(sys.stdin)['jobs'] if j['status']=='RUNNING']"); do
  curl -X PATCH "http://localhost:32200/jobs/${job_id}?mode=cancel"
  echo "Cancelled $job_id"
done

# Resubmit (now includes the reviews pipeline)
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=180s
```

### Step 9 — Verify

```bash
# 5 jobs should now be running (was 4)
curl -sf http://localhost:32200/jobs | python3 -c "
import sys, json
jobs = [j for j in json.load(sys.stdin)['jobs'] if j['status']=='RUNNING']
print(f'{len(jobs)} jobs running')
"

# Insert a test review into ecom-db
kubectl exec -n ecom deploy/ecom-db -- psql -U ecomuser -d ecomdb \
  -c "INSERT INTO reviews (id, book_id, user_id, rating, comment, created_at)
      VALUES (gen_random_uuid(), 'aaaaaaaa-0001-0001-0001-000000000001', 'user1', 5, 'Great book!', NOW())"

# Poll analytics-db for the review
kubectl exec -n analytics deploy/analytics-db -- psql -U analyticsuser -d analyticsdb \
  -c "SELECT id, rating, comment FROM fact_reviews LIMIT 5"
```

---

## 17. Common Misunderstandings

### "The source table stores data in Flink"

No. A Flink `CREATE TABLE` with `connector='kafka'` is a **schema declaration**, not a table in any database. No data is stored inside Flink. The table definition only lives in Flink's in-memory session catalog for the duration of the SQL submission. When the sql-runner Job exits, the catalog is gone — but the jobs keep running because the compiled DAG is submitted to the cluster, not the SQL text.

### "The sink table must be empty before Flink can write to it"

No. The sink table can already have data. Upsert mode (`ON CONFLICT DO UPDATE`) handles existing rows correctly. When Flink's initial snapshot events arrive (with `op='r'`), they upsert into existing rows rather than failing on duplicate key.

### "I need to restart Flink every time the source DB changes"

No — with one important clarification. Flink's **partition discovery** (`scan.topic-partition-discovery.interval`) automatically detects new Kafka partitions for *existing topics*. Adding a new *table* always requires adding a new source/sink declaration and resubmitting the SQL pipeline. The distinction is:
- More partitions on an existing topic → auto-detected, no restart needed
- New Kafka topic (new table) → SQL change + job resubmit required

### "Source and sink are separate jobs in Flink"

No. One `INSERT INTO ... SELECT ... FROM` statement creates one Flink streaming job that runs the entire pipeline: polling Kafka + transforming rows + writing to PostgreSQL. All three happen in the same task slot, in the same TaskManager thread. "Source" and "sink" are operator names within a single job, not separate jobs.

### "The JDBC sink creates a new connection for every row"

No. The JDBC sink maintains a long-lived connection pool to PostgreSQL. A single `PreparedStatement` is reused for all rows. The `sink.buffer-flush.max-rows=1` setting means the `executeBatch()` call happens after every row (no batching), but the connection itself remains open continuously.

---

## Summary

Apache Flink acts as both source and sink in this CDC pipeline:

| Role | What Flink Does | Connector | External System |
|------|----------------|-----------|----------------|
| **Source** | Reads CDC events from Kafka topics | `flink-connector-kafka` | Kafka (infra namespace) |
| **Sink** | Writes processed rows to analytics DB | `flink-connector-jdbc` | PostgreSQL analytics-db |

The connection between them is declared in a single `INSERT INTO ... SELECT ... FROM` SQL statement. Flink compiles this into a streaming operator chain: `KafkaSourceReader → Calc → JdbcSink`. Four such chains run concurrently in 4 task slots of the same TaskManager pod, processing orders, order items, books, and inventory in parallel.

The exactly-once guarantee is achieved by the checkpoint protocol: the source tracks Kafka offsets in checkpoint state, the sink flushes rows to PostgreSQL before acknowledging each checkpoint, and the JDBC upsert mode ensures replayed events are idempotent.

---

## Related Documents

- `docs/cdc/flink-streaming-sql-pipeline.md` — complete Flink pipeline reference
- `docs/cdc/debezium-server-guide.md` — Debezium Server architecture and operations
- `docs/cdc/debezium-flink-cdc.md` — full CDC pipeline overview
- `analytics/flink/sql/pipeline.sql` — authoritative SQL source
- `infra/flink/flink-sql-runner.yaml` — Kubernetes Job that submits the SQL
