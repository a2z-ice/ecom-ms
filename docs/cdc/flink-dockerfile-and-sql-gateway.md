# Flink Docker Image and SQL Gateway: Complete Walkthrough

## Quick Answer: Where is the Dockerfile?

The Dockerfile is **not** in `infra/flink/`. It lives in:

```
analytics/flink/Dockerfile        ← the Dockerfile
analytics/flink/sql/pipeline.sql  ← the SQL submitted at runtime
infra/flink/flink-cluster.yaml    ← Kubernetes Deployment that uses the image
infra/flink/flink-sql-runner.yaml ← Kubernetes Job that submits the SQL
infra/flink/flink-pvc.yaml        ← PersistentVolumeClaim for checkpoints
```

The separation is intentional:
- `analytics/flink/` — **build-time** concerns: what goes into the image
- `infra/flink/` — **runtime** concerns: how the image is deployed and operated

The image tag `bookstore/flink:latest` is built locally from `analytics/flink/Dockerfile`, loaded directly into the kind cluster with `kind load docker-image`, and referenced by three manifests in `infra/flink/` via `imagePullPolicy: Never` (never pull from a registry — always use the local image).

---

## Table of Contents

1. [The Complete Dockerfile — Annotated](#1-the-complete-dockerfile--annotated)
2. [What Is Inside the Base Flink Image?](#2-what-is-inside-the-base-flink-image)
3. [Why Each Connector JAR Is Needed](#3-why-each-connector-jar-is-needed)
4. [How the Image Is Built and Loaded](#4-how-the-image-is-built-and-loaded)
5. [What Uses the Image (Three Places)](#5-what-uses-the-image-three-places)
6. [What Is the SQL Gateway?](#6-what-is-the-sql-gateway)
7. [SQL Gateway: Complete Step-by-Step Startup](#7-sql-gateway-complete-step-by-step-startup)
8. [SQL Gateway: How SQL Submission Works](#8-sql-gateway-how-sql-submission-works)
9. [SQL Gateway: Internal Request Flow](#9-sql-gateway-internal-request-flow)
10. [SQL Gateway REST API Reference](#10-sql-gateway-rest-api-reference)
11. [The flink-sql-runner Job: Complete Walkthrough](#11-the-flink-sql-runner-job-complete-walkthrough)
12. [Full Startup Sequence: Boot to Running Jobs](#12-full-startup-sequence-boot-to-running-jobs)
13. [Rebuilding the Image](#13-rebuilding-the-image)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. The Complete Dockerfile — Annotated

**File**: `analytics/flink/Dockerfile`

```dockerfile
# ─────────────────────────────────────────────────────────────────
# Stage 1: Downloader
# Uses Alpine Linux (tiny — ~5MB) as a scratch environment.
# Its only job is to download 4 connector JARs from Maven Central.
# This stage is discarded after the build — its files are never in
# the final image except what is explicitly COPY'd.
#
# Why Alpine? It is multi-arch (amd64 + arm64), so the same
# Dockerfile builds correctly on both Intel Macs and Apple Silicon.
# ─────────────────────────────────────────────────────────────────
FROM alpine:3.19 AS downloader

# Install curl — the only tool needed to download JARs.
# --no-cache: do not store the apk package index → smaller layer.
RUN apk add --no-cache curl

# All downloaded JARs are placed here.
WORKDIR /jars

# ── JAR 1: Flink Kafka Connector ──────────────────────────────────
# Provides the 'kafka' connector for Flink SQL TABLE definitions.
# Version 3.4.0-1.20 means: connector 3.4.0 built for Flink 1.20.
# This JAR contains:
#   - KafkaSource (polls Kafka, tracks offsets in Flink checkpoints)
#   - KafkaSink (writes to Kafka — not used here but bundled)
#   - JSON/Avro/CSV format support
#   - Partition discovery (AdminClient-based, runs every N ms)
RUN curl -fsSL -o flink-connector-kafka-3.4.0-1.20.jar \
  "https://repo1.maven.org/maven2/org/apache/flink/flink-connector-kafka/3.4.0-1.20/flink-connector-kafka-3.4.0-1.20.jar"

# ── JAR 2: Flink JDBC Connector ───────────────────────────────────
# Provides the 'jdbc' connector for Flink SQL TABLE definitions.
# Version 3.3.0-1.20 means: connector 3.3.0 built for Flink 1.20.
# This JAR contains:
#   - JdbcDynamicTableSink (writes rows via JDBC PreparedStatement)
#   - Upsert mode (INSERT ... ON CONFLICT DO UPDATE) when PRIMARY KEY
#     is declared in the CREATE TABLE
#   - Buffer flushing logic (flush after N rows or after T interval)
# NOTE: No Flink 2.x release exists for this connector yet (as of 2026-03).
# The connector internally uses SinkFunction API removed in Flink 2.0.
RUN curl -fsSL -o flink-connector-jdbc-3.3.0-1.20.jar \
  "https://repo1.maven.org/maven2/org/apache/flink/flink-connector-jdbc/3.3.0-1.20/flink-connector-jdbc-3.3.0-1.20.jar"

# ── JAR 3: PostgreSQL JDBC Driver ─────────────────────────────────
# The JDBC connector above is database-agnostic — it works with any
# JDBC-compatible database. This driver is the PostgreSQL-specific
# implementation that translates JDBC calls into the PostgreSQL wire
# protocol (libpq-compatible TCP connection).
# Without this JAR, the JDBC connector cannot connect to PostgreSQL.
# Version 42.7.10 is the latest stable as of March 2026.
RUN curl -fsSL -o postgresql-42.7.10.jar \
  "https://repo1.maven.org/maven2/org/postgresql/postgresql/42.7.10/postgresql-42.7.10.jar"

# ── JAR 4: Kafka Clients ──────────────────────────────────────────
# The Flink Kafka connector JAR (JAR 1) does not bundle the Kafka
# client library — it declares it as an 'optional' dependency to
# avoid version conflicts. At runtime, the Kafka client must be on
# the classpath separately.
# kafka-clients-3.9.2.jar provides:
#   - KafkaConsumer (polls broker for records)
#   - KafkaProducer (not used by source connector)
#   - AdminClient (used for partition discovery)
RUN curl -fsSL -o kafka-clients-3.9.2.jar \
  "https://repo1.maven.org/maven2/org/apache/kafka/kafka-clients/3.9.2/kafka-clients-3.9.2.jar"

# ─────────────────────────────────────────────────────────────────
# Stage 2: Final image
# Starts from the official Apache Flink 1.20 image.
# This image already contains:
#   - JDK 17 (Java runtime)
#   - Flink core JARs (/opt/flink/lib/flink-dist-*.jar)
#   - Flink Table/SQL runtime JARs
#   - All Flink CLI tools (bin/flink, bin/sql-client.sh,
#     bin/sql-gateway.sh, /docker-entrypoint.sh)
#   - Non-root user 'flink' (UID 9999) pre-configured
#
# Why scala_2.12? Flink's Scala API was built against Scala 2.12.
# The SQL-only pipeline does not use Scala directly, but the base
# Flink distribution still needs a consistent Scala version.
#
# Why java17? Required by Flink 1.20. Java 11 support was dropped.
# ─────────────────────────────────────────────────────────────────
FROM flink:1.20-scala_2.12-java17

# Copy all 4 JARs from the downloader stage into Flink's automatic
# classpath directory. Flink scans /opt/flink/lib/ at startup and
# loads every JAR it finds — no configuration required.
# The base image already owns this directory as user flink (UID 9999).
COPY --from=downloader /jars/*.jar /opt/flink/lib/

# No CMD or ENTRYPOINT is set here because the base flink image
# already provides /docker-entrypoint.sh which accepts arguments:
#   jobmanager   → starts the JobManager process
#   taskmanager  → starts the TaskManager process
# These arguments are supplied by the Kubernetes Deployment's
# 'args' field. The SQL Gateway is started by a separate shell
# script in the sidecar container spec (not via entrypoint).
```

### What the Build Produces

```
Layer 1: flink:1.20-scala_2.12-java17 base (pulled from Docker Hub)
  /opt/flink/
  ├── bin/
  │   ├── flink                 ← CLI: submit/cancel/list jobs
  │   ├── sql-client.sh         ← Submit SQL interactively or from file
  │   ├── sql-gateway.sh        ← Start the SQL Gateway server
  │   └── taskmanager.sh        ← (internal, called by entrypoint)
  ├── lib/
  │   ├── flink-dist-1.20.0.jar ← Flink core runtime
  │   ├── flink-table-*.jar     ← Table API and SQL runtime
  │   └── ... (30+ Flink JARs)
  └── conf/
      └── flink-conf.yaml       ← Default config (overridden by FLINK_PROPERTIES env var)

Layer 2: COPY --from=downloader /jars/*.jar /opt/flink/lib/   (added by our Dockerfile)
  /opt/flink/lib/
  ├── flink-connector-kafka-3.4.0-1.20.jar   ← new: Kafka source/sink connector
  ├── flink-connector-jdbc-3.3.0-1.20.jar    ← new: JDBC sink connector
  ├── postgresql-42.7.10.jar                  ← new: PostgreSQL driver
  └── kafka-clients-3.9.2.jar                ← new: Kafka protocol library
```

The final image size is approximately **900MB** (JDK 17 + Flink core + 4 connector JARs).

---

## 2. What Is Inside the Base Flink Image?

The `flink:1.20-scala_2.12-java17` image is the official Apache Flink image. Understanding what it provides explains why the Dockerfile is so short — most of the work is already done.

### `/docker-entrypoint.sh` — The process launcher

When a container starts, this script reads the first argument:

```bash
# Simplified logic from /docker-entrypoint.sh
case "$1" in
  jobmanager)
    exec "$FLINK_HOME/bin/jobmanager.sh" start-foreground
    ;;
  taskmanager)
    exec "$FLINK_HOME/bin/taskmanager.sh" start-foreground
    ;;
  *)
    exec "$@"
    ;;
esac
```

In the Kubernetes Deployment:
```yaml
# JobManager container
command: ["/docker-entrypoint.sh"]
args: ["jobmanager"]

# TaskManager container
command: ["/docker-entrypoint.sh"]
args: ["taskmanager"]
```

The SQL Gateway sidecar does **not** use `/docker-entrypoint.sh` — it runs `bin/sql-gateway.sh` directly via a shell script (explained in Section 7).

### `bin/sql-client.sh` — The SQL submission tool

Used by the `flink-sql-runner` Kubernetes Job to submit `pipeline.sql` to the cluster. In gateway mode, it acts as a thin client — it sends SQL text to the SQL Gateway HTTP API and prints the results.

### `bin/sql-gateway.sh` — The SQL Gateway server

A separate long-running HTTP server that accepts SQL statements via REST and executes them against the connected Flink cluster. Used as a sidecar in the JobManager pod.

### `FLINK_PROPERTIES` environment variable

The base image's entrypoint reads this env var and writes its contents to `$FLINK_HOME/conf/flink-conf.yaml` before starting the Flink process. This allows the Kubernetes Deployment to inject configuration without mounting a ConfigMap.

```yaml
env:
  - name: FLINK_PROPERTIES
    value: |
      jobmanager.rpc.address: flink-jobmanager
      parallelism.default: 1
      state.backend.type: hashmap
      # ... other config keys
```

---

## 3. Why Each Connector JAR Is Needed

This table explains the dependency chain that makes the SQL pipeline work:

| JAR | Used By | Without It |
|-----|---------|-----------|
| `flink-connector-kafka-3.4.0-1.20.jar` | SQL `CREATE TABLE ... WITH ('connector'='kafka')` | `ClassNotFoundException: KafkaConnectorFactory` on job submission |
| `kafka-clients-3.9.2.jar` | `flink-connector-kafka` at runtime | `NoClassDefFoundError: org.apache.kafka.clients.consumer.KafkaConsumer` when the Kafka source operator initialises |
| `flink-connector-jdbc-3.3.0-1.20.jar` | SQL `CREATE TABLE ... WITH ('connector'='jdbc')` | `ClassNotFoundException: JdbcDynamicTableFactory` on job submission |
| `postgresql-42.7.10.jar` | `flink-connector-jdbc` at runtime when connecting to PostgreSQL | `java.sql.SQLException: No suitable driver found for jdbc:postgresql://...` |

All four JARs must be in `/opt/flink/lib/` on **both the JobManager and TaskManager** pods. The JobManager needs them to validate and compile the SQL. The TaskManager needs them to run the operators. Both pods use the same `bookstore/flink:latest` image, so the JARs are automatically present in both.

---

## 4. How the Image Is Built and Loaded

The image is **never pushed to a container registry**. Instead it is built locally and loaded directly into the kind cluster's internal image store. This avoids the need for a registry in local development.

### Build Command

```bash
docker build -t bookstore/flink:latest analytics/flink/
```

What happens:
1. Docker reads `analytics/flink/Dockerfile`
2. Starts Stage 1: pulls `alpine:3.19`, installs curl, downloads 4 JARs
3. Starts Stage 2: pulls `flink:1.20-scala_2.12-java17`, copies JARs from Stage 1
4. Tags the result as `bookstore/flink:latest`
5. Stage 1 (the downloader layer) is discarded from the final image

### Load into Kind

```bash
kind load docker-image bookstore/flink:latest --name bookstore
```

What happens:
- kind calls `docker save bookstore/flink:latest | ...` to export the image as a tar archive
- It loads the archive into the containerd image store on each kind node
- After this, any pod in the cluster can use the image without network access to a registry

### Why `imagePullPolicy: Never`

```yaml
# In flink-cluster.yaml — all three image references
imagePullPolicy: Never
```

With `imagePullPolicy: Never`, Kubernetes never tries to pull the image from the internet. It uses only what is already in the local containerd store (loaded by `kind load`). Without this, Kubernetes would try to pull `bookstore/flink:latest` from Docker Hub, fail (the image does not exist there), and the pod would stay in `ImagePullBackOff`.

### Where in `scripts/up.sh`

```bash
# Build runs in background (parallel with other builds)
docker build -t bookstore/flink:latest "${REPO_ROOT}/analytics/flink" \
  >/tmp/build-flink.log 2>&1 &
_FLINK_PID=$!

# Later: wait for build to finish
_wait_build "bookstore/flink:latest" "$_FLINK_PID" "/tmp/build-flink.log"

# Then load into kind (serialized — kind cannot handle concurrent loads)
kind load docker-image bookstore/flink:latest --name bookstore
```

---

## 5. What Uses the Image (Three Places)

The same `bookstore/flink:latest` image is used by three different Kubernetes resources, each running a different process from the same image:

```
bookstore/flink:latest
       │
       ├── Deployment: flink-jobmanager (container: jobmanager)
       │     command: /docker-entrypoint.sh jobmanager
       │     → starts org.apache.flink.runtime.entrypoint.StandaloneSessionClusterEntrypoint
       │     → exposes REST API :8081, RPC :6123, blob :6124
       │
       ├── Deployment: flink-jobmanager (container: sql-gateway)  [sidecar]
       │     command: /bin/bash -c "wait for JM ... ; bin/sql-gateway.sh start-foreground ..."
       │     → starts org.apache.flink.table.gateway.SqlGateway
       │     → exposes REST API :9091
       │
       ├── Deployment: flink-taskmanager (container: taskmanager)
       │     command: /docker-entrypoint.sh taskmanager
       │     → starts org.apache.flink.runtime.taskexecutor.TaskManagerRunner
       │     → connects to JobManager RPC :6123, registers 4 task slots
       │
       └── Job: flink-sql-runner (container: sql-runner)
             command: /bin/bash -c "envsubst ... ; bin/sql-client.sh gateway ..."
             → runs sql-client.sh as a one-shot CLI tool
             → sends SQL to SQL Gateway :9091, exits 0 when done
```

The image is built once and serves four distinct roles purely through the command/args/entrypoint override in Kubernetes.

---

## 6. What Is the SQL Gateway?

The **SQL Gateway** is a long-running HTTP server included in Flink 1.20+ (`bin/sql-gateway.sh`). It provides a REST API for submitting Flink SQL statements to a running cluster remotely — without needing direct access to the cluster's filesystem or RPC port.

### Why Is the SQL Gateway Needed?

Before SQL Gateway, submitting SQL to a Flink cluster required either:
1. Running `bin/sql-client.sh` interactively inside the JobManager pod — fragile, hard to automate
2. Using the Flink REST API directly — requires compiling SQL to a JAR and uploading it
3. Embedding SQL in application code — requires a Java/Scala service

SQL Gateway enables a third option: **send SQL text over HTTP from anywhere**. A lightweight Kubernetes Job (`flink-sql-runner`) can:
1. Mount the SQL file from a ConfigMap
2. Call `bin/sql-client.sh gateway -e http://... -f pipeline.sql`
3. Exit cleanly when done

The cluster keeps running the submitted streaming jobs indefinitely — the sql-runner Job just triggers them and exits.

### Where It Runs

The SQL Gateway runs as a **sidecar container** inside the `flink-jobmanager` pod:

```
Pod: flink-jobmanager
├── Container: jobmanager      (port 8081 — Flink REST API + Web Dashboard)
└── Container: sql-gateway     (port 9091 — SQL Gateway REST API)
```

Both containers share the same pod network namespace, so the SQL Gateway can reach the JobManager at `localhost:8081` via loopback — no Kubernetes Service hop needed.

---

## 7. SQL Gateway: Complete Step-by-Step Startup

### Step 1 — Pod Scheduled, JobManager Container Starts

Kubernetes schedules the `flink-jobmanager` pod onto a node. Both containers start simultaneously. The JobManager container runs:

```bash
/docker-entrypoint.sh jobmanager
```

This launches the Flink JobManager JVM process. It takes 15–30 seconds to fully initialise — loading JARs, starting the RPC server, and opening the REST endpoint at port 8081.

### Step 2 — SQL Gateway Container Starts (Simultaneously)

The `sql-gateway` sidecar container also starts at the same time, but it does not immediately run `sql-gateway.sh`. Instead, it runs a shell script that **waits** for the JobManager's REST API to become available:

```bash
# From flink-cluster.yaml, sql-gateway container command:
/bin/bash -c |
  echo "Waiting for JobManager REST API..."
  until curl -sf http://localhost:8081/overview > /dev/null 2>&1; do
    sleep 3
  done
  echo "JobManager ready. Starting SQL Gateway on port 9091..."
  bin/sql-gateway.sh start-foreground \
    -Dsql-gateway.endpoint.rest.address=0.0.0.0 \
    -Dsql-gateway.endpoint.rest.port=9091 \
    -Drest.address=localhost \
    -Drest.port=8081 \
    -Dexecution.target=remote \
    -Dparallelism.default=1
```

The `until curl -sf http://localhost:8081/overview` loop:
- Polls the JobManager REST `/overview` endpoint every 3 seconds
- `localhost:8081` works because both containers share the pod's network namespace
- Proceeds only when the JobManager responds with HTTP 200

**Why this ordering matters**: `sql-gateway.sh` immediately tries to connect to the Flink cluster when it starts. If the JobManager is not yet ready, the SQL Gateway fails to start. The wait loop prevents this race condition.

### Step 3 — SQL Gateway Starts

Once the JobManager is confirmed ready, `sql-gateway.sh start-foreground` launches the SQL Gateway process with these flags:

| Flag | Value | Meaning |
|------|-------|---------|
| `-Dsql-gateway.endpoint.rest.address` | `0.0.0.0` | Listen on all interfaces (so the Kubernetes Service can route to it) |
| `-Dsql-gateway.endpoint.rest.port` | `9091` | HTTP port for the SQL Gateway REST API |
| `-Drest.address` | `localhost` | Where to find the Flink JobManager REST API (loopback — same pod) |
| `-Drest.port` | `8081` | JobManager REST port |
| `-Dexecution.target` | `remote` | Submit jobs to a remote cluster (not embedded mode) |
| `-Dparallelism.default` | `1` | Default parallelism for submitted statements |

Additionally, the `FLINK_PROPERTIES` env var provides base config for the SQL Gateway container:

```yaml
env:
  - name: FLINK_PROPERTIES
    value: |
      jobmanager.rpc.address: flink-jobmanager  # how to reach JM via RPC
      rest.address: localhost                    # JM REST is on loopback
      rest.port: 8081
      execution.target: remote
      parallelism.default: 1
```

### Step 4 — SQL Gateway Initialises

The SQL Gateway process:
1. Opens HTTP listener on `0.0.0.0:9091`
2. Connects to the JobManager via RPC (port 6123) to register itself as a SQL client
3. Creates an internal session store (for managing multiple concurrent SQL sessions)
4. Exposes the REST API — `/v1/info`, `/v1/sessions`, `/v1/sessions/{id}/statements`

When `/v1/info` returns HTTP 200, the SQL Gateway is ready to accept SQL.

### Step 5 — Kubernetes Readiness and Services

The `flink-jobmanager` ClusterIP Service exposes port 9091:

```yaml
# From flink-cluster.yaml Service spec
ports:
  - name: sql-gateway
    port: 9091
    targetPort: 9091
```

This means any other pod in the cluster can reach the SQL Gateway at:
```
http://flink-jobmanager.analytics.svc.cluster.local:9091
```

The `flink-sql-runner` Job uses exactly this URL.

### Full Startup Timeline

```
T+0s    Pod scheduled. Both containers start in parallel.
T+0s    jobmanager: JVM starts, loading ~80MB of JARs
T+0s    sql-gateway: shell starts, begins polling localhost:8081/overview
T+3s    sql-gateway: polls → connection refused (JM not ready) → sleep 3
T+6s    sql-gateway: polls → connection refused → sleep 3
...
T+25s   jobmanager: REST API opens at :8081 ← JobManager ready
T+28s   sql-gateway: polls → HTTP 200 → exits loop
T+28s   sql-gateway: launches sql-gateway.sh start-foreground
T+33s   sql-gateway: HTTP listener opens at :9091
T+33s   sql-gateway: GET /v1/info → 200 OK ← SQL Gateway ready

T+33s   Kubernetes readiness probe on :8081/overview → passes
T+33s   Pod enters READY state (2/2 containers ready)
```

---

## 8. SQL Gateway: How SQL Submission Works

Once the SQL Gateway is running, the `flink-sql-runner` Kubernetes Job submits the pipeline SQL.

### The flink-sql-runner Job Structure

```yaml
# Two-stage execution: initContainer → main container

initContainer: wait-for-sql-gateway
  image: curlimages/curl:latest
  Polls: curl -sf http://flink-jobmanager.analytics.svc.cluster.local:9091/v1/info
  Retries every 5s until 200 OK
  Then exits 0 → main container starts

container: sql-runner
  image: bookstore/flink:latest
  Step 1: envsubst < /sql/pipeline.sql > /tmp/pipeline-resolved.sql
  Step 2: bin/sql-client.sh gateway \
            -e http://flink-jobmanager.analytics.svc.cluster.local:9091 \
            -f /tmp/pipeline-resolved.sql
  Exits 0 when all SQL statements submitted successfully
```

### Step 1 — Environment Variable Substitution

The `pipeline.sql` file uses placeholder syntax for database credentials:

```sql
-- In /sql/pipeline.sql (mounted from ConfigMap)
CREATE TABLE sink_fact_orders (
  ...
) WITH (
  'username' = '${ANALYTICS_DB_USER}',    ← placeholder
  'password' = '${ANALYTICS_DB_PASSWORD}' ← placeholder
  ...
);
```

Before submitting, `envsubst` replaces the placeholders with actual values from the container's environment:

```bash
envsubst < /sql/pipeline.sql > /tmp/pipeline-resolved.sql
```

The env vars `ANALYTICS_DB_USER` and `ANALYTICS_DB_PASSWORD` are injected by Kubernetes from the `analytics-db-secret` Secret:

```yaml
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
```

After substitution, `/tmp/pipeline-resolved.sql` contains the real credentials — ready for submission.

### Step 2 — sql-client.sh in Gateway Mode

```bash
bin/sql-client.sh gateway \
  -e http://flink-jobmanager.analytics.svc.cluster.local:9091 \
  -f /tmp/pipeline-resolved.sql
```

Flag breakdown:

| Flag | Value | Meaning |
|------|-------|---------|
| `gateway` | subcommand | Use SQL Gateway mode (not embedded local mode) |
| `-e` | `http://flink-jobmanager.analytics.svc.cluster.local:9091` | SQL Gateway endpoint URL |
| `-f` | `/tmp/pipeline-resolved.sql` | File containing SQL statements to execute |

`sql-client.sh` reads the file and sends each SQL statement sequentially to the SQL Gateway. It reads statements delimited by `;`.

The SQL file contains **12 statements** total:
- 4 × `CREATE TABLE kafka_*` (source tables)
- 4 × `CREATE TABLE sink_*` (sink tables)
- 4 × `INSERT INTO sink_* SELECT ... FROM kafka_*` (pipelines)

---

## 9. SQL Gateway: Internal Request Flow

When `sql-client.sh` sends SQL to the Gateway, here is what happens for each statement type:

### For `CREATE TABLE` Statements

```
sql-client.sh
    │
    │  POST /v1/sessions/{session-id}/statements
    │  Body: {"statement": "CREATE TABLE kafka_orders (after ROW<...>) WITH (...)"}
    │
    ▼
SQL Gateway (port 9091)
    │
    │  Parses SQL using Flink's SQL parser (Calcite-based)
    │  Validates connector options ('connector'='kafka' → loads KafkaConnectorFactory)
    │  Registers table in the session catalog (in-memory)
    │  Returns: {"operation": {"operationHandle": "abc123", "status": "FINISHED"}}
    │
    ▼
(no job submitted yet — CREATE TABLE only registers metadata)
```

### For `INSERT INTO` Statements

```
sql-client.sh
    │
    │  POST /v1/sessions/{session-id}/statements
    │  Body: {"statement": "INSERT INTO sink_fact_orders SELECT ... FROM kafka_orders WHERE ..."}
    │
    ▼
SQL Gateway (port 9091)
    │
    │  1. Parse SQL → abstract syntax tree (AST)
    │  2. Validate: check that kafka_orders and sink_fact_orders exist in catalog
    │  3. Optimise: apply Calcite rules (predicate pushdown, projection pruning)
    │  4. Translate to Flink DataStream plan (operator DAG)
    │  5. Serialise plan to JobGraph
    │  6. Submit JobGraph to JobManager via REST API:
    │        POST http://localhost:8081/v1/jobs
    │        Body: <serialised JobGraph>
    │
    ▼
JobManager (port 8081)
    │
    │  1. Receives JobGraph
    │  2. Assigns each operator a vertex with a parallelism
    │  3. Requests task slots from TaskManager (via RPC :6123)
    │
    ▼
TaskManager (port 6122)
    │
    │  1. Receives task deployment from JobManager
    │  2. Allocates task slot (1 of 4 available)
    │  3. Loads connector JARs from /opt/flink/lib/
    │  4. Instantiates operators:
    │       - KafkaSourceReader (starts polling)
    │       - CalcOperator (applies WHERE + SELECT)
    │       - JdbcSink (opens JDBC connection to analytics-db)
    │  5. Job enters RUNNING state
    │
    ▼
JobManager responds to SQL Gateway: {"jobId": "a1b2c3..."}
SQL Gateway responds to sql-client.sh: {"status": "FINISHED", "results": [...]}
sql-client.sh prints status and moves to next statement
```

### Four Separate Job Submissions

Because the SQL file has four `INSERT INTO` statements, the SQL Gateway makes **four separate job submissions** to the JobManager. Each produces one independent streaming job:

```
INSERT INTO sink_fact_orders ...        → Job ID: a1b2c3... → RUNNING on Slot 0
INSERT INTO sink_fact_order_items ...   → Job ID: d4e5f6... → RUNNING on Slot 1
INSERT INTO sink_dim_books ...          → Job ID: g7h8i9... → RUNNING on Slot 2
INSERT INTO sink_fact_inventory ...     → Job ID: j0k1l2... → RUNNING on Slot 3
```

After submitting all four, `sql-client.sh` exits. The jobs continue running indefinitely — they are now owned by the Flink cluster, not the sql-runner pod.

---

## 10. SQL Gateway REST API Reference

You can interact with the SQL Gateway directly. It listens internally at port 9091. From outside the cluster, access it via `kubectl exec`:

```bash
# Check SQL Gateway is running
kubectl exec -n analytics deploy/flink-jobmanager -c sql-gateway -- \
  curl -sf http://localhost:9091/v1/info | python3 -m json.tool
```

Expected response:
```json
{
  "productName": "Apache Flink",
  "version": "1.20.0"
}
```

### Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/info` | Version and cluster info — used as health check |
| `POST` | `/v1/sessions` | Create a new SQL session |
| `DELETE` | `/v1/sessions/{id}` | Close a session |
| `POST` | `/v1/sessions/{id}/statements` | Execute a SQL statement |
| `GET` | `/v1/sessions/{id}/operations/{op}/result/{token}` | Get statement result |

### Submit SQL Manually via the Gateway

```bash
# 1. Create a session
SESSION=$(kubectl exec -n analytics deploy/flink-jobmanager -c sql-gateway -- \
  curl -sf -X POST http://localhost:9091/v1/sessions \
    -H 'Content-Type: application/json' \
    -d '{}' | python3 -c "import sys,json; print(json.load(sys.stdin)['sessionHandle'])")

echo "Session: $SESSION"

# 2. Execute a SHOW JOBS statement
kubectl exec -n analytics deploy/flink-jobmanager -c sql-gateway -- \
  curl -sf -X POST "http://localhost:9091/v1/sessions/$SESSION/statements" \
    -H 'Content-Type: application/json' \
    -d '{"statement": "SHOW JOBS"}' | python3 -m json.tool

# 3. Close the session when done
kubectl exec -n analytics deploy/flink-jobmanager -c sql-gateway -- \
  curl -sf -X DELETE "http://localhost:9091/v1/sessions/$SESSION"
```

---

## 11. The flink-sql-runner Job: Complete Walkthrough

**File**: `infra/flink/flink-sql-runner.yaml`

This file contains two Kubernetes resources: a ConfigMap holding the SQL, and a Job that submits it.

### ConfigMap: flink-pipeline-sql

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: flink-pipeline-sql
  namespace: analytics
data:
  pipeline.sql: |
    -- Full SQL content (4 source tables + 4 sink tables + 4 INSERT INTO)
    -- This is the authoritative runtime copy of analytics/flink/sql/pipeline.sql
    -- Changes here take effect on next flink-sql-runner run — no Docker rebuild needed
    CREATE TABLE kafka_orders ( ... );
    CREATE TABLE kafka_order_items ( ... );
    ...
    INSERT INTO sink_fact_orders SELECT ... FROM kafka_orders WHERE ...;
    ...
```

The SQL lives in a ConfigMap so it can be updated without rebuilding the Docker image. After editing the ConfigMap, re-submit the runner Job and Flink picks up the new SQL.

**Important**: Keep `analytics/flink/sql/pipeline.sql` and the ConfigMap content in sync manually — they are intentionally duplicated so the SQL can be developed and version-controlled without a Kubernetes cluster.

### The Job

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: flink-sql-runner
  namespace: analytics
spec:
  backoffLimit: 0      # Never auto-retry on failure — investigate logs instead
  template:
    spec:
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 9999   # flink user from base image
        fsGroup: 9999

      # ── Phase 1: Wait for SQL Gateway ──────────────────────────
      initContainers:
        - name: wait-for-sql-gateway
          image: curlimages/curl:latest   # tiny curl-only image (~10MB)
          command:
            - sh
            - -c
            - |
              echo "Waiting for Flink SQL Gateway..."
              until curl -sf http://flink-jobmanager.analytics.svc.cluster.local:9091/v1/info; do
                echo "SQL Gateway not ready yet, retrying in 5s..."
                sleep 5
              done
              echo "SQL Gateway is ready."
          # Minimal resources — this container only runs curl in a loop
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits:   { cpu: 100m, memory: 128Mi }

      # ── Phase 2: Submit SQL ─────────────────────────────────────
      containers:
        - name: sql-runner
          image: bookstore/flink:latest
          imagePullPolicy: Never
          command:
            - /bin/bash
            - -c
            - |
              # Replace ${ANALYTICS_DB_USER} and ${ANALYTICS_DB_PASSWORD}
              # in the SQL file with actual values from environment
              envsubst < /sql/pipeline.sql > /tmp/pipeline-resolved.sql

              echo "Submitting SQL pipeline via SQL Gateway..."
              bin/sql-client.sh gateway \
                -e http://flink-jobmanager.analytics.svc.cluster.local:9091 \
                -f /tmp/pipeline-resolved.sql

              echo "SQL submission complete. Exit: $?"
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
              mountPath: /sql               # ConfigMap mounted here as pipeline.sql
            - name: tmp
              mountPath: /tmp               # writeable scratch space for resolved SQL
            - name: flink-log
              mountPath: /opt/flink/log     # Flink CLI writes logs here

      volumes:
        - name: pipeline-sql
          configMap:
            name: flink-pipeline-sql        # the ConfigMap defined above
        - name: tmp
          emptyDir: {}
        - name: flink-log
          emptyDir: {}
```

### Job Lifecycle

```
kubectl apply -f infra/flink/flink-sql-runner.yaml
        │
        ▼
Kubernetes creates Job "flink-sql-runner"
        │
        ▼
Job creates Pod "flink-sql-runner-xxxxx"
        │
        ├── initContainer: wait-for-sql-gateway
        │     Polls /v1/info every 5s
        │     Exits 0 when SQL Gateway responds
        │
        ▼  (initContainer exits 0)
        │
        └── container: sql-runner
              envsubst replaces ${...} placeholders
              bin/sql-client.sh sends all 12 SQL statements
              4 streaming jobs now RUNNING in the cluster
              Container exits 0
        │
        ▼
Pod phase: Succeeded
Job condition: Complete=True

(The 4 streaming Flink jobs continue running in the cluster
 even though this Job/Pod is finished)
```

### Why `backoffLimit: 0`?

If `sql-client.sh` fails (wrong SQL, Gateway not ready, DB credentials wrong), the error message in the logs is the most useful diagnostic tool. Auto-retrying would:
1. Potentially submit partial SQL (some tables created, some not)
2. Make it unclear which attempt caused the issue
3. Hide the real error by overwriting logs

With `backoffLimit: 0`, the Job fails immediately and the pod logs are preserved for inspection.

### Re-running the Job

Kubernetes Jobs are immutable — once Complete or Failed, they cannot be re-run in place. To resubmit:

```bash
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=180s
```

**Before resubmitting**, cancel the existing streaming jobs if you are changing the SQL schema, otherwise the old and new jobs will both run simultaneously:

```bash
# Cancel all running jobs
for job_id in $(curl -sf http://localhost:32200/jobs | \
  python3 -c "import sys,json; [print(j['id']) for j in json.load(sys.stdin)['jobs'] if j['status']=='RUNNING']"); do
  curl -X PATCH "http://localhost:32200/jobs/${job_id}?mode=cancel"
  echo "Cancelled $job_id"
done
```

---

## 12. Full Startup Sequence: Boot to Running Jobs

This is the complete end-to-end timeline from `kubectl apply` to all 4 streaming jobs running:

```
T+0s     kubectl apply -f infra/flink/flink-pvc.yaml
           → PVC flink-checkpoints-pvc created (2Gi, backed by host data/flink/)

T+1s     kubectl apply -f infra/flink/flink-cluster.yaml
           → Deployment flink-jobmanager created
           → Deployment flink-taskmanager created
           → Service flink-jobmanager (ClusterIP, ports: 6123/6124/8081/9091) created
           → Service flink-jobmanager-nodeport (NodePort 32200→8081) created

T+5s     Pod flink-jobmanager-xxxxx scheduled on a node
           Container "jobmanager" starts:
             /docker-entrypoint.sh jobmanager
             → Flink JVM starts, reads FLINK_PROPERTIES env var
             → Writes config to /opt/flink/conf/flink-conf.yaml
             → Starts ResourceManager (manages task slots)
             → Starts Dispatcher (accepts job submissions)
             → Opens RPC server on :6123
             → Opens blob server on :6124

           Container "sql-gateway" starts (simultaneously):
             /bin/bash -c "until curl localhost:8081/overview; do sleep 3; done ..."
             → Polling loop begins

T+5s     Pod flink-taskmanager-xxxxx scheduled on a node
           Container "taskmanager" starts:
             /docker-entrypoint.sh taskmanager
             → Flink JVM starts
             → Reads FLINK_PROPERTIES: jobmanager.rpc.address=flink-jobmanager
             → Connects to JobManager RPC at flink-jobmanager:6123
             → Registers 4 task slots

T+25s    JobManager REST API opens at :8081
           Readiness probe passes: GET /overview → 200 OK
           Pod readiness: jobmanager container = READY

T+28s    sql-gateway polling loop: curl localhost:8081/overview → 200 OK
           Loop exits, sql-gateway.sh starts:
             bin/sql-gateway.sh start-foreground
               -Dsql-gateway.endpoint.rest.address=0.0.0.0
               -Dsql-gateway.endpoint.rest.port=9091
               -Drest.address=localhost
               -Drest.port=8081
               -Dexecution.target=remote

T+33s    SQL Gateway HTTP listener opens at :9091
           GET /v1/info → {"productName":"Apache Flink","version":"1.20.0"}
           Pod readiness: sql-gateway container = READY
           flink-jobmanager pod: 2/2 READY

T+35s    scripts/up.sh detects pod ready, submits sql-runner Job:
           kubectl delete job flink-sql-runner -n analytics --ignore-not-found
           kubectl apply -f infra/flink/flink-sql-runner.yaml

T+36s    Pod flink-sql-runner-xxxxx scheduled
           initContainer "wait-for-sql-gateway" starts (curlimages/curl):
             until curl -sf http://flink-jobmanager.analytics.svc.cluster.local:9091/v1/info
             → 200 OK immediately (SQL Gateway already up)
             initContainer exits 0

T+38s    Container "sql-runner" starts (bookstore/flink:latest):
           Step 1: envsubst replaces ${ANALYTICS_DB_USER} and ${ANALYTICS_DB_PASSWORD}
           Step 2: bin/sql-client.sh gateway
                     -e http://flink-jobmanager.analytics.svc.cluster.local:9091
                     -f /tmp/pipeline-resolved.sql

           SQL Client opens a session with SQL Gateway
           Sends Statement 1:  CREATE TABLE kafka_orders (...)      → catalog registered
           Sends Statement 2:  CREATE TABLE kafka_order_items (...) → catalog registered
           Sends Statement 3:  CREATE TABLE kafka_books (...)       → catalog registered
           Sends Statement 4:  CREATE TABLE kafka_inventory (...)   → catalog registered
           Sends Statement 5:  CREATE TABLE sink_fact_orders (...)  → catalog registered
           Sends Statement 6:  CREATE TABLE sink_fact_order_items (.) → catalog registered
           Sends Statement 7:  CREATE TABLE sink_dim_books (...)    → catalog registered
           Sends Statement 8:  CREATE TABLE sink_fact_inventory (.) → catalog registered
           Sends Statement 9:  INSERT INTO sink_fact_orders ...     → Job submitted → Job ID: a1b2...
           Sends Statement 10: INSERT INTO sink_fact_order_items ... → Job submitted → Job ID: c3d4...
           Sends Statement 11: INSERT INTO sink_dim_books ...       → Job submitted → Job ID: e5f6...
           Sends Statement 12: INSERT INTO sink_fact_inventory ...  → Job submitted → Job ID: g7h8...

T+55s    All 4 streaming jobs submitted
           sql-client.sh exits 0
           sql-runner container exits 0
           flink-sql-runner Pod phase: Succeeded
           flink-sql-runner Job: Complete=True

T+55s    Four streaming jobs are RUNNING in the Flink cluster:
           Job a1b2...: KafkaSource[kafka_orders] → Calc → JdbcSink[fact_orders]
           Job c3d4...: KafkaSource[kafka_order_items] → Calc → JdbcSink[fact_order_items]
           Job e5f6...: KafkaSource[kafka_books] → Calc → JdbcSink[dim_books]
           Job g7h8...: KafkaSource[kafka_inventory] → Calc → JdbcSink[fact_inventory]

T+60s    All 4 KafkaSource operators begin polling Kafka topics
           Debezium snapshot events are read and upserted into analytics-db
           CDC pipeline: active and processing
```

---

## 13. Rebuilding the Image

### When to Rebuild

| Change | Need Rebuild? |
|--------|--------------|
| Edit `analytics/flink/sql/pipeline.sql` | **No** — SQL also lives in the ConfigMap. Edit the ConfigMap in `infra/flink/flink-sql-runner.yaml` and resubmit the Job. |
| Update connector JAR version (e.g., postgresql 42.7.10 → 42.7.11) | **Yes** — JAR is baked into the image. |
| Upgrade Flink base image (1.20 → future 1.21) | **Yes** — base image is in the Dockerfile FROM line. |
| Change Flink cluster configuration (parallelism, checkpoint interval) | **No** — config is in `FLINK_PROPERTIES` env var in `flink-cluster.yaml`. |
| Add a new Kafka topic / new pipeline | **No** — SQL change only; edit ConfigMap and resubmit Job. |

### Rebuild Commands

```bash
# 1. Rebuild the image
docker build -t bookstore/flink:latest analytics/flink/

# 2. Load into kind cluster (replaces the existing image)
kind load docker-image bookstore/flink:latest --name bookstore

# 3. Restart cluster pods to pick up the new image
kubectl rollout restart deployment/flink-jobmanager  -n analytics
kubectl rollout restart deployment/flink-taskmanager -n analytics

# 4. Wait for pods to be ready
kubectl rollout status deployment/flink-jobmanager  -n analytics --timeout=180s
kubectl rollout status deployment/flink-taskmanager -n analytics --timeout=180s

# 5. Wait for SQL Gateway
until kubectl exec -n analytics deploy/flink-jobmanager -c sql-gateway -- \
  curl -sf http://localhost:9091/v1/info > /dev/null 2>&1; do
  sleep 5; echo "Waiting for SQL Gateway..."
done

# 6. Resubmit streaming jobs (jobs are lost when JM pod restarts)
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply  -f infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=180s

# 7. Confirm 4 jobs RUNNING
curl -sf http://localhost:32200/jobs | python3 -c "
import sys, json
jobs = json.load(sys.stdin)['jobs']
running = [j for j in jobs if j['status'] == 'RUNNING']
print(f'{len(running)}/4 jobs running')
"
```

---

## 14. Troubleshooting

### Image Not Found (`ImagePullBackOff`)

```
Events: Failed to pull image "bookstore/flink:latest": ... not found
```

The image was not loaded into kind. Fix:
```bash
docker build -t bookstore/flink:latest analytics/flink/
kind load docker-image bookstore/flink:latest --name bookstore
kubectl rollout restart deployment/flink-jobmanager -n analytics
```

### SQL Gateway Never Becomes Ready

```bash
# Check sql-gateway container logs
kubectl logs -n analytics deploy/flink-jobmanager -c sql-gateway
```

If you see repeated:
```
Waiting for JobManager REST API...
```
The JobManager is not healthy. Check:
```bash
kubectl logs -n analytics deploy/flink-jobmanager -c jobmanager | tail -30
```

If you see an out-of-memory error, the pod has insufficient memory. The JobManager is configured for 900m — the node needs at least 1.2GB free for the pod.

### flink-sql-runner Fails

```bash
kubectl logs -n analytics -l job-name=flink-sql-runner
```

**`ClassNotFoundException: KafkaConnectorFactory`**: A connector JAR is missing from `/opt/flink/lib/`. Rebuild the image.

**`Error: Table 'fact_orders' doesn't exist`**: The analytics DDL was not applied before Flink started. Apply it:
```bash
cat analytics/schema/analytics-ddl.sql | kubectl exec -i -n analytics deploy/analytics-db \
  -- psql -U analyticsuser -d analyticsdb
```

**`Connection refused to kafka:9092`**: Kafka is not running or the bootstrap address is wrong. Check:
```bash
kubectl get pods -n infra -l app=kafka
```

**`envsubst: command not found`**: The `bookstore/flink:latest` image does not have `envsubst`. The base `flink:1.20` image includes it as part of `gettext`. If missing, the image may have been built from a different base. Rebuild.

### Jobs Disappeared After JobManager Restart

Flink Session Cluster stores all job state in memory. When the JobManager pod restarts (Kubernetes pod eviction, node restart, `kubectl rollout restart`), all running jobs are lost. This is expected behavior for a Session Cluster.

Fix: always resubmit the sql-runner Job after any JobManager restart:

```bash
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply  -f infra/flink/flink-sql-runner.yaml
```

Flink will recover from checkpoints automatically — Kafka source operators resume from the last committed offset, and the JDBC sink upsert mode handles any potential re-processing.

---

## File Location Reference

```
/Volumes/Other/rand/llm/microservice/
│
├── analytics/
│   └── flink/
│       ├── Dockerfile                 ← BUILD: defines bookstore/flink:latest
│       └── sql/
│           └── pipeline.sql           ← SQL source of truth (dev reference)
│
└── infra/
    └── flink/
        ├── flink-pvc.yaml             ← DEPLOY: PersistentVolumeClaim (checkpoints)
        ├── flink-cluster.yaml         ← DEPLOY: JobManager + TaskManager + SQL Gateway
        └── flink-sql-runner.yaml      ← DEPLOY: ConfigMap (SQL) + Job (submission)
```
