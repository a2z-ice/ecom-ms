# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a production-grade, microservices-based e-commerce book store platform. It is a POC with production-aligned architecture deployed to a local Kubernetes (kind) cluster.

- Full spec: `production_grade_ecommerce_microservices_spec.md`
- Incremental build plan: `plans/implementation-plan.md` — **read this before starting any work**. Each numbered session has acceptance criteria that must pass before the next session begins.

---

## Commands

### Build & Test Each Service

**ecom-service (Maven — no wrapper, use system `mvn`):**
```bash
cd ecom-service
mvn test                          # run unit tests
mvn package -DskipTests           # build JAR
docker build -t bookstore/ecom-service:latest .
kind load docker-image bookstore/ecom-service:latest --name bookstore
```

**inventory-service (Poetry + pytest):**
```bash
cd inventory-service
poetry install                    # install deps
poetry run pytest                 # run tests
docker build -t bookstore/inventory-service:latest .
kind load docker-image bookstore/inventory-service:latest --name bookstore
```

**ui (npm + Vite):**
```bash
cd ui
npm install
npm run dev                       # Vite dev server
npm run build                     # TypeScript + Vite bundle to dist/
npm run lint                      # ESLint on src/
# IMPORTANT: VITE_ vars must be passed as --build-arg (baked in at build time, not runtime)
docker build \
  --build-arg VITE_KEYCLOAK_AUTHORITY=http://idp.keycloak.net:30000/realms/bookstore \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
  --build-arg VITE_REDIRECT_URI=http://localhost:30000/callback \
  -t bookstore/ui-service:latest .
kind load docker-image bookstore/ui-service:latest --name bookstore
```

**e2e (Playwright):**
```bash
cd e2e
npm install
npm run test                      # headless, sequential (workers: 1)
npm run test:ui                   # Playwright UI mode
npm run test:headed               # headed browser
npm run report                    # open last HTML report
```

### Cluster Lifecycle
```bash
bash scripts/cluster-up.sh        # create kind cluster + Istio + Kubernetes Gateway API
bash scripts/infra-up.sh          # apply all infra manifests
bash scripts/keycloak-import.sh   # patch ConfigMap + run realm import Job
bash infra/debezium/register-connectors.sh  # POST CDC connectors
bash scripts/verify-routes.sh     # smoke-test all external HTTP routes
bash scripts/verify-cdc.sh        # seed row + poll analytics DB (30s)
bash scripts/smoke-test.sh        # full stack check
```

---

## Architecture

### Microservices

| Service | Tech | Path | Exposed At |
|---|---|---|---|
| UI Service | React 19.2 | `ui/` | `myecom.net:30000` |
| E-Commerce Service | Spring Boot 4.0.3 | `ecom-service/` | `api.service.net:30000/ecom` |
| Inventory Service | Python FastAPI | `inventory-service/` | `api.service.net:30000/inven` |
| Analytics Pipeline | Kafka + Debezium + Flink SQL | `analytics/` | internal |

### Infrastructure Stack

- **Kubernetes**: kind (local), NodePort exposure only — no `kubectl port-forward`
- **Service Mesh**: Istio Ambient Mesh 1.28.4 (mTLS between all services, JWT validation via `RequestAuthentication` + `AuthorizationPolicy`)
- **Gateway**: Kubernetes Gateway API (`gatewayClassName: istio`) — Istio's built-in Gateway implementation; all ingress routing via HTTPRoutes
- **Identity**: Keycloak 26.5.4 at `idp.keycloak.net:30000`
- **Databases**: Each service has its own dedicated PostgreSQL instance — no cross-database access. Instances: `ecom-db`, `inventory-db`, `analytics-db`, plus Keycloak's own `keycloak-db`
- **Messaging**: Kafka for event streaming; Debezium for CDC from all PostgreSQL DBs
- **Session/CSRF/Rate-limiting**: Central Redis instance
- **Reporting**: Apache Superset connected to the central analytics PostgreSQL

### Data Flow

```
User → UI → Keycloak (OIDC PKCE) → UI
UI → E-Commerce API (JWT-protected)
E-Commerce → Inventory API (service-to-service, mTLS)
E-Commerce DB → Debezium → Kafka → Analytics DB
Inventory DB  → Debezium → Kafka → Analytics DB
Superset → Analytics DB
```

