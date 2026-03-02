#!/usr/bin/env bash
# scripts/restart-after-docker.sh
# Recovery after Docker Desktop restarts.
# Fixes two root causes (see docs/restart-app.md for full explanation):
#   1. Istio ztunnel HBONE plumbing breaks — must restart ztunnel then all pods
#   2. Debezium connector re-registration — only needed if Kafka PVC data was lost
#      (e.g. after `down.sh --data`). With Kafka PVC intact, Kafka internal topics
#      (connect-configs, connect-offsets, connect-status) survive pod restarts and
#      Debezium auto-restores both connectors from Kafka state. The script checks
#      connector state and skips re-registration if already RUNNING.
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
kubectl rollout restart deploy/debezium -n infra
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
wait_deploy debezium infra

# ── Step 4: Re-register Debezium CDC connectors (only if needed) ─────────────
# With Kafka PVC-backed storage, Kafka internal topics (connect-configs,
# connect-offsets, connect-status) survive pod restarts. Debezium reads these
# topics on startup and auto-restores connectors from the last committed WAL
# offset — no manual re-registration required in that case.
# We check connector state first and only re-register if not already RUNNING.
section "Checking Debezium CDC connector state"

DEBEZIUM_URL="${DEBEZIUM_URL:-http://localhost:32300}"

info "Waiting for Debezium REST API at ${DEBEZIUM_URL}..."
_deb_i=0
until curl -sf "${DEBEZIUM_URL}/connectors" > /dev/null 2>&1; do
  ((_deb_i++)) && [[ $_deb_i -ge 24 ]] && { echo "ERROR: Debezium not ready after 2m"; exit 1; }
  echo "  Not ready yet, retrying in 5s..."
  sleep 5
done
info "Debezium is ready."

# Return 0 (true) if the named connector is currently RUNNING
_connector_running() {
  local name=$1
  local state
  state=$(curl -sf "${DEBEZIUM_URL}/connectors/${name}/status" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['connector']['state'])" 2>/dev/null \
    || echo "MISSING")
  echo "  ${name}: ${state}"
  [[ "$state" == "RUNNING" ]]
}

if _connector_running "ecom-connector" && _connector_running "inventory-connector"; then
  info "Both connectors already RUNNING — Kafka PVC data intact, skipping re-registration."
else
  info "One or more connectors not RUNNING — re-registering..."
  bash "${REPO_ROOT}/infra/debezium/register-connectors.sh"
fi

# ── Step 5: Smoke test ────────────────────────────────────────────────────────
section "Smoke test"
bash "${REPO_ROOT}/scripts/smoke-test.sh"
