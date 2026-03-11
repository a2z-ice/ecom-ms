# PostgreSQL High Availability with CloudNativePG

> Session 27 — Automatic Failover, WAL-based CDC with Debezium, and Zero-Downtime Database Recovery

## Table of Contents

- [What is CloudNativePG?](#what-is-cloudnativepg)
- [How Debezium CDC Works with PostgreSQL WAL](#how-debezium-cdc-works-with-postgresql-wal)
- [HA Architecture](#ha-architecture)
- [Why 5 Kubernetes Services Per Database?](#why-5-kubernetes-services-per-database)
- [Automatic Failover Sequence](#automatic-failover-sequence)
- [Why CNPG is Excluded from Istio Ambient Mesh](#why-cnpg-is-excluded-from-istio-ambient-mesh)
- [Debezium Configuration for HA](#debezium-configuration-for-ha)
- [Issues Encountered & Fixes](#issues-encountered--fixes)
- [Database Clusters Summary](#database-clusters-summary)
- [AWS RDS & Aurora PostgreSQL Configuration](#aws-rds--aurora-postgresql-configuration)
- [Verification & Testing](#verification--testing)
- [Files Changed Summary](#files-changed-summary)

---

## What is CloudNativePG?

**CloudNativePG (CNPG)** is a Kubernetes operator designed to manage the full lifecycle of PostgreSQL database clusters inside Kubernetes. It is the **first open-source PostgreSQL operator to join the CNCF Sandbox**, and it is the industry-standard approach for running production PostgreSQL on Kubernetes.

### Why CloudNativePG Over Alternatives?

| Feature | CloudNativePG (Chosen) | Patroni | Manual Replication |
|---------|----------------------|---------|-------------------|
| Failover | Automatic (built-in controller) | Requires etcd/Consul | Manual promotion |
| Service management | Auto-creates `-rw`, `-ro`, `-r` Services | Custom configuration | Custom scripts |
| CDC support | `wal_level=logical` native | Supported | Supported |
| Configuration | Single CRD per cluster | Multiple config files | Manual config |
| Backup/Restore | Built-in (Barman) | External tools | Manual |
| CNCF status | Sandbox project | N/A | N/A |

CloudNativePG was chosen for its simplicity, native Kubernetes integration, and alignment with our existing operator pattern (cert-manager, cert-dashboard-operator).

### How CNPG Works

The CNPG operator watches for `Cluster` custom resources and reconciles the desired state:

1. **Cluster CR Applied** — You declare a `Cluster` resource specifying instances, storage, PostgreSQL parameters, and bootstrap configuration
2. **Operator Creates Pods** — CNPG creates the specified number of PostgreSQL pods. The first pod becomes the **primary** (read-write), and additional pods become **standbys** (read-only replicas)
3. **Services Auto-Created** — Three Kubernetes Services are automatically created:
   - `<cluster>-rw` — Routes to the current primary (for writes)
   - `<cluster>-ro` — Routes to standby replicas (for reads)
   - `<cluster>-r` — Routes to all instances (for any read)
4. **Streaming Replication** — CNPG configures PostgreSQL native streaming replication between primary and standbys. WAL records are shipped continuously
5. **Health Monitoring** — The instance manager (sidecar process) on each pod reports health to the operator every ~10 seconds
6. **Automatic Failover** — When the primary pod fails, CNPG promotes the most up-to-date standby to primary and updates the `-rw` Service endpoint

### Example CNPG Cluster CR

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: ecom-db
  namespace: ecom
spec:
  instances: 2                    # 1 primary + 1 standby
  imageName: ghcr.io/cloudnative-pg/postgresql:17

  # Exclude from Istio Ambient mesh (CNPG manages its own TLS)
  inheritedMetadata:
    annotations:
      ambient.istio.io/redirection: disabled

  postgresql:
    parameters:
      wal_level: logical          # Required for Debezium CDC
      max_replication_slots: "10"
      max_wal_senders: "10"
      wal_keep_size: 256MB

  bootstrap:
    initdb:
      database: ecomdb
      owner: ecomuser
      secret:
        name: ecom-db-cnpg-auth
      postInitApplicationSQL:
        - ALTER USER ecomuser WITH REPLICATION;
        - CREATE PUBLICATION debezium_ecom_pub FOR ALL TABLES;

  storage:
    size: 2Gi
    storageClass: standard
```

---

## How Debezium CDC Works with PostgreSQL WAL

### Write-Ahead Log (WAL) Fundamentals

PostgreSQL uses a **Write-Ahead Log (WAL)** to ensure data durability. Before any change is written to the actual data files (tables, indexes), it is first recorded in the WAL. This guarantees that even if PostgreSQL crashes mid-transaction, the database can recover to a consistent state by replaying the WAL.

> **WAL is the Source of Truth:** Every `INSERT`, `UPDATE`, and `DELETE` operation generates WAL records. These records contain the exact byte-level changes to the data pages. PostgreSQL uses WAL for three critical purposes: crash recovery, streaming replication (to standbys), and logical replication (to external consumers like Debezium).

### Physical vs Logical WAL

| Aspect | Physical WAL (default) | Logical WAL (`wal_level=logical`) |
|--------|----------------------|----------------------------------|
| **Content** | Raw byte-level page diffs | Logical row changes (INSERT/UPDATE/DELETE with column values) |
| **Use case** | Streaming replication, crash recovery | Change Data Capture, logical replication |
| **Consumers** | Standby PostgreSQL instances | Debezium, pg_logical, custom consumers |
| **Overhead** | Minimal | Slightly larger WAL volume (~10-20% more) |
| **PostgreSQL setting** | `wal_level=replica` | `wal_level=logical` |

`wal_level=logical` is a superset of `replica` — it includes all physical WAL data PLUS decoded logical change records. This means a single WAL stream supports both streaming replication (to standbys) and logical replication (to Debezium) simultaneously.

### Debezium's CDC Pipeline from WAL

Debezium captures changes from PostgreSQL through the following mechanism:

1. **Logical Replication Slot** — Debezium creates a replication slot (`debezium_ecom_slot`) on the primary. This slot tells PostgreSQL to **retain WAL segments** that haven't been consumed yet, preventing them from being recycled
2. **Publication** — A PostgreSQL `PUBLICATION` defines which tables are included in the change stream. We pre-create `debezium_ecom_pub FOR ALL TABLES` as the superuser during database bootstrap
3. **pgoutput Plugin** — Debezium uses PostgreSQL's built-in `pgoutput` logical decoding plugin to decode WAL records into a structured format (table name, operation type, old/new row values)
4. **Streaming Protocol** — Debezium connects to PostgreSQL via the streaming replication protocol (port 5432, same as regular connections) and receives a continuous stream of decoded changes
5. **Kafka Sink** — Each change is transformed into a Kafka message and published to the appropriate topic (`ecom-connector.public.orders`, etc.)
6. **Offset Storage** — Debezium records the current WAL position (LSN — Log Sequence Number) in a Kafka topic (`debezium.ecom.offsets`) so it can resume from the exact position after a restart

```
PostgreSQL Primary
  │
  ├── Transaction: INSERT INTO orders (id, user_id, total) VALUES (1, 'u1', 39.98)
  │
  ├── WAL Record Generated:
  │     LSN: 0/1A3B4C0
  │     Type: INSERT
  │     Table: public.orders
  │     New Row: {id: 1, user_id: 'u1', total: 39.98}
  │
  ├── Logical Replication Slot: debezium_ecom_slot
  │     Confirmed flush LSN: 0/1A3B4B0  (previous position)
  │     Slot retains WAL from this LSN onward
  │
  ├── pgoutput Plugin decodes → structured change event
  │
  └── Debezium Server receives:
        {
          "source": {"lsn": 27229376, "table": "orders"},
          "op": "c",  // c=create, u=update, d=delete
          "after": {"id": 1, "user_id": "u1", "total": 39.98}
        }
        │
        └── Published to Kafka topic: ecom-connector.public.orders
            Offset stored in: debezium.ecom.offsets (Kafka, compacted)
```

---

## HA Architecture

### Architecture Diagrams

Animated SVG diagrams are available at:
- `docs/diagrams/ha-postgres-debezium-animated.svg` — Complete HA architecture with CNPG, Debezium, and Kafka
- `docs/diagrams/ha-failover-animated.svg` — 8-phase automatic failover sequence

Interactive HTML version with both diagrams: `webpage/postgresql-ha.html`

### Key Architecture Components

| Component | Role | Details |
|-----------|------|---------|
| **CNPG Operator** | Lifecycle management | Watches Cluster CRs, manages pods, handles failover, updates Services |
| **Primary Pod** | Read-write instance | Accepts all writes, generates WAL, hosts replication slots and publications |
| **Standby Pod** | Read-only replica | Receives WAL via streaming replication, continuously replays changes |
| **-rw Service** | Write endpoint | Auto-managed by CNPG, always points to current primary pod |
| **ExternalName Service** | DNS alias | `ecom-db` → `ecom-db-rw` (zero app config changes) |
| **Debezium Server** | CDC capture | Reads WAL via logical replication slot, publishes to Kafka |
| **Kafka** | Event bus + offset store | CDC topics + `debezium.ecom.offsets` (compacted, survives restarts) |
| **Flink SQL** | Stream processing | Consumes Kafka CDC topics, transforms to analytics star schema |

### ExternalName Service Pattern

The key to achieving **zero application code changes** is the ExternalName Service pattern:

```
Application JDBC URL: jdbc:postgresql://ecom-db:5432/ecomdb
                              │
                              ▼
            ExternalName Service: ecom-db
            (type: ExternalName)
            externalName: ecom-db-rw.ecom.svc.cluster.local
                              │
                              ▼
            CNPG -rw Service: ecom-db-rw
            (Endpoints: current primary pod IP)
                              │
                              ▼
            Primary Pod: ecom-db-1 (or ecom-db-2 after failover)
            PostgreSQL 17 | wal_level=logical
```

No application code, Debezium config, Flink SQL, Keycloak, or any other component needed modification to their database connection strings.

---

## Why 5 Kubernetes Services Per Database?

When you run `kubectl get svc -n inventory`, you'll see **5 services** for a single database cluster like `inventory-db`. Here's exactly what each one is, who creates it, and where it's used.

### All 5 Services Explained

| # | Service Name | Type | Created By | Purpose |
|---|-------------|------|------------|---------|
| 1 | `inventory-db` | ExternalName | **Manual** (in CNPG cluster YAML) | DNS alias → points to `inventory-db-rw`. Preserves original hostname so apps need zero config changes. |
| 2 | `inventory-db-rw` | ClusterIP | **CNPG Operator** (auto) | **Read-Write endpoint** — always routes to current primary pod. Endpoints auto-updated on failover. |
| 3 | `inventory-db-ro` | ClusterIP | **CNPG Operator** (auto) | **Read-Only endpoint** — routes to standby replicas only. For read queries tolerating replication lag. |
| 4 | `inventory-db-r` | ClusterIP | **CNPG Operator** (auto) | **Any-Read endpoint** — routes to all instances (primary + standbys). Load-balances reads across every pod. |
| 5 | `inventory-db-any` | ClusterIP (Headless) | **CNPG Operator** (auto) | **Headless service** for pod DNS discovery. Each pod gets stable DNS like `inventory-db-1.inventory-db-any`. Used by CNPG internally. |

> **CNPG auto-creates 4 services per Cluster.** When CNPG processes a `Cluster` CR named `inventory-db`, it automatically creates `-rw`, `-ro`, `-r`, and `-any`. The 5th service (`inventory-db` itself, the ExternalName alias) is **manually defined** in our CNPG cluster YAML to maintain backward compatibility.

### Service Routing Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│  kubectl get svc -n inventory                                           │
│                                                                          │
│  NAME                TYPE           TARGET                               │
│  ─────────────────   ────────────   ──────────────────────────────────── │
│  inventory-db        ExternalName   → inventory-db-rw.inventory.svc...  │
│  inventory-db-rw     ClusterIP      → Primary pod IP (auto-updated)     │
│  inventory-db-ro     ClusterIP      → Standby pod IPs only              │
│  inventory-db-r      ClusterIP      → All pod IPs (primary + standby)   │
│  inventory-db-any    ClusterIP      → Headless (pod DNS discovery)      │
└──────────────────────────────────────────────────────────────────────────┘

  Application / Debezium connects to:

  inventory-db ──DNS──→ inventory-db-rw ──Endpoint──→ Primary Pod
  (ExternalName)         (ClusterIP)                  (inventory-db-1
                                                       or -2 after failover)

  On failover:
    CNPG patches inventory-db-rw Endpoints:
      Before: inventory-db-1 (10.244.1.5)  ← was primary
      After:  inventory-db-2 (10.244.2.8)  ← promoted to primary
```

### Which Services Are Actually Used?

| Consumer | Service Used | Why |
|----------|-------------|-----|
| **inventory-service** (FastAPI) | `inventory-db` | ExternalName alias — same hostname as before CNPG migration |
| **ecom-service** (Spring Boot) | `ecom-db` | Same pattern |
| **Debezium Server** | `ecom-db`, `inventory-db` | CDC hostname unchanged — resolves through alias → `-rw` → primary |
| **Keycloak** | `keycloak-db` | ExternalName → `keycloak-db-rw` |
| **Flink SQL** | `analytics-db` | JDBC sink URL uses ExternalName alias |
| **Superset** | `analytics-db` | SQL queries via ExternalName alias |
| **-ro, -r services** | *Not used currently* | Available for future read scaling |
| **-any service** | *CNPG internal only* | Headless service for pod DNS; instance manager communication |

> **Read Scaling Ready:** The `-ro` and `-r` services are available for read scaling. Point Superset or reporting tools to `analytics-db-ro` to offload read queries from the primary — just change the hostname, no additional configuration needed.

---

## Automatic Failover Sequence

### 8-Phase Recovery Timeline

| Phase | Name | Description | Duration |
|-------|------|-------------|----------|
| 1 | **Normal Operation** | App connects via ExternalName → -rw → Primary. Debezium reads WAL. Streaming replication active. | — |
| 2 | **Primary Pod Fails** | Pod crashes (OOMKill, node failure). App JDBC connections break (TCP RST). Debezium loses TCP. | 0s |
| 3 | **CNPG Detects Failure** | Instance manager reports unhealthy. Reconcile loop (~10s) detects pod not ready. | ~10s |
| 4 | **Promote Standby** | `pg_ctl promote` on standby. Exits recovery mode, accepts writes. Timeline ID increments. | ~2-5s |
| 5 | **Update -rw Service** | CNPG patches `ecom-db-rw` Endpoints → new primary pod IP. ExternalName follows. | ~1s |
| 6 | **App Reconnects** | HikariCP detects broken connections, creates new ones via DNS. App resumes. | ~2-5s |
| 7 | **Debezium Resumes** | Reconnects to same hostname → new primary. Creates new slot. Reads offset from Kafka. | ~5-10s |
| 8 | **Fully Recovered** | CNPG recreates old primary as new standby. Cluster returns to 2 healthy instances. | ~30-60s |

**Total application downtime: ~5-15 seconds. Zero data loss (synchronous replication).**

### KafkaOffsetBackingStore: The Key to Debezium Resilience

Previously, Debezium used `FileOffsetBackingStore` with `emptyDir` storage — meaning offsets were lost on every pod restart, triggering a full re-snapshot. By switching to `KafkaOffsetBackingStore`, offsets are stored in a compacted Kafka topic (`debezium.ecom.offsets`) that survives both Debezium restarts AND database failovers. After failover, Debezium reads the last committed LSN from Kafka and resumes exactly where it left off.

---

## Why CNPG is Excluded from Istio Ambient Mesh

This was one of the most critical architectural decisions in the HA implementation.

### The Conflict: Double TLS Encryption

Istio Ambient Mesh uses **ztunnel** to transparently intercept all TCP traffic and wrap it in HBONE (HTTP/2-based) tunnels with mTLS encryption. CNPG manages its own TLS certificates for PostgreSQL streaming replication. When both are active:

```
# With Istio Ambient + CNPG TLS (BROKEN):
Primary Pod
  └── PostgreSQL starts TLS handshake (CNPG-managed cert)
        └── ztunnel intercepts → wraps in HBONE mTLS tunnel
              └── ztunnel on destination decrypts HBONE
                    └── Delivers to Standby Pod
                          └── PostgreSQL tries to complete TLS handshake
                                └── FAILS: TLS state corrupted by double encryption

# Without Istio Ambient (WORKING):
Primary Pod
  └── PostgreSQL starts TLS handshake (CNPG-managed cert)
        └── Direct TCP to Standby Pod
              └── PostgreSQL completes TLS handshake
                    └── Streaming replication active
```

**Symptom:** Standby pods fail to connect to primary with `SSL error: certificate verify failed` or TLS handshake timeouts.

### The Solution: Mesh Exclusion

All CNPG database pods are excluded from the Istio Ambient mesh:

```yaml
# In every CNPG Cluster CR:
spec:
  inheritedMetadata:
    annotations:
      ambient.istio.io/redirection: disabled
```

### Why cnpg-system Namespace is NOT in the Mesh

The CNPG operator itself (in `cnpg-system` namespace) also cannot be in the mesh. CNPG registers a **ValidatingWebhookConfiguration** with the Kubernetes API server. The kube-apiserver is **outside the mesh** — if the webhook pod is in STRICT mTLS mode, the kube-apiserver's plain TCP connection is rejected, and all Cluster operations fail with `EOF` errors.

```yaml
# cnpg-system PeerAuthentication: PERMISSIVE
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: cnpg-mtls
  namespace: cnpg-system
spec:
  mtls:
    mode: PERMISSIVE  # kube-apiserver needs plain TCP access to webhook
```

### Security Impact

| Aspect | Impact | Mitigation |
|--------|--------|------------|
| Inter-pod replication | Not encrypted by Istio | CNPG manages its own TLS — traffic IS encrypted |
| App → Database | Not encrypted by Istio | CNPG enables TLS by default on all connections |
| Operator webhook | Plain TCP from kube-apiserver | PERMISSIVE mode; webhook itself uses HTTPS |
| NetworkPolicies | Still enforced | Namespace-scoped policies with CNPG labels |
| AuthorizationPolicies | Updated for CNPG | Use `cnpg.io/cluster` label selectors |

---

## Debezium Configuration for HA

### KafkaOffsetBackingStore Configuration

```properties
# Debezium Server application.properties (HA-ready)

# ─── Offset Storage (Kafka) ───
debezium.source.offset.storage=org.apache.kafka.connect.storage.KafkaOffsetBackingStore
debezium.source.offset.storage.topic=debezium.ecom.offsets
debezium.source.offset.storage.bootstrap.servers=kafka.infra.svc.cluster.local:9092
debezium.source.offset.flush.interval.ms=5000

# KafkaOffsetBackingStore requires these in embedded worker config:
debezium.source.bootstrap.servers=kafka.infra.svc.cluster.local:9092
debezium.source.offset.storage.partitions=1
debezium.source.offset.storage.replication.factor=1

# ─── Publication (pre-created as superuser) ───
debezium.source.publication.name=debezium_ecom_pub
debezium.source.publication.autocreate.mode=disabled

# ─── Source Database ───
debezium.source.connector.class=io.debezium.connector.postgresql.PostgresConnector
debezium.source.database.hostname=ecom-db         # ExternalName → -rw → primary
debezium.source.database.port=5432
debezium.source.database.dbname=ecomdb
debezium.source.plugin.name=pgoutput
debezium.source.slot.name=debezium_ecom_slot
```

### Kafka Offset Topics

Offset topics must be created with `cleanup.policy=compact`:

```bash
# Offset topics (compacted — retains last value per key)
recreate_compacted_topic "debezium.ecom.offsets"
recreate_compacted_topic "debezium.inventory.offsets"

# Why "recreate"? Stale offsets from a previous DB instance cause
# "no longer available on the server" errors. Fresh bootstrap = fresh offsets.
```

---

## Issues Encountered & Fixes

### Issue 1: CNPG Streaming Replication TLS Timeout

- **Symptom:** Standby pods failed to connect to primary with TLS handshake errors
- **Root Cause:** Istio ztunnel double-encrypted CNPG's own TLS traffic
- **Fix:** Added `inheritedMetadata.annotations: ambient.istio.io/redirection: disabled` to all Cluster CRs

### Issue 2: CNPG Webhook Unreachable (EOF Error)

- **Symptom:** `kubectl apply` of Cluster CR failed with `EOF` from webhook
- **Root Cause:** cnpg-system in Istio Ambient mesh with STRICT mTLS blocked kube-apiserver
- **Fix:** Removed cnpg-system from ambient mesh; PeerAuth set to PERMISSIVE

### Issue 3: KafkaOffsetBackingStore Missing Properties

- **Symptom:** Debezium failed to start: `Missing required config: bootstrap.servers`
- **Root Cause:** Embedded Kafka Connect worker needs `bootstrap.servers`, `offset.storage.partitions`, `offset.storage.replication.factor` under `debezium.source` prefix
- **Fix:** Added all required properties

### Issue 4: REPLICATION Role Not Granted

- **Symptom:** Debezium couldn't create replication slot: `must be superuser or replication role`
- **Root Cause:** CNPG doesn't auto-grant REPLICATION attribute
- **Fix:** Added `ALTER USER ecomuser WITH REPLICATION` in `postInitApplicationSQL`

### Issue 5: Publication Must Be Created as Superuser

- **Symptom:** `must be superuser to create FOR ALL TABLES publication`
- **Root Cause:** PostgreSQL requires superuser for `CREATE PUBLICATION FOR ALL TABLES`
- **Fix:** Pre-created in `postInitApplicationSQL` (runs as postgres); set `publication.autocreate.mode=disabled`

### Issue 6: Peer Authentication Failed for Application User

- **Symptom:** `psql -U ecomuser` via `kubectl exec` failed with `Peer authentication failed`
- **Root Cause:** CNPG uses `peer` auth on local socket; only `postgres` OS user → `postgres` DB user
- **Fix:** All E2E tests updated to use `psql -U postgres`

### Issue 7: Stale Kafka Offsets from Previous Run

- **Symptom:** `Replication slot is no longer available on the server`
- **Root Cause:** Kafka data persists on PVC; old offsets referenced LSNs from previous DB
- **Fix:** `kafka-topics-init.yaml` deletes and recreates offset topics on fresh bootstrap

### Issue 8: NetworkPolicy Blocking K8s API Server Access

- **Symptom:** CNPG pods couldn't communicate with K8s API server
- **Root Cause:** Namespace NetworkPolicies didn't include K8s API server egress
- **Fix:** Added egress rules for ports 443/6443 to kube-system namespace

### Issue 9: Offset Topic cleanup.policy Must Be Compact

- **Symptom:** Debezium lost offsets after Kafka log retention
- **Root Cause:** Offset topics created with default `delete` policy
- **Fix:** Create with `--config cleanup.policy=compact`

---

## Database Clusters Summary

| Cluster | Namespace | Instances | WAL Level | Storage | CDC Source? |
|---------|-----------|-----------|-----------|---------|-------------|
| **ecom-db** | ecom | 2 (1P + 1S) | logical | 2Gi | Yes (Debezium) |
| **inventory-db** | inventory | 2 (1P + 1S) | logical | 2Gi | Yes (Debezium) |
| **analytics-db** | analytics | 2 (1P + 1S) | replica | 5Gi | No (sink only) |
| **keycloak-db** | identity | 2 (1P + 1S) | replica | 2Gi | No |

Total: 8 database pods (up from 4 single-replica Deployments). Additional resource usage: ~500m CPU, ~1.25Gi memory.

---

## AWS RDS & Aurora PostgreSQL Configuration

### AWS RDS PostgreSQL

| CNPG (Kubernetes) | AWS RDS PostgreSQL | Notes |
|-------------------|--------------------|-------|
| `instances: 2` | `MultiAZ: true` | Synchronous standby with automatic failover |
| `wal_level: logical` | Parameter Group: `rds.logical_replication = 1` | Requires reboot |
| `max_replication_slots: 10` | Parameter Group: `max_replication_slots = 10` | Same parameter |
| `wal_keep_size: 256MB` | Not needed | RDS manages WAL retention |
| `storageClass: standard` | `StorageType: gp3` | gp3 for balanced IOPS/cost |
| ExternalName Service | RDS Endpoint (DNS) | Auto-follows failover |
| CNPG `postInitApplicationSQL` | Lambda / custom init script | Run after RDS ready |
| CNPG manages TLS | RDS manages TLS (rds-ca bundle) | `rds-combined-ca-bundle.pem` |

```hcl
# AWS RDS PostgreSQL — Terraform
resource "aws_db_parameter_group" "ecom_pg17" {
  family = "postgres17"
  name   = "ecom-pg17-params"

  parameter {
    name         = "rds.logical_replication"
    value        = "1"
    apply_method = "pending-reboot"
  }
  parameter { name = "max_replication_slots"; value = "10" }
  parameter { name = "max_wal_senders"; value = "10" }
}

resource "aws_db_instance" "ecom_db" {
  identifier     = "ecom-db"
  engine         = "postgres"
  engine_version = "17"
  instance_class = "db.t3.medium"
  multi_az       = true
  db_name        = "ecomdb"
  username       = "ecomuser"
  parameter_group_name = aws_db_parameter_group.ecom_pg17.name
  storage_encrypted    = true
  allocated_storage    = 20
  storage_type         = "gp3"
}
```

### AWS Aurora PostgreSQL

| CNPG (Kubernetes) | AWS Aurora PostgreSQL | Notes |
|-------------------|-----------------------|-------|
| `instances: 2` | 1 Writer + 1+ Reader | Aurora cluster auto-failover |
| `wal_level: logical` | Cluster Parameter Group: `rds.logical_replication = 1` | Same as RDS |
| ExternalName Service | Aurora Cluster Endpoint (writer) | Auto-follows failover |
| `storageClass: standard` | Aurora storage (auto-scaling) | No config needed; auto-scales to 128 TiB |
| Streaming replication | Aurora shared storage | No WAL shipping; shared storage layer |

```hcl
# AWS Aurora PostgreSQL — Terraform
resource "aws_rds_cluster" "ecom" {
  cluster_identifier = "ecom-db-cluster"
  engine             = "aurora-postgresql"
  engine_version     = "17.4"
  database_name      = "ecomdb"
  master_username    = "ecomuser"
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.ecom.name
  storage_encrypted  = true
}

resource "aws_rds_cluster_instance" "writer" {
  identifier         = "ecom-db-writer"
  cluster_identifier = aws_rds_cluster.ecom.id
  instance_class     = "db.r6g.large"
  engine             = "aurora-postgresql"
}

resource "aws_rds_cluster_instance" "reader" {
  identifier         = "ecom-db-reader"
  cluster_identifier = aws_rds_cluster.ecom.id
  instance_class     = "db.r6g.large"
  engine             = "aurora-postgresql"
}
```

### Debezium Configuration Changes for AWS

```properties
# Database Connection — only hostname changes
# CNPG:
debezium.source.database.hostname=ecom-db
# AWS RDS:
debezium.source.database.hostname=ecom-db.xxxx.us-east-1.rds.amazonaws.com
# AWS Aurora:
debezium.source.database.hostname=ecom-db-cluster.cluster-xxxx.us-east-1.rds.amazonaws.com

# SSL/TLS — add for AWS
debezium.source.database.sslmode=verify-full
debezium.source.database.sslrootcert=/path/to/rds-combined-ca-bundle.pem

# Offset storage and publication config — unchanged
```

### AWS-Specific Considerations

- **No superuser access:** RDS/Aurora don't provide `postgres` superuser. Use `rds_superuser` role (master user has it)
- **Reboot required:** `rds.logical_replication` change requires reboot
- **Aurora replication slots:** Tied to writer instance; on failover, promoted reader creates new slots
- **WAL retention:** Aurora doesn't use `wal_keep_size`. Monitor `ReplicationSlotDiskUsage` CloudWatch metric
- **MSK/Kafka:** Update `bootstrap.servers` to MSK broker endpoints if using Amazon MSK

---

## Verification & Testing

### Cluster Health Checks

```bash
# Check all CNPG clusters
kubectl get clusters -A

# Check pods per cluster
kubectl get pods -n ecom -l cnpg.io/cluster=ecom-db

# Verify primary/standby roles
kubectl get pods -n ecom -l cnpg.io/cluster=ecom-db \
  -o custom-columns=NAME:.metadata.name,ROLE:.metadata.labels.cnpg\\.io/instanceRole

# Check ExternalName Service
kubectl get svc ecom-db -n ecom

# Test app connectivity
curl -sk https://api.service.net:30000/ecom/books
```

### Failover Test

```bash
# 1. Delete primary pod
kubectl delete pod -n ecom -l cnpg.io/instanceRole=primary,cnpg.io/cluster=ecom-db

# 2. Verify cluster recovers
kubectl wait --for=jsonpath='{.status.readyInstances}'=2 \
  cluster/ecom-db -n ecom --timeout=120s

# 3. Verify app still works
curl -sk https://api.service.net:30000/ecom/books
```

### E2E Test Coverage

`e2e/postgresql-ha.spec.ts` includes 31 tests covering:
- CNPG operator health
- Cluster health (all 4 clusters)
- Instance counts (2 per cluster)
- Primary/standby role verification
- ExternalName service resolution
- WAL level verification (logical for CDC sources)
- Streaming replication status
- PVC storage binding
- Failover recovery (delete primary → cluster recovers)
- Application reconnection post-failover
- Debezium resilience

---

## Files Changed Summary

| # | File | Action | Description |
|---|------|--------|-------------|
| 1 | `infra/cnpg/install.sh` | NEW | Install CNPG operator v1.25.1 |
| 2 | `infra/cnpg/ecom-db-cluster.yaml` | NEW | CNPG Cluster (2 instances, logical WAL) |
| 3 | `infra/cnpg/inventory-db-cluster.yaml` | NEW | Same pattern |
| 4 | `infra/cnpg/analytics-db-cluster.yaml` | NEW | 5Gi storage, no logical WAL |
| 5 | `infra/cnpg/keycloak-db-cluster.yaml` | NEW | Identity namespace |
| 6 | `infra/cnpg/peer-auth.yaml` | NEW | PERMISSIVE mTLS for cnpg-system |
| 7-9 | `infra/postgres/*.yaml` | DELETE | Replaced by CNPG Clusters |
| 10 | `infra/keycloak/keycloak.yaml` | MODIFY | Remove keycloak-db section |
| 11 | `infra/debezium/debezium-server-*.yaml` | MODIFY | KafkaOffsetBackingStore |
| 12 | `infra/kafka/kafka-topics-init.yaml` | MODIFY | Compacted offset topics |
| 13-16 | `infra/kubernetes/network-policies/*.yaml` | MODIFY | CNPG labels + K8s API egress |
| 17-20 | `infra/istio/security/authz-policies/*.yaml` | MODIFY | CNPG label selectors |
| 21-24 | `scripts/*.sh` | MODIFY | CNPG install/wait/labels |
| 25-28 | `e2e/*.ts` | MODIFY | Label-based pod exec |
| 29 | `e2e/postgresql-ha.spec.ts` | NEW | 31 HA E2E tests |
| 30-31 | `docs/diagrams/ha-*.svg` | NEW | Animated architecture diagrams |
