# Session 18 — Apache Flink CDC Pipeline & Enhanced Superset Analytics

## Goal

Replace the Python analytics CDC consumer with a production-grade Apache Flink SQL streaming pipeline. Expand Superset from 1 dashboard/2 charts to 3 dashboards/14 charts covering inventory health, revenue breakdown, and KPI metrics.

## Context

**Why this change:**
The current Python analytics consumer (`analytics/consumer/main.py`) has three concrete limitations:
1. **No exactly-once guarantees** — per-row Kafka auto-commit with psycopg2 reconnect means a pod restart can duplicate or skip rows.
2. **No streaming transformations** — windowed aggregations, cross-topic joins, or derived metrics require code changes.
3. **Not the industry standard** — production event-driven analytics uses Debezium → Kafka → Flink SQL → sink.

**Why Flink is the right choice:**
- Flink SQL has native `debezium-json` format support — no custom envelope parsing needed.
- Exactly-once semantics via checkpointing + Kafka offset tracking.
- Adding a new transformation is a one-line SQL change.

**Resource impact:**
- Remove Python consumer: −256Mi memory
- Add Flink JobManager: +512Mi, Add Flink TaskManager: +1Gi
- Net: +~1.3Gi. Acceptable for a 3-node kind cluster.

## Deliverables

| File | Purpose | Status |
|------|---------|--------|
| `analytics/flink/Dockerfile` | Custom image: Flink 1.20 + Kafka/JDBC/PostgreSQL connector JARs | [ ] |
| `analytics/flink/sql/pipeline.sql` | Flink SQL DDL (4 source + 4 sink tables) + 4 INSERT INTO pipelines | [ ] |
| `infra/flink/flink-cluster.yaml` | JobManager Deployment + Service + TaskManager Deployment | [ ] |
| `infra/flink/flink-config.yaml` | ConfigMap: flink-conf.yaml (checkpoints, parallelism) | [ ] |
| `infra/flink/flink-sql-runner.yaml` | Kubernetes Job: submits SQL pipeline to Session Cluster | [ ] |
| `infra/flink/flink-pvc.yaml` | PVC for checkpoint storage (2Gi, local-hostpath StorageClass) | [ ] |
| `plans/session-18-flink-analytics-superset.md` | This file | [x] |

### Files Modified

| File | Change | Status |
|------|--------|--------|
| `infra/storage/persistent-volumes.yaml` | Add `flink-pv` (hostPath: `/data/flink`, 2Gi) | [ ] |
| `infra/kind/cluster.yaml` | Add `DATA_DIR/flink` extraMount on all 3 nodes | [ ] |
| `analytics/schema/analytics-ddl.sql` | Append 8 new views | [ ] |
| `infra/superset/bootstrap/bootstrap_dashboards.py` | Expand to 3 dashboards, 14 charts, 8 new datasets | [ ] |
| `infra/superset/bootstrap-job.yaml` | Create Kubernetes Job for Superset bootstrap | [ ] |
| `e2e/superset.spec.ts` | Add tests for 2 new dashboards + new charts | [ ] |
| `scripts/infra-up.sh` | Apply `infra/flink/` manifests (after kafka section) | [ ] |
| `CLAUDE.md` | Update current state (Session 18 complete) | [ ] |

### Files Deleted

| File | Reason | Status |
|------|--------|--------|
| `analytics/consumer/main.py` | Replaced by Flink SQL pipeline | [ ] |
| `analytics/consumer/Dockerfile` | Replaced by `analytics/flink/Dockerfile` | [ ] |
| `analytics/consumer/requirements.txt` | Replaced by Flink image with baked-in JARs | [ ] |
| `infra/analytics/analytics-consumer.yaml` | Replaced by `infra/flink/flink-cluster.yaml` | [ ] |

## Architecture

```
Debezium → Kafka topics → Flink SQL (debezium-json format) → JDBC → analytics-db
                                                                     ↓
                                                              Superset dashboards
```

## Acceptance Criteria

- [ ] `flink-jobmanager` and `flink-taskmanager` pods Running in `analytics` namespace
- [ ] Flink REST API (`GET /jobs`) shows 4 streaming jobs in RUNNING state
- [ ] `analytics/consumer/main.py` and `infra/analytics/analytics-consumer.yaml` deleted
- [ ] All 8 new views exist in analytics DB (`\dv vw_*` shows 10 views total)
- [ ] Superset has 3 dashboards, 14 charts
- [ ] "Inventory Analytics" dashboard renders Inventory Health Table with stock levels
- [ ] "Sales & Revenue Analytics" dashboard shows KPI big numbers
- [ ] E2E tests: ≥50 passing (45 existing + ~5 new Superset tests)
- [ ] `scripts/verify-cdc.sh` still exits 0 (end-to-end CDC still works)

## Build & Deploy Commands

```bash
# 1. Build and load Flink image
docker build -t bookstore/flink:latest ./analytics/flink
kind load docker-image bookstore/flink:latest --name bookstore

# 2. Apply storage (PV + PVC)
kubectl apply -f infra/storage/persistent-volumes.yaml
kubectl apply -f infra/flink/flink-pvc.yaml

# 3. Deploy Flink cluster
kubectl apply -f infra/flink/flink-config.yaml
kubectl apply -f infra/flink/flink-cluster.yaml
kubectl rollout status deployment/flink-jobmanager -n analytics --timeout=120s
kubectl rollout status deployment/flink-taskmanager -n analytics --timeout=120s

# 4. Submit SQL pipeline
kubectl apply -f infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=120s

# 5. Verify Flink jobs running
kubectl exec -n analytics deploy/flink-jobmanager -- \
  curl -s http://localhost:8081/jobs | python3 -m json.tool

# 6. Remove Python consumer (after verification)
kubectl delete -f infra/analytics/analytics-consumer.yaml

# 7. Apply new analytics DDL
kubectl exec -n analytics deployment/analytics-db -- psql -U analyticsuser -d analyticsdb \
  -c "$(cat analytics/schema/analytics-ddl.sql)"

# 8. Run Superset bootstrap for new dashboards
kubectl apply -f infra/superset/bootstrap-job.yaml
kubectl wait --for=condition=complete job/superset-bootstrap -n analytics --timeout=300s
```

## Status: In Progress
