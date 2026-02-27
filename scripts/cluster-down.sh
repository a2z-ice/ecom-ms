#!/usr/bin/env bash
# scripts/cluster-down.sh
# Tears down the BookStore kind cluster cleanly.
# Data in ./data/ is PRESERVED by default.
# Use --purge-data to also delete all persisted data.
#
# Usage:
#   ./scripts/cluster-down.sh              # keep data
#   ./scripts/cluster-down.sh --purge-data # delete data too

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}==>${NC} $*"; }
warning() { echo -e "${YELLOW}WARN:${NC} $*"; }

PURGE_DATA=false
for arg in "$@"; do
  [[ "$arg" == "--purge-data" ]] && PURGE_DATA=true
done

# ── 1. Stop Kiali Docker proxy ─────────────────────────────────────────────
info "Stopping Kiali proxy container..."
if docker rm -f kiali-proxy 2>/dev/null; then
  info "kiali-proxy removed."
else
  info "kiali-proxy was not running."
fi

# ── 2. Delete kind cluster ─────────────────────────────────────────────────
if kind get clusters 2>/dev/null | grep -q "^bookstore$"; then
  info "Deleting kind cluster 'bookstore'..."
  kind delete cluster --name bookstore
  info "Cluster deleted."
else
  info "Cluster 'bookstore' not found — nothing to delete."
fi

# ── 3. Optionally purge data ───────────────────────────────────────────────
if $PURGE_DATA; then
  warning "⚠  --purge-data flag set: this will permanently DELETE all"
  warning "   PostgreSQL, Superset, Kafka, and Redis data in ${REPO_ROOT}/data/"
  read -r -p "Type 'yes' to confirm permanent data deletion: " confirm
  if [[ "$confirm" == "yes" ]]; then
    info "Purging data directories..."
    rm -rf \
      "${REPO_ROOT}/data/ecom-db" \
      "${REPO_ROOT}/data/inventory-db" \
      "${REPO_ROOT}/data/analytics-db" \
      "${REPO_ROOT}/data/keycloak-db" \
      "${REPO_ROOT}/data/superset" \
      "${REPO_ROOT}/data/kafka" \
      "${REPO_ROOT}/data/redis"
    info "Data purged."
  else
    info "Purge cancelled — data preserved."
  fi
else
  info "Data preserved at ${REPO_ROOT}/data/"
  info "To also delete data, run: ./scripts/cluster-down.sh --purge-data"
fi

echo ""
echo -e "${GREEN}✔ Cluster down.${NC}"
echo "  To restart: ./scripts/stack-up.sh"
