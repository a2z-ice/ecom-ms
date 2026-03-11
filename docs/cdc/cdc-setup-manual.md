# CDC Pipeline — Complete Manual Setup Guide

This guide walks you through setting up the entire Change Data Capture (CDC) pipeline from scratch, component by component. Every Kubernetes manifest, configuration value, and test command is included. Follow each stage in order — each one depends on the previous.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CDC Pipeline                                    │
│                                                                         │
│  ecom-db (PostgreSQL)                                                   │
│  ├── WAL (Write-Ahead Log, wal_level=logical)                           │
│  └── Tables: orders, order_items, books                                 │
│       │                                                                 │
│  inventory-db (PostgreSQL)                                              │
│  ├── WAL (Write-Ahead Log, wal_level=logical)                           │
│  └── Table: inventory                                                   │
│       │                                                                 │
│       ▼  (pgoutput replication slot)                                    │
│  Debezium 2.7 (Kafka Connect)               namespace: infra            │
│  ├── ecom-connector     → reads ecom-db WAL                             │
│  └── inventory-connector → reads inventory-db WAL                      │
│       │                                                                 │
│       ▼  (4 CDC topics)                                                 │
│  Kafka (KRaft, no Zookeeper)                namespace: infra            │
│  ├── ecom-connector.public.books        (3 partitions)                  │
│  ├── ecom-connector.public.orders       (3 partitions)                  │
│  ├── ecom-connector.public.order_items  (3 partitions)                  │
│  └── inventory-connector.public.inventory (3 partitions)               │
│       │                                                                 │
│       ▼  (Flink SQL reads from Kafka)                                   │
│  Apache Flink 1.20 (Session Cluster)        namespace: analytics        │
│  ├── JobManager + SQL Gateway (port 9091)                               │
│  ├── TaskManager (4 slots)                                              │
│  └── 4 streaming INSERT jobs (hashmap state backend, 30s checkpoints)  │
│       │                                                                 │
│       ▼  (JDBC upsert via flink-connector-jdbc)                         │
│  analytics-db (PostgreSQL)                  namespace: analytics        │
│  ├── fact_orders, fact_order_items                                      │
│  ├── dim_books, fact_inventory                                          │
│  └── 10 views (vw_*)                                                    │
│       │                                                                 │
│       ▼                                                                 │
│  Apache Superset                            namespace: analytics        │
│  └── 3 dashboards / 16 charts                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

**Data flow for a single INSERT into `ecom-db.public.orders`:**

```
INSERT INTO orders (...)           -- application writes to ecom-db
    → PostgreSQL WAL record        -- wal_level=logical writes change to WAL
    → Debezium reads replication slot  -- ecom-connector streams WAL
    → Kafka topic: ecom-connector.public.orders  -- Debezium publishes JSON envelope
    → Flink KafkaSource (partition 0,1,2)  -- Flink reads from Kafka
    → Flink extracts `after` ROW   -- INSERT WHERE after IS NOT NULL
    → JDBC upsert → fact_orders    -- analytics-db updated in < 2s
    → Superset refreshes dashboard -- charts reflect new data
```

---

## Prerequisites

Before starting, verify:

```bash
# Kind cluster is running
kubectl get nodes
# Expected: 3 nodes (control-plane + 2 workers) all Ready

# Namespaces exist
kubectl get namespaces | grep -E "ecom|inventory|infra|analytics"
# Expected: ecom, inventory, infra, analytics all Active

# Istio Ambient Mesh is running
kubectl get pods -n istio-system | grep -E "istiod|ztunnel"
# Expected: istiod and ztunnel pods Running

# Source databases are up
kubectl get deploy -n ecom ecom-db && kubectl get deploy -n inventory inventory-db
# Expected: both READY 1/1

# NodePort map (kind extraPortMappings)
# Port 32200 → Flink Web Dashboard
# Port 32300 → Debezium REST API
```

---

## Stage 1: Source Databases — PostgreSQL with Logical Replication

Debezium uses PostgreSQL's **Write-Ahead Log (WAL)** in `logical` mode to capture row-level changes. This must be configured when the database starts.

### 1.1 Understanding `wal_level=logical`

PostgreSQL has three WAL levels:
- `minimal` — bare minimum for crash recovery
- `replica` — physical streaming replication
- `logical` — **required for CDC**: includes decoded row changes with column values

When `wal_level=logical`, PostgreSQL writes the full before/after column values to the WAL for every INSERT/UPDATE/DELETE. Debezium creates a **replication slot** that acts like a cursor on the WAL stream — it reads change events and forwards them to Kafka.

### 1.2 ecom-db Kubernetes Manifest

**File:** `infra/postgres/ecom-db.yaml`

The critical CDC configuration is in the `args` section passed to the PostgreSQL process:

```yaml
containers:
  - name: postgres
    image: postgres:17-alpine
    envFrom:
      - secretRef:
          name: ecom-db-secret
    env:
      - name: POSTGRES_INITDB_ARGS
        value: "--encoding=UTF8"
    args:
      - postgres
      - -c
      - wal_level=logical          # REQUIRED: enables CDC-capable WAL
      - -c
      - max_replication_slots=10   # max concurrent Debezium connectors
      - -c
      - max_wal_senders=10         # max concurrent WAL streaming connections
```

**Why `args` and not a config file?** Using `args` overrides PostgreSQL startup flags directly. This is simpler than mounting a custom `postgresql.conf` and works with the official Docker image.

**The Secret** (credentials must be created first):

```bash
kubectl create secret generic ecom-db-secret \
  --namespace ecom \
  --from-literal=POSTGRES_USER=ecomuser \
  --from-literal=POSTGRES_PASSWORD=CHANGE_ME \
  --from-literal=POSTGRES_DB=ecomdb
```

**Apply the manifest:**

```bash
kubectl apply -f infra/postgres/ecom-db.yaml
kubectl rollout status deploy/ecom-db -n ecom --timeout=120s
```

### 1.3 inventory-db Kubernetes Manifest

**File:** `infra/postgres/inventory-db.yaml`

Same logical replication configuration:

```yaml
args:
  - postgres
  - -c
  - wal_level=logical
  - -c
  - max_replication_slots=10
  - -c
  - max_wal_senders=10
```

```bash
kubectl apply -f infra/postgres/inventory-db.yaml
kubectl rollout status deploy/inventory-db -n inventory --timeout=120s
```

### 1.4 analytics-db Kubernetes Manifest

**File:** `infra/postgres/analytics-db.yaml`

The analytics DB is a **sink only** — it receives data from Flink via JDBC. It does NOT need `wal_level=logical` because nothing reads its WAL.

```yaml
containers:
  - name: postgres
    image: postgres:17-alpine
    envFrom:
      - secretRef:
          name: analytics-db-secret
    # No CDC args needed — this is a sink, not a source
```

**The Secret:**

```bash
kubectl create secret generic analytics-db-secret \
  --namespace analytics \
  --from-literal=POSTGRES_USER=analyticsuser \
  --from-literal=POSTGRES_PASSWORD=CHANGE_ME \
  --from-literal=POSTGRES_DB=analyticsdb
```

```bash
kubectl apply -f infra/postgres/analytics-db.yaml
kubectl rollout status deploy/analytics-db -n analytics --timeout=120s
```

### ✅ Test Case 1 — Verify WAL Level

```bash
# Verify ecom-db WAL level
kubectl exec -n ecom deploy/ecom-db -- \
  psql -U ecomuser -d ecomdb -c "SHOW wal_level;"
```

**Expected output:**
```
 wal_level
-----------
 logical
(1 row)
```

```bash
# Verify max_replication_slots
kubectl exec -n ecom deploy/ecom-db -- \
  psql -U ecomuser -d ecomdb \
  -c "SHOW max_replication_slots; SHOW max_wal_senders;"
```

**Expected:**
```
 max_replication_slots
----------------------
 10

 max_wal_senders
-----------------
 10
```

```bash
# Verify inventory-db as well
kubectl exec -n inventory deploy/inventory-db -- \
  psql -U inventoryuser -d inventorydb -c "SHOW wal_level;"
# Expected: logical
```

```bash
# Verify analytics-db is reachable
kubectl exec -n analytics deploy/analytics-db -- \
  pg_isready -U analyticsuser -d analyticsdb
# Expected: analytics-db.analytics.svc.cluster.local:5432 - accepting connections
```

