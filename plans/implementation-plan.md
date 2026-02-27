# Implementation Plan — Book Store E-Commerce Platform

Each session below is a self-contained unit of work that can be reviewed and approved before proceeding to the next.
Acceptance criteria must pass before marking a session complete.

**Status legend:** `[ ]` pending · `[x]` complete · `[~]` in progress

---

## Session 1 — Cluster Foundation

**Goal:** A running kind cluster with Istio Ambient Mesh, KGateway, and all namespaces ready. No applications yet.

### Deliverables

- `infra/kind/cluster.yaml` — kind cluster config with:
  - `hostMapping` entries for `myecom.net`, `api.service.net`, `idp.keycloak.net` → node IP
  - `NodePort` range including 30000 and 31111
- `infra/namespaces.yaml` — namespaces: `ecom`, `inventory`, `analytics`, `identity`, `infra`, `observability`
  - Each namespace labelled for Istio ambient: `istio.io/dataplane-mode: ambient`
- `infra/istio/install.sh` — installs Istio Ambient Mesh 1.28.4 via `istioctl` with ambient profile
- `infra/kgateway/install.sh` — installs KGateway CRDs and controller (latest)
- `scripts/cluster-up.sh` — idempotent script: creates cluster, installs Istio, KGateway, applies namespaces

### Acceptance Criteria

- [x] `kubectl get nodes` shows cluster ready
- [x] `istioctl verify-install` passes
- [x] KGateway controller pod running in `kgateway-system`
- [x] All namespaces exist with correct Istio labels
- [x] No port-forwarding required to reach NodePort 30000 from host

---

## Session 2 — Infrastructure Services

**Goal:** PostgreSQL instances, Redis, Kafka, Debezium, and PgAdmin deployed and reachable within the cluster.

### Deliverables

- `infra/postgres/` — Kubernetes manifests for four PostgreSQL instances:
  - `ecom-db` (namespace: `ecom`) — for E-Commerce Service
  - `inventory-db` (namespace: `inventory`) — for Inventory Service
  - `analytics-db` (namespace: `analytics`) — CDC sink target
  - Each: Deployment + Service + PersistentVolumeClaim + Secret
- `infra/redis/` — Redis Deployment + Service (namespace: `infra`)
- `infra/kafka/` — Kafka + Zookeeper manifests (namespace: `infra`)
  - Pre-create topics: `order.created`, `inventory.updated`
- `infra/debezium/` — Debezium Deployment + Service (namespace: `infra`); connector configs added in Session 8
- `infra/pgadmin/` — PgAdmin Deployment + NodePort Service at port 31111 (namespace: `infra`)
- `scripts/infra-up.sh` — applies all infra manifests in dependency order

### Conventions

- All passwords/credentials in Kubernetes Secrets; never in manifests as plaintext
- Postgres data on PVC (not emptyDir)
- Containers run as non-root (`runAsNonRoot: true`, `runAsUser: 999` for postgres)

### Acceptance Criteria

- [x] All four PostgreSQL pods `Running`; accessible from within cluster by service DNS
- [x] Redis pod `Running`
- [x] Kafka pod `Running`; `kafka-topics.sh --list` shows `order.created` and `inventory.updated`
- [x] Debezium pod `Running` (no connectors yet)
- [x] PgAdmin accessible at `localhost:31111` from host (NodePort)

---

## Session 3 — Keycloak Identity Provider

**Goal:** Keycloak running and fully configured: realm, clients, roles, and test users ready.

### Deliverables

- `infra/keycloak/` — Keycloak 26.5.4 Deployment + Service (namespace: `identity`)
- `infra/keycloak/realm-export.json` — Keycloak realm export containing:
  - Realm: `bookstore`
  - Clients:
    - `ui-client` — public, Authorization Code + PKCE, redirect URIs for `myecom.net`
    - `ecom-service` — confidential (for service-to-service token introspection if needed)
    - `inventory-service` — confidential
  - Roles: `customer`, `admin`
  - Test users: `user1` (customer), `admin1` (admin) — passwords in Secrets
- `infra/keycloak/import-job.yaml` — Kubernetes Job to import realm on first boot
- `infra/kgateway/routes/keycloak-route.yaml` — HTTPRoute: `idp.keycloak.net:30000` → Keycloak service

### Acceptance Criteria

