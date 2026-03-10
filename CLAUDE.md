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
  --build-arg VITE_KEYCLOAK_AUTHORITY=https://idp.keycloak.net:30000/realms/bookstore \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
  --build-arg VITE_REDIRECT_URI=https://localhost:30000/callback \
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

**Recommended — use the smart master script:**
```bash
bash scripts/up.sh           # smart start: fresh bootstrap, recovery, or health check (auto-detects)
bash scripts/up.sh --fresh   # force full teardown + rebuild from scratch
bash scripts/down.sh         # delete cluster (keeps data)
bash scripts/down.sh --data  # delete cluster + wipe all data
bash scripts/down.sh --all   # delete cluster + data + images
```

**Individual steps (advanced):**
```bash
bash scripts/cluster-up.sh        # create kind cluster + Istio + Kubernetes Gateway API
bash scripts/infra-up.sh          # apply all infra manifests
bash scripts/keycloak-import.sh   # patch ConfigMap + run realm import Job
bash infra/debezium/register-connectors.sh  # PUT CDC connectors (reads creds from K8s secret)
bash scripts/verify-routes.sh     # smoke-test all external HTTP routes
bash scripts/verify-cdc.sh        # seed row + poll analytics DB (30s)
bash scripts/smoke-test.sh        # full stack check
```

### After Docker Desktop Restart
**Use `up.sh`** — it auto-detects the degraded state and runs full recovery:
```bash
bash scripts/up.sh
```

Or use the dedicated recovery script directly:
```bash
bash scripts/restart-after-docker.sh
```

This handles all root causes automatically:
1. **ztunnel restart** — Istio Ambient mesh HBONE plumbing breaks after Docker restart; ztunnel must be restarted first
2. **Pod rolling restart (all pods)** — After ztunnel restart, existing pods lose HBONE registration; every pod must restart in dependency order (DBs first, then apps)
3. **Debezium connector re-registration** — Kafka topics (including `debezium.configs`) are lost on Kafka restart; connectors must be re-registered

See `docs/operations/restart-app.md` for the full explanation and root cause analysis.

**Important Debezium re-registration caveat:** The `${file:...}` FileConfigProvider syntax does NOT expand during Kafka Connect connector validation (only at task startup). `register-connectors.sh` reads real credentials from the K8s secret and injects them directly — do NOT send `${file:...}` literals during PUT.

**Connector registration format:** Use `PUT /connectors/{name}/config` with just the config object (no outer `name`/`config` wrapper). The JSON files in `infra/debezium/connectors/` have the full wrapper format for `POST /connectors` — `register-connectors.sh` extracts the `config` key automatically.

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
- **Gateway**: Kubernetes Gateway API (`gatewayClassName: istio`) — Istio's built-in Gateway implementation; all ingress routing via HTTPRoutes; HTTPS on port 30000 with TLS termination
- **TLS / cert-manager**: cert-manager v1.17.2 manages self-signed CA and gateway certificates (30d rotation, 7d renewBefore). HTTP→HTTPS redirect on port 30080. See `docs/guides/tls-setup.md`
- **Identity**: Keycloak 26.5.4 at `idp.keycloak.net:30000`
- **Databases**: Each service has its own dedicated PostgreSQL instance — no cross-database access. Instances: `ecom-db`, `inventory-db`, `analytics-db`, plus Keycloak's own `keycloak-db`
- **Messaging**: Kafka for event streaming; Debezium for CDC from all PostgreSQL DBs
- **Session/CSRF/Rate-limiting**: Central Redis instance
- **Reporting**: Apache Superset connected to the central analytics PostgreSQL

### Data Flow

