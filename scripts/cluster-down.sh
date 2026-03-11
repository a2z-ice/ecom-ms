#!/usr/bin/env bash
# scripts/cluster-down.sh
# Tears down the BookStore kind cluster cleanly.
# Preserved for backward compatibility. For full options, use: scripts/down.sh
#
# Usage:
#   ./scripts/cluster-down.sh              # delete cluster, keep data
#   ./scripts/cluster-down.sh --purge-data # delete cluster + data

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Delegate to down.sh
ARGS=()
for arg in "$@"; do
  [[ "$arg" == "--purge-data" ]] && ARGS+=("--data") || ARGS+=("$arg")
done

exec bash "${REPO_ROOT}/scripts/down.sh" "${ARGS[@]}"
