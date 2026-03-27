# BookStore Platform — Complete User Guide

Step-by-step walkthrough of every interface, dashboard, and API endpoint.

---

## Quick Reference — All URLs & Credentials

| Interface | URL | Credentials | Purpose |
|-----------|-----|-------------|---------|
| Book Store UI | https://myecom.net:30000 | user1 / CHANGE_ME | Shopping |
| Admin Panel | https://myecom.net:30000/admin | admin1 / CHANGE_ME | Management |
| E-Commerce API | https://api.service.net:30000/ecom | JWT token | REST API |
| Inventory API | https://api.service.net:30000/inven | JWT token | Stock API |
| Keycloak Admin | http://localhost:32400/admin | admin / CHANGE_ME | Identity |
| PgAdmin | http://localhost:31111 | admin@bookstore.dev / CHANGE_ME | Database |
| Superset | http://localhost:32000 | admin / CHANGE_ME | Analytics |
| Grafana | http://localhost:32500 | admin / admin | Monitoring |
| Kiali | http://localhost:32100/kiali | (none) | Service Mesh |
| Flink Dashboard | http://localhost:32200 | (none) | CDC Pipeline |
| Cert Dashboard | http://localhost:32600 | (none) | Certificates |
| Debezium ecom | http://localhost:32300/q/health | (none) | CDC Health |
| Debezium inventory | http://localhost:32301/q/health | (none) | CDC Health |

---

## Prerequisites & Initial Setup

### 1. DNS Setup

Add the following entries to `/etc/hosts` so your browser can resolve the platform hostnames:

```
127.0.0.1  idp.keycloak.net myecom.net api.service.net
```

### 2. Bootstrap the Cluster

Run the master startup script. It auto-detects whether to perform a fresh bootstrap, recovery, or health check:

```bash
bash scripts/up.sh
```

For a completely clean start (destroys existing cluster and data):

```bash
bash scripts/up.sh --fresh
```

### 3. Trust the TLS Certificate

The platform uses a self-signed CA for HTTPS. Without trusting the CA, browsers show "Your connection is not private" (`ERR_CERT_AUTHORITY_INVALID`).

**macOS:**
```bash
bash scripts/trust-ca.sh --install
# Then quit and reopen Chrome
```

**Ubuntu/Debian:**
```bash
bash scripts/trust-ca.sh
sudo cp certs/bookstore-ca.crt /usr/local/share/ca-certificates/bookstore-ca.crt
sudo update-ca-certificates
```

**RHEL/CentOS/Fedora:**
```bash
bash scripts/trust-ca.sh
sudo cp certs/bookstore-ca.crt /etc/pki/ca-trust/source/anchors/bookstore-ca.crt
sudo update-ca-trust extract
```

**Windows (Admin PowerShell):**
```powershell
Import-Certificate -FilePath .\certs\bookstore-ca.crt -CertStoreLocation Cert:\LocalMachine\Root
```

For detailed instructions (install, verify, revert, troubleshooting), see [Browser CA Trust Guide](guides/browser-ca-trust.md).

Alternatively, when using `curl`, pass the `-sk` flag to skip certificate verification:

```bash
curl -sk https://api.service.net:30000/ecom/books
```

### 4. Verify Everything Is Running

```bash
bash scripts/smoke-test.sh
```

This checks all pods, HTTP routes, Kafka topics, and Debezium connectors.

---

## 1. Book Store Application (Customer Experience)

### Step 1: Open the Store

Navigate to **https://myecom.net:30000** in your browser.

You will see the book catalog homepage with a grid of available books. No login is required to browse.

![Homepage](../e2e/screenshots/auth-setup-01-homepage.png)

The catalog page displays book cards with title, author, price, and cover image:

![Book Catalog](../e2e/screenshots/catalog-02-books-grid.png)

### Step 2: Log In via Keycloak

Click the **Login** button in the top navigation bar. You will be redirected to the Keycloak login page.

![Keycloak Login](../e2e/screenshots/auth-setup-02-keycloak-login.png)

Enter your credentials:
- **Username:** `user1`
- **Password:** `CHANGE_ME`

![Credentials Filled](../e2e/screenshots/auth-setup-03-credentials-filled.png)

After successful authentication, you are redirected back to the store. Your name appears in the navbar alongside a **Logout** button.

![Logged In](../e2e/screenshots/auth-setup-04-logged-in.png)