- [x] `https://idp.keycloak.net:30000` reachable from host (NodePort, no port-forward)
- [x] Bookstore realm visible in Keycloak admin console
- [x] OIDC discovery endpoint responds: `https://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration`
- [x] `user1` can obtain a token via password grant (smoke test only; PKCE tested in Session 12)

---

## Session 4 — E-Commerce Service (Spring Boot)

**Goal:** Fully functional Spring Boot service with JWT-secured REST APIs, Liquibase-managed DB, and Kafka producer.

### Deliverables

- `ecom-service/` — Spring Boot 4.0.3 project (Maven)
  - `src/main/resources/db/changelog/` — Liquibase changelogs:
    - `books` table (id, title, author, price, description, cover_url)
    - `cart_items` table (id, user_id, book_id, quantity)
    - `orders` table (id, user_id, total, status, created_at)
    - `order_items` table (id, order_id, book_id, quantity, price)
    - Seed data: at least 10 books
  - `application.yml` — all values from env vars (no hardcoded config)
  - Spring Security: `SecurityFilterChain` as OIDC Resource Server, Keycloak JWKS URI from env
  - REST controllers: `BookController`, `CartController`, `OrderController`
  - Kafka producer: publishes `order.created` event on `POST /checkout`
  - Rate limiting via Spring's built-in or Bucket4j + Redis
- `ecom-service/Dockerfile` — multi-stage, non-root, minimal JRE image
- `ecom-service/k8s/` — Deployment, Service, ConfigMap, Secret (DB creds, Kafka, Keycloak JWKS URL)
  - Liquibase runs as init container before app starts

### API Contract

```
GET  /ecom/books                 → public, no auth
GET  /ecom/books/search?q=...    → public, no auth
POST /ecom/cart                  → requires JWT (role: customer)
GET  /ecom/cart                  → requires JWT (role: customer)
POST /ecom/checkout              → requires JWT (role: customer)
```

### Event Schema — `order.created`

```json
{
  "orderId": "uuid",
  "userId": "string",
  "items": [{ "bookId": "uuid", "quantity": 2, "price": 19.99 }],
  "total": 39.98,
  "timestamp": "ISO-8601"
}
```

### Acceptance Criteria

- [x] `GET /ecom/books` returns book list (no auth required)
- [x] `POST /ecom/checkout` with valid JWT publishes event to `order.created` topic
- [x] Liquibase migrations run automatically on pod start
- [x] Invalid JWT returns 401; missing role returns 403
- [x] Pod runs as non-root

---

## Session 5 — Inventory Service (FastAPI)

**Goal:** FastAPI service managing book stock, consuming order events, and publishing inventory events.

### Deliverables

- `inventory-service/` — Python FastAPI project
  - `alembic/` — Alembic migrations:
    - `inventory` table (book_id, quantity, reserved)
    - Seed data matching books seeded in ecom-service
  - `app/` — FastAPI app:
    - JWT validation middleware (PyJWT + Keycloak JWKS)
    - `GET /inven/stock/{bookId}` — public
    - `POST /inven/reserve` — internal (called by ecom-service, mTLS-only)
    - Kafka consumer (background task): consumes `order.created`, deducts stock, publishes `inventory.updated`
  - `requirements.txt` / `pyproject.toml`
  - `alembic.ini` — DB URL from env var
- `inventory-service/Dockerfile` — multi-stage, non-root, slim Python image
- `inventory-service/k8s/` — Deployment, Service, ConfigMap, Secret

### Event Schema — `inventory.updated`

```json
{
  "bookId": "uuid",
  "previousQuantity": 10,
  "newQuantity": 8,
  "orderId": "uuid",
  "timestamp": "ISO-8601"
}
```

### Acceptance Criteria

- [x] Alembic migrations run on pod start (init container)
- [x] `GET /inven/stock/{bookId}` returns current stock
- [x] Consuming `order.created` decrements stock in DB and publishes `inventory.updated`
- [x] Invalid JWT returns 401
- [x] Pod runs as non-root

---

## Session 6 — UI Service (React)

**Goal:** React 19.2 SPA implementing the full user journey — catalog, search, cart, login, checkout.

### Deliverables

