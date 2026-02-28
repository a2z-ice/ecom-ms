# Debezium + Apache Flink CDC Pipeline

**Book Store Analytics Platform — Technical Deep Dive**

This document explains how change data capture (CDC) flows from the operational PostgreSQL databases through Debezium, Kafka, Apache Flink SQL, and into the analytics database that powers Superset dashboards.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Component Roles](#2-component-roles)
3. [Architecture Diagram](#3-architecture-diagram)
4. [Debezium: PostgreSQL WAL Capture](#4-debezium-postgresql-wal-capture)
5. [Kafka: Event Transport Layer](#5-kafka-event-transport-layer)
6. [Apache Flink: Streaming SQL Pipeline](#6-apache-flink-streaming-sql-pipeline)
7. [Analytics Database Schema](#7-analytics-database-schema)
8. [Superset Dashboards](#8-superset-dashboards)
9. [Accessing the Dashboards](#9-accessing-the-dashboards)
10. [Data Flow Walkthrough — Step by Step](#10-data-flow-walkthrough--step-by-step)
11. [Operational Guide](#11-operational-guide)
12. [E2E Test Coverage](#12-e2e-test-coverage)
13. [Screenshots Reference](#13-screenshots-reference)

---

## 1. Overview

The analytics pipeline captures every INSERT, UPDATE, and DELETE from the operational databases in real time — without any application code changes — and delivers them to a separate analytics database that Superset queries for dashboards.

```
Operational DBs ──► Debezium ──► Kafka ──► Flink SQL ──► Analytics DB ──► Superset
(PostgreSQL WAL)   (CDC Agent)  (Topics)  (SQL Jobs)    (PostgreSQL)     (Dashboards)
```

**Key properties:**
- **Zero application coupling** — services write to their own DB; analytics is a side effect
- **Exactly-once delivery** — Flink checkpoints + Kafka offset tracking prevent duplicate rows
- **Schema-free ingestion** — Debezium's `debezium-json` format is parsed natively by Flink SQL; no custom code
- **UPSERT semantics** — Flink's JDBC sink uses primary keys to `INSERT ... ON CONFLICT DO UPDATE`

---

## 2. Component Roles

| Component | Role | Namespace | Port |
|-----------|------|-----------|------|
| **ecom-db** | Source DB: orders, books, cart | `ecom` | 5432 (internal) |
| **inventory-db** | Source DB: inventory stock | `inventory` | 5432 (internal) |
| **Debezium** | CDC agent: reads PostgreSQL WAL, publishes to Kafka | `infra` | 8083 → host:32300 |
| **Kafka (KRaft)** | Event bus: durable topic storage | `infra` | 9092 (internal) |
| **Flink JobManager** | Coordinates streaming SQL jobs | `analytics` | 8081 → host:32200 |
| **Flink TaskManager** | Executes SQL operators | `analytics` | 6122 (internal) |
| **analytics-db** | Sink DB: fact/dim tables + 10 views | `analytics` | 5432 (internal) |
| **Superset** | Dashboards connecting to analytics-db | `analytics` | 8088 → host:32000 |

---

## 3. Architecture Diagram

### 3.1 Full Pipeline

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║                     BOOK STORE CDC ANALYTICS PIPELINE                          ║
╠══════════════════════════════════════════════════════════════════════════════════╣
║                                                                                ║
║  ┌─────────────────────────────────────────────────────────────────────────┐   ║
║  │  OPERATIONAL TIER  (ecom ns + inventory ns)                             │   ║
║  │                                                                         │   ║
║  │  ┌──────────────┐        ┌─────────────────┐                            │   ║
║  │  │   ecom-db    │        │  inventory-db   │                            │   ║
║  │  │  (PostgreSQL)│        │  (PostgreSQL)   │                            │   ║
║  │  │              │        │                 │                            │   ║
║  │  │  • orders    │        │  • inventory    │                            │   ║
║  │  │  • order_    │        │    (book_id,    │                            │   ║
║  │  │    items     │        │    qty, resvd)  │                            │   ║
║  │  │  • books     │        │                 │                            │   ║
║  │  └──────┬───────┘        └───────┬─────────┘                            │   ║
║  │         │ WAL (pg_logical)       │ WAL (pg_logical)                     │   ║
║  └─────────┼────────────────────────┼─────────────────────────────────────┘   ║
║            │                        │                                          ║
║  ┌─────────▼────────────────────────▼─────────────────────────────────────┐   ║
║  │  CAPTURE TIER  (infra ns)                                               │   ║
║  │                                                                         │   ║
║  │  ┌──────────────────────────────────────────────────────────────────┐   │   ║
║  │  │              DEBEZIUM (Kafka Connect 2.7.0.Final)                │   │   ║
║  │  │                                                                  │   │   ║
║  │  │   ┌───────────────────┐    ┌──────────────────────────────────┐  │   │   ║
║  │  │   │  ecom-connector   │    │     inventory-connector          │  │   │   ║
║  │  │   │ PostgresConnector │    │    PostgresConnector             │  │   │   ║
║  │  │   │                   │    │                                  │  │   │   ║
║  │  │   │ slot: debezium_   │    │ slot: debezium_inventory_slot    │  │   │   ║
║  │  │   │       ecom_slot   │    │ pub:  debezium_inventory_pub     │  │   │   ║
║  │  │   │ pub:  debezium_   │    │                                  │  │   │   ║
║  │  │   │       ecom_pub    │    │ Tables: public.inventory         │  │   │   ║
║  │  │   │                   │    └──────────────┬───────────────────┘  │   │   ║
║  │  │   │ Tables:           │                   │                      │   │   ║
║  │  │   │  public.orders    │                   │                      │   │   ║
║  │  │   │  public.order_    │                   │                      │   │   ║
║  │  │   │    items          │                   │                      │   │   ║
║  │  │   │  public.books     │                   │                      │   │   ║
║  │  │   └──────────┬────────┘                   │                      │   │   ║
║  │  │              │                            │                      │   │   ║
║  │  └──────────────┼────────────────────────────┼──────────────────────┘   │   ║
║  │                 │                            │                          │   ║
║  │  ┌──────────────▼────────────────────────────▼──────────────────────┐   │   ║
║  │  │              KAFKA (KRaft, no Zookeeper)                         │   │   ║
║  │  │                                                                  │   │   ║
║  │  │   ecom-connector.public.orders     ──────────────────────────►   │   │   ║
║  │  │   ecom-connector.public.order_items ─────────────────────────►  │   │   ║
║  │  │   ecom-connector.public.books      ──────────────────────────►   │   │   ║
║  │  │   inventory-connector.public.inventory ──────────────────────►   │   │   ║
║  │  │                                                                  │   │   ║
║  │  └──────────────────────────────────────────────────────────────────┘   │   ║
║  └─────────────────────────────────────────────────────────────────────────┘   ║
║                              │ (4 Kafka topics)                                ║
║  ┌───────────────────────────▼─────────────────────────────────────────────┐   ║
║  │  PROCESSING TIER  (analytics ns)                                        │   ║
║  │                                                                         │   ║
║  │  ┌──────────────────────────────────────────────────────────────────┐   │   ║
║  │  │              APACHE FLINK 1.20 (Session Cluster)                 │   │   ║
║  │  │                                                                  │   │   ║
║  │  │   JobManager (:8081)          TaskManager                        │   │   ║
║  │  │   ┌────────────────┐          ┌──────────────────────────────┐   │   │   ║
║  │  │   │ • Coordinates  │◄────────►│ • SQL operators              │   │   │   ║
║  │  │   │   4 SQL jobs   │  RPC     │ • 4 task slots               │   │   │   ║
║  │  │   │ • REST API     │  6123    │ • Checkpoint state           │   │   │   ║
║  │  │   │ • Web UI       │          │                              │   │   │   ║
║  │  │   └────────────────┘          └──────────────────────────────┘   │   │   ║
║  │  │                                                                  │   │   ║
║  │  │   ┌──────────────────────────────────────────────────────────┐   │   │   ║
║  │  │   │  SQL Pipeline (4 parallel INSERT INTO jobs)              │   │   │   ║
║  │  │   │                                                          │   │   │   ║
║  │  │   │  kafka_orders ──────────────► sink_fact_orders           │   │   │   ║
║  │  │   │  kafka_order_items ─────────► sink_fact_order_items      │   │   │   ║
║  │  │   │  kafka_books ──────────────► sink_dim_books              │   │   │   ║
║  │  │   │  kafka_inventory ──────────► sink_fact_inventory         │   │   │   ║
║  │  │   │                                                          │   │   │   ║
║  │  │   │  Format: debezium-json (native, no custom code)          │   │   │   ║
║  │  │   │  Sink:   JDBC (upsert via PRIMARY KEY)                   │   │   │   ║
║  │  │   │  Mode:   EXACTLY_ONCE (30s checkpoints)                  │   │   │   ║
║  │  │   └──────────────────────────────────────────────────────────┘   │   │   ║
║  │  └──────────────────────────────────────────────────────────────────┘   │   ║
║  └─────────────────────────────────────────────────────────────────────────┘   ║
║                              │ (JDBC upsert)                                   ║
║  ┌───────────────────────────▼─────────────────────────────────────────────┐   ║
║  │  ANALYTICS TIER  (analytics ns)                                         │   ║
║  │                                                                         │   ║
║  │  ┌──────────────────────────────────────────────────────────────────┐   │   ║
║  │  │              ANALYTICS-DB (PostgreSQL)                           │   │   ║
║  │  │                                                                  │   │   ║
║  │  │   Tables              Views (10)                                 │   │   ║
║  │  │   ─────────────       ───────────────────────────                │   │   ║
║  │  │   fact_orders         vw_product_sales_volume                    │   │   ║
║  │  │   fact_order_items    vw_sales_over_time                         │   │   ║
║  │  │   fact_inventory      vw_revenue_by_author                       │   │   ║
║  │  │   dim_books           vw_revenue_by_genre                        │   │   ║
║  │  │                       vw_order_status_distribution               │   │   ║
║  │  │                       vw_inventory_health                        │   │   ║
║  │  │                       vw_avg_order_value                         │   │   ║
║  │  │                       vw_top_books_by_revenue                    │   │   ║
║  │  │                       vw_inventory_turnover                      │   │   ║
║  │  │                       vw_book_price_distribution                 │   │   ║
║  │  └──────────────────────────────────────────────────────────────────┘   │   ║
║  │                              │                                          │   ║
║  │  ┌───────────────────────────▼──────────────────────────────────────┐   │   ║
║  │  │              APACHE SUPERSET (:32000)                            │   │   ║
║  │  │                                                                  │   │   ║
║  │  │   Dashboard 1: Book Store Analytics      (5 charts)             │   │   ║
║  │  │   Dashboard 2: Sales & Revenue Analytics (5 charts)             │   │   ║
║  │  │   Dashboard 3: Inventory Analytics       (4 charts)             │   │   ║
║  │  └──────────────────────────────────────────────────────────────────┘   │   ║
║  └─────────────────────────────────────────────────────────────────────────┘   ║
╚══════════════════════════════════════════════════════════════════════════════════╝
```

### 3.2 Data Flow Per Event (Single Order)

```
 User clicks "Checkout"
         │
         ▼
  ecom-service (Spring Boot)
  • Creates order row in ecom-db.orders
  • Creates order_items rows in ecom-db.order_items
  • Publishes order.created to Kafka (application event)
         │
         │ (WAL replication slot — independent of app)
         ▼
  Debezium ecom-connector
  • Reads pg_logical WAL from ecom-db
  • Wraps row in Debezium envelope:
    {
      "op": "c",              ← c=create, u=update, d=delete, r=read(snapshot)
      "before": null,         ← null for INSERT
      "after": {              ← the actual row data
        "id": "uuid...",
        "user_id": "...",
        "total": 39.99,
        "status": "CONFIRMED",
        "created_at": 1709123456789   ← epoch ms (time.precision.mode: connect)
      },
      "source": { "table": "orders", "lsn": 12345678 }
    }
  • Publishes to Kafka topic: ecom-connector.public.orders
         │
         │
         ▼
  Kafka topic: ecom-connector.public.orders
  • Partition key: primary key value (order UUID)
  • Replication factor: 1 (single-node cluster)
  • Retained: until Flink consumer commits offset
         │
         │
         ▼
  Flink SQL (kafka_orders → sink_fact_orders)
  • Reads with format: debezium-json  ← extracts "after" automatically
  • Applies: TO_TIMESTAMP_LTZ(created_at, 3)  ← epoch ms → TIMESTAMP(3)
  • Writes via JDBC: INSERT INTO fact_orders (...) ON CONFLICT (id) DO UPDATE
  • Checkpoints every 30s → exactly-once guarantee
         │
         │
         ▼
  analytics-db.fact_orders
  • Row available within seconds of the original INSERT
  • Joins with dim_books via analytics views
         │
         │
         ▼
  Superset queries vw_product_sales_volume, vw_sales_over_time, etc.
  • Refreshes on dashboard load
  • Shows updated totals, charts, and KPIs
```

---

## 4. Debezium: PostgreSQL WAL Capture

### 4.1 What Is a WAL?

PostgreSQL records every data change in a **Write-Ahead Log (WAL)** before applying it to heap files. This enables crash recovery and replication. Debezium subscribes to the WAL using **logical replication slots** — the same mechanism used by read replicas.

```
PostgreSQL ecom-db
┌────────────────────────────────────────────────────────────┐
│                                                            │
│  Application writes:                                       │
│  INSERT INTO orders VALUES (...)                          │
│         │                                                  │
│         ▼                                                  │
│  WAL (Write-Ahead Log)  ←── append-only, sequential       │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ LSN 0/1A2B3C4D: INSERT orders id=abc user_id=u1 ... │ │
│  │ LSN 0/1A2B3C5E: INSERT order_items id=xyz ...       │ │
│  │ LSN 0/1A2B3C6F: UPDATE inventory SET qty=qty-1 ...  │ │
│  └──────────────────────────────────────────────────────┘ │
│         │                                                  │
│         ├──► Heap files (actual data storage)              │
│         │                                                  │
│         └──► Logical Replication Slot: debezium_ecom_slot  │
│              (holds position; Debezium reads from here)    │
└────────────────────────────────────────────────────────────┘
         │
         │  pg_logical plugin (pgoutput)
         ▼
  Debezium reads decoded WAL events
```

### 4.2 Connector Configuration

**ecom-connector** (`infra/debezium/connectors/ecom-connector.json`):

```json
{
  "connector.class":      "io.debezium.connector.postgresql.PostgresConnector",
  "plugin.name":          "pgoutput",          ← built-in to PostgreSQL 10+
  "database.dbname":      "ecomdb",
  "table.include.list":   "public.orders,public.order_items,public.books",
  "slot.name":            "debezium_ecom_slot", ← replication slot name
  "publication.name":     "debezium_ecom_pub",  ← publication name
  "decimal.handling.mode":"double",             ← NUMERIC → DOUBLE PRECISION
  "time.precision.mode":  "connect",            ← timestamps → epoch milliseconds
  "snapshot.mode":        "initial"             ← reads existing rows on first start
}
```

**inventory-connector** (`infra/debezium/connectors/inventory-connector.json`):

```json
{
  "connector.class":      "io.debezium.connector.postgresql.PostgresConnector",
  "database.dbname":      "inventorydb",
  "table.include.list":   "public.inventory",
  "slot.name":            "debezium_inventory_slot",
  "publication.name":     "debezium_inventory_pub",
  "decimal.handling.mode":"double",
  "time.precision.mode":  "connect",
  "snapshot.mode":        "initial"
}
```

### 4.3 Debezium Envelope Format

Every message published to Kafka has this structure (schemas disabled):

```json
{
  "op":     "c",           ← operation: c=create, u=update, d=delete, r=read
  "before": null,          ← row state before change (null for INSERT)
  "after":  {              ← row state after change (null for DELETE)
    "id":         "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "user_id":    "keycloak-user-uuid",
    "total":      39.98,
    "status":     "CONFIRMED",
    "created_at": 1709123456789
  },
  "source": {
    "version":  "2.7.0.Final",
    "connector":"postgresql",
    "name":     "ecom-connector",
    "ts_ms":    1709123456790,
    "db":       "ecomdb",
    "schema":   "public",
    "table":    "orders",
    "lsn":      26738560
  },
  "ts_ms": 1709123456791
}
```

> **Key design decision:** `schemas.enable: false` is set so Kafka messages are plain JSON (no schema registry). This is why the Kafka Connect JDBC Sink connector could NOT be used directly (it requires schemas). Flink's `debezium-json` format handles schemaless envelopes natively.

### 4.4 Initial Snapshot Behaviour

On first startup, Debezium runs an **initial snapshot** with `snapshot.mode: initial`:

```
Phase 1 (Snapshot):
  Debezium takes a consistent snapshot of all tables
  Each existing row is published with op="r" (read)
  Flink processes these and populates fact/dim tables

Phase 2 (Streaming):
  Debezium switches to WAL streaming
  All subsequent changes are published in real time
  LSN position is tracked in the replication slot
```

This means analytics-db is always seeded with existing data, then kept in sync.

---

## 5. Kafka: Event Transport Layer

### 5.1 Topics

| Topic | Source | Consumer |
|-------|--------|----------|
| `ecom-connector.public.orders` | ecom-db `orders` table | Flink `kafka_orders` source |
| `ecom-connector.public.order_items` | ecom-db `order_items` table | Flink `kafka_order_items` source |
| `ecom-connector.public.books` | ecom-db `books` table | Flink `kafka_books` source |
| `inventory-connector.public.inventory` | inventory-db `inventory` table | Flink `kafka_inventory` source |

Topic naming convention: `<connector-name>.<schema>.<table>`

### 5.2 Topic Configuration

All topics are auto-created by Debezium with:
- **Replication factor**: 1 (single-broker KRaft cluster)
- **Partitions**: 1 (single connector task)
- **Retention**: default (7 days)

### 5.3 Kafka Message Layout

```
Key:   { "id": "3fa85f64-..." }       ← primary key (JSON, no schema)
Value: { "op": "c", "after": {...} }  ← Debezium envelope (JSON, no schema)
```

Partition routing uses the key, ensuring all changes to the same row go to the same partition (preserving per-key ordering).

---

## 6. Apache Flink: Streaming SQL Pipeline

### 6.1 Cluster Architecture

```
                    ┌─────────────────────────────────┐
                    │        FLINK SESSION CLUSTER      │
                    │                                   │
                    │  ┌──────────────────────────────┐ │
                    │  │       JobManager             │ │
                    │  │                              │ │
                    │  │  • REST API :8081            │ │
                    │  │  • Web Dashboard (Angular)   │ │
                    │  │  • Job scheduling            │ │
                    │  │  • Checkpoint coordination   │ │
                    │  │  • TaskManager heartbeat     │ │
                    │  └───────────────┬──────────────┘ │
                    │                  │ RPC :6123       │
                    │  ┌───────────────▼──────────────┐ │
                    │  │       TaskManager            │ │
                    │  │                              │ │
                    │  │  • 4 task slots              │ │
                    │  │  • SQL operators execution   │ │
                    │  │  • Checkpoint state          │ │
                    │  │  • Kafka consumer threads    │ │
                    │  │  • JDBC writer threads       │ │
                    │  └──────────────────────────────┘ │
                    │                                   │
                    │  PVC: flink-checkpoints-pvc       │
                    │  Path: /opt/flink/checkpoints     │
                    └─────────────────────────────────┘
```

### 6.2 SQL Pipeline (`analytics/flink/sql/pipeline.sql`)

The pipeline is submitted once via a Kubernetes Job (`flink-sql-runner`). It creates 4 source tables and 4 sink tables, then runs 4 continuous INSERT INTO statements.

**Source Table Pattern (Kafka + debezium-json):**

```sql
CREATE TABLE kafka_orders (
  id         STRING,
  user_id    STRING,
  total      DOUBLE,
  status     STRING,
  created_at BIGINT,            -- epoch ms from Debezium (time.precision.mode: connect)
  PRIMARY KEY (id) NOT ENFORCED -- enables changelog mode for upserts
) WITH (
  'connector'                    = 'kafka',
  'topic'                        = 'ecom-connector.public.orders',
  'properties.bootstrap.servers' = 'kafka.infra.svc.cluster.local:9092',
  'properties.group.id'          = 'flink-analytics-consumer',
  'format'                       = 'debezium-json',    -- native CDC format support
  'debezium-json.schema-include' = 'false',            -- no schema registry
  'scan.startup.mode'            = 'earliest-offset'   -- replay from beginning
);
```

**Sink Table Pattern (JDBC + upsert):**

```sql
CREATE TABLE sink_fact_orders (
  id         STRING,
  user_id    STRING,
  total      DOUBLE,
  status     STRING,
  created_at TIMESTAMP(3),     -- converted from epoch ms
  PRIMARY KEY (id) NOT ENFORCED -- triggers JDBC upsert: INSERT ... ON CONFLICT DO UPDATE
) WITH (
  'connector'                   = 'jdbc',
  'url'                         = 'jdbc:postgresql://analytics-db.analytics.svc.cluster.local:5432/analyticsdb',
  'table-name'                  = 'fact_orders',
  'username'                    = '${ANALYTICS_DB_USER}',
  'password'                    = '${ANALYTICS_DB_PASSWORD}',
  'sink.buffer-flush.max-rows'  = '1',    -- flush every row (low latency)
  'sink.buffer-flush.interval'  = '1s'    -- max 1s flush delay
);
```

**Pipeline Statements (4 continuous jobs):**

```sql
-- Job 1: Orders
INSERT INTO sink_fact_orders
SELECT id, user_id, total, status,
       TO_TIMESTAMP_LTZ(created_at, 3)   -- epoch ms → TIMESTAMP(3) with timezone
FROM kafka_orders;

-- Job 2: Order Items
INSERT INTO sink_fact_order_items
SELECT id, order_id, book_id, quantity, price_at_purchase
FROM kafka_order_items;

-- Job 3: Books (catalog dimension)
INSERT INTO sink_dim_books
SELECT id, title, author, price, description, cover_url, isbn, genre,
       published_year, TO_TIMESTAMP_LTZ(created_at, 3)
FROM kafka_books;

-- Job 4: Inventory
INSERT INTO sink_fact_inventory
SELECT book_id, quantity, reserved,
       TO_TIMESTAMP_LTZ(updated_at, 3)
FROM kafka_inventory;
```

### 6.3 Checkpoint Mechanism

```
Timeline:
  T=0    T=30s   T=60s   T=90s
   │       │       │       │
   ▼       ▼       ▼       ▼
 Job     CKP-1   CKP-2   CKP-3
 Start    │       │       │
          │       │       │
  Kafka offset committed to:  /opt/flink/checkpoints/...
  JDBC state flushed to analytics-db

If pod crashes between T=60s and T=90s:
  → Flink restores from CKP-2
  → Re-reads Kafka from the offset saved at CKP-2
  → Any rows written between CKP-2 and crash are re-written (idempotent via ON CONFLICT DO UPDATE)
  → No data loss, no duplicates
```

### 6.4 Type Conversion Reference

| Debezium type | Kafka JSON | Flink SQL type | Notes |
|---------------|-----------|----------------|-------|
| TIMESTAMP | epoch ms (BIGINT) | `TO_TIMESTAMP_LTZ(col, 3)` | `time.precision.mode: connect` |
| NUMERIC/DECIMAL | DOUBLE | DOUBLE | `decimal.handling.mode: double` |
| UUID | STRING | STRING | Cast to UUID in PostgreSQL sink |
| VARCHAR | STRING | STRING | Direct mapping |
| INTEGER | INT | INT | Direct mapping |

### 6.5 Docker Image (`analytics/flink/Dockerfile`)

```dockerfile
# Stage 1: Download connector JARs
FROM eclipse-temurin:17-jdk-alpine AS downloader
RUN curl -o flink-connector-kafka-3.4.0-1.20.jar    \
         https://repo1.maven.org/...
RUN curl -o flink-connector-jdbc-3.2.0-1.20.jar     \
         https://repo1.maven.org/...
RUN curl -o postgresql-42.7.4.jar                    \
         https://repo1.maven.org/...
RUN curl -o kafka-clients-3.7.0.jar                  \
         https://repo1.maven.org/...

# Stage 2: Flink runtime with baked-in connectors
FROM flink:1.20-scala_2.12-java17
COPY --from=downloader /jars/*.jar /opt/flink/lib/
# /opt/flink/lib/ is auto-classpath — no manual configuration needed
```

---

## 7. Analytics Database Schema

### 7.1 Fact and Dimension Tables

```sql
-- Dimension: book catalog (from Debezium CDC of ecom-db.books)
CREATE TABLE dim_books (
    id             UUID PRIMARY KEY,
    title          VARCHAR(255),
    author         VARCHAR(255),
    price          DOUBLE PRECISION,
    genre          VARCHAR(100),
    isbn           VARCHAR(20),
    published_year INT,
    created_at     TIMESTAMP WITH TIME ZONE,
    synced_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Fact: completed orders (from ecom-db.orders)
CREATE TABLE fact_orders (
    id         UUID PRIMARY KEY,    -- matches source orders.id
    user_id    VARCHAR(255),
    total      DOUBLE PRECISION,
    status     VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE,
    synced_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Fact: line items (from ecom-db.order_items)
CREATE TABLE fact_order_items (
    id                UUID PRIMARY KEY,
    order_id          UUID,           -- FK-like (no FK constraint)
    book_id           UUID,           -- FK-like (no FK constraint)
    quantity          INT,
    price_at_purchase DOUBLE PRECISION,
    synced_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Fact: current inventory levels (from inventory-db.inventory)
CREATE TABLE fact_inventory (
    book_id    UUID PRIMARY KEY,
    quantity   INT,
    reserved   INT,
    updated_at TIMESTAMP WITH TIME ZONE,
    synced_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

> **No FK constraints** — CDC delivery order is not guaranteed. A row in `fact_order_items` may arrive before the corresponding `dim_books` row from the snapshot. Foreign key checks would fail; analytics queries handle this with JOINs.

### 7.2 Analytics Views (10 Total)

```
View                        Purpose                         Used By
──────────────────────────  ───────────────────────────     ──────────────────────────
vw_product_sales_volume     Units sold + revenue per book   Dashboard 1 (bar chart)
vw_sales_over_time          Daily revenue trend             Dashboard 1 (line chart)
vw_revenue_by_author        Revenue grouped by author       Dashboard 1 (bar chart)
vw_top_books_by_revenue     RANK() by total revenue         Dashboard 1 (bar chart)
vw_book_price_distribution  Price bucket counts             Dashboard 1 (pie chart)
vw_avg_order_value          Daily avg order value           Dashboard 2 (line chart)
vw_order_status_distribution Count by status (pie)          Dashboard 2 (pie chart)
vw_inventory_health         Stock + reserved + available    Dashboard 3 (table)
vw_inventory_turnover       (sold/stock)×100 per book       Dashboard 3 (bar chart)
vw_revenue_by_genre         Revenue grouped by genre        Dashboard 3 (bar chart)
```

---

## 8. Superset Dashboards

### 8.1 Dashboard 1: "Book Store Analytics"

```
┌─────────────────────────────────────────────────────────────────┐
│                    BOOK STORE ANALYTICS                         │
├─────────────────────────────────┬───────────────────────────────┤
│  Product Sales Volume           │  Sales Over Time              │
│  (Bar: title × units_sold)      │  (Line: sale_date × revenue)  │
├─────────────────────────────────┼───────────────────────────────┤
│  Revenue by Author              │  Top Books by Revenue         │
│  (Bar: author × revenue)        │  (Bar: title × total_revenue) │
├─────────────────────────────────┴───────────────────────────────┤
│  Book Price Distribution (Pie: price_range × book_count)        │
└─────────────────────────────────────────────────────────────────┘
```

**Screenshot:** `e2e/screenshots/superset-09-bookstore-dashboard.png`

### 8.2 Dashboard 2: "Sales & Revenue Analytics"

```
┌─────────────────────────────────────────────────────────────────┐
│                  SALES & REVENUE ANALYTICS                      │
├─────────────────┬─────────────────┬─────────────────────────────┤
│ Total Revenue   │ Total Orders    │ Average Order Value         │
│ KPI (big num)   │ KPI (big num)   │ KPI (big num)               │
├─────────────────┴─────────────────┼─────────────────────────────┤
│  Order Status Distribution (Pie)  │ Avg Order Value Over Time   │
│  (status × order_count)           │ (Line: date × avg_value)    │
└───────────────────────────────────┴─────────────────────────────┘
```

**Screenshot:** `e2e/screenshots/superset-11-revenue-dashboard.png`

### 8.3 Dashboard 3: "Inventory Analytics"

```
┌─────────────────────────────────────────────────────────────────┐
│                     INVENTORY ANALYTICS                         │
├─────────────────────────────────────────────────────────────────┤
│  Inventory Health Table                                         │
│  (table: title, author, stock_qty, reserved, available, status) │
├─────────────────────────────────┬───────────────────────────────┤
│  Stock vs Reserved              │  Inventory Turnover Rate      │
│  (Grouped bar: qty + reserved)  │  (Bar: title × turnover_pct)  │
├─────────────────────────────────┴───────────────────────────────┤
│  Revenue by Genre (Bar: genre × revenue)                        │
└─────────────────────────────────────────────────────────────────┘
```

**Screenshot:** `e2e/screenshots/superset-13-inventory-dashboard.png`

---

## 9. Accessing the Dashboards

### 9.1 Port Map

| Service | URL | Notes |
|---------|-----|-------|
| Superset Dashboards | `http://localhost:32000` | Credentials: admin / CHANGE_ME |
| Flink Web Dashboard | `http://localhost:32200` | Shows running jobs, checkpoints, task managers |
| Debezium REST API | `http://localhost:32300` | JSON REST API for connector management |

### 9.2 Setting Up Docker Proxy Containers (one-time per cluster recreation)

For services exposed via NodePort on the kind node, a docker socat proxy is needed to forward from the host:

```bash
# Get the kind control-plane node IP
CTRL_IP=$(kubectl get node bookstore-control-plane \
  -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')

# Flink Dashboard → localhost:32200
docker rm -f flink-proxy 2>/dev/null || true
docker run -d --name flink-proxy \
  --network kind --restart unless-stopped \
  -p 32200:32200 \
  alpine/socat TCP-LISTEN:32200,fork,reuseaddr TCP:${CTRL_IP}:32200

# Debezium REST API → localhost:32300
docker rm -f debezium-proxy 2>/dev/null || true
docker run -d --name debezium-proxy \
  --network kind --restart unless-stopped \
  -p 32300:32300 \
  alpine/socat TCP-LISTEN:32300,fork,reuseaddr TCP:${CTRL_IP}:32300
```

### 9.3 Debezium REST API Quick Reference

```bash
# List all connectors
curl http://localhost:32300/connectors

# Get connector status (RUNNING, PAUSED, FAILED)
curl http://localhost:32300/connectors/ecom-connector/status | python3 -m json.tool
curl http://localhost:32300/connectors/inventory-connector/status | python3 -m json.tool

# Get connector configuration
curl http://localhost:32300/connectors/ecom-connector/config | python3 -m json.tool

# List topics written by a connector
curl http://localhost:32300/connectors/ecom-connector/topics | python3 -m json.tool

# Restart a failed connector
curl -X POST http://localhost:32300/connectors/ecom-connector/restart

# Pause / Resume
curl -X PUT http://localhost:32300/connectors/ecom-connector/pause
curl -X PUT http://localhost:32300/connectors/ecom-connector/resume

# List available connector plugins
curl http://localhost:32300/connector-plugins | python3 -m json.tool
```

### 9.4 Flink REST API Quick Reference

```bash
# Cluster overview (taskmanagers, slots, jobs)
curl http://localhost:32200/overview | python3 -m json.tool

# List all jobs and their status
curl http://localhost:32200/jobs | python3 -m json.tool

# Get details for a specific job
JOB_ID=<id-from-above>
curl http://localhost:32200/jobs/${JOB_ID} | python3 -m json.tool

# Get checkpoint configuration
curl http://localhost:32200/jobs/${JOB_ID}/checkpoints/config | python3 -m json.tool

# Get latest checkpoint stats
curl http://localhost:32200/jobs/${JOB_ID}/checkpoints | python3 -m json.tool

# List task managers
curl http://localhost:32200/taskmanagers | python3 -m json.tool
```

---

## 10. Data Flow Walkthrough — Step by Step

This section traces a single checkout through every layer of the pipeline.

### Step 1 — User places order

```
User browser → Istio Gateway → ecom-service → ecom-db

INSERT INTO orders VALUES (id='abc', user_id='u1', total=39.99, status='CONFIRMED');
INSERT INTO order_items VALUES (id='xyz', order_id='abc', book_id='b1', qty=2, price=19.99);
```

**Latency:** ~50ms (HTTP round-trip)

### Step 2 — Debezium reads WAL

```
ecom-db WAL: LSN 0x1A2B3C → INSERT orders ...

Debezium ecom-connector:
  1. Reads logical replication stream from debezium_ecom_slot
  2. Decodes: table=orders, op=c, after={ id:'abc', total:39.99, created_at:1709123456789 }
  3. Serializes to JSON (schemas disabled)
  4. Publishes to Kafka: topic=ecom-connector.public.orders, key={ id:'abc' }
```

**Latency:** ~100–500ms (WAL decode + Kafka produce)

### Step 3 — Kafka stores the event

```
Topic: ecom-connector.public.orders
Partition 0: offset 1234
Message:
  Key:   {"id":"abc"}
  Value: {"op":"c","after":{"id":"abc","user_id":"u1","total":39.99,"status":"CONFIRMED","created_at":1709123456789},"source":{...}}
```

**Retention:** configurable (default 7 days)

### Step 4 — Flink SQL reads and transforms

```sql
-- Flink reads Kafka message
kafka_orders row: { id: 'abc', user_id: 'u1', total: 39.99, status: 'CONFIRMED', created_at: 1709123456789 }

-- TO_TIMESTAMP_LTZ converts epoch ms:
-- 1709123456789 → 2024-02-28 21:17:36.789 UTC (TIMESTAMP(3) WITH TIME ZONE)

-- Flink emits to JDBC sink:
INSERT INTO fact_orders (id, user_id, total, status, created_at)
VALUES ('abc', 'u1', 39.99, 'CONFIRMED', '2024-02-28T21:17:36.789Z')
ON CONFLICT (id) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  total = EXCLUDED.total,
  status = EXCLUDED.status,
  created_at = EXCLUDED.created_at;
```

**Latency:** ~200ms–2s (Kafka poll + SQL eval + JDBC flush with `sink.buffer-flush.interval=1s`)

### Step 5 — analytics-db row is available

```sql
SELECT id, total, status FROM fact_orders WHERE id = 'abc';
-- Returns: abc | 39.99 | CONFIRMED   ← within ~1-3 seconds of the checkout
```

### Step 6 — Superset dashboard reflects the order

```
Next time Superset loads vw_sales_over_time:
  SELECT DATE(created_at) AS sale_date, SUM(total) AS daily_revenue
  FROM fact_orders WHERE status != 'CANCELLED'
  GROUP BY DATE(created_at)
  → Today's revenue increases by 39.99
```

**Total end-to-end latency: typically 1–5 seconds** (WAL read + Kafka + Flink flush)

---

## 11. Operational Guide

### 11.1 Check CDC Pipeline Health

```bash
# 1. Debezium connectors running?
curl -s http://localhost:32300/connectors/ecom-connector/status | \
  python3 -c "import sys,json; s=json.load(sys.stdin); print('State:', s['connector']['state'])"

# 2. Flink jobs running?
curl -s http://localhost:32200/jobs | \
  python3 -c "import sys,json; j=json.load(sys.stdin); print('Running:', sum(1 for x in j['jobs'] if x['status']=='RUNNING'))"

# 3. analytics-db has data?
kubectl exec -n analytics deployment/analytics-db -- \
  psql -U analyticsuser analyticsdb -c "SELECT COUNT(*) FROM dim_books; SELECT COUNT(*) FROM fact_orders;"

# 4. Views return results?
kubectl exec -n analytics deployment/analytics-db -- \
  psql -U analyticsuser analyticsdb -c "SELECT * FROM vw_inventory_health LIMIT 3;"
```

### 11.2 Re-submit Flink SQL Jobs

If all 4 Flink jobs stop (e.g., after cluster restart):

```bash
# Delete old runner job
kubectl delete job flink-sql-runner -n analytics --ignore-not-found

# Re-submit
kubectl apply -f infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=180s

# Verify jobs are running
curl http://localhost:32200/jobs | python3 -m json.tool
```

### 11.3 Re-register Debezium Connectors

If connectors are missing (e.g., after Kafka topic wipe):

```bash
bash infra/debezium/register-connectors.sh
```

### 11.4 Rebuild Superset Dashboards

If Superset loses its SQLite state (e.g., PVC issue):

```bash
# Run the bootstrap job
kubectl delete job superset-bootstrap -n analytics --ignore-not-found
kubectl apply -f infra/superset/bootstrap-job.yaml
kubectl wait --for=condition=complete job/superset-bootstrap -n analytics --timeout=300s
```

### 11.5 Run E2E Verification

```bash
# Full E2E suite (all ~60 tests)
cd e2e && npm run test

# Just CDC pipeline tests
cd e2e && npm run test -- debezium-flink.spec.ts

# Just Superset tests
cd e2e && npm run test -- superset.spec.ts
```

### 11.6 View Logs

```bash
# Debezium logs
kubectl logs -n infra deploy/debezium --tail=50

# Flink JobManager logs
kubectl logs -n analytics deploy/flink-jobmanager --tail=50

# Flink TaskManager logs
kubectl logs -n analytics deploy/flink-taskmanager --tail=50

# Flink SQL runner job logs
kubectl logs -n analytics job/flink-sql-runner

# Analytics DB query log
kubectl logs -n analytics deploy/analytics-db --tail=20
```

---

## 12. E2E Test Coverage

### 12.1 `e2e/debezium-flink.spec.ts` (29 tests)

```
Suite: Debezium REST API (localhost:32300)
  ✓ API root is accessible and returns version info
  ✓ GET /connectors lists both CDC connectors
  ✓ ecom-connector is in RUNNING state
  ✓ inventory-connector is in RUNNING state
  ✓ ecom-connector config monitors correct tables
  ✓ inventory-connector config monitors inventory table
  ✓ ecom-connector has produced Kafka topics
  ✓ inventory-connector has produced inventory Kafka topic
  ✓ GET /connector-plugins lists PostgreSQL connector plugin

Suite: Flink Web Dashboard (localhost:32200)
  ✓ REST API /overview is accessible
  ✓ Cluster has at least 1 TaskManager registered
  ✓ Cluster has available task slots
  ✓ /jobs lists running streaming jobs
  ✓ all 4 CDC pipeline jobs are in RUNNING state
  ✓ /taskmanagers returns task manager details
  ✓ Web dashboard page loads in browser
  ✓ Dashboard shows running jobs in UI
  ✓ Checkpoint configuration is EXACTLY_ONCE

Suite: CDC End-to-End Data Flow
  ✓ dim_books is populated from initial Debezium snapshot via Flink
  ✓ fact_inventory is populated from initial Debezium snapshot via Flink
  ✓ Flink JDBC sink writes dim_books with correct column types
  ✓ analytics view vw_product_sales_volume returns data
  ✓ analytics view vw_inventory_health returns stock levels
  ✓ analytics view vw_book_price_distribution buckets are correct
  ✓ all 10 analytics views exist and are queryable
  ✓ CDC real-time flow: insert into ecom-db appears in analytics-db via Flink

Suite: Operational Health
  ✓ Debezium pod is Running (via kubectl)
  ✓ Flink JobManager pod is Running (via kubectl)
  ✓ Flink TaskManager pod is Running (via kubectl)
  ✓ Debezium NodePort service exists at port 32300
  ✓ Flink NodePort service exists at port 32200
  ✓ Flink checkpoint storage PVC is bound
  ✓ analytics-db has all 4 fact/dim tables
```

### 12.2 `e2e/superset.spec.ts` (17 tests)

```
Suite: Superset Analytics
  ✓ Superset API: all 3 dashboards exist
  ✓ Superset API: all 14 charts exist
  ✓ Superset API: all 10 datasets exist
  ✓ UI: dashboard list shows all 3 dashboards
  ✓ UI: chart list shows all 14 charts
  ✓ Dashboard: "Book Store Analytics" opens and renders charts
  ✓ Dashboard: "Sales & Revenue Analytics" exists and opens
  ✓ Dashboard: "Inventory Analytics" exists and opens
  ✓ All 3 dashboards render without error alerts
  ✓ Chart: "Product Sales Volume" bar chart is in chart list
  ✓ Chart: "Inventory Health Table" is in chart list
  ✓ Chart: "Total Revenue KPI" is in chart list
  ✓ Chart: "Revenue by Genre" is in chart list
  (+ 4 screenshot-only tests)
```

### 12.3 `e2e/cdc.spec.ts` (3 existing tests)

```
Suite: CDC Pipeline
  ✓ order placed via UI appears in analytics DB within 30s
  ✓ books dim table is populated in analytics DB
  ✓ inventory table is synced to analytics DB
```

---

## 13. Screenshots Reference

Screenshots are captured during E2E test runs and saved to `e2e/screenshots/`.

| File | Content |
|------|---------|
| `debezium-01-api-accessible.png` | Debezium REST API root response |
| `debezium-02-ecom-connector-running.png` | ecom-connector RUNNING state |
| `debezium-03-inventory-connector-running.png` | inventory-connector RUNNING state |
| `debezium-04-connector-topics.png` | Topics produced by ecom-connector |
| `flink-01-overview-api.png` | Flink cluster overview API response |
| `flink-02-running-jobs.png` | Flink /jobs API response |
| `flink-03-four-jobs-running.png` | All 4 streaming jobs in RUNNING state |
| `flink-04-web-dashboard.png` | Flink Web Dashboard (Angular UI) |
| `flink-05-dashboard-overview.png` | Flink dashboard overview pane |
| `cdc-flink-01-dim-books-populated.png` | dim_books rows from snapshot |
| `cdc-flink-02-fact-inventory-populated.png` | fact_inventory rows from snapshot |
| `cdc-flink-05-view-inventory-health.png` | vw_inventory_health with status labels |
| `cdc-flink-09-order-in-analytics.png` | Test order visible in analytics-db |
| `health-01-debezium-pod-running.png` | kubectl get pod output for Debezium |
| `health-02-flink-jm-pod-running.png` | kubectl get pod output for JobManager |
| `health-06-flink-pvc-bound.png` | PVC bound status |
| `superset-09-bookstore-dashboard.png` | Book Store Analytics dashboard |
| `superset-11-revenue-dashboard.png` | Sales & Revenue Analytics dashboard |
| `superset-13-inventory-dashboard.png` | Inventory Analytics dashboard |

To re-generate all screenshots:
```bash
cd e2e && npm run test -- --reporter=html
```

---

*Generated by Claude Code — Session 18 (Flink CDC Pipeline & Superset Analytics)*
