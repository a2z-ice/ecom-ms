#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# ui-service-up.sh — Build, package, and deploy the UI service to kind cluster
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== UI Service: Build & Deploy ==="

# 1. TypeScript + Vite build
echo "→ npm run build (TypeScript + Vite)..."
cd ui
npm run build
cd ..

# 2. Docker build with VITE_ build args (baked in at build time, not runtime)
echo "→ Docker build..."
docker build \
  --build-arg VITE_KEYCLOAK_AUTHORITY=https://idp.keycloak.net:30000/realms/bookstore \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
  --build-arg VITE_REDIRECT_URI=https://localhost:30000/callback \
  -t bookstore/ui-service:latest ./ui

# 3. Load image into kind cluster
echo "→ Loading image into kind cluster..."
kind load docker-image bookstore/ui-service:latest --name bookstore

# 4. Rollout restart and wait
echo "→ Restarting deployment..."
kubectl rollout restart deploy/ui-service -n ecom
kubectl rollout status deploy/ui-service -n ecom --timeout=120s

echo "=== UI Service: Done ==="