```
User (HTTPS) → UI → Keycloak (OIDC PKCE) → UI
UI → E-Commerce API (HTTPS, JWT-protected)
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

**HTTPS (self-signed CA)**: All gateway endpoints serve HTTPS on port 30000. To trust the self-signed CA in browsers:
```bash
bash scripts/trust-ca.sh --install   # extracts CA cert + adds to macOS Keychain
```
For curl, use `-sk` flag or `--cacert certs/bookstore-ca.crt`. See `docs/guides/tls-setup.md` for details.

---

## Security Invariants

These must be maintained across all services:
- All external gateway traffic served over HTTPS (TLS terminated at Istio Gateway, cert-manager managed)
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
playwright.config.ts       workers:1, baseURL:https://localhost:30000, ignoreHTTPSErrors:true
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
cert-manager/           install.sh, ca-issuer.yaml, gateway-certificate.yaml, rotation-config.yaml
kgateway/               gateway.yaml (HTTPS listener) + HTTPRoutes per service + routes/https-redirect.yaml
keycloak/               keycloak.yaml, import-job.yaml, realm-export.json
postgres/               ecom-db.yaml, inventory-db.yaml, analytics-db.yaml (each with PVC)
kafka/                  kafka.yaml (KRaft), zookeeper.yaml (intentionally EMPTY placeholder)
debezium/               debezium-server-ecom.yaml, debezium-server-inventory.yaml
                        register-connectors.sh (health-poll script — no REST registration)
                        Credentials read directly from ecom-db-secret / inventory-db-secret via secretKeyRef
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

**NodePort + STRICT mTLS**: ztunnel on worker nodes intercepts ALL inbound traffic (including kind NodePort from host). To allow direct host→pod plaintext for NodePort-exposed services, use `portLevelMtls: PERMISSIVE` on the specific port. This REQUIRES a `selector` — namespace-wide `portLevelMtls` is not supported:
```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: debezium-ecom-nodeport-permissive
  namespace: infra
spec:
  selector:
    matchLabels:
      app: debezium-server-ecom
  mtls:
    mode: STRICT
  portLevelMtls:
    "8080":
      mode: PERMISSIVE
```

### TLS / cert-manager Pattern (Session 24)

- cert-manager v1.17.2 installed in `cert-manager` namespace
- Self-signed CA chain: bootstrap ClusterIssuer → CA Certificate (10yr) → CA ClusterIssuer → leaf Certificate (30d, renewBefore 7d)
- Gateway leaf cert stored in `bookstore-gateway-tls` Secret (namespace `infra`), referenced by Gateway HTTPS listener
- All gateway URLs use HTTPS on port 30000: `https://myecom.net:30000`, `https://api.service.net:30000`, `https://idp.keycloak.net:30000`, `https://localhost:30000`
- HTTP→HTTPS redirect on port 30080 (301 → `https://<host>:30000`)
- Tool NodePorts (31111, 32000, 32100, 32200, 32300, 32301, 32400, 32500) remain plain HTTP
- E2E tests: `ignoreHTTPSErrors: true` in Playwright config
- curl commands for gateway endpoints: use `-sk` flag (e.g., `curl -sk https://api.service.net:30000/ecom/books`)
- Browser trust: `bash scripts/trust-ca.sh --install` (extracts CA from cluster + adds to macOS Keychain)
- Manifests: `infra/cert-manager/install.sh`, `ca-issuer.yaml`, `gateway-certificate.yaml`, `rotation-config.yaml`

### CDC / Debezium Server Pattern (Session 22)

- PostgreSQL must have `wal_level=logical` (set via `POSTGRES_INITDB_ARGS` or ConfigMap)
- **Debezium Server** (not Kafka Connect): one pod per source DB; config in `application.properties` ConfigMap
- Health check: `GET /q/health` at port 8080 → `{"status":"UP"}` when running
- Offset storage: `KafkaOffsetBackingStore` — topics `debezium.ecom.offsets` and `debezium.inventory.offsets` in Kafka
- No REST registration needed: Debezium Server reads config on startup and auto-connects
- On pod restart: auto-resumes from Kafka offset topics (no re-registration required)
- Topic format unchanged: `<prefix>.<schema>.<table>` (e.g., `ecom-connector.public.orders`)
- Flink SQL pipeline unchanged (same Kafka topics, same Debezium JSON envelope)

### Playwright Test Pattern

