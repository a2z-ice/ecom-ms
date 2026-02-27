#!/usr/bin/env bash
# infra/debezium/register-connectors.sh
# Registers Debezium CDC connectors via the Kafka Connect REST API.
# Idempotent — uses PUT to create-or-update.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEBEZIUM_URL="${DEBEZIUM_URL:-http://localhost:8083}"
GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}==>${NC} $*"; }

wait_for_debezium() {
  info "Waiting for Debezium to be ready at ${DEBEZIUM_URL}..."
  until curl -sf "${DEBEZIUM_URL}/connectors" > /dev/null; do
    echo "  Not ready yet, retrying in 5s..."
    sleep 5
  done
  echo "  Debezium is ready."
}

register_connector() {
  local name=$1
  local config_file=$2

  info "Registering connector: ${name}..."
  curl -sf -X PUT \
    -H "Content-Type: application/json" \
    --data "@${config_file}" \
    "${DEBEZIUM_URL}/connectors/${name}/config"
  echo ""
  echo "  Connector '${name}' registered."
}

check_connector_status() {
  local name=$1
  local status
  status=$(curl -sf "${DEBEZIUM_URL}/connectors/${name}/status" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['connector']['state'])")
  echo "  Status of '${name}': ${status}"
  [[ "$status" == "RUNNING" ]]
}

CONNECTORS_DIR="${REPO_ROOT}/infra/debezium/connectors"

wait_for_debezium

register_connector "ecom-connector" "${CONNECTORS_DIR}/ecom-connector.json"
register_connector "inventory-connector" "${CONNECTORS_DIR}/inventory-connector.json"

info "Waiting 10s for connectors to start..."
sleep 10

info "Checking connector statuses..."
check_connector_status "ecom-connector"
check_connector_status "inventory-connector"

echo ""
echo -e "${GREEN}✔ Debezium connectors registered and running.${NC}"
