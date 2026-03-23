# Current Cluster State

> **Last updated:** 2026-03-11 (Session 27 in progress)
>
> This file contains mutable runtime state. For durable patterns and conventions, see `CLAUDE.md`.

## Implementation Status

**Sessions 1–27 in progress. E2E: 130/130 passing.**

### Cluster: `bookstore` (kind, 3 nodes) — RUNNING

| Namespace | Service | Status |
|---|---|---|
| ecom | ecom-service | Running |
| ecom | ui-service | Running |
| ecom | ecom-db (CNPG 2 instances) | Running |
| inventory | inventory-service | Running |
| inventory | inventory-db (CNPG 2 instances) | Running |
| identity | keycloak | Running |
| identity | keycloak-db (CNPG 2 instances) | Running |
| identity | keycloak-realm-import | Completed |
| infra | kafka (KRaft) | Running |
| infra | debezium-server-ecom | Running (Debezium Server 3.4, health at :32300/q/health) |
| infra | debezium-server-inventory | Running (Debezium Server 3.4, health at :32301/q/health) |
| infra | redis | Running |
| infra | pgadmin | Running |
| analytics | analytics-db (CNPG 2 instances) | Running |
| analytics | flink-jobmanager | Running |
| analytics | flink-taskmanager | Running |
| analytics | superset | Running |
| observability | prometheus | Running |
| cnpg-system | cnpg-controller-manager | Running (v1.25.1, manages all 4 DB clusters) |
| cert-manager | cert-manager | Running (v1.17.2, self-signed CA) |
| istio-system | kiali | Running (Prometheus connected) |

### Verified Capabilities
- `GET https://api.service.net:30000/ecom/books` → 200 with 10 seeded books (use `curl -sk`)
- TLS: cert-manager self-signed CA → gateway cert (30d rotation, 7d renewBefore)
- HTTP→HTTPS redirect: `http://*:30080` → 301 → `https://*:30000`
- Keycloak realm `bookstore` imported, JWT validation working
- CDC pipeline: Debezium Server → Kafka → Flink SQL → analytics-db
- Flink REST API `/jobs` shows 4 streaming jobs in RUNNING state
- Superset: 3 dashboards, 16 charts (Book Store Analytics, Sales & Revenue Analytics, Inventory Analytics)
- Analytics DB: 10 views (`\dv vw_*`)
- Kiali: traffic graph populated (10 nodes, 12 edges for ecom+inventory)
- E2E tests: 130/130 passing (Sessions 1–22 complete)
- ecom-service → inventory-service synchronous mTLS reserve call on checkout
- All Istio AuthorizationPolicies L4-only (ztunnel-compatible)

### Session History

Detailed per-session implementation history: `docs/architecture/session-history.md`

Key facts:
- **Session 27**: CloudNativePG HA — 4 CNPG clusters (2 instances each), ExternalName aliases, Kafka offset storage for Debezium
- Flink CDC: Debezium Server 3.4 → Kafka → Flink SQL → analytics-db → Superset (3 dashboards, 16 charts)
- Flink SQL uses plain `json` format (NOT `debezium-json`). `WHERE after IS NOT NULL` skips deletes/tombstones.
- Admin panel: `admin1`/`CHANGE_ME` (customer+admin roles), ecom `/admin/books` + `/admin/orders`, inventory `/admin/stock`
- OIDC: dynamic `redirect_uri = ${window.location.origin}/callback`, `crypto.subtle` check for PKCE fallback
- Stock UI: `/inven/stock/bulk?book_ids=...`, StockBadge component (gray/red/orange/green)
- TLS: cert-manager v1.17.2, self-signed CA (10yr) → leaf cert (30d, 7d renewBefore)
- Cert Dashboard: Go operator at NodePort 32600, SSE renewal, TokenReview auth
- DB storage: CNPG uses kind `standard` StorageClass (dynamic PVC). Non-DB PVCs still use host `data/` dirs.
- Superset working viz types: `echarts_timeseries_bar`, `echarts_timeseries_line`, `pie`, `table`, `big_number_total` (NOT `echarts_bar`/`echarts_pie`)

### NEXT SESSION — Start Here

**Session 27 in progress.** CloudNativePG HA migration. Run `bash scripts/up.sh --fresh --yes` to deploy.