- `ignoreHTTPSErrors: true` in `playwright.config.ts` (required for self-signed TLS cert)
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
- `up.sh` — **master smart startup**: auto-detects scenario (no cluster → fresh bootstrap; degraded → recovery; healthy → verify connectors + smoke test); options: `--fresh`, `--yes`/`-y`
- `down.sh` — enhanced teardown; options: `--data` (wipe `./data/`), `--images` (remove Docker images), `--all` (data + images), `--yes`/`-y` (skip prompts)
- `cluster-up.sh` — create kind cluster + install Istio + Kubernetes Gateway API + namespaces; substitutes `DATA_DIR` placeholder in `infra/kind/cluster.yaml` via `sed` before calling `kind create`
- `cluster-down.sh` — thin wrapper around `down.sh`; maps `--purge-data` → `--data` for backward compat
- `infra-up.sh` — apply all infra manifests
- `verify-routes.sh` — curl all external routes, assert HTTP 200/302
- `verify-cdc.sh` — seed a row, poll analytics DB, assert row present
- `smoke-test.sh` — full stack smoke test
- `stack-up.sh` — one-command full bootstrap (cluster + infra + keycloak + connectors)
- `sanity-test.sh` — comprehensive cluster health check (pods + routes + Kafka + Debezium)
- `restart-after-docker.sh` — full recovery after Docker Desktop restart (ztunnel + pod restarts in dependency order + Debezium re-registration)
- `trust-ca.sh` — extract self-signed CA cert from cluster to `certs/bookstore-ca.crt`; `--install` adds to macOS Keychain

---

## Plans Convention

Every enhancement, feature, or new session **must** produce a plan file in `plans/` **before or alongside** implementation:

- **File name:** `plans/session-<NN>-<meaningful-slug>.md` (e.g. `session-18-kafka-persistence.md`)
- **Also update:** `plans/implementation-plan.md` — add the new session section there too
- **Minimum content:** Goal, Deliverables table, Acceptance Criteria, Build & Deploy commands, Status

Individual session files for chunk-by-chunk reading: `plans/session-01-*.md` through `plans/session-17-*.md`.

---

## Current Implementation State (as of 2026-03-10)

**Sessions 1–24 complete. E2E: 130/130 passing.**

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
| infra | debezium-server-ecom | Running ✓ (Debezium Server 3.4, health at :32300/q/health) |
| infra | debezium-server-inventory | Running ✓ (Debezium Server 3.4, health at :32301/q/health) |
| infra | redis | Running ✓ |
| infra | pgadmin | Running ✓ |
| analytics | analytics-db | Running ✓ |
| analytics | flink-jobmanager | Running ✓ |
| analytics | flink-taskmanager | Running ✓ |
| analytics | superset | Running ✓ |
| observability | prometheus | Running ✓ |
| cert-manager | cert-manager | Running ✓ (v1.17.2, self-signed CA) |
| istio-system | kiali | Running ✓ (Prometheus connected) |

### Verified
- `GET https://api.service.net:30000/ecom/books` → 200 with 10 seeded books (use `curl -sk`) ✓
- TLS: cert-manager self-signed CA → gateway cert (30d rotation, 7d renewBefore) ✓
- HTTP→HTTPS redirect: `http://*:30080` → 301 → `https://*:30000` ✓
- Keycloak realm `bookstore` imported ✓, JWT validation working ✓
- CDC pipeline: Debezium Server → Kafka → Flink SQL → analytics-db ✓
- Flink REST API `/jobs` shows 4 streaming jobs in RUNNING state ✓
- Flink Web Dashboard: `http://localhost:32200` (kind hostPort, NodePort 32200) ✓
- Debezium ecom health: `http://localhost:32300/q/health` → `{"status":"UP"}` ✓
- Debezium inventory health: `http://localhost:32301/q/health` → `{"status":"UP"}` ✓
- Superset: 3 dashboards, 16 charts (Book Store Analytics, Sales & Revenue Analytics, Inventory Analytics) ✓
- Analytics DB: 10 views (`\dv vw_*`) ✓
- Kiali: traffic graph populated (10 nodes, 12 edges for ecom+inventory), Prometheus scraping ztunnel + istiod ✓
- **E2E tests: 130/130 passing** ✓ (Sessions 1–22 complete)
- ecom-service → inventory-service synchronous mTLS reserve call on checkout ✓
- All Istio AuthorizationPolicies L4-only (ztunnel-compatible) ✓

### NodePort Map

All ports are exposed directly via kind `extraPortMappings` on the control-plane node — no proxy containers needed.