- `ui/` — React 19.2 project (Vite)
  - `src/auth/` — OIDC PKCE flow using `oidc-client-ts`
    - Tokens stored in memory (React context/state)
    - Refresh tokens in HTTP-only cookies (via BFF pattern or Keycloak cookie)
    - CSRF token fetched from backend, stored in memory, sent in `X-CSRF-Token` header
  - Pages: `CatalogPage`, `SearchPage`, `CartPage`, `CheckoutPage`, `CallbackPage`
  - `src/api/` — typed API client for ecom-service and inventory-service
  - Content Security Policy headers served by Nginx
  - Nginx `default.conf` — SPA routing, security headers, proxy for `/ecom` and `/inven`
- `ui/Dockerfile` — multi-stage: `node` build → `nginx:alpine`, non-root
- `ui/k8s/` — Deployment, Service, ConfigMap (Nginx config)
- `infra/kgateway/routes/` — HTTPRoutes:
  - `myecom.net:30000` → UI service
  - `api.service.net:30000/ecom` → ecom-service
  - `api.service.net:30000/inven` → inventory-service

### Auth Flow

1. Anonymous user sees catalog and search (no token required)
2. "Add to cart" or "Checkout" triggers redirect to Keycloak
3. After login, redirect back with auth code → exchanged for tokens
4. Access token in memory; refresh token in HTTP-only cookie
5. Token refresh handled silently via hidden iframe or refresh endpoint

### Acceptance Criteria

- [x] `myecom.net:30000` loads catalog without login
- [x] Search returns filtered results
- [x] Clicking "Login" redirects to Keycloak; successful login returns to app
- [x] Cart shows items post-login; checkout submits order
- [x] No tokens in localStorage or sessionStorage
- [x] CSP headers present on all responses

---

## Session 7 — KGateway Routing

**Goal:** All external routes configured and verified end-to-end through KGateway.

### Deliverables

- `infra/kgateway/gateway.yaml` — Gateway resource:
  - `gatewayClassName: kgateway`
  - Listener on port 30000 (HTTP, NodePort)
- `infra/kgateway/routes/ui-route.yaml` — `myecom.net` → `ui-service`
- `infra/kgateway/routes/ecom-route.yaml` — `api.service.net /ecom` → `ecom-service`
- `infra/kgateway/routes/inven-route.yaml` — `api.service.net /inven` → `inventory-service`
- `infra/kgateway/routes/keycloak-route.yaml` — `idp.keycloak.net` → `keycloak-service`
- `scripts/verify-routes.sh` — `curl` smoke tests for all routes

### Acceptance Criteria

- [x] All four hostnames resolve and respond correctly from host machine
- [x] Path prefix stripping works: `/ecom/books` → ecom-service receives `/books` (or `/ecom/books` — consistent with service config)
- [x] No NodePort change required; all traffic through port 30000

---

## Session 8 — Debezium CDC Pipeline

**Goal:** Database changes in ecom-service and inventory-service automatically replicated to the analytics DB.

### Deliverables

- `infra/debezium/connectors/` — Debezium connector registration JSONs:
  - `ecom-connector.json` — PostgreSQL source connector for `ecom-db` (captures `orders`, `order_items`, `books`)
  - `inventory-connector.json` — PostgreSQL source connector for `inventory-db` (captures `inventory`)
- `infra/debezium/register-connectors.sh` — script to POST connector configs to Debezium REST API
- `analytics/schema/` — SQL DDL for analytics DB:
  - `fact_orders`, `fact_order_items`, `dim_books`, `fact_inventory` tables
- `infra/kafka/sink-connector.json` — JDBC Sink Connector to write from Kafka CDC topics → analytics DB
- `scripts/verify-cdc.sh` — inserts a test row in ecom-db, waits, verifies it appears in analytics-db

### CDC Topic Naming Convention

```
<connector-name>.<schema>.<table>
# e.g. ecom-connector.public.orders
```

### Acceptance Criteria

- [x] INSERT/UPDATE/DELETE in `ecom-db.orders` appears in analytics DB within 5 seconds
- [x] INSERT/UPDATE in `inventory-db.inventory` appears in analytics DB within 5 seconds
- [x] `verify-cdc.sh` exits 0
- [x] Debezium connector status shows `RUNNING` (not `FAILED`)

---

## Session 9 — Apache Superset Analytics

**Goal:** Superset deployed with two pre-built charts connected to the analytics DB.