### Step 3: Browse Books & Check Stock

Each book card displays a stock indicator badge:
- **Green "In Stock"** — plenty of copies available
- **Orange "Only X left"** — low stock warning
- **Red "Out of Stock"** — cannot be purchased

![Stock Badges](../e2e/screenshots/stock-01-catalog-stock-badges.png)

### Step 4: Search for Books

Click **Search** in the navigation bar. Enter a title or author name to filter results.

![Search Page](../e2e/screenshots/search-01-empty-search-page.png)

Results display in a table with an **Availability** column showing stock status:

![Search Results](../e2e/screenshots/search-02-results-by-title.png)

![Search by Author](../e2e/screenshots/search-04-results-by-author.png)

When no results match your query:

![No Results](../e2e/screenshots/search-05-no-results.png)

### Step 5: Add Items to Cart

Click **Add to Cart** on any in-stock book. The cart badge in the navbar updates to show the item count.

![Item Added](../e2e/screenshots/checkout-02-item-added.png)

Books that are out of stock have a disabled button — you cannot add them.

![Unauthenticated Add to Cart](../e2e/screenshots/catalog-04-unauthenticated-login-to-buy.png)

> **Note:** If you are not logged in, clicking "Add to Cart" saves the item to a guest cart in your browser's localStorage. See [Guest Cart](#step-7-guest-cart-flow) below.

### Step 6: Checkout

Navigate to the **Cart** page. Review your items, quantities, and stock availability:

![Cart Ready](../e2e/screenshots/checkout-03-cart-ready.png)

The cart page shows per-item stock badges and warns if any item exceeds available stock:

![Cart Stock Badges](../e2e/screenshots/stock-03-cart-stock-badges.png)

Click **Checkout** to place your order:

![Checkout Button](../e2e/screenshots/checkout-04-checkout-button.png)

On success, you see an order confirmation and the cart is cleared:

![Order Confirmed](../e2e/screenshots/checkout-05-order-confirmation.png)

Behind the scenes, the checkout flow:
1. Creates an order in the E-Commerce database
2. Publishes an `order.created` event to Kafka
3. The Inventory Service consumes the event and reserves stock
4. Publishes an `inventory.updated` event to Kafka
5. Debezium captures DB changes and streams them to the Analytics pipeline

### Step 7: Guest Cart Flow

Users who are **not logged in** can still add books to their cart. Items are stored in the browser's `localStorage` under the key `bookstore_guest_cart`.

![Guest Cart — Add Item](../e2e/screenshots/guest-cart-01-catalog-unauthenticated.png)

![Guest Cart — Toast Notification](../e2e/screenshots/guest-cart-02-toast-after-add.png)

![Guest Cart Page](../e2e/screenshots/guest-cart-03-guest-cart-page.png)

When the guest clicks **Login to Checkout**, they are redirected to Keycloak:

![Guest Cart — Login Redirect](../e2e/screenshots/guest-cart-05-redirected-to-keycloak.png)

After login, the guest cart items are automatically **merged** into the server-side cart and `localStorage` is cleared:

![Cart After Merge](../e2e/screenshots/guest-cart-06-cart-after-login.png)

### Step 8: Logout

Click **Logout** in the navbar. You are redirected to the homepage in an unauthenticated state. All in-memory tokens are cleared.

![After Logout](../e2e/screenshots/auth-04-after-logout.png)

---

## 2. Admin Panel

### Accessing the Admin Panel

Log in with admin credentials:
- **Username:** `admin1`
- **Password:** `CHANGE_ME`

After login, an **Admin** link appears in the navigation bar (only visible to users with the `admin` role):

![Admin Link](../e2e/screenshots/admin-01-navbar-admin-link.png)

### Admin Dashboard (/admin)

The dashboard shows summary statistics at a glance:
- **Total Books** — number of books in the catalog
- **Total Orders** — all orders placed
- **Low Stock** — items with stock below threshold
- **Out of Stock** — items with zero inventory

![Admin Dashboard](../e2e/screenshots/admin-02-dashboard.png)

### Book Management (/admin/books)

Full CRUD operations on the book catalog. You can add new books, edit existing ones, or remove them.

![Books List](../e2e/screenshots/admin-03-books-list.png)

![Create Book Form](../e2e/screenshots/admin-04-create-book-form.png)

### Stock Management (/admin/stock)