---

## Stage 2: Analytics DB Schema

The analytics DB schema must exist **before Flink starts** — the Flink JDBC sink connector uses `INSERT ... ON CONFLICT DO UPDATE` (upsert mode), which requires the tables and their primary keys to already exist.

### 2.1 Schema Design

**Design decisions:**
- **No foreign keys** — CDC delivery order is not guaranteed (an `order_item` can arrive before its `order`). FK constraints would cause inserts to fail. Instead, joins are done at query time in views.
- **UUID primary keys** — all source tables use UUID PKs, mapped as `STRING` in Flink SQL and cast via `?stringtype=unspecified` in the JDBC URL.
- **`synced_at` timestamp** — added to every table at the analytics DB level (not from CDC), records when the row was last written by Flink.
- **Views** — 10 analytical views used by Superset dashboards.

### 2.2 Apply the DDL

**File:** `analytics/schema/analytics-ddl.sql`

```sql
-- Fact and dimension tables
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
    id          UUID PRIMARY KEY,
    user_id     VARCHAR(255),
    total       DOUBLE PRECISION,
    status      VARCHAR(50),
    created_at  TIMESTAMP WITH TIME ZONE,
    synced_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
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
    book_id     UUID PRIMARY KEY,
    quantity    INT,
    reserved    INT,
    updated_at  TIMESTAMP WITH TIME ZONE,
    synced_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

Apply with `-i` flag (required for stdin redirect):

```bash
cat analytics/schema/analytics-ddl.sql | \
  kubectl exec -i -n analytics deploy/analytics-db -- \
  psql -U analyticsuser -d analyticsdb
```

### ✅ Test Case 2 — Verify Analytics Schema

```bash
# List all tables
kubectl exec -n analytics deploy/analytics-db -- \
  psql -U analyticsuser -d analyticsdb \
  -c "\dt"
```

**Expected:**
```
             List of relations
 Schema |      Name       | Type  |    Owner
--------+-----------------+-------+--------------
 public | dim_books       | table | analyticsuser
 public | fact_inventory  | table | analyticsuser
 public | fact_order_items| table | analyticsuser
 public | fact_orders     | table | analyticsuser
```

```bash
# List all views
kubectl exec -n analytics deploy/analytics-db -- \
  psql -U analyticsuser -d analyticsdb \
  -c "\dv vw_*"
```

**Expected:** 10 views listed (vw_avg_order_value, vw_book_price_distribution, vw_inventory_health, vw_inventory_turnover, vw_order_status_distribution, vw_product_sales_volume, vw_revenue_by_author, vw_revenue_by_genre, vw_sales_over_time, vw_top_books_by_revenue).

```bash
# Verify primary keys are set (required for Flink JDBC upsert)
kubectl exec -n analytics deploy/analytics-db -- \
  psql -U analyticsuser -d analyticsdb \
  -c "SELECT tablename, indexname FROM pg_indexes WHERE indexname LIKE '%pkey%';"
```

**Expected:** 4 rows — one `_pkey` index per table.

---

## Stage 3: Kafka (KRaft Mode)

Kafka acts as the message bus between Debezium (producer) and Flink (consumer). We run in **KRaft mode** — no Zookeeper required.

### 3.1 Why KRaft?

KRaft (Kafka Raft metadata mode) embeds the controller (formerly Zookeeper's role) into Kafka itself. Benefits:
- Simpler deployment (1 pod instead of 3+)
- Faster startup and leader election
- Better suited for development/POC environments

### 3.2 Kafka Deployment

**File:** `infra/kafka/kafka.yaml`

Key configuration explained:

```yaml
env:
  # KAFKA_PORT must be empty — Kubernetes injects KAFKA_PORT=tcp://...
  # which conflicts with Confluent's internal port handling.
  - name: KAFKA_PORT
    value: ""

  # KRaft mode: single node acts as both broker and controller
  - name: KAFKA_PROCESS_ROLES
    value: "broker,controller"

  - name: KAFKA_NODE_ID
    value: "1"

  - name: KAFKA_CONTROLLER_QUORUM_VOTERS
    value: "1@localhost:29093"          # node 1 is the only voter

  # Two listeners: PLAINTEXT for app traffic, CONTROLLER for raft consensus
  - name: KAFKA_LISTENERS
    value: "PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:29093"

  # Advertise the Kubernetes service DNS name — pods in other namespaces
  # resolve kafka.infra.svc.cluster.local to reach this pod
  - name: KAFKA_ADVERTISED_LISTENERS
    value: "PLAINTEXT://kafka.infra.svc.cluster.local:9092"

  # CRITICAL: auto-create is OFF. All topics must be pre-created.
  # This prevents Debezium from creating topics with wrong partition counts.
  - name: KAFKA_AUTO_CREATE_TOPICS_ENABLE
    value: "false"

  # Cap JVM heap to stay within 2Gi container memory limit
  - name: KAFKA_HEAP_OPTS
    value: "-Xmx512m -Xms256m"
```

```bash
kubectl apply -f infra/kafka/kafka.yaml
kubectl rollout status deploy/kafka -n infra --timeout=180s
```

### 3.3 Kafka Topic Creation

**File:** `infra/kafka/kafka-topics-init.yaml`

Since `KAFKA_AUTO_CREATE_TOPICS_ENABLE=false`, all topics must be created before Debezium tries to write. The init Job also creates the application event topics (`order.created`, `inventory.updated`).

```yaml
# Topic creation logic (from the Job's container command):
create_topic "order.created"                         # app events
create_topic "inventory.updated"                     # app events
create_topic "ecom-connector.public.books"           # CDC: books table
create_topic "ecom-connector.public.orders"          # CDC: orders table
create_topic "ecom-connector.public.order_items"     # CDC: order_items table
create_topic "inventory-connector.public.inventory"  # CDC: inventory table
```

**Topic naming convention:** `<connector-name>.<schema>.<table>`
- Connector name comes from the `topic.prefix` in the Debezium connector config
- Schema is always `public` (PostgreSQL default schema)
- Table is the source table name

**Partitions:** 3 per topic (allows parallelism if needed), replication factor 1 (single-broker cluster).

```bash
# Run the topic init job
kubectl delete job kafka-topic-init -n infra --ignore-not-found
kubectl apply -f infra/kafka/kafka-topics-init.yaml
kubectl wait --for=condition=complete job/kafka-topic-init -n infra --timeout=300s
```

### ✅ Test Case 3 — Verify Kafka Topics

```bash
# List all topics
kubectl exec -n infra deploy/kafka -- \
  kafka-topics --bootstrap-server localhost:9092 --list
```

**Expected output (10 topics):**
```
__consumer_offsets
debezium.configs
debezium.offsets
debezium.status
ecom-connector.public.books
ecom-connector.public.order_items
ecom-connector.public.orders
inventory-connector.public.inventory
inventory.updated
order.created
```

Note: `debezium.*` topics are created automatically by Debezium on first startup. The 4 `ecom-connector.*` and `inventory-connector.*` topics must be manually pre-created.

```bash
# Verify partition count for a CDC topic
kubectl exec -n infra deploy/kafka -- \
  kafka-topics --bootstrap-server localhost:9092 \
  --describe --topic ecom-connector.public.orders
```

**Expected:**
```
Topic: ecom-connector.public.orders  PartitionCount: 3  ReplicationFactor: 1
  Partition: 0  Leader: 1  Replicas: 1  Isr: 1
  Partition: 1  Leader: 1  Replicas: 1  Isr: 1
  Partition: 2  Leader: 1  Replicas: 1  Isr: 1
```

```bash
# Verify Kafka is reachable from other namespaces
kubectl run kafka-test --rm -it --restart=Never \
  --image=confluentinc/cp-kafka:latest \
  --namespace=analytics \
  -- kafka-topics --bootstrap-server kafka.infra.svc.cluster.local:9092 --list
