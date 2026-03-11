#!/usr/bin/env bash
# scripts/down.sh
# Shuts down and cleans up the BookStore stack.
#
# Options:
#   (no args)   Delete the kind cluster only. Data in ./data/ is preserved.
#   --data      Delete the kind cluster AND all persisted data (./data/).
#               Keycloak, PostgreSQL, Kafka, Redis, Superset, Flink data will be wiped.
#   --images    Delete the kind cluster AND locally-built Docker images.
#               (bookstore/ecom-service, bookstore/inventory-service, etc.)
#   --all       Delete cluster + data + images. Full clean slate.
#   --yes / -y  Skip all confirmation prompts (for automation).
#   --help / -h Show this help.
#
# Examples:
#   ./scripts/down.sh                # cluster only, keep data
#   ./scripts/down.sh --data         # cluster + wipe data
#   ./scripts/down.sh --all --yes    # full clean, no prompts
#
# After teardown, run ./scripts/up.sh to bring the stack back up.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}==>${NC} $*"; }
warn()    { echo -e "${YELLOW}WARN:${NC} $*"; }
success() { echo -e "${GREEN}✔${NC} $*"; }

usage() {
  grep '^#' "$0" | grep -v '^#!/' | sed 's/^# \{0,1\}//'
  exit 0
}

# ── Parse options ────────────────────────────────────────────────────────────
DELETE_DATA=false
DELETE_IMAGES=false
YES=false

for arg in "$@"; do
  case "$arg" in
    --data)       DELETE_DATA=true ;;
    --images)     DELETE_IMAGES=true ;;
    --all)        DELETE_DATA=true; DELETE_IMAGES=true ;;
    --purge-data) DELETE_DATA=true ;;   # backward-compat alias from cluster-down.sh
    --yes|-y)     YES=true ;;
    --help|-h)    usage ;;
    *)
      echo "Unknown option: $arg"
      echo ""
      echo "Usage: $0 [--data] [--images] [--all] [--yes] [--help]"
      echo "  (no args)  Delete cluster only, keep ./data/"
      echo "  --data     Delete cluster + ./data/ (wipes all DB/Kafka/Redis/Flink data)"
      echo "  --images   Delete cluster + bookstore/* Docker images"
      echo "  --all      Delete cluster + data + images"
      echo "  --yes/-y   Skip confirmation prompts"
      exit 1
      ;;
  esac
done

confirm() {
  $YES && return 0
  local ans
  read -r -p "$1 [y/N] " ans
  [[ "$ans" =~ ^[Yy] ]]
}

# ── Show what will be done ───────────────────────────────────────────────────
echo ""
echo "BookStore Stack Teardown"
echo "========================"
echo "  Kind cluster 'bookstore': DELETE"
echo "  Data (./data/):           $(${DELETE_DATA} && echo 'DELETE' || echo 'PRESERVE')"
echo "  Docker images:            $(${DELETE_IMAGES} && echo 'DELETE' || echo 'PRESERVE')"
echo ""

if $DELETE_DATA; then
  warn "⚠  --data flag set: all PostgreSQL, Kafka, Redis, Flink, Superset data will be permanently deleted."
fi
if $DELETE_IMAGES; then
  warn "⚠  --images flag set: built Docker images for all services will be removed."
fi

confirm "Proceed with teardown?" || { info "Aborted — nothing changed."; exit 0; }

# ── 1. Remove any leftover proxy containers (legacy — not needed with kind hostPorts) ─
for proxy in kiali-proxy flink-proxy debezium-proxy; do
  if docker rm -f "$proxy" 2>/dev/null; then
    info "Removed legacy proxy container: $proxy"
  fi
done

# ── 2. Delete kind cluster ───────────────────────────────────────────────────
if kind get clusters 2>/dev/null | grep -q "^bookstore$"; then
  info "Deleting kind cluster 'bookstore'..."
  kind delete cluster --name bookstore
  success "Cluster deleted."
else
  info "Cluster 'bookstore' not found — skipping."
fi

# ── 3. Clean up Helm releases that might linger outside the cluster ──────────
# (Helm stores release state locally; clean it up so re-installs start fresh)
for release in kiali-server; do
  if helm status "$release" -n istio-system &>/dev/null 2>&1; then
    info "Removing Helm release: $release..."
    helm uninstall "$release" -n istio-system 2>/dev/null || true
    success "Helm release '$release' removed."
  fi
done

# ── 4. Optionally delete data directories ───────────────────────────────────
if $DELETE_DATA; then
  DATA_DIR="${REPO_ROOT}/data"
  if [[ -d "$DATA_DIR" ]]; then
    info "Deleting data directories in ${DATA_DIR}/..."
    rm -rf \
      "${DATA_DIR}/ecom-db" \
      "${DATA_DIR}/inventory-db" \
      "${DATA_DIR}/analytics-db" \
      "${DATA_DIR}/keycloak-db" \
      "${DATA_DIR}/superset" \
      "${DATA_DIR}/kafka" \
      "${DATA_DIR}/redis" \
      "${DATA_DIR}/flink"
    success "Data directories deleted."
  else
    info "No data directory found at ${DATA_DIR} — nothing to delete."
  fi
else
  info "Data preserved at ${REPO_ROOT}/data/"
fi

# ── 5. Optionally delete Docker images ──────────────────────────────────────
if $DELETE_IMAGES; then
  info "Removing bookstore/* Docker images..."
  for img in \
    bookstore/ecom-service:latest \
    bookstore/inventory-service:latest \
    bookstore/ui-service:latest \
    bookstore/flink:latest; do
    if docker image inspect "$img" &>/dev/null; then
      docker rmi "$img"
      success "Removed image: $img"
    else
      info "Image not found (skipping): $img"
    fi
  done
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
success "Teardown complete."
echo ""
if $DELETE_DATA; then
  echo "  Data has been wiped. Next 'up.sh' will start with empty databases."
else
  echo "  Data preserved at ${REPO_ROOT}/data/"
  echo "  Next 'up.sh' will restore persisted data (PostgreSQL, Kafka, Redis, Superset)."
fi
echo ""
echo "  To bring the stack back up:"
echo "    ./scripts/up.sh           # smart start"
echo "    ./scripts/up.sh --fresh   # force full rebuild"
