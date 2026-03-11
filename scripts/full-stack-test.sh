#!/usr/bin/env bash
# scripts/full-stack-test.sh
# Comprehensive full-stack integration test for the BookStore platform.
# Tears down, bootstraps fresh, deploys cert-dashboard, and runs ALL tests.
# Idempotent — safe to run multiple times.
#
# Usage:
#   bash scripts/full-stack-test.sh                     # full pipeline
#   bash scripts/full-stack-test.sh --skip-bootstrap    # skip teardown+bootstrap, test existing cluster
#   bash scripts/full-stack-test.sh --skip-e2e          # skip Playwright E2E tests
#   bash scripts/full-stack-test.sh --yes               # auto-confirm teardown
#   bash scripts/full-stack-test.sh --skip-bootstrap --skip-e2e   # infra + smoke only

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="/tmp/full-stack-test"
mkdir -p "$LOG_DIR"

# ── Colors & Logging ──────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${GREEN}==>${NC} $*"; }
warn()    { echo -e "${YELLOW}WARN:${NC} $*"; }
err()     { echo -e "${RED}ERROR:${NC} $*" >&2; }
section() { echo -e "\n${CYAN}${BOLD}━━━ $* ━━━${NC}"; }
pass()    { echo -e "  ${GREEN}PASS${NC} $*"; ((TOTAL_PASSED++)) || true; ((SECTION_PASSED++)) || true; }
fail()    { echo -e "  ${RED}FAIL${NC} $*"; ((TOTAL_FAILED++)) || true; ((SECTION_FAILED++)) || true; }

# ── Counters ──────────────────────────────────────────────────────────────
TOTAL_PASSED=0
TOTAL_FAILED=0
SECTION_PASSED=0
SECTION_FAILED=0
SECTION_RESULTS=()

begin_section() {
  SECTION_PASSED=0
  SECTION_FAILED=0
  SECTION_START=$SECONDS
}

end_section() {
  local name=$1
  local elapsed=$(( SECONDS - SECTION_START ))
  local status="PASS"
  [[ $SECTION_FAILED -gt 0 ]] && status="FAIL"
  SECTION_RESULTS+=("$(printf "%-30s %s  %d passed, %d failed  (%ds)" "$name" "$status" "$SECTION_PASSED" "$SECTION_FAILED" "$elapsed")")
}

# ── Timeout wrapper (macOS lacks GNU timeout) ───────────────────────────
# Prefers GNU timeout, then gtimeout (Homebrew coreutils), then a bash
# fallback that spawns the command and kills it after N seconds.
_timeout() {
  local secs=$1; shift
  if command -v timeout &>/dev/null; then
    timeout "$secs" "$@"
  elif command -v gtimeout &>/dev/null; then
    gtimeout "$secs" "$@"
  else
    # Pure-bash fallback: run in background, kill after deadline
    "$@" &
    local pid=$!
    ( sleep "$secs" && kill "$pid" 2>/dev/null ) &
    local watchdog=$!
    if wait "$pid" 2>/dev/null; then
      kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null
      return 0
    else
      local rc=$?
      kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null
      return $rc
    fi
  fi
}

# ── Helpers ───────────────────────────────────────────────────────────────
http_check() {
  local label=$1 url=$2 expected=${3:-200}
  local code
  code=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 15 "$url" 2>/dev/null || echo "000")
  [[ "$code" == "$expected" ]] && pass "[$label] $url -> $code" || fail "[$label] $url -> expected=$expected actual=$code"
}

http_check_any() {
  local label=$1 url=$2 expected_codes=$3
  local code
  code=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 15 "$url" 2>/dev/null || echo "000")
  for exp in $expected_codes; do
    [[ "$code" == "$exp" ]] && { pass "[$label] $url -> $code"; return; }
  done
  fail "[$label] $url -> expected=$expected_codes actual=$code"
}

