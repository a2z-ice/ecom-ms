#!/usr/bin/env bash
# scripts/generate-secrets.sh
# Generates strong random passwords and creates all K8s Secrets.
# Idempotent: skips secrets that already exist (unless --force).
#
# Usage:
#   bash scripts/generate-secrets.sh           # create missing secrets only
#   bash scripts/generate-secrets.sh --force   # recreate all secrets

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}==>${NC} $*"; }
warn()  { echo -e "${YELLOW}WARN:${NC} $*"; }

FORCE=false
[[ "${1:-}" == "--force" ]] && FORCE=true

# ── Helper: generate a cryptographically strong random password ─────────────
gen_password() { openssl rand -base64 24 | tr -d '=+/' | head -c 32; }

# ── Helper: create a secret only if it doesn't exist (or --force) ──────────
create_secret() {
  local ns="$1" name="$2"
  shift 2
  if ! $FORCE && kubectl get secret "$name" -n "$ns" &>/dev/null; then
    info "Secret ${ns}/${name} already exists — skipping (use --force to recreate)"
    return 0
  fi
  info "Creating secret ${ns}/${name}..."
  kubectl create secret generic "$name" -n "$ns" "$@" \
    --dry-run=client -o yaml | kubectl apply -f -
}

# ── Pre-flight: ensure namespaces exist ────────────────────────────────────
for ns in ecom inventory analytics identity infra observability admin-tools; do
  kubectl create ns "$ns" 2>/dev/null || true
done

# ── Generate passwords ─────────────────────────────────────────────────────
DB_PASSWORD_ECOM=$(gen_password)
DB_PASSWORD_INVENTORY=$(gen_password)
DB_PASSWORD_ANALYTICS=$(gen_password)
DB_PASSWORD_KEYCLOAK=$(gen_password)
REDIS_PASSWORD=$(gen_password)
KC_ADMIN_PASSWORD=$(gen_password)
PGADMIN_PASSWORD=$(gen_password)
GRAFANA_PASSWORD=$(gen_password)
SUPERSET_PASSWORD=$(gen_password)
SUPERSET_SECRET_KEY=$(gen_password)
CSRF_HMAC_KEY=$(gen_password)

# ── CNPG database secrets (basic-auth type + app secrets) ──────────────────
info "Creating database secrets..."

# ecom-db
kubectl create secret generic ecom-db-cnpg-auth -n ecom \
  --from-literal=username=ecomuser \
  --from-literal=password="$DB_PASSWORD_ECOM" \
  --type=kubernetes.io/basic-auth \
  --dry-run=client -o yaml | kubectl apply -f -

create_secret ecom ecom-service-secret \
  --from-literal=DB_URL="jdbc:postgresql://ecom-db.ecom.svc.cluster.local:5432/ecomdb" \
  --from-literal=DB_USERNAME=ecomuser \
  --from-literal=DB_PASSWORD="$DB_PASSWORD_ECOM" \
  --from-literal=KEYCLOAK_JWKS_URI="http://keycloak.identity.svc.cluster.local:8080/realms/bookstore/protocol/openid-connect/certs" \
  --from-literal=KEYCLOAK_ISSUER_URI="https://idp.keycloak.net:30000/realms/bookstore" \
  --from-literal=KAFKA_BOOTSTRAP_SERVERS="kafka.infra.svc.cluster.local:9092" \
  --from-literal=REDIS_HOST="redis.infra.svc.cluster.local" \
  --from-literal=REDIS_PASSWORD="$REDIS_PASSWORD"

# inventory-db
kubectl create secret generic inventory-db-cnpg-auth -n inventory \
  --from-literal=username=inventoryuser \
  --from-literal=password="$DB_PASSWORD_INVENTORY" \
  --type=kubernetes.io/basic-auth \
  --dry-run=client -o yaml | kubectl apply -f -