### Deliverables

- `infra/superset/` — Superset Deployment + Service (namespace: `analytics`)
  - NodePort service (choose a distinct port, e.g., 32000)
  - Admin credentials via Kubernetes Secret
- `infra/superset/bootstrap/` — Python script run as Kubernetes Job post-deploy:
  - Registers analytics PostgreSQL as a database connection
  - Creates dataset from `fact_order_items` joined with `dim_books`
  - Creates **Bar Chart**: "Product Sales Volume" (x: book title, y: units sold)
  - Creates **Trend Chart**: "Sales Over Time" (x: date, y: revenue)
  - Publishes both charts to a "Book Store Analytics" dashboard

### Acceptance Criteria

- [x] Superset UI accessible from host (NodePort, no port-forward)
- [x] Analytics DB connection shows "Connected"
- [x] Both charts render with data after at least one order has been placed and CDC synced
- [x] Dashboard "Book Store Analytics" exists and loads

---

## Session 10 — Istio Security Hardening

**Goal:** Zero-trust enforcement: strict mTLS, JWT validation at mesh level, and fine-grained authorization policies.

### Deliverables

- `infra/istio/security/peer-auth.yaml` — `PeerAuthentication` STRICT mTLS for all app namespaces
- `infra/istio/security/request-auth.yaml` — `RequestAuthentication` pointing to Keycloak JWKS for `ecom` and `inventory` namespaces
- `infra/istio/security/authz-policies/` — `AuthorizationPolicy` per service:
  - `ecom-service-policy.yaml` — allow only: UI (GET /books*), authenticated users (POST /cart, POST /checkout)
  - `inventory-service-policy.yaml` — allow only: ecom-service (mTLS principal) for `/reserve`
  - `analytics-policy.yaml` — deny all external traffic (internal only)
- `infra/kubernetes/network-policies/` — `NetworkPolicy` per namespace (deny-all + explicit allow)
- `infra/kubernetes/pod-security/` — `PodSecurity` admission labels on each namespace (baseline or restricted)

### Acceptance Criteria

- [x] `curl` from one namespace to another without a valid JWT returns 403
- [x] Cross-namespace calls without mTLS (e.g., from outside mesh) are rejected
- [x] `kiali` shows all traffic as mTLS-encrypted (green lock icons)
- [x] PodSecurity violations fail admission (test with a pod running as root)

---

## Session 11 — Observability Stack

**Goal:** Metrics, tracing, and dashboards for all services.

### Deliverables

- `infra/observability/prometheus/` — Prometheus Deployment + ServiceMonitors for each service namespace
- `infra/observability/grafana/` — Grafana Deployment + pre-built dashboards:
  - JVM metrics dashboard for ecom-service
  - FastAPI metrics dashboard for inventory-service
  - Kafka lag dashboard
- `infra/observability/kiali/` — Kiali Deployment connected to Prometheus and Istio
- OpenTelemetry instrumentation:
  - `ecom-service`: Java agent attached via `JAVA_TOOL_OPTIONS` env var in Deployment
  - `inventory-service`: `opentelemetry-sdk` added to `requirements.txt`, instrumented at startup
- `infra/observability/otel-collector.yaml` — OpenTelemetry Collector receiving traces from both services

### Acceptance Criteria

- [x] Grafana accessible (NodePort); dashboards show live metrics
- [x] Kiali service graph shows all services and traffic flow
- [x] Traces visible in Kiali or Jaeger for a full request (UI → ecom → kafka)
- [x] Prometheus scrapes all services successfully (`up == 1`)

---

## Session 12 — Playwright End-to-End Tests

**Goal:** Full E2E test coverage for every user-facing feature, the CDC pipeline, and Superset reports.

### Deliverables

- `e2e/` — Playwright project (TypeScript)
  - `playwright.config.ts` — base URL `myecom.net:30000`, Keycloak auth setup
  - `e2e/fixtures/auth.ts` — reusable OIDC login fixture (user1, admin1)
  - Test files:
    - `catalog.spec.ts` — view book list, verify titles/prices
    - `search.spec.ts` — search by keyword, verify filtered results
    - `auth.spec.ts` — OIDC PKCE login/logout flow, token not in localStorage
    - `cart.spec.ts` — add to cart pre-login triggers redirect; post-login cart persists
    - `checkout.spec.ts` — complete checkout, verify order confirmation, verify stock decremented
    - `cdc.spec.ts` — place order, poll analytics DB (via API or direct query), verify row appears
    - `superset.spec.ts` — load Superset dashboard, assert both charts rendered with data
  - `e2e/helpers/db.ts` — direct DB query helper for CDC assertion (uses pg client)

