#!/usr/bin/env bash
# scripts/sanity-test.sh
# Comprehensive sanity test: pods, PVCs, HTTP routes, DB schemas,
# Kafka topics, Debezium health, and Kiali Prometheus integration.
# Compatible with CloudNativePG-managed PostgreSQL clusters.
# Exits 0 only if ALL checks pass.
#
# Usage: ./scripts/sanity-test.sh

set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0

ok()   { echo -e "${GREEN}PASS${NC} $*"; ((PASS++)) || true; }
fail() { echo -e "${RED}FAIL${NC} $*"; ((FAIL++)) || true; }
info() { echo -e "${YELLOW}INFO${NC} $*"; }

http_check() {
  local label=$1 url=$2 expected=${3:-200}
  local code
  code=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
  [[ "$code" == "$expected" ]] \
    && ok "[$label] → HTTP $code" \
    || fail "[$label] $url → expected=$expected got=$code"
}

pod_check() {
  local label=$1 ns=$2 selector=$3
  local phase
  phase=$(kubectl get pods -n "$ns" -l "$selector" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "Missing")
  [[ "$phase" == "Running" ]] \
    && ok "[pod] $label" \
    || fail "[pod] $label phase=$phase"
}

db_table_check() {
  local label=$1 ns=$2 cluster=$3 db=$4 table=$5
  local pod_name count
  pod_name=$(kubectl get pod -n "$ns" -l "cnpg.io/cluster=$cluster,cnpg.io/instanceRole=primary" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [[ -z "$pod_name" ]]; then
    fail "[db] $label — primary pod not found"
    return
  fi
  count=$(kubectl exec -n "$ns" "$pod_name" -- \
    sh -c "psql -U postgres -d $db -tAc \
      \"SELECT COUNT(*) FROM information_schema.tables WHERE table_name='$table'\"" 2>/dev/null || echo "0")
  [[ "${count// /}" == "1" ]] \
    && ok "[db] $label table '$table' exists" \
    || fail "[db] $label table '$table' missing"
}

echo "════════════════════════════════════════"
echo "  BookStore Sanity Test"
echo "════════════════════════════════════════"

# 1. Pod health
info "Checking all pods..."
pod_check "ecom-service"       ecom       "app=ecom-service"
pod_check "ecom-db"            ecom       "cnpg.io/cluster=ecom-db"
pod_check "ui-service"         ecom       "app=ui-service"
pod_check "inventory-service"  inventory  "app=inventory-service"
pod_check "inventory-db"       inventory  "cnpg.io/cluster=inventory-db"
pod_check "analytics-db"       analytics  "cnpg.io/cluster=analytics-db"
pod_check "flink-jobmanager"   analytics  "app=flink-jobmanager"
pod_check "flink-taskmanager"  analytics  "app=flink-taskmanager"
pod_check "superset"           analytics  "app=superset"
pod_check "keycloak"           identity   "app=keycloak"
pod_check "keycloak-db"        identity   "cnpg.io/cluster=keycloak-db"
pod_check "redis"              infra      "app=redis"
pod_check "kafka"              infra      "app=kafka"
pod_check "debezium-ecom"      infra      "app=debezium-server-ecom"
pod_check "debezium-inventory" infra      "app=debezium-server-inventory"
pod_check "pgadmin"            infra      "app=pgadmin"
pod_check "kiali"              istio-system "app=kiali"

echo ""
# 2. CNPG cluster health (replaces PVC checks — CNPG manages its own PVCs)
info "Checking CNPG cluster health..."
for cluster_ns in "ecom-db:ecom" "inventory-db:inventory" "analytics-db:analytics" "keycloak-db:identity"; do
  cluster="${cluster_ns%%:*}"
  ns="${cluster_ns##*:}"
  HEALTHY=$(kubectl get cluster "$cluster" -n "$ns" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")
  [[ "$HEALTHY" == "Cluster in healthy state" ]] \
    && ok "[cnpg] $cluster healthy" \
    || fail "[cnpg] $cluster phase=$HEALTHY"
done

echo ""
# 3. HTTP endpoints
info "Checking HTTP endpoints..."
http_check "Keycloak OIDC"        "https://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration"
http_check "UI catalog"           "https://myecom.net:30000/"
http_check "ecom /books"          "https://api.service.net:30000/ecom/books"
http_check "ecom /books/search"   "https://api.service.net:30000/ecom/books/search?q=python"
http_check "ecom /cart (unauth→401)" "https://api.service.net:30000/ecom/cart" "401"
http_check "inventory /health"    "https://api.service.net:30000/inven/health"
http_check "PgAdmin"              "http://localhost:31111/misc/ping"
http_check "Superset /health"     "http://localhost:32000/health"
http_check "Kiali (NodePort)"     "http://localhost:32100/kiali/api/status"

echo ""
# 4. Database table checks
info "Checking database schemas and data..."
db_table_check "ecom-db"      ecom      "ecom-db"      "ecomdb"      "books"
db_table_check "inventory-db" inventory "inventory-db" "inventorydb" "inventory"
db_table_check "analytics-db" analytics "analytics-db" "analyticsdb" "fact_orders"
db_table_check "analytics-db" analytics "analytics-db" "analyticsdb" "dim_books"

echo ""
# 5. Kafka topics
info "Checking Kafka topics..."
for topic in order.created inventory.updated \
  ecom-connector.public.books ecom-connector.public.orders ecom-connector.public.order_items \
  inventory-connector.public.inventory; do
  EXISTS=$(kubectl exec -n infra deploy/kafka -- \
    kafka-topics --bootstrap-server localhost:9092 --describe --topic "$topic" 2>/dev/null \
    | grep -c "Topic:" || echo "0")
  [[ "$EXISTS" -ge 1 ]] \
    && ok "[kafka] topic $topic exists" \
    || fail "[kafka] topic $topic missing"
done

echo ""
# 6. Debezium Server health (Debezium Server uses /q/health, not connector REST API)
info "Checking Debezium Server health..."
for svc_port in "ecom:32300" "inventory:32301"; do
  svc="${svc_port%%:*}"
  port="${svc_port##*:}"
  STATUS=$(curl -s --max-time 10 "http://localhost:${port}/q/health" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','UNKNOWN'))" 2>/dev/null \
    || echo "UNKNOWN")
  [[ "$STATUS" == "UP" ]] \
    && ok "[debezium] debezium-server-$svc UP" \
    || fail "[debezium] debezium-server-$svc status=$STATUS"
done

echo ""
# 7. Kiali Prometheus ExternalName alias
info "Checking Kiali Prometheus connection..."
PROMETHEUS_ALIAS=$(kubectl get svc prometheus -n istio-system \
  -o jsonpath='{.spec.externalName}' 2>/dev/null || echo "missing")
[[ "$PROMETHEUS_ALIAS" == "prometheus.observability.svc.cluster.local" ]] \
  && ok "[kiali] prometheus ExternalName alias configured" \
  || fail "[kiali] prometheus alias missing or wrong (got: ${PROMETHEUS_ALIAS})"

echo ""
echo "════════════════════════════════════════"
echo "  Results: ${PASS} passed, ${FAIL} failed"
echo "════════════════════════════════════════"
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}✔ All sanity checks passed${NC}"
else
  echo -e "${RED}✘ ${FAIL} check(s) failed — review above${NC}"
  exit 1
fi