| Service | NodePort | Host URL |
|---------|----------|----------|
| Main Gateway (HTTPS) | 30000 | `https://myecom.net:30000` |
| HTTP→HTTPS Redirect | 30080 | `http://*:30080` → 301 → `https://*:30000` |
| PgAdmin | 31111 | `http://localhost:31111` |
| Superset | 32000 | `http://localhost:32000` |
| Kiali | 32100 | `http://localhost:32100/kiali` |
| Flink | 32200 | `http://localhost:32200` |
| Debezium ecom | 32300 | `http://localhost:32300/q/health` |
| Debezium inventory | 32301 | `http://localhost:32301/q/health` |
| Keycloak Admin | 32400 | `http://localhost:32400/admin` |

All 10 ports are declared in `infra/kind/cluster.yaml` under `extraPortMappings` on the `control-plane` role node. kind binds them directly from host to the container port — no socat or proxy containers required. Port 30080 was added for HTTP→HTTPS redirect (`up.sh --fresh` required for new port mappings).

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
- Guest cart tests use `https://localhost:30000` (HTTPS — secure context for PKCE). All gateway endpoints now serve HTTPS.
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
- **NodePort services**: Flink Web Dashboard at NodePort 32200 (`flink-jobmanager-nodeport` service) + Debezium health at NodePort 32300 (`debezium-nodeport` service, later replaced by `debezium-server-ecom-nodeport` in Session 22). Both exposed directly via kind `extraPortMappings` — no proxy containers.
- **E2E coverage**: `e2e/superset.spec.ts` expanded to 17 tests (API + UI: 3 dashboards, 14 charts, 10 datasets); `e2e/debezium-flink.spec.ts` (NEW) — 29 tests covering Debezium API, Flink dashboard, CDC end-to-end flow, operational health.
- **Documentation**: `docs/cdc/debezium-flink-cdc.md` — comprehensive guide with architecture diagrams, per-component deep dives, data flow walkthrough, REST API reference, and E2E test coverage index.

### Flink CDC Architecture (Session 22 — updated versions)

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

### Fresh Bootstrap Fixes (2026-03-02 — additional)

These bugs were found during a `up.sh --fresh` rebuild (data preserved):

- **Keycloak import 180s timeout**: `scripts/keycloak-import.sh` `kubectl wait --timeout` was 180s. On fresh cluster, `kc.sh import` triggers a Keycloak binary rebuild phase (~90s) + startup (~60s) + import (~15s) = ~165s total. Increased timeout to 360s. Fix: `keycloak-import.sh` line 25.
- **Flink SQL runner not resubmitted after recovery**: `up.sh` recovery function and `restart-after-docker.sh` restarted Flink JM/TM pods but never deleted + recreated the `flink-sql-runner` Job. Flink Session Cluster loses all streaming jobs on JM restart; the completed K8s Job won't re-run. Both scripts now poll SQL Gateway readiness → delete + recreate the Job. Fix: both scripts, Step 5.
- **E2E cold-start flake**: `cart.spec.ts` add-to-cart test failed on first run after fresh cluster (ecom-service POST /cart slow during cold start; button reverts to "Add to Cart" silently on both success and failure). Fix: `playwright.config.ts` `retries: 1` (was `CI ? 1 : 0`).

### Fresh Bootstrap Fixes (2026-03-01)

These bugs were found and fixed during a full `up.sh --fresh --data` rebuild:

- **GatewayClass race condition**: `kgateway/install.sh` now polls for `gatewayclass/istio` before `kubectl wait` (istiod creates it asynchronously after startup)
- **Istio Gateway NodePort**: Istio auto-creates `bookstore-gateway-istio` service with random NodePort. `up.sh` now patches it to 30000 after creation (must match kind `extraPortMappings`)
- **Istio STRICT mTLS + NodePort**: ztunnel rejects plaintext from host via kind NodePort. Fixed with workload-specific `PeerAuthentication` using `portLevelMtls: PERMISSIVE` for each NodePort-exposed infra/analytics service (requires `selector`; namespace-wide portLevelMtls is not supported)
- **Kafka CDC topics**: `KAFKA_AUTO_CREATE_TOPICS_ENABLE=false` — added 4 Debezium topics to kafka-topic-init job (`ecom-connector.public.{books,orders,order_items}`, `inventory-connector.public.inventory`)
- **Keycloak missing `sub` claim**: Realm import with custom `clientScopes` (roles/profile/email) replaced Keycloak's built-in `openid` scope, losing the `sub` claim mapper. Fixed: added `oidc-sub-mapper` to the `profile` scope in `realm-export.json`. Without `sub`, `jwt.getSubject()` returns null → `null user_id` in cart_items.
- **Analytics DDL ordering**: Must be applied BEFORE Flink starts (Flink JDBC sink requires tables to pre-exist). Moved DDL apply to right after `analytics-db` is ready. Fixed `kubectl exec` to use `-i` flag (without it, stdin redirect is silently ignored).
- **verify-cdc.sh column name**: Fixed `WHERE order_id = '...'` to `WHERE id = '...'` in fact_orders polling query.

### Bootstrap Optimization (2026-03-01)

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

### Persistence — Fully Implemented

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

### Session 20 — Completed (Stock Management UI)

- `GET /inven/stock/bulk?book_ids=...` endpoint (returns `list[StockResponse]`, before `/{book_id}` route)
- `StockBadge.tsx` component (gray loading, red OOS, orange low, green in-stock)
- `CatalogPage.tsx`: bulk stock fetch; badges; OOS button disabled
- `SearchPage.tsx`: Availability column; OOS buttons disabled
- `CartPage.tsx`: Availability column; per-item badges; checkout blocked when OOS
- `e2e/stock-management.spec.ts`: 9 tests covering API structure + UI behavior

### Session 21 — Completed (Admin Panel)

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

### Post-Session-21 Fixes — Complete (2026-03-02)

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

### Session 22 — Completed (2026-03-06)

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

### Session 24 — Completed (TLS / cert-manager)

- **cert-manager v1.17.2**: Installed via `infra/cert-manager/install.sh`; manages self-signed CA and gateway leaf certificate
- **Certificate chain**: `selfsigned-bootstrap` ClusterIssuer → `bookstore-ca` Certificate (10yr) → `bookstore-ca-issuer` ClusterIssuer → `bookstore-gateway-cert` Certificate (30d, renewBefore 7d) → `bookstore-gateway-tls` Secret
- **Gateway HTTPS**: Port 30000 now serves HTTPS (TLS terminated at Istio Gateway). All hostnames covered: `myecom.net`, `api.service.net`, `idp.keycloak.net`, `localhost`, `127.0.0.1`
- **HTTP→HTTPS redirect**: Port 30080 returns 301 to `https://<host>:30000` via HTTPRoute at `infra/kgateway/routes/https-redirect.yaml`
- **kind cluster.yaml**: Port 30080 added to `extraPortMappings` (requires `up.sh --fresh`)
- **Browser trust**: `bash scripts/trust-ca.sh --install` extracts CA cert to `certs/bookstore-ca.crt` and adds to macOS Keychain
- **E2E**: `playwright.config.ts` uses `ignoreHTTPSErrors: true`; baseURL changed to `https://localhost:30000`
- **curl**: All smoke tests and verification scripts use `-sk` flag for self-signed cert
- **Tool NodePorts unchanged**: 31111, 32000, 32100, 32200, 32300, 32301, 32400, 32500 remain HTTP
- **Manifests**: `infra/cert-manager/ca-issuer.yaml`, `gateway-certificate.yaml`, `rotation-config.yaml`

### NEXT SESSION — Start Here

**Sessions 1–24 complete.** No outstanding items. See `docs/architecture/review-and-proposed-architecture.md` for the enhancement roadmap.

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

**`sub` claim in access tokens**: Keycloak's built-in `openid` scope includes the `sub` (subject UUID) claim mapper. When a realm import defines custom `clientScopes` (roles/profile/email), the import replaces Keycloak's built-in scopes and the `openid` scope's `sub` mapper is lost. **Fix**: add `oidc-sub-mapper` explicitly to the `profile` scope in `realm-export.json`. Without `sub`, `jwt.getSubject()` returns null in Spring Security → `null value in column "user_id"` DB errors.
