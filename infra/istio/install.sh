#!/usr/bin/env bash
# infra/istio/install.sh
# Installs Istio Ambient Mesh 1.28.4 using Helm.
# Idempotent: safe to re-run; skips steps that are already done.
set -euo pipefail

ISTIO_VERSION="1.28.4"
ISTIO_NAMESPACE="istio-system"

echo "==> Installing Istio Ambient Mesh ${ISTIO_VERSION}"

# ── 1. Add / update Istio Helm repo ────────────────────────────────────────
helm repo add istio https://istio-release.storage.googleapis.com/charts 2>/dev/null || true
helm repo update istio

# ── 2. Create istio-system namespace ───────────────────────────────────────
kubectl create namespace "${ISTIO_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

# ── 3. Istio base CRDs ─────────────────────────────────────────────────────
if helm status istio-base -n "${ISTIO_NAMESPACE}" &>/dev/null; then
  echo "  istio-base already installed, upgrading..."
  helm upgrade istio-base istio/base \
    -n "${ISTIO_NAMESPACE}" \
    --version "${ISTIO_VERSION}" \
    --set defaultRevision=default \
    --wait
else
  helm install istio-base istio/base \
    -n "${ISTIO_NAMESPACE}" \
    --version "${ISTIO_VERSION}" \
    --set defaultRevision=default \
    --wait
fi

# ── 4. istiod (control plane) ──────────────────────────────────────────────
if helm status istiod -n "${ISTIO_NAMESPACE}" &>/dev/null; then
  echo "  istiod already installed, upgrading..."
  helm upgrade istiod istio/istiod \
    -n "${ISTIO_NAMESPACE}" \
    --version "${ISTIO_VERSION}" \
    --set profile=ambient \
    --wait
else
  helm install istiod istio/istiod \
    -n "${ISTIO_NAMESPACE}" \
    --version "${ISTIO_VERSION}" \
    --set profile=ambient \
    --wait
fi

# ── 5. Istio CNI plugin (required for ambient) ─────────────────────────────
if helm status istio-cni -n "${ISTIO_NAMESPACE}" &>/dev/null; then
  echo "  istio-cni already installed, upgrading..."
  helm upgrade istio-cni istio/cni \
    -n "${ISTIO_NAMESPACE}" \
    --version "${ISTIO_VERSION}" \
    --set profile=ambient \
    --wait
else
  helm install istio-cni istio/cni \
    -n "${ISTIO_NAMESPACE}" \
    --version "${ISTIO_VERSION}" \
    --set profile=ambient \
    --wait
fi

# ── 6. ztunnel (per-node ambient proxy) ────────────────────────────────────
if helm status ztunnel -n "${ISTIO_NAMESPACE}" &>/dev/null; then
  echo "  ztunnel already installed, upgrading..."
  helm upgrade ztunnel istio/ztunnel \
    -n "${ISTIO_NAMESPACE}" \
    --version "${ISTIO_VERSION}" \
    --wait
else
  helm install ztunnel istio/ztunnel \
    -n "${ISTIO_NAMESPACE}" \
    --version "${ISTIO_VERSION}" \
    --wait
fi

# ── 7. Verify ──────────────────────────────────────────────────────────────
echo ""
echo "==> Verifying Istio installation..."
# verify-install was removed in 1.28+; check pods directly
kubectl wait --for=condition=Ready pods --all -n istio-system --timeout=120s

echo ""
echo "✔ Istio Ambient Mesh ${ISTIO_VERSION} installed successfully."