View and adjust inventory quantities for all books. Set absolute quantities or adjust by delta (e.g., +10 or -5).

![Stock Management](../e2e/screenshots/admin-05-stock-management.png)

### Order Management (/admin/orders)

View all customer orders with line items, quantities, and totals.

![Orders List](../e2e/screenshots/admin-06-orders-list.png)

---

## 3. Apache Superset (Analytics Dashboards)

**URL:** http://localhost:32000
**Login:** admin / CHANGE_ME

![Superset Login](../docs/screenshots/cdc-guide/superset-00-login.png)

After login, you land on the Superset welcome page:

![Superset Welcome](../docs/screenshots/cdc-guide/superset-01-welcome.png)

### Data Pipeline

Analytics data flows through the CDC (Change Data Capture) pipeline:

```
Source DBs (ecom, inventory)
  --> Debezium Server (captures WAL changes)
    --> Kafka (event streaming)
      --> Flink SQL (transforms & joins)
        --> Analytics DB (materialized tables)
          --> Superset (visualizations)
```

### Dashboard 1: Book Store Analytics

Overview of the book catalog and sales activity.

![Book Store Analytics](../docs/screenshots/cdc-guide/superset-dash-book-store-analytics.png)

### Dashboard 2: Sales & Revenue Analytics

Revenue trends, top-selling books, and order volume over time.

![Sales & Revenue](../docs/screenshots/cdc-guide/superset-dash-sales---revenue-analytics.png)

### Dashboard 3: Inventory Analytics

Current stock levels, low-stock alerts, and inventory movement.

![Inventory Analytics](../docs/screenshots/cdc-guide/superset-dash-inventory-analytics.png)

### Exploring Charts

Navigate to **Charts** in the top menu to see individual chart definitions. Click any chart to open it in Explore mode for interactive filtering and customization.

![Chart List](../e2e/screenshots/superset-03-chart-list.png)

---

## 4. Grafana (Metrics, Logs & Traces)

**URL:** http://localhost:32500
**Login:** admin / admin

![Grafana Login](../docs/images/grafana-loki/guide-01-grafana-login.png)

![Grafana Home](../docs/images/grafana-loki/guide-02-grafana-home.png)

Grafana is configured with three datasources:
- **Prometheus** — metrics (request rates, latencies, resource usage)
- **Loki** — centralized log aggregation
- **Tempo** — distributed tracing

### Pre-built Dashboards

Navigate to **Dashboards** in the left sidebar to see all available dashboards:

![Dashboard List](../docs/images/grafana-loki/guide-12-dashboards-list.png)

### Application Logs Dashboard

Five panels showing logs from all services, filterable by service name and log level:
- All Services (combined view)
- ecom-service logs
- inventory-service logs
- Log Volume (rate of log messages over time)
- Error Volume (rate of WARN/ERROR messages)

![Application Logs Dashboard](../docs/images/grafana-loki/guide-09-application-logs-dashboard.png)

### Service Health Dashboard

Real-time request rate, error rate, and latency percentiles (p50, p95, p99) for each microservice.

![Service Health Dashboard](../docs/images/grafana-loki/guide-11-service-health-dashboard.png)

### Distributed Tracing Dashboard

View trace timelines showing how requests flow across services.

![Distributed Tracing](../docs/images/grafana-loki/guide-10-distributed-tracing-dashboard.png)

### Exploring Logs with Loki

Go to **Explore** in the left sidebar, select **Loki** as the datasource.

![Explore Page](../docs/images/grafana-loki/guide-03-explore-page.png)

Use the label browser to filter by service, namespace, or log level:

![Loki Label Browser](../docs/images/grafana-loki/guide-04-loki-label-browser.png)

Available Loki labels:
- `service_name` — `ecom-service` or `inventory-service`
- `service_namespace` — `ecom` or `inventory`
- `deployment_environment` — `production`
- `level` — `DEBUG`, `INFO`, `WARN`, `ERROR`
- `job` — OTel job identifier

Example queries:
```logql
{service_name="ecom-service"}
{service_name="inventory-service", level="ERROR"}
{service_namespace="ecom"} |= "checkout"
```

![All Services Logs](../docs/images/grafana-loki/guide-05-all-services-logs.png)

![ecom-service Logs](../docs/images/grafana-loki/guide-06-ecom-service-logs.png)

![inventory-service Logs](../docs/images/grafana-loki/guide-07-inventory-service-logs.png)

