#!/usr/bin/env bash
# scripts/cert-dashboard-up.sh
# Tests, builds, and deploys the cert-dashboard operator in a single shot.
# Idempotent — safe to run multiple times.
#
# Usage:
#   bash scripts/cert-dashboard-up.sh              # full pipeline: test → build → deploy → verify
#   bash scripts/cert-dashboard-up.sh --skip-test  # skip Go tests (faster redeploy)
#   bash scripts/cert-dashboard-up.sh --test-only  # run tests only, no build/deploy
#   bash scripts/cert-dashboard-up.sh --build-only # test + build only, no deploy
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPERATOR_DIR="${REPO_ROOT}/cert-dashboard-operator"
KIND_CLUSTER="bookstore"
DASHBOARD_NS="cert-dashboard"
DASHBOARD_PORT=32600

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
SKIP_TEST=false
TEST_ONLY=false
BUILD_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --skip-test)  SKIP_TEST=true ;;
    --test-only)  TEST_ONLY=true ;;
    --build-only) BUILD_ONLY=true ;;
    -h|--help)
      echo "Usage: $0 [--skip-test|--test-only|--build-only]"
      echo ""
      echo "  (no flags)    Full pipeline: test → build → deploy → verify"
      echo "  --skip-test   Skip Go tests (faster redeploy)"
      echo "  --test-only   Run tests only, no build/deploy"
      echo "  --build-only  Test + build only, no deploy"
      exit 0
      ;;
    *)
      err "Unknown flag: $arg"
      exit 1
      ;;
  esac
done

START_TIME=$SECONDS
TESTS_PASSED=0
TESTS_FAILED=0

# ── Prerequisites Check ──────────────────────────────────────────────────
section "1. Checking Prerequisites"

_check_cmd() {
  if command -v "$1" &>/dev/null; then
    pass "$1 found: $(command -v "$1")"
  else
    fail "$1 not found"
    err "$1 is required. Install: $2"
    exit 1
  fi
}

_check_cmd go       "https://go.dev/dl/"
_check_cmd docker   "https://docs.docker.com/get-docker/"
_check_cmd kubectl  "https://kubernetes.io/docs/tasks/tools/"
_check_cmd kind     "https://kind.sigs.k8s.io/docs/user/quick-start/#installation"

# Check Go version
GO_VERSION=$(go version | awk '{print $3}' | sed 's/go//')
info "Go version: ${GO_VERSION}"

# Check kind cluster exists (only if we plan to deploy)
if [[ "$TEST_ONLY" == "false" ]]; then
  if kind get clusters 2>/dev/null | grep -q "^${KIND_CLUSTER}$"; then
    pass "Kind cluster '${KIND_CLUSTER}' exists"
  else
    fail "Kind cluster '${KIND_CLUSTER}' not found"
    err "Run 'bash scripts/up.sh' to create the cluster first"
    exit 1
  fi
fi

