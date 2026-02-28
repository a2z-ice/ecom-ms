# Session 08 — Debezium CDC Pipeline

**Goal:** Database changes in ecom-service and inventory-service automatically replicated to the analytics DB.

## Deliverables

- `infra/debezium/connectors/` — Debezium connector registration JSONs:
  - `ecom-connector.json` — PostgreSQL source connector for `ecom-db` (captures `orders`, `order_items`, `books`)
  - `inventory-connector.json` — PostgreSQL source connector for `inventory-db` (captures `inventory`)
- `infra/debezium/register-connectors.sh` — script to POST connector configs to Debezium REST API
- `analytics/schema/analytics-ddl.sql` — SQL DDL for analytics DB:
  - Tables: `fact_orders`, `fact_order_items`, `dim_books`, `fact_inventory`
  - Views: `vw_product_sales_volume` (units sold per book), `vw_sales_over_time` (daily revenue)
  - No FK constraints (CDC delivery order not guaranteed)
- `scripts/verify-cdc.sh` — inserts a test row in ecom-db, waits, verifies it appears in analytics-db

## CDC Topic Naming Convention

```
<connector-name>.<schema>.<table>
# e.g. ecom-connector.public.orders
```

## Connector Configuration Notes

- PostgreSQL must have `wal_level=logical`, `max_replication_slots=10`, `max_wal_senders=10`
- Connector credentials loaded via mounted Secret files (not hardcoded):
  `${file:/opt/kafka/external-configuration/db-credentials/ECOM_DB_USER}`
- `key.converter.schemas.enable: false` + `value.converter.schemas.enable: false` (schemaless JSON)
- `decimal.handling.mode: double`, `snapshot.mode: initial`

## Why Custom Analytics Consumer (Not JDBC Sink)

Debezium JDBC Sink Connector (`io.debezium.connector.jdbc.JdbcSinkConnector`) throws NPE on `valueSchema()` when source uses `schemas.enable: false`. Solution: custom Python consumer at `analytics/consumer/main.py`.

Consumer reads topics → extracts Debezium `after` field → upserts into analytics DB:
```python
TOPIC_CONFIG = {
    "ecom-connector.public.orders":      ("fact_orders", "id", [...]),
    "ecom-connector.public.order_items": ("fact_order_items", "id", [...]),
    "ecom-connector.public.books":       ("dim_books", "id", [...]),
    "inventory-connector.public.inventory": ("fact_inventory", "book_id", [...]),
}
```

## Acceptance Criteria

- [x] INSERT/UPDATE/DELETE in `ecom-db.orders` appears in analytics DB within 5 seconds
- [x] INSERT/UPDATE in `inventory-db.inventory` appears in analytics DB within 5 seconds
- [x] `verify-cdc.sh` exits 0
- [x] Debezium connector status shows `RUNNING` (not `FAILED`)

## Status: Complete ✓