![WARN Level Filter](../docs/images/grafana-loki/guide-08-warn-level-filter.png)

### Exploring Traces with Tempo

Go to **Explore**, select **Tempo** as the datasource. Search by service name to find recent traces, then click a trace ID to view the waterfall diagram.

![Tempo Service Graph](../docs/images/grafana-loki/guide-13-tempo-service-graph.png)

![Tempo Recent Traces](../docs/images/grafana-loki/guide-14-tempo-recent-traces.png)

---

## 5. Kiali (Service Mesh Observability)

**URL:** http://localhost:32100/kiali
**Authentication:** None required

Kiali provides a visual representation of the Istio service mesh, showing real-time traffic flow, mTLS status, and service health.

### Overview

The overview page shows all namespaces with health indicators:

![Kiali Overview](../e2e/screenshots/kiali-01-overview.png)

### Traffic Graph

Real-time traffic flow between services. mTLS connections show lock icons. Color-coded edges indicate health (green = healthy, red = errors):

![Traffic Graph](../e2e/screenshots/kiali-02-traffic-graph.png)

### Workloads

Detailed view of all workloads (deployments) in a namespace with pod counts, health, and Istio configuration status:

![Workloads](../e2e/screenshots/kiali-03-ecom-workloads.png)

### Services

List of all Kubernetes services with their routing rules, virtual services, and destination rules:

![Services](../e2e/screenshots/kiali-04-services.png)

### Mesh Topology

Full mesh topology showing cross-namespace communication patterns:

![Mesh Topology](../e2e/screenshots/kiali-05-mesh-topology.png)

---

## 6. Cert Dashboard (Certificate Management)

**URL:** http://localhost:32600
**Authentication:** None required for viewing; ServiceAccount token required for renewal

The Cert Dashboard is a custom Kubernetes operator that monitors cert-manager certificates and provides a web UI for viewing certificate status and triggering manual renewals.

### Dashboard Overview

![Cert Dashboard Full Page](../e2e/screenshots/cert-dashboard/cert-dashboard-01-full-page.png)

### Certificates Monitored

**1. bookstore-ca** — Root CA certificate
- Validity: 10 years
- Algorithm: ECDSA P-256
- Self-signed ClusterIssuer

![CA Certificate Card](../e2e/screenshots/cert-dashboard/cert-dashboard-02-ca-cert-card.png)

**2. bookstore-gateway-cert** — Gateway leaf certificate
- Validity: 30 days (auto-renew at 7 days remaining)
- DNS SANs: `myecom.net`, `api.service.net`, `idp.keycloak.net`, `localhost`
- IP SANs: `127.0.0.1`

![Gateway Certificate Card](../e2e/screenshots/cert-dashboard/cert-dashboard-03-gateway-cert-card.png)

### Progress Bars

Certificate validity is shown as a progress bar:
- **Green** — more than 50% validity remaining
- **Yellow** — between 25% and 50% remaining
- **Red** — less than 25% remaining (approaching renewal)

![Progress Bar](../e2e/screenshots/cert-dashboard/cert-dashboard-04-progress-bar-green.png)

### Force Certificate Renewal

To manually trigger renewal of the gateway certificate:

1. Generate a ServiceAccount token:
   ```bash
   TOKEN=$(kubectl create token bookstore-certs -n cert-dashboard --duration=10m)
   ```

2. Call the renewal API:
   ```bash
   curl -X POST http://localhost:32600/api/renew \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"name":"bookstore-gateway-cert","namespace":"infra"}'
   ```

3. The dashboard shows real-time SSE (Server-Sent Events) progress through the renewal phases:
   - Deleting secret
   - Waiting for issuing
   - Issued
   - Ready
   - Complete

![Renew Modal](../e2e/screenshots/cert-dashboard/cert-dashboard-05-renew-modal.png)

![SSE In Progress](../e2e/screenshots/cert-dashboard/cert-dashboard-07-sse-in-progress.png)

![SSE Complete](../e2e/screenshots/cert-dashboard/cert-dashboard-08-sse-complete.png)

### API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/` | GET | None | Dashboard web UI |
| `/api/certs` | GET | None | List all certificates as JSON |
| `/api/renew` | POST | Bearer token | Trigger certificate renewal |
| `/api/sse/{streamId}` | GET | None | SSE stream for renewal progress |
| `/healthz` | GET | None | Health check |