# ── Test ──────────────────────────────────────────────────────────────────
if [[ "$SKIP_TEST" == "false" ]]; then
  section "2. Running Tests"
  cd "${OPERATOR_DIR}"

  # 2a. Lint
  info "Running go vet..."
  if go vet ./... 2>&1; then
    pass "go vet passed"
    ((TESTS_PASSED++))
  else
    fail "go vet failed"
    ((TESTS_FAILED++))
  fi

  # 2b. Generate manifests (ensures CRD/RBAC are up to date)
  info "Regenerating manifests..."
  make manifests generate 2>&1 | tail -3
  pass "Manifests regenerated"

  # 2c. Unit tests — webhook
  info "Running webhook tests..."
  if go test ./internal/webhook/ -v -count=1 2>&1 | tee /tmp/cert-op-webhook-test.log | tail -5; then
    WEBHOOK_COUNT=$(grep -c "^--- PASS" /tmp/cert-op-webhook-test.log || true)
    pass "Webhook tests: ${WEBHOOK_COUNT} passed"
    ((TESTS_PASSED++))
  else
    fail "Webhook tests failed"
    ((TESTS_FAILED++))
  fi

  # 2d. Unit tests — dashboard handlers + cert_watcher
  info "Running dashboard unit tests..."
  if go test ./internal/dashboard/ -v -count=1 -run 'Test' 2>&1 | tee /tmp/cert-op-dashboard-test.log | tail -5; then
    DASHBOARD_COUNT=$(grep -c "^--- PASS" /tmp/cert-op-dashboard-test.log || true)
    pass "Dashboard tests: ${DASHBOARD_COUNT} passed"
    ((TESTS_PASSED++))
  else
    fail "Dashboard tests failed"
    ((TESTS_FAILED++))
  fi

  # 2e. Controller integration tests (envtest)
  info "Running controller tests (envtest)..."
  if make test 2>&1 | tee /tmp/cert-op-controller-test.log | tail -10; then
    # Extract coverage
    CTRL_COV=$(grep "internal/controller" /tmp/cert-op-controller-test.log | awk '{print $NF}')
    DASH_COV=$(grep "internal/dashboard" /tmp/cert-op-controller-test.log | awk '{print $NF}')
    HOOK_COV=$(grep "internal/webhook" /tmp/cert-op-controller-test.log | awk '{print $NF}')
    pass "Controller tests passed (coverage: ${CTRL_COV})"
    pass "Dashboard coverage: ${DASH_COV}"
    pass "Webhook coverage: ${HOOK_COV}"
    ((TESTS_PASSED++))
  else
    fail "Controller tests failed"
    ((TESTS_FAILED++))
  fi

  echo ""
  if [[ "$TESTS_FAILED" -gt 0 ]]; then
    err "${TESTS_FAILED} test suite(s) failed. Aborting."
    exit 1
  fi
  info "All ${TESTS_PASSED} test suites passed!"

  cd "${REPO_ROOT}"
fi

if [[ "$TEST_ONLY" == "true" ]]; then
  ELAPSED=$((SECONDS - START_TIME))
  echo ""
  info "Test-only mode complete in ${ELAPSED}s"
  exit 0
fi

# ── Build ─────────────────────────────────────────────────────────────────
section "3. Building Docker Images"

info "Building cert-dashboard-operator image..."
docker build -t bookstore/cert-dashboard-operator:latest "${OPERATOR_DIR}" 2>&1 | tail -3
pass "Operator image built"

info "Tagging dashboard image (same binary, different entrypoint)..."
docker tag bookstore/cert-dashboard-operator:latest bookstore/cert-dashboard:latest
pass "Dashboard image tagged"

# Show image size
IMG_SIZE=$(docker images bookstore/cert-dashboard-operator:latest --format "{{.Size}}")
info "Image size: ${IMG_SIZE}"

if [[ "$BUILD_ONLY" == "true" ]]; then
  ELAPSED=$((SECONDS - START_TIME))
  echo ""
  info "Build-only mode complete in ${ELAPSED}s"
  exit 0
fi

# ── Load into Kind ────────────────────────────────────────────────────────
section "4. Loading Images into Kind"

info "Loading operator image..."
kind load docker-image bookstore/cert-dashboard-operator:latest --name "${KIND_CLUSTER}" 2>&1
pass "Operator image loaded"

info "Loading dashboard image..."
kind load docker-image bookstore/cert-dashboard:latest --name "${KIND_CLUSTER}" 2>&1
pass "Dashboard image loaded"

# ── Install OLM (if not present) ─────────────────────────────────────────
section "5. Installing OLM"

if kubectl get deploy olm-operator -n olm &>/dev/null; then
  pass "OLM already installed"
else
  info "Installing Operator Lifecycle Manager..."
  operator-sdk olm install 2>&1 | tail -5
  kubectl wait --for=condition=available deploy/olm-operator -n olm --timeout=120s
  kubectl wait --for=condition=available deploy/catalog-operator -n olm --timeout=120s
  pass "OLM installed"
fi

# ── Deploy ────────────────────────────────────────────────────────────────
section "6. Deploying Operator"