### Test Execution

```bash
# Run all E2E tests (requires full stack running)
cd e2e && npx playwright test

# Run a single test file
npx playwright test catalog.spec.ts

# Run with UI mode for debugging
npx playwright test --ui

# Run CDC tests only
npx playwright test cdc.spec.ts
```

### Acceptance Criteria

- [x] All specs pass with 0 failures against a live cluster
- [x] `auth.spec.ts` asserts localStorage is empty after login
- [x] `cdc.spec.ts` passes within a 30-second polling window
- [x] `superset.spec.ts` asserts chart SVG/canvas elements exist and are non-empty

---

## Session 13 — Final Hardening & Validation

**Goal:** Production-readiness pass: resource constraints, pod resilience, and a full smoke-test run.

### Deliverables

- Resource `requests` and `limits` added to every Deployment:
  - ecom-service: `cpu: 250m/500m`, `memory: 512Mi/1Gi`
  - inventory-service: `cpu: 100m/300m`, `memory: 128Mi/256Mi`
  - UI: `cpu: 50m/100m`, `memory: 64Mi/128Mi`
  - Infrastructure services: sized appropriately
- `infra/kubernetes/pdb/` — `PodDisruptionBudget` for ecom-service and inventory-service (`minAvailable: 1`)
- `infra/kubernetes/hpa/` — `HorizontalPodAutoscaler` for ecom-service and inventory-service (CPU threshold 70%)
- `scripts/smoke-test.sh` — hits every endpoint, checks HTTP status, verifies Kafka consumer lag is 0
- `docs/runbook.md` — how to bring the full stack up from scratch, re-register Debezium connectors, reset Keycloak

### Acceptance Criteria

- [x] All pods have resource requests and limits
- [x] `kubectl describe hpa` shows targets and current replicas
- [x] `smoke-test.sh` exits 0 on a fresh cluster boot
- [x] All Playwright E2E tests (Session 12) still pass after hardening changes

---

## Session 14 — Observability, Data Persistence & Guest Cart

**Goal:** Kiali traffic graph working with Prometheus, persistent storage for all PostgreSQL instances, and guest cart UX for unauthenticated users.

### Deliverables

- `infra/observability/prometheus/prometheus.yaml` — Prometheus deployed to `observability` namespace with scrape configs for istiod (port 15014), ztunnel DaemonSet (port 15020), ecom-service, and inventory-service; RBAC (ServiceAccount/ClusterRole/ClusterRoleBinding)
- `infra/observability/kiali/prometheus-alias.yaml` — ExternalName Service in `istio-system` bridging Kiali's default Prometheus URL to `prometheus.observability`
- `infra/observability/kiali/kiali-config-patch.yaml` — Kiali ConfigMap patch disabling ingressgateway/egressgateway/cni-node checks and Grafana
- `infra/observability/kiali/kiali-nodeport.yaml` — NodePort Service exposing Kiali at port 32100
- Data persistence: `infra/kubernetes/storage/` — `StorageClass: local-hostpath` backed by host `data/` directory; all 4 PostgreSQL PVCs updated to this class
- Guest cart: `ui/src/hooks/useGuestCart.ts` — localStorage-backed guest cart under key `bookstore_guest_cart`; merge-on-login in `CallbackPage.tsx`
- `e2e/guest-cart.spec.ts` — 4 tests (add to cart, persist across reload, checkout redirects to Keycloak, merge on login)
- `e2e/istio-gateway.spec.ts` — 6 tests covering all HTTPRoutes and JWT enforcement
- `e2e/kiali.spec.ts` — 3 tests for Kiali dashboard, graph, and Prometheus connectivity

### Acceptance Criteria

- [x] Kiali traffic graph shows ≥10 nodes and ≥12 edges for ecom+inventory namespaces
- [x] Prometheus scrapes istiod and ztunnel successfully
- [x] Kiali accessible at `http://localhost:32100/kiali` (via kiali-proxy docker container)
- [x] All 4 PostgreSQL instances have PVCs backed by `local-hostpath` StorageClass
- [x] Guest users can add items to cart without login (stored in localStorage)
- [x] On login, guest cart items merge into authenticated server cart
- [x] E2E tests: 36/36 passing

