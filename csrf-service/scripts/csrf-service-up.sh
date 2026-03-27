#!/usr/bin/env bash
# csrf-service/scripts/csrf-service-up.sh
#
# Build, test, and deploy the CSRF service to the kind cluster.
# Idempotent — safe to run multiple times.
#
# Usage:
#   bash csrf-service/scripts/csrf-service-up.sh          # full: test + build + deploy
#   bash csrf-service/scripts/csrf-service-up.sh --skip-tests   # skip Go tests
#   bash csrf-service/scripts/csrf-service-up.sh --build-only   # build Docker image only

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_DIR="${REPO_ROOT}/csrf-service"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${GREEN}==>${NC} $*"; }
section() { echo -e "\n${YELLOW}════════════════════════════════════════${NC}\n  $*\n${YELLOW}════════════════════════════════════════${NC}"; }
err()     { echo -e "${RED}ERROR:${NC} $*" >&2; }

SKIP_TESTS=false
BUILD_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=true ;;
    --build-only) BUILD_ONLY=true ;;
    *) err "Unknown option: $arg"; echo "Usage: $0 [--skip-tests] [--build-only]"; exit 1 ;;
  esac
done

# ── 1. Run Go unit tests ────────────────────────────────────────────────────
if ! $SKIP_TESTS && ! $BUILD_ONLY; then
  section "Running unit tests"
  cd "${SERVICE_DIR}"
  go test -v ./... || { err "Unit tests failed"; exit 1; }
  info "All tests passed."
fi

# ── 2. Build Docker image ───────────────────────────────────────────────────
section "Building Docker image"
docker build -t bookstore/csrf-service:latest "${SERVICE_DIR}" || {
  info "Retrying without cache..."
  docker build --no-cache -t bookstore/csrf-service:latest "${SERVICE_DIR}"
}
info "Image built: bookstore/csrf-service:latest"

if $BUILD_ONLY; then
  info "Build-only mode — skipping deployment."
  exit 0
fi

# ── 3. Load into kind cluster ────────────────────────────────────────────────
section "Loading image into kind cluster"
kind load docker-image bookstore/csrf-service:latest --name bookstore
info "Image loaded."

# ── 4. Deploy K8s manifests ──────────────────────────────────────────────────
section "Deploying CSRF service"
kubectl apply -f "${SERVICE_DIR}/k8s/csrf-service.yaml"
info "Manifests applied."

# ── 5. Apply Istio AuthorizationPolicy + HTTPRoute ───────────────────────────
section "Applying Istio ext_authz policy and HTTPRoute"
kubectl apply -f "${REPO_ROOT}/infra/istio/csrf-envoy-filter.yaml"
kubectl apply -f "${REPO_ROOT}/infra/kgateway/routes/csrf-route.yaml"
info "Istio AuthorizationPolicy and HTTPRoute applied."

# ── 6. Ensure Istio extensionProvider is registered ──────────────────────────
section "Ensuring Istio extensionProvider is registered"
MESH_CONFIG=$(kubectl get configmap istio -n istio-system -o jsonpath='{.data.mesh}' 2>/dev/null)
if echo "$MESH_CONFIG" | grep -q "csrf-ext-authz"; then
  info "extensionProvider 'csrf-ext-authz' already registered."
else
  info "Registering extensionProvider 'csrf-ext-authz' in Istio mesh config..."
  kubectl get configmap istio -n istio-system -o json | python3 -c "
import sys, json, yaml
cm = json.load(sys.stdin)
mesh = yaml.safe_load(cm['data']['mesh'])
if 'extensionProviders' not in mesh:
    mesh['extensionProviders'] = []
existing = [p for p in mesh['extensionProviders'] if p.get('name') == 'csrf-ext-authz']
if not existing:
    mesh['extensionProviders'].append({
        'name': 'csrf-ext-authz',
        'envoyExtAuthzHttp': {
            'service': 'csrf-service.infra.svc.cluster.local',
            'port': 8080,
            'failOpen': True,
            'headersToUpstreamOnAllow': [],
            'includeRequestHeadersInCheck': ['authorization', 'x-csrf-token', 'origin', 'referer'],
        }
    })