# 6a. Namespace
info "Creating namespace..."
kubectl apply -f "${REPO_ROOT}/infra/cert-dashboard/namespace.yaml"
pass "Namespace '${DASHBOARD_NS}' ready"

# 6b. CRD
info "Installing CertDashboard CRD..."
kubectl apply -f "${OPERATOR_DIR}/config/crd/bases/"
pass "CRD installed"

# 6c. Operator RBAC + Deployment
info "Applying operator RBAC..."
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cert-dashboard-operator
  namespace: cert-dashboard
---
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
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cert-dashboard-operator
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cert-dashboard-operator
subjects:
  - kind: ServiceAccount
    name: cert-dashboard-operator
    namespace: cert-dashboard
EOF
pass "RBAC applied"

info "Deploying operator..."
kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cert-dashboard-operator
  namespace: cert-dashboard
  labels:
    app: cert-dashboard-operator
    app.kubernetes.io/name: cert-dashboard-operator
    app.kubernetes.io/managed-by: operator-sdk
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cert-dashboard-operator
  template:
    metadata:
      labels:
        app: cert-dashboard-operator
    spec:
      serviceAccountName: cert-dashboard-operator
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: manager
          image: bookstore/cert-dashboard-operator:latest
          imagePullPolicy: IfNotPresent
          command: ["/manager"]
          args:
            - --leader-elect=false
            - --health-probe-bind-address=:8081
          ports:
            - name: health
              containerPort: 8081
              protocol: TCP
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8081
            initialDelaySeconds: 15
            periodSeconds: 20
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8081
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
          securityContext:
            runAsNonRoot: true
            runAsUser: 65532
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
EOF

info "Waiting for operator to be ready..."
kubectl rollout status deploy/cert-dashboard-operator -n "${DASHBOARD_NS}" --timeout=120s
pass "Operator running"

# 6d. PeerAuthentication (for Istio mTLS)
if kubectl get crd peerauthentications.security.istio.io &>/dev/null; then
  info "Applying PeerAuthentication..."
  kubectl apply -f "${REPO_ROOT}/infra/cert-dashboard/peer-auth.yaml"
  pass "PeerAuthentication applied"
else
  warn "Istio not installed — skipping PeerAuthentication"
fi

# 6e. CertDashboard CR
info "Creating CertDashboard custom resource..."
kubectl apply -f "${REPO_ROOT}/infra/cert-dashboard/certdashboard-cr.yaml"
pass "CertDashboard CR applied"

# 6f. Wait for dashboard
info "Waiting for dashboard deployment to appear..."
for i in $(seq 1 30); do
  if kubectl get deploy bookstore-certs -n "${DASHBOARD_NS}" &>/dev/null; then
    break
  fi
  sleep 2
done

info "Waiting for dashboard to be ready..."
kubectl rollout status deploy/bookstore-certs -n "${DASHBOARD_NS}" --timeout=120s
pass "Dashboard running"

# ── Verify ────────────────────────────────────────────────────────────────
section "7. Verification"

VERIFY_PASSED=0
VERIFY_FAILED=0

# 7a. Operator pod
if kubectl get pods -n "${DASHBOARD_NS}" -l app=cert-dashboard-operator --field-selector=status.phase=Running -o name | grep -q pod; then
  pass "Operator pod running"
  ((VERIFY_PASSED++))
else
  fail "Operator pod not running"
  ((VERIFY_FAILED++))
fi

# 7b. Dashboard pod
if kubectl get pods -n "${DASHBOARD_NS}" -l app=cert-dashboard --field-selector=status.phase=Running -o name | grep -q pod; then
  pass "Dashboard pod running"
  ((VERIFY_PASSED++))
else
  fail "Dashboard pod not running"
  ((VERIFY_FAILED++))
fi

# 7c. CR status
CR_READY=$(kubectl get certdashboard bookstore-certs -n "${DASHBOARD_NS}" -o jsonpath='{.status.ready}' 2>/dev/null || echo "false")
if [[ "$CR_READY" == "true" ]]; then
  pass "CertDashboard CR ready"
  ((VERIFY_PASSED++))
