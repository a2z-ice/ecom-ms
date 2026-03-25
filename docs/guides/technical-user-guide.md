# Technical User Guide — Bookstore Microservices Platform

Comprehensive reference for operating, debugging, and extending the bookstore e-commerce microservices platform deployed on a local Kubernetes (kind) cluster.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Prerequisites](#2-prerequisites)
3. [URLs & Endpoints](#3-urls--endpoints)
4. [Users & Credentials](#4-users--credentials)
5. [Cluster Lifecycle](#5-cluster-lifecycle)
6. [Service Architecture](#6-service-architecture)
7. [Database Architecture (CloudNativePG HA)](#7-database-architecture-cloudnativepg-ha)
8. [CDC Pipeline (Debezium → Kafka → Flink → Analytics)](#8-cdc-pipeline-debezium--kafka--flink--analytics)
9. [Identity & Security (Keycloak + Istio)](#9-identity--security-keycloak--istio)
10. [TLS & Certificate Management](#10-tls--certificate-management)
11. [Observability Stack](#11-observability-stack)
12. [E2E Testing](#12-e2e-testing)
13. [Common Issues & Solutions](#13-common-issues--solutions)
14. [Operational Runbooks](#14-operational-runbooks)
15. [Architecture Decisions & Trade-offs](#15-architecture-decisions--trade-offs)

---

## 1. System Overview

A production-grade, microservices-based e-commerce book store platform deployed to a local Kubernetes cluster. It demonstrates:

- **3 application services**: React UI, Spring Boot API, Python FastAPI API
- **4 HA PostgreSQL clusters** managed by CloudNativePG (1 primary + 1 standby each)
- **CDC pipeline**: Debezium Server → Kafka → Flink SQL → Analytics DB
- **Identity**: Keycloak OIDC with PKCE, JWT validation, RBAC
- **Service mesh**: Istio Ambient Mesh (mTLS, L4 authorization)
- **TLS**: cert-manager self-signed CA with automatic certificate rotation
- **Observability**: Prometheus, Grafana, Loki, Tempo, Kiali, OTel Collector
- **Analytics**: Apache Superset with 3 dashboards and 16 charts

**Cluster:** `bookstore` (kind, 3 nodes — 1 control-plane, 2 workers)

---

## 2. Prerequisites

### Host Machine Requirements

- Docker Desktop (macOS/Linux) with ≥8GB RAM allocated
- kind v0.27+ (`brew install kind`)
- kubectl (`brew install kubectl`)
- Helm 3.x (`brew install helm`)
- Node.js 20+ and npm (for E2E tests)
- Java 21+ and Maven 3.9+ (for ecom-service)
- Python 3.12+ and Poetry (for inventory-service)

### DNS Configuration

Add to `/etc/hosts`:

```
127.0.0.1  idp.keycloak.net
127.0.0.1  myecom.net
127.0.0.1  api.service.net
```

### TLS Trust (Optional — for browsers)

```bash
bash scripts/trust-ca.sh --install
# Extracts self-signed CA cert from cluster → adds to macOS Keychain
# Prompts for sudo password
```

For `curl`, use `-sk` flag:

```bash
curl -sk https://api.service.net:30000/ecom/books
```

---

## 3. URLs & Endpoints

### Application URLs (HTTPS — Port 30000)

| Service | URL | Authentication |
|---------|-----|----------------|
| **Book Store UI** | `https://myecom.net:30000` | OIDC login (user1/admin1) |
| **E-Commerce API** | `https://api.service.net:30000/ecom/books` | Public (read), JWT (write) |
| **Inventory API** | `https://api.service.net:30000/inven/health` | Public (health), JWT (stock) |
| **Keycloak OIDC** | `https://idp.keycloak.net:30000/realms/bookstore` | N/A |
| **HTTP→HTTPS Redirect** | `http://*:30080` → 301 → `https://*:30000` | N/A |

### Tool URLs (HTTP — Direct NodePort)

| Tool | URL | Default Credentials |
|------|-----|---------------------|
| **PgAdmin** | `http://localhost:31111` | `admin@bookstore.dev` / `CHANGE_ME` |
| **Apache Superset** | `http://localhost:32000` | `admin` / `CHANGE_ME` |
| **Kiali** | `http://localhost:32100/kiali` | Anonymous (no login) |
| **Flink Dashboard** | `http://localhost:32200` | No auth |
| **Debezium ecom Health** | `http://localhost:32300/q/health` | No auth |
| **Debezium inventory Health** | `http://localhost:32301/q/health` | No auth |
| **Keycloak Admin** | `http://localhost:32400/admin` | `admin` / `CHANGE_ME` |
| **Grafana** | `http://localhost:32500` | `admin` / `admin` |
| **Cert Dashboard** | `http://localhost:32600` | No auth (renewal requires K8s token) |

### E-Commerce API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/ecom/books` | Public | List all books |
| `GET` | `/ecom/books/search?q=python` | Public | Search books by title/author |
| `GET` | `/ecom/books/{id}` | Public | Get book by ID |
| `GET` | `/ecom/cart` | JWT | Get user's cart |
| `POST` | `/ecom/cart` | JWT | Add item to cart |
| `POST` | `/ecom/checkout` | JWT | Checkout (creates order, reserves stock) |
| `GET` | `/ecom/admin/books` | JWT+admin | Admin: list books |
| `POST` | `/ecom/admin/books` | JWT+admin | Admin: create book |
| `GET` | `/ecom/admin/orders` | JWT+admin | Admin: list all orders |

### Inventory API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/inven/health` | Public | Health check |
| `GET` | `/inven/stock/{book_id}` | Public | Get stock for one book |
| `GET` | `/inven/stock/bulk?book_ids=id1,id2` | Public | Bulk stock check |
| `POST` | `/inven/reserve` | mTLS+admin | Reserve stock (internal) |
| `GET` | `/inven/admin/stock` | JWT+admin | Admin: all stock levels |
| `PUT` | `/inven/admin/stock/{book_id}` | JWT+admin | Admin: update stock |

---

## 4. Users & Credentials

### Application Users (Keycloak `bookstore` Realm)

| Username | Password | Roles | Purpose |
|----------|----------|-------|---------|
| `user1` | `CHANGE_ME` | `customer` | Regular customer (browse, cart, checkout) |
| `admin1` | `CHANGE_ME` | `customer`, `admin` | Admin user (all customer + admin panels) |

### Service Accounts (Keycloak)

| Client ID | Type | Purpose |
|-----------|------|---------|
| `ui-client` | Public (PKCE) | React UI OIDC login |
| `ecom-service` | Confidential | E-commerce service-to-service auth |
| `inventory-service` | Confidential | Inventory service auth |

### Database Credentials

| Database | Namespace | Username | Password | JDBC URL |
|----------|-----------|----------|----------|----------|
| ecomdb | ecom | ecomuser | CHANGE_ME | `jdbc:postgresql://ecom-db:5432/ecomdb` |
| inventorydb | inventory | inventoryuser | CHANGE_ME | `postgresql://inventory-db:5432/inventorydb` |
| analyticsdb | analytics | analyticsuser | CHANGE_ME | `postgresql://analytics-db:5432/analyticsdb` |
| keycloakdb | identity | keycloakuser | CHANGE_ME | `jdbc:postgresql://keycloak-db:5432/keycloakdb` |

### Infrastructure Credentials

| Service | Username | Password | Notes |
|---------|----------|----------|-------|
| Keycloak Admin | `admin` | `CHANGE_ME` | Master realm admin |
| PgAdmin | `admin@bookstore.dev` | `CHANGE_ME` | `PGADMIN_DEFAULT_EMAIL` |
| Superset | `admin` | `CHANGE_ME` | Default admin account |
| Grafana | `admin` | `admin` | Default Grafana admin |

### Reset User Password (if locked out)

```bash
# Get admin token
ADMIN_TOKEN=$(curl -sk -X POST \
  "https://idp.keycloak.net:30000/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=admin&password=CHANGE_ME" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# Find user ID
curl -sk "https://idp.keycloak.net:30000/admin/realms/bookstore/users?username=user1" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | python3 -m json.tool

# Reset password (use actual user ID from above)
curl -sk -X PUT \
  "https://idp.keycloak.net:30000/admin/realms/bookstore/users/<USER_ID>/reset-password" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"password","value":"CHANGE_ME","temporary":false}'
```

---

## 5. Cluster Lifecycle

### Start (Smart — Auto-Detects Scenario)

```bash
bash scripts/up.sh          # Auto: fresh, recovery, or health check
bash scripts/up.sh --fresh   # Force full teardown + rebuild
bash scripts/up.sh --yes     # Skip confirmation prompts
```

`up.sh` auto-detects:
- **No cluster:** Full bootstrap (kind create + Istio + infra + services)
- **Degraded cluster** (e.g., after Docker restart): Recovery (ztunnel + pod restarts + Debezium re-register)
- **Healthy cluster:** Verify connectors + smoke test

### Stop

```bash
bash scripts/down.sh          # Delete cluster (keeps data/)
bash scripts/down.sh --data   # Delete cluster + wipe data/
bash scripts/down.sh --all    # Delete cluster + data/ + Docker images
```

### After Docker Desktop Restart

```bash
bash scripts/up.sh     # Auto-detects degraded state → runs recovery
# Or directly:
bash scripts/restart-after-docker.sh
```

Recovery handles:
1. ztunnel restart (Istio HBONE plumbing)
2. Pod rolling restart in dependency order (DBs first, then apps)
3. Debezium connector re-registration

### Health Verification

```bash
bash scripts/smoke-test.sh    # Full stack check
bash scripts/verify-routes.sh  # HTTP route checks
bash scripts/verify-cdc.sh     # CDC pipeline check
```

---

## 6. Service Architecture

### Data Flow

```
User (HTTPS :30000)
  │
  ├─→ UI (React 19.2, Nginx) ←──→ Keycloak (OIDC PKCE)
  │     │
  │     └─→ E-Commerce API (Spring Boot 4.0.3)
  │           │
  │           ├─→ ecom-db (CNPG HA PostgreSQL)
  │           │     └─→ Debezium Server → Kafka → Flink SQL → analytics-db
  │           │
  │           └─→ Inventory API (FastAPI, mTLS)
  │                 │
  │                 ├─→ inventory-db (CNPG HA PostgreSQL)
  │                 │     └─→ Debezium Server → Kafka → Flink SQL → analytics-db
  │                 │
  │                 └─→ Kafka (order.created, inventory.updated)
  │
  └─→ Superset → analytics-db (3 dashboards, 16 charts)
```

### Namespace Layout

| Namespace | Services |
|-----------|----------|
| `ecom` | ecom-service, ui-service, ecom-db (CNPG) |
| `inventory` | inventory-service, inventory-db (CNPG) |
| `identity` | keycloak, keycloak-db (CNPG) |
| `analytics` | analytics-db (CNPG), flink-jobmanager, flink-taskmanager, superset |
| `infra` | kafka, redis, pgadmin, debezium-server-ecom, debezium-server-inventory, bookstore-gateway-istio, schema-registry |
| `observability` | prometheus, grafana, alertmanager, kube-state-metrics |
| `otel` | otel-collector, loki, tempo |
| `istio-system` | istiod, ztunnel, istio-cni, kiali |
| `cert-manager` | cert-manager, cert-manager-webhook, cert-manager-cainjector |
| `cert-dashboard` | cert-dashboard-operator, bookstore-certs |
| `cnpg-system` | cnpg-controller-manager |

### Kafka Topics

| Topic | Producer | Consumer | Format |
|-------|----------|----------|--------|
| `order.created` | ecom-service | inventory-service | JSON |
| `inventory.updated` | inventory-service | — | JSON |
| `ecom-connector.public.orders` | Debezium ecom | Flink SQL | Debezium JSON |
| `ecom-connector.public.order_items` | Debezium ecom | Flink SQL | Debezium JSON |
| `ecom-connector.public.books` | Debezium ecom | Flink SQL | Debezium JSON |
| `inventory-connector.public.inventory` | Debezium inventory | Flink SQL | Debezium JSON |
| `debezium.ecom.offsets` | Debezium ecom | — | Internal (KafkaOffsetBackingStore) |
| `debezium.inventory.offsets` | Debezium inventory | — | Internal (KafkaOffsetBackingStore) |

---

## 7. Database Architecture (CloudNativePG HA)

### Overview

4 CNPG-managed PostgreSQL clusters, each with 1 primary + 1 standby (streaming replication):

| Cluster | Namespace | Database | Owner | Purpose |
|---------|-----------|----------|-------|---------|
| ecom-db | ecom | ecomdb | ecomuser | Orders, books, cart |
| inventory-db | inventory | inventorydb | inventoryuser | Stock levels |
| analytics-db | analytics | analyticsdb | analyticsuser | CDC sink (10 views) |
| keycloak-db | identity | keycloakdb | keycloakuser | Keycloak sessions/realm |

### Service DNS

CNPG creates 3 services per cluster. An ExternalName alias maps the short name to the primary:

| DNS Name | Resolves To | Purpose |
|----------|------------|---------|
| `ecom-db.ecom` | `ecom-db-rw.ecom` | App connections (always primary) |
| `ecom-db-rw.ecom` | Primary pod | Read-write (primary) |
| `ecom-db-ro.ecom` | Standby pod | Read-only (standby) |
| `ecom-db-r.ecom` | Any pod | Read (any instance) |

### HA Failover Behavior

1. CNPG detects primary failure (liveness probe or pod deletion)
2. Standby promoted to primary (~10-30s)
3. Old primary pod recreated as new standby (~60-120s)
4. ExternalName service (`ecom-db-rw`) auto-updates to new primary
5. Application reconnects via connection pool retry

**Debezium resilience:** Logical replication slots are synced to standbys (`synchronizeReplicas: true`), so Debezium can connect to the new primary immediately. `snapshot.mode=when_needed` provides fallback if offset is stale.

### Accessing Databases

```bash
# Via kubectl exec (primary)
ECOM_PRIMARY=$(kubectl get pods -n ecom -l cnpg.io/cluster=ecom-db,cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n ecom "$ECOM_PRIMARY" -- psql -U postgres -d ecomdb

# Via PgAdmin (http://localhost:31111)
# Server: ecom-db-rw.ecom.svc.cluster.local:5432
# Username: ecomuser / Password: CHANGE_ME
```

### Checking Cluster Health

```bash
# All clusters at once
for ns_cluster in "ecom/ecom-db" "inventory/inventory-db" "analytics/analytics-db" "identity/keycloak-db"; do
  ns=${ns_cluster%/*}; cluster=${ns_cluster#*/}
  phase=$(kubectl get cluster "$cluster" -n "$ns" -o jsonpath='{.status.phase}')
  ready=$(kubectl get cluster "$cluster" -n "$ns" -o jsonpath='{.status.readyInstances}')
  echo "$cluster ($ns): $phase, ready=$ready/2"
done
```

---

## 8. CDC Pipeline (Debezium → Kafka → Flink → Analytics)

### Architecture

```
ecom-db (PostgreSQL WAL) → Debezium Server (pgoutput) → Kafka Topics → Flink SQL → analytics-db
                                                                                      ↓
inventory-db (PostgreSQL WAL) → Debezium Server (pgoutput) → Kafka Topics → Flink SQL ↗
                                                                                      ↓
                                                                              Superset (dashboards)
```

### Debezium Server Configuration

Two Debezium Server pods, one per source database:

| Instance | Source DB | Topics | Health | Offset Topic |
|----------|-----------|--------|--------|-------------|
| debezium-server-ecom | ecom-db | `ecom-connector.public.*` | `:32300/q/health` | `debezium.ecom.offsets` |
| debezium-server-inventory | inventory-db | `inventory-connector.public.*` | `:32301/q/health` | `debezium.inventory.offsets` |

Key config: `snapshot.mode=when_needed`, `plugin.name=pgoutput`, `schemas.enable=false`

### Flink SQL Pipeline

4 streaming jobs (RUNNING state):
- `sink_dim_books` — Books dimension table
- `sink_fact_orders` — Orders fact table
- `sink_fact_order_items` — Order items fact table
- `sink_fact_inventory` — Inventory fact table

All use JDBC sink with UPSERT mode (`PRIMARY KEY NOT ENFORCED` → `ON CONFLICT DO UPDATE`).

**Important:** Flink uses plain `json` format (NOT `debezium-json`). The query extracts `after` field and filters `WHERE after IS NOT NULL` to skip deletes.

### Analytics Views (10 total)

| View | Description |
|------|-------------|
| `vw_product_sales_volume` | Units sold per book |
| `vw_sales_over_time` | Daily sales trend |
| `vw_revenue_by_author` | Revenue grouped by author |
| `vw_revenue_by_genre` | Revenue grouped by genre |
| `vw_order_status_distribution` | Order status breakdown |
| `vw_inventory_health` | Stock status (OK/Low/Critical) |
| `vw_avg_order_value` | Average order value |
| `vw_top_books_by_revenue` | Top revenue-generating books |
| `vw_inventory_turnover` | Inventory turnover ratio |
| `vw_book_price_distribution` | Books by price range |

### Verifying CDC Pipeline

```bash
# 1. Check Debezium health
curl -s http://localhost:32300/q/health  # ecom → {"status":"UP"}
curl -s http://localhost:32301/q/health  # inventory → {"status":"UP"}

# 2. Check Flink jobs
curl -s http://localhost:32200/jobs/overview | python3 -c "
import sys,json
for j in json.load(sys.stdin)['jobs']:
    print(f\"{j['name']}: {j['state']}\")
"

# 3. Check analytics-db views have data
ANALYTICS_PRIMARY=$(kubectl get pods -n analytics -l cnpg.io/cluster=analytics-db,cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n analytics "$ANALYTICS_PRIMARY" -- psql -U postgres -d analyticsdb -c "
  SELECT 'dim_books' as tbl, count(*) FROM dim_books
  UNION ALL SELECT 'fact_inventory', count(*) FROM fact_inventory
  UNION ALL SELECT 'fact_orders', count(*) FROM fact_orders;
"

# 4. Full CDC verification (inserts test row, polls analytics)
bash scripts/verify-cdc.sh
```

---

## 9. Identity & Security (Keycloak + Istio)

### OIDC Flow

1. User clicks Login → redirected to Keycloak (`idp.keycloak.net:30000`)
2. Keycloak authenticates → returns authorization code
3. UI exchanges code for tokens (PKCE) → tokens stored in memory only
4. UI sends `Authorization: Bearer <access_token>` on API calls
5. Backend validates JWT signature via Keycloak JWKS endpoint

### Istio Security Layers

1. **PeerAuthentication** — `mtls.mode: STRICT` (all inter-service traffic encrypted)
2. **RequestAuthentication** — JWT validation against Keycloak JWKS
3. **AuthorizationPolicy** — L4 allow rules (ztunnel-compatible)

NodePort services use `portLevelMtls: PERMISSIVE` for direct host access.

### Token Lifespan

| Token Type | Lifespan | Notes |
|-----------|----------|-------|
| Access token | 30 min (1800s) | POC setting; production should be 5-10 min |
| SSO session idle | 30 min | |
| SSO session max | 10 hours | |
| Offline session idle | 30 days | |

---

## 10. TLS & Certificate Management

### Certificate Chain

```
Self-signed Root CA (10 year, ECDSA P-256)
  └── Gateway Leaf Certificate (30 day, auto-renewal at 7 days)
        ├── SAN: myecom.net
        ├── SAN: api.service.net
        ├── SAN: idp.keycloak.net
        ├── SAN: localhost
        └── SAN: 127.0.0.1
```

### cert-manager Resources

```bash
# Check certificate status
kubectl get certificates -n infra
kubectl get certificaterequests -n infra
kubectl describe certificate bookstore-gateway-tls -n infra

# Extract CA cert
bash scripts/trust-ca.sh
# Cert saved to certs/bookstore-ca.crt
```

### Cert Dashboard

`http://localhost:32600` — shows all certificates, expiry dates, and progress bars. Supports manual renewal via SSE.

---

## 11. Observability Stack

### Metrics (Prometheus → Grafana)

- **Prometheus:** `http://localhost:30000` (internal), scrapes istiod + ztunnel + kube-state-metrics
- **Grafana:** `http://localhost:32500` — dashboards for Application Logs, Service Health, Cluster Overview, Distributed Tracing

### Logs (OTel Collector → Loki → Grafana)

Both services export logs via OpenTelemetry:
- Java (ecom-service): OTel Java agent auto-bridges Logback
- Python (inventory-service): OTel LoggerProvider

Loki labels: `service_name`, `service_namespace`, `deployment_environment`, `level`, `job`

### Traces (OTel Collector → Tempo → Grafana)

Distributed traces via OTel SDK instrumentation.

### Service Mesh (Kiali)

`http://localhost:32100/kiali` — traffic graph, workload health, Istio config validation.

---

## 12. E2E Testing

### Running Tests

```bash
cd e2e
npm install
npm run test          # Headless, sequential (workers: 1)
npm run test:ui       # Playwright UI mode (interactive)
npm run test:headed   # Headed browser
npm run report        # Open last HTML report
```

### Test Coverage (~310 tests)

| Suite | Tests | Description |
|-------|-------|-------------|
| auth.spec.ts | ~10 | OIDC login/logout, token validation |
| books-api.spec.ts | ~15 | Book CRUD API |
| cart.spec.ts | ~8 | Cart operations |
| checkout.spec.ts | ~10 | Checkout flow, order creation |
| guest-cart.spec.ts | ~5 | Guest cart, merge-on-login |
| search.spec.ts | ~3 | Book search by title/author |
| stock-management.spec.ts | ~9 | Bulk stock, StockBadge UI |
| admin.spec.ts | ~20 | Admin panel, RBAC |
| debezium-flink.spec.ts | ~25 | CDC pipeline, analytics views |
| superset.spec.ts | ~25 | Dashboards, charts |
| postgresql-ha.spec.ts | ~15 | HA failover, replication |
| tls-cert-manager.spec.ts | ~30 | TLS, cert rotation |
| cert-dashboard.spec.ts | ~29 | Cert dashboard operator |
| otel-loki.spec.ts | ~18 | Logs, tracing |
| ui-fixes.spec.ts | ~12 | UI stability |
| mtls.spec.ts | ~5 | Service-to-service mTLS |

### Session Fixtures

Tests use pre-authenticated Playwright storage states:
- `e2e/fixtures/user1-session.json` — user1 session
- `e2e/fixtures/admin1-session.json` — admin1 session

These are regenerated by auth setup tests at the start of each run.

---

## 13. Common Issues & Solutions

### Issue: Pod in CrashLoopBackOff

```bash
# Identify the failing pod
kubectl get pods --all-namespaces | grep -v Running | grep -v Completed

# Check logs
kubectl logs -n <namespace> <pod-name> --tail=50

# Check events
kubectl describe pod -n <namespace> <pod-name> | tail -20
```

**Common causes:**
| Symptom | Cause | Fix |
|---------|-------|-----|
| `ReadOnlyFileSystemException` | Keycloak needs writable root FS | Set `readOnlyRootFilesystem: false` |
| `permission denied` | PVC owned by root, app runs non-root | Add init container with `chown` |
| `ImagePullBackOff` | Image tag doesn't exist | Verify tag on Docker Hub |
| `replication slot not found` | CNPG failover lost logical slot | Recreate slot or restart Debezium |

### Issue: Debezium CrashLoopBackOff After Failover

```bash
# 1. Recreate replication slot on new primary
ECOM_PRIMARY=$(kubectl get pods -n ecom -l cnpg.io/cluster=ecom-db,cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n ecom "$ECOM_PRIMARY" -- psql -U postgres -d ecomdb -c \
  "SELECT pg_create_logical_replication_slot('debezium_ecom_slot', 'pgoutput');"

# 2. Delete stale offset topic
KAFKA_POD=$(kubectl get pods -n infra -l app=kafka -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n infra "$KAFKA_POD" -- kafka-topics --bootstrap-server localhost:9092 \
  --delete --topic debezium.ecom.offsets

# 3. Restart Debezium
kubectl rollout restart deploy/debezium-server-ecom -n infra
kubectl rollout status deploy/debezium-server-ecom -n infra --timeout=120s
```

### Issue: 401 Unauthorized on API Calls

```bash
# Check token is valid
curl -sk https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/certs

# Get fresh token
TOKEN=$(curl -sk -X POST \
  "https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=ui-client&username=user1&password=CHANGE_ME" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# Test with token
curl -sk -H "Authorization: Bearer $TOKEN" https://api.service.net:30000/ecom/cart
```

### Issue: Services Not Accessible After Docker Restart

```bash
bash scripts/up.sh   # Auto-detects degraded state → full recovery
```

### Issue: Flink Jobs Not Running

```bash
# Check job status
curl -s http://localhost:32200/jobs/overview | python3 -m json.tool

# If no jobs, re-run the SQL runner
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f infra/flink/flink-sql-runner.yaml
```

### Issue: E2E Tests Failing with Token Expiry

```bash
# Delete stale session fixtures to force re-auth
rm -f e2e/fixtures/user1-session.json e2e/fixtures/admin1-session.json
rm -f e2e/fixtures/user1.json e2e/fixtures/admin1.json

# Re-run tests (auth setup runs first)
cd e2e && npm run test
```

### Issue: Certificate Expired

```bash
# Check cert status
kubectl get certificates -n infra

# Force renewal
kubectl delete secret bookstore-gateway-tls -n infra
# cert-manager auto-regenerates within ~30s

# Or use cert dashboard
open http://localhost:32600
```

---

## 14. Operational Runbooks

### Full Cluster Health Check

```bash
#!/bin/bash
echo "=== Pod Health ==="
kubectl get pods --all-namespaces | grep -v Running | grep -v Completed | grep -v NAMESPACE

echo -e "\n=== CNPG Clusters ==="
for ns_cluster in "ecom/ecom-db" "inventory/inventory-db" "analytics/analytics-db" "identity/keycloak-db"; do
  ns=${ns_cluster%/*}; cluster=${ns_cluster#*/}
  phase=$(kubectl get cluster "$cluster" -n "$ns" -o jsonpath='{.status.phase}')
  ready=$(kubectl get cluster "$cluster" -n "$ns" -o jsonpath='{.status.readyInstances}')
  echo "  $cluster: $phase (ready=$ready/2)"
done

echo -e "\n=== Debezium ==="
echo -n "  ecom: "; curl -s http://localhost:32300/q/health | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "DOWN"
echo -n "  inventory: "; curl -s http://localhost:32301/q/health | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "DOWN"

echo -e "\n=== Flink ==="
curl -s http://localhost:32200/jobs/overview | python3 -c "
import sys,json
for j in json.load(sys.stdin)['jobs']:
    print(f\"  {j['name']}: {j['state']}\")
" 2>/dev/null || echo "  UNAVAILABLE"

echo -e "\n=== Routes ==="
for url in "https://api.service.net:30000/ecom/books" "https://api.service.net:30000/inven/health" "https://idp.keycloak.net:30000/realms/bookstore" "https://myecom.net:30000"; do
  code=$(curl -sk -o /dev/null -w "%{http_code}" "$url" 2>/dev/null)
  echo "  $url → $code"
done
```

### Rolling Restart of All Services

```bash
# Databases first (CNPG handles rolling restart automatically)
# Then infrastructure
kubectl rollout restart deploy/kafka -n infra
kubectl rollout restart deploy/redis -n infra

# Then application services
kubectl rollout restart deploy/ecom-service -n ecom
kubectl rollout restart deploy/inventory-service -n inventory
kubectl rollout restart deploy/ui-service -n ecom

# Then CDC
kubectl rollout restart deploy/debezium-server-ecom -n infra
kubectl rollout restart deploy/debezium-server-inventory -n infra
```

### Viewing Kafka Topics & Messages

```bash
KAFKA_POD=$(kubectl get pods -n infra -l app=kafka -o jsonpath='{.items[0].metadata.name}')

# List topics
kubectl exec -n infra "$KAFKA_POD" -- kafka-topics --bootstrap-server localhost:9092 --list

# Consume from topic (last 5 messages)
kubectl exec -n infra "$KAFKA_POD" -- kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic ecom-connector.public.orders \
  --from-beginning --max-messages 5
```

---

## 15. Architecture Decisions & Trade-offs

### Why `readOnlyRootFilesystem: false` for Keycloak?

Quarkus (Keycloak's runtime) executes a JAR build step at startup (`JarResultBuildStep#buildRunnerJar`) that writes into the JAR ZIP filesystem. This is not `/tmp` — it's the application binary itself. No amount of emptyDir volumes can fix this. Mitigated by dropping all capabilities and running non-root.

### Why `accessTokenLifespan: 1800s`?

The E2E test suite takes 8-12 minutes. With 5-minute tokens, tests fail mid-run. 30 minutes covers the full suite with margin. For production, reduce to 300-600s and rely on refresh token rotation.

### Why `snapshot.mode=when_needed` (not `initial`)?

After CNPG failover, the stored WAL offset may be invalid. `initial` mode would crash permanently. `when_needed` auto-re-snapshots, and Flink's UPSERT mode ensures idempotency (no duplicates in analytics-db).

### Why CNPG `synchronizeReplicas: true`?

PostgreSQL doesn't replicate logical replication slots to standbys. Without this, every failover breaks Debezium. CNPG's slot sync feature propagates slots to standbys, so they exist immediately after promotion.

### Why Init Containers Run as Root?

PVCs for Loki/Tempo are created with root ownership. The main containers run as UID 10001. A brief init container (`chown`) fixes permissions before the app starts. Security impact is minimized by explicit `CHOWN`+`FOWNER` capabilities only (all others dropped).

### Why Debezium Server (not Kafka Connect)?

Debezium Server is lighter weight (single-purpose, no Connect framework overhead). Each source DB gets its own pod with config in a ConfigMap. Health at `/q/health`. Offset storage in Kafka topics (durable across restarts).
