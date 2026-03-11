#!/usr/bin/env bash
# scripts/trust-ca.sh
# Extracts the BookStore CA certificate from the cluster and optionally
# installs it into the macOS system Keychain for browser trust.
#
# Options:
#   --install       Install CA cert into macOS System Keychain (requires sudo)
#   --yes / -y      Auto-confirm (no interactive prompt; used by up.sh --yes)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="${REPO_ROOT}/certs"
CA_CERT="${CERT_DIR}/bookstore-ca.crt"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }

# Parse options
_INSTALL=false
_YES=false
for arg in "$@"; do
  case "$arg" in
    --install) _INSTALL=true ;;
    --yes|-y)  _YES=true ;;
  esac
done

# Extract CA cert from cluster
info "Extracting BookStore CA certificate from cluster..."
mkdir -p "$CERT_DIR"
kubectl get secret bookstore-ca-secret -n cert-manager \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > "$CA_CERT"

if [[ ! -s "$CA_CERT" ]]; then
  err "Failed to extract CA certificate. Is cert-manager installed?"
  exit 1
fi

info "CA certificate saved to: ${CA_CERT}"
echo ""
echo "To use with curl:"
echo "  curl --cacert ${CA_CERT} https://api.service.net:30000/ecom/books"
echo ""
echo "To use with Node.js/Playwright:"
echo "  export NODE_EXTRA_CA_CERTS=${CA_CERT}"
echo ""

# macOS Keychain install (optional)
if [[ "$(uname)" == "Darwin" ]]; then
  if $_INSTALL; then
    if $_YES; then
      # --yes mode: attempt install without prompting
      info "Installing CA certificate into macOS System Keychain..."
      if sudo security add-trusted-cert -d -r trustRoot \
          -k /Library/Keychains/System.keychain "$CA_CERT"; then
        info "CA certificate installed. Browsers will trust BookStore TLS."
      else
        warn "Failed to install CA certificate. Install manually:"
        echo "  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${CA_CERT}"
      fi
    else
      # Interactive mode: ask the user
      local_ans=""
      read -r -p "Install CA certificate into macOS Keychain? (requires sudo) [y/N] " local_ans
      if [[ "$local_ans" =~ ^[Yy] ]]; then
        info "Installing CA certificate into macOS System Keychain..."
        if sudo security add-trusted-cert -d -r trustRoot \
            -k /Library/Keychains/System.keychain "$CA_CERT"; then
          info "CA certificate installed. Browsers will trust BookStore TLS."
        else
          warn "Failed to install CA certificate. Install manually:"
          echo "  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${CA_CERT}"
        fi
      else
        echo "Skipped. To install later:"
        echo "  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${CA_CERT}"
      fi
    fi
  else
    echo "To trust in macOS browsers (requires sudo):"
    echo "  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${CA_CERT}"
    echo ""
  fi
fi
