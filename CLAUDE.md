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
- **Databases**: CloudNativePG-managed PostgreSQL HA clusters (1 primary + 1 standby each). 4 clusters: `ecom-db`, `inventory-db`, `analytics-db`, `keycloak-db`. No cross-database access. ExternalName Service aliases for zero app config changes.
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

Detailed directory trees for all services and infra: `docs/architecture/source-structure.md`

Key entry points: `ecom-service/` (Spring Boot, `com.bookstore.ecom`), `inventory-service/` (FastAPI, `app/`), `ui/` (React, `src/`), `e2e/` (Playwright), `infra/` (K8s manifests), `cert-dashboard-operator/` (Go operator).

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

- PostgreSQL must have `wal_level=logical` (set via CNPG `postgresql.parameters` in Cluster CR)
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

### Data Persistence Pattern (Session 14, updated Session 27)

- Non-DB services: StorageClass `local-hostpath` backed by host `data/` directory (superset, kafka, redis, flink, grafana, prometheus)
- **PostgreSQL (Session 27)**: CloudNativePG manages its own PVCs via kind's `standard` StorageClass (dynamic provisioner)
  - 4 CNPG Clusters: `ecom-db`, `inventory-db`, `analytics-db`, `keycloak-db` (2 instances each)
  - ExternalName Service aliases (`ecom-db` → `ecom-db-rw`) ensure zero app config changes
  - Manifests: `infra/cnpg/*-cluster.yaml`; old `infra/postgres/*-db.yaml` files deleted
  - CNPG labels: `cnpg.io/cluster=<name>`, `cnpg.io/instanceRole=primary|replica`
  - Debezium offset storage: `KafkaOffsetBackingStore` (survives CNPG failover)

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

## Current Implementation State (as of 2026-03-11)

**Sessions 1–27 in progress. E2E: 130/130 passing.**

### Cluster: `bookstore` (kind, 3 nodes) — RUNNING

| Namespace | Service | Status |
|---|---|---|
| ecom | ecom-service | Running ✓ |
| ecom | ui-service | Running ✓ |
| ecom | ecom-db (CNPG 2 instances) | Running ✓ |
| inventory | inventory-service | Running ✓ |
| inventory | inventory-db (CNPG 2 instances) | Running ✓ |
| identity | keycloak | Running ✓ |
| identity | keycloak-db (CNPG 2 instances) | Running ✓ |
| identity | keycloak-realm-import | Completed ✓ |
| infra | kafka (KRaft) | Running ✓ |
| infra | debezium-server-ecom | Running ✓ (Debezium Server 3.4, health at :32300/q/health) |
| infra | debezium-server-inventory | Running ✓ (Debezium Server 3.4, health at :32301/q/health) |
| infra | redis | Running ✓ |
| infra | pgadmin | Running ✓ |
| analytics | analytics-db (CNPG 2 instances) | Running ✓ |
| analytics | flink-jobmanager | Running ✓ |
| analytics | flink-taskmanager | Running ✓ |
| analytics | superset | Running ✓ |
| observability | prometheus | Running ✓ |
| cnpg-system | cnpg-controller-manager | Running ✓ (v1.25.1, manages all 4 DB clusters) |
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
| Grafana | 32500 | `http://localhost:32500` |
| Cert Dashboard | 32600 | `http://localhost:32600` |

All 12 ports are declared in `infra/kind/cluster.yaml` under `extraPortMappings` on the `control-plane` role node. kind binds them directly from host to the container port — no socat or proxy containers required. Port 30080 was added for HTTP→HTTPS redirect, port 32600 for cert-dashboard (`up.sh --fresh` required for new port mappings).

### Session History (Sessions 14–25)

Detailed per-session implementation history is in `docs/architecture/session-history.md`.

Key facts:
- Sessions 1–27 (27 in progress). E2E: 130/130 passing.
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

---

## Known Issues (Solved)

Spring Boot 4.0 breaking changes, Kafka KRaft mode config, and Keycloak import caveats are documented in `docs/architecture/known-issues.md`. All fixes are already in place. Key gotchas:
- Spring Boot 4.0: KafkaTemplate generic mismatch, Liquibase ordering, Jackson 3.x package rename, RestClient HTTP/2 breaks FastAPI (force HTTP/1.1)
- Kafka: `zookeeper.yaml` is intentionally empty (placeholder); readiness probe must be TCP socket
- Keycloak: always use `keycloak-import.sh` (never apply `import-job.yaml` alone); `sub` claim requires explicit `oidc-sub-mapper` in `profile` scope