else
  fail "CertDashboard CR not ready (status: ${CR_READY})"
  ((VERIFY_FAILED++))
fi

# 7d. Health endpoint
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${DASHBOARD_PORT}/healthz" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "200" ]]; then
  pass "Health endpoint: http://localhost:${DASHBOARD_PORT}/healthz → 200"
  ((VERIFY_PASSED++))
else
  fail "Health endpoint returned ${HTTP_CODE}"
  ((VERIFY_FAILED++))
fi

# 7e. Certs API
CERT_COUNT=$(curl -s "http://localhost:${DASHBOARD_PORT}/api/certs" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
if [[ "$CERT_COUNT" -gt 0 ]]; then
  pass "Certs API: ${CERT_COUNT} certificates found"
  ((VERIFY_PASSED++))
else
  fail "Certs API returned 0 certificates"
  ((VERIFY_FAILED++))
fi

# 7f. Metrics endpoint
METRICS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${DASHBOARD_PORT}/metrics" 2>/dev/null || echo "000")
if [[ "$METRICS_CODE" == "200" ]]; then
  METRICS_COUNT=$(curl -s "http://localhost:${DASHBOARD_PORT}/metrics" 2>/dev/null | grep -c "^cert_dashboard_" || true)
  pass "Metrics endpoint: ${METRICS_COUNT} cert_dashboard_* metrics"
  ((VERIFY_PASSED++))
else
  fail "Metrics endpoint returned ${METRICS_CODE}"
  ((VERIFY_FAILED++))
fi

# 7g. Security context on dashboard pod
POD_SEC=$(kubectl get deploy bookstore-certs -n "${DASHBOARD_NS}" -o jsonpath='{.spec.template.spec.containers[0].securityContext.capabilities.drop[0]}' 2>/dev/null || echo "")
if [[ "$POD_SEC" == "ALL" ]]; then
  pass "Dashboard security: capabilities drop ALL"
  ((VERIFY_PASSED++))
else
  fail "Dashboard missing capabilities drop ALL"
  ((VERIFY_FAILED++))
fi

SECCOMP=$(kubectl get deploy bookstore-certs -n "${DASHBOARD_NS}" -o jsonpath='{.spec.template.spec.securityContext.seccompProfile.type}' 2>/dev/null || echo "")
if [[ "$SECCOMP" == "RuntimeDefault" ]]; then
  pass "Dashboard security: seccompProfile RuntimeDefault"
  ((VERIFY_PASSED++))
else
  fail "Dashboard missing seccompProfile"
  ((VERIFY_FAILED++))
fi

# ── Summary ───────────────────────────────────────────────────────────────
ELAPSED=$((SECONDS - START_TIME))

echo ""
section "Summary"
echo ""

if [[ "$SKIP_TEST" == "false" ]]; then
  echo -e "  Tests:         ${GREEN}${TESTS_PASSED} suites passed${NC}"
fi
echo -e "  Verification:  ${GREEN}${VERIFY_PASSED}/$((VERIFY_PASSED + VERIFY_FAILED)) checks passed${NC}"

if [[ "$VERIFY_FAILED" -gt 0 ]]; then
  echo -e "                 ${RED}${VERIFY_FAILED} checks failed${NC}"
fi

echo -e "  Time:          ${ELAPSED}s"
echo ""
echo -e "  ${BOLD}Dashboard:${NC}  http://localhost:${DASHBOARD_PORT}"
echo -e "  ${BOLD}Metrics:${NC}   http://localhost:${DASHBOARD_PORT}/metrics"
echo -e "  ${BOLD}Certs API:${NC} http://localhost:${DASHBOARD_PORT}/api/certs"
echo ""

# Show kubectl summary
kubectl get certdashboard,deploy,pods -n "${DASHBOARD_NS}" 2>/dev/null

if [[ "$VERIFY_FAILED" -gt 0 ]]; then
  echo ""
  err "${VERIFY_FAILED} verification check(s) failed"
  exit 1
fi

echo ""
info "Done! Operator tested, built, and deployed successfully."
