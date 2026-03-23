# Schema Registry — Setup, Usage & Manual Testing Guide

## Overview

The BookStore platform uses **Confluent Schema Registry 7.8.0** to provide centralized schema governance for all Kafka topics in the CDC pipeline. JSON Schemas are registered for every CDC topic (Debezium change events) and every application event topic (`order.created`, `inventory.updated`).

### What the Schema Registry Provides

| Capability | Description |
|-----------|-------------|
| **Schema Catalog** | Central repository of all event schemas — single source of truth |
| **Versioning** | Every schema change creates a new version; full history retained |
| **Compatibility** | BACKWARD compatibility enforced — new schemas can always read old data |
| **Validation** | REST API allows producers/consumers to validate messages against registered schemas |
| **Documentation** | Each schema includes title, description, field types, and constraints |

### Architecture

```
ecom-service ──publish──▶ Kafka ◀──consume── Flink SQL
     │                      ▲                    │
     │                      │                    │
     ▼                      │                    ▼
 Schema Registry ◀── Debezium Server ──▶ analytics-db
     (validation)    (CDC events)
```

The Schema Registry runs as a ClusterIP service in the `infra` namespace at `schema-registry.infra.svc.cluster.local:8081`. It stores schemas in a Kafka topic (`_schemas`) using Kafka as its backend store.

---

## Registered Schemas

### CDC Topics (Debezium Change Events)

| Subject | Source Table | Key Fields |
|---------|-------------|------------|
| `ecom-connector.public.orders-value` | ecom-db.public.orders | id, user_id, total, status, created_at |
| `ecom-connector.public.order_items-value` | ecom-db.public.order_items | id, order_id, book_id, quantity, price_at_purchase |
| `ecom-connector.public.books-value` | ecom-db.public.books | id, title, author, price, isbn, genre |
| `inventory-connector.public.inventory-value` | inventory-db.public.inventory | book_id, quantity, reserved, updated_at |

All CDC schemas follow the **Debezium envelope format**:
```json
{
  "before": null | { <row data> },
  "after":  null | { <row data> },
  "op": "c|u|d|r",
  "ts_ms": 1234567890,
  "source": { ... }
}
```

### Application Event Topics

| Subject | Producer | Consumer | Key Fields |
|---------|----------|----------|------------|
| `order.created-value` | ecom-service | inventory-service | orderId, userId, items[], total, timestamp |
| `inventory.updated-value` | inventory-service | analytics pipeline | bookId, previousQuantity, newQuantity, orderId, timestamp |

---

## Step-by-Step Manual Testing Guide

### Prerequisites

- Cluster running: `bash scripts/up.sh`
- Schema Registry pod in Running state: `kubectl get pod -n infra -l app=schema-registry`

### Test 1: Verify Schema Registry is Healthy

```bash
# Check pod status
kubectl get pod -n infra -l app=schema-registry

# Check readiness endpoint
kubectl exec -n infra deploy/schema-registry -- \
  curl -sf http://localhost:8081/subjects
# Expected: JSON array of subject names (may be empty if schemas not registered yet)
```

### Test 2: Register Schemas (if not already done)

```bash
bash infra/schema-registry/register-schemas.sh
# Expected: 6 schemas registered, 0 failed
```

### Test 3: List All Registered Subjects

```bash
kubectl exec -n infra deploy/schema-registry -- \
  curl -sf http://localhost:8081/subjects | python3 -m json.tool
```

Expected output:
```json
[
  "ecom-connector.public.books-value",
  "ecom-connector.public.order_items-value",
  "ecom-connector.public.orders-value",
  "inventory-connector.public.inventory-value",
  "inventory.updated-value",
  "order.created-value"
]
```

### Test 4: View Schema Versions for a Subject

```bash
kubectl exec -n infra deploy/schema-registry -- \
  curl -sf http://localhost:8081/subjects/ecom-connector.public.orders-value/versions
# Expected: [1]
```

### Test 5: Retrieve Latest Schema Content

```bash
kubectl exec -n infra deploy/schema-registry -- \
  curl -sf http://localhost:8081/subjects/ecom-connector.public.orders-value/versions/latest \
  | python3 -m json.tool
```

Expected: JSON response with `schemaType: "JSON"`, `schema: "<escaped JSON Schema>"`, `id: <number>`, `version: 1`.

### Test 6: Verify Debezium Envelope Structure

