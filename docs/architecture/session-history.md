# Session Implementation History

> Extracted from CLAUDE.md for performance. This contains detailed per-session implementation notes.

## UI Bug Fixes — Completed (Post Session 15)

- **Nav cart badge for auth users**: NavBar fetches server cart count via `cartApi.get()` on login; listens for `cartUpdated` DOM event. Badge now shows for both guest and authenticated users.
- **`cartUpdated` event**: Dispatched from `CatalogPage`, `SearchPage`, and `CartPage` after any cart mutation. NavBar re-fetches count on each dispatch.
- **Minus button fix**: `CartRequest.java` has `@Min(1)` so `quantity: -1` was rejected with 400. Added `PUT /cart/{itemId}` endpoint with `CartUpdateRequest` DTO, `CartService.setQuantity()`, and `cartApi.update()` in frontend. CartPage uses `cartApi.update(item.id, item.quantity - 1)` for decrement.
- **Logout button styling**: Added `style={{ color: '#fff', borderColor: '#cbd5e0' }}` to Logout button in NavBar (matching Login button style — both white text on dark navbar).
- **`api/client.ts`**: Added `put` method alongside existing `get`, `post`, `delete`.
- **E2E coverage**: `ui-fixes.spec.ts` (5 tests) — auth badge, minus decrement, minus removes, logout color, badge clears after checkout.

## Session 14 — Completed

- Kiali Prometheus connection fixed: ExternalName service `prometheus.istio-system` → `prometheus.observability` + Prometheus deployed to `observability` namespace
- Prometheus scrape configs added for Istio telemetry: `istiod` (port 15014) + `ztunnel` DaemonSet (port 15020, kubernetes_sd_configs) + Prometheus RBAC (ServiceAccount/ClusterRole/ClusterRoleBinding)
- Architecture diagram labels corrected: "KGateway" → "Istio Gateway (K8s Gateway API)"
- E2E coverage added: `istio-gateway.spec.ts` (6 tests), `kiali.spec.ts` (3 tests), `guest-cart.spec.ts` (4 tests)
- Guest cart tests use `https://localhost:30000` (HTTPS — secure context for PKCE). All gateway endpoints now serve HTTPS.
- CLAUDE.md updated with Session 14 state, new scripts, corrected gateway terminology

## Session 15 — Completed

- `AuthContext.tsx`: `login(returnPath?)` — at non-localhost hosts redirects to `localhost:30000/login?return=<path>` (avoids `crypto.subtle` unavailability); at localhost calls `userManager.signinRedirect({ state: { returnUrl } })`
- `LoginPage.tsx` (NEW): served at `/login?return=<path>`, triggers OIDC redirect at localhost (secure context always available)
- `CallbackPage.tsx`: reads `user.state.returnUrl` and navigates to original page after auth (guest cart merge logic preserved)
- `ProtectedRoute.tsx` (NEW): route guard that calls `login()` with current path if unauthenticated
- `NavBar.tsx`: shows `...` during `isLoading` (prevents Login button flash); uses `onClick={() => login()}` not `onClick={login}` (avoids passing MouseEvent as returnPath)
- `CartPage.tsx`: uses `login('/cart')` from `useAuth()` instead of direct `userManager.signinRedirect()`
- `App.tsx`: `/login` route added; `/order-confirmation` wrapped with `ProtectedRoute`
- UI Docker image rebuilt with VITE build args (see build command in Commands section)
- **CRITICAL**: `docker build` for ui-service requires `--build-arg` for VITE_ vars (baked in at build time by Vite)

## Session 16 — Completed

