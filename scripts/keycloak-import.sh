#!/usr/bin/env bash
# scripts/keycloak-import.sh
# Patches the keycloak-realm-json ConfigMap with the actual realm JSON,
# then runs the import Job. Idempotent.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REALM_FILE="${REPO_ROOT}/infra/keycloak/realm-export.json"
GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}==>${NC} $*"; }

info "Patching ConfigMap keycloak-realm-json with realm-export.json..."
kubectl create configmap keycloak-realm-json \
  --namespace identity \
  --from-file=bookstore-realm.json="${REALM_FILE}" \
  --dry-run=client -o yaml | kubectl apply -f -

info "Deleting previous import job (if any)..."
kubectl delete job keycloak-realm-import -n identity --ignore-not-found

info "Running realm import Job..."
kubectl apply -f "${REPO_ROOT}/infra/keycloak/import-job.yaml"

info "Waiting for import Job to complete..."
kubectl wait --for=condition=complete job/keycloak-realm-import \
  -n identity --timeout=180s

echo ""
echo -e "${GREEN}✔ Keycloak realm 'bookstore' imported successfully.${NC}"
echo ""
echo "Verify at: http://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration"