```bash
# Extract and pretty-print the schema
kubectl exec -n infra deploy/schema-registry -- \
  curl -sf http://localhost:8081/subjects/ecom-connector.public.orders-value/versions/latest \
  | python3 -c "
import sys, json
resp = json.load(sys.stdin)
schema = json.loads(resp['schema'])
print(json.dumps(schema, indent=2))
"
```

Verify the output contains:
- `properties.before` — pre-change row (null for inserts)
- `properties.after` — post-change row
- `properties.op` — operation type enum: `["c", "u", "d", "r"]`
- `$defs.OrderRow` — row structure with id, user_id, total, status

### Test 7: Check Global Compatibility Mode

```bash
kubectl exec -n infra deploy/schema-registry -- \
  curl -sf http://localhost:8081/config
# Expected: {"compatibilityLevel":"BACKWARD"}
```

### Test 8: Test Compatibility Check (Simulate Schema Evolution)

```bash
# Test if adding an optional field is backward-compatible
kubectl exec -i -n infra deploy/schema-registry -- \
  curl -sf -X POST \
  http://localhost:8081/compatibility/subjects/order.created-value/versions/latest \
  -H "Content-Type: application/vnd.schemaregistry.v1+json" \
  -d '{"schemaType":"JSON","schema":"{\"type\":\"object\",\"properties\":{\"orderId\":{\"type\":\"string\"},\"userId\":{\"type\":\"string\"},\"items\":{\"type\":\"array\"},\"total\":{\"type\":\"number\"},\"timestamp\":{\"type\":\"string\"},\"newOptionalField\":{\"type\":\"string\"}},\"required\":[\"orderId\",\"userId\",\"items\",\"total\",\"timestamp\"]}"}'
# Expected: {"is_compatible":true}
```

### Test 9: Retrieve Schema by Global ID

```bash
# Get the schema ID from a subject
SCHEMA_ID=$(kubectl exec -n infra deploy/schema-registry -- \
  curl -sf http://localhost:8081/subjects/ecom-connector.public.orders-value/versions/latest \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

# Fetch by global ID
kubectl exec -n infra deploy/schema-registry -- \
  curl -sf http://localhost:8081/schemas/ids/$SCHEMA_ID \
  | python3 -m json.tool
# Expected: Full schema with schemaType and schema fields
```

### Test 10: Verify Idempotent Re-registration

```bash
# Run register-schemas.sh again
bash infra/schema-registry/register-schemas.sh

# Check versions — should still be [1] (no new version created)
kubectl exec -n infra deploy/schema-registry -- \
  curl -sf http://localhost:8081/subjects/ecom-connector.public.orders-value/versions
# Expected: [1]
```

### Test 11: Run E2E Tests

```bash
cd e2e
npx playwright test schema-registry.spec.ts --reporter=list
# Expected: 24 tests passed
```

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Schema Registry pod CrashLoopBackOff | Kafka not ready or `enableServiceLinks` not set to `false` | Check Kafka pod status; verify `enableServiceLinks: false` in deployment |
| `curl: (7) Failed to connect` | Schema Registry not ready | Wait for readiness probe: `kubectl wait --for=condition=Ready pod -l app=schema-registry -n infra` |
| `409 Conflict` on registration | Schema version already exists with different content | Increase version or check compatibility mode |
| `422 Unprocessable Entity` | Invalid JSON Schema syntax | Validate schema JSON with `python3 -m json.tool < schema.json` |
| Empty `/subjects` response | Schemas not registered | Run `bash infra/schema-registry/register-schemas.sh` |

---

## Files

| File | Purpose |
|------|---------|
| `infra/schema-registry/schema-registry.yaml` | Deployment + ClusterIP Service |
| `infra/schema-registry/register-schemas.sh` | Idempotent schema registration script |
| `infra/schema-registry/schemas/orders-value.json` | Orders CDC envelope schema |
| `infra/schema-registry/schemas/order-items-value.json` | Order items CDC envelope schema |
| `infra/schema-registry/schemas/books-value.json` | Books CDC envelope schema |
| `infra/schema-registry/schemas/inventory-value.json` | Inventory CDC envelope schema |
| `infra/schema-registry/schemas/order-created-value.json` | Application event schema |
| `infra/schema-registry/schemas/inventory-updated-value.json` | Application event schema |
| `e2e/schema-registry.spec.ts` | 24 E2E tests |
