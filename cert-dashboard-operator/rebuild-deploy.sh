#!/usr/bin/env bash
# cert-dashboard-operator/rebuild-deploy.sh
#
# Rebuilds the operator & dashboard images and redeploys to the kind cluster.
# Handles the full lifecycle: build → kind load → force pod restart → wait for ready → verify.
#
# Usage:
#   bash rebuild-deploy.sh              # rebuild + redeploy (no tests)
#   bash rebuild-deploy.sh --test       # run Go tests before building
#   bash rebuild-deploy.sh --build-only # build images only, don't deploy
#   bash rebuild-deploy.sh --deploy-only # skip build, just restart pods to pick up loaded images
#   bash rebuild-deploy.sh --verify     # skip build+deploy, just run verification checks
#
# Prerequisites:
#   - Docker running
#   - kind cluster "bookstore" exists
#   - cert-dashboard namespace and CRD already applied (use scripts/cert-dashboard-up.sh for first-time setup)
#
# Why force-delete pods?
#   imagePullPolicy: IfNotPresent with :latest tag means Kubernetes won't re-pull
#   the image after `kind load`. Deleting the pod forces a fresh container creation
#   that picks up the newly loaded image.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
KIND_CLUSTER="bookstore"
DASHBOARD_NS="cert-dashboard"
DASHBOARD_PORT=32600

OPERATOR_IMAGE="bookstore/cert-dashboard-operator:latest"
DASHBOARD_IMAGE="bookstore/cert-dashboard:latest"

# ── Colors & Logging ──────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${GREEN}==>${NC} $*"; }
warn()    { echo -e "${YELLOW}WARN:${NC} $*"; }
err()     { echo -e "${RED}ERROR:${NC} $*" >&2; }
section() { echo -e "\n${CYAN}${BOLD}━━━ $* ━━━${NC}"; }
pass()    { echo -e "  ${GREEN}✓${NC} $*"; }
fail()    { echo -e "  ${RED}✗${NC} $*"; }

# ── Parse Arguments ───────────────────────────────────────────────────────
RUN_TESTS=false
BUILD_ONLY=false
DEPLOY_ONLY=false
VERIFY_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --test)        RUN_TESTS=true ;;
    --build-only)  BUILD_ONLY=true ;;
    --deploy-only) DEPLOY_ONLY=true ;;
    --verify)      VERIFY_ONLY=true ;;
    -h|--help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  (no flags)      Rebuild images + redeploy to kind cluster"
      echo "  --test          Run Go tests before building"
      echo "  --build-only    Build Docker images only (no deploy)"
      echo "  --deploy-only   Skip build, restart pods to pick up pre-loaded images"
      echo "  --verify        Run verification checks only (no build/deploy)"
      echo ""
      echo "Examples:"
      echo "  $0                   # Quick rebuild + redeploy"
      echo "  $0 --test            # Test, then rebuild + redeploy"
      echo "  $0 --deploy-only     # Restart pods (after manual docker build + kind load)"
      exit 0
      ;;
    *)
      err "Unknown flag: $arg"
      echo "Run '$0 --help' for usage"
      exit 1
      ;;
  esac
done

START_TIME=$SECONDS

# ── Prerequisites ─────────────────────────────────────────────────────────
section "Prerequisites"

for cmd in docker kubectl kind; do
  if ! command -v "$cmd" &>/dev/null; then
    err "$cmd is required but not found"
    exit 1
  fi
done
pass "Required tools: docker, kubectl, kind"

if ! docker info &>/dev/null; then
  err "Docker daemon not running"
  exit 1
fi
pass "Docker daemon running"

if ! kind get clusters 2>/dev/null | grep -q "^${KIND_CLUSTER}$"; then
  err "Kind cluster '${KIND_CLUSTER}' not found. Run 'bash scripts/up.sh' first."
  exit 1
fi
pass "Kind cluster '${KIND_CLUSTER}' exists"

if ! kubectl get ns "${DASHBOARD_NS}" &>/dev/null; then
  err "Namespace '${DASHBOARD_NS}' not found. Run 'bash scripts/cert-dashboard-up.sh' for first-time setup."
  exit 1
fi
pass "Namespace '${DASHBOARD_NS}' exists"

# ── Verify Only Mode ─────────────────────────────────────────────────────
if [[ "$VERIFY_ONLY" == "true" ]]; then
  # Jump straight to verification
  source /dev/stdin <<'VERIFY_FUNC'
  true  # placeholder — verification runs below
VERIFY_FUNC
fi

# ── Tests (optional) ─────────────────────────────────────────────────────
if [[ "$RUN_TESTS" == "true" && "$DEPLOY_ONLY" == "false" && "$VERIFY_ONLY" == "false" ]]; then
  section "Running Tests"
  cd "${SCRIPT_DIR}"

  info "go vet..."
  go vet ./...
  pass "go vet passed"

  info "Running unit + integration tests..."
  if make test 2>&1 | tee /tmp/cert-op-rebuild-test.log | tail -10; then
    pass "All tests passed"
  else
    fail "Tests failed — aborting rebuild"
    cat /tmp/cert-op-rebuild-test.log | tail -20
    exit 1
  fi

  cd "${REPO_ROOT}"