### Kafka Topics & Event Schemas

- `order.created` — published by E-Commerce Service on checkout:
  ```json
  { "orderId": "uuid", "userId": "string", "items": [{ "bookId": "uuid", "quantity": 2, "price": 19.99 }], "total": 39.98, "timestamp": "ISO-8601" }
  ```
- `inventory.updated` — published by Inventory Service after stock deduction:
  ```json
  { "bookId": "uuid", "previousQuantity": 10, "newQuantity": 8, "orderId": "uuid", "timestamp": "ISO-8601" }
  ```

---

## Service Details

### UI Service (React 19.2)

- OIDC Authorization Code Flow with PKCE
- Tokens stored in memory only (never localStorage)
- Secure HTTP-only cookies for refresh tokens
- CSRF protection via Redis-backed token store

### E-Commerce Service (Spring Boot 4.0.3)

- Spring Security OIDC Resource Server (validates JWTs from Keycloak)
- Liquibase for DB schema migrations
- Endpoints (context path `/ecom`):
  - `GET /books`, `GET /books/search?q=...`, `GET /books/{id}` — public
  - `GET /cart`, `POST /cart` — JWT required
  - `POST /checkout` — JWT required; publishes `order.created` to Kafka
- Package: `com.bookstore.ecom`; key classes: `SecurityConfig`, `KafkaConfig`, `LiquibaseConfig`

### Inventory Service (Python FastAPI)

- Poetry-managed deps (`pyproject.toml`, Python ^3.12)
- Alembic for DB schema migrations
- Endpoints (root path `/inven`):
  - `GET /stock/{book_id}` — public
  - `POST /reserve` — internal, mTLS + admin role
- Consumes `order.created` from Kafka via `AIOKafkaConsumer` in `app/kafka/consumer.py`
- JWT middleware in `app/middleware/auth.py`; publishes `inventory.updated` after deduction

---

## Domain / Hosts Setup

Add to `/etc/hosts`:
```
127.0.0.1  idp.keycloak.net
127.0.0.1  myecom.net
127.0.0.1  api.service.net
```

kind cluster must have `hostMapping` and `NodePort: 30000` configured in the cluster config. All services must be reachable without port-forwarding.

---

## Security Invariants

