#!/usr/bin/env bash
# scripts/smoke-test.sh
# Full-stack smoke test for Session 13.
# Tests every endpoint, verifies Kafka consumer lag, checks all pods Running.
# Exits 0 only if all checks pass.
set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0

ok()   { echo -e "${GREEN}PASS${NC} $*"; ((PASS++)) || true; }
fail() { echo -e "${RED}FAIL${NC} $*"; ((FAIL++)) || true; }
info() { echo -e "${YELLOW}INFO${NC} $*"; }

http_check() {
  local label=$1 url=$2 expected=${3:-200}
  local code
  code=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
  [[ "$code" == "$expected" ]] && ok "[$label] $url → $code" || fail "[$label] $url → expected=$expected actual=$code"
}

pod_check() {
  local label=$1 ns=$2 selector=$3
  local phase
  phase=$(kubectl get pods -n "$ns" -l "$selector" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "Unknown")
  [[ "$phase" == "Running" ]] && ok "[$label] pod Running" || fail "[$label] pod phase=$phase"
}

echo "==============================="
echo "  Book Store Smoke Test"
echo "==============================="
echo ""

# ── 1. Pod health checks ────────────────────────────────────────────────────
info "Checking pod status..."
pod_check "ecom-service" ecom "app=ecom-service"
pod_check "ecom-db" ecom "app=ecom-db"
pod_check "inventory-service" inventory "app=inventory-service"
pod_check "inventory-db" inventory "app=inventory-db"
pod_check "analytics-db" analytics "app=analytics-db"
pod_check "keycloak" identity "app=keycloak"
pod_check "redis" infra "app=redis"
pod_check "kafka" infra "app=kafka"
pod_check "debezium" infra "app=debezium"
pod_check "pgadmin" infra "app=pgadmin"
pod_check "superset" analytics "app=superset"
pod_check "ui-service" ecom "app=ui-service"

echo ""
# ── 2. HTTP endpoint checks ─────────────────────────────────────────────────
info "Checking HTTP endpoints..."
http_check "Keycloak OIDC" "http://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration"
http_check "UI catalog" "http://myecom.net:30000/"
http_check "ecom GET /books" "http://api.service.net:30000/ecom/books"
http_check "ecom GET /books/search" "http://api.service.net:30000/ecom/books/search?q=kafka"
http_check "ecom GET /cart (no auth→401)" "http://api.service.net:30000/ecom/cart" "401"
http_check "inventory health" "http://api.service.net:30000/inven/health"
http_check "PgAdmin" "http://localhost:31111/misc/ping"
http_check "Superset" "http://localhost:32000/health"

echo ""
# ── 3. Kafka consumer lag ────────────────────────────────────────────────────
info "Checking Kafka consumer lag..."
LAG=$(kubectl exec -n infra deploy/kafka -- \
  kafka-consumer-groups --bootstrap-server localhost:9092 \
  --group inventory-service \
  --describe 2>/dev/null | awk '/inventory-service/{sum+=$6} END{print sum+0}' || echo "-1")

if [[ "$LAG" == "0" || "$LAG" == "" ]]; then
  ok "[Kafka lag] inventory-service consumer lag=0"
else
  fail "[Kafka lag] inventory-service consumer lag=$LAG (expected 0)"
fi

echo ""
# ── 4. Debezium connector status ─────────────────────────────────────────────
info "Checking Debezium connectors..."
for connector in ecom-connector inventory-connector; do
  STATUS=$(kubectl exec -n infra deploy/debezium -- \
    curl -sf "http://localhost:8083/connectors/${connector}/status" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['connector']['state'])" 2>/dev/null || echo "UNKNOWN")
  [[ "$STATUS" == "RUNNING" ]] && ok "[Debezium] $connector=RUNNING" || fail "[Debezium] $connector=$STATUS"
done

echo ""
echo "==============================="
echo "  Results: ${PASS} passed, ${FAIL} failed"
echo "==============================="
[[ $FAIL -eq 0 ]] && echo -e "${GREEN}✔ All smoke tests passed${NC}" || { echo -e "${RED}FAIL: Some checks failed${NC}"; exit 1; }
