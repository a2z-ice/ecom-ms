# Step-by-Step: Flink Upgrade Attempt & Debezium Server Migration

**Session 22 — Book Store Analytics Platform**

This document is a complete record of what was changed, why each change was made, every bug encountered during implementation, the root cause of each bug, and the exact fix applied. It is written so that someone unfamiliar with the session can reproduce or extend the work from scratch.

---

## Table of Contents

1. [Goals and Motivation](#1-goals-and-motivation)
2. [Architecture: Before and After](#2-architecture-before-and-after)
3. [Flink Upgrade Attempt (1.20 → 2.2.0)](#3-flink-upgrade-attempt-120--220)
4. [Debezium Server Migration (Kafka Connect → Standalone)](#4-debezium-server-migration-kafka-connect--standalone)
5. [Bug 1 — Cross-Namespace Secret Reference](#5-bug-1--cross-namespace-secret-reference)
6. [Bug 2 — Wrong Config Mount Path](#6-bug-2--wrong-config-mount-path)
7. [Bug 3 — KafkaOffsetBackingStore Configuration](#7-bug-3--kafkaoffsetbackingstore-configuration)
8. [Bug 4 — ByteArraySerializer Incompatible with JSON Format](#8-bug-4--bytearrayserializer-incompatible-with-json-format)
9. [All File Changes Summary](#9-all-file-changes-summary)
10. [Deployment Procedure](#10-deployment-procedure)
11. [Verification Checklist](#11-verification-checklist)
12. [Known Limitations and Future Work](#12-known-limitations-and-future-work)

---

## 1. Goals and Motivation

Two independent upgrades were planned for Session 22:

### 1.1 Flink 1.20 → 2.2.0

Apache Flink 2.0 is a major release (December 2025) with a rewritten connector API. The 4.x connector series (e.g. `flink-connector-kafka:4.0.1-2.0`) targets Flink 2.x. The upgrade was planned to keep the platform current with the Flink ecosystem.

**Outcome: Partially completed.** The Kafka connector was successfully upgraded but the JDBC connector has no Flink 2.x release yet (see [Section 3](#3-flink-upgrade-attempt-120--220)). Flink base image stayed at 1.20.

### 1.2 Debezium Kafka Connect → Debezium Server 3.4

The original architecture used Debezium Kafka Connect, a distributed connector framework that manages connectors via a REST API. While powerful, it has operational overhead:

- Connectors must be registered via REST after every Kafka restart (internal topics are lost)
- A single pod handles both source DBs — coupling that doesn't scale
- REST management adds extra steps to recovery scripts

Debezium Server is a simpler, opinionated alternative: a standalone Quarkus process that reads config from a properties file and runs a single connector. One pod per source database. No REST API, no registration step, auto-starts on launch.

**Outcome: Fully completed.** Two Debezium Server pods replaced the single Kafka Connect pod. Four bugs were fixed during deployment.

---

## 2. Architecture: Before and After

### 2.1 Before (Kafka Connect)

```
ecom-db (PostgreSQL WAL)  ──────────┐
                                     ├──► Debezium (Kafka Connect)  ──► Kafka  ──► Flink SQL ──► analytics-db
inventory-db (PostgreSQL WAL) ───────┘         (single pod)
                                               Port 8083 REST API
                                               NodePort 32300
```

**Key characteristics:**
- Single pod in `infra` namespace: `debezium` (deployment)
- REST API at `localhost:32300/connectors`
- Two connectors registered at runtime: `ecom-connector` and `inventory-connector`
- Connector config in `infra/debezium/connectors/ecom-connector.json` and `inventory-connector.json`
- Connectors lost on Kafka restart → `register-connectors.sh` re-registers them via REST PUT
- Credentials injected into connector config by `register-connectors.sh` (FileConfigProvider expansion only works at task start, not validation)

### 2.2 After (Debezium Server)

```
ecom-db (PostgreSQL WAL)  ──► debezium-server-ecom  ──────────────┐
                               (Quarkus, port 8080)                ├──► Kafka ──► Flink SQL ──► analytics-db
inventory-db (PostgreSQL WAL) ──► debezium-server-inventory ───────┘
                                   (Quarkus, port 8080)

Health: localhost:32300/q/health (ecom)
Health: localhost:32301/q/health (inventory)
```

**Key characteristics:**
- Two pods in `infra` namespace: `debezium-server-ecom` and `debezium-server-inventory`
- Health API at `/q/health` (Quarkus standard, not Kafka Connect REST)
- Config in `application.properties` ConfigMap — mounted into pod, read at startup
- Auto-starts CDC on launch — no REST registration step
- Offsets stored via `FileOffsetBackingStore` on an emptyDir volume
- Credentials from `debezium-db-credentials` secret in `infra` namespace

### 2.3 What Did NOT Change

The Kafka topic names are identical:

| Topic | Source |
|-------|--------|
| `ecom-connector.public.orders` | ecom-db orders table |
| `ecom-connector.public.order_items` | ecom-db order_items table |
| `ecom-connector.public.books` | ecom-db books table |
| `inventory-connector.public.inventory` | inventory-db inventory table |

The Debezium JSON envelope format is identical. The Flink SQL pipeline (`analytics/flink/sql/pipeline.sql`) was not changed. The analytics database schema and Superset dashboards were not changed.

---

## 3. Flink Upgrade Attempt (1.20 → 2.2.0)

### 3.1 What Was Planned

The plan was to update `analytics/flink/Dockerfile` to:

```dockerfile
# Before
FROM flink:1.20-scala_2.12-java17

RUN curl ... flink-connector-kafka-3.4.0-1.20.jar
RUN curl ... flink-connector-jdbc-3.3.0-1.20.jar
RUN curl ... kafka-clients-3.7.0.jar
RUN curl ... postgresql-42.7.4.jar

# After (planned)
FROM flink:2.2.0-scala_2.12-java17

RUN curl ... flink-connector-kafka-4.0.1-2.0.jar
RUN curl ... flink-connector-jdbc-4.0.0-2.0.jar    # ← This does not exist
RUN curl ... kafka-clients-3.9.2.jar
RUN curl ... postgresql-42.7.10.jar
```

### 3.2 What Happened: JDBC Connector 4.x Does Not Exist

When building the Flink 2.2.0 image with `flink-connector-jdbc:4.0.0-2.0`, the Maven Central download failed with HTTP 404:

```
ERROR: failed to build: failed to solve: process "/bin/sh -c curl -fsSL -o
flink-connector-jdbc-4.0.0-2.0.jar
\"https://repo1.maven.org/maven2/org/apache/flink/flink-connector-jdbc/4.0.0-2.0/
flink-connector-jdbc-4.0.0-2.0.jar\""
did not complete successfully: exit code: 22
```

Checking Maven Central confirmed the issue:

```bash
curl -s "https://repo1.maven.org/maven2/org/apache/flink/flink-connector-jdbc/maven-metadata.xml" \
  | grep version | tail -5
# Output:
# <version>3.2.0-1.19</version>
# <version>3.3.0-1.19</version>
# <version>3.3.0-1.20</version>   ← latest available
# (no 4.x or 2.x-suffix versions)
```

While the Kafka connector did release a `4.x` series for Flink 2.x:

```bash
curl -s "https://repo1.maven.org/maven2/org/apache/flink/flink-connector-kafka/maven-metadata.xml" \
  | grep version | tail -5
# <version>3.4.0-1.20</version>
# <version>4.0.0-2.0</version>
# <version>4.0.1-2.0</version>   ← available for Flink 2.x
```

The JDBC connector team has not yet released a Flink 2.x version.

### 3.3 Workaround Attempt: Use 3.3.0-1.20 with Flink 2.2.0

The next attempt was to use `flink-connector-jdbc:3.3.0-1.20` (the last Flink 1.x release) with Flink 2.2.0, hoping for backward API compatibility. The image built successfully. When the SQL pipeline was submitted, the JDBC `INSERT INTO` statement failed at runtime:

```
[ERROR] Could not execute SQL statement. Reason:
java.lang.ClassNotFoundException: org.apache.flink.streaming.api.functions.sink.SinkFunction
```

**Root cause:** Flink 2.0 removed the `SinkFunction` interface from its public API as part of the FLIP-200 sink API redesign. The JDBC connector `3.3.0-1.20` internally implements `SinkFunction` (the old 1.x API). When loaded into a Flink 2.x runtime, the class is not found.

This is a hard binary incompatibility — the old connector cannot run on Flink 2.x.

### 3.4 Resolution: Stay on Flink 1.20, Update Dependency Versions

Since no Flink 2.x JDBC connector exists, the Flink base image was kept at `1.20`. The dependency versions were still updated to their latest `1.20`-compatible releases:

| Dependency | Old Version | New Version | Reason |
|---|---|---|---|
| `flink-connector-kafka` | `3.4.0-1.20` | `3.4.0-1.20` | Already current |
| `flink-connector-jdbc` | `3.3.0-1.20` | `3.3.0-1.20` | Already current |
| `kafka-clients` | `3.7.0` | `3.9.2` | Bug fixes, performance |
| `postgresql` driver | `42.7.4` | `42.7.10` | Security patches |

**When to retry the Flink 2.x upgrade:** Once `flink-connector-jdbc` publishes a `4.x` or `2.x`-suffix release to Maven Central. Check: `https://repo1.maven.org/maven2/org/apache/flink/flink-connector-jdbc/`

### 3.5 Final Dockerfile

```dockerfile
# analytics/flink/Dockerfile
FROM alpine:3.19 AS downloader
RUN apk add --no-cache curl
WORKDIR /jars

# Flink Kafka connector (for Flink 1.20)
RUN curl -fsSL -o flink-connector-kafka-3.4.0-1.20.jar \
  "https://repo1.maven.org/maven2/org/apache/flink/flink-connector-kafka/3.4.0-1.20/flink-connector-kafka-3.4.0-1.20.jar"

# Flink JDBC connector (3.3.0 is the latest; no Flink 2.x release exists yet)
RUN curl -fsSL -o flink-connector-jdbc-3.3.0-1.20.jar \
  "https://repo1.maven.org/maven2/org/apache/flink/flink-connector-jdbc/3.3.0-1.20/flink-connector-jdbc-3.3.0-1.20.jar"

# PostgreSQL JDBC driver (updated from 42.7.4)
RUN curl -fsSL -o postgresql-42.7.10.jar \
  "https://repo1.maven.org/maven2/org/postgresql/postgresql/42.7.10/postgresql-42.7.10.jar"

# Kafka clients (updated from 3.7.0)
RUN curl -fsSL -o kafka-clients-3.9.2.jar \
  "https://repo1.maven.org/maven2/org/apache/kafka/kafka-clients/3.9.2/kafka-clients-3.9.2.jar"

# NOTE: Flink base image stays at 1.20 — flink-connector-jdbc has no 2.x release yet
FROM flink:1.20-scala_2.12-java17
COPY --from=downloader /jars/*.jar /opt/flink/lib/
```

---

## 4. Debezium Server Migration (Kafka Connect → Standalone)

### 4.1 Architecture Decision: One Pod Per Source DB

Debezium Server runs a single connector per process. Rather than a multi-connector Kafka Connect cluster, we deploy two separate Kubernetes Deployments:

- `debezium-server-ecom` — connects to `ecom-db`, streams `orders`, `order_items`, `books`
- `debezium-server-inventory` — connects to `inventory-db`, streams `inventory`

Each has its own ConfigMap, Secret references, NodePort, PeerAuthentication, health probe, and resource limits.

### 4.2 Configuration Model: ConfigMap vs. REST API

**Kafka Connect (old):** Connector config lived in JSON files. It was registered via REST PUT at runtime. The connector framework stored config internally in Kafka topics (`connect-configs`). On Kafka restart, those topics were lost and connectors had to be re-registered.

**Debezium Server (new):** Config lives in `application.properties`, mounted via a Kubernetes ConfigMap. The server reads it at startup and immediately begins streaming. No registration step. No REST endpoint to call. Config changes require a pod restart (which triggers a re-read of the ConfigMap).

**application.properties structure:**

```properties
# Source connector
debezium.source.connector.class=io.debezium.connector.postgresql.PostgresConnector
debezium.source.database.hostname=ecom-db.ecom.svc.cluster.local
debezium.source.database.user=${ECOM_DB_USER}       # injected from Secret
debezium.source.database.password=${ECOM_DB_PASSWORD}

# Offset storage (where to track WAL position)
debezium.source.offset.storage=org.apache.kafka.connect.storage.FileOffsetBackingStore
debezium.source.offset.storage.file.filename=/debezium/data/offsets.dat

# Kafka sink
debezium.sink.type=kafka
debezium.sink.kafka.producer.bootstrap.servers=kafka.infra.svc.cluster.local:9092
debezium.sink.kafka.producer.key.serializer=org.apache.kafka.common.serialization.StringSerializer
debezium.sink.kafka.producer.value.serializer=org.apache.kafka.common.serialization.StringSerializer

# JSON format (no schema registry)
debezium.format.value=json
debezium.format.key=json
debezium.format.value.schemas.enable=false
debezium.format.key.schemas.enable=false

# Quarkus HTTP port (health API)
quarkus.http.port=8080
```

### 4.3 Offset Storage: File vs. Kafka

**FileOffsetBackingStore** stores the last-read WAL position in a file on disk. The file is at `/debezium/data/offsets.dat`, mounted on an emptyDir volume.

**Trade-off:** If the pod is deleted and recreated (e.g. rolling restart), the emptyDir is gone and the offset file is lost. Debezium Server then re-runs the initial snapshot from the beginning, re-publishing all existing rows. Flink's JDBC sink uses `INSERT ... ON CONFLICT DO UPDATE` (upsert), so duplicate rows are handled correctly — the analytics DB converges to the correct final state.

**Why not KafkaOffsetBackingStore?** This was the first approach attempted. It failed with a configuration error (see [Bug 3](#7-bug-3--kafkaoffsetbackingstore-configuration)). The `FileOffsetBackingStore` is what the official Debezium Server documentation and the bundled example config use, so it was adopted as the stable choice.

### 4.4 Health API

Debezium Server is built on Quarkus, which exposes a standard health API:

| Endpoint | Meaning |
|---|---|
| `GET /q/health` | Combined liveness + readiness |
| `GET /q/health/live` | Is the process alive? |
| `GET /q/health/ready` | Is the connector connected and streaming? |

Response format:
```json
{
  "status": "UP",
  "checks": [
    { "name": "debezium", "status": "UP" }
  ]
}
```

This replaces the old Kafka Connect status endpoint:
```
# Old: GET /connectors/ecom-connector/status
# New: GET /q/health
```

### 4.5 NodePort Services

Two NodePort services expose the health APIs to the host:

| Service | NodePort | Host URL |
|---|---|---|
| `debezium-server-ecom-nodeport` | 32300 | `http://localhost:32300/q/health` |
| `debezium-server-inventory-nodeport` | 32301 | `http://localhost:32301/q/health` |

Port 32300 was already in use (old Debezium REST API) — it was reassigned to the ecom server. Port 32301 is new and required adding an `extraPortMappings` entry to `infra/kind/cluster.yaml`, which means a fresh cluster rebuild (`up.sh --fresh`) is required when first deploying this change.

### 4.6 Istio PeerAuthentication

Istio Ambient's ztunnel intercepts all traffic including NodePort connections from the host. For health-check traffic (plain HTTP from `curl localhost:32300`) to reach the pods, the port must be set to PERMISSIVE mTLS mode.

**Old config (port 8083, single pod):**
```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: debezium-nodeport-permissive
  namespace: infra
spec:
  selector:
    matchLabels:
      app: debezium
  mtls:
    mode: STRICT
  portLevelMtls:
    "8083":
      mode: PERMISSIVE
```

**New config (port 8080, two pods with separate selectors):**
```yaml
---
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: debezium-ecom-nodeport-permissive
  namespace: infra
spec:
  selector:
    matchLabels:
      app: debezium-server-ecom
  mtls:
    mode: STRICT
  portLevelMtls:
    "8080":
      mode: PERMISSIVE
---
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: debezium-inventory-nodeport-permissive
  namespace: infra
spec:
  selector:
    matchLabels:
      app: debezium-server-inventory
  mtls:
    mode: STRICT
  portLevelMtls:
    "8080":
      mode: PERMISSIVE
```

**Important:** The `selector` field is mandatory. Namespace-wide `portLevelMtls` is not supported by Istio Ambient — it requires a pod selector.

### 4.7 Credential Management

Kubernetes Secrets are namespace-scoped. The source database secrets (`ecom-db-secret`, `inventory-db-secret`) live in the `ecom` and `inventory` namespaces respectively. Debezium Server pods run in the `infra` namespace and cannot reference secrets from other namespaces.

**Solution:** `infra-up.sh` and `up.sh` read the credentials from the source-namespace secrets, then create a combined `debezium-db-credentials` secret in the `infra` namespace:

```bash
ECOM_USER=$(kubectl get secret -n ecom ecom-db-secret \
  -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
ECOM_PASS=$(kubectl get secret -n ecom ecom-db-secret \
  -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)
INV_USER=$(kubectl get secret -n inventory inventory-db-secret \
  -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
INV_PASS=$(kubectl get secret -n inventory inventory-db-secret \
  -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)

kubectl create secret generic debezium-db-credentials -n infra \
  --from-literal=ECOM_DB_USER="$ECOM_USER" \
  --from-literal=ECOM_DB_PASSWORD="$ECOM_PASS" \
  --from-literal=INVENTORY_DB_USER="$INV_USER" \
  --from-literal=INVENTORY_DB_PASSWORD="$INV_PASS" \
  --dry-run=client -o yaml | kubectl apply -f -
```

The Deployment then references this combined secret:
```yaml
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
```

---

## 5. Bug 1 — Cross-Namespace Secret Reference

### Symptom

Both Debezium Server pods entered `CreateContainerConfigError` state immediately after deployment:

```bash
kubectl get pods -n infra
# NAME                                   READY   STATUS                       RESTARTS
# debezium-server-ecom-xxx               0/1     CreateContainerConfigError   0
# debezium-server-inventory-xxx          0/1     CreateContainerConfigError   0

kubectl describe pod -n infra debezium-server-ecom-xxx
# Events:
#   Warning  Failed  ...  Error: secret "ecom-db-secret" not found
```

### Root Cause

The initial Deployment manifests used a `secretKeyRef` pointing directly to the source-namespace secrets:

```yaml
# WRONG — this secret is in 'ecom' namespace, pod is in 'infra' namespace
env:
  - name: ECOM_DB_USER
    valueFrom:
      secretKeyRef:
        name: ecom-db-secret    # ← does not exist in 'infra' namespace
        key: POSTGRES_USER
```

Kubernetes Secrets are strictly namespace-scoped. A pod in `infra` cannot read a Secret from `ecom`. The lookup fails silently at scheduling, and the pod never starts.

### Fix

1. Create a combined secret in the `infra` namespace (see [Section 4.7](#47-credential-management))
2. Update both Deployment manifests to reference `debezium-db-credentials` from `infra`:

```yaml
# CORRECT
env:
  - name: ECOM_DB_USER
    valueFrom:
      secretKeyRef:
        name: debezium-db-credentials    # exists in 'infra'
        key: ECOM_DB_USER
```

3. Add the secret creation step to both `scripts/infra-up.sh` and `scripts/up.sh`

---

## 6. Bug 2 — Wrong Config Mount Path

### Symptom

After fixing Bug 1, pods started but immediately crashed with a fatal startup error. Checking logs:

```bash
kubectl logs -n infra deploy/debezium-server-ecom | grep -i "error\|config\|mandatory"
# ERROR  Failed to load mandatory config value 'debezium.sink.type'
```

The server started but could not read any configuration — as if the properties file was empty or missing.

### Diagnosis

The ConfigMap was mounted but the server wasn't reading it. To find the correct path, a debug pod was run using the Debezium Server image:

```bash
kubectl run dbz-debug --image=quay.io/debezium/server:3.4.1.Final \
  --restart=Never -n infra -- sleep 3600

kubectl exec -n infra dbz-debug -- find /debezium -name "*.properties*" -o -name "*.example"
# /debezium/config/application.properties.example
# /debezium/conf/  (empty directory)
```

Reading the example file confirmed the correct config path:

```bash
kubectl exec -n infra dbz-debug -- head -5 /debezium/config/application.properties.example
# # Debezium Server configuration example
# debezium.source.connector.class=...
```

### Root Cause

The ConfigMap was mounted at `/debezium/conf/application.properties` — but Debezium Server reads from `/debezium/config/application.properties`. The directory names differ: `conf` vs. `config`.

This is not documented prominently. The correct path was discovered by inspecting the container image itself.

### Fix

Updated the `volumeMounts` section in both Deployment manifests:

```yaml
# WRONG
volumeMounts:
  - name: config
    mountPath: /debezium/conf/application.properties   # ← wrong directory
    subPath: application.properties

# CORRECT
volumeMounts:
  - name: config
    mountPath: /debezium/config/application.properties  # ← correct
    subPath: application.properties
```

Note: Using `subPath` is required when mounting a single file from a ConfigMap into a directory that already exists in the container image. Without `subPath`, the entire directory would be replaced by the ConfigMap, hiding other files.

---

## 7. Bug 3 — KafkaOffsetBackingStore Configuration

### Symptom

After fixing Bug 2, the pods started but crashed during initialization:

```bash
kubectl logs -n infra deploy/debezium-server-ecom | grep -i "offset\|backing\|bootstrap"
# ERROR  Cannot initialize Kafka offset storage,
#        mandatory configuration option 'bootstrap.servers' is missing.
```

### Context

The initial design used `KafkaOffsetBackingStore`, which stores WAL offsets as messages in a Kafka topic (`debezium.ecom.offsets`). This provides durable offset storage that survives pod restarts (unlike a file on an emptyDir volume).

The configuration attempted was:

```properties
# Attempt 1 (wrong key name)
debezium.source.offset.storage=org.apache.kafka.connect.storage.KafkaOffsetBackingStore
debezium.source.offset.storage.kafka.bootstrap.servers=kafka.infra.svc.cluster.local:9092

# Attempt 2 (still wrong)
debezium.source.offset.storage=org.apache.kafka.connect.storage.KafkaOffsetBackingStore
debezium.source.offset.storage.bootstrap.servers=kafka.infra.svc.cluster.local:9092
```

### Root Cause

`KafkaOffsetBackingStore` inherits directly from the Kafka Connect internal SPI. Its configuration keys follow the Kafka Connect internal convention — which is not prefixed by `debezium.source.offset.storage.` in the same way Debezium Server properties are. The exact property resolution path differs between Kafka Connect (where this class was designed) and Debezium Server (which wraps it).

The correct key in Debezium Server context is undocumented at the property-prefix level, and two attempts with different key names both failed.

### Fix

Switched to `FileOffsetBackingStore`, which is the approach shown in the official Debezium Server example config file and has a simpler, well-documented configuration:

```properties
# CORRECT — FileOffsetBackingStore
debezium.source.offset.storage=org.apache.kafka.connect.storage.FileOffsetBackingStore
debezium.source.offset.storage.file.filename=/debezium/data/offsets.dat
debezium.source.offset.flush.interval.ms=5000
```

And added a `data` emptyDir volume to give the file a writable location:

```yaml
volumeMounts:
  - name: data
    mountPath: /debezium/data
volumes:
  - name: data
    emptyDir: {}
```

**Trade-off documented:** The offsets file is on an emptyDir and lost on pod restart. On restart, Debezium re-runs the initial snapshot, re-publishing all rows. Flink's JDBC sink uses upsert (`INSERT ... ON CONFLICT DO UPDATE`) so re-published rows overwrite correctly and do not cause data corruption.

---

## 8. Bug 4 — ByteArraySerializer Incompatible with JSON Format

### Symptom

After fixing Bug 3, both pods started and began the initial snapshot. Shortly after, the following error appeared in logs:

```
ERROR  Can't convert key of class java.lang.String to class
       org.apache.kafka.common.serialization.ByteArraySerializer
       specified in key.serializer
```

The snapshot completed but no messages reached Kafka — they were being dropped at the serialization stage.

### Root Cause

The initial Kafka producer configuration used `ByteArraySerializer` for both key and value:

```properties
# WRONG
debezium.sink.kafka.producer.key.serializer=org.apache.kafka.common.serialization.ByteArraySerializer
debezium.sink.kafka.producer.value.serializer=org.apache.kafka.common.serialization.ByteArraySerializer
```

When `debezium.format.key=json` and `debezium.format.value=json` are set, Debezium Server formats events as JSON **strings** (type `java.lang.String`). The Kafka producer then tries to pass these strings to `ByteArraySerializer`, which only accepts `byte[]`. The type mismatch causes a `ClassCastException` and the message is dropped.

In Kafka Connect (old architecture), the Kafka producer is managed internally by the Connect framework, which handles serialization transparently. In Debezium Server, you configure the producer directly and must match the serializer type to the format output type.

### Fix

Changed both serializers to `StringSerializer`:

```properties
# CORRECT — JSON format produces String, StringSerializer accepts String
debezium.sink.kafka.producer.key.serializer=org.apache.kafka.common.serialization.StringSerializer
debezium.sink.kafka.producer.value.serializer=org.apache.kafka.common.serialization.StringSerializer
```

**Rule:** Match the serializer to the format output type:
- `debezium.format.value=json` → `StringSerializer`
- `debezium.format.value=avro` → `ByteArraySerializer` (Avro produces bytes)
- `debezium.format.value=protobuf` → `ByteArraySerializer`

---

## 9. All File Changes Summary

### New Files

| File | Description |
|------|-------------|
| `infra/debezium/debezium-server-ecom.yaml` | ConfigMap + Deployment + ClusterIP + NodePort (32300) for ecom |
| `infra/debezium/debezium-server-inventory.yaml` | ConfigMap + Deployment + ClusterIP + NodePort (32301) for inventory |
| `plans/session-22-flink-debezium-server-upgrade.md` | Session plan file |

### Deleted Files

| File | Reason |
|------|--------|
| `infra/debezium/debezium.yaml` | Kafka Connect replaced by Debezium Server |
| `infra/debezium/connectors/ecom-connector.json` | Config now in ConfigMap |
| `infra/debezium/connectors/inventory-connector.json` | Config now in ConfigMap |

### Modified Files

| File | Change |
|------|--------|
| `analytics/flink/Dockerfile` | Updated kafka-clients 3.7.0→3.9.2, postgresql 42.7.4→42.7.10; Flink stays at 1.20 |
| `infra/debezium/register-connectors.sh` | Replaced REST registration logic with health-poll of `/q/health` |
| `infra/kind/cluster.yaml` | Added port 32301 to `extraPortMappings` |
| `infra/kafka/kafka-topics-init.yaml` | Added `debezium.ecom.offsets` and `debezium.inventory.offsets` topics |
| `infra/istio/security/peer-auth.yaml` | Replaced single port-8083 entry with two port-8080 entries |
| `scripts/infra-up.sh` | Creates `debezium-db-credentials` secret; deploys both server manifests |
| `scripts/up.sh` | Bootstrap + recovery functions updated for two-server model |
| `scripts/restart-after-docker.sh` | Restarts both server pods + polls `/q/health` instead of re-registering connectors |
| `scripts/smoke-test.sh` | Checks pod names and `/q/health` for both servers |
| `scripts/verify-cdc.sh` | Updated error message to reference `deploy/debezium-server-ecom` |
| `e2e/debezium-flink.spec.ts` | Suite 1 rewritten for Debezium Server health API; Suite 4 updated |
| `plans/implementation-plan.md` | Session 22 section added |
| `CLAUDE.md` | Versions, NodePort map, session state, CDC pattern updated |

### Detailed Diff: register-connectors.sh

**Before (Kafka Connect):**
```bash
#!/usr/bin/env bash
# Registers ecom-connector and inventory-connector via Kafka Connect REST API
DEBEZIUM_URL="${DEBEZIUM_URL:-http://localhost:32300}"

_put_connector() {
  local name=$1 config_file=$2
  # Extract .config from JSON wrapper (Debezium Server FileConfigProvider
  # doesn't expand ${file:...} at validation time — inject real creds)
  ECOM_USER=$(kubectl get secret -n ecom ecom-db-secret ...)
  curl -sf -X PUT "${DEBEZIUM_URL}/connectors/${name}/config" \
    -H "Content-Type: application/json" \
    -d "$config_json"
}

_wait_connector_running() {
  local name=$1
  for i in $(seq 1 60); do
    state=$(curl -sf "${DEBEZIUM_URL}/connectors/${name}/status" | ...)
    [[ "$state" == "RUNNING" ]] && return 0
    sleep 5
  done
}

_put_connector "ecom-connector" "infra/debezium/connectors/ecom-connector.json"
_put_connector "inventory-connector" "infra/debezium/connectors/inventory-connector.json"
_wait_connector_running "ecom-connector"
_wait_connector_running "inventory-connector"
```

**After (Debezium Server):**
```bash
#!/usr/bin/env bash
# Waits for both Debezium Server instances to report healthy via /q/health.
DEBEZIUM_ECM_URL="${DEBEZIUM_ECM_URL:-http://localhost:32300}"
DEBEZIUM_INV_URL="${DEBEZIUM_INV_URL:-http://localhost:32301}"

_wait_healthy() {
  local name=$1 url=$2
  while true; do
    status=$(curl -sf "${url}/q/health" \
      | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null \
      || echo "")
    [[ "$status" == "UP" ]] && { echo "[OK] ${name} is healthy"; return 0; }
    sleep 5
  done
}

_wait_healthy "debezium-server-ecom"      "$DEBEZIUM_ECM_URL"
_wait_healthy "debezium-server-inventory" "$DEBEZIUM_INV_URL"
```

### Detailed Diff: E2E Tests (Suite 1)

**Before (debezium-flink.spec.ts Suite 1 — Kafka Connect):**
```typescript
test.describe('Debezium REST API', () => {
  test('Debezium Connect is accessible', async ({ request }) => {
    const res = await request.get(`${DEBEZIUM_URL}/connectors`)
    expect(res.status()).toBe(200)
  })
  test('ecom-connector is RUNNING', async ({ request }) => {
    const res = await request.get(`${DEBEZIUM_URL}/connectors/ecom-connector/status`)
    const body = await res.json()
    expect(body.connector.state).toBe('RUNNING')
  })
  test('inventory-connector is RUNNING', async ({ request }) => {
    const res = await request.get(`${DEBEZIUM_URL}/connectors/inventory-connector/status`)
    const body = await res.json()
    expect(body.connector.state).toBe('RUNNING')
  })
  // ...
})
```

**After (Suite 1 — Debezium Server):**
```typescript
test.describe('Debezium Server Health API', () => {
  test('ecom server health endpoint is accessible', async ({ request }) => {
    const res = await request.get(`${DEBEZIUM_ECM_URL}/q/health`)
    expect(res.status()).toBe(200)
  })
  test('ecom server reports status UP', async ({ request }) => {
    const res = await request.get(`${DEBEZIUM_ECM_URL}/q/health`)
    const body = await res.json()
    expect(body.status).toBe('UP')
  })
  test('inventory server health endpoint is accessible', async ({ request }) => {
    const res = await request.get(`${DEBEZIUM_INV_URL}/q/health`)
    expect(res.status()).toBe(200)
  })
  test('inventory server reports status UP', async ({ request }) => {
    const res = await request.get(`${DEBEZIUM_INV_URL}/q/health`)
    const body = await res.json()
    expect(body.status).toBe('UP')
  })
  // readiness + liveness + NodePort service existence checks
})
```

---

## 10. Deployment Procedure

### 10.1 First-Time Deployment (Fresh Cluster Required)

Port 32301 is new. kind `extraPortMappings` are set at cluster creation and cannot be patched on a running cluster. A fresh rebuild is required:

```bash
# From repo root
bash scripts/up.sh --fresh
```

This will:
1. Delete the existing kind cluster
2. Create a new cluster with port 32301 in `extraPortMappings`
3. Build `bookstore/flink:latest` image
4. Apply all infra manifests (PostgreSQL, Redis, Kafka, Debezium Server, Flink, Superset)
5. Import Keycloak realm
6. Deploy all app services
7. Apply Istio security policies
8. Run smoke tests

### 10.2 Incremental Redeploy (Existing Cluster with Port 32301)

If the cluster already has port 32301 mapped (i.e. was created after this migration):

```bash
# Update Debezium Server only
kubectl apply -f infra/debezium/debezium-server-ecom.yaml
kubectl apply -f infra/debezium/debezium-server-inventory.yaml

# Update credentials if DB passwords changed
ECOM_USER=$(kubectl get secret -n ecom ecom-db-secret -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
ECOM_PASS=$(kubectl get secret -n ecom ecom-db-secret -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)
INV_USER=$(kubectl get secret -n inventory inventory-db-secret -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
INV_PASS=$(kubectl get secret -n inventory inventory-db-secret -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)
kubectl create secret generic debezium-db-credentials -n infra \
  --from-literal=ECOM_DB_USER="$ECOM_USER" \
  --from-literal=ECOM_DB_PASSWORD="$ECOM_PASS" \
  --from-literal=INVENTORY_DB_USER="$INV_USER" \
  --from-literal=INVENTORY_DB_PASSWORD="$INV_PASS" \
  --dry-run=client -o yaml | kubectl apply -f -

# Rebuild and reload Flink image (if Dockerfile changed)
docker build -t bookstore/flink:latest ./analytics/flink
kind load docker-image bookstore/flink:latest --name bookstore
kubectl rollout restart deployment/flink-jobmanager deployment/flink-taskmanager -n analytics
kubectl rollout status deployment/flink-jobmanager -n analytics --timeout=120s
kubectl rollout status deployment/flink-taskmanager -n analytics --timeout=120s
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=180s
```

### 10.3 After Docker Desktop Restart

Debezium Server auto-resumes. No re-registration is needed. The recovery process is:

```bash
bash scripts/restart-after-docker.sh
# OR
bash scripts/up.sh   # auto-detects degraded state
```

The script:
1. Restarts ztunnel (Istio Ambient mesh breaks after Docker restart)
2. Restarts all pods in dependency order
3. Restarts `debezium-server-ecom` and `debezium-server-inventory`
4. Polls `/q/health` on both servers until `UP`
5. Resubmits Flink SQL pipeline (jobs are lost when JobManager restarts)

Note: Because offsets are on an emptyDir (lost on pod restart), Debezium will re-snapshot on restart. This is benign — Flink upserts handle duplicates correctly.

---

## 11. Verification Checklist

### 11.1 Debezium Server Health

```bash
# Both should return {"status":"UP"}
curl -s http://localhost:32300/q/health | python3 -m json.tool
curl -s http://localhost:32301/q/health | python3 -m json.tool

# Readiness (connector connected and streaming)
curl -s http://localhost:32300/q/health/ready
curl -s http://localhost:32301/q/health/ready
```

### 11.2 Kafka Topics Populated

```bash
kubectl exec -n infra deploy/kafka -- kafka-topics \
  --bootstrap-server localhost:9092 --list | grep connector

# Expected:
# ecom-connector.public.books
# ecom-connector.public.order_items
# ecom-connector.public.orders
# inventory-connector.public.inventory

# Sample a message
kubectl exec -n infra deploy/kafka -- kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic ecom-connector.public.orders \
  --from-beginning --max-messages 1 --timeout-ms 5000
```

### 11.3 Flink Jobs

```bash
# All 4 jobs should be RUNNING
curl -s http://localhost:32200/jobs | python3 -c "
import sys, json
jobs = json.load(sys.stdin)['jobs']
for j in jobs:
    print(j['status'], j['id'][:8])
print('Total:', len(jobs))
"
```

### 11.4 CDC End-to-End

```bash
bash scripts/verify-cdc.sh
# Expected: ✔ CDC verified: order appeared in analytics-db within Xs.
```

### 11.5 E2E Tests

```bash
cd e2e && npm run test
# Expected: 130/130 tests passing
```

---

## 12. Known Limitations and Future Work

### 12.1 Flink 2.x Upgrade Blocked

**Status:** Blocked on upstream.

`flink-connector-jdbc` does not have a Flink 2.x release. Track availability at:
```
https://repo1.maven.org/maven2/org/apache/flink/flink-connector-jdbc/
```

When a version with a `2.x` suffix (e.g. `4.0.0-2.0`) appears, the upgrade procedure is:
1. Update `analytics/flink/Dockerfile` base image to `flink:2.x.y-scala_2.12-java17`
2. Update `flink-connector-kafka` to `4.0.1-2.0` (already confirmed to exist)
3. Update `flink-connector-jdbc` to the new 2.x version
4. Build, load, rollout restart, resubmit SQL runner
5. Verify Flink SQL pipeline — the `SinkFunction` API removal may require SQL changes

### 12.2 Debezium Offset Durability

**Status:** Accepted trade-off for local kind cluster.

FileOffsetBackingStore offsets are on an emptyDir and lost on pod restart. For a production deployment, switch to `KafkaOffsetBackingStore` and investigate the correct property prefix for Debezium Server 3.4, or use a PersistentVolumeClaim for the data volume instead of emptyDir.

To switch to PVC-backed offset storage, change the `data` volume definition:
```yaml
# Current (emptyDir — ephemeral)
volumes:
  - name: data
    emptyDir: {}

# Production alternative (PVC — durable)
volumes:
  - name: data
    persistentVolumeClaim:
      claimName: debezium-ecom-data-pvc
```

### 12.3 Single Partition CDC Topics

The CDC topics are created with 1 partition. This is sufficient for a local dev cluster (one Debezium Server instance per topic). For production, increase partition count and ensure Debezium Server instances are scaled accordingly (one task per partition).

### 12.4 Snapshot Re-Run on Restart

Every pod restart triggers a full re-snapshot from PostgreSQL WAL beginning. For large tables this can be slow and creates temporary Kafka backpressure. For production, use `KafkaOffsetBackingStore` or PVC-backed `FileOffsetBackingStore` to persist offsets across restarts.