These must be maintained across all services:
- All inter-service traffic encrypted via Istio mTLS
- JWT validation in every backend service (never trust the UI's claims)
- CSRF tokens required for state-changing UI requests, stored in Redis
- Containers run as non-root
- Secrets via Kubernetes Secrets only
- All configs via environment variables (15-Factor: no hardcoded config)
- NetworkPolicies enforced per namespace

---

## Database Conventions

- Each service owns its DB schema exclusively
- Migrations run as init containers or startup jobs (never manually)
- E-Commerce Service: Liquibase
- Inventory Service: Alembic

---

## Testing

End-to-end tests use **Playwright**. Every user-facing feature must have Playwright coverage. CDC pipeline behavior must also be tested (verify that DB changes propagate through Debezium → Kafka → Analytics DB). Superset analytics reports (bar chart: Product Sales Volume; trend chart: Sales Over Time) must also be covered.

---

## Observability

- **Metrics**: Prometheus
- **Tracing**: Kiali, with OpenTelemetry instrumentation in services
- **Dashboards**: Grafana
- **Logs**: stdout only (15-Factor), collected by cluster-level log aggregator
- **DB Admin**: PgAdmin at `localhost:31111`

---

## Key Constraints

- **No port-forwarding** — everything exposed via NodePort through kind `hostMapping`
- **No cross-service DB access** — strict per-service DB isolation
- **No localStorage for tokens** — tokens in memory; refresh tokens in HTTP-only cookies
- **No hardcoded secrets or config** — always Kubernetes Secrets + env vars

---

## Source Structure

### ecom-service (`com.bookstore.ecom`)
```
config/          SecurityConfig, KafkaConfig, LiquibaseConfig
controller/      BookController, CartController, OrderController
service/         BookService, CartService, OrderService
model/           Book, CartItem, Order, OrderItem (JPA entities)
repository/      Spring Data JPA repositories
dto/             CartRequest, OrderCreatedEvent
kafka/           OrderEventPublisher
resources/db/changelog/   Liquibase: 001-create-books → 004-seed-books
```

### inventory-service (`app/`)
```
main.py          FastAPI app, lifespan (Kafka consumer start/stop)
config.py        Env var loading
database.py      SQLAlchemy async engine/session
api/stock.py     HTTPRoutes: GET /stock/{id}, POST /reserve
models/          SQLAlchemy Inventory model
schemas/         Pydantic StockResponse, ReserveRequest
kafka/consumer.py  AIOKafkaConsumer for order.created
middleware/auth.py JWT validation (python-jose + JWKS)
alembic/versions/  001_create_inventory, 002_seed_inventory
```

### ui (`src/`)
```
auth/oidcConfig.ts     UserManager with PKCE, InMemoryWebStorage
auth/AuthContext.tsx   Token state context
api/client.ts          fetch wrapper: attaches Bearer token + X-CSRF-Token
pages/                 CatalogPage, SearchPage, CartPage, CheckoutPage,
                       OrderConfirmationPage, CallbackPage
components/NavBar.tsx
```

### e2e (`e2e/`)
```
playwright.config.ts       workers:1, baseURL:http://localhost:30000 (PKCE requires localhost)
fixtures/auth.setup.ts     OIDC login → saves storageState (fixtures/user1.json) +
                           sessionStorage separately (fixtures/user1-session.json)
                           NOTE: Playwright storageState does NOT capture sessionStorage
helpers/db.ts              pg client: queryAnalyticsDb(), pollUntilFound() via kubectl exec
helpers/auth.ts            auth utilities
*.spec.ts                  catalog, search, auth, cart, checkout, cdc, superset,
                           istio-gateway, kiali, guest-cart, ui-fixes, mtls-enforcement
```

### infra (`infra/`)
```
kind/cluster.yaml       kind cluster with hostMapping + NodePort 30000; contains DATA_DIR
                        placeholder substituted at runtime by cluster-up.sh via sed
storage/                storageclass.yaml (local-hostpath) + persistent-volumes.yaml (7 PVs)
namespaces.yaml
kgateway/               gateway.yaml + HTTPRoutes per service
keycloak/               keycloak.yaml, import-job.yaml, realm-export.json
postgres/               ecom-db.yaml, inventory-db.yaml, analytics-db.yaml (each with PVC)
kafka/                  kafka.yaml (KRaft), zookeeper.yaml (intentionally EMPTY placeholder)
debezium/               debezium.yaml, register-connectors.sh, connectors/*.json
                        Connector credentials loaded via mounted Secret files, not hardcoded
istio/security/         peer-auth.yaml, request-auth.yaml, authz-policies/
observability/          prometheus/, kiali/ (nodeport + config-patch + prometheus-alias),
                        otel-collector.yaml
kubernetes/             hpa/, pdb/, network-policies/ (ecom-netpol, inventory-netpol)
superset/               deployment + bootstrap-job (pre-populates dashboards)
analytics/schema/       DDL: fact_orders, fact_order_items, dim_books, fact_inventory +
                        views vw_product_sales_volume, vw_sales_over_time (used by Superset)
```

---

## Established Skills & Patterns

These patterns are decided and must be followed consistently across all sessions. Do not re-derive or debate them.

### Kubernetes Manifest Pattern

Every application Deployment must include:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
resources:
  requests:
    cpu: <value>
    memory: <value>
  limits:
    cpu: <value>
    memory: <value>
env:
  - name: SOME_SECRET
    valueFrom:
      secretKeyRef:
        name: <secret-name>
        key: <key>
```

Migrations always run as an init container that must exit 0 before the app container starts:

```yaml
initContainers:
  - name: migrate
    image: <same-image-as-app>
    command: ["<migration-command>"]
    envFrom:
      - secretRef:
          name: <db-secret>
```

### Dockerfile Pattern

All Dockerfiles are multi-stage, ending with a minimal runtime image and a non-root user:

```dockerfile
# Build stage
FROM <build-image> AS build
WORKDIR /app
COPY . .
RUN <build-command>

# Runtime stage
FROM <minimal-runtime-image>
RUN addgroup --system app && adduser --system --ingroup app app
WORKDIR /app
COPY --from=build /app/<artifact> .
USER app
EXPOSE <port>
CMD ["<entrypoint>"]
```

### Spring Boot (ecom-service) Patterns

- All config via `application.yml` with `${ENV_VAR}` references — no hardcoded values
- Liquibase changelogs in `src/main/resources/db/changelog/`; master changelog at `db.changelog-master.yaml`
- Security config: `SecurityFilterChain` bean; OIDC Resource Server with Keycloak JWKS URI from `KEYCLOAK_JWKS_URI` env var
- Kafka: use `KafkaTemplate<String, Object>`; events serialized as JSON with `JsonSerializer`
- Rate limiting: Bucket4j with Redis as token bucket store
- Error handling: `GlobalExceptionHandler` (`@RestControllerAdvice`) returns `ProblemDetail` responses for `ResourceNotFoundException`, `BusinessException`, and `MethodArgumentNotValidException`

### FastAPI (inventory-service) Patterns

- App entry: `uvicorn app.main:app`
- JWT validation: `python-jose` + `httpx` to fetch JWKS from `KEYCLOAK_JWKS_URI` env var; middleware class in `app/middleware/auth.py`
- Alembic: `alembic upgrade head` as init container command; `alembic.ini` reads `DATABASE_URL` from env
- Kafka consumer: `aiokafka` `AIOKafkaConsumer` started in `@asynccontextmanager` lifespan
- Kafka producer: `aiokafka` `AIOKafkaProducer`; events serialized as JSON
- Health endpoint: `GET /health` returns `{"status": "ok"}` — unauthenticated, used by Kubernetes probes

### React (ui/) Patterns

- OIDC library: `oidc-client-ts`; `UserManager` configured with PKCE (`response_type: 'code'`)
- Token storage: `UserManager` configured with `userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() })`
- API calls: always attach `Authorization: Bearer <access_token>` from in-memory `User` object; never read from storage
- CSRF: fetch CSRF token from ecom-service on app load, store in React state, send as `X-CSRF-Token` header on mutating requests
- Nginx config: serve SPA with `try_files $uri /index.html`; set security headers (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Content-Security-Policy`)