create_secret inventory inventory-service-secret \
  --from-literal=DATABASE_URL="postgresql+asyncpg://inventoryuser:${DB_PASSWORD_INVENTORY}@inventory-db.inventory.svc.cluster.local:5432/inventorydb" \
  --from-literal=KEYCLOAK_JWKS_URI="http://keycloak.identity.svc.cluster.local:8080/realms/bookstore/protocol/openid-connect/certs" \
  --from-literal=KEYCLOAK_ISSUER_URI="https://idp.keycloak.net:30000/realms/bookstore" \
  --from-literal=KAFKA_BOOTSTRAP_SERVERS="kafka.infra.svc.cluster.local:9092"

# analytics-db
kubectl create secret generic analytics-db-cnpg-auth -n analytics \
  --from-literal=username=analyticsuser \
  --from-literal=password="$DB_PASSWORD_ANALYTICS" \
  --type=kubernetes.io/basic-auth \
  --dry-run=client -o yaml | kubectl apply -f -

# keycloak-db
kubectl create secret generic keycloak-db-cnpg-auth -n identity \
  --from-literal=username=keycloakuser \
  --from-literal=password="$DB_PASSWORD_KEYCLOAK" \
  --type=kubernetes.io/basic-auth \
  --dry-run=client -o yaml | kubectl apply -f -

# ── Infrastructure secrets ─────────────────────────────────────────────────
info "Creating infrastructure secrets..."

create_secret infra redis-secret \
  --from-literal=REDIS_PASSWORD="$REDIS_PASSWORD"

create_secret identity keycloak-secret \
  --from-literal=KC_BOOTSTRAP_ADMIN_USERNAME=admin \
  --from-literal=KC_BOOTSTRAP_ADMIN_PASSWORD="$KC_ADMIN_PASSWORD" \
  --from-literal=KC_DB_USERNAME=keycloakuser \
  --from-literal=KC_DB_PASSWORD="$DB_PASSWORD_KEYCLOAK"

create_secret infra pgadmin-secret \
  --from-literal=PGADMIN_DEFAULT_EMAIL=admin@bookstore.local \
  --from-literal=PGADMIN_DEFAULT_PASSWORD="$PGADMIN_PASSWORD"

create_secret observability grafana-secret \
  --from-literal=admin-user=admin \
  --from-literal=admin-password="$GRAFANA_PASSWORD"

create_secret analytics superset-secret \
  --from-literal=SUPERSET_ADMIN_PASSWORD="$SUPERSET_PASSWORD" \
  --from-literal=SUPERSET_SECRET_KEY="$SUPERSET_SECRET_KEY" \
  --from-literal=ANALYTICS_DB_URL="postgresql+psycopg2://analyticsuser:${DB_PASSWORD_ANALYTICS}@analytics-db.analytics.svc.cluster.local:5432/analyticsdb"

create_secret infra csrf-service-secret \
  --from-literal=CSRF_REDIS_PASSWORD="$REDIS_PASSWORD" \
  --from-literal=CSRF_HMAC_KEY="$CSRF_HMAC_KEY"

# ── Save reference file (gitignored) ──────────────────────────────────────
SECRETS_FILE="${REPO_ROOT}/.env.secrets"
cat > "$SECRETS_FILE" <<EOF
# Generated secrets — DO NOT COMMIT (gitignored)
# Generated at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
DB_PASSWORD_ECOM=$DB_PASSWORD_ECOM
DB_PASSWORD_INVENTORY=$DB_PASSWORD_INVENTORY
DB_PASSWORD_ANALYTICS=$DB_PASSWORD_ANALYTICS
DB_PASSWORD_KEYCLOAK=$DB_PASSWORD_KEYCLOAK
REDIS_PASSWORD=$REDIS_PASSWORD
KC_ADMIN_PASSWORD=$KC_ADMIN_PASSWORD
PGADMIN_PASSWORD=$PGADMIN_PASSWORD
GRAFANA_PASSWORD=$GRAFANA_PASSWORD
SUPERSET_PASSWORD=$SUPERSET_PASSWORD
SUPERSET_SECRET_KEY=$SUPERSET_SECRET_KEY
CSRF_HMAC_KEY=$CSRF_HMAC_KEY
EOF
chmod 600 "$SECRETS_FILE"

echo ""
info "All secrets created. Reference file: .env.secrets"
info "Passwords are stored in Kubernetes Secrets — never committed to Git."
