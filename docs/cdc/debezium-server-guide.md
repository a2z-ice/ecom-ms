# Debezium Server Guide

**Version**: Debezium Server 3.4.1.Final
**Image**: `quay.io/debezium/server:3.4.1.Final`
**Namespace**: `infra`
**Health endpoints**:
- ecom: `http://localhost:32300/q/health`
- inventory: `http://localhost:32301/q/health`
**Purpose**: Capture database changes from PostgreSQL and stream them as JSON events to Kafka, enabling real-time CDC (Change Data Capture) for the analytics pipeline.

---

## Table of Contents

1. [What is Debezium Server?](#1-what-is-debezium-server)
2. [Architecture Overview](#2-architecture-overview)
3. [How CDC Works](#3-how-cdc-works)
4. [Kubernetes Deployment](#4-kubernetes-deployment)
5. [Configuration Reference](#5-configuration-reference)
6. [Source Connector: PostgreSQL](#6-source-connector-postgresql)
7. [Sink Connector: Kafka](#7-sink-connector-kafka)
8. [Offset Storage](#8-offset-storage)
9. [Output Event Format](#9-output-event-format)
10. [Topic Naming Convention](#10-topic-naming-convention)
11. [Health API](#11-health-api)
12. [Initial Snapshot](#12-initial-snapshot)
13. [Kubernetes Secrets and Cross-Namespace Pattern](#13-kubernetes-secrets-and-cross-namespace-pattern)
14. [Istio Integration](#14-istio-integration)
15. [Customization Guide](#15-customization-guide)
16. [Operations Guide](#16-operations-guide)
17. [Troubleshooting](#17-troubleshooting)
18. [Screenshot Reference](#18-screenshot-reference)

---

## 1. What is Debezium Server?

Debezium Server is a **standalone, self-contained application** for Change Data Capture (CDC). It continuously monitors a source database's transaction log and emits every INSERT, UPDATE, and DELETE as a structured event to a messaging system (Kafka in this platform).

### Debezium Server vs Kafka Connect

This platform previously used **Debezium as a Kafka Connect plugin** (the traditional deployment model). It was replaced with Debezium Server because:

| Aspect | Kafka Connect + Debezium plugin | Debezium Server |
|--------|--------------------------------|-----------------|
| **Architecture** | Kafka Connect cluster with Debezium JAR installed | Standalone Quarkus app — no Kafka Connect |
| **Configuration** | REST API: `PUT /connectors/{name}/config` | File: `application.properties` in a ConfigMap |
| **Multiple sources** | One Connect cluster manages all connectors | One pod per source database |
| **Operational complexity** | Manage Connect cluster + register connectors | Apply YAML manifests |
| **Health check** | `GET /connectors/{name}/status` (port 8083) | `GET /q/health` (port 8080) |
| **Restart recovery** | Must re-register connectors if `connect-configs` topic is lost | Reads offset file or offset topic; auto-resumes |
| **Resource footprint** | ~512MB per Connect worker + separate Kafka cluster | ~256MB per Debezium Server pod |
| **Kubernetes fit** | Connector registration via shell script (fragile) | Pure `kubectl apply` workflow |

### What Debezium Server Does

1. Connects to a PostgreSQL database using the **pgoutput** logical replication plugin
2. Creates a **replication slot** (named `debezium_ecom_slot` / `debezium_inventory_slot`) on the DB
3. Reads from the PostgreSQL **Write-Ahead Log (WAL)** via the replication slot
4. Serializes each change event as a JSON message
5. Publishes the message to the corresponding Kafka topic
6. Records the WAL position (offset) to a file on disk for crash recovery

---

## 2. Architecture Overview

```
+─────────────────────── PostgreSQL (ecom-db) ─────────────────+
│                                                               │
│  WAL: Write-Ahead Log (transaction journal)                  │
│  wal_level=logical (required for CDC)                        │
│  Publication: debezium_ecom_pub                              │
│    - Publishes changes from: public.orders                   │
│                              public.order_items              │
│                              public.books                    │
│  Replication Slot: debezium_ecom_slot                        │
│    (Debezium's exclusive read position in the WAL)           │
+──────────────────────────────┬───────────────────────────────+
                               │ Logical replication protocol (pgoutput)
                               │ TCP port 5432
                               v
+────────── debezium-server-ecom Pod (infra namespace) ─────────+
│                                                               │
│  Quarkus application (JVM-based)                             │
│  Source: PostgresConnector                                    │
│  Sink: KafkaSink                                              │
│                                                               │
│  Internal pipeline:                                           │
│    1. WAL reader: receives raw change records from PG         │
│    2. Transformer: parses binary WAL → Debezium change event  │
│    3. Serializer: encodes event as JSON (no schema wrapper)   │
│    4. Kafka producer: publishes to topic                      │
│    5. Offset writer: records WAL LSN to /debezium/data/       │
│                                                               │
│  Health API: port 8080 → /q/health/ready + /q/health/live    │
+──────────────────────────────┬───────────────────────────────+
                               │ Kafka producer (StringSerializer)
                               v
+─────────────────────── Kafka (infra namespace) ────────────────+
│                                                               │
│  Topics:                                                      │
│    ecom-connector.public.orders                              │
│    ecom-connector.public.order_items                         │
│    ecom-connector.public.books                               │
│    inventory-connector.public.inventory                      │
└───────────────────────────────────────────────────────────────+
                               │
                               v
                    Flink SQL pipeline
                    (analytics namespace)
```

### Two Server Instances

Each source database gets its own dedicated Debezium Server pod:

| Pod | Source DB | Namespace | Topics Produced |
|-----|-----------|-----------|-----------------|
| `debezium-server-ecom` | ecom-db | infra | `ecom-connector.public.orders`, `ecom-connector.public.order_items`, `ecom-connector.public.books` |
| `debezium-server-inventory` | inventory-db | infra | `inventory-connector.public.inventory` |

This separation is required because each Debezium Server instance manages one replication slot on one PostgreSQL database. Multiple databases require multiple server instances.

---

## 3. How CDC Works

### PostgreSQL Logical Replication

PostgreSQL implements CDC through its **logical decoding** feature. When `wal_level=logical`, PostgreSQL writes every row-level change (INSERT/UPDATE/DELETE) into the WAL in a structured format that can be decoded by plugins.

The **pgoutput** plugin (built into PostgreSQL 10+) converts the binary WAL records into a text-based protocol that Debezium understands.

```
Application layer:
  INSERT INTO orders (id, user_id, total) VALUES ('abc', 'user1', 49.99)
              │
              v
WAL (Write-Ahead Log):
  LSN: 0/15A3B20  BEGIN
  LSN: 0/15A3B30  TABLE public.orders: INSERT
                  columns: [id='abc', user_id='user1', total=49.99, status='PENDING', ...]
  LSN: 0/15A3C00  COMMIT
              │
              v
pgoutput plugin decodes WAL → sends to replication client (Debezium)
```

### Replication Slot

A **replication slot** is a cursor into the WAL. It:
- Guarantees PostgreSQL retains WAL segments until the slot consumer has read them
- Stores the consumer's current position (LSN — Log Sequence Number)
- Survives PostgreSQL restarts

```sql
-- The slot is created automatically by Debezium on first startup
SELECT slot_name, plugin, active, restart_lsn
FROM pg_replication_slots;
--   slot_name             | plugin   | active | restart_lsn
--   debezium_ecom_slot    | pgoutput | true   | 0/15A3B00
--   debezium_inventory_slot| pgoutput | true   | 0/1234567
```

**Warning**: An unused replication slot with large WAL lag causes PostgreSQL to retain all WAL since the slot's position, potentially filling the disk. Monitor slot lag in production.

### Publication

A **publication** defines which tables Debezium monitors. It is created by Debezium on startup:

```sql
-- Auto-created by Debezium Server on first startup
CREATE PUBLICATION debezium_ecom_pub
  FOR TABLE public.orders, public.order_items, public.books;
```

Only changes to tables listed in `debezium.source.table.include.list` will flow through.

### Change Event Lifecycle

```
1. User calls POST /ecom/checkout (Spring Boot)
   → Spring inserts row into ecom-db.public.orders

2. PostgreSQL writes INSERT to WAL with LSN 0/15A3B30

3. Debezium (via pgoutput) reads the WAL event:
   - Parses column values from binary format
   - Constructs a SourceRecord object

4. Debezium serializes the SourceRecord:
   - Key:   {"id": "abc..."}  (primary key)
   - Value: {"before": null, "after": {"id":"abc...", "total":49.99, ...}, "op":"c", "source":{...}}

5. Debezium produces the message to Kafka:
   - Topic: ecom-connector.public.orders
   - Partition: 0 (single partition)
   - Offset: 42

6. Debezium writes offset to /debezium/data/offsets.dat:
   - {"ecom-connector":{"0/15A3B30"}}

7. Flink reads from ecom-connector.public.orders at offset 42
8. Flink writes to analytics-db.fact_orders
9. User sees order in Superset dashboard
```

---

## 4. Kubernetes Deployment

### Two Manifests

**Files**:
- `infra/debezium/debezium-server-ecom.yaml`
- `infra/debezium/debezium-server-inventory.yaml`

Each manifest contains 4 Kubernetes resources:

```
1. ConfigMap  — application.properties configuration
2. Deployment — single-replica pod
3. ClusterIP Service — internal cluster access on port 8080
4. NodePort Service  — external health check access
```

### Deployment Structure (ecom example)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: debezium-server-ecom
  namespace: infra
spec:
  replicas: 1   # MUST be 1 — multiple replicas would create duplicate events
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
        fsGroup: 1001
      containers:
        - name: debezium-server
          image: quay.io/debezium/server:3.4.1.Final
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 8080     # Quarkus health API
          env:
            - name: ECOM_DB_USER
              valueFrom:
                secretKeyRef:
                  name: debezium-db-credentials
                  key: ECOM_DB_USER
            - name: ECOM_DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: debezium-db-credentials
                  key: ECOM_DB_PASSWORD
          volumeMounts:
            - name: config
              mountPath: /debezium/config/application.properties
              subPath: application.properties
              readOnly: true
            - name: data
              mountPath: /debezium/data    # offset storage
            - name: tmp
              mountPath: /tmp
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /q/health/ready
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 6
          livenessProbe:
            httpGet:
              path: /q/health/live
              port: 8080
            initialDelaySeconds: 60
            periodSeconds: 15
          securityContext:
            readOnlyRootFilesystem: false  # Debezium writes temp files
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
```

**Why `replicas: 1`**: Debezium manages a single replication slot. Multiple replicas would:
1. Both connect to the same slot → race condition, duplicate events
2. Both write to the same offset file → corruption
Always run exactly one replica per source database.

**Why `readOnlyRootFilesystem: false`**: Debezium Server (Quarkus) writes temporary files at runtime. The root filesystem cannot be read-only.

### Volume Mount: Config Path

The ConfigMap is mounted at `/debezium/config/application.properties` (NOT `/debezium/conf/`):

```yaml
volumeMounts:
  - name: config
    mountPath: /debezium/config/application.properties
    subPath: application.properties
    readOnly: true
```

Debezium Server reads configuration from `/debezium/config/application.properties` by default. This path was discovered through a bug investigation — using the wrong path causes Debezium to start with empty configuration (no source connector, no sink), which results in a healthy but completely inactive pod.

### Services

```yaml
# ClusterIP — for in-cluster access (e.g., Prometheus scraping health)
apiVersion: v1
kind: Service
metadata:
  name: debezium-server-ecom
  namespace: infra
spec:
  type: ClusterIP
  selector:
    app: debezium-server-ecom
  ports:
    - port: 8080
      targetPort: 8080

---
# NodePort — for external access from the host
apiVersion: v1
kind: Service
metadata:
  name: debezium-server-ecom-nodeport
  namespace: infra
spec:
  type: NodePort
  selector:
    app: debezium-server-ecom
  ports:
    - name: health
      port: 8080
      targetPort: 8080
      nodePort: 32300   # ecom server
```

| Server | NodePort | Host URL |
|--------|----------|----------|
| debezium-server-ecom | 32300 | `http://localhost:32300/q/health` |
| debezium-server-inventory | 32301 | `http://localhost:32301/q/health` |

Both ports are declared in `infra/kind/cluster.yaml` `extraPortMappings` and must exist at cluster creation time.

---

## 5. Configuration Reference

### Full Configuration (ecom server)

**Source**: `infra/debezium/debezium-server-ecom.yaml` ConfigMap

```properties
# ─── Source: PostgreSQL ecom-db ──────────────────────────────────────────────

# Connector class (PostgreSQL logical replication)
debezium.source.connector.class=io.debezium.connector.postgresql.PostgresConnector

# Database connection
debezium.source.database.hostname=ecom-db.ecom.svc.cluster.local
debezium.source.database.port=5432
debezium.source.database.user=${ECOM_DB_USER}         # injected from Secret
debezium.source.database.password=${ECOM_DB_PASSWORD}  # injected from Secret
debezium.source.database.dbname=ecomdb

# Topic prefix (all topics: <prefix>.<schema>.<table>)
debezium.source.topic.prefix=ecom-connector

# Tables to monitor
debezium.source.table.include.list=public.orders,public.order_items,public.books

# Logical replication plugin (built-in since PostgreSQL 10)
debezium.source.plugin.name=pgoutput

# Replication slot name (must be unique per PostgreSQL instance)
debezium.source.slot.name=debezium_ecom_slot

# Publication name (auto-created if it does not exist)
debezium.source.publication.name=debezium_ecom_pub

# Snapshot mode: read all existing rows on first startup
debezium.source.snapshot.mode=initial

# Numeric precision: convert NUMERIC/DECIMAL to JSON float64
debezium.source.decimal.handling.mode=double

# Timestamp precision: use java.util.Date types (millisecond precision)
debezium.source.time.precision.mode=connect

# ─── Offset Storage: File-backed ─────────────────────────────────────────────

debezium.source.offset.storage=org.apache.kafka.connect.storage.FileOffsetBackingStore
debezium.source.offset.storage.file.filename=/debezium/data/offsets.dat
debezium.source.offset.flush.interval.ms=5000

# ─── Sink: Kafka ─────────────────────────────────────────────────────────────

debezium.sink.type=kafka
debezium.sink.kafka.producer.bootstrap.servers=kafka.infra.svc.cluster.local:9092
debezium.sink.kafka.producer.key.serializer=org.apache.kafka.common.serialization.StringSerializer
debezium.sink.kafka.producer.value.serializer=org.apache.kafka.common.serialization.StringSerializer

# ─── Format: JSON without schema wrapper ─────────────────────────────────────

debezium.format.value=json
debezium.format.key=json
debezium.format.value.schemas.enable=false
debezium.format.key.schemas.enable=false

# ─── HTTP server (Quarkus health API) ────────────────────────────────────────

quarkus.http.port=8080
```

### Inventory Server Configuration Differences

The inventory server (`debezium-server-inventory`) uses the same structure with these differences:

| Property | ecom value | inventory value |
|----------|-----------|-----------------|
| `database.hostname` | `ecom-db.ecom.svc.cluster.local` | `inventory-db.inventory.svc.cluster.local` |
| `database.dbname` | `ecomdb` | `inventorydb` |
| `topic.prefix` | `ecom-connector` | `inventory-connector` |
| `table.include.list` | `public.orders,public.order_items,public.books` | `public.inventory` |
| `slot.name` | `debezium_ecom_slot` | `debezium_inventory_slot` |
| `publication.name` | `debezium_ecom_pub` | `debezium_inventory_pub` |
| `offset.storage.file.filename` | `/debezium/data/offsets.dat` | `/debezium/data/offsets.dat` |
| NodePort | `32300` | `32301` |
| Secret keys | `ECOM_DB_USER`, `ECOM_DB_PASSWORD` | `INVENTORY_DB_USER`, `INVENTORY_DB_PASSWORD` |

---

## 6. Source Connector: PostgreSQL

### PostgreSQL Prerequisites

The source PostgreSQL instance must have:

```sql
-- wal_level=logical is set via POSTGRES_INITDB_ARGS in the DB deployment
-- Verify:
SHOW wal_level;
-- Expected: logical
```

In the Kubernetes deployment, this is set via:
```yaml
# infra/postgres/ecom-db.yaml
env:
  - name: POSTGRES_INITDB_ARGS
    value: "--wal-level=logical"
```

Or via `postgresql.conf`:
```
wal_level = logical
max_replication_slots = 5
max_wal_senders = 5
```

### Connection: Kubernetes DNS

Debezium Server runs in the `infra` namespace. The source databases are in separate namespaces:
- `ecom-db.ecom.svc.cluster.local` — resolves to ecom-db Service in ecom namespace
- `inventory-db.inventory.svc.cluster.local` — resolves to inventory-db Service in inventory namespace

Kubernetes DNS format: `<service-name>.<namespace>.svc.cluster.local`

The database user needs **REPLICATION** privilege:
```sql
-- On ecom-db
ALTER USER ecomuser REPLICATION;
-- Or create a dedicated replication user:
CREATE USER debezium WITH REPLICATION LOGIN PASSWORD 'secret';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO debezium;
```

### Snapshot Mode

`debezium.source.snapshot.mode=initial` means:
1. On **first startup** (no existing offset file): Debezium reads all existing rows from the monitored tables. Every existing row is emitted as a change event with `op=r` (read).
2. On **subsequent startups** (offset file exists): Debezium skips the snapshot and resumes from the saved WAL position.

Other modes:
| Mode | When to Use |
|------|-------------|
| `initial` | Default. Full snapshot on first run. |
| `never` | Skip snapshot entirely. Only capture future changes. |
| `always` | Re-snapshot on every startup (expensive). |
| `exported` | Start from a specific WAL position (advanced). |

### Decimal and Timestamp Handling

**Decimal handling** (`decimal.handling.mode=double`):
- PostgreSQL `NUMERIC(10,2)` → JSON `49.99` (float64)
- Alternative `string` mode: → JSON `"49.99"` (requires string-to-number cast in Flink)
- Alternative `precise` mode: → binary JSON encoding (complex to parse)

**Timestamp handling** (`time.precision.mode=connect`):
- `TIMESTAMP WITH TIME ZONE` → ISO 8601 string `"2026-03-01T14:22:10.123456Z"`
- This is what allows the Flink CAST/REPLACE conversion to work

---

## 7. Sink Connector: Kafka

### Serialization Choice

```properties
debezium.sink.kafka.producer.key.serializer=org.apache.kafka.common.serialization.StringSerializer
debezium.sink.kafka.producer.value.serializer=org.apache.kafka.common.serialization.StringSerializer
```

**Why `StringSerializer` (not `ByteArraySerializer`)?**

This was a critical bug discovered during the Debezium Server migration. Debezium Server's JSON format produces a `String` object internally. When the sink is configured with `ByteArraySerializer`, Kafka's `ProducerRecord` receives a String but tries to serialize it as `byte[]` → `ClassCastException` at runtime. The pod appears healthy (passes health checks) but silently drops all events.

`StringSerializer` accepts the String directly → correct Kafka message encoding → Flink reads valid JSON.

### Kafka Topic Configuration

Kafka topics are pre-created by `infra/kafka/kafka-topics-init.yaml`. With `KAFKA_AUTO_CREATE_TOPICS_ENABLE=false` on the Kafka broker, topics must exist before Debezium starts:

```yaml
# infra/kafka/kafka-topics-init.yaml
kafka-topics --bootstrap-server localhost:9092 --create \
  --topic ecom-connector.public.orders \
  --partitions 1 --replication-factor 1 || true

kafka-topics --bootstrap-server localhost:9092 --create \
  --topic ecom-connector.public.order_items \
  --partitions 1 --replication-factor 1 || true

kafka-topics --bootstrap-server localhost:9092 --create \
  --topic ecom-connector.public.books \
  --partitions 1 --replication-factor 1 || true

kafka-topics --bootstrap-server localhost:9092 --create \
  --topic inventory-connector.public.inventory \
  --partitions 1 --replication-factor 1 || true
```

### Producer Configuration

Additional Kafka producer properties can be set with the `debezium.sink.kafka.producer.*` prefix:

```properties
# Example: enable compression (not currently configured)
debezium.sink.kafka.producer.compression.type=snappy

# Example: increase batch size for higher throughput
debezium.sink.kafka.producer.batch.size=65536
debezium.sink.kafka.producer.linger.ms=10
```

---

## 8. Offset Storage

### File-Backed Offset Store

```properties
debezium.source.offset.storage=org.apache.kafka.connect.storage.FileOffsetBackingStore
debezium.source.offset.storage.file.filename=/debezium/data/offsets.dat
debezium.source.offset.flush.interval.ms=5000
```

The offset file (`offsets.dat`) stores the last successfully processed WAL LSN (Log Sequence Number). This allows Debezium Server to resume exactly where it left off after a pod restart.

**File location**: `/debezium/data/` → mounted from `emptyDir` volume.

**Current limitation**: `emptyDir` is ephemeral — the offset file is **lost when the pod is deleted** (but not when the container restarts). On pod deletion/recreation:
1. The offset file is gone
2. Debezium sees no existing offset → performs a full re-snapshot
3. All existing rows are re-emitted with `op=r`
4. Flink's upsert mode handles duplicates (ON CONFLICT DO UPDATE)
5. No data is lost, but there is a brief period of increased traffic

**Making offsets durable**: Use a PersistentVolumeClaim instead of `emptyDir`:

```yaml
# Replace emptyDir with PVC for production durability
volumes:
  - name: data
    persistentVolumeClaim:
      claimName: debezium-ecom-data-pvc
```

Or use Kafka-backed offset storage (more complex, requires offset topics):

```properties
# Alternative: Kafka-backed offset storage
debezium.source.offset.storage=org.apache.kafka.connect.storage.KafkaOffsetBackingStore
debezium.source.offset.storage.kafka.bootstrap.servers=kafka.infra.svc.cluster.local:9092
debezium.source.offset.storage.topic=debezium.ecom.offsets
debezium.source.offset.storage.partitions=1
debezium.source.offset.storage.replication.factor=1
```

**Note**: `KafkaOffsetBackingStore` requires creating the offset topics first. The current implementation uses `FileOffsetBackingStore` for simplicity.

---

## 9. Output Event Format

### Standard Debezium JSON Envelope

Every Kafka message produced by Debezium Server follows this structure:

```json
{
  "before": null,
  "after": {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "user_id": "9d82bcb3-6e96-462c-bdb9-e677080e8920",
    "total": 49.99,
    "status": "PENDING",
    "created_at": "2026-03-01T14:22:10.123456Z"
  },
  "op": "c",
  "source": {
    "version": "3.4.1.Final",
    "connector": "postgresql",
    "name": "ecom-connector",
    "ts_ms": 1740837730123,
    "snapshot": "false",
    "db": "ecomdb",
    "schema": "public",
    "table": "orders",
    "txId": 589,
    "lsn": 22826800,
    "xmin": null
  },
  "transaction": null
}
```

### Field Reference

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `before` | Object or null | row data or null | Row state BEFORE the change. Always null for INSERTs. Null for UPDATEs unless `REPLICA IDENTITY FULL` |
| `after` | Object or null | row data or null | Row state AFTER the change. Null for DELETEs |
| `op` | String | `c`, `u`, `d`, `r` | Operation: create, update, delete, read (snapshot) |
| `source.version` | String | `3.4.1.Final` | Debezium version |
| `source.connector` | String | `postgresql` | Connector type |
| `source.name` | String | `ecom-connector` | The `topic.prefix` property |
| `source.ts_ms` | Long | epoch milliseconds | Wall clock time when the change occurred in the DB |
| `source.snapshot` | String | `true`, `false`, `last` | Whether this event is from the initial snapshot |
| `source.table` | String | `orders` | Table name |
| `source.txId` | Long | PostgreSQL tx ID | Transaction identifier |
| `source.lsn` | Long | WAL position | Log Sequence Number — used for resume position |

### Operation Type Examples

**INSERT** (user places order):
```json
{"before": null, "after": {"id": "abc", "total": 49.99, "status": "PENDING"}, "op": "c"}
```

**UPDATE** (order status changes to COMPLETED):
```json
{"before": null, "after": {"id": "abc", "total": 49.99, "status": "COMPLETED"}, "op": "u"}
```
Note: `before` is null because the source table uses `REPLICA IDENTITY DEFAULT`. The analytics pipeline doesn't need `before` — it upserts based on the `after` state.

**DELETE** (if implemented):
```json
{"before": {"id": "abc", ...}, "after": null, "op": "d"}
```
The Flink pipeline filters these out with `WHERE after IS NOT NULL`.

**SNAPSHOT** (initial read of existing rows):
```json
{"before": null, "after": {"id": "abc", "total": 49.99, "status": "PENDING"}, "op": "r"}
```

### Kafka Message Key

The message key is also JSON, containing the primary key columns:

```json
{"id": "123e4567-e89b-12d3-a456-426614174000"}
```

For the inventory table (PK is `book_id`):
```json
{"book_id": "aaaaaaaa-0001-0001-0001-000000000001"}
```

Kafka uses the key for partition assignment (same key → same partition → ordering guaranteed per row).

---

## 10. Topic Naming Convention

Topics follow the pattern: `<topic.prefix>.<schema>.<table>`

| Server | Prefix | Schema | Table | Full Topic Name |
|--------|--------|--------|-------|-----------------|
| ecom | `ecom-connector` | `public` | `orders` | `ecom-connector.public.orders` |
| ecom | `ecom-connector` | `public` | `order_items` | `ecom-connector.public.order_items` |
| ecom | `ecom-connector` | `public` | `books` | `ecom-connector.public.books` |
| inventory | `inventory-connector` | `public` | `inventory` | `inventory-connector.public.inventory` |

Verify topics exist:
```bash
kubectl exec -n infra deploy/kafka -- \
  kafka-topics --bootstrap-server localhost:9092 --list | grep connector
```

---

## 11. Health API

Debezium Server 3.4 includes a **Quarkus Health API** at port 8080. This replaces the Kafka Connect REST API that was at port 8083 in the previous deployment.

### Health Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /q/health` | Combined readiness + liveness status |
| `GET /q/health/ready` | Readiness: connector fully started and streaming |
| `GET /q/health/live` | Liveness: JVM process is alive |

### Example Response

```bash
curl -sf http://localhost:32300/q/health | python3 -m json.tool
```

**Healthy response**:
```json
{
  "status": "UP",
  "checks": [
    {
      "name": "debezium",
      "status": "UP",
      "data": {
        "connector.status": "RUNNING_SNAPSHOT_COMPLETED"
      }
    }
  ]
}
```

**Starting up** (during initial snapshot):
```json
{
  "status": "DOWN",
  "checks": [
    {
      "name": "debezium",
      "status": "DOWN",
      "data": {
        "connector.status": "RUNNING_SNAPSHOT_RUNNING"
      }
    }
  ]
}
```

**Not yet started**:
```json
{
  "status": "DOWN",
  "checks": [
    {
      "name": "debezium",
      "status": "DOWN"
    }
  ]
}
```

### Kubernetes Probes

```yaml
readinessProbe:
  httpGet:
    path: /q/health/ready
    port: 8080
  initialDelaySeconds: 30    # Wait 30s before first probe (snapshot takes time)
  periodSeconds: 10           # Check every 10s
  failureThreshold: 6         # 60s total before marked not-ready (allow for slow snapshots)

livenessProbe:
  httpGet:
    path: /q/health/live
    port: 8080
  initialDelaySeconds: 60    # JVM startup time
  periodSeconds: 15
```

### Health Check Script

`infra/debezium/register-connectors.sh` waits for both servers to report healthy:

```bash
#!/usr/bin/env bash
DEBEZIUM_ECM_URL="${DEBEZIUM_ECM_URL:-http://localhost:32300}"
DEBEZIUM_INV_URL="${DEBEZIUM_INV_URL:-http://localhost:32301}"

_wait_healthy() {
  local name=$1 url=$2
  for i in $(seq 1 60); do
    status=$(curl -sf "$url/q/health" | \
      python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
    [[ "$status" == "UP" ]] && { echo "[OK] $name healthy"; return 0; }
    sleep 5
  done
  echo "[FAIL] $name not healthy after 300s"; return 1
}

_wait_healthy "debezium-server-ecom"       "$DEBEZIUM_ECM_URL"
_wait_healthy "debezium-server-inventory"  "$DEBEZIUM_INV_URL"
```

---

## 12. Initial Snapshot

When Debezium Server starts for the first time (no existing offset file), it performs an **initial snapshot** — reading all existing rows from the monitored tables before entering streaming mode.

### Snapshot Process

```
1. Debezium acquires a consistent read snapshot on PostgreSQL (REPEATABLE READ isolation)
2. Reads all rows from public.orders         → emits events with op='r'
3. Reads all rows from public.order_items    → emits events with op='r'
4. Reads all rows from public.books         → emits events with op='r'
5. Releases snapshot (no table locks held during streaming)
6. Switches to streaming mode (reads WAL from LSN at snapshot start)
7. Health endpoint returns UP
```

During the snapshot phase, the health endpoint returns `connector.status: RUNNING_SNAPSHOT_RUNNING`. The readiness probe `failureThreshold: 6` allows up to 60 seconds for the snapshot to complete.

### What Happens to the Analytics DB

On the very first run, the snapshot populates `dim_books` and `fact_orders`/`fact_inventory` with all existing data. Flink's upsert mode handles this correctly — each snapshot row is an INSERT (or UPDATE if the row already exists from a previous run).

### Verifying Snapshot Completion

```bash
# Watch health status during startup
watch -n 2 'curl -sf http://localhost:32300/q/health | python3 -m json.tool'

# Check topic has messages (snapshot events)
kubectl exec -n infra deploy/kafka -- \
  kafka-console-consumer \
    --bootstrap-server localhost:9092 \
    --topic ecom-connector.public.books \
    --from-beginning \
    --max-messages 3 \
    --property print.offset=true
```

---

## 13. Kubernetes Secrets and Cross-Namespace Pattern

### The Challenge

Kubernetes Secrets are **namespace-scoped**. The Debezium Server pods run in the `infra` namespace, but the database credentials are stored in:
- `ecom-db-secret` in the `ecom` namespace
- `inventory-db-secret` in the `inventory` namespace

Debezium cannot directly reference secrets from other namespaces.

### The Solution: Copy Secrets at Deploy Time

`scripts/infra-up.sh` reads the credentials from source namespaces and creates a combined secret in `infra` using `--dry-run=client -o yaml | kubectl apply`:

```bash
# Extract credentials from source namespaces
ECOM_USER=$(kubectl get secret -n ecom ecom-db-secret \
  -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
ECOM_PASS=$(kubectl get secret -n ecom ecom-db-secret \
  -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)
INV_USER=$(kubectl get secret -n inventory inventory-db-secret \
  -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
INV_PASS=$(kubectl get secret -n inventory inventory-db-secret \
  -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)

# Create combined secret in infra namespace (idempotent: apply, not create)
kubectl create secret generic debezium-db-credentials -n infra \
  --from-literal=ECOM_DB_USER="$ECOM_USER" \
  --from-literal=ECOM_DB_PASSWORD="$ECOM_PASS" \
  --from-literal=INVENTORY_DB_USER="$INV_USER" \
  --from-literal=INVENTORY_DB_PASSWORD="$INV_PASS" \
  --dry-run=client -o yaml | kubectl apply -f -
```

This creates `infra/debezium-db-credentials` which the Debezium Deployments reference via `secretKeyRef`.

### Secret Reference in Deployment

```yaml
env:
  - name: ECOM_DB_USER
    valueFrom:
      secretKeyRef:
        name: debezium-db-credentials  # lives in infra namespace
        key: ECOM_DB_USER
  - name: ECOM_DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: debezium-db-credentials
        key: ECOM_DB_PASSWORD
```

### Environment Variable Expansion in Configuration

The `application.properties` file uses shell-like substitution syntax:

```properties
debezium.source.database.user=${ECOM_DB_USER}
debezium.source.database.password=${ECOM_DB_PASSWORD}
```

Debezium Server (via SmallRye Config) expands `${ENV_VAR}` references at startup using the container's environment. This is standard behavior — no special ConfigMap processing is needed.

---

## 14. Istio Integration

### The mTLS NodePort Problem

The Debezium Server pods are in the `infra` namespace, which has Istio Ambient mTLS in STRICT mode. This means ztunnel intercepts ALL inbound traffic and requires mTLS — including traffic from the host machine via NodePort (ports 32300/32301).

When you run `curl http://localhost:32300/q/health` from the host, the request enters the kind cluster via NodePort and reaches the ztunnel. Since the host is not part of the mesh, it cannot present an mTLS certificate → connection rejected → health check fails.

### The Fix: portLevelMtls PERMISSIVE

```yaml
# infra/istio/security/peer-auth.yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: debezium-ecom-nodeport-permissive
  namespace: infra
spec:
  selector:
    matchLabels:
      app: debezium-server-ecom   # REQUIRED — selector is mandatory for portLevelMtls
  mtls:
    mode: STRICT                   # Keep STRICT as the default
  portLevelMtls:
    "8080":
      mode: PERMISSIVE             # Allow plaintext on port 8080 for NodePort access
```

A separate `PeerAuthentication` resource exists for each server instance (ecom and inventory) because Istio requires a `selector` for `portLevelMtls` — namespace-wide port-level overrides are not supported.

### Internal Traffic

Traffic between Flink (analytics namespace) and Kafka (infra namespace) is fully mTLS-encrypted by Istio's ztunnel. Debezium to Kafka traffic is similarly mTLS-protected. Only the external NodePort health check endpoint is PERMISSIVE.

---

## 15. Customization Guide

### 15.1 Adding a New Table to Monitor

To start capturing CDC events from a new table:

**Step 1**: Ensure the table exists in PostgreSQL with the correct schema.

**Step 2**: Add the table to the `table.include.list` in the ConfigMap:

```properties
# Before
debezium.source.table.include.list=public.orders,public.order_items,public.books

# After (add public.reviews)
debezium.source.table.include.list=public.orders,public.order_items,public.books,public.reviews
```

**Step 3**: Create the Kafka topic (add to `kafka-topics-init.yaml` and re-run):
```bash
kubectl exec -n infra deploy/kafka -- \
  kafka-topics --bootstrap-server localhost:9092 \
  --create --topic ecom-connector.public.reviews \
  --partitions 1 --replication-factor 1
```

**Step 4**: Apply the updated ConfigMap and restart the pod:
```bash
kubectl apply -f infra/debezium/debezium-server-ecom.yaml
kubectl rollout restart deployment/debezium-server-ecom -n infra
kubectl rollout status deployment/debezium-server-ecom -n infra --timeout=120s
```

**Step 5**: Verify events are flowing:
```bash
kubectl exec -n infra deploy/kafka -- \
  kafka-console-consumer \
    --bootstrap-server localhost:9092 \
    --topic ecom-connector.public.reviews \
    --from-beginning --max-messages 3
```

**Step 6**: Update the Flink SQL pipeline to consume the new topic (see `docs/cdc/flink-streaming-sql-pipeline.md` Section 14.1).

### 15.2 Adding a New Source Database

To monitor a third database (e.g., `analytics-db` for bi-directional sync):

**Step 1**: Create a new manifest file `infra/debezium/debezium-server-analytics.yaml` by copying `debezium-server-ecom.yaml` and changing:
- All `ecom` references to `analytics`
- `database.hostname` to `analytics-db.analytics.svc.cluster.local`
- `database.dbname` to `analyticsdb`
- `topic.prefix` to `analytics-connector`
- `slot.name` to `debezium_analytics_slot`
- `publication.name` to `debezium_analytics_pub`
- NodePort to a new unused port (e.g., 32302)

**Step 2**: Add the new NodePort to `infra/kind/cluster.yaml`:
```yaml
- containerPort: 32302
  hostPort: 32302
  protocol: TCP
```
This requires `up.sh --fresh` to recreate the cluster.

**Step 3**: Add credentials to the deploy script:
```bash
# In scripts/infra-up.sh
ANALYTICS_USER=$(kubectl get secret -n analytics analytics-db-secret ...)
kubectl create secret generic debezium-db-credentials -n infra \
  --from-literal=ANALYTICS_DB_USER="$ANALYTICS_USER" \
  ...
```

**Step 4**: Add `PeerAuthentication` for the new NodePort in `infra/istio/security/peer-auth.yaml`.

### 15.3 Changing Snapshot Mode

To skip the initial snapshot (only capture future changes):

```properties
# Change in ConfigMap application.properties
debezium.source.snapshot.mode=never
```

**Important**: After changing snapshot mode, you must also drop and recreate the replication slot, because the slot position is tied to the snapshot:

```bash
# On the source PostgreSQL instance
kubectl exec -n ecom deploy/ecom-db -- psql -U ecomuser -d ecomdb \
  -c "SELECT pg_drop_replication_slot('debezium_ecom_slot');"

# Also delete offset file (pod restart clears emptyDir automatically)
kubectl rollout restart deployment/debezium-server-ecom -n infra
```

### 15.4 Enabling Column Filtering

To exclude sensitive columns (e.g., user passwords) from CDC events:

```properties
# Exclude specific columns from all events
debezium.source.column.exclude.list=public.users.password_hash,public.users.salt
```

Or include only specific columns:
```properties
debezium.source.column.include.list=public.orders.id,public.orders.total,public.orders.status
```

### 15.5 Enabling Schema Changes

By default, DDL changes (ALTER TABLE, etc.) are not captured. To enable:

```properties
debezium.source.include.schema.changes=true
```

Schema change events are emitted to the `<prefix>` topic (not table-specific topics) and should be handled carefully in downstream consumers.

### 15.6 Using Kafka Offset Storage (Production Durability)

For production environments where pod deletion must not cause a re-snapshot:

```properties
# Replace file-backed storage with Kafka-backed
debezium.source.offset.storage=org.apache.kafka.connect.storage.KafkaOffsetBackingStore
debezium.source.offset.storage.kafka.bootstrap.servers=kafka.infra.svc.cluster.local:9092
debezium.source.offset.storage.topic=debezium.ecom.offsets
debezium.source.offset.storage.partitions=1
debezium.source.offset.storage.replication.factor=1

# Remove file-based settings
# debezium.source.offset.storage.file.filename=...
```

Create the offset topic first:
```bash
kubectl exec -n infra deploy/kafka -- \
  kafka-topics --bootstrap-server localhost:9092 \
  --create --topic debezium.ecom.offsets \
  --partitions 1 --replication-factor 1 \
  --config cleanup.policy=compact
```

Also remove the `data` emptyDir volume mount (not needed with Kafka offset storage).

---

## 16. Operations Guide

### Check Both Servers Are Healthy

```bash
echo "=== ecom server ===" && curl -sf http://localhost:32300/q/health | python3 -m json.tool
echo "=== inventory server ===" && curl -sf http://localhost:32301/q/health | python3 -m json.tool
```

Expected: `"status": "UP"` with `connector.status: RUNNING_SNAPSHOT_COMPLETED` in both.

### Verify Kafka Topics Are Receiving Events

```bash
# List all CDC topics
kubectl exec -n infra deploy/kafka -- \
  kafka-topics --bootstrap-server localhost:9092 --list | grep connector

# Check message count on orders topic
kubectl exec -n infra deploy/kafka -- \
  kafka-run-class kafka.tools.GetOffsetShell \
  --broker-list localhost:9092 \
  --topic ecom-connector.public.orders \
  --time -1

# Read last 3 messages from inventory topic
kubectl exec -n infra deploy/kafka -- \
  kafka-console-consumer \
    --bootstrap-server localhost:9092 \
    --topic inventory-connector.public.inventory \
    --offset latest \
    --partition 0 \
    --max-messages 3
```

### Restart a Debezium Server

```bash
# Safe restart — Debezium resumes from offset file (if emptyDir survives)
kubectl rollout restart deployment/debezium-server-ecom -n infra
kubectl rollout status deployment/debezium-server-ecom -n infra --timeout=120s

# Then wait for health
until curl -sf http://localhost:32300/q/health | grep -q '"status":"UP"'; do
  sleep 5; echo "Waiting for ecom server..."
done
echo "ecom server is UP"
```

### Check Replication Slot Lag

```bash
# Check WAL lag (bytes behind) for each replication slot
kubectl exec -n ecom deploy/ecom-db -- psql -U ecomuser -d ecomdb -c "
SELECT slot_name,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag,
       active,
       active_pid
FROM pg_replication_slots
WHERE slot_name LIKE 'debezium%';
"
```

**Expected**: `lag` should be small (< 1MB) and `active` should be `t` (true).

Large lag means Debezium is falling behind or has stopped. Small lag with `active=f` means Debezium is stopped and the slot is blocking WAL cleanup → disk usage will grow.

### Delete a Replication Slot

If Debezium is permanently removed or the slot is stuck:

```bash
# On ecom-db
kubectl exec -n ecom deploy/ecom-db -- psql -U ecomuser -d ecomdb \
  -c "SELECT pg_drop_replication_slot('debezium_ecom_slot');"

# On inventory-db
kubectl exec -n inventory deploy/inventory-db -- psql -U inventoryuser -d inventorydb \
  -c "SELECT pg_drop_replication_slot('debezium_inventory_slot');"
```

**Warning**: After dropping the slot, the next Debezium startup will perform a full re-snapshot.

### Trigger a Full Re-Snapshot

If the analytics-db is out of sync and you want to repopulate it:

```bash
# 1. Stop Debezium Server
kubectl scale deployment/debezium-server-ecom -n infra --replicas=0

# 2. Drop replication slot (forces re-snapshot)
kubectl exec -n ecom deploy/ecom-db -- psql -U ecomuser -d ecomdb \
  -c "SELECT pg_drop_replication_slot('debezium_ecom_slot');"

# 3. (Optional) Clear analytics tables to avoid conflicts
kubectl exec -n analytics deploy/analytics-db -- psql -U analyticsuser -d analyticsdb \
  -c "TRUNCATE fact_orders, fact_order_items, dim_books;"

# 4. Restart Debezium (emptyDir is cleared on pod restart, triggering new snapshot)
kubectl scale deployment/debezium-server-ecom -n infra --replicas=1
kubectl rollout status deployment/debezium-server-ecom -n infra --timeout=120s

# 5. Monitor health until snapshot completes
watch -n 5 'curl -sf http://localhost:32300/q/health | python3 -m json.tool'
```

### View Debezium Server Logs

```bash
# Follow live logs
kubectl logs -n infra deploy/debezium-server-ecom -f

# Look for snapshot completion
kubectl logs -n infra deploy/debezium-server-ecom | grep -i "snapshot\|streaming\|error\|exception"

# Expected log sequence on healthy startup:
#   INFO Snapshot completed
#   INFO Streaming events from PostgreSQL...
#   INFO Connected to Kafka broker
```

---

## 17. Troubleshooting

### Server Pod Keeps Restarting

```bash
kubectl describe pod -n infra -l app=debezium-server-ecom
```

**Cause 1**: DB credentials wrong.
```
ERROR Connection refused to ecom-db:5432
```
Fix: Verify `debezium-db-credentials` secret exists in `infra` namespace:
```bash
kubectl get secret debezium-db-credentials -n infra -o jsonpath='{.data}' | python3 -m json.tool
```

**Cause 2**: Wrong config mount path.
```
INFO No application.properties found, using defaults
```
Fix: Verify the volumeMount `mountPath` is `/debezium/config/application.properties` (not `/debezium/conf/`).

**Cause 3**: `wal_level` is not `logical`.
```
ERROR The configured user does not have sufficient replication privileges
```
Fix: `kubectl exec -n ecom deploy/ecom-db -- psql -U ecomuser -c "SHOW wal_level;"` — should be `logical`.

### No Events Flowing to Kafka

**Symptom**: Debezium is `UP` and `RUNNING_SNAPSHOT_COMPLETED`, but Kafka topics are empty.

```bash
# Check if topic exists
kubectl exec -n infra deploy/kafka -- \
  kafka-topics --bootstrap-server localhost:9092 --describe \
  --topic ecom-connector.public.orders

# Check Debezium logs for producer errors
kubectl logs -n infra deploy/debezium-server-ecom | grep -i "kafka\|producer\|send\|error"
```

**Cause**: `ByteArraySerializer` is configured instead of `StringSerializer`.
```
ClassCastException: String cannot be cast to byte[]
```
Fix: Ensure both serializers are `StringSerializer` in the ConfigMap.

**Cause**: Kafka topic does not exist and auto-create is disabled.
```
UNKNOWN_TOPIC_OR_PARTITION
```
Fix: Create the topic manually or re-run `kafka-topics-init.yaml`.

### Readiness Probe Failing During Snapshot

**Symptom**: Pod is `Running` but `0/1` containers ready.

**Cause**: The initial snapshot is taking longer than `failureThreshold × periodSeconds = 60s`.

**Fix**: Increase `failureThreshold` or `initialDelaySeconds` in the readiness probe. The snapshot duration depends on the number of existing rows. For large tables (millions of rows), set `initialDelaySeconds: 120` and `failureThreshold: 18` (3 minutes).

### Health API Returns 404

**Symptom**: `curl http://localhost:32300/q/health` returns 404.

**Cause**: The pod is starting up but Quarkus has not initialized yet. Debezium Server starts the HTTP server as part of the Quarkus startup sequence.

**Fix**: Wait 30–60 seconds and retry. If it persists, check pod logs:
```bash
kubectl logs -n infra deploy/debezium-server-ecom
```

### Large WAL Lag / Disk Full Warning

**Symptom**: PostgreSQL disk usage growing; `pg_wal` directory large.

**Cause**: Replication slot is active but Debezium is not consuming (or pod was deleted and slot is now inactive with `active=f`).

```bash
# Check slot status
kubectl exec -n ecom deploy/ecom-db -- psql -U ecomuser -d ecomdb \
  -c "SELECT slot_name, active, restart_lsn, pg_current_wal_lsn(), \
             pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag \
      FROM pg_replication_slots;"
```

**Fix**: Restart Debezium Server. If the pod was deleted and offset is lost, the slot will catch up after re-snapshot.

---

## 18. Screenshot Reference

These views help verify Debezium Server operation:

| What to Check | How to Access |
|---------------|---------------|
| Health status | `curl http://localhost:32300/q/health` |
| Pod status | `kubectl get pods -n infra -l app=debezium-server-ecom` |
| Pod logs | `kubectl logs -n infra deploy/debezium-server-ecom` |
| Kafka topics | `kubectl exec -n infra deploy/kafka -- kafka-topics --list` |
| Replication slots | PgAdmin at `http://localhost:31111` → ecom-db → pg_replication_slots |
| WAL lag | PgAdmin → ecom-db → Query Tool → SELECT from pg_replication_slots |

### PgAdmin: View Replication Slots

1. Navigate to `http://localhost:31111`
2. Log in with PgAdmin credentials
3. Expand: Servers → ecom-db → Databases → ecomdb → Schemas → public
4. In Query Tool:
   ```sql
   SELECT slot_name, active, restart_lsn,
          pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag
   FROM pg_replication_slots;
   ```

Expected: `active = true`, `lag` < 1MB for `debezium_ecom_slot`.

---

## Related Documents

- `docs/cdc/debezium-flink-cdc.md` — full CDC pipeline architecture overview
- `docs/cdc/flink-streaming-sql-pipeline.md` — Flink SQL pipeline internals and customization
- `docs/cdc/step-by-step-flink-upgrade-and-debezium-server-migration.md` — migration from Kafka Connect to Debezium Server
- `docs/operations/stability-issues-and-fixes.md` — all production bugs and fixes (Issues 13–17 are Debezium Server specific)
- `infra/debezium/debezium-server-ecom.yaml` — ecom server manifest
- `infra/debezium/debezium-server-inventory.yaml` — inventory server manifest
- `infra/debezium/register-connectors.sh` — health-check wait script