fi

# ── Build ─────────────────────────────────────────────────────────────────
if [[ "$DEPLOY_ONLY" == "false" && "$VERIFY_ONLY" == "false" ]]; then
  section "Building Docker Images"

  info "Building ${OPERATOR_IMAGE} (no-cache)..."
  docker build --no-cache -t "${OPERATOR_IMAGE}" "${SCRIPT_DIR}" 2>&1 | tail -5
  pass "Operator image built"

  # The operator creates a dashboard Deployment using DASHBOARD_IMAGE.
  # It's the same binary (multi-binary Dockerfile), just a different tag.
  info "Tagging ${DASHBOARD_IMAGE}..."
  docker tag "${OPERATOR_IMAGE}" "${DASHBOARD_IMAGE}"
  pass "Dashboard image tagged"

  IMG_SIZE=$(docker images "${OPERATOR_IMAGE}" --format "{{.Size}}")
  info "Image size: ${IMG_SIZE}"

  section "Loading Images into Kind"

  # Remove old images from kind nodes to avoid stale cache with :latest tag
  info "Clearing old images from kind nodes..."
  for node in $(kind get nodes --name "${KIND_CLUSTER}" 2>/dev/null); do
    docker exec "$node" crictl rmi "docker.io/${OPERATOR_IMAGE}" "docker.io/${DASHBOARD_IMAGE}" 2>/dev/null || true
  done
  pass "Old images cleared"

  info "Loading ${OPERATOR_IMAGE}..."
  kind load docker-image "${OPERATOR_IMAGE}" --name "${KIND_CLUSTER}" 2>&1
  pass "Operator image loaded"

  info "Loading ${DASHBOARD_IMAGE}..."
  kind load docker-image "${DASHBOARD_IMAGE}" --name "${KIND_CLUSTER}" 2>&1
  pass "Dashboard image loaded"
fi

if [[ "$BUILD_ONLY" == "true" ]]; then
  ELAPSED=$((SECONDS - START_TIME))
  info "Build-only complete in ${ELAPSED}s"
  exit 0
fi