### Istio Security Pattern

Applied in this order per namespace:
1. `PeerAuthentication` — `mtls.mode: STRICT` (namespace-wide)
2. `RequestAuthentication` — Keycloak JWKS for JWT validation
3. `AuthorizationPolicy` — explicit allow rules; default deny-all implied

### CDC / Debezium Pattern

- PostgreSQL must have `wal_level=logical` (set via `POSTGRES_INITDB_ARGS` or ConfigMap)
- Debezium connector registered via REST POST to `http://debezium-service:8083/connectors`
- Topic format: `<connector-name>.<schema>.<table>` (e.g., `ecom-connector.public.orders`)
- Sink: Kafka JDBC Sink Connector writes from CDC topics into analytics DB tables

### Playwright Test Pattern

- Use `test.use({ storageState: ... })` with a pre-authenticated state file for tests that need login
- Auth fixture: log in via Keycloak UI once, save storage state; re-use across tests
- CDC assertions: poll with retry (max 30s, 1s interval) — never sleep fixed duration
- API assertions for CDC: prefer direct DB query via `pg` client over UI polling

### Data Persistence Pattern (Session 14)

- StorageClass: `local-hostpath` backed by host `data/` directory in the repo root
- PersistentVolumes use `hostPath` mounts into `data/<service>/` on the kind node
- All 4 PostgreSQL instances (ecom-db, inventory-db, analytics-db, keycloak-db) use PVCs of this class
- Manifests: `infra/postgres/*-db.yaml` each include a PVC; `infra/kubernetes/storage/` has the StorageClass

### Guest Cart Pattern (Session 14)

- Guest (unauthenticated) users: cart stored in `localStorage` under key `bookstore_guest_cart`
- On OIDC callback: `CallbackPage.tsx` reads `bookstore_guest_cart`, POSTs items to server cart, then clears localStorage
- E2E coverage: `e2e/guest-cart.spec.ts` (5 tests) verifies add-to-cart, persist across page reload, and merge-on-login

