#!/usr/bin/env bash
# scripts/cluster-up.sh
# Idempotent full-stack bootstrap:
#   1. Create kind cluster (if not running)
#   2. Install Istio Ambient Mesh
#   3. Install KGateway
#   4. Apply all namespaces
#
# Usage: ./scripts/cluster-up.sh
# Prerequisites: kind, kubectl, helm, istioctl installed and on PATH.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER_NAME="bookstore"

# ── Colour helpers ──────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}==>${NC} $*"; }
warning() { echo -e "${YELLOW}WARN:${NC} $*"; }

# ── Preflight checks ────────────────────────────────────────────────────────
info "Checking prerequisites..."
for cmd in kind kubectl helm istioctl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' not found on PATH. Please install it before running this script."
    exit 1
  fi
done

# ── 1. Create kind cluster ──────────────────────────────────────────────────
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  info "kind cluster '${CLUSTER_NAME}' already exists, skipping creation."
else
  info "Creating kind cluster '${CLUSTER_NAME}'..."
  # Create data directories so extraMounts have valid host paths
  DATA_DIR="${REPO_ROOT}/data"
  mkdir -p "${DATA_DIR}"/{ecom-db,inventory-db,analytics-db,keycloak-db,superset,kafka,redis}
  # Substitute DATA_DIR placeholder in cluster.yaml before passing to kind
  sed "s|DATA_DIR|${DATA_DIR}|g" \
    "${REPO_ROOT}/infra/kind/cluster.yaml" > /tmp/bookstore-cluster.yaml
  kind create cluster \
    --name "${CLUSTER_NAME}" \
    --config /tmp/bookstore-cluster.yaml
fi

# Ensure kubectl context points to our cluster
kubectl config use-context "kind-${CLUSTER_NAME}"

info "Waiting for cluster to be ready..."
kubectl wait --for=condition=Ready nodes --all --timeout=120s

# ── 2. Install Istio Ambient Mesh ───────────────────────────────────────────
info "Installing Istio Ambient Mesh..."
bash "${REPO_ROOT}/infra/istio/install.sh"

# ── 3. Install KGateway ─────────────────────────────────────────────────────
info "Installing KGateway..."
bash "${REPO_ROOT}/infra/kgateway/install.sh"

# ── 4. Apply namespaces ─────────────────────────────────────────────────────
info "Applying namespaces..."
kubectl apply -f "${REPO_ROOT}/infra/namespaces.yaml"

# ── 5. Apply Gateway resource ───────────────────────────────────────────────
info "Applying Gateway resource..."
kubectl apply -f "${REPO_ROOT}/infra/kgateway/gateway.yaml"

# ── 6. Verify ───────────────────────────────────────────────────────────────
echo ""
info "Cluster summary:"
kubectl get nodes
echo ""
info "Namespaces:"
kubectl get namespaces -L istio.io/dataplane-mode
echo ""
info "kgateway pods:"
kubectl get pods -n kgateway-system
echo ""
info "Istio pods:"
kubectl get pods -n istio-system

echo ""
echo -e "${GREEN}✔ Session 1 complete.${NC}"
echo ""
echo "Next steps — add to /etc/hosts if not already present:"
echo "  127.0.0.1  idp.keycloak.net  myecom.net  api.service.net"
echo ""
echo "Run acceptance checks:"
echo "  kubectl get nodes"
echo "  istioctl verify-install"
echo "  kubectl get pods -n kgateway-system"
echo "  kubectl get namespaces -L istio.io/dataplane-mode"