![API Certs Response](../e2e/screenshots/cert-dashboard/cert-dashboard-12-api-certs.png)

![Health Check](../e2e/screenshots/cert-dashboard/cert-dashboard-11-healthz.png)

---

## 7. PgAdmin (Database Administration)

**URL:** http://localhost:31111
**Login:** admin@bookstore.dev / CHANGE_ME

![PgAdmin Login](../e2e/screenshots/pgadmin-01-login.png)

![PgAdmin Dashboard](../e2e/screenshots/pgadmin-02-dashboard.png)

### Pre-configured Database Servers

All four PostgreSQL clusters are pre-registered. Connection details (for reference or manual setup):

| Database | Hostname | DB Name | Username | Password |
|----------|----------|---------|----------|----------|
| E-Commerce | ecom-db-rw.ecom.svc.cluster.local | ecomdb | ecomuser | CHANGE_ME |
| Inventory | inventory-db-rw.inventory.svc.cluster.local | inventorydb | inventoryuser | CHANGE_ME |
| Analytics | analytics-db-rw.analytics.svc.cluster.local | analyticsdb | analyticsuser | CHANGE_ME |
| Keycloak | keycloak-db-rw.identity.svc.cluster.local | keycloakdb | keycloakuser | CHANGE_ME |

Each database is managed by CloudNativePG with 1 primary + 1 standby replica. The `-rw` suffix in the hostname routes to the primary (read-write) instance.

### Key Tables

**E-Commerce DB (`ecomdb`)**
- `books` — book catalog (id, title, author, price, isbn, description)
- `orders` — customer orders (id, user_id, total, status, created_at)
- `order_items` — line items (order_id, book_id, quantity, price)
- `carts` / `cart_items` — shopping cart state

**Inventory DB (`inventorydb`)**
- `stock` — inventory levels (book_id, quantity, reserved)

**Analytics DB (`analyticsdb`)**
- `dim_books` — book dimension table (populated by Flink CDC)
- `fact_orders` — order facts (populated by Flink CDC)
- `fact_order_items` — order item facts (populated by Flink CDC)
- `fact_inventory` — inventory snapshots (populated by Flink CDC)

---

## 8. Flink Dashboard (CDC Pipeline)

**URL:** http://localhost:32200
**Authentication:** None required

The Flink dashboard shows the status of the streaming SQL jobs that power the CDC analytics pipeline.

### Overview

![Flink Overview](../docs/screenshots/cdc-guide/flink-01-overview.png)

### Running Jobs

Four streaming SQL jobs run continuously:
1. **dim_books** — mirrors the books table from ecom-db into analytics-db
2. **fact_orders** — mirrors orders from ecom-db into analytics-db
3. **fact_order_items** — mirrors order line items from ecom-db into analytics-db
4. **fact_inventory** — mirrors stock records from inventory-db into analytics-db

![Jobs List](../docs/screenshots/cdc-guide/flink-02-jobs-list.png)

### Job Detail View

Click any job to see its execution graph, checkpoints, and metrics:

![Job Detail](../docs/screenshots/cdc-guide/flink-03-job-detail.png)

![Checkpoints](../docs/screenshots/cdc-guide/flink-04-checkpoints.png)

![Metrics](../docs/screenshots/cdc-guide/flink-05-metrics.png)

### Task Managers

View the Flink task manager pods and their resource utilization:

![Task Managers](../docs/screenshots/cdc-guide/flink-06-taskmanagers.png)

---

## 9. Debezium CDC Health

Debezium Server captures PostgreSQL WAL (Write-Ahead Log) changes and streams them to Kafka topics. Two instances run — one for each source database.

### Check Health

```bash
# E-Commerce Debezium Server
curl -s http://localhost:32300/q/health | jq .

# Inventory Debezium Server
curl -s http://localhost:32301/q/health | jq .
```

Expected response:
```json
{
  "status": "UP",
  "checks": [...]
}
```

![Debezium Health](../e2e/screenshots/health-01-debezium-pod-running.png)

### Kafka Topics Created by Debezium

Debezium creates topics in the format `<prefix>.<schema>.<table>`:

```bash
kubectl exec -n infra deploy/kafka -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --list
```

Key topics:
- `ecom-connector.public.books` — book catalog changes
- `ecom-connector.public.orders` — order changes
- `ecom-connector.public.order_items` — order item changes
- `inventory-connector.public.stock` — stock level changes
- `debezium.ecom.offsets` — Debezium ecom offset tracking
- `debezium.inventory.offsets` — Debezium inventory offset tracking

