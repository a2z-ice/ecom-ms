# Session 05 — Inventory Service (FastAPI)

**Goal:** FastAPI service managing book stock, consuming order events, and publishing inventory events.

## Deliverables

- `inventory-service/` — Python FastAPI project (Poetry, Python ^3.12)
  - `alembic/` — Alembic migrations:
    - `inventory` table (book_id, quantity, reserved)
    - Seed data matching books seeded in ecom-service
  - `app/` — FastAPI app:
    - JWT validation middleware (`python-jose` + Keycloak JWKS from `KEYCLOAK_JWKS_URI` env var)
    - `GET /inven/stock/{bookId}` — public
    - `POST /inven/reserve` — internal (called by ecom-service via mTLS, not exposed externally)
    - Kafka consumer (background task via `AIOKafkaConsumer` lifespan): consumes `order.created`, deducts stock, publishes `inventory.updated`
    - `GET /health` — unauthenticated, returns `{"status": "ok"}` (Kubernetes probes)
  - `pyproject.toml` + `poetry.lock`
  - `alembic.ini` — DB URL from `DATABASE_URL` env var
- `inventory-service/Dockerfile` — multi-stage, non-root, slim Python image
- `inventory-service/k8s/` — Deployment, Service, ConfigMap, Secret

## Event Schema — `inventory.updated`

```json
{
  "bookId": "uuid",
  "previousQuantity": 10,
  "newQuantity": 8,
  "orderId": "uuid",
  "timestamp": "ISO-8601"
}
```

## Key Implementation Details

- App entry: `uvicorn app.main:app`
- Kafka consumer started/stopped in `@asynccontextmanager` lifespan function in `main.py`
- `kafka-python-ng==2.2.3` (not `kafka-python 2.0.2` — broken on Python 3.12)
- Alembic: `alembic upgrade head` as init container command
- Inventory book IDs: fixed sequential UUIDs (`00000000-0000-0000-0000-000000000001`, etc.) matching ecom-service seed (added in Session 16 changeset 005)

## Acceptance Criteria

- [x] Alembic migrations run on pod start (init container)
- [x] `GET /inven/stock/{bookId}` returns current stock
- [x] Consuming `order.created` decrements stock in DB and publishes `inventory.updated`
- [x] Invalid JWT returns 401
- [x] Pod runs as non-root

## Status: Complete ✓