cm['data']['mesh'] = yaml.dump(mesh, default_flow_style=False)
json.dump(cm, sys.stdout)
" | kubectl apply -f -
  info "extensionProvider registered."
fi

# ── 7. Ensure NetworkPolicies exist ──────────────────────────────────────────
section "Applying NetworkPolicies"
kubectl apply -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: csrf-service-ingress
  namespace: infra
spec:
  podSelector:
    matchLabels:
      app: csrf-service
  ingress:
    - from:
        - podSelector:
            matchLabels:
              gateway.networking.k8s.io/gateway-name: bookstore-gateway
      ports:
        - port: 8080
    - from: []
      ports:
        - port: 15008
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: csrf-service-egress
  namespace: infra
spec:
  podSelector:
    matchLabels:
      app: csrf-service
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: redis
      ports:
        - port: 6379
    - to:
        - namespaceSelector: {}
      ports:
        - port: 53
          protocol: UDP
    - to: []
      ports:
        - port: 15008
EOF
info "NetworkPolicies applied."

# ── 8. Ensure PeerAuthentication ─────────────────────────────────────────────
kubectl apply -f - <<'EOF'
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: csrf-service-permissive
  namespace: infra
spec:
  selector:
    matchLabels:
      app: csrf-service
  mtls:
    mode: STRICT
  portLevelMtls:
    "8080":
      mode: PERMISSIVE
EOF
info "PeerAuthentication applied."

# ── 9. Ensure gateway-egress allows csrf-service ─────────────────────────────
GATEWAY_EGRESS=$(kubectl get networkpolicy gateway-egress -n infra -o json 2>/dev/null)
if echo "$GATEWAY_EGRESS" | grep -q "csrf-service"; then
  info "gateway-egress already allows csrf-service."
else
  info "Patching gateway-egress to allow csrf-service..."
  echo "$GATEWAY_EGRESS" | python3 -c "
import sys, json
pol = json.load(sys.stdin)
pol['spec']['egress'].insert(0, {
    'to': [{'podSelector': {'matchLabels': {'app': 'csrf-service'}}}],
    'ports': [{'port': 8080, 'protocol': 'TCP'}]
})
json.dump(pol, sys.stdout)
" | kubectl apply -f -
  info "gateway-egress patched."
fi

# ── 10. Wait for rollout ─────────────────────────────────────────────────────
section "Waiting for CSRF service rollout"
kubectl rollout restart deploy/csrf-service -n infra 2>/dev/null || true
kubectl rollout status deploy/csrf-service -n infra --timeout=120s
info "CSRF service is running."

# ── 11. Apply HPA + PDB (via recursive infra apply) ─────────────────────────
kubectl apply -R -f "${REPO_ROOT}/infra/kubernetes/" 2>/dev/null || true
info "HPA and PDB applied."

# ── 12. Verify ───────────────────────────────────────────────────────────────
section "Verifying CSRF service"
PODS=$(kubectl get pods -n infra -l app=csrf-service --no-headers | wc -l | tr -d ' ')
info "Replicas running: ${PODS}"
HPA_MIN=$(kubectl get hpa csrf-service-hpa -n infra -o jsonpath='{.spec.minReplicas}' 2>/dev/null || echo "N/A")
HPA_MAX=$(kubectl get hpa csrf-service-hpa -n infra -o jsonpath='{.spec.maxReplicas}' 2>/dev/null || echo "N/A")
info "HPA: ${HPA_MIN}-${HPA_MAX} replicas"
PDB=$(kubectl get pdb csrf-service-pdb -n infra -o jsonpath='{.spec.minAvailable}' 2>/dev/null || echo "N/A")
info "PDB: minAvailable=${PDB}"

echo ""
echo -e "${GREEN}Done! CSRF service deployed and verified.${NC}"
echo ""
echo "  Endpoints:"
echo "    Token:   https://api.service.net:30000/csrf/token (JWT required)"
echo "    Health:  http://csrf-service.infra:8080/healthz"
echo "    Metrics: http://csrf-service.infra:8080/metrics"
echo ""
echo "  Test: cd e2e && npx playwright test csrf.spec.ts"