### Verify CDC Pipeline End-to-End

```bash
bash scripts/verify-cdc.sh
```

This script inserts a test row into the source database, then polls the analytics database (up to 30 seconds) to confirm the row has propagated through the full pipeline.

---

## 10. Keycloak Admin Console

**URL:** http://localhost:32400/admin
**Login:** admin / CHANGE_ME

![Keycloak Admin Login](../e2e/screenshots/keycloak-01-admin-login-page.png)

![Keycloak Admin Console](../e2e/screenshots/keycloak-02-admin-master-console.png)

### Realm: bookstore

Switch to the **bookstore** realm using the realm dropdown in the top-left corner.

![Realm Settings](../e2e/screenshots/keycloak-04-realm-settings.png)

### Users

Two users are pre-configured:

| Username | Password | Roles | Purpose |
|----------|----------|-------|---------|
| user1 | CHANGE_ME | customer | Shopping, checkout |
| admin1 | CHANGE_ME | customer, admin | Shopping + admin panel |

![Users List](../e2e/screenshots/keycloak-05-users-list.png)

### Clients

The `ui-client` is configured for OIDC Authorization Code Flow with PKCE:
- **Client ID:** `ui-client`
- **Root URL:** `https://myecom.net:30000`
- **Valid Redirect URIs:** `https://myecom.net:30000/callback`, `https://localhost:30000/callback`
- **Web Origins:** `https://myecom.net:30000`, `https://localhost:30000`
- **PKCE Challenge Method:** S256

![Clients](../e2e/screenshots/keycloak-06-clients.png)

---

## 11. API Quick Reference

All API endpoints are served over HTTPS. Use `-sk` with `curl` to skip certificate verification.

### Obtain a JWT Token

**As a regular user (user1):**
```bash
TOKEN=$(curl -sk -X POST \
  "https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=ui-client&username=user1&password=CHANGE_ME" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
```

**As an admin (admin1):**
```bash
ADMIN_TOKEN=$(curl -sk -X POST \
  "https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=ui-client&username=admin1&password=CHANGE_ME" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
```

### Public Endpoints (No Auth Required)

```bash
# List all books
curl -sk https://api.service.net:30000/ecom/books | jq .

# Search books by title or author
curl -sk "https://api.service.net:30000/ecom/books/search?q=Python" | jq .

# Get a specific book by ID
curl -sk https://api.service.net:30000/ecom/books/<book-uuid> | jq .

# Get stock for a specific book
curl -sk https://api.service.net:30000/inven/stock/<book-uuid> | jq .

# Bulk stock check
curl -sk "https://api.service.net:30000/inven/stock/bulk?book_ids=<uuid1>,<uuid2>" | jq .

# Inventory service health
curl -sk https://api.service.net:30000/inven/health
```

### Authenticated Endpoints (JWT Required)

```bash
# View cart
curl -sk -H "Authorization: Bearer $TOKEN" \
  https://api.service.net:30000/ecom/cart | jq .

# Add item to cart
curl -sk -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"bookId":"<book-uuid>","quantity":1}' \
  https://api.service.net:30000/ecom/cart | jq .

# Checkout (place order)
curl -sk -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  https://api.service.net:30000/ecom/checkout | jq .
```

### Admin Endpoints (Admin Role Required)

```bash
# List all books (admin view)
curl -sk -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.service.net:30000/ecom/admin/books | jq .

# List all orders
curl -sk -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.service.net:30000/ecom/admin/orders | jq .

# View all stock levels
curl -sk -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.service.net:30000/inven/admin/stock | jq .
```

### Keycloak Admin API

```bash
# Get admin token for Keycloak management
KC_TOKEN=$(curl -sk -X POST \
  "https://idp.keycloak.net:30000/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=admin&password=CHANGE_ME" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# List users in bookstore realm
curl -sk -H "Authorization: Bearer $KC_TOKEN" \
  "https://idp.keycloak.net:30000/admin/realms/bookstore/users" | jq .

# List clients in bookstore realm
curl -sk -H "Authorization: Bearer $KC_TOKEN" \
  "https://idp.keycloak.net:30000/admin/realms/bookstore/clients" | jq .
```

---

## 12. Troubleshooting

### Quick Health Checks

