#!/usr/bin/env bash
# scripts/infra-up.sh
# Applies all infrastructure service manifests in dependency order.
# Idempotent: safe to re-run.
#
# Prerequisites: cluster-up.sh must have run successfully.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}==>${NC} $*"; }

# ── Preflight ───────────────────────────────────────────────────────────────
kubectl config current-context | grep -q "kind-bookstore" || {
  echo "ERROR: Current kubectl context is not kind-bookstore. Run cluster-up.sh first."
  exit 1
}

# ── Helper: wait for a deployment to become ready ───────────────────────────
wait_deployment() {
  local name=$1 ns=$2
  info "Waiting for deployment/${name} in namespace ${ns}..."
  kubectl rollout status deployment/"${name}" -n "${ns}" --timeout=180s
}

# ── 1. PostgreSQL instances ─────────────────────────────────────────────────
info "Deploying ecom-db..."
kubectl apply -f "${REPO_ROOT}/infra/postgres/ecom-db.yaml"

info "Deploying inventory-db..."
kubectl apply -f "${REPO_ROOT}/infra/postgres/inventory-db.yaml"

info "Deploying analytics-db..."
kubectl apply -f "${REPO_ROOT}/infra/postgres/analytics-db.yaml"

wait_deployment ecom-db ecom
wait_deployment inventory-db inventory
wait_deployment analytics-db analytics

# ── 2. Redis ────────────────────────────────────────────────────────────────
info "Deploying Redis..."
kubectl apply -f "${REPO_ROOT}/infra/redis/redis.yaml"
wait_deployment redis infra

# ── 3. Kafka + Zookeeper ────────────────────────────────────────────────────
info "Deploying Zookeeper..."
kubectl apply -f "${REPO_ROOT}/infra/kafka/zookeeper.yaml"
wait_deployment zookeeper infra

info "Deploying Kafka..."
kubectl apply -f "${REPO_ROOT}/infra/kafka/kafka.yaml"
wait_deployment kafka infra

info "Creating Kafka topics (Job)..."
# If a previous kafka-topic-init job exists, delete it first (Jobs are immutable)
kubectl delete job kafka-topic-init -n infra --ignore-not-found
kubectl apply -f "${REPO_ROOT}/infra/kafka/kafka.yaml"
kubectl wait --for=condition=complete job/kafka-topic-init -n infra --timeout=120s

# ── 4. Debezium ─────────────────────────────────────────────────────────────
info "Deploying Debezium..."
kubectl apply -f "${REPO_ROOT}/infra/debezium/debezium.yaml"
wait_deployment debezium infra

# ── 5. PgAdmin ──────────────────────────────────────────────────────────────
info "Deploying PgAdmin..."
kubectl apply -f "${REPO_ROOT}/infra/pgadmin/pgadmin.yaml"
wait_deployment pgadmin infra

# ── 6. Flink (CDC analytics pipeline) ───────────────────────────────────────
info "Deploying Flink cluster (JobManager + TaskManager)..."
kubectl apply -f "${REPO_ROOT}/infra/flink/flink-pvc.yaml"
kubectl apply -f "${REPO_ROOT}/infra/flink/flink-config.yaml"
kubectl apply -f "${REPO_ROOT}/infra/flink/flink-cluster.yaml"
wait_deployment flink-jobmanager analytics
wait_deployment flink-taskmanager analytics

info "Submitting Flink SQL pipeline..."
# Delete previous runner job if it exists (Jobs are immutable)
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f "${REPO_ROOT}/infra/flink/flink-sql-runner.yaml"
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=180s || \
  info "Warning: flink-sql-runner did not complete in 180s — check pod logs"

# ── 7. Summary ──────────────────────────────────────────────────────────────
echo ""
info "Infrastructure pod status:"
kubectl get pods -n ecom -l app=ecom-db
kubectl get pods -n inventory -l app=inventory-db
kubectl get pods -n analytics
kubectl get pods -n infra

echo ""
echo -e "${GREEN}✔ Infrastructure up.${NC}"
echo ""
echo "Acceptance checks:"
echo "  kubectl get pods -n ecom         # ecom-db Running"
echo "  kubectl get pods -n inventory    # inventory-db Running"
echo "  kubectl get pods -n analytics    # analytics-db, flink-jobmanager, flink-taskmanager Running"
echo "  kubectl get pods -n infra        # redis, kafka, zookeeper, debezium, pgadmin"
echo "  curl http://localhost:31111      # PgAdmin UI"
echo ""
echo "Verify Flink jobs running:"
echo "  kubectl exec -n analytics deploy/flink-jobmanager -- \\"
echo "    curl -s http://localhost:8081/jobs | python3 -m json.tool"
echo ""
echo "Verify Kafka topics:"
echo "  kubectl exec -n infra deploy/kafka -- kafka-topics \\"
echo "    --bootstrap-server localhost:9092 --list"