pod_check() {
  local label=$1 ns=$2 selector=$3
  local phase
  phase=$(kubectl get pods -n "$ns" -l "$selector" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "Missing")
  [[ "$phase" == "Running" ]] && pass "[pod] $label Running" || fail "[pod] $label phase=$phase"
}

job_check() {
  local label=$1 ns=$2 selector=$3
  local status
  status=$(kubectl get pods -n "$ns" -l "$selector" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "Missing")
  [[ "$status" == "Succeeded" || "$status" == "Running" ]] \
    && pass "[pod] $label $status" \
    || fail "[pod] $label phase=$status"
}

# ── Parse Arguments ───────────────────────────────────────────────────────
SKIP_BOOTSTRAP=false
SKIP_E2E=false
YES=false

for arg in "$@"; do
  case "$arg" in
    --skip-bootstrap) SKIP_BOOTSTRAP=true ;;
    --skip-e2e)       SKIP_E2E=true ;;
    --yes|-y)         YES=true ;;
    -h|--help)
      echo "Usage: $0 [--skip-bootstrap] [--skip-e2e] [--yes|-y]"
      echo ""
      echo "  (no flags)        Full pipeline: teardown -> bootstrap -> cert-dashboard -> all tests"
      echo "  --skip-bootstrap  Skip teardown+bootstrap, run tests against existing cluster"
      echo "  --skip-e2e        Skip Playwright E2E tests (infra + smoke only)"
      echo "  --yes / -y        Auto-confirm teardown (no prompts)"
      exit 0
      ;;
    *) err "Unknown flag: $arg"; exit 1 ;;
  esac
done

GLOBAL_START=$SECONDS

echo ""
echo -e "${CYAN}${BOLD}=======================================================${NC}"
echo -e "${CYAN}${BOLD}  BookStore Full-Stack Integration Test${NC}"
echo -e "${CYAN}${BOLD}=======================================================${NC}"
echo ""
echo "  Log directory: $LOG_DIR"
echo "  Skip bootstrap: $SKIP_BOOTSTRAP"
echo "  Skip E2E:       $SKIP_E2E"
echo ""

# ══════════════════════════════════════════════════════════════════════════
# Section 1: Pre-flight Checks
# ══════════════════════════════════════════════════════════════════════════
section "1. Pre-flight Checks"
begin_section

_check_cmd() {
  if command -v "$1" &>/dev/null; then
    pass "$1 found: $(command -v "$1")"
  else
    fail "$1 not found — install: $2"
  fi
}

_check_cmd docker   "https://docs.docker.com/get-docker/"
_check_cmd kubectl  "https://kubernetes.io/docs/tasks/tools/"
_check_cmd kind     "https://kind.sigs.k8s.io/"
_check_cmd node     "https://nodejs.org/"
_check_cmd npm      "https://nodejs.org/"

# Docker must be running
if docker info &>/dev/null; then
  pass "Docker daemon running"
else
  fail "Docker daemon not running"
  err "Start Docker Desktop and try again."
  exit 1
fi

end_section "Pre-flight"

# ══════════════════════════════════════════════════════════════════════════
# Section 2: Fresh Bootstrap
# ══════════════════════════════════════════════════════════════════════════
section "2. Fresh Bootstrap"
begin_section

if [[ "$SKIP_BOOTSTRAP" == "true" ]]; then
  info "Skipping bootstrap (--skip-bootstrap)"
  # Verify cluster exists
  if kind get clusters 2>/dev/null | grep -q "^bookstore$"; then
    pass "Kind cluster 'bookstore' exists"
  else
    fail "Kind cluster 'bookstore' not found — cannot skip bootstrap"
    err "Run without --skip-bootstrap or create cluster with: bash scripts/up.sh"
    exit 1
  fi