### Kiali + Prometheus Pattern (Session 14)

- Prometheus deployed to `observability` namespace via `infra/observability/prometheus/prometheus.yaml`
- Kiali defaults to `http://prometheus.istio-system:9090` — bridged via ExternalName service at `infra/observability/kiali/prometheus-alias.yaml`
- After applying the alias: restart Kiali deployment so it picks up the live Prometheus connection
- Verify: `kubectl exec -n istio-system <kiali-pod> -- ...` OR check `GET /kiali/api/status` — Prometheus must appear in `externalServices`

### Scripts Naming Convention

All `scripts/` files must be idempotent (safe to run multiple times):
- `cluster-up.sh` — create kind cluster + install Istio + Kubernetes Gateway API + namespaces; substitutes `DATA_DIR` placeholder in `infra/kind/cluster.yaml` via `sed` before calling `kind create`
- `infra-up.sh` — apply all infra manifests
- `verify-routes.sh` — curl all external routes, assert HTTP 200/302
- `verify-cdc.sh` — seed a row, poll analytics DB, assert row present
- `smoke-test.sh` — full stack smoke test (used in Session 13)
- `stack-up.sh` — one-command full bootstrap (cluster + infra + keycloak + connectors)
- `cluster-down.sh` — clean teardown; `--purge-data` to delete host data volumes
- `sanity-test.sh` — comprehensive cluster health check (pods + routes + Kafka + Debezium)

---

## Plans Convention

Every enhancement, feature, or new session **must** produce a plan file in `plans/` **before or alongside** implementation:

- **File name:** `plans/session-<NN>-<meaningful-slug>.md` (e.g. `session-18-kafka-persistence.md`)
- **Also update:** `plans/implementation-plan.md` — add the new session section there too
- **Minimum content:** Goal, Deliverables table, Acceptance Criteria, Build & Deploy commands, Status

Individual session files for chunk-by-chunk reading: `plans/session-01-*.md` through `plans/session-17-*.md`.

---

## Current Implementation State (as of 2026-02-28)

**Sessions 1–18 complete + UI bug fixes. E2E: 89/89 passing.**

### Cluster: `bookstore` (kind, 3 nodes) — RUNNING

| Namespace | Service | Status |
|---|---|---|
| ecom | ecom-service | Running ✓ |
| ecom | ui-service | Running ✓ |
| ecom | ecom-db | Running ✓ |
| inventory | inventory-service | Running ✓ |
| inventory | inventory-db | Running ✓ |
| identity | keycloak | Running ✓ |
| identity | keycloak-db | Running ✓ |
| identity | keycloak-realm-import | Completed ✓ |
| infra | kafka (KRaft) | Running ✓ |
| infra | debezium | Running ✓ (CDC connectors registered) |
| infra | redis | Running ✓ |
| infra | pgadmin | Running ✓ |
| analytics | analytics-db | Running ✓ |
| analytics | flink-jobmanager | Running ✓ |
| analytics | flink-taskmanager | Running ✓ |
| analytics | superset | Running ✓ |
| observability | prometheus | Running ✓ |
| istio-system | kiali | Running ✓ (Prometheus connected) |

### Verified
- `GET http://api.service.net:30000/ecom/books` → 200 with 10 seeded books ✓
- Keycloak realm `bookstore` imported ✓, JWT validation working ✓
- CDC pipeline: Debezium → Kafka → Flink SQL → analytics-db ✓ (replaces Python consumer)
- Flink REST API `/jobs` shows 4 streaming jobs in RUNNING state ✓
- Flink Web Dashboard: `http://localhost:32200` (via flink-proxy docker container) ✓
- Debezium REST API: `http://localhost:32300` (via debezium-proxy docker container) ✓
- Superset: 3 dashboards, 16 charts (Book Store Analytics, Sales & Revenue Analytics, Inventory Analytics) ✓
- Analytics DB: 10 views (`\dv vw_*`) ✓
- Kiali: traffic graph populated (10 nodes, 12 edges for ecom+inventory), Prometheus scraping ztunnel + istiod ✓
- **E2E tests: 89/89 passing** ✓ (45 existing + 19 Superset + 25 Debezium-Flink CDC tests)
- ecom-service → inventory-service synchronous mTLS reserve call on checkout ✓
- All Istio AuthorizationPolicies L4-only (ztunnel-compatible) ✓