- Named ServiceAccounts: `ecom-service` (ecom ns) + `inventory-service` (inventory ns)
- Rewritten AuthorizationPolicies: all L4-only (namespace + SPIFFE principal). L7 policies cause implicit deny-all in Istio Ambient without waypoint proxy
- DB policies: ecom-db, inventory-db, keycloak-db locked to their namespaces + infra
- NetworkPolicies: `infra/kubernetes/network-policies/inventory-netpol.yaml` (NEW); ecom-netpol updated with HBONE port 15008, ui-service egress, Prometheus ingress
- HTTPRoute: `inven-route.yaml` restricted to GET /stock/* and GET /health only; POST /reserve not exposed externally
- RestClientConfig: forced HTTP/1.1 — Java's default JDK HttpClient sends h2c upgrade headers that Starlette rejects with 400 "Invalid HTTP request received"
- OrderService: calls `inventoryClient.reserve()` before creating order (synchronous mTLS)
- Book UUIDs: changeset 005 re-seeds with fixed sequential UUIDs matching inventory seed data
- **E2E tests: 45/45 passing** (4 new: external POST /reserve → 404, checkout JWT 401, checkout via mTLS, reserved count increases)

## Session 18 — Completed

- **Flink CDC pipeline**: Replaced Python analytics consumer with Apache Flink 1.20 SQL pipeline
  - `analytics/flink/Dockerfile` — custom image: Flink 1.20 + Kafka/JDBC/PostgreSQL JARs baked in
  - `analytics/flink/sql/pipeline.sql` — 4 source + 4 sink tables + 4 INSERT INTO streaming pipelines
  - `infra/flink/flink-cluster.yaml` — JobManager + TaskManager Deployments with PVC checkpoints
  - `infra/flink/flink-sql-runner.yaml` — Kubernetes Job that submits SQL to the Session Cluster
  - `infra/flink/flink-pvc.yaml` + `flink-pv` in `infra/storage/persistent-volumes.yaml`
  - `infra/kind/cluster.yaml` updated with `DATA_DIR/flink` extraMount on all 3 nodes
- **Analytics DDL expanded**: 8 new views added to `analytics/schema/analytics-ddl.sql` (10 total)
  - `vw_revenue_by_author`, `vw_revenue_by_genre`, `vw_order_status_distribution`
  - `vw_inventory_health`, `vw_avg_order_value`, `vw_top_books_by_revenue`
  - `vw_inventory_turnover`, `vw_book_price_distribution`
- **Superset expanded**: 3 dashboards / 16 charts (was 1 dashboard / 2 charts)
  - "Book Store Analytics" (5 charts), "Sales & Revenue Analytics" (5 charts), "Inventory Analytics" (6 charts including 2 new pie charts)
  - Added "Stock Status Distribution" (pie) and "Revenue Share by Genre" (pie) to Inventory Analytics
  - `infra/superset/bootstrap-job.yaml` (NEW) — Kubernetes Job that runs bootstrap inside Superset pod
  - **Working viz types** (confirmed in `apache/superset:latest`): `echarts_timeseries_bar`, `echarts_timeseries_line`, `pie`, `table`, `big_number_total`
  - `echarts_bar` and `echarts_pie` are NOT registered — do not use them
- **Python consumer deleted**: `analytics/consumer/main.py`, `Dockerfile`, `requirements.txt`, `infra/analytics/analytics-consumer.yaml` removed
- **NodePort services**: Flink Web Dashboard at NodePort 32200 (`flink-jobmanager-nodeport` service) + Debezium health at NodePort 32300 (`debezium-nodeport` service, later replaced by `debezium-server-ecom-nodeport` in Session 22). Both exposed directly via kind `extraPortMappings` — no proxy containers.
- **E2E coverage**: `e2e/superset.spec.ts` expanded to 17 tests (API + UI: 3 dashboards, 14 charts, 10 datasets); `e2e/debezium-flink.spec.ts` (NEW) — 29 tests covering Debezium API, Flink dashboard, CDC end-to-end flow, operational health.
- **Documentation**: `docs/cdc/debezium-flink-cdc.md` — comprehensive guide with architecture diagrams, per-component deep dives, data flow walkthrough, REST API reference, and E2E test coverage index.

## Flink CDC Architecture (Session 22 — updated versions)

```
Debezium Server 3.4 → Kafka (4 topics) → Flink 2.2.0 SQL (plain json, after field extraction) → JDBC → analytics-db
(2 pods: ecom + inv)                                                                                       ↓
                                                                                              Superset (3 dashboards, 16 charts)
```

**Versions (Session 22):**
- Flink: `2.2.0-scala_2.12-java17`
- flink-connector-kafka: `4.0.1-2.0`
- flink-connector-jdbc: `4.0.0-2.0`
- kafka-clients: `3.9.2`
- postgresql JDBC: `42.7.10`
- Debezium Server: `3.4.1.Final` (replaces Kafka Connect `2.7.0.Final`)

**Flink SQL format choice**: Uses plain `json` format (NOT `debezium-json`). Reason: `debezium-json` requires `REPLICA IDENTITY FULL` on source tables for UPDATE events (the "before" field must be non-null). Plain `json` format parses the Debezium envelope directly and extracts the `after` ROW field — works regardless of REPLICA IDENTITY setting.

**Source table schema**: Each source table has an `after ROW<...>` field and an `op STRING` field matching Debezium's JSON envelope. `WHERE after IS NOT NULL` in INSERT statements skips DELETE events and tombstones.

**Timestamp conversion**: Debezium sends `TIMESTAMP WITH TIME ZONE` as ISO 8601 strings (`"2026-02-26T18:58:09.811060Z"`). Flink JSON format uses SQL format (space separator). Conversion: `CAST(REPLACE(REPLACE(col, 'T', ' '), 'Z', '') AS TIMESTAMP(3))`.

**JDBC sink**: Uses `TIMESTAMP(3)` (NOT `TIMESTAMP_LTZ(3)` — JDBC connector does not support it). `?stringtype=unspecified` in JDBC URL allows implicit `varchar → uuid` casts in PostgreSQL.

**Exactly-once**: Flink checkpoints at `/opt/flink/checkpoints` (PVC-backed, `hashmap` state backend). Interval: 30s, mode: `EXACTLY_ONCE`.

**Partition discovery**: All 4 Kafka source tables set `'scan.topic-partition-discovery.interval' = '300000'` (5 min, enabled). This is the **production-grade setting** required for Kafka topic scaling (auto-detects new partitions). New TABLES always require a SQL change + job resubmit regardless.

**AdminClient connection resilience** (production-grade fix for NAT idle-connection crash): All 4 source tables also set:
- `'properties.connections.max.idle.ms' = '180000'` — AdminClient proactively closes idle connection after 3 min (< 5 min discovery interval). Each discovery cycle opens a fresh connection → no stale NAT state → no `UnknownTopicOrPartitionException`.
- `'properties.reconnect.backoff.ms' = '1000'`, `'properties.reconnect.backoff.max.ms' = '10000'`, `'properties.request.timeout.ms' = '30000'`, `'properties.socket.connection.setup.timeout.ms' = '10000'`, `'properties.socket.connection.setup.timeout.max.ms' = '30000'`, `'properties.metadata.max.age.ms' = '300000'`.

**Adding a new table** (production procedure — partition discovery does NOT automate this):
1. Add migration (Liquibase/Alembic) in the source service
2. Update Debezium Server `table.include.list` in the appropriate ConfigMap (`debezium-server-ecom-config` or `debezium-server-inventory-config`) and restart the pod
3. Add DDL to `analytics/schema/analytics-ddl.sql`
4. Add Kafka source table + JDBC sink table + `INSERT INTO` pipeline to `analytics/flink/sql/pipeline.sql` AND `infra/flink/flink-sql-runner.yaml` ConfigMap (copy the full WITH clause template including all 8 connection properties)
5. Resubmit: `kubectl apply -f infra/flink/flink-sql-runner.yaml && kubectl delete job flink-sql-runner -n analytics --ignore-not-found && kubectl apply -f infra/flink/flink-sql-runner.yaml && kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=120s`

**Deprecated config keys fixed**: `state.backend.type: hashmap` (was `state.backend: filesystem`); `execution.checkpointing.dir` (was `state.checkpoints.dir`). Config comes from `FLINK_PROPERTIES` env var in `flink-cluster.yaml` — the `flink-config.yaml` ConfigMap is NOT mounted and is kept for reference only.

## Fresh Bootstrap Fixes (2026-03-02 — additional)

These bugs were found during a `up.sh --fresh` rebuild (data preserved):

- **Keycloak import 180s timeout**: `scripts/keycloak-import.sh` `kubectl wait --timeout` was 180s. On fresh cluster, `kc.sh import` triggers a Keycloak binary rebuild phase (~90s) + startup (~60s) + import (~15s) = ~165s total. Increased timeout to 360s. Fix: `keycloak-import.sh` line 25.
- **Flink SQL runner not resubmitted after recovery**: `up.sh` recovery function and `restart-after-docker.sh` restarted Flink JM/TM pods but never deleted + recreated the `flink-sql-runner` Job. Flink Session Cluster loses all streaming jobs on JM restart; the completed K8s Job won't re-run. Both scripts now poll SQL Gateway readiness → delete + recreate the Job. Fix: both scripts, Step 5.
- **E2E cold-start flake**: `cart.spec.ts` add-to-cart test failed on first run after fresh cluster (ecom-service POST /cart slow during cold start; button reverts to "Add to Cart" silently on both success and failure). Fix: `playwright.config.ts` `retries: 1` (was `CI ? 1 : 0`).

## Fresh Bootstrap Fixes (2026-03-01)

These bugs were found and fixed during a full `up.sh --fresh --data` rebuild:

- **GatewayClass race condition**: `kgateway/install.sh` now polls for `gatewayclass/istio` before `kubectl wait` (istiod creates it asynchronously after startup)
- **Istio Gateway NodePort**: Istio auto-creates `bookstore-gateway-istio` service with random NodePort. `up.sh` now patches it to 30000 after creation (must match kind `extraPortMappings`)
- **Istio STRICT mTLS + NodePort**: ztunnel rejects plaintext from host via kind NodePort. Fixed with workload-specific `PeerAuthentication` using `portLevelMtls: PERMISSIVE` for each NodePort-exposed infra/analytics service (requires `selector`; namespace-wide portLevelMtls is not supported)
- **Kafka CDC topics**: `KAFKA_AUTO_CREATE_TOPICS_ENABLE=false` — added 4 Debezium topics to kafka-topic-init job (`ecom-connector.public.{books,orders,order_items}`, `inventory-connector.public.inventory`)
- **Keycloak missing `sub` claim**: Realm import with custom `clientScopes` (roles/profile/email) replaced Keycloak's built-in `openid` scope, losing the `sub` claim mapper. Fixed: added `oidc-sub-mapper` to the `profile` scope in `realm-export.json`. Without `sub`, `jwt.getSubject()` returns null → `null user_id` in cart_items.
- **Analytics DDL ordering**: Must be applied BEFORE Flink starts (Flink JDBC sink requires tables to pre-exist). Moved DDL apply to right after `analytics-db` is ready. Fixed `kubectl exec` to use `-i` flag (without it, stdin redirect is silently ignored).
- **verify-cdc.sh column name**: Fixed `WHERE order_id = '...'` to `WHERE id = '...'` in fact_orders polling query.

## Bootstrap Optimization (2026-03-01)

`scripts/up.sh --fresh` rewritten to parallelize heavily:
- **Docker builds start as background processes** right after storage/namespaces — overlap entire infra deploy phase (~8-12 min saved on cold build)
- **PostgreSQL, Redis+Kafka, Flink JM+TM** all waited in parallel (`kubectl rollout status ... &` + `wait`)
- **Keycloak apply overlaps Flink startup** (both applied at same time, waited separately)
- **Flink sql-runner** submitted fire-and-forget; verified at end
- **Kiali helm install** moved to END of bootstrap (was blocking top ~8-10 min)
- **PgAdmin** removed from critical path (apply only, no wait)
- **App service waits** run in parallel

`infra/debezium/register-connectors.sh`: replaced hardcoded `sleep 15` with a poll loop (5s interval, max 60s) checking connector RUNNING state.

`infra/superset/bootstrap-job.yaml` fixed:
- ServiceAccount moved to first YAML document (Job controller needs it at scheduling time)
- `echarts_bar` → `echarts_timeseries_bar` (echarts_bar not registered in apache/superset:latest)
- `echarts_pie` → `pie` (echarts_pie not registered in apache/superset:latest)
- Container command changed to use `/app/.venv/bin/python` (Superset's venv, has requests built-in — no pip install, no network dependency)

## Persistence — Fully Implemented

All stateful services are backed by PVCs → PVs → host `data/` directory:

| Service | PVC | PV hostPath | Survives restart |
|---|---|---|---|
| ecom-db | `ecom-db-pvc` | `data/ecom-db` | ✓ |
| inventory-db | `inventory-db-pvc` | `data/inventory-db` | ✓ |
| analytics-db | `analytics-db-pvc` | `data/analytics-db` | ✓ |
| keycloak-db | `keycloak-db-pvc` | `data/keycloak-db` | ✓ |
| kafka | `kafka-pvc` | `data/kafka` | ✓ |
| redis | `redis-pvc` | `data/redis` | ✓ |
| flink | `flink-checkpoints-pvc` | `data/flink` | ✓ |
| superset | `superset-pvc` | `data/superset` | ✓ |

`cluster-up.sh` creates all `data/` subdirectories before `kind create cluster`. The `cluster.yaml` mounts `DATA_DIR/<name>` → `/data/<name>` on all 3 nodes.

**Kafka PVC mount fix (Session 19)**: `confluentinc/cp-kafka` declares `VOLUME /var/lib/kafka/data` in its Dockerfile. Docker auto-creates an anonymous volume at that path that shadows any parent bind mount. Fix: mount the PVC at `/var/lib/kafka/data` (exact VOLUME path) so the bind mount takes precedence. The PVC is now at `volumeMounts.mountPath: /var/lib/kafka/data` in `infra/kafka/kafka.yaml`. After this fix, KRaft cluster metadata persists across pod restarts. CDC topics (`ecom-connector.public.*`) still require `kafka-topics-init.yaml` + `register-connectors.sh` after each Kafka restart (since `connect-offsets` topic is lost when Kafka resets).

## Session 20 — Completed (Stock Management UI)

- `GET /inven/stock/bulk?book_ids=...` endpoint (returns `list[StockResponse]`, before `/{book_id}` route)
- `StockBadge.tsx` component (gray loading, red OOS, orange low, green in-stock)
- `CatalogPage.tsx`: bulk stock fetch; badges; OOS button disabled
- `SearchPage.tsx`: Availability column; OOS buttons disabled
- `CartPage.tsx`: Availability column; per-item badges; checkout blocked when OOS
- `e2e/stock-management.spec.ts`: 9 tests covering API structure + UI behavior

## Session 21 — Completed (Admin Panel)

- **Keycloak**: `admin1` user has both `customer` + `admin` realm roles. `ui-client` has `directAccessGrantsEnabled: true` (needed for curl-based token tests and API reference docs)
- **ecom-service admin API** (`/admin/books`, `/admin/orders`):
  - `AdminBookController.java`: GET/POST/PUT/DELETE at `/admin/books` — `@PreAuthorize("hasRole('ADMIN')")`
  - `AdminOrderController.java`: GET all orders at `/admin/orders` — admin only
  - `BookRequest.java` DTO, `AdminOrderResponse.java` DTO
  - `BookService.java` updated with create/update/delete
- **inventory-service admin API** (`/admin/stock`):
  - `api/admin.py`: GET (list all), PUT (set absolute qty), POST (adjust by delta)
  - All endpoints: `require_role("admin")` dependency
- **Gateway**: `inven-route.yaml` exposes `/inven/admin/**` (PathPrefix, all methods)
- **UI**:
  - `AuthContext.tsx`: `isAdmin` (decodes access token to check roles)
  - `AdminRoute.tsx`: not-logged-in → redirects to login; not-admin → shows "Access Denied"
  - `NavBar.tsx`: gold "Admin" link visible only when `isAdmin`
  - `api/admin.ts`: admin API client (books, orders, stock)
  - `pages/admin/`: `AdminDashboard.tsx`, `AdminBooksPage.tsx`, `AdminEditBookPage.tsx`, `AdminStockPage.tsx`, `AdminOrdersPage.tsx`
  - `App.tsx`: `/admin`, `/admin/books`, `/admin/books/new`, `/admin/books/:id`, `/admin/stock`, `/admin/orders` routes
- **E2E**: `admin.spec.ts` (21 tests: API access control, book CRUD, stock management, UI), `fixtures/admin.setup.ts`, `fixtures/admin-base.ts`, `fixtures/admin1.json`
- **E2E tests: 128/128 passing** (8 new: 2 myecom.net redirect + 6 Keycloak admin console tests)

## Post-Session-21 Fixes — Complete (2026-03-02)

- **Admin logout**: Fixed `AuthContext.tsx` `logout()` — `removeUser()` + `setUser(null)` before redirect; trailing `/` in `post_logout_redirect_uri` to match `http://localhost:30000/*` wildcard
- **realm-export.json**: Added `"postLogoutRedirectUris": ["+"]` to `ui-client` config
- **Keycloak admin NodePort**: `infra/keycloak/keycloak-nodeport.yaml` (NodePort 32400); `cluster.yaml` updated with `extraPortMappings`; `keycloak-nodeport-permissive` PeerAuthentication added to `peer-auth.yaml`
- **smoke-test.sh**: Section 5 admin API access control (7 checks); `http_check_bearer` and `http_check_any` helpers
- **docs/guides/admin-feature.md**: Comprehensive admin panel guide with screenshots and API examples
- **myecom.net redirect fix** (direct PKCE, updated 2026-03-03):
  - `oidcConfig.ts`: `redirect_uri = ${window.location.origin}/callback` (dynamic — uses current origin, not baked VITE_REDIRECT_URI)
  - `AuthContext.tsx` `login()`: checks `!crypto?.subtle` (not hostname). Chrome treats `http://myecom.net:30000` as secure context (loopback DNS → 127.0.0.1), so PKCE runs directly there
  - `CallbackPage.tsx`: hash relay retained as fallback for `isAbsolute` returnUrl (when crypto.subtle unavailable)
  - E2E: `auth.spec.ts` myecom.net tests — screenshot moved after logout assertion; 30s timeout for admin test
- **docs/api/api-reference.md**: Keycloak Admin URLs added to URL Quick Reference table

## Session 22 — Completed (2026-03-06)

- **Flink connector update**: Updated `analytics/flink/Dockerfile` connector JARs (kafka 3.4.0-1.20→kept at 1.20, jdbc 3.3.0-1.20→kept at 1.20, kafka-clients 3.9.2, postgresql 42.7.10). NOTE: Flink base image stays at 1.20 — `flink-connector-jdbc` has no Flink 2.x release on Maven Central yet (latest is 3.3.0-1.20 for 1.20)
- **Debezium Kafka Connect → Debezium Server 3.4**: Replaced single Kafka Connect pod with two Debezium Server pods (one per source DB). Config via `application.properties` ConfigMap. No REST registration — auto-starts on pod launch.
- **New manifests**: `debezium-server-ecom.yaml` (NodePort 32300) + `debezium-server-inventory.yaml` (NodePort 32301)
- **Removed**: `debezium.yaml`, `connectors/*.json` — replaced by ConfigMap-based config
- **New Kafka topics**: `debezium.ecom.offsets` + `debezium.inventory.offsets` (Debezium Server offset storage)
- **PeerAuthentication**: Replaced `debezium-nodeport-permissive` (port 8083) with two entries for port 8080
- **kind cluster.yaml**: Added port 32301 to `extraPortMappings` (requires `--fresh`)
- **`register-connectors.sh`**: Now a health-poll script (`/q/health`) — no REST connector registration
- **Scripts updated**: `up.sh`, `infra-up.sh`, `restart-after-docker.sh`, `smoke-test.sh`
- **E2E**: Suite 1 in `debezium-flink.spec.ts` fully rewritten for Debezium Server health API; Suite 4 updated for 2 pods + 2 NodePorts
- **Flink SQL pipeline unchanged**: Same Kafka topics, same Debezium JSON envelope format

## Session 24 — Completed (TLS / cert-manager)

- **cert-manager v1.17.2**: Installed via `infra/cert-manager/install.sh`; manages self-signed CA and gateway leaf certificate
- **Certificate chain**: `selfsigned-bootstrap` ClusterIssuer → `bookstore-ca` Certificate (10yr) → `bookstore-ca-issuer` ClusterIssuer → `bookstore-gateway-cert` Certificate (30d, renewBefore 7d) → `bookstore-gateway-tls` Secret
- **Gateway HTTPS**: Port 30000 now serves HTTPS (TLS terminated at Istio Gateway). All hostnames covered: `myecom.net`, `api.service.net`, `idp.keycloak.net`, `localhost`, `127.0.0.1`
- **HTTP→HTTPS redirect**: Port 30080 returns 301 to `https://<host>:30000` via HTTPRoute at `infra/kgateway/routes/https-redirect.yaml`
- **kind cluster.yaml**: Port 30080 added to `extraPortMappings` (requires `up.sh --fresh`)
- **Browser trust**: `bash scripts/trust-ca.sh --install` extracts CA cert to `certs/bookstore-ca.crt` and adds to macOS Keychain
- **E2E**: `playwright.config.ts` uses `ignoreHTTPSErrors: true`; baseURL changed to `https://localhost:30000`
- **curl**: All smoke tests and verification scripts use `-sk` flag for self-signed cert
- **Tool NodePorts unchanged**: 31111, 32000, 32100, 32200, 32300, 32301, 32400, 32500, 32600 remain HTTP
- **Manifests**: `infra/cert-manager/ca-issuer.yaml`, `gateway-certificate.yaml`, `rotation-config.yaml`

## Session 25 — Completed (Cert Dashboard Kubernetes Operator)

- **Go-based Kubernetes operator** (`cert-dashboard-operator/`) using operator-sdk + OLM
- **CertDashboard CRD** (`v1alpha1`): spec includes namespaces, nodePort, thresholds, image, replicas
- **Go web dashboard** with embedded HTML/CSS/JS (`embed.FS`): dark theme, certificate cards, progress bars (green/yellow/red), renewal modal, SSE streaming
- **API endpoints**: `GET /api/certs`, `POST /api/renew`, `GET /api/sse/{streamId}`, `GET /healthz`
- **Renewal via secret deletion**: Delete TLS secret → cert-manager re-issues → SSE streams phases (deleting-secret → waiting-issuing → issued → ready → complete)
- **Single Docker image**: Both `/manager` (operator) and `/dashboard` (web server) binaries, different entrypoints
- **OLM installed**: Operator Lifecycle Manager for production-grade operator lifecycle
- **NodePort 32600**: Exposed via kind `extraPortMappings` (requires `up.sh --fresh`)
- **Istio PeerAuthentication**: `portLevelMtls: PERMISSIVE` on port 8080 for NodePort access
- **Deployment script**: `scripts/cert-dashboard-up.sh` — builds images, installs OLM, deploys operator + CR
- **E2E tests**: `cert-dashboard.spec.ts` — 32 passed, 1 skipped (CRD, operator, API, UI, token modal, auth, renewal SSE flow)
- **Key fix**: Kubernetes unstructured API stores revision as `int64` (not `float64`) — use type switch for both
- **Validation webhook**: CertDashboardValidator (threshold ordering, image required, replicas >= 0, nodePort range)
- **Kubernetes TokenReview auth**: POST /api/renew requires Bearer token validated via TokenReview API; ClusterRole includes `authentication.k8s.io/tokenreviews/create`
- **Token modal UI**: Renewal confirmation dialog with password-masked token input, Show/Hide toggle, clipboard copy icon (SVG with checkmark feedback), client-side validation, centered dialog with word-wrapped kubectl command
- **Prometheus metrics**: 5 custom metrics (`cert_dashboard_*`) at `GET /metrics`
- **Rate limiting**: 1 renewal per 10 seconds globally; auth checked before rate limit (unauthenticated requests don't consume the window)
- **Pod security hardened**: seccomp RuntimeDefault, capabilities drop ALL on reconciled Deployment
- **Safe type assertions**: Panic fix in parseCertificate (nil spec, invalid spec type)
- **CertProvider interface**: Server.watcher typed as interface for testability
- **44 Go tests**: controller 8, handlers 11, cert_watcher 7, webhook 9 (was 2 stubs)
- **HTTP timeouts**: ReadHeaderTimeout 10s, ReadTimeout 30s, IdleTimeout 120s
- **Input validation**: name max 253 chars, namespace max 63 chars on POST /api/renew
- **scripts/cert-dashboard-up.sh**: Complete pipeline script (test -> build -> deploy -> verify, 8 verification checks)
- **rebuild-deploy.sh**: Quick rebuild script in `cert-dashboard-operator/` (no-cache build, kind image clearing, RBAC update, pod restart, 8 verification checks)
