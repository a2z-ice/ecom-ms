#!/usr/bin/env bash
# scripts/verify-routes.sh
# Smoke-tests all external routes via curl. Exits non-zero if any fail.
# Session 7 acceptance check.
set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
PASS=0; FAIL=0

check() {
  local label=$1 url=$2 expected_status=${3:-200}
  local actual
  actual=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
  if [[ "$actual" == "$expected_status" ]]; then
    echo -e "${GREEN}PASS${NC} [$label] $url → $actual"
    ((PASS++)) || true
  else
    echo -e "${RED}FAIL${NC} [$label] $url → expected=$expected_status actual=$actual"
    ((FAIL++)) || true
  fi
}

echo "==> Verifying all external routes..."
echo ""

# Keycloak — OIDC discovery (200)
check "Keycloak OIDC discovery" \
  "http://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration"

# Keycloak admin (200 or 302 redirect)
check "Keycloak admin" \
  "http://idp.keycloak.net:30000/admin/" "302"

# UI — catalog page (200)
check "UI catalog" \
  "http://myecom.net:30000/"

# ecom-service — public books endpoint (200)
check "ecom GET /books" \
  "http://api.service.net:30000/ecom/books"

# ecom-service — search (200)
check "ecom GET /books/search" \
  "http://api.service.net:30000/ecom/books/search?q=python"

# ecom-service — cart without auth (401)
check "ecom GET /cart (no auth → 401)" \
  "http://api.service.net:30000/ecom/cart" "401"

# inventory-service — health (200)
check "inventory health" \
  "http://api.service.net:30000/inven/health"

# PgAdmin (200)
check "PgAdmin" \
  "http://localhost:31111/misc/ping"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]] && echo -e "${GREEN}✔ All routes OK${NC}" || { echo -e "${RED}Some routes failed${NC}"; exit 1; }
