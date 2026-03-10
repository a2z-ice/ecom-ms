#!/usr/bin/env bash
# infra/cert-manager/install.sh
# Installs cert-manager v1.17.2 into the cluster. Idempotent — safe to run multiple times.
set -euo pipefail

GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}==>${NC} $*"; }

CERT_MANAGER_VERSION="v1.17.2"

# Check if cert-manager is already installed and ready
if kubectl get deployment cert-manager -n cert-manager &>/dev/null; then
  READY=$(kubectl get deployment cert-manager -n cert-manager \
    -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
  if [[ "$READY" -ge 1 ]]; then
    info "cert-manager is already installed and ready — skipping."
    exit 0
  fi
fi

info "Installing cert-manager ${CERT_MANAGER_VERSION}..."
kubectl apply -f "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml"

info "Waiting for cert-manager deployments to be ready..."
kubectl wait --for=condition=Available deployment/cert-manager \
  -n cert-manager --timeout=180s
kubectl wait --for=condition=Available deployment/cert-manager-webhook \
  -n cert-manager --timeout=180s
kubectl wait --for=condition=Available deployment/cert-manager-cainjector \
  -n cert-manager --timeout=180s

info "cert-manager ${CERT_MANAGER_VERSION} is ready."
