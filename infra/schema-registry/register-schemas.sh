#!/usr/bin/env bash
# infra/schema-registry/register-schemas.sh
# Registers JSON Schemas for all CDC and application Kafka topics
# with the Confluent Schema Registry via kubectl exec.
#
# Idempotent: safe to run multiple times. Re-registers create new versions only if schema changed.
# Compatibility mode: BACKWARD — new schemas can read data written by old schemas.
#
# Usage:
#   bash infra/schema-registry/register-schemas.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMAS_DIR="${SCRIPT_DIR}/schemas"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}==>${NC} $*"; }
warn()  { echo -e "${YELLOW}WARN:${NC} $*"; }
err()   { echo -e "${RED}ERROR:${NC} $*" >&2; }

SR_URL="http://localhost:8081"
SR_POD="deploy/schema-registry"

# ── Wait for Schema Registry to be ready ──────────────────────────────────────
info "Waiting for Schema Registry to be ready..."
for i in $(seq 1 30); do
  if kubectl exec -n infra $SR_POD -- curl -sf "${SR_URL}/subjects" >/dev/null 2>&1; then
    info "Schema Registry is ready."
    break
  fi
  if [[ $i -eq 30 ]]; then
    err "Schema Registry not ready after 150s — aborting."
    exit 1
  fi
  echo "  Not ready (attempt $i/30), retrying in 5s..."
  sleep 5
done

# ── Set global compatibility to BACKWARD ──────────────────────────────────────
info "Setting global compatibility to BACKWARD..."
kubectl exec -n infra $SR_POD -- curl -sf -X PUT "${SR_URL}/config" \
  -H "Content-Type: application/vnd.schemaregistry.v1+json" \
  -d '{"compatibility":"BACKWARD"}' >/dev/null || warn "Could not set global compatibility"

# ── Subject-to-file mapping ───────────────────────────────────────────────────
# Subject naming: TopicNameStrategy — <topic>-value
SUBJECTS=(
  "ecom-connector.public.orders-value|orders-value.json"
  "ecom-connector.public.order_items-value|order-items-value.json"
  "ecom-connector.public.books-value|books-value.json"
  "inventory-connector.public.inventory-value|inventory-value.json"
  "order.created-value|order-created-value.json"
  "inventory.updated-value|inventory-updated-value.json"
)

REGISTERED=0
FAILED=0

for entry in "${SUBJECTS[@]}"; do
  subject="${entry%%|*}"
  schema_file="${SCHEMAS_DIR}/${entry##*|}"

  if [[ ! -f "$schema_file" ]]; then
    warn "Schema file not found: $schema_file — skipping $subject"
    ((FAILED++)) || true
    continue
  fi

  # Build payload: {"schemaType":"JSON","schema":"<escaped-json-string>"}
  # The schema must be a JSON-escaped string inside the wrapper
  payload=$(python3 -c "
import json
with open('$schema_file') as f:
    schema = f.read().strip()
print(json.dumps({'schemaType': 'JSON', 'schema': schema}))
")

  info "Registering: $subject"

  # Use kubectl exec with the payload passed as a single-quoted -d argument
  # Write payload to a temp file, then use kubectl cp + exec
  response=$(kubectl exec -i -n infra $SR_POD -- \
    curl -sf -X POST "${SR_URL}/subjects/${subject}/versions" \
    -H "Content-Type: application/vnd.schemaregistry.v1+json" \
    -d @- <<< "$payload" 2>&1) || {
    err "  Failed to register $subject: $response"
    ((FAILED++)) || true
    continue
  }

  schema_id=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','?'))" 2>/dev/null || echo "?")
  info "  Registered: $subject (schema id=$schema_id)"
  ((REGISTERED++)) || true
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
info "Schema registration complete: $REGISTERED registered, $FAILED failed."

# ── List all subjects ─────────────────────────────────────────────────────────
info "All registered subjects:"
kubectl exec -n infra $SR_POD -- curl -sf "${SR_URL}/subjects" | python3 -c "
import sys, json
subjects = json.load(sys.stdin)
for s in sorted(subjects):
    print(f'  - {s}')
" 2>/dev/null || warn "Could not list subjects"

echo ""
info "Done."