### NodePort + Proxy Map

| Service | NodePort | Host URL | Docker Proxy |
|---------|----------|----------|-------------|
| Main Gateway | 30000 | `http://myecom.net:30000` | kind hostPort |
| PgAdmin | 31111 | `http://localhost:31111` | kind hostPort |
| Superset | 32000 | `http://localhost:32000` | kind hostPort |
| Kiali | 32100 | `http://localhost:32100/kiali` | `kiali-proxy` docker container |
| **Flink** | **32200** | **`http://localhost:32200`** | **`flink-proxy` docker container** |
| **Debezium** | **32300** | **`http://localhost:32300`** | **`debezium-proxy` docker container** |

**Set up proxies (one-time after cluster creation):**
```bash
CTRL_IP=$(kubectl get node bookstore-control-plane -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')
kubectl apply -f infra/flink/flink-cluster.yaml     # includes flink-jobmanager-nodeport
kubectl apply -f infra/debezium/debezium.yaml        # includes debezium-nodeport
docker rm -f flink-proxy debezium-proxy 2>/dev/null || true
docker run -d --name flink-proxy --network kind --restart unless-stopped \
  -p 32200:32200 alpine/socat TCP-LISTEN:32200,fork,reuseaddr TCP:${CTRL_IP}:32200
docker run -d --name debezium-proxy --network kind --restart unless-stopped \
  -p 32300:32300 alpine/socat TCP-LISTEN:32300,fork,reuseaddr TCP:${CTRL_IP}:32300
```

### UI Bug Fixes — Completed (Post Session 15)

- **Nav cart badge for auth users**: NavBar fetches server cart count via `cartApi.get()` on login; listens for `cartUpdated` DOM event. Badge now shows for both guest and authenticated users.
- **`cartUpdated` event**: Dispatched from `CatalogPage`, `SearchPage`, and `CartPage` after any cart mutation. NavBar re-fetches count on each dispatch.
- **Minus button fix**: `CartRequest.java` has `@Min(1)` so `quantity: -1` was rejected with 400. Added `PUT /cart/{itemId}` endpoint with `CartUpdateRequest` DTO, `CartService.setQuantity()`, and `cartApi.update()` in frontend. CartPage uses `cartApi.update(item.id, item.quantity - 1)` for decrement.
- **Logout button styling**: Added `style={{ color: '#fff', borderColor: '#cbd5e0' }}` to Logout button in NavBar (matching Login button style — both white text on dark navbar).
- **`api/client.ts`**: Added `put` method alongside existing `get`, `post`, `delete`.
- **E2E coverage**: `ui-fixes.spec.ts` (5 tests) — auth badge, minus decrement, minus removes, logout color, badge clears after checkout.

### Session 14 — Completed

- Kiali Prometheus connection fixed: ExternalName service `prometheus.istio-system` → `prometheus.observability` + Prometheus deployed to `observability` namespace
- Prometheus scrape configs added for Istio telemetry: `istiod` (port 15014) + `ztunnel` DaemonSet (port 15020, kubernetes_sd_configs) + Prometheus RBAC (ServiceAccount/ClusterRole/ClusterRoleBinding)
- Architecture diagram labels corrected: "KGateway" → "Istio Gateway (K8s Gateway API)"
- E2E coverage added: `istio-gateway.spec.ts` (6 tests), `kiali.spec.ts` (3 tests), `guest-cart.spec.ts` (4 tests)
- Guest cart tests require `http://localhost:30000` (secure context for PKCE). `http://myecom.net:30000` is non-localhost HTTP — `crypto.subtle` unavailable there.
- CLAUDE.md updated with Session 14 state, new scripts, corrected gateway terminology

### Session 15 — Completed