# Expected: same topic list as above
```

---

## Stage 4: Debezium (Kafka Connect with PostgreSQL CDC)

Debezium reads the PostgreSQL WAL via replication slots and forwards row-level changes as JSON messages to Kafka.

### 4.1 How Debezium Works

1. On first start, Debezium takes a **snapshot** of existing data (reads all rows and publishes them as `INSERT` events with `op: "r"`)
2. After the snapshot, it switches to **streaming mode** — tails the WAL replication slot in real time
3. Each row change is published as a JSON envelope:

```json
{
  "before": null,
  "after": {
    "id": "abc123",
    "total": 39.98,
    "status": "PENDING",
    "created_at": "2026-03-02T14:30:00Z"
  },
  "op": "c",
  "source": {
    "db": "ecomdb",
    "table": "orders",
    "lsn": 12345678
  }
}
```

`op` values:
- `"c"` — CREATE (INSERT)
- `"u"` — UPDATE
- `"d"` — DELETE
- `"r"` — READ (snapshot)

### 4.2 Debezium Credentials Secret

Debezium mounts the secret as files and uses `${file:...}` substitution to read credentials. **However**, this substitution only runs at task startup, not during validation. The `register-connectors.sh` script reads creds from Kubernetes and injects them inline to avoid validation failures.

```bash
# Create the Debezium DB credentials secret in the infra namespace
kubectl create secret generic debezium-db-credentials \
  --namespace infra \
  --from-literal=ECOM_DB_USER=ecomuser \
  --from-literal=ECOM_DB_PASSWORD=CHANGE_ME \
  --from-literal=INVENTORY_DB_USER=inventoryuser \
  --from-literal=INVENTORY_DB_PASSWORD=CHANGE_ME
```

### 4.3 Debezium Deployment

**File:** `infra/debezium/debezium.yaml`

Key configuration:

```yaml
containers:
  - name: debezium
    image: debezium/connect:2.7.0.Final
    env:
      - name: BOOTSTRAP_SERVERS
        value: "kafka.infra.svc.cluster.local:9092"

      # Kafka Connect internal state topics (connector config, offsets, task status)
      # These are created automatically by Kafka Connect on first run.
      # With Kafka PVC persistence, these topics survive pod restarts —
      # connectors auto-resume from the last committed WAL offset.
      - name: CONFIG_STORAGE_TOPIC
        value: "debezium.configs"
      - name: OFFSET_STORAGE_TOPIC
        value: "debezium.offsets"
      - name: STATUS_STORAGE_TOPIC
        value: "debezium.status"

      # Replication factor 1 (single-broker cluster)
      - name: CONFIG_STORAGE_REPLICATION_FACTOR
        value: "1"
      - name: OFFSET_STORAGE_REPLICATION_FACTOR
        value: "1"
      - name: STATUS_STORAGE_REPLICATION_FACTOR
        value: "1"

      # JSON converter without schema — produces compact JSON, no schema envelope
      # Matches Flink SQL's 'format' = 'json' expectation
      - name: CONNECT_KEY_CONVERTER
        value: "org.apache.kafka.connect.json.JsonConverter"
      - name: CONNECT_VALUE_CONVERTER
        value: "org.apache.kafka.connect.json.JsonConverter"
      - name: CONNECT_KEY_CONVERTER_SCHEMAS_ENABLE
        value: "false"
      - name: CONNECT_VALUE_CONVERTER_SCHEMAS_ENABLE
        value: "false"

      # FileConfigProvider: allows ${file:...} variable substitution in connector configs
      - name: CONNECT_CONFIG_PROVIDERS
        value: "file"
      - name: CONNECT_CONFIG_PROVIDERS_FILE_CLASS
        value: "org.apache.kafka.common.config.provider.FileConfigProvider"

    volumeMounts:
      # Secret files mounted at this path — referenced by ${file:/opt/kafka/external-configuration/...}
      - name: db-credentials
        mountPath: /opt/kafka/external-configuration/db-credentials
        readOnly: true

  volumes:
    - name: db-credentials
      secret:
        secretName: debezium-db-credentials
```

**Istio mTLS — PERMISSIVE on port 8083:**

Debezium's REST API (port 8083) is exposed via NodePort 32300. The kind hostPort sends plaintext traffic, but Istio Ambient's ztunnel enforces STRICT mTLS by default. We use `portLevelMtls: PERMISSIVE` on the specific port to allow plaintext from the host while keeping mTLS for pod-to-pod traffic.

```yaml
# File: infra/istio/security/peer-auth.yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: debezium-nodeport-permissive
  namespace: infra
spec:
  selector:
    matchLabels:
      app: debezium          # must have selector — namespace-wide portLevelMtls is NOT supported
  mtls:
    mode: STRICT
  portLevelMtls:
    "8083":
      mode: PERMISSIVE       # allows plaintext from kind NodePort host traffic
```

```bash
kubectl apply -f infra/debezium/debezium.yaml
kubectl apply -f infra/istio/security/peer-auth.yaml
kubectl rollout status deploy/debezium -n infra --timeout=180s
```

### 4.4 Connector Configuration Files

**File:** `infra/debezium/connectors/ecom-connector.json`

```json
{
  "name": "ecom-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "plugin.name": "pgoutput",      // Built-in PostgreSQL 10+ logical decoding plugin
    "tasks.max": "1",               // 1 task per connector (PostgreSQL WAL is single-threaded)

    "database.hostname": "ecom-db.ecom.svc.cluster.local",
    "database.port": "5432",
    "database.user": "${file:/opt/kafka/external-configuration/db-credentials/ECOM_DB_USER}",
    "database.password": "${file:/opt/kafka/external-configuration/db-credentials/ECOM_DB_PASSWORD}",
    "database.dbname": "ecomdb",
    "database.server.name": "ecom-connector",

    // Only capture these 3 tables — not the entire database
    "table.include.list": "public.orders,public.order_items,public.books",

    // Topic prefix: topics will be named <prefix>.<schema>.<table>
    // e.g., ecom-connector.public.orders
    "topic.prefix": "ecom-connector",

    // PostgreSQL replication slot and publication names (created automatically by Debezium)
    "slot.name": "debezium_ecom_slot",
    "publication.name": "debezium_ecom_pub",

    "key.converter": "org.apache.kafka.connect.json.JsonConverter",
    "value.converter": "org.apache.kafka.connect.json.JsonConverter",
    "key.converter.schemas.enable": "false",
    "value.converter.schemas.enable": "false",

    // Convert NUMERIC/DECIMAL to double (avoids complex Debezium decimal encoding)
    "decimal.handling.mode": "double",
    "time.precision.mode": "connect",

    // "initial": take a full snapshot on first connect, then stream changes
    "snapshot.mode": "initial"
  }
}
```

**File:** `infra/debezium/connectors/inventory-connector.json`

```json
{
  "name": "inventory-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "plugin.name": "pgoutput",
    "tasks.max": "1",

    "database.hostname": "inventory-db.inventory.svc.cluster.local",
    "database.port": "5432",
    "database.user": "${file:/opt/kafka/external-configuration/db-credentials/INVENTORY_DB_USER}",
    "database.password": "${file:/opt/kafka/external-configuration/db-credentials/INVENTORY_DB_PASSWORD}",
    "database.dbname": "inventorydb",
    "database.server.name": "inventory-connector",

    "table.include.list": "public.inventory",
    "topic.prefix": "inventory-connector",

    "slot.name": "debezium_inventory_slot",
    "publication.name": "debezium_inventory_pub",

    "key.converter": "org.apache.kafka.connect.json.JsonConverter",
    "value.converter": "org.apache.kafka.connect.json.JsonConverter",
    "key.converter.schemas.enable": "false",
    "value.converter.schemas.enable": "false",

    "decimal.handling.mode": "double",
    "time.precision.mode": "connect",
    "snapshot.mode": "initial"
  }
}
```

### 4.5 Register the Connectors

The registration script reads credentials from the Kubernetes secret and injects them inline (bypassing the `${file:...}` validation issue).

```bash
bash infra/debezium/register-connectors.sh
```

What the script does internally:
1. Reads `ECOM_DB_USER`, `ECOM_DB_PASSWORD`, `INVENTORY_DB_USER`, `INVENTORY_DB_PASSWORD` from the `debezium-db-credentials` secret via `kubectl get secret ... -o jsonpath`
2. Loads the JSON connector config and substitutes the credential placeholders
3. Calls `PUT /connectors/{name}/config` with the flat config JSON (not the `{"name":..,"config":..}` wrapper)
4. Polls until both connectors reach `RUNNING` state

**Manual registration** (equivalent to the script):

```bash
# Read credentials
ECOM_USER=$(kubectl get secret -n infra debezium-db-credentials \
  -o jsonpath='{.data.ECOM_DB_USER}' | base64 -d)