else
  if [[ "$YES" == "false" ]]; then
    echo ""
    echo -e "${YELLOW}This will TEAR DOWN the existing cluster and rebuild from scratch.${NC}"
    echo -n "Continue? [y/N] "
    read -r confirm
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
      info "Aborted."
      exit 0
    fi
  fi

  info "Tearing down existing cluster..."
  bash "${REPO_ROOT}/scripts/down.sh" --all --yes > "${LOG_DIR}/down.log" 2>&1 \
    && pass "Teardown complete" \
    || { warn "Teardown had warnings (may be first run)"; pass "Teardown complete (no prior cluster)"; }

  info "Starting fresh bootstrap (this may take 15-25 minutes)..."
  info "Log: ${LOG_DIR}/bootstrap.log"
  if bash "${REPO_ROOT}/scripts/up.sh" --fresh --yes > "${LOG_DIR}/bootstrap.log" 2>&1; then
    pass "Fresh bootstrap completed successfully"
  else
    fail "Fresh bootstrap failed — check ${LOG_DIR}/bootstrap.log"
    err "Bootstrap failed. Review log and fix before continuing."
    # Continue to collect more info rather than exit
  fi
fi

end_section "Bootstrap"

# ══════════════════════════════════════════════════════════════════════════
# Section 3: Cert Dashboard Deploy
# ══════════════════════════════════════════════════════════════════════════
section "3. Cert Dashboard Deploy"
begin_section