- `AuthContext.tsx`: `login(returnPath?)` — at non-localhost hosts redirects to `localhost:30000/login?return=<path>` (avoids `crypto.subtle` unavailability); at localhost calls `userManager.signinRedirect({ state: { returnUrl } })`
- `LoginPage.tsx` (NEW): served at `/login?return=<path>`, triggers OIDC redirect at localhost (secure context always available)
- `CallbackPage.tsx`: reads `user.state.returnUrl` and navigates to original page after auth (guest cart merge logic preserved)
- `ProtectedRoute.tsx` (NEW): route guard that calls `login()` with current path if unauthenticated
- `NavBar.tsx`: shows `...` during `isLoading` (prevents Login button flash); uses `onClick={() => login()}` not `onClick={login}` (avoids passing MouseEvent as returnPath)
- `CartPage.tsx`: uses `login('/cart')` from `useAuth()` instead of direct `userManager.signinRedirect()`
- `App.tsx`: `/login` route added; `/order-confirmation` wrapped with `ProtectedRoute`
- UI Docker image rebuilt with VITE build args (see build command in Commands section)
- **CRITICAL**: `docker build` for ui-service requires `--build-arg` for VITE_ vars (baked in at build time by Vite)

### Session 16 — Completed

- Named ServiceAccounts: `ecom-service` (ecom ns) + `inventory-service` (inventory ns)
- Rewritten AuthorizationPolicies: all L4-only (namespace + SPIFFE principal). L7 policies cause implicit deny-all in Istio Ambient without waypoint proxy
- DB policies: ecom-db, inventory-db, keycloak-db locked to their namespaces + infra
- NetworkPolicies: `infra/kubernetes/network-policies/inventory-netpol.yaml` (NEW); ecom-netpol updated with HBONE port 15008, ui-service egress, Prometheus ingress
- HTTPRoute: `inven-route.yaml` restricted to GET /stock/* and GET /health only; POST /reserve not exposed externally
- RestClientConfig: forced HTTP/1.1 — Java's default JDK HttpClient sends h2c upgrade headers that Starlette rejects with 400 "Invalid HTTP request received"
- OrderService: calls `inventoryClient.reserve()` before creating order (synchronous mTLS)
- Book UUIDs: changeset 005 re-seeds with fixed sequential UUIDs matching inventory seed data
- **E2E tests: 45/45 passing** (4 new: external POST /reserve → 404, checkout JWT 401, checkout via mTLS, reserved count increases)

### Session 18 — Completed

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
- **NodePort services**: Flink Web Dashboard at NodePort 32200 (`flink-jobmanager-nodeport` service) + Debezium REST API at NodePort 32300 (`debezium-nodeport` service). Both use docker socat proxy containers.
- **E2E coverage**: `e2e/superset.spec.ts` expanded to 17 tests (API + UI: 3 dashboards, 14 charts, 10 datasets); `e2e/debezium-flink.spec.ts` (NEW) — 29 tests covering Debezium API, Flink dashboard, CDC end-to-end flow, operational health.
- **Documentation**: `docs/debezium-flink-cdc.md` — comprehensive guide with architecture diagrams, per-component deep dives, data flow walkthrough, REST API reference, and E2E test coverage index.

### Flink CDC Architecture

```
Debezium → Kafka (4 topics) → Flink SQL (plain json format, after field extraction) → JDBC → analytics-db
                                                                                               ↓
                                                                                    Superset (3 dashboards, 16 charts)
```

**Flink SQL format choice**: Uses plain `json` format (NOT `debezium-json`). Reason: `debezium-json` requires `REPLICA IDENTITY FULL` on source tables for UPDATE events (the "before" field must be non-null). Plain `json` format parses the Debezium envelope directly and extracts the `after` ROW field — works regardless of REPLICA IDENTITY setting.

**Source table schema**: Each source table has an `after ROW<...>` field and an `op STRING` field matching Debezium's JSON envelope. `WHERE after IS NOT NULL` in INSERT statements skips DELETE events and tombstones.

**Timestamp conversion**: Debezium sends `TIMESTAMP WITH TIME ZONE` as ISO 8601 strings (`"2026-02-26T18:58:09.811060Z"`). Flink JSON format uses SQL format (space separator). Conversion: `CAST(REPLACE(REPLACE(col, 'T', ' '), 'Z', '') AS TIMESTAMP(3))`.

**JDBC sink**: Uses `TIMESTAMP(3)` (NOT `TIMESTAMP_LTZ(3)` — JDBC connector does not support it). `?stringtype=unspecified` in JDBC URL allows implicit `varchar → uuid` casts in PostgreSQL.

**Exactly-once**: Flink checkpoints at `/opt/flink/checkpoints` (PVC-backed, `filesystem` state backend). Interval: 30s, mode: `EXACTLY_ONCE`.

### NEXT SESSION — Start Here

**All 18 sessions complete + UI bug fixes done.** Outstanding items:
- DB data persistence — mount all 4 PostgreSQL DBs to host `data/` folder (PVs exist, but cluster.yaml and PV/PVC wiring needed)
- Kafka persistence — topics lost on pod restart; add PVC or recreate on startup

---

## Spring Boot 4.0 / Spring Framework 7.0 Known Issues (Solved)

These are non-obvious breaking changes from Spring Boot 3.x. The fixes are already in place but document them here for reference:

1. **KafkaTemplate generic mismatch**: Autoconfigured `KafkaTemplate<?,?>` does NOT match injection of `KafkaTemplate<String, Object>`. Fix: explicit `KafkaConfig.java` `@Bean`.
2. **Liquibase ordering**: Hibernate validation runs BEFORE Liquibase in Spring Boot 4.0. Fix: `spring.jpa.hibernate.ddl-auto: none` + explicit `LiquibaseConfig.java` `@Bean("liquibase")`.
3. **Actuator health subpaths**: `/actuator/health` pattern does NOT match `/actuator/health/liveness` or `/actuator/health/readiness`. Fix: use `/actuator/health/**` in SecurityConfig.
4. **readOnlyRootFilesystem + Tomcat**: Spring Boot Tomcat needs writable `/tmp`. Fix: emptyDir volume mounted at `/tmp`.
5. **Jackson 3.x package rename**: Spring Boot 4.0 migrates from `com.fasterxml.jackson` to `tools.jackson`. The Kafka `JsonSerializer` must use the new packages. Fix: `Jackson3JsonSerializer.java` in `ecom-service/src/main/java/com/bookstore/ecom/config/` wraps Jackson 3.x for Kafka serialization.
6. **RestClient HTTP/2 upgrade breaks FastAPI**: Spring Boot 4.0's `RestClient.create()` uses `JdkClientHttpRequestFactory` (Java's `HttpClient`). Java's `HttpClient` may send `Connection: Upgrade, HTTP2-Settings` headers even for plain HTTP. Starlette/uvicorn's h11 parser rejects these with `400 Bad Request: "Invalid HTTP request received."`. Fix: force HTTP/1.1 explicitly:
   ```java
   var httpClient = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();
   RestClient.builder().requestFactory(new JdkClientHttpRequestFactory(httpClient)).build();
   ```

## Kafka KRaft Mode (no Zookeeper)

The cluster uses `confluentinc/cp-kafka:latest` in KRaft combined mode (broker + controller in one pod). Critical settings:
- `KAFKA_PROCESS_ROLES: "broker,controller"`
- `KAFKA_PORT: ""` — MUST override Kubernetes service-discovery injection
- Listener name MUST be `PLAINTEXT` (not `INTERNAL`) for CP 8.x KRaft
- Readiness probe MUST be TCP socket (not exec) — exec follows advertised listener DNS which has no endpoints until pod is Ready (chicken-and-egg)

`infra/kafka/zookeeper.yaml` exists but is **intentionally empty** (comment only) — it is a placeholder to prevent script failures in `infra-up.sh`. Do not add Zookeeper content to it.

## Keycloak Import Job

The import job (`infra/keycloak/import-job.yaml`) does NOT contain a ConfigMap definition — the ConfigMap is managed by `scripts/keycloak-import.sh` which patches it from `realm-export.json`. Always use the script to run imports, never `kubectl apply -f import-job.yaml` alone.

The Keycloak 26.5.4 image has neither `curl` nor `wget`. Health check uses bash built-in `/dev/tcp`:
```bash
until (bash -c ">/dev/tcp/keycloak.identity.svc.cluster.local/8080" 2>/dev/null); do
  sleep 5
done
```