# ── Redeploy ──────────────────────────────────────────────────────────────
if [[ "$VERIFY_ONLY" == "false" ]]; then
  section "Redeploying"

  # Update CRD (picks up schema changes)
  info "Updating CRD..."
  kubectl apply -f "${SCRIPT_DIR}/config/crd/bases/"
  pass "CRD updated"

  # Re-apply operator RBAC from cert-dashboard-up.sh (picks up new permissions like tokenreviews)
  # This is the operator SA's own ClusterRole — must include all permissions it grants to child resources
  info "Updating operator ClusterRole..."
  kubectl apply -f - <<'OPRBAC'
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cert-dashboard-operator
rules:
  - apiGroups: ["certs.bookstore.io"]
    resources: ["certdashboards", "certdashboards/status", "certdashboards/finalizers"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["services", "serviceaccounts"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["clusterroles", "clusterrolebindings"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["cert-manager.io"]
    resources: ["certificates", "certificaterequests", "clusterissuers", "issuers"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "watch", "delete"]
  - apiGroups: ["authentication.k8s.io"]
    resources: ["tokenreviews"]
    verbs: ["create"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create", "patch"]
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
OPRBAC
  pass "Operator ClusterRole updated"

  # Force-delete operator pod to pick up new image
  info "Restarting operator pod..."
  kubectl delete pods -n "${DASHBOARD_NS}" -l app=cert-dashboard-operator --force --grace-period=0 2>/dev/null || true
  info "Waiting for operator pod to be ready..."
  kubectl rollout status deploy/cert-dashboard-operator -n "${DASHBOARD_NS}" --timeout=120s
  pass "Operator pod restarted"

  # Wait for operator to reconcile and (re)create the dashboard deployment
  info "Waiting for operator to reconcile..."
  sleep 3

  # Force-delete dashboard pod to pick up new image
  info "Restarting dashboard pod..."
  kubectl delete pods -n "${DASHBOARD_NS}" -l app=cert-dashboard --force --grace-period=0 2>/dev/null || true

  # Wait for dashboard deployment to exist (operator creates it)
  for i in $(seq 1 30); do
    if kubectl get deploy bookstore-certs -n "${DASHBOARD_NS}" &>/dev/null; then
      break
    fi
    sleep 2
  done

  info "Waiting for dashboard pod to be ready..."
  kubectl rollout status deploy/bookstore-certs -n "${DASHBOARD_NS}" --timeout=120s
  pass "Dashboard pod restarted"

  # Update the ClusterRole managed by the operator (force reconcile by touching CR)
  info "Triggering operator reconciliation for RBAC update..."
  kubectl annotate certdashboard bookstore-certs -n "${DASHBOARD_NS}" \
    "rebuild-deploy/last-run=$(date -u +%Y-%m-%dT%H:%M:%SZ)" --overwrite 2>/dev/null || true
  sleep 3
  pass "Reconciliation triggered"
fi

# ── Verification ──────────────────────────────────────────────────────────
section "Verification"

VERIFY_PASSED=0
VERIFY_FAILED=0

_verify() {
  local desc="$1"
  shift
  if "$@" &>/dev/null; then
    pass "$desc"
    ((VERIFY_PASSED++))
  else
    fail "$desc"
    ((VERIFY_FAILED++))
  fi
}

# Pods running
_verify "Operator pod running" \
  kubectl get pods -n "${DASHBOARD_NS}" -l app=cert-dashboard-operator \
    --field-selector=status.phase=Running -o name

_verify "Dashboard pod running" \
  kubectl get pods -n "${DASHBOARD_NS}" -l app=cert-dashboard \
    --field-selector=status.phase=Running -o name

# CR status
CR_READY=$(kubectl get certdashboard bookstore-certs -n "${DASHBOARD_NS}" \
  -o jsonpath='{.status.ready}' 2>/dev/null || echo "false")
if [[ "$CR_READY" == "true" ]]; then
  pass "CertDashboard CR ready"
  ((VERIFY_PASSED++))
else
  fail "CertDashboard CR not ready (${CR_READY})"
  ((VERIFY_FAILED++))
fi

# Health endpoint
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "http://localhost:${DASHBOARD_PORT}/healthz" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "200" ]]; then
  pass "Health: http://localhost:${DASHBOARD_PORT}/healthz → 200"
  ((VERIFY_PASSED++))
else
  fail "Health endpoint returned ${HTTP_CODE}"
  ((VERIFY_FAILED++))
fi

# Certs API
CERT_COUNT=$(curl -s "http://localhost:${DASHBOARD_PORT}/api/certs" 2>/dev/null \
  | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
if [[ "$CERT_COUNT" -gt 0 ]]; then
  pass "Certs API: ${CERT_COUNT} certificates found"
  ((VERIFY_PASSED++))
else
  fail "Certs API: 0 certificates"
  ((VERIFY_FAILED++))
fi

# Metrics
METRICS_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "http://localhost:${DASHBOARD_PORT}/metrics" 2>/dev/null || echo "000")
if [[ "$METRICS_CODE" == "200" ]]; then
  pass "Metrics: http://localhost:${DASHBOARD_PORT}/metrics → 200"
  ((VERIFY_PASSED++))
else
  fail "Metrics endpoint returned ${METRICS_CODE}"
  ((VERIFY_FAILED++))
fi

# ClusterRole has tokenreviews rule
TOKEN_REVIEW_RULE=$(kubectl get clusterrole cert-dashboard-bookstore-certs \
  -o jsonpath='{.rules[?(@.resources[0]=="tokenreviews")].verbs[0]}' 2>/dev/null || echo "")
if [[ "$TOKEN_REVIEW_RULE" == "create" ]]; then
  pass "ClusterRole has tokenreviews/create permission"
  ((VERIFY_PASSED++))
else
  fail "ClusterRole missing tokenreviews/create permission"
  ((VERIFY_FAILED++))
fi

# Auth endpoint (should return 401 without token)
AUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "http://localhost:${DASHBOARD_PORT}/api/renew" \
  -H "Content-Type: application/json" \
  -d '{"name":"test","namespace":"test"}' 2>/dev/null || echo "000")
if [[ "$AUTH_CODE" == "401" ]]; then
  pass "Auth: POST /api/renew without token → 401"
  ((VERIFY_PASSED++))
else
  fail "Auth: POST /api/renew without token → ${AUTH_CODE} (expected 401)"
  ((VERIFY_FAILED++))
fi

# ── Summary ───────────────────────────────────────────────────────────────
ELAPSED=$((SECONDS - START_TIME))

echo ""
section "Summary"
echo ""
echo -e "  Verification:  ${VERIFY_PASSED}/$((VERIFY_PASSED + VERIFY_FAILED)) checks passed"
if [[ "$VERIFY_FAILED" -gt 0 ]]; then
  echo -e "                 ${RED}${VERIFY_FAILED} checks failed${NC}"
fi
echo -e "  Time:          ${ELAPSED}s"
echo ""
echo -e "  ${BOLD}Dashboard:${NC}  http://localhost:${DASHBOARD_PORT}"
echo -e "  ${BOLD}Metrics:${NC}   http://localhost:${DASHBOARD_PORT}/metrics"
echo -e "  ${BOLD}Certs API:${NC} http://localhost:${DASHBOARD_PORT}/api/certs"
echo ""

kubectl get certdashboard,deploy,pods -n "${DASHBOARD_NS}" 2>/dev/null

if [[ "$VERIFY_FAILED" -gt 0 ]]; then
  echo ""
  err "${VERIFY_FAILED} verification check(s) failed"
  exit 1
fi

echo ""
info "Rebuild + redeploy complete!"
