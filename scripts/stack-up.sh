#!/usr/bin/env bash
# scripts/stack-up.sh
# Creates the kind cluster (if absent) and brings up the full BookStore stack.
# Idempotent: safe to re-run on a running cluster.
#
# Usage: ./scripts/stack-up.sh
# Prerequisites: kind, kubectl, docker, helm, istioctl

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}==>${NC} $*"; }
section() { echo -e "\n${YELLOW}════ $* ════${NC}"; }

wait_deployment() {
  kubectl rollout status deployment/"$1" -n "$2" --timeout=300s
}

# ── Step 0: Pre-flight ──────────────────────────────────────────────────────
section "Pre-flight checks"
for cmd in kind kubectl docker helm istioctl; do
  command -v "$cmd" &>/dev/null || { echo "ERROR: $cmd not found on PATH"; exit 1; }
done
info "All prerequisites found."

# ── Step 1: Create data directories ────────────────────────────────────────
section "Creating data directories"
mkdir -p "${REPO_ROOT}/data"/{ecom-db,inventory-db,analytics-db,keycloak-db,superset,kafka,redis}
info "Data directories ready at ${REPO_ROOT}/data/"

# ── Step 2: Create/verify kind cluster ─────────────────────────────────────
section "Kind cluster"
bash "${REPO_ROOT}/scripts/cluster-up.sh"

# ── Step 3: StorageClass + PersistentVolumes ───────────────────────────────
section "Storage (hostPath PVs)"
kubectl apply -f "${REPO_ROOT}/infra/storage/storageclass.yaml"
kubectl apply -f "${REPO_ROOT}/infra/storage/persistent-volumes.yaml"
info "StorageClass and PVs applied."

# ── Step 4: Infrastructure services ───────────────────────────────────────
section "Infrastructure (PostgreSQL, Redis, Kafka, Debezium, PgAdmin)"
kubectl apply -f "${REPO_ROOT}/infra/postgres/ecom-db.yaml"
kubectl apply -f "${REPO_ROOT}/infra/postgres/inventory-db.yaml"
kubectl apply -f "${REPO_ROOT}/infra/postgres/analytics-db.yaml"
kubectl apply -f "${REPO_ROOT}/infra/redis/redis.yaml"
kubectl apply -f "${REPO_ROOT}/infra/kafka/kafka.yaml"
kubectl apply -f "${REPO_ROOT}/infra/debezium/debezium.yaml"
if [[ -f "${REPO_ROOT}/infra/pgadmin/pgadmin.yaml" ]]; then
  kubectl apply -f "${REPO_ROOT}/infra/pgadmin/pgadmin.yaml"
fi

info "Waiting for infra pods to be ready..."
wait_deployment ecom-db ecom
wait_deployment inventory-db inventory
wait_deployment analytics-db analytics
wait_deployment redis infra
wait_deployment kafka infra
wait_deployment debezium infra

# ── Step 5: Keycloak + realm import ────────────────────────────────────────
section "Keycloak Identity Provider"
kubectl apply -f "${REPO_ROOT}/infra/keycloak/keycloak.yaml"
wait_deployment keycloak-db identity
wait_deployment keycloak identity
bash "${REPO_ROOT}/scripts/keycloak-import.sh"

# ── Step 6: Application services ───────────────────────────────────────────
section "Application services"
for dir in ecom-service inventory-service ui; do
  for location in \
    "${REPO_ROOT}/infra/${dir}/" \
    "${REPO_ROOT}/${dir}/k8s/" \
    "${REPO_ROOT}/${dir}/infra/"; do
    if [[ -d "$location" ]]; then
      kubectl apply -f "$location"
      break
    fi
  done
done
kubectl apply -f "${REPO_ROOT}/infra/kgateway/" 2>/dev/null || true
wait_deployment ecom-service ecom       || true
wait_deployment inventory-service inventory || true
wait_deployment ui-service ecom         || true

# ── Step 7: Debezium CDC connectors ────────────────────────────────────────
section "Debezium CDC connectors"
bash "${REPO_ROOT}/infra/debezium/register-connectors.sh" || true

# ── Step 8: Analytics consumer ─────────────────────────────────────────────
section "Analytics consumer"
if ls "${REPO_ROOT}/infra/analytics/"*.yaml &>/dev/null 2>&1; then
  kubectl apply -f "${REPO_ROOT}/infra/analytics/"
  wait_deployment analytics-consumer analytics || true
fi

# ── Step 9: Superset ───────────────────────────────────────────────────────
section "Apache Superset"
kubectl apply -f "${REPO_ROOT}/infra/superset/superset.yaml"
wait_deployment superset analytics
if [[ -f "${REPO_ROOT}/infra/superset/bootstrap-job.yaml" ]]; then
  kubectl delete job superset-bootstrap -n analytics --ignore-not-found
  kubectl apply -f "${REPO_ROOT}/infra/superset/bootstrap-job.yaml"
  kubectl wait --for=condition=complete job/superset-bootstrap -n analytics --timeout=300s || true
fi

# ── Step 10: Observability ─────────────────────────────────────────────────
section "Observability (Prometheus + Kiali)"
if [[ -f "${REPO_ROOT}/infra/observability/prometheus/prometheus.yaml" ]]; then
  kubectl apply -f "${REPO_ROOT}/infra/observability/prometheus/prometheus.yaml"
fi
kubectl apply -f "${REPO_ROOT}/infra/observability/kiali/prometheus-alias.yaml"
kubectl apply -f "${REPO_ROOT}/infra/observability/kiali/kiali-nodeport.yaml"
info "Kiali available at http://localhost:32100/kiali (kind NodePort — no proxy needed)"

# ── Step 11: Sanity test ───────────────────────────────────────────────────
section "Sanity test"
bash "${REPO_ROOT}/scripts/sanity-test.sh"
