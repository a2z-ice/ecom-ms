# Session 09 — Apache Superset Analytics

**Goal:** Superset deployed with two pre-built charts connected to the analytics DB.

## Deliverables

- `infra/superset/superset.yaml` — Superset Deployment + Service (namespace: `analytics`)
  - NodePort service at port 32000
  - Admin credentials via Kubernetes Secret
  - `psycopg2-binary` installed via init container into shared emptyDir volume (venv is read-only in image)
- `infra/superset/bootstrap-job.yaml` — Kubernetes Job that runs `bootstrap_dashboards.py`:
  - Registers analytics PostgreSQL as a database connection
  - Creates datasets from analytics views
  - Creates **Bar Chart**: "Product Sales Volume" (x: book title, y: units sold)
  - Creates **Trend Chart**: "Sales Over Time" (x: date, y: revenue)
  - Publishes both charts to a "Book Store Analytics" dashboard via direct SQLite update

## Superset Gotchas

- Image: `apache/superset:latest` (multi-platform pull required: `docker pull --platform linux/amd64`)
- `psycopg2` not in image; venv is read-only: use emptyDir volume shared between init+main containers
  - Init: `uv pip install psycopg2-binary --target /extra-packages`
  - Main: `PYTHONPATH=/extra-packages`
- All POST/PUT/DELETE require `X-CSRFToken` header — fetch from `/api/v1/security/csrf_token/` after login
- `viz_type: "bar"` and `viz_type: "line"` removed — use `echarts_bar` and `echarts_timeseries_line`
- Metrics must be objects: `{"expressionType": "SIMPLE", "column": {...}, "aggregate": "SUM", "label": "..."}`
- Dashboard-chart linking NOT supported via REST API — directly update SQLite table `dashboard_slices` via `sqlite3` at `/app/superset_home/superset.db`

## Acceptance Criteria

- [x] Superset UI accessible at `localhost:32000` from host (NodePort, no port-forward)
- [x] Analytics DB connection shows "Connected"
- [x] Both charts render with data after at least one order has been placed and CDC synced
- [x] Dashboard "Book Store Analytics" exists and loads

## Status: Complete ✓
