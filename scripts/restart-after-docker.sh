#!/usr/bin/env bash
# scripts/restart-after-docker.sh
# Recovery after Docker Desktop restarts.
# Fixes three root causes (see docs/restart-app.md for full explanation):
#   1. Istio ztunnel HBONE plumbing breaks — must restart ztunnel then all pods
#   2. Debezium connector re-registration — only needed if Kafka PVC data was lost
#      (e.g. after `down.sh --data`). With Kafka PVC intact, Kafka internal topics
#      (connect-configs, connect-offsets, connect-status) survive pod restarts and
#      Debezium auto-restores both connectors from Kafka state. The script checks
#      connector state and skips re-registration if already RUNNING.
#   3. Flink SQL pipeline resubmission — Flink Session Cluster loses all streaming
#      jobs when the JobManager pod restarts. The flink-sql-runner K8s Job already
#      completed and won't re-run; must delete + recreate it to resubmit.
#
# Usage: ./scripts/restart-after-docker.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}==>${NC} $*"; }
section() { echo -e "\n${YELLOW}════ $* ════${NC}"; }

wait_deploy() {
  kubectl rollout status deployment/"$1" -n "$2" --timeout=180s
}

# ── Pre-flight ───────────────────────────────────────────────────────────────
kubectl config use-context kind-bookstore
kubectl wait --for=condition=Ready nodes --all --timeout=60s

# ── Step 1: Restart ztunnel to reset HBONE network plumbing ─────────────────
section "Restarting ztunnel (HBONE reset)"
kubectl rollout restart daemonset/ztunnel -n istio-system
kubectl rollout status daemonset/ztunnel -n istio-system --timeout=90s
info "ztunnel ready — waiting 10s for mesh to stabilize before pod restarts..."
sleep 10

# ── Step 2: Restart DB pods first (apps need DBs ready for migrations) ───────
section "Restarting DB pods"
kubectl rollout restart deploy/ecom-db -n ecom
kubectl rollout restart deploy/inventory-db -n inventory
kubectl rollout restart deploy/keycloak-db -n identity
kubectl rollout restart deploy/analytics-db -n analytics
wait_deploy ecom-db ecom
wait_deploy inventory-db inventory
wait_deploy keycloak-db identity
wait_deploy analytics-db analytics

# ── Step 3: Restart application pods ─────────────────────────────────────────
section "Restarting application pods"
kubectl rollout restart deploy/kafka -n infra
kubectl rollout restart deploy/redis -n infra
kubectl rollout restart deploy/keycloak -n identity
kubectl rollout restart deploy/ecom-service -n ecom
kubectl rollout restart deploy/inventory-service -n inventory
kubectl rollout restart deploy/ui-service -n ecom
kubectl rollout restart deploy/debezium-server-ecom -n infra
kubectl rollout restart deploy/debezium-server-inventory -n infra
kubectl rollout restart deploy/pgadmin -n infra
kubectl rollout restart deploy/flink-jobmanager -n analytics
kubectl rollout restart deploy/flink-taskmanager -n analytics
kubectl rollout restart deploy/superset -n analytics
kubectl rollout restart deploy/prometheus -n observability

info "Waiting for critical services to be ready..."
wait_deploy kafka infra
wait_deploy keycloak identity
wait_deploy ecom-service ecom
wait_deploy inventory-service inventory
wait_deploy debezium-server-ecom infra
wait_deploy debezium-server-inventory infra
wait_deploy flink-jobmanager analytics
wait_deploy flink-taskmanager analytics

# ── Step 4: Wait for Debezium Server health ──────────────────────────────────
# Debezium Server auto-resumes CDC from Kafka-backed offset storage on restart
# (debezium.ecom.offsets and debezium.inventory.offsets topics in Kafka).
# No re-registration needed — just poll /q/health until both instances are UP.
section "Waiting for Debezium Server health (auto-resumes from Kafka offsets)"
bash "${REPO_ROOT}/infra/debezium/register-connectors.sh"

# ── Step 5: Resubmit Flink SQL pipeline ──────────────────────────────────────
# Flink Session Cluster loses all streaming jobs when JM pod restarts.
# The flink-sql-runner K8s Job already completed — must delete + recreate to resubmit.
section "Resubmitting Flink SQL pipeline"
info "Waiting for Flink SQL Gateway to be ready..."
_gw_i=0
until kubectl exec -n analytics deploy/flink-jobmanager -c sql-gateway -- \
  curl -sf http://localhost:9091/v1/info > /dev/null 2>&1; do
  ((_gw_i++)) && [[ $_gw_i -ge 24 ]] && { echo "  WARNING: SQL Gateway not ready after 2m — skipping sql-runner"; break; }
  echo "  SQL Gateway not ready, retrying in 5s..."
  sleep 5
done
if [[ $_gw_i -lt 24 ]]; then
  kubectl delete job flink-sql-runner -n analytics --ignore-not-found
  kubectl apply -f "${REPO_ROOT}/infra/flink/flink-sql-runner.yaml"
  kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=120s || \
    echo "  WARNING: flink-sql-runner did not complete — check: kubectl logs -n analytics -l job-name=flink-sql-runner"
  info "Flink SQL pipeline resubmitted."
fi

# ── Step 6: Smoke test ────────────────────────────────────────────────────────
section "Smoke test"
bash "${REPO_ROOT}/scripts/smoke-test.sh"