```bash
# Comprehensive smoke test (pods + routes + Kafka + Debezium)
bash scripts/smoke-test.sh

# Detailed sanity check
bash scripts/sanity-test.sh

# Verify all HTTP/HTTPS routes return expected status codes
bash scripts/verify-routes.sh

# Verify CDC pipeline end-to-end
bash scripts/verify-cdc.sh
```

### Pod Logs

```bash
# E-Commerce Service
kubectl logs -n ecom deploy/ecom-service -f

# Inventory Service
kubectl logs -n inventory deploy/inventory-service -f

# Keycloak
kubectl logs -n identity deploy/keycloak -f

# Kafka
kubectl logs -n infra deploy/kafka -f

# Debezium (ecom)
kubectl logs -n infra deploy/debezium-server-ecom -f

# Debezium (inventory)
kubectl logs -n infra deploy/debezium-server-inventory -f

# Flink JobManager
kubectl logs -n analytics deploy/flink-jobmanager -f
```

### Database Shell Access

Connect directly to the PostgreSQL primary via the CNPG-managed pods:

```bash
# E-Commerce DB
kubectl exec -n ecom -it ecom-db-1 -- psql -U ecom

# Inventory DB
kubectl exec -n inventory -it inventory-db-1 -- psql -U inventory

# Analytics DB
kubectl exec -n analytics -it analytics-db-1 -- psql -U analytics

# Keycloak DB
kubectl exec -n identity -it keycloak-db-1 -- psql -U keycloak
```

### Kafka Diagnostics

```bash
# List all topics
kubectl exec -n infra deploy/kafka -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --list

# List consumer groups
kubectl exec -n infra deploy/kafka -- /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 --list

# Describe a specific topic
kubectl exec -n infra deploy/kafka -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --describe --topic ecom-connector.public.orders
```

### Recovery After Docker Desktop Restart

When Docker Desktop restarts, the kind cluster nodes come back but pods and mesh connectivity are broken. The `up.sh` script auto-detects this and runs full recovery:

```bash
bash scripts/up.sh
```

This handles:
1. **ztunnel restart** — restores Istio Ambient mesh HBONE plumbing
2. **Pod rolling restart** — all pods restarted in dependency order (databases first, then applications)
3. **Debezium re-registration** — Kafka topics are lost on Kafka restart; connectors are re-registered

### Reset user1 Password

If the user1 password gets out of sync or the account is locked:

```bash
# Get Keycloak admin token
ADMIN_TOKEN=$(curl -sk -X POST \
  "https://idp.keycloak.net:30000/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=admin&password=CHANGE_ME" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# Reset password
curl -sk -X PUT \
  "https://idp.keycloak.net:30000/admin/realms/bookstore/users/9d82bcb3-6e96-462c-bdb9-e677080e8920/reset-password" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"password","value":"CHANGE_ME","temporary":false}'
```

### Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Browser shows certificate warning | CA not trusted | `bash scripts/trust-ca.sh --install` |
| `curl: (7) Failed to connect` | Cluster not running | `bash scripts/up.sh` |
| 401 Unauthorized on API calls | Token expired (5 min lifetime) | Re-fetch the JWT token |
| Empty analytics dashboards | CDC pipeline not running | Check Flink jobs at http://localhost:32200 |
| Debezium health returns DOWN | Kafka or DB connection lost | `bash scripts/up.sh` (auto-recovers) |
| "Out of Stock" on all books | Inventory not seeded | Check inventory-db stock table |
| Keycloak login page not loading | DNS not configured | Add entries to `/etc/hosts` |
| Pods in CrashLoopBackOff | Check pod logs | `kubectl logs -n <ns> <pod> --previous` |

### Running E2E Tests

The Playwright test suite validates all user-facing features:

```bash
cd e2e

# Run all tests (headless)
npm run test

# Run with browser visible
npm run test:headed

# Run with Playwright UI (interactive debugger)
npm run test:ui

# Run a specific test file
npx playwright test checkout.spec.ts

# Run tests matching a name pattern
npx playwright test -g "should display book catalog"

# View the last test report
npm run report
```

Default test credentials: user1 / CHANGE_ME

---

## Architecture Diagrams

For reference, the platform architecture and data flow are captured in these diagrams:

![Infrastructure Architecture](../e2e/screenshots/infra-architecture.png)

![Data Flow Diagram](../e2e/screenshots/data-flow-diagram.png)