ECOM_PASS=$(kubectl get secret -n infra debezium-db-credentials \
  -o jsonpath='{.data.ECOM_DB_PASSWORD}' | base64 -d)

# Register ecom-connector (PUT = create-or-update)
curl -X PUT http://localhost:32300/connectors/ecom-connector/config \
  -H "Content-Type: application/json" \
  -d "{
    \"connector.class\": \"io.debezium.connector.postgresql.PostgresConnector\",
    \"plugin.name\": \"pgoutput\",
    \"tasks.max\": \"1\",
    \"database.hostname\": \"ecom-db.ecom.svc.cluster.local\",
    \"database.port\": \"5432\",
    \"database.user\": \"${ECOM_USER}\",
    \"database.password\": \"${ECOM_PASS}\",
    \"database.dbname\": \"ecomdb\",
    \"database.server.name\": \"ecom-connector\",
    \"table.include.list\": \"public.orders,public.order_items,public.books\",
    \"topic.prefix\": \"ecom-connector\",
    \"slot.name\": \"debezium_ecom_slot\",
    \"publication.name\": \"debezium_ecom_pub\",
    \"key.converter\": \"org.apache.kafka.connect.json.JsonConverter\",
    \"value.converter\": \"org.apache.kafka.connect.json.JsonConverter\",
    \"key.converter.schemas.enable\": \"false\",
    \"value.converter.schemas.enable\": \"false\",
    \"decimal.handling.mode\": \"double\",
    \"time.precision.mode\": \"connect\",
    \"snapshot.mode\": \"initial\"
  }"
```

### ✅ Test Case 4 — Verify Debezium Connectors

```bash
# List all registered connectors
curl -s http://localhost:32300/connectors | python3 -m json.tool
```

**Expected:**
```json
["ecom-connector", "inventory-connector"]
```

```bash
# Check ecom-connector status
curl -s http://localhost:32300/connectors/ecom-connector/status | \
  python3 -c "
import sys, json
d = json.load(sys.stdin)
print('Connector:', d['connector']['state'])
for t in d['tasks']:
    print(f'Task {t[\"id\"]}: {t[\"state\"]}')
"
```

**Expected:**
```
Connector: RUNNING
Task 0: RUNNING
```

```bash
# Check which topics each connector writes to (after snapshot completes)
curl -s http://localhost:32300/connectors/ecom-connector/topics | python3 -m json.tool
```

**Expected:**
```json
{
  "ecom-connector": {
    "topics": [
      "ecom-connector.public.books",
      "ecom-connector.public.order_items",
      "ecom-connector.public.orders"
    ]
  }
}
```

```bash
# Check the replication slot was created in ecom-db
kubectl exec -n ecom deploy/ecom-db -- \
  psql -U ecomuser -d ecomdb \
  -c "SELECT slot_name, plugin, slot_type, active FROM pg_replication_slots;"
```

**Expected:**
```
        slot_name        |  plugin  | slot_type | active
-------------------------+----------+-----------+--------
 debezium_ecom_slot      | pgoutput | logical   | t
```

```bash
# Verify Kafka topic has messages after snapshot
kubectl exec -n infra deploy/kafka -- \
  kafka-run-class kafka.tools.GetOffsetShell \
  --bootstrap-server localhost:9092 \
  --topic ecom-connector.public.books \
  --time -1
```

**Expected:** 3 lines (one per partition) with non-zero offsets, e.g.:
```
ecom-connector.public.books:0:4
ecom-connector.public.books:1:3
ecom-connector.public.books:2:3
```
(Total should equal the number of books seeded × 1, since the snapshot publishes 1 message per row)

---

## Stage 5: Apache Flink 1.20 (Session Cluster)

Flink reads the CDC events from Kafka, transforms them using SQL, and writes the results to the analytics DB via JDBC upsert.

### 5.1 Architecture: Session Cluster vs. Application Mode

We use **Session Cluster** mode:
- JobManager is a long-running Deployment that manages jobs
- TaskManager is a long-running Deployment that executes job operators
- SQL is submitted on-demand via the SQL Gateway sidecar
- Jobs survive individual resubmissions without restarting the cluster

### 5.2 Custom Flink Docker Image

**File:** `analytics/flink/Dockerfile`

The base Flink 1.20 image doesn't include the Kafka or JDBC connectors. We build a custom image with all required JARs baked in.

```dockerfile
# Stage 1: Download JARs from Maven Central
FROM alpine:3.19 AS downloader
RUN apk add --no-cache curl
WORKDIR /jars

# flink-connector-kafka: Kafka source/sink for Flink Table API
RUN curl -fsSL -o flink-connector-kafka-3.4.0-1.20.jar \
  "https://repo1.maven.org/maven2/org/apache/flink/flink-connector-kafka/3.4.0-1.20/flink-connector-kafka-3.4.0-1.20.jar"

# flink-connector-jdbc: JDBC sink (upsert to PostgreSQL)
RUN curl -fsSL -o flink-connector-jdbc-3.3.0-1.20.jar \
  "https://repo1.maven.org/maven2/org/apache/flink/flink-connector-jdbc/3.3.0-1.20/flink-connector-jdbc-3.3.0-1.20.jar"

# PostgreSQL JDBC driver (runtime dependency of flink-connector-jdbc)
RUN curl -fsSL -o postgresql-42.7.4.jar \
  "https://repo1.maven.org/maven2/org/postgresql/postgresql/42.7.4/postgresql-42.7.4.jar"

# Kafka client library (runtime dependency of flink-connector-kafka)
RUN curl -fsSL -o kafka-clients-3.7.0.jar \
  "https://repo1.maven.org/maven2/org/apache/kafka/kafka-clients/3.7.0/kafka-clients-3.7.0.jar"

