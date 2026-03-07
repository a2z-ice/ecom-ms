#!/usr/bin/env bash
# infra/debezium/register-connectors.sh
# Waits for both Debezium Server instances to report healthy via /q/health.
# (Replaces the old Kafka Connect connector-registration script.)
#
# Usage:
#   bash infra/debezium/register-connectors.sh
#   DEBEZIUM_ECM_URL=http://localhost:32300 DEBEZIUM_INV_URL=http://localhost:32301 \
#     bash infra/debezium/register-connectors.sh
#
# Notes:
#   - Default URLs use kind NodePort (no proxy needed).
#   - Each Debezium Server instance auto-starts CDC on launch (config is in
#     application.properties ConfigMap); no REST registration required.
#   - /q/health reports {"status":"UP"} once the server is running and connected.

set -euo pipefail

DEBEZIUM_ECM_URL="${DEBEZIUM_ECM_URL:-http://localhost:32300}"
DEBEZIUM_INV_URL="${DEBEZIUM_INV_URL:-http://localhost:32301}"
GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}==>${NC} $*"; }

_wait_healthy() {
  local name=$1 url=$2
  info "Waiting for ${name} to be healthy at ${url}/q/health..."
  local i=0
  while true; do
    local status
    status=$(curl -sf "${url}/q/health" \
      | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null \
      || echo "")
    if [[ "$status" == "UP" ]]; then
      echo -e "  ${GREEN}[OK]${NC} ${name} is healthy (status=UP)"
      return 0
    fi
    i=$((i + 1))
    if [[ $i -ge 60 ]]; then
      echo "  [FAIL] ${name} not healthy after 300s (last status='${status}')" >&2
      return 1
    fi
    echo "  ${name} not ready yet (status='${status}'), retrying in 5s... (${i}/60)"
    sleep 5
  done
}

_wait_healthy "debezium-server-ecom"      "$DEBEZIUM_ECM_URL"
_wait_healthy "debezium-server-inventory" "$DEBEZIUM_INV_URL"

echo ""
echo -e "${GREEN}✔ Both Debezium Server instances are healthy.${NC}"