---

## Session 15 — Auth Flow Fixes (Login Button, Return URL, Protected Routes)

**Goal:** Fix three bugs and two missing features in the UI authentication flow.

### Deliverables

- `ui/src/auth/AuthContext.tsx` — `login(returnPath?)` now accepts optional return path and handles non-secure-context hosts by redirecting to `localhost:30000/login?return=<path>`
- `ui/src/pages/LoginPage.tsx` — NEW: served at `/login?return=<path>`, always runs at localhost (secure context), triggers OIDC redirect
- `ui/src/pages/CallbackPage.tsx` — reads `user.state.returnUrl` and navigates to original page after auth (with guest cart merge logic preserved)
- `ui/src/components/ProtectedRoute.tsx` — NEW: route guard that calls `login()` with current path if unauthenticated, shows loading state
- `ui/src/components/NavBar.tsx` — shows `...` during auth check (`isLoading=true`) to prevent Login button flash; `onClick={() => login()}` (not `onClick={login}`) to avoid passing MouseEvent as returnPath
- `ui/src/pages/CartPage.tsx` — uses `login('/cart')` from `useAuth()` instead of direct `userManager.signinRedirect()`
- `ui/src/App.tsx` — adds `/login` route and wraps `/order-confirmation` with `ProtectedRoute`
- Docker image rebuilt with VITE build args: `VITE_KEYCLOAK_AUTHORITY`, `VITE_KEYCLOAK_CLIENT_ID`, `VITE_REDIRECT_URI`

### Build Command (required — VITE vars must be baked in at build time)

```bash
cd ui
docker build \
  --build-arg VITE_KEYCLOAK_AUTHORITY=http://idp.keycloak.net:30000/realms/bookstore \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
  --build-arg VITE_REDIRECT_URI=http://localhost:30000/callback \
  -t bookstore/ui-service:latest .
kind load docker-image bookstore/ui-service:latest --name bookstore
kubectl rollout restart deployment/ui-service -n ecom
```

### Acceptance Criteria

- [x] Click Login at `myecom.net:30000` → redirects to `localhost:30000/login?return=/` → Keycloak (no silent fail)
- [x] Click Login at `localhost:30000/search?q=tolkien` → returns to `/search?q=tolkien` after auth
- [x] Page refresh when already logged in → no Login button flash (shows `...` during check)
- [x] Navigate to `/order-confirmation` without auth → redirects to login, returns after auth
- [x] Click "Login to Checkout" in cart → uses `login('/cart')`, returns to `/cart` after auth
- [x] E2E tests: 36/36 passing

---

## Cross-Session Rules

These apply to every session:

1. **No hardcoded secrets** — every credential goes in a Kubernetes Secret; manifest references `secretKeyRef`
2. **Non-root containers** — every Dockerfile sets `USER nonroot` or numeric UID; every Deployment sets `runAsNonRoot: true`
3. **Env-var config only** — `application.yml` / `.env` / `alembic.ini` read from env vars; no values hardcoded
4. **Migrations before app** — DB migrations always run as init containers; app container starts only after migrations succeed
5. **No port-forwarding** — all verification uses host-resolvable NodePort URLs
6. **Review gate** — do not start a session until the previous session's acceptance criteria are all checked off

---

## Directory Structure (target)

```
microservice/
├── plans/
│   └── implementation-plan.md
├── infra/
│   ├── kind/
│   ├── namespaces.yaml
│   ├── istio/
│   ├── kgateway/
│   ├── postgres/
│   ├── redis/
│   ├── kafka/
│   ├── debezium/
│   ├── keycloak/
│   ├── pgadmin/
│   ├── superset/
│   ├── observability/
│   └── kubernetes/
│       ├── network-policies/
│       ├── pod-security/
│       ├── pdb/
│       └── hpa/
├── ecom-service/          # Spring Boot 4.0.3
├── inventory-service/     # Python FastAPI
├── ui/                    # React 19.2
├── analytics/             # Schema + pipeline config
├── e2e/                   # Playwright tests
└── scripts/
```
