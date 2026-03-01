#!/usr/bin/env bash
# infra/kgateway/install.sh
# Installs the Kubernetes Gateway API CRDs (experimental channel).
# Uses Istio's built-in Gateway API controller (GatewayClass: istio) — no
# separate gateway controller needed when Istio is installed.
# Idempotent: safe to re-run.
set -euo pipefail

echo "==> Installing Gateway API CRDs (experimental channel for full feature support)"
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/experimental-install.yaml

echo ""
echo "==> Waiting for Istio GatewayClass to be created by istiod..."
# istiod creates the 'istio' GatewayClass after it starts; poll until it exists
for i in $(seq 1 24); do
  if kubectl get gatewayclass istio &>/dev/null 2>&1; then
    echo "  GatewayClass 'istio' found."
    break
  fi
  echo "  Not ready yet (attempt ${i}/24), retrying in 5s..."
  sleep 5
done
kubectl wait --for=condition=Accepted gatewayclass/istio --timeout=60s

echo ""
echo "✔ Gateway API CRDs installed. Using GatewayClass 'istio' (built into Istio)."
echo "  Apply infra/kgateway/gateway.yaml next."
