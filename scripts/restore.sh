#!/usr/bin/env bash
# scripts/restore.sh <timestamp>
# Restores databases from a backup created by backup.sh.
# Usage: bash scripts/restore.sh 20260323-143000

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARNING:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }

# ── Argument parsing ───────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
  err "Usage: $0 <backup-timestamp>"
  echo "Available backups:"
  ls -1 "${REPO_ROOT}/backups/" 2>/dev/null || echo "  (none)"
  exit 1
fi

TIMESTAMP="$1"
BACKUP_DIR="${REPO_ROOT}/backups/${TIMESTAMP}"

if [[ ! -d "${BACKUP_DIR}" ]]; then
  err "Backup directory not found: ${BACKUP_DIR}"
  echo "Available backups:"
  ls -1 "${REPO_ROOT}/backups/" 2>/dev/null || echo "  (none)"
  exit 1
fi

# ── Preflight ───────────────────────────────────────────────────────────────
kubectl config current-context | grep -q "kind-bookstore" || {
  err "Current kubectl context is not kind-bookstore."
  exit 1
}

# ── Confirmation ────────────────────────────────────────────────────────────
echo ""
warn "This will OVERWRITE current database contents with backup from ${TIMESTAMP}."
echo "Backup files found:"
ls -lh "${BACKUP_DIR}/"
echo ""

if [[ "${2:-}" != "--yes" && "${2:-}" != "-y" ]]; then
  read -rp "Proceed? (y/N) " confirm
  if [[ "${confirm}" != "y" && "${confirm}" != "Y" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ── Helper: resolve CNPG primary pod ────────────────────────────────────────
cnpg_primary() {
  local ns=$1 cluster=$2
  kubectl get pod -n "${ns}" \
    -l "cnpg.io/cluster=${cluster},cnpg.io/instanceRole=primary" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo ""
}

# ── Restore databases ──────────────────────────────────────────────────────
restore_db() {
  local ns=$1 cluster=$2 dbname=$3 label=$4
  local dump_file="${BACKUP_DIR}/${label}.sql"

  if [[ ! -f "${dump_file}" ]]; then
    warn "Dump file not found: ${dump_file} — skipping ${label}"
    return 0
  fi

  local pod
  pod=$(cnpg_primary "${ns}" "${cluster}")
  if [[ -z "${pod}" ]]; then
    err "Could not find primary pod for ${cluster} in ${ns} — skipping"
    return 1
  fi

  info "Restoring ${label} to ${ns}/${pod}..."
  # Drop and recreate public schema to clear existing data, then restore
  kubectl exec -n "${ns}" "${pod}" -i -- \
    psql -U postgres -d "${dbname}" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" \
    2>/dev/null
  kubectl exec -n "${ns}" "${pod}" -i -- \
    psql -U postgres -d "${dbname}" < "${dump_file}" \
    > /dev/null 2>&1
  info "  → ${label} restored"
}

restore_db ecom ecom-db ecomdb ecom-db
restore_db inventory inventory-db inventorydb inventory-db
restore_db analytics analytics-db analyticsdb analytics-db
restore_db identity keycloak-db keycloakdb keycloak-db

# ── Keycloak realm import ──────────────────────────────────────────────────
REALM_FILE="${BACKUP_DIR}/keycloak-bookstore-realm.json"
if [[ -f "${REALM_FILE}" ]]; then
  info "Keycloak realm export found — to re-import, use:"
  echo "  bash scripts/keycloak-import.sh"
else
  warn "No Keycloak realm export in backup — skipping"
fi

echo ""
info "Restore from ${TIMESTAMP} complete."
echo "You may need to restart services for schema changes to take effect:"
echo "  kubectl rollout restart deploy -n ecom"
echo "  kubectl rollout restart deploy -n inventory"
