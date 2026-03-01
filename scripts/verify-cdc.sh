#!/usr/bin/env bash
# scripts/verify-cdc.sh
# Inserts a test order into ecom-db, waits up to 30s, verifies it appears in analytics-db.
# Requires: kubectl access to the cluster and psql/pg client inside pods.
set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}==>${NC} $*"; }
warning() { echo -e "${YELLOW}WARN:${NC} $*"; }

# ── Helper: run SQL in a pod ───────────────────────────────────────────────
run_sql() {
  local ns=$1 pod_label=$2 db_secret=$3 db_name=$4 sql=$5
  kubectl exec -n "$ns" \
    "$(kubectl get pod -n "$ns" -l "app=$pod_label" -o jsonpath='{.items[0].metadata.name}')" \
    -- sh -c "PGPASSWORD=\$(PGPASSWORD) psql -U \$(POSTGRES_USER) -d $db_name -tAc \"$sql\""
}

# ── 1. Insert a test book and order into ecom-db ────────────────────────────
TEST_BOOK_ID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
TEST_ORDER_ID="11111111-2222-3333-4444-555555555555"

info "Inserting test data into ecom-db..."

kubectl exec -n ecom \
  "$(kubectl get pod -n ecom -l app=ecom-db -o jsonpath='{.items[0].metadata.name}')" \
  -- sh -c "
    PGPASSWORD=\$POSTGRES_PASSWORD psql -U \$POSTGRES_USER -d \$POSTGRES_DB -c \"
      INSERT INTO books (id, title, author, price, isbn)
      VALUES ('${TEST_BOOK_ID}', 'CDC Test Book', 'Test Author', 9.99, 'TEST-CDC-001')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO orders (id, user_id, total, status)
      VALUES ('${TEST_ORDER_ID}', 'cdc-test-user', 9.99, 'CONFIRMED')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO order_items (id, order_id, book_id, quantity, price_at_purchase)
      VALUES (gen_random_uuid(), '${TEST_ORDER_ID}', '${TEST_BOOK_ID}', 1, 9.99)
      ON CONFLICT DO NOTHING;
    \"
  "

# ── 2. Poll analytics-db for the order ─────────────────────────────────────
info "Polling analytics-db for order ${TEST_ORDER_ID} (max 30s)..."

MAX_WAIT=30
ELAPSED=0
FOUND=false

while [[ $ELAPSED -lt $MAX_WAIT ]]; do
  COUNT=$(kubectl exec -n analytics \
    "$(kubectl get pod -n analytics -l app=analytics-db -o jsonpath='{.items[0].metadata.name}')" \
    -- sh -c "PGPASSWORD=\$POSTGRES_PASSWORD psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"
      SELECT COUNT(*) FROM fact_orders WHERE id = '${TEST_ORDER_ID}';
    \"" 2>/dev/null || echo "0")

  if [[ "${COUNT// /}" == "1" ]]; then
    FOUND=true
    break
  fi

  sleep 1
  ((ELAPSED++)) || true
done

# ── 3. Cleanup test data ────────────────────────────────────────────────────
info "Cleaning up test data..."
kubectl exec -n ecom \
  "$(kubectl get pod -n ecom -l app=ecom-db -o jsonpath='{.items[0].metadata.name}')" \
  -- sh -c "
    PGPASSWORD=\$POSTGRES_PASSWORD psql -U \$POSTGRES_USER -d \$POSTGRES_DB -c \"
      DELETE FROM order_items WHERE order_id = '${TEST_ORDER_ID}';
      DELETE FROM orders WHERE id = '${TEST_ORDER_ID}';
      DELETE FROM books WHERE id = '${TEST_BOOK_ID}';
    \"
  " 2>/dev/null || true

# ── 4. Result ───────────────────────────────────────────────────────────────
if $FOUND; then
  echo ""
  echo -e "${GREEN}✔ CDC verified: order appeared in analytics-db within ${ELAPSED}s.${NC}"
  exit 0
else
  echo ""
  echo -e "${RED}FAIL: Order did not appear in analytics-db within ${MAX_WAIT}s.${NC}"
  echo "Check: kubectl logs -n infra deploy/debezium"
  exit 1
fi
