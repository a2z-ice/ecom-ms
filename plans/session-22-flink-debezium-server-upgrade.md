# Session 22 — Flink 2.2.0 + Debezium Server 3.4

## Goal

Upgrade two infrastructure components:

1. **Flink 1.20 → 2.2.0**: New major release (December 2025). Connector JARs move to 4.x series.
2. **Debezium Kafka Connect 2.7.0 → Debezium Server 3.4**: Replaces Kafka Connect with a standalone Quarkus process. One pod per source DB. Config in `application.properties` ConfigMap. Health API at `/q/health` (port 8080).

## Deliverables

| # | File | Action |
|---|------|--------|
| 1 | `analytics/flink/Dockerfile` | Updated base image + 4 connector JARs |
| 2 | `infra/debezium/debezium-server-ecom.yaml` | NEW — ConfigMap + Deployment + ClusterIP + NodePort 32300 |
| 3 | `infra/debezium/debezium-server-inventory.yaml` | NEW — ConfigMap + Deployment + ClusterIP + NodePort 32301 |
| 4 | `infra/debezium/debezium.yaml` | DELETED (Kafka Connect replaced) |
| 5 | `infra/debezium/connectors/*.json` | DELETED (config moves to ConfigMap) |
| 6 | `infra/debezium/register-connectors.sh` | Replaced with health-check script |
| 7 | `infra/kind/cluster.yaml` | Added `extraPortMappings` port 32301 on control-plane |
| 8 | `infra/kafka/kafka-topics-init.yaml` | Added 2 offset topics for Debezium Server |
| 9 | `infra/istio/security/peer-auth.yaml` | Replaced `debezium-nodeport-permissive` with two entries (port 8080) |
| 10 | `scripts/infra-up.sh` | Deploy new server manifests instead of debezium.yaml |
| 11 | `scripts/up.sh` | Debezium Server deployment + health check (no registration step) |
| 12 | `scripts/restart-after-docker.sh` | Restart both server pods + health poll |
| 13 | `scripts/smoke-test.sh` | Replace Kafka Connect status checks with `/q/health` checks |
| 14 | `e2e/debezium-flink.spec.ts` | Suite 1 rewritten; Suite 4 updated for 2 server pods + 2 NodePorts |
| 15 | `plans/session-22-flink-debezium-server-upgrade.md` | This file |
| 16 | `plans/implementation-plan.md` | Session 22 added |
| 17 | `CLAUDE.md` | Versions, NodePort map, session state updated |

## Key Architecture Changes

### Debezium Server vs Kafka Connect

| | Kafka Connect (old) | Debezium Server (new) |
|---|---|---|
| Image | `debezium/connect:2.7.0.Final` | `quay.io/debezium/server:3.4.1.Final` |
| Instances | 1 pod (all connectors) | 1 pod per source DB |
| Config | REST API POST | `application.properties` ConfigMap |
| Health | `GET /connectors/{name}/status` | `GET /q/health` |
| Port | 8083 | 8080 |
| NodePorts | 32300 only | 32300 (ecom), 32301 (inventory) |
| Offset storage | Kafka internal topics | `debezium.ecom.offsets`, `debezium.inventory.offsets` |
| Restart recovery | Re-register connectors via REST | Auto-resumes from Kafka offset topics |

### Flink Connector Versions

| Component | Old | New |
|---|---|---|
| Base image | `flink:1.20-scala_2.12-java17` | `flink:2.2.0-scala_2.12-java17` |
| flink-connector-kafka | `3.4.0-1.20` | `4.0.1-2.0` |
| flink-connector-jdbc | `3.3.0-1.20` | `4.0.0-2.0` |
| kafka-clients | `3.7.0` | `3.9.2` |
| postgresql | `42.7.4` | `42.7.10` |

### Flink SQL Pipeline

No SQL changes required. The `flink-connector-kafka 4.0.1-2.0` and `flink-connector-jdbc 4.0.0-2.0` are backward-compatible with the existing SQL options:
- `scan.topic-partition-discovery.interval` — still valid
- All 8 AdminClient resilience properties
- JDBC sink options (`sink.buffer-flush.*`, `PRIMARY KEY NOT ENFORCED`)
- `TIMESTAMP(3)` and `?stringtype=unspecified` JDBC URL param

## Deployment

Requires `up.sh --fresh` because port 32301 is new (kind `extraPortMappings` set at cluster creation):

```bash
# 1. Build updated Flink image
docker build -t bookstore/flink:latest ./analytics/flink

# 2. Fresh cluster rebuild
bash scripts/up.sh --fresh

# 3. Verify
bash scripts/verify-cdc.sh
cd e2e && npm run test
```

## Acceptance Criteria

| Check | How to Verify |
|-------|--------------|
| Flink 2.2.0 running | `kubectl exec -n analytics deploy/flink-jobmanager -- flink --version` |
| 4 streaming jobs RUNNING | `curl localhost:32200/jobs` |
| Debezium ecom healthy | `curl localhost:32300/q/health` → `{"status":"UP"}` |
| Debezium inventory healthy | `curl localhost:32301/q/health` → `{"status":"UP"}` |
| End-to-end CDC < 30s | `bash scripts/verify-cdc.sh` |
| All E2E tests pass | `cd e2e && npm run test` → 128+ passing |

## Status

[x] Complete
