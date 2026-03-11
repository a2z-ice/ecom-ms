# Source Structure

> Extracted from CLAUDE.md for performance.

## ecom-service (`com.bookstore.ecom`)
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

## inventory-service (`app/`)
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

## ui (`src/`)
```
auth/oidcConfig.ts     UserManager with PKCE, InMemoryWebStorage
auth/AuthContext.tsx   Token state context
api/client.ts          fetch wrapper: attaches Bearer token + X-CSRF-Token
pages/                 CatalogPage, SearchPage, CartPage, CheckoutPage,
                       OrderConfirmationPage, CallbackPage
components/NavBar.tsx
```

## e2e (`e2e/`)
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

## infra (`infra/`)
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