# Stage 2: Flink runtime image with all connectors
FROM flink:1.20-scala_2.12-java17
# Copy JARs to Flink's auto-classpath directory
COPY --from=downloader /jars/*.jar /opt/flink/lib/
```

```bash
docker build -t bookstore/flink:latest ./analytics/flink
kind load docker-image bookstore/flink:latest --name bookstore
```

### 5.3 Flink PVC for Checkpoints

**File:** `infra/flink/flink-pvc.yaml`

Checkpoints are written to a PVC backed by a host-path volume. If the JobManager restarts, Flink can recover from the last checkpoint.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: flink-checkpoints-pvc
  namespace: analytics
spec:
  storageClassName: standard
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 2Gi
```

```bash
kubectl apply -f infra/flink/flink-pvc.yaml
```

### 5.4 Flink Cluster Deployment

**File:** `infra/flink/flink-cluster.yaml`

#### JobManager

The JobManager coordinates jobs, manages checkpoints, and exposes the REST API and the SQL Gateway sidecar.

```yaml
containers:
  - name: jobmanager
    image: bookstore/flink:latest
    imagePullPolicy: Never        # use locally loaded kind image
    command: ["/docker-entrypoint.sh"]
    args: ["jobmanager"]
    env:
      - name: FLINK_PROPERTIES
        value: |
          jobmanager.rpc.address: flink-jobmanager    # hostname for TaskManagers to connect
          jobmanager.memory.process.size: 900m
          parallelism.default: 1

          # State backend: hashmap = in-heap state (fast for small state)
          # Note: "filesystem" is deprecated in Flink 1.20 → use "hashmap"
          state.backend.type: hashmap

          # Checkpoints written to PVC (persisted across pod restarts)
          # Note: "state.checkpoints.dir" is deprecated → use "execution.checkpointing.dir"
          execution.checkpointing.dir: file:///opt/flink/checkpoints

          execution.checkpointing.interval: 30s      # checkpoint every 30 seconds
          execution.checkpointing.mode: EXACTLY_ONCE # exactly-once semantics

          rest.port: 8081
          rest.address: 0.0.0.0
          rest.profiling.enabled: true               # enables /jobmanager/profiler endpoint
```

#### SQL Gateway Sidecar

The SQL Gateway runs alongside the JobManager and exposes a REST API (port 9091) that accepts Flink SQL statements. The `flink-sql-runner` Job connects here to submit `pipeline.sql`.

```yaml
  - name: sql-gateway
    image: bookstore/flink:latest
    command:
      - /bin/bash
      - -c
      - |
        # Wait for JobManager REST API to be ready before starting SQL Gateway
        until curl -sf http://localhost:8081/overview > /dev/null 2>&1; do
          sleep 3
        done
        # Start SQL Gateway in foreground
        bin/sql-gateway.sh start-foreground \
          -Dsql-gateway.endpoint.rest.address=0.0.0.0 \
          -Dsql-gateway.endpoint.rest.port=9091 \
          -Drest.address=localhost \
          -Drest.port=8081 \
          -Dexecution.target=remote \
          -Dparallelism.default=1
```

#### TaskManager

```yaml
containers:
  - name: taskmanager
    image: bookstore/flink:latest
    args: ["taskmanager"]
    env:
      - name: FLINK_PROPERTIES
        value: |
          jobmanager.rpc.address: flink-jobmanager
          taskmanager.memory.process.size: 1024m
          taskmanager.numberOfTaskSlots: 4    # 4 slots = can run 4 parallel tasks
          parallelism.default: 1
          state.backend.type: hashmap
          execution.checkpointing.dir: file:///opt/flink/checkpoints
          execution.checkpointing.interval: 30s
          execution.checkpointing.mode: EXACTLY_ONCE
```

**Istio mTLS — PERMISSIVE on port 8081:**

Same as Debezium — Flink's dashboard (NodePort 32200) receives plaintext from the kind host. Must be PERMISSIVE on port 8081.

```yaml
# infra/istio/security/peer-auth.yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: flink-nodeport-permissive
  namespace: analytics
spec:
  selector:
    matchLabels:
      app: flink-jobmanager
  mtls:
    mode: STRICT
  portLevelMtls:
    "8081":
      mode: PERMISSIVE
```

```bash
kubectl apply -f infra/flink/flink-cluster.yaml
kubectl apply -f infra/istio/security/peer-auth.yaml
kubectl rollout status deploy/flink-jobmanager deploy/flink-taskmanager \
  -n analytics --timeout=180s
```

### 5.5 Flink SQL Pipeline

**File:** `analytics/flink/sql/pipeline.sql` (authoritative source)
**ConfigMap:** embedded in `infra/flink/flink-sql-runner.yaml` (used at runtime)

Both files must be kept in sync.

#### Source Tables (Kafka → Flink)

Each source table reads from one Kafka CDC topic. Key design decisions:

```sql
CREATE TABLE kafka_orders (
  -- Debezium envelope structure:
  -- {"before": null/row, "after": null/row, "op": "c|u|d|r", "source": {...}}
  -- We map only the fields we need:
  after ROW<
    id         STRING,
    user_id    STRING,
    total      DOUBLE,
    status     STRING,
    created_at STRING    -- TIMESTAMP WITH TIME ZONE arrives as ISO 8601 string
  >,
  op STRING              -- operation type (c=create, u=update, d=delete, r=read/snapshot)
) WITH (
  'connector'                               = 'kafka',
  'topic'                                   = 'ecom-connector.public.orders',
  'properties.bootstrap.servers'            = 'kafka.infra.svc.cluster.local:9092',
  'properties.group.id'                     = 'flink-analytics-consumer',

  -- 'json' format parses Debezium envelope directly.
  -- Alternative 'debezium-json' format requires REPLICA IDENTITY FULL on source
  -- tables (for UPDATE events to have 'before' populated). We avoid that.
  'format'                                  = 'json',

  -- Skip messages that don't match the schema (tombstones, schema change events)
  'json.ignore-parse-errors'                = 'true',

  -- Start reading from the earliest available offset (replay full history on first run)
  'scan.startup.mode'                       = 'earliest-offset',

  -- CRITICAL: Disable periodic partition discovery.
  -- Default is 300000ms (5 min). Every 5 min, an AdminClient reconnect attempt
  -- fails with UnknownTopicOrPartitionException in kind's NAT networking.
  -- Our topics are static (never gain new partitions), so we disable this entirely.
  'scan.topic-partition-discovery.interval' = '0'
);
```

#### Sink Tables (Flink → analytics-db via JDBC)

```sql
CREATE TABLE sink_fact_orders (
  id         STRING,
  user_id    STRING,
  total      DOUBLE,
  status     STRING,
  created_at TIMESTAMP(3),
  PRIMARY KEY (id) NOT ENFORCED    -- enables JDBC upsert mode
) WITH (
  'connector'                   = 'jdbc',
  -- ?stringtype=unspecified: PostgreSQL can implicitly cast VARCHAR to UUID.
  -- Without this, the JDBC driver sends UUIDs as strings and PostgreSQL
  -- rejects the implicit cast for UUID primary key columns.
  'url'                         = 'jdbc:postgresql://analytics-db.analytics.svc.cluster.local:5432/analyticsdb?stringtype=unspecified',
  'table-name'                  = 'fact_orders',
  'username'                    = '${ANALYTICS_DB_USER}',    -- substituted by envsubst at runtime
  'password'                    = '${ANALYTICS_DB_PASSWORD}',
  'sink.buffer-flush.max-rows'  = '1',    -- flush after every row (low latency)
  'sink.buffer-flush.interval'  = '1s'    -- or after 1 second, whichever comes first
);
```

#### Pipeline INSERT Statements

```sql
-- Filter: WHERE after IS NOT NULL skips DELETE events (op='d') and Kafka tombstones.
-- Timestamp conversion: Debezium sends TIMESTAMP WITH TIME ZONE as ISO 8601 string
-- e.g., "2026-02-26T18:58:09.811060Z"
-- Flink's TIMESTAMP(3) type expects "2026-02-26 18:58:09.811" (space separator, no Z)
-- REPLACE 'T' with ' ', strip 'Z', then CAST to TIMESTAMP(3).

INSERT INTO sink_fact_orders
SELECT
  after.id,
  after.user_id,
  after.total,
  after.status,
  CAST(REPLACE(REPLACE(after.created_at, 'T', ' '), 'Z', '') AS TIMESTAMP(3))
FROM kafka_orders
WHERE after IS NOT NULL;
```

### 5.6 SQL Runner Job

**File:** `infra/flink/flink-sql-runner.yaml`

This is a one-shot Kubernetes Job that:
1. Waits for the SQL Gateway to be ready
2. Runs `envsubst` on `pipeline.sql` to substitute `$ANALYTICS_DB_USER` and `$ANALYTICS_DB_PASSWORD`
3. Submits the resolved SQL via `sql-client.sh gateway -f`
4. Exits 0 — the streaming jobs continue running in the Flink cluster

```yaml
containers:
  - name: sql-runner
    image: bookstore/flink:latest
    command:
      - /bin/bash
      - -c
      - |
        # Substitute env vars before submission
        envsubst < /sql/pipeline.sql > /tmp/pipeline-resolved.sql
        # Submit SQL via SQL Gateway (not directly to JobManager)
        bin/sql-client.sh gateway \
          -e http://flink-jobmanager.analytics.svc.cluster.local:9091 \
          -f /tmp/pipeline-resolved.sql
    env:
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
    volumeMounts:
      - name: pipeline-sql
        mountPath: /sql    # ConfigMap mounted here
  volumes:
    - name: pipeline-sql
      configMap:
        name: flink-pipeline-sql    # Contains the SQL from flink-sql-runner.yaml
```

```bash
# Wait for SQL Gateway to be ready
until kubectl exec -n analytics deploy/flink-jobmanager -c sql-gateway -- \
  curl -sf http://localhost:9091/v1/info > /dev/null 2>&1; do
  echo "SQL Gateway not ready..."
  sleep 5
done

# Submit the pipeline
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=120s
```

### ✅ Test Case 5 — Verify Flink Jobs

```bash
# Check all 4 jobs are RUNNING
curl -s http://localhost:32200/jobs | python3 -c "
import sys, json, datetime
d = json.load(sys.stdin)
running = [j for j in d['jobs'] if j['status'] == 'RUNNING']
failed  = [j for j in d['jobs'] if j['status'] == 'FAILED']
print(f'RUNNING: {len(running)}  FAILED: {len(failed)}')
for j in running:
    ts = datetime.datetime.fromtimestamp(j['start-time']/1000).strftime('%H:%M:%S')
    print(f'  {j[\"id\"][:8]}  started {ts}')
"
```

**Expected:**
```
RUNNING: 4  FAILED: 0
  ec6e28da  started 16:38:34
  9bb8aa6e  started 16:38:34
  d8cec4de  started 16:38:35
  e02af975  started 16:38:35
```

```bash
# Verify partition discovery is disabled (CRITICAL for stability)
kubectl logs -n analytics deploy/flink-jobmanager --container jobmanager | \
  grep "KafkaSourceEnumerator" | head -4
```

**Expected — must say "without periodic partition discovery":**
```
INFO KafkaSourceEnumerator - Starting the KafkaSourceEnumerator for consumer group
  flink-analytics-consumer without periodic partition discovery.
```

**If it says** `with partition discovery interval of 300000 ms` — the `scan.topic-partition-discovery.interval = 0` property is missing. See Troubleshooting.

```bash
# Verify no deprecation warnings
kubectl logs -n analytics deploy/flink-jobmanager --container jobmanager | \
  grep "deprecated" | grep -v "INFO"
```

**Expected:** no output (no deprecation warnings)

```bash
# Verify state backend
kubectl logs -n analytics deploy/flink-jobmanager --container jobmanager | \
  grep "StateBackendLoader"
```

**Expected:**
```
INFO StateBackendLoader - State backend loader loads the state backend as HashMapStateBackend
```

```bash
# Check for job exceptions
for jid in $(curl -s http://localhost:32200/jobs | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(' '.join(j['id'] for j in d['jobs'] if j['status']=='RUNNING'))
"); do
  count=$(curl -s "http://localhost:32200/jobs/$jid/exceptions" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('all-exceptions',[])))")
  echo "Job ${jid:0:8}: $count exceptions"
done
```

**Expected:** `0 exceptions` for all 4 jobs.

---

## Stage 6: End-to-End CDC Data Flow Test

Now verify the complete pipeline by triggering a real data change and watching it propagate.

### 6.1 Snapshot Data (Already in Analytics DB)

After Debezium starts and takes its initial snapshot, the `dim_books` and `fact_inventory` tables should already be populated:

```bash
kubectl exec -n analytics deploy/analytics-db -- \
  psql -U analyticsuser -d analyticsdb \
  -c "SELECT 'dim_books' t, COUNT(*) n FROM dim_books
      UNION ALL SELECT 'fact_inventory', COUNT(*) FROM fact_inventory
      UNION ALL SELECT 'fact_orders', COUNT(*) FROM fact_orders;"
```

**Expected after snapshot:**
```
      t       | n
--------------+----
 dim_books    | 10
 fact_inventory | 10
 fact_orders  | 0
```

### 6.2 Trigger a CDC Event via the Application

**Option A: Using the UI**

1. Navigate to `http://myecom.net:30000`
2. Log in with `user1 / CHANGE_ME`
3. Add a book to cart and complete checkout
4. An order row is inserted into `ecom-db.public.orders`

**Option B: Direct database INSERT (for manual testing)**

```bash
# Insert a test order directly into ecom-db
ORDER_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
USER_ID="test-user-cdc-$(date +%s)"

kubectl exec -n ecom deploy/ecom-db -- psql -U ecomuser -d ecomdb -c "
INSERT INTO orders (id, user_id, total, status, created_at)
VALUES (
  '${ORDER_ID}',
  '${USER_ID}',
  49.99,
  'CONFIRMED',
  NOW()
);
"
echo "Inserted order: ${ORDER_ID}"
```

### 6.3 Watch Each Stage

**Step 1: Verify Debezium captured the WAL change**

```bash
# Check Debezium committed offset has advanced
curl -s http://localhost:32300/connectors/ecom-connector/status | \
  python3 -c "
import sys, json
d = json.load(sys.stdin)
print('Connector:', d['connector']['state'])
print('Tasks:')
for t in d['tasks']:
    print(f'  task {t[\"id\"]}: {t[\"state\"]}')
"
```

**Step 2: Verify Kafka received the message**

```bash
# Check message count in the orders topic has increased
kubectl exec -n infra deploy/kafka -- \
  kafka-run-class kafka.tools.GetOffsetShell \
  --bootstrap-server localhost:9092 \
  --topic ecom-connector.public.orders \
  --time -1
```

Consume one message to see the raw Debezium JSON envelope:

```bash
kubectl exec -n infra deploy/kafka -- \
  kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic ecom-connector.public.orders \
  --from-beginning \
  --max-messages 1 \
  --timeout-ms 5000 2>/dev/null | python3 -m json.tool
```

**Expected Debezium JSON envelope:**
```json
{
  "before": null,
  "after": {
    "id": "abc12345-...",
    "user_id": "test-user-cdc-...",
    "total": 49.99,
    "status": "CONFIRMED",
    "created_at": "2026-03-02T16:30:00.000000Z"
  },
  "source": {
    "db": "ecomdb",
    "table": "orders"
  },
  "op": "c",
  "ts_ms": 1740924600000
}
```

**Step 3: Verify Flink processed the message**

Flink metrics show bytes consumed from Kafka. Check via REST API:

```bash
# Get one running job's ID
JOB_ID=$(curl -s http://localhost:32200/jobs | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=[j for j in d['jobs'] if j['status']=='RUNNING']
print(r[0]['id']) if r else print('none')
")

# Check job status (should be RUNNING, not restarting)
curl -s "http://localhost:32200/jobs/${JOB_ID}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('Job state:', d['state'])
print('Duration:', d.get('duration', 0) // 1000, 'seconds')
"
```

**Step 4: Verify analytics-db received the row**

```bash
# Poll until the order appears in fact_orders (usually < 2 seconds)
ORDER_ID="<the UUID you inserted above>"

for i in $(seq 1 30); do
  COUNT=$(kubectl exec -n analytics deploy/analytics-db -- \
    psql -U analyticsuser -d analyticsdb -t \
    -c "SELECT COUNT(*) FROM fact_orders WHERE id = '${ORDER_ID}';" | tr -d ' ')
  if [ "$COUNT" -gt "0" ]; then
    echo "SUCCESS: Order found in analytics DB after ${i}s"
    kubectl exec -n analytics deploy/analytics-db -- \
      psql -U analyticsuser -d analyticsdb \
      -c "SELECT id, user_id, total, status, created_at FROM fact_orders WHERE id = '${ORDER_ID}';"
    break
  fi
  echo "  Waiting... (${i}s)"
  sleep 1
done
```

**Expected:**
```
SUCCESS: Order found in analytics DB after 2s
                  id                  |     user_id      | total | status  |         created_at
--------------------------------------+------------------+-------+---------+----------------------------
 abc12345-...                         | test-user-cdc-...| 49.99 | CONFIRMED | 2026-03-02 16:30:00+00
```

### ✅ Test Case 6 — Full Pipeline Timing

```bash
# Measure end-to-end latency
START=$(date +%s%3N)
ORDER_ID=$(python3 -c "import uuid; print(uuid.uuid4())")

kubectl exec -n ecom deploy/ecom-db -- psql -U ecomuser -d ecomdb -c \
  "INSERT INTO orders (id, user_id, total, status, created_at)
   VALUES ('${ORDER_ID}', 'latency-test', 99.99, 'CONFIRMED', NOW());" > /dev/null

for i in $(seq 1 30); do
  COUNT=$(kubectl exec -n analytics deploy/analytics-db -- \
    psql -U analyticsuser -d analyticsdb -t \
    -c "SELECT COUNT(*) FROM fact_orders WHERE id = '${ORDER_ID}';" | tr -d ' ')
  if [ "$COUNT" -gt "0" ]; then
    END=$(date +%s%3N)
    echo "End-to-end latency: $((END - START))ms"
    break
  fi
  sleep 1
done
```

**Typical result:** 1000–3000ms (1–3 seconds)

---

## Stage 7: Superset Dashboard Verification

### 7.1 Connect to Superset

Navigate to `http://localhost:32000` and log in with `admin / CHANGE_ME`.

### 7.2 Verify Database Connection

Go to **Settings → Database Connections**. The `analyticsdb` connection should already be configured:

```
SQLAlchemy URI: postgresql+psycopg2://analyticsuser:CHANGE_ME@analytics-db.analytics.svc.cluster.local:5432/analyticsdb
```

Test the connection by clicking **Test Connection** — should show "Connection looks good!".

### 7.3 Verify Datasets

Go to **Datasets**. All 10 views and 4 tables should be listed:

```bash
# Check datasets via API
curl -s -u admin:CHANGE_ME \
  "http://localhost:32000/api/v1/dataset/?q=(page_size:50)" | \
  python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Total datasets: {d[\"count\"]}')
for ds in d['result'][:14]:
    print(f'  {ds[\"table_name\"]}')
"
```

**Expected:** 14 datasets listed (4 tables + 10 views).

### 7.4 Verify Dashboards and Charts

Go to **Dashboards**. Three dashboards should be present:

| Dashboard | Charts |
|---|---|
| Book Store Analytics | 5 charts: product sales, revenue by genre, top books, inventory health, price distribution |
| Sales & Revenue Analytics | 5 charts: daily revenue, order count, avg order value, revenue by author, order status |
| Inventory Analytics | 6 charts: stock levels, reserved units, available stock, stock status pie, turnover rate, genre revenue pie |

### ✅ Test Case 7 — Verify Data Flows to Superset

```bash
# Verify a Superset chart query returns data
# Get auth token
TOKEN=$(curl -s -X POST http://localhost:32000/api/v1/security/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"CHANGE_ME","provider":"db"}' | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# Query the vw_product_sales_volume view directly
curl -s -X POST http://localhost:32000/api/v1/sqllab/execute/ \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d "{\"database_id\": 1, \"sql\": \"SELECT * FROM vw_product_sales_volume LIMIT 5\", \"runAsync\": false}" | \
  python3 -c "
import sys, json
d = json.load(sys.stdin)
rows = d.get('data', [])
print(f'Rows returned: {len(rows)}')
for r in rows[:3]:
    print(f'  {r}')
"
```

**Expected:** rows showing book titles and their sales volume.

---

## Stage 8: Stability Verification

After the pipeline has been running for several minutes, verify it remains stable.

### 8.1 Wait Past the Former 5-Minute Failure Window

Before the `scan.topic-partition-discovery.interval = 0` fix, jobs would fail every 5 minutes. Verify they remain RUNNING:

```bash
# Wait 6 minutes then check
sleep 360 && curl -s http://localhost:32200/jobs | python3 -c "
import sys, json
d = json.load(sys.stdin)
r = [j for j in d['jobs'] if j['status'] == 'RUNNING']
f = [j for j in d['jobs'] if j['status'] == 'FAILED']
print(f'RUNNING: {len(r)}, FAILED: {len(f)}')
assert len(r) == 4, f'Expected 4 RUNNING jobs, got {len(r)}'
assert len(f) == 0, f'Expected 0 FAILED jobs, got {len(f)}'
print('STABLE — no failures after 6 minutes')
"
```

**Expected:**
```
RUNNING: 4, FAILED: 0
STABLE — no failures after 6 minutes
```

### 8.2 Verify Checkpoints

```bash
# Get a job ID
JOB_ID=$(curl -s http://localhost:32200/jobs | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=[j for j in d['jobs'] if j['status']=='RUNNING']
print(r[0]['id'])
")

# Check checkpoint history
curl -s "http://localhost:32200/jobs/${JOB_ID}/checkpoints" | python3 -c "
import sys, json, datetime
d = json.load(sys.stdin)
counts = d.get('counts', {})
print('Checkpoint counts:', counts)
latest = d.get('latest', {})
completed = latest.get('completed', {})
if completed:
    ts = datetime.datetime.fromtimestamp(completed['trigger_timestamp']/1000)
    print(f'Latest completed checkpoint: {ts.strftime(\"%H:%M:%S\")}')
    print(f'Duration: {completed[\"end_to_end_duration\"]}ms')
"
```

**Expected:**
```
Checkpoint counts: {'restored': 0, 'total': 12, 'in_progress': 0, 'completed': 12, 'failed': 0}
Latest completed checkpoint: 16:45:30
Duration: 245ms
```

### 8.3 Check Kafka Consumer Lag

```bash
# flink-analytics-consumer group — should have near-zero lag (Flink keeps up with Kafka)
kubectl exec -n infra deploy/kafka -- \
  kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --group flink-analytics-consumer \
  --describe 2>/dev/null | head -20
```

**Expected:** `LAG` column showing 0 or a very small number for all partitions.

### 8.4 Comprehensive Health Check Script

Run this to check the entire pipeline in one command:

```bash
echo "=== Stage 1: Source DBs ==="
kubectl exec -n ecom deploy/ecom-db -- psql -U ecomuser -d ecomdb -c "SHOW wal_level;" 2>/dev/null | grep logical && echo "ecom-db: wal_level=logical ✓"
kubectl exec -n inventory deploy/inventory-db -- psql -U inventoryuser -d inventorydb -c "SHOW wal_level;" 2>/dev/null | grep logical && echo "inventory-db: wal_level=logical ✓"

echo ""
echo "=== Stage 2: Analytics DB Schema ==="
kubectl exec -n analytics deploy/analytics-db -- psql -U analyticsuser -d analyticsdb -c "\dt" 2>/dev/null | grep -c "table" | xargs -I{} echo "{} tables ✓"

echo ""
echo "=== Stage 3: Kafka Topics ==="
kubectl exec -n infra deploy/kafka -- kafka-topics \
  --bootstrap-server localhost:9092 --list 2>/dev/null | \
  grep -c "connector" | xargs -I{} echo "{}/4 CDC topics present ✓"

echo ""
echo "=== Stage 4: Debezium Connectors ==="
curl -s http://localhost:32300/connectors/ecom-connector/status 2>/dev/null | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(f'ecom-connector: {d[\"connector\"][\"state\"]} ✓')" 2>/dev/null
curl -s http://localhost:32300/connectors/inventory-connector/status 2>/dev/null | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(f'inventory-connector: {d[\"connector\"][\"state\"]} ✓')" 2>/dev/null

echo ""
echo "=== Stage 5: Flink Jobs ==="
curl -s http://localhost:32200/jobs 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=[j for j in d['jobs'] if j['status']=='RUNNING']
f=[j for j in d['jobs'] if j['status']=='FAILED']
print(f'{len(r)}/4 jobs RUNNING ✓' if len(r)==4 else f'WARNING: {len(r)} RUNNING, {len(f)} FAILED')
"

echo ""
echo "=== Stage 6: Analytics DB Data ==="
kubectl exec -n analytics deploy/analytics-db -- \
  psql -U analyticsuser -d analyticsdb -t \
  -c "SELECT 'dim_books='||COUNT(*)||', fact_inventory='||(SELECT COUNT(*) FROM fact_inventory) FROM dim_books;" \
  2>/dev/null | tr -d ' '
```

---

## Troubleshooting

### Problem: Flink jobs fail every 5 minutes with `UnknownTopicOrPartitionException`

**Symptom:** 8+ FAILED jobs accumulate, new ones keep failing at t+5min.

**Cause:** `scan.topic-partition-discovery.interval` not set → defaults to 300000ms → periodic AdminClient reconnection fails in kind.

**Fix:**
```sql
-- Add to each Kafka source table's WITH clause in pipeline.sql / ConfigMap:
'scan.topic-partition-discovery.interval' = '0'
```
Then resubmit the SQL runner:
```bash
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=120s
```

### Problem: Flink jobs fail immediately with `UnknownTopicOrPartitionException` at startup

**Cause:** Kafka CDC topics don't exist (`KAFKA_AUTO_CREATE_TOPICS_ENABLE=false`).

**Fix:**
```bash
kubectl delete job kafka-topic-init -n infra --ignore-not-found
kubectl apply -f infra/kafka/kafka-topics-init.yaml
kubectl wait --for=condition=complete job/kafka-topic-init -n infra --timeout=300s
```
Then resubmit the SQL runner.

### Problem: Debezium connector stuck in `FAILED` state

**Symptoms:**
```json
{"connector": {"state": "FAILED"}, "tasks": [{"state": "FAILED"}]}
```

**Diagnose:**
```bash
kubectl logs -n infra deploy/debezium | grep -E "ERROR|WARN" | tail -20
```

Common causes and fixes:
- **Wrong credentials** — recreate the `debezium-db-credentials` secret with correct values, then re-register connectors.
- **Replication slot already exists from a previous run** — delete it manually:
  ```bash
  kubectl exec -n ecom deploy/ecom-db -- \
    psql -U ecomuser -d ecomdb \
    -c "SELECT pg_drop_replication_slot('debezium_ecom_slot') WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'debezium_ecom_slot');"
  ```
- **wal_level not logical** — the database wasn't started with `wal_level=logical`. Verify with `SHOW wal_level;`. If wrong, restart the DB pod (it reads from startup args).
- **ecom-db not reachable** — verify Istio mTLS allows Debezium → ecom-db traffic. Check `kubectl logs -n infra deploy/debezium` for connection refused errors.

### Problem: Flink JDBC sink shows `NullPointerException: Cannot cast STRING to UUID`

**Cause:** JDBC URL missing `?stringtype=unspecified`.

**Fix:** Ensure all sink tables use:
```sql
'url' = 'jdbc:postgresql://analytics-db.analytics.svc.cluster.local:5432/analyticsdb?stringtype=unspecified'
```

### Problem: Debezium re-registers connectors unnecessarily on restart

After Docker Desktop restart or Kafka pod restart with PVC intact, the `connect-offsets`, `connect-configs`, and `connect-status` Kafka topics survive. Debezium reads them on startup and auto-restores connectors from the last WAL offset — no manual re-registration needed.

The `restart-after-docker.sh` script checks connector state before re-registering:
```bash
if _connector_running "ecom-connector" && _connector_running "inventory-connector"; then
    echo "Both connectors RUNNING — skipping re-registration"
else
    bash infra/debezium/register-connectors.sh
fi
```

### Problem: Flink profiler endpoint returns `NullPointerException`

**Symptom:** `Cannot invoke "ProfilingInfo$ProfilingMode.getCode()" ... null`

**Cause:** Wrong request body field name.

**Fix:** Use `"mode"` not `"triggerType"`:
```bash
# WRONG:
curl -X POST "http://localhost:32200/taskmanagers/${TM_ID}/profiler" \
  -d '{"triggerType":"CPU","duration":10}'

# CORRECT:
curl -X POST "http://localhost:32200/taskmanagers/${TM_ID}/profiler" \
  -H "Content-Type: application/json" \
  -d '{"mode":"CPU","duration":10}'
```

---

## Complete Setup Script

Run all stages in order:

```bash
#!/usr/bin/env bash
# Manual CDC pipeline setup — run from repo root
set -euo pipefail

echo "=== Stage 1: Source Databases ==="
kubectl apply -f infra/postgres/ecom-db.yaml
kubectl apply -f infra/postgres/inventory-db.yaml
kubectl apply -f infra/postgres/analytics-db.yaml
kubectl rollout status deploy/ecom-db -n ecom --timeout=120s
kubectl rollout status deploy/inventory-db -n inventory --timeout=120s
kubectl rollout status deploy/analytics-db -n analytics --timeout=120s

echo "=== Stage 2: Analytics DB Schema ==="
cat analytics/schema/analytics-ddl.sql | \
  kubectl exec -i -n analytics deploy/analytics-db -- \
  psql -U analyticsuser -d analyticsdb

echo "=== Stage 3: Kafka ==="
kubectl apply -f infra/kafka/kafka.yaml
kubectl rollout status deploy/kafka -n infra --timeout=180s
kubectl delete job kafka-topic-init -n infra --ignore-not-found
kubectl apply -f infra/kafka/kafka-topics-init.yaml
kubectl wait --for=condition=complete job/kafka-topic-init -n infra --timeout=300s

echo "=== Stage 4: Debezium ==="
kubectl apply -f infra/debezium/debezium.yaml
kubectl apply -f infra/istio/security/peer-auth.yaml
kubectl rollout status deploy/debezium -n infra --timeout=180s
bash infra/debezium/register-connectors.sh

echo "=== Stage 5: Flink ==="
kubectl apply -f infra/flink/flink-pvc.yaml
kubectl apply -f infra/flink/flink-cluster.yaml
kubectl apply -f infra/istio/security/peer-auth.yaml
kubectl rollout status deploy/flink-jobmanager deploy/flink-taskmanager \
  -n analytics --timeout=180s

# Wait for SQL Gateway
until kubectl exec -n analytics deploy/flink-jobmanager -c sql-gateway -- \
  curl -sf http://localhost:9091/v1/info > /dev/null 2>&1; do
  echo "  Waiting for SQL Gateway..."
  sleep 5
done

kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=120s

echo ""
echo "=== CDC Pipeline Setup Complete ==="
echo "Verify at:"
echo "  Flink Dashboard: http://localhost:32200"
echo "  Debezium REST:   http://localhost:32300"
echo "  Superset:        http://localhost:32000"
```

---

## Reference

### Key Files

| File | Purpose |
|---|---|
| `infra/postgres/ecom-db.yaml` | ecom-db with `wal_level=logical` |
| `infra/postgres/inventory-db.yaml` | inventory-db with `wal_level=logical` |
| `infra/postgres/analytics-db.yaml` | analytics-db (sink, no WAL config) |
| `analytics/schema/analytics-ddl.sql` | Tables + 10 views for Superset |
| `infra/kafka/kafka.yaml` | Kafka KRaft deployment + PVC |
| `infra/kafka/kafka-topics-init.yaml` | Job to pre-create all 6 Kafka topics |
| `infra/debezium/debezium.yaml` | Debezium deployment + NodePort service |
| `infra/debezium/connectors/ecom-connector.json` | ecom CDC connector config |
| `infra/debezium/connectors/inventory-connector.json` | inventory CDC connector config |
| `infra/debezium/register-connectors.sh` | Connector registration script |
| `analytics/flink/Dockerfile` | Custom Flink image with connectors |
| `analytics/flink/sql/pipeline.sql` | Canonical Flink SQL pipeline |
| `infra/flink/flink-cluster.yaml` | JobManager + TaskManager Deployments |
| `infra/flink/flink-sql-runner.yaml` | SQL ConfigMap + submission Job |
| `infra/flink/flink-pvc.yaml` | Checkpoint storage PVC |
| `infra/istio/security/peer-auth.yaml` | mTLS PeerAuthentication policies |

### Service Endpoints

| Service | Internal DNS | External |
|---|---|---|
| Kafka | `kafka.infra.svc.cluster.local:9092` | N/A (internal only) |
| Debezium REST | `debezium.infra.svc.cluster.local:8083` | `http://localhost:32300` |
| Flink REST | `flink-jobmanager.analytics.svc.cluster.local:8081` | `http://localhost:32200` |
| Flink SQL Gateway | `flink-jobmanager.analytics.svc.cluster.local:9091` | N/A (internal only) |
| analytics-db | `analytics-db.analytics.svc.cluster.local:5432` | N/A (internal only) |
| Superset | `superset.analytics.svc.cluster.local:8088` | `http://localhost:32000` |

### Kafka Topic Naming

```
<connector-topic-prefix>.<postgres-schema>.<table-name>
```

| Topic | Source |
|---|---|
| `ecom-connector.public.books` | ecom-db → public.books |
| `ecom-connector.public.orders` | ecom-db → public.orders |
| `ecom-connector.public.order_items` | ecom-db → public.order_items |
| `inventory-connector.public.inventory` | inventory-db → public.inventory |

### Critical Configuration Rules

1. **`wal_level=logical`** on source PostgreSQL instances — without this, Debezium cannot create a replication slot and cannot capture changes.

2. **`KAFKA_AUTO_CREATE_TOPICS_ENABLE=false`** — topics must be pre-created with the correct partition count. Debezium will fail if topics don't exist.

3. **`scan.topic-partition-discovery.interval = 0`** in all Flink Kafka source tables — without this, Flink fires a periodic AdminClient reconnection every 5 minutes that fails in kind's NAT networking.

4. **`state.backend.type: hashmap`** (not `state.backend: filesystem`) — use the current non-deprecated config key. The `filesystem` backend is now called `hashmap` in Flink 1.20.

5. **`?stringtype=unspecified`** in JDBC URL — allows PostgreSQL to implicitly cast `VARCHAR` to `UUID` in primary key columns.

6. **`portLevelMtls: PERMISSIVE`** on NodePort-exposed pods — Istio Ambient STRICT mode rejects plaintext traffic from kind's hostPort. Must use port-level PERMISSIVE with a pod selector (namespace-wide portLevelMtls is not supported by ztunnel).

7. **Apply DDL before Flink** — the JDBC sink requires tables to pre-exist. If you start Flink first, the sink jobs will fail immediately.

8. **Use `-i` flag with `kubectl exec`** for stdin redirect — `cat file | kubectl exec -i` works; `kubectl exec < file` without `-i` is silently ignored.

For deeper troubleshooting, see:
- `docs/cdc/flink-stability-guide.md` — root cause analysis of the 3 Flink stability issues
- `docs/cdc/debezium-flink-cdc.md` — comprehensive architecture reference
