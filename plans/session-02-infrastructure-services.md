# Session 02 — Infrastructure Services

**Goal:** PostgreSQL instances, Redis, Kafka, Debezium, and PgAdmin deployed and reachable within the cluster.

## Deliverables

- `infra/postgres/` — Kubernetes manifests for four PostgreSQL instances:
  - `ecom-db` (namespace: `ecom`) — for E-Commerce Service
  - `inventory-db` (namespace: `inventory`) — for Inventory Service
  - `analytics-db` (namespace: `analytics`) — CDC sink target
  - Each: Deployment + Service + PersistentVolumeClaim + Secret
- `infra/redis/` — Redis Deployment + Service (namespace: `infra`)
- `infra/kafka/` — Kafka KRaft manifest (namespace: `infra`)
  - Pre-create topics: `order.created`, `inventory.updated`
  - `zookeeper.yaml` intentionally left empty (KRaft mode — no Zookeeper)
- `infra/debezium/` — Debezium Deployment + Service (namespace: `infra`); connector configs added in Session 8
- `infra/pgadmin/` — PgAdmin Deployment + NodePort Service at port 31111 (namespace: `infra`)
- `scripts/infra-up.sh` — applies all infra manifests in dependency order

## Conventions

- All passwords/credentials in Kubernetes Secrets; never in manifests as plaintext
- Postgres data on PVC (not emptyDir)
- Containers run as non-root (`runAsNonRoot: true`, `runAsUser: 999` for postgres)

## Kafka KRaft Critical Settings

```yaml
KAFKA_PROCESS_ROLES: "broker,controller"
KAFKA_PORT: ""          # MUST override Kubernetes service-discovery injection
KAFKA_HEAP_OPTS: "-Xmx512m -Xms256m"
readinessProbe:
  tcpSocket:            # NOT exec — avoids DNS chicken-egg deadlock
    port: 9092
```

## Acceptance Criteria

- [x] All four PostgreSQL pods `Running`; accessible from within cluster by service DNS
- [x] Redis pod `Running`
- [x] Kafka pod `Running`; `kafka-topics.sh --list` shows `order.created` and `inventory.updated`
- [x] Debezium pod `Running` (no connectors yet)
- [x] PgAdmin accessible at `localhost:31111` from host (NodePort)

## Status: Complete ✓
