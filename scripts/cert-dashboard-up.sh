#!/usr/bin/env bash
# scripts/cert-dashboard-up.sh
# Builds, installs OLM, and deploys the cert-dashboard operator + CR.
# Idempotent — safe to run multiple times.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPERATOR_DIR="${REPO_ROOT}/cert-dashboard-operator"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }

# ── 1. Build Docker images ────────────────────────────────────────────────
info "Building cert-dashboard-operator image..."
docker build -t bookstore/cert-dashboard-operator:latest "${OPERATOR_DIR}" 2>&1 | tail -3

info "Building cert-dashboard image (same Dockerfile, different entrypoint)..."
# The dashboard image is the same as the operator image — just a different ENTRYPOINT
docker tag bookstore/cert-dashboard-operator:latest bookstore/cert-dashboard:latest

info "Loading images into kind cluster..."
kind load docker-image bookstore/cert-dashboard-operator:latest --name bookstore 2>/dev/null || true
kind load docker-image bookstore/cert-dashboard:latest --name bookstore 2>/dev/null || true

# ── 2. Install OLM (if not present) ──────────────────────────────────────
if ! kubectl get deploy olm-operator -n olm &>/dev/null; then
  info "Installing Operator Lifecycle Manager (OLM)..."
  operator-sdk olm install 2>&1 | tail -5
  info "Waiting for OLM to be ready..."
  kubectl wait --for=condition=available deploy/olm-operator -n olm --timeout=120s
  kubectl wait --for=condition=available deploy/catalog-operator -n olm --timeout=120s
else
  info "OLM already installed."
fi

# ── 3. Create namespace ──────────────────────────────────────────────────
kubectl apply -f "${REPO_ROOT}/infra/cert-dashboard/namespace.yaml"

# ── 4. Install CRD ──────────────────────────────────────────────────────
info "Installing CertDashboard CRD..."
kubectl apply -f "${OPERATOR_DIR}/config/crd/bases/"

# ── 5. Deploy operator ──────────────────────────────────────────────────
info "Deploying cert-dashboard-operator..."

# Create operator ServiceAccount + RBAC in cert-dashboard namespace
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
  # CertDashboard CR management
  - apiGroups: ["certs.bookstore.io"]
    resources: ["certdashboards", "certdashboards/status", "certdashboards/finalizers"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # Manage dashboard resources
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["services", "serviceaccounts"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # RBAC for dashboard ServiceAccount
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["clusterroles", "clusterrolebindings"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # cert-manager read access
  - apiGroups: ["cert-manager.io"]
    resources: ["certificates", "certificaterequests", "clusterissuers", "issuers"]
    verbs: ["get", "list", "watch"]
  # Secret access (for cert info + renewal)
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "watch", "delete"]
  # Events
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create", "patch"]
  # Leader election
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

# Deploy the operator
kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cert-dashboard-operator
  namespace: cert-dashboard
  labels:
    app: cert-dashboard-operator
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
      containers:
        - name: manager
          image: bookstore/cert-dashboard-operator:latest
          imagePullPolicy: IfNotPresent
          command: ["/manager"]
          args:
            - --leader-elect=false
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
EOF

info "Waiting for operator to be ready..."
kubectl rollout status deploy/cert-dashboard-operator -n cert-dashboard --timeout=120s

# ── 6. Apply PeerAuthentication ──────────────────────────────────────────
kubectl apply -f "${REPO_ROOT}/infra/cert-dashboard/peer-auth.yaml"

# ── 7. Apply CertDashboard CR ───────────────────────────────────────────
info "Creating CertDashboard custom resource..."
kubectl apply -f "${REPO_ROOT}/infra/cert-dashboard/certdashboard-cr.yaml"

# ── 8. Wait for dashboard deployment ────────────────────────────────────
info "Waiting for dashboard to be ready..."
for i in $(seq 1 30); do
  if kubectl get deploy bookstore-certs -n cert-dashboard &>/dev/null; then
    kubectl rollout status deploy/bookstore-certs -n cert-dashboard --timeout=60s && break
  fi
  sleep 2
done

# ── 9. Verify ────────────────────────────────────────────────────────────
echo ""
info "Cert Dashboard deployed successfully!"
echo ""
echo "  Dashboard URL: http://localhost:32600"
echo "  Operator:      kubectl get deploy cert-dashboard-operator -n cert-dashboard"
echo "  CR status:     kubectl get certdashboard -n cert-dashboard"
echo ""
