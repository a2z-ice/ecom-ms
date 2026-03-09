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
info "Deploying Zookeeper placeholder (intentionally empty — Kafka runs in KRaft mode)..."
kubectl apply -f "${REPO_ROOT}/infra/kafka/zookeeper.yaml" 2>/dev/null || true

info "Deploying Kafka..."
kubectl apply -f "${REPO_ROOT}/infra/kafka/kafka.yaml"
wait_deployment kafka infra

info "Creating Kafka topics (Job)..."
# Apply topic-init Job separately — never re-apply kafka.yaml here because
# that would reconfigure the Deployment and could restart Kafka mid-job.
kubectl delete job kafka-topic-init -n infra --ignore-not-found
kubectl apply -f "${REPO_ROOT}/infra/kafka/kafka-topics-init.yaml"
kubectl wait --for=condition=complete job/kafka-topic-init -n infra --timeout=300s

# ── 3b. Schema Registry ───────────────────────────────────────────────────────
info "Deploying Schema Registry..."
kubectl apply -f "${REPO_ROOT}/infra/schema-registry/schema-registry.yaml"
wait_deployment schema-registry infra

# ── 4. Debezium Server (replaces Kafka Connect) ──────────────────────────────
info "Deploying Debezium Server (ecom + inventory)..."
# Debezium Server runs in `infra` namespace; DB secrets are in `ecom`/`inventory`.
# Copy credentials into infra namespace (secrets are namespace-scoped in Kubernetes).
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
kubectl apply -f "${REPO_ROOT}/infra/debezium/debezium-server-ecom.yaml"
kubectl apply -f "${REPO_ROOT}/infra/debezium/debezium-server-inventory.yaml"
wait_deployment debezium-server-ecom infra
wait_deployment debezium-server-inventory infra

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

# ── 7. Observability — Grafana + AlertManager ──────────────────────────────
info "Deploying AlertManager..."
kubectl apply -f "${REPO_ROOT}/infra/observability/alertmanager/alertmanager.yaml"
wait_deployment alertmanager observability

info "Deploying Grafana..."
kubectl apply -f "${REPO_ROOT}/infra/observability/grafana/grafana.yaml"
wait_deployment grafana observability

info "Deploying OTel stack (Tempo + Loki + OTel Collector) in otel namespace..."
kubectl create ns otel 2>/dev/null || true
kubectl label ns otel istio.io/dataplane-mode=ambient --overwrite 2>/dev/null
kubectl label ns otel pod-security.kubernetes.io/enforce=baseline pod-security.kubernetes.io/enforce-version=latest --overwrite 2>/dev/null
cat <<'OTEL_PA' | kubectl apply -f -
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: permissive-mtls
  namespace: otel
spec:
  mtls:
    mode: PERMISSIVE
OTEL_PA
kubectl apply -f "${REPO_ROOT}/infra/observability/otel-collector.yaml"
kubectl apply -f "${REPO_ROOT}/infra/observability/tempo/tempo.yaml"
kubectl apply -f "${REPO_ROOT}/infra/observability/loki/loki.yaml"
wait_deployment otel-collector otel
wait_deployment tempo otel
wait_deployment loki otel

# ── 8. Summary ──────────────────────────────────────────────────────────────
echo ""
info "Infrastructure pod status:"
kubectl get pods -n ecom -l app=ecom-db
kubectl get pods -n inventory -l app=inventory-db
kubectl get pods -n analytics
kubectl get pods -n infra
kubectl get pods -n observability
kubectl get pods -n otel

echo ""
echo -e "${GREEN}✔ Infrastructure up.${NC}"
echo ""
echo "Acceptance checks:"
echo "  kubectl get pods -n ecom         # ecom-db Running"
echo "  kubectl get pods -n inventory    # inventory-db Running"
echo "  kubectl get pods -n analytics    # analytics-db, flink-jobmanager, flink-taskmanager Running"
echo "  kubectl get pods -n infra        # redis, kafka, debezium-server-ecom, debezium-server-inventory, pgadmin"
echo "  curl http://localhost:31111      # PgAdmin UI"
echo ""
echo "Verify Flink jobs running:"
echo "  kubectl exec -n analytics deploy/flink-jobmanager -- \\"
echo "    curl -s http://localhost:8081/jobs | python3 -m json.tool"
echo ""
echo "Verify Kafka topics:"
echo "  kubectl exec -n infra deploy/kafka -- kafka-topics \\"
echo "    --bootstrap-server localhost:9092 --list"
