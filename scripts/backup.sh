#!/usr/bin/env bash
# scripts/backup.sh
# Creates a timestamped backup of all databases, Kafka consumer offsets, and Keycloak realm.
# Idempotent: safe to run multiple times.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="${REPO_ROOT}/backups/${TIMESTAMP}"
GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}==>${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }

# ── Preflight ───────────────────────────────────────────────────────────────
kubectl config current-context | grep -q "kind-bookstore" || {
  err "Current kubectl context is not kind-bookstore."
  exit 1
}

mkdir -p "${BACKUP_DIR}"
info "Backup directory: ${BACKUP_DIR}"

# ── Helper: resolve CNPG primary pod ────────────────────────────────────────
cnpg_primary() {
  local ns=$1 cluster=$2
  kubectl get pod -n "${ns}" \
    -l "cnpg.io/cluster=${cluster},cnpg.io/instanceRole=primary" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo ""
}

# ── 1. PostgreSQL dumps ────────────────────────────────────────────────────
dump_db() {
  local ns=$1 cluster=$2 dbname=$3 label=$4
  local pod
  pod=$(cnpg_primary "${ns}" "${cluster}")
  if [[ -z "${pod}" ]]; then
    err "Could not find primary pod for ${cluster} in ${ns} — skipping"
    return 1
  fi
  info "Dumping ${label} (${ns}/${pod})..."
  kubectl exec -n "${ns}" "${pod}" -- \
    pg_dump -U postgres -d "${dbname}" --no-owner --no-privileges \
    > "${BACKUP_DIR}/${label}.sql" 2>/dev/null
  info "  → ${label}.sql ($(du -h "${BACKUP_DIR}/${label}.sql" | cut -f1))"
}

dump_db ecom ecom-db ecomdb ecom-db &
dump_db inventory inventory-db inventorydb inventory-db &
dump_db analytics analytics-db analyticsdb analytics-db &
dump_db identity keycloak-db keycloakdb keycloak-db &
wait

# ── 2. Kafka consumer group offsets ─────────────────────────────────────────
info "Snapshotting Kafka consumer group offsets..."
kubectl exec -n infra deploy/kafka -- \
  kafka-consumer-groups --bootstrap-server localhost:9092 --all-groups --describe \
  > "${BACKUP_DIR}/kafka-consumer-offsets.txt" 2>/dev/null || \
  err "Failed to snapshot Kafka consumer offsets (non-fatal)"

# ── 3. Keycloak realm export ───────────────────────────────────────────────
info "Exporting Keycloak bookstore realm..."
kubectl exec -n identity deploy/keycloak -- \
  /opt/keycloak/bin/kc.sh export --realm bookstore --dir /tmp/export --users realm_file \
  > /dev/null 2>&1 || true
kubectl cp identity/$(kubectl get pod -n identity -l app=keycloak -o jsonpath='{.items[0].metadata.name}'):/tmp/export/bookstore-realm.json \
  "${BACKUP_DIR}/keycloak-bookstore-realm.json" 2>/dev/null || \
  err "Keycloak realm export failed (non-fatal)"

# ── 4. Summary ──────────────────────────────────────────────────────────────
echo ""
info "Backup complete: ${BACKUP_DIR}"
echo "Files:"
ls -lh "${BACKUP_DIR}/" | tail -n +2
echo ""
echo "Total size: $(du -sh "${BACKUP_DIR}" | cut -f1)"
