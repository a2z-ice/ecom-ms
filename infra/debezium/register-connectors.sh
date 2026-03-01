#!/usr/bin/env bash
# infra/debezium/register-connectors.sh
# Registers Debezium CDC connectors via the Kafka Connect REST API.
# Idempotent — uses PUT /connectors/{name}/config to create-or-update.
#
# Usage:
#   bash infra/debezium/register-connectors.sh
#   DEBEZIUM_URL=http://localhost:32300 bash infra/debezium/register-connectors.sh
#
# Notes:
#   - Default URL is localhost:32300 (kind NodePort, no proxy needed).
#   - PUT /connectors/{name}/config expects just the flat config object — NOT
#     the full {"name":...,"config":{...}} wrapper used for POST /connectors.
#   - Kafka Connect's FileConfigProvider (${file:...} syntax) does NOT expand
#     during validation. Credentials are read from the K8s secret at registration
#     time and injected inline so validation succeeds.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEBEZIUM_URL="${DEBEZIUM_URL:-http://localhost:32300}"
GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}==>${NC} $*"; }

wait_for_debezium() {
  info "Waiting for Debezium to be ready at ${DEBEZIUM_URL}..."
  local i=0
  until curl -sf "${DEBEZIUM_URL}/connectors" > /dev/null 2>&1; do
    ((i++)) && [[ $i -ge 60 ]] && { echo "ERROR: Debezium not ready after 5m"; exit 1; }
    echo "  Not ready yet, retrying in 5s..."
    sleep 5
  done
  echo "  Debezium is ready."
}

register_connector() {
  local name=$1 config_file=$2 db_user=$3 db_password=$4

  info "Registering connector: ${name}..."
  # Extract the config object and inject actual credentials (FileConfigProvider
  # ${file:...} syntax fails validation — expand credentials here instead).
  local cfg_json
  cfg_json=$(python3 - <<PYEOF
import json, sys
with open('${config_file}') as f:
    doc = json.load(f)
cfg = doc.get('config', doc)   # handle both full-wrapper and config-only formats
cfg['database.user']     = '${db_user}'
cfg['database.password'] = '${db_password}'
print(json.dumps(cfg))
PYEOF
)

  # PUT /connectors/{name}/config — body must be flat config object only
  if curl -sf -X PUT \
    -H "Content-Type: application/json" \
    --data "${cfg_json}" \
    "${DEBEZIUM_URL}/connectors/${name}/config" > /dev/null; then
    echo "  Connector '${name}' registered."
  else
    echo "  ERROR: Failed to register '${name}'. Check Debezium logs." >&2
    return 1
  fi
}

check_connector_status() {
  local name=$1
  local status
  status=$(curl -sf "${DEBEZIUM_URL}/connectors/${name}/status" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['connector']['state'])")
  echo "  ${name}: ${status}"
  [[ "$status" == "RUNNING" ]]
}

# ── Preflight: read credentials from K8s secret ─────────────────────────────
if ! kubectl get secret -n infra debezium-db-credentials &>/dev/null; then
  echo "ERROR: Secret 'debezium-db-credentials' not found in namespace 'infra'." >&2
  echo "       Run scripts/up.sh or apply infra manifests first." >&2
  exit 1
fi

ECOM_USER=$(kubectl get secret -n infra debezium-db-credentials \
  -o jsonpath='{.data.ECOM_DB_USER}' | base64 -d)
ECOM_PASS=$(kubectl get secret -n infra debezium-db-credentials \
  -o jsonpath='{.data.ECOM_DB_PASSWORD}' | base64 -d)
INV_USER=$(kubectl get secret -n infra debezium-db-credentials \
  -o jsonpath='{.data.INVENTORY_DB_USER}' | base64 -d)
INV_PASS=$(kubectl get secret -n infra debezium-db-credentials \
  -o jsonpath='{.data.INVENTORY_DB_PASSWORD}' | base64 -d)

CONNECTORS_DIR="${REPO_ROOT}/infra/debezium/connectors"

wait_for_debezium
register_connector "ecom-connector"       "${CONNECTORS_DIR}/ecom-connector.json"       "$ECOM_USER" "$ECOM_PASS"
register_connector "inventory-connector"  "${CONNECTORS_DIR}/inventory-connector.json"  "$INV_USER"  "$INV_PASS"

info "Waiting 15s for connectors to start..."
sleep 15

info "Checking connector statuses..."
check_connector_status "ecom-connector"
check_connector_status "inventory-connector"

echo ""
echo -e "${GREEN}✔ Debezium connectors registered and running.${NC}"