if [[ -f "${REPO_ROOT}/scripts/cert-dashboard-up.sh" ]]; then
  # Skip deploy if cert-dashboard pods are already running
  _cd_running=$(kubectl get pods -n cert-dashboard -l app=cert-dashboard \
    --field-selector=status.phase=Running -o name 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$_cd_running" -ge 1 ]] && [[ "$SKIP_BOOTSTRAP" == "true" ]]; then
    info "Cert dashboard already running — skipping deploy"
    pass "Cert dashboard already deployed"
  else
    info "Deploying cert-dashboard operator..."
    info "Log: ${LOG_DIR}/cert-dashboard.log"
    if bash "${REPO_ROOT}/scripts/cert-dashboard-up.sh" --skip-test > "${LOG_DIR}/cert-dashboard.log" 2>&1; then
      pass "Cert dashboard deployed successfully"
    else
      fail "Cert dashboard deploy failed — check ${LOG_DIR}/cert-dashboard.log"
    fi
  fi
else
  warn "cert-dashboard-up.sh not found — skipping"
fi

end_section "Cert Dashboard"

# ══════════════════════════════════════════════════════════════════════════
# Section 4: Cluster Health
# ══════════════════════════════════════════════════════════════════════════
section "4. Cluster Health — All Pods"
begin_section

info "Checking pods across all namespaces..."

# ecom namespace
pod_check "ecom-service"     ecom       "app=ecom-service"
pod_check "ecom-db"          ecom       "cnpg.io/cluster=ecom-db,cnpg.io/instanceRole=primary"
pod_check "ui-service"       ecom       "app=ui-service"

# inventory namespace
pod_check "inventory-service" inventory  "app=inventory-service"
pod_check "inventory-db"      inventory  "cnpg.io/cluster=inventory-db,cnpg.io/instanceRole=primary"

# identity namespace
pod_check "keycloak"         identity   "app=keycloak"
pod_check "keycloak-db"      identity   "cnpg.io/cluster=keycloak-db,cnpg.io/instanceRole=primary"

# infra namespace
pod_check "kafka"            infra      "app=kafka"
pod_check "redis"            infra      "app=redis"
pod_check "debezium-ecom"    infra      "app=debezium-server-ecom"
pod_check "debezium-inv"     infra      "app=debezium-server-inventory"
pod_check "pgadmin"          infra      "app=pgadmin"

# analytics namespace
pod_check "analytics-db"     analytics  "cnpg.io/cluster=analytics-db,cnpg.io/instanceRole=primary"
pod_check "flink-jm"         analytics  "app=flink-jobmanager"
pod_check "flink-tm"         analytics  "app=flink-taskmanager"
pod_check "superset"         analytics  "app=superset"

# observability namespace
pod_check "prometheus"       observability "app=prometheus"

# istio-system
pod_check "kiali"            istio-system  "app=kiali"

# otel namespace (if exists)
if kubectl get ns otel &>/dev/null; then
  pod_check "otel-collector" otel "app=otel-collector"
fi

# cert-dashboard namespace (if exists)
if kubectl get ns cert-dashboard &>/dev/null; then
  pod_check "cert-dashboard-operator" cert-dashboard "app=cert-dashboard-operator"
  pod_check "cert-dashboard"          cert-dashboard "app=cert-dashboard"
fi

end_section "Cluster Health"

# ══════════════════════════════════════════════════════════════════════════
# Section 5: Route Verification
# ══════════════════════════════════════════════════════════════════════════
section "5. Route Verification — All Endpoints"
begin_section

info "Testing gateway routes (HTTPS, port 30000)..."
http_check "UI catalog"         "https://myecom.net:30000/"
http_check "Keycloak OIDC"      "https://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration"
http_check "ecom /books"        "https://api.service.net:30000/ecom/books"
http_check "ecom /books/search" "https://api.service.net:30000/ecom/books/search?q=kafka"
http_check "ecom /cart (401)"   "https://api.service.net:30000/ecom/cart" "401"
http_check "inventory /health"  "https://api.service.net:30000/inven/health"
http_check "HTTP->HTTPS redirect" "http://myecom.net:30080/" "301"

info "Testing tool NodePorts (HTTP)..."
http_check "PgAdmin"            "http://localhost:31111/misc/ping"
http_check "Superset /health"   "http://localhost:32000/health"
http_check "Kiali"              "http://localhost:32100/kiali/api/status"
http_check "Flink dashboard"    "http://localhost:32200/config"
http_check "Debezium ecom"      "http://localhost:32300/q/health"
http_check "Debezium inventory" "http://localhost:32301/q/health"
http_check_any "Keycloak admin" "http://localhost:32400/admin/" "200 302 303"

# Cert dashboard (if deployed)
if kubectl get ns cert-dashboard &>/dev/null; then
  http_check "Cert dashboard"   "http://localhost:32600/healthz"
fi

end_section "Route Verification"

# ══════════════════════════════════════════════════════════════════════════
# Section 6: API Tests
# ══════════════════════════════════════════════════════════════════════════
section "6. API Tests"
begin_section

# ecom books count
info "Testing ecom-service API..."
BOOK_COUNT=$(curl -sk --max-time 15 "https://api.service.net:30000/ecom/books" 2>/dev/null \
  | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
[[ "$BOOK_COUNT" -ge 10 ]] \
  && pass "[ecom] GET /books returned $BOOK_COUNT books (>= 10)" \
  || fail "[ecom] GET /books returned $BOOK_COUNT books (expected >= 10)"

# inventory bulk stock
info "Testing inventory-service API..."
STOCK_CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 15 \
  "https://api.service.net:30000/inven/stock/bulk?book_ids=00000000-0000-0000-0000-000000000001" 2>/dev/null || echo "000")
[[ "$STOCK_CODE" == "200" ]] \
  && pass "[inventory] GET /stock/bulk -> 200" \
  || fail "[inventory] GET /stock/bulk -> $STOCK_CODE (expected 200)"

# admin API access control (no token -> 401)
http_check "ecom admin no-token" "https://api.service.net:30000/ecom/admin/books" "401"
http_check_any "inven admin no-token" "https://api.service.net:30000/inven/admin/stock" "401 403"

# cert-dashboard API (if deployed)
if kubectl get ns cert-dashboard &>/dev/null; then
  info "Testing cert-dashboard API..."
  http_check "cert /healthz"     "http://localhost:32600/healthz"
  http_check "cert /metrics"     "http://localhost:32600/metrics"

  CERT_COUNT=$(curl -s --max-time 10 "http://localhost:32600/api/certs" 2>/dev/null \
    | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
  [[ "$CERT_COUNT" -gt 0 ]] \
    && pass "[cert-dashboard] /api/certs returned $CERT_COUNT certificates" \
    || fail "[cert-dashboard] /api/certs returned 0 certificates"

  # POST /api/renew without token -> 401
  RENEW_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    -X POST "http://localhost:32600/api/renew" 2>/dev/null || echo "000")
  [[ "$RENEW_CODE" == "401" ]] \
    && pass "[cert-dashboard] POST /api/renew no-token -> 401" \
    || fail "[cert-dashboard] POST /api/renew no-token -> $RENEW_CODE (expected 401)"
fi

end_section "API Tests"

# ══════════════════════════════════════════════════════════════════════════
# Section 7: CDC Pipeline
# ══════════════════════════════════════════════════════════════════════════
section "7. CDC Pipeline Verification"
begin_section

# Debezium Server health
info "Checking Debezium Server health..."
for pair in "ecom:http://localhost:32300" "inventory:http://localhost:32301"; do
  name="${pair%%:*}"
  url="${pair#*:}"
  STATUS=$(curl -s --max-time 10 "${url}/q/health" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','UNKNOWN'))" 2>/dev/null \
    || echo "UNKNOWN")
  [[ "$STATUS" == "UP" ]] \
    && pass "[Debezium] $name health=UP" \
    || fail "[Debezium] $name health=$STATUS"
done

# Flink jobs count
info "Checking Flink streaming jobs..."
FLINK_JOBS=$(curl -s --max-time 10 "http://localhost:32200/jobs/overview" 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for j in d.get('jobs',[]) if j['state']=='RUNNING'))" 2>/dev/null \
  || echo "0")
[[ "$FLINK_JOBS" -eq 4 ]] \
  && pass "[Flink] $FLINK_JOBS/4 streaming jobs RUNNING" \
  || fail "[Flink] $FLINK_JOBS/4 streaming jobs RUNNING (expected 4)"

# Analytics DB tables
info "Checking analytics DB tables..."
ANALYTICS_POD=$(kubectl get pod -n analytics -l "cnpg.io/cluster=analytics-db,cnpg.io/instanceRole=primary" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [[ -n "$ANALYTICS_POD" ]]; then
  for table in fact_orders fact_order_items dim_books fact_inventory; do
    EXISTS=$(kubectl exec -n analytics "$ANALYTICS_POD" -- \
      sh -c "PGPASSWORD=\$POSTGRES_PASSWORD psql -U \$POSTGRES_USER -d analyticsdb -tAc \
        \"SELECT COUNT(*) FROM information_schema.tables WHERE table_name='$table'\"" 2>/dev/null || echo "0")
    [[ "${EXISTS// /}" == "1" ]] \
      && pass "[analytics-db] table '$table' exists" \
      || fail "[analytics-db] table '$table' missing"
  done
else
  fail "[analytics-db] pod not found"
fi

# Kafka topics
info "Checking Kafka CDC topics..."
for topic in order.created inventory.updated \
  ecom-connector.public.books ecom-connector.public.orders ecom-connector.public.order_items \
  inventory-connector.public.inventory; do
  EXISTS=$(kubectl exec -n infra deploy/kafka -- \
    kafka-topics --bootstrap-server localhost:9092 --describe --topic "$topic" 2>/dev/null \
    | grep -c "Topic:" || echo "0")
  [[ "$EXISTS" -ge 1 ]] \
    && pass "[Kafka] topic '$topic' exists" \
    || fail "[Kafka] topic '$topic' missing"
done

end_section "CDC Pipeline"

# ══════════════════════════════════════════════════════════════════════════
# Section 8: Smoke Test
# ══════════════════════════════════════════════════════════════════════════
section "8. Smoke Test"
begin_section

info "Running smoke-test.sh..."
info "Log: ${LOG_DIR}/smoke-test.log"
if bash "${REPO_ROOT}/scripts/smoke-test.sh" > "${LOG_DIR}/smoke-test.log" 2>&1; then
  pass "Smoke test passed"
else
  fail "Smoke test failed — check ${LOG_DIR}/smoke-test.log"
fi

end_section "Smoke Test"

# ══════════════════════════════════════════════════════════════════════════
# Section 9: E2E Tests (Playwright)
# ══════════════════════════════════════════════════════════════════════════
section "9. E2E Tests (Playwright)"
begin_section

if [[ "$SKIP_E2E" == "true" ]]; then
  info "Skipping E2E tests (--skip-e2e)"
else
  E2E_DIR="${REPO_ROOT}/e2e"

  info "Installing E2E dependencies..."
  (cd "$E2E_DIR" && npm install --silent 2>&1) > "${LOG_DIR}/e2e-install.log" 2>&1

  info "Installing Playwright browsers..."
  (cd "$E2E_DIR" && npx playwright install chromium 2>&1) >> "${LOG_DIR}/e2e-install.log" 2>&1

  info "Running ALL Playwright E2E tests (timeout: 600s)..."
  info "Log: ${LOG_DIR}/e2e.log"

  E2E_EXIT=0
  (cd "$E2E_DIR" && _timeout 600 npm run test 2>&1) > "${LOG_DIR}/e2e.log" 2>&1 || E2E_EXIT=$?

  # Parse results from log
  E2E_PASSED=$(grep -Eo '[0-9]+ passed' "${LOG_DIR}/e2e.log" 2>/dev/null | tail -1 | grep -Eo '[0-9]+' || echo "0")
  E2E_FAILED_COUNT=$(grep -Eo '[0-9]+ failed' "${LOG_DIR}/e2e.log" 2>/dev/null | tail -1 | grep -Eo '[0-9]+' || echo "0")
  E2E_FLAKY=$(grep -Eo '[0-9]+ flaky' "${LOG_DIR}/e2e.log" 2>/dev/null | tail -1 | grep -Eo '[0-9]+' || echo "0")

  if [[ "$E2E_EXIT" -eq 0 ]]; then
    pass "E2E tests: ${E2E_PASSED} passed, ${E2E_FAILED_COUNT} failed, ${E2E_FLAKY} flaky"
  else
    fail "E2E tests: ${E2E_PASSED} passed, ${E2E_FAILED_COUNT} failed, ${E2E_FLAKY} flaky (exit=$E2E_EXIT)"
  fi
fi

end_section "E2E Tests"

# ══════════════════════════════════════════════════════════════════════════
# Section 10: Summary
# ══════════════════════════════════════════════════════════════════════════
TOTAL_ELAPSED=$(( SECONDS - GLOBAL_START ))
TOTAL_MINS=$(( TOTAL_ELAPSED / 60 ))
TOTAL_SECS=$(( TOTAL_ELAPSED % 60 ))

echo ""
echo -e "${CYAN}${BOLD}=======================================================${NC}"
echo -e "${CYAN}${BOLD}  Full-Stack Test Summary${NC}"
echo -e "${CYAN}${BOLD}=======================================================${NC}"
echo ""

for result in "${SECTION_RESULTS[@]}"; do
  if echo "$result" | grep -q "FAIL"; then
    echo -e "  ${RED}$result${NC}"
  else
    echo -e "  ${GREEN}$result${NC}"
  fi
done

echo ""
echo -e "  ${BOLD}Total:${NC}  ${GREEN}${TOTAL_PASSED} passed${NC}, ${RED}${TOTAL_FAILED} failed${NC}"
echo -e "  ${BOLD}Time:${NC}   ${TOTAL_MINS}m ${TOTAL_SECS}s"
echo ""
echo -e "  ${BOLD}Log files:${NC}"
for f in "${LOG_DIR}"/*.log; do
  [[ -f "$f" ]] && echo "    $f"
done
echo ""

if [[ $TOTAL_FAILED -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}ALL TESTS PASSED${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}${TOTAL_FAILED} TEST(S) FAILED${NC}"
  exit 1
fi
