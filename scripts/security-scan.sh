#!/usr/bin/env bash
# scripts/security-scan.sh
# Runs dependency vulnerability scanning across all services.
# Each scan is non-blocking — failures are reported but don't stop other scans.
#
# Usage: bash scripts/security-scan.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}==>${NC} $*"; }
warn()  { echo -e "${YELLOW}WARN:${NC} $*"; }
fail()  { echo -e "${RED}FAIL:${NC} $*"; }

TOTAL=0
PASSED=0

run_scan() {
  local name="$1"
  shift
  TOTAL=$((TOTAL + 1))
  info "Scanning ${name}..."
  if "$@" 2>&1; then
    PASSED=$((PASSED + 1))
    info "${name}: PASSED"
  else
    fail "${name}: VULNERABILITIES FOUND (see output above)"
  fi
  echo ""
}

# ── Java (Maven) ───────────────────────────────────────────────────────────
if command -v mvn &>/dev/null; then
  run_scan "ecom-service (Maven OWASP)" \
    mvn -f "${REPO_ROOT}/ecom-service/pom.xml" \
    org.owasp:dependency-check-maven:check \
    -DfailBuildOnCVSS=7 -q
else
  warn "mvn not found — skipping ecom-service scan"
fi

# ── Python ─────────────────────────────────────────────────────────────────
if command -v pip-audit &>/dev/null; then
  run_scan "inventory-service (pip-audit)" \
    pip-audit -r "${REPO_ROOT}/inventory-service/requirements.txt" 2>/dev/null || \
    (cd "${REPO_ROOT}/inventory-service" && poetry export -f requirements.txt --without-hashes -o /tmp/inv-reqs.txt && pip-audit -r /tmp/inv-reqs.txt)
else
  warn "pip-audit not found — install with: pip install pip-audit"
fi

# ── Go ─────────────────────────────────────────────────────────────────────
if command -v govulncheck &>/dev/null; then
  run_scan "csrf-service (govulncheck)" \
    govulncheck -C "${REPO_ROOT}/csrf-service" ./...
else
  warn "govulncheck not found — install with: go install golang.org/x/vuln/cmd/govulncheck@latest"
fi

# ── JavaScript (npm) ──────────────────────────────────────────────────────
if command -v npm &>/dev/null; then
  run_scan "ui (npm audit)" \
    npm audit --prefix "${REPO_ROOT}/ui" --audit-level=high
  run_scan "e2e (npm audit)" \
    npm audit --prefix "${REPO_ROOT}/e2e" --audit-level=high
else
  warn "npm not found — skipping JS scans"
fi

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "Security scan complete: ${PASSED}/${TOTAL} passed"
if [[ $PASSED -eq $TOTAL ]]; then
  echo -e "${GREEN}All scans passed.${NC}"
else
  echo -e "${RED}$((TOTAL - PASSED)) scan(s) found vulnerabilities.${NC}"
fi
