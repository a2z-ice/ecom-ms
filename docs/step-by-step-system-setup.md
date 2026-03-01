# Step-by-Step System Setup Guide

## Full Fresh Bootstrap: Issues Found & Fixed

This document is a forensic record of every issue discovered when rebuilding the BookStore
cluster completely from scratch (`up.sh --fresh --data`) and the exact fix applied for each
one. Read this before attempting a fresh bootstrap so you do not have to rediscover these
issues yourself.

**Validated on**: macOS 15 (Darwin 25.3.0), Docker Desktop, kind 0.26, Istio 1.28.4,
Keycloak 26.5.4, Flink 1.20, Apache Superset latest, Playwright 1.x
**End state**: 89/89 E2E tests passing after a single `./scripts/up.sh --fresh --data`

---

## How to Start

```bash
# Prerequisites (one-time)
echo "127.0.0.1  idp.keycloak.net  myecom.net  api.service.net" | sudo tee -a /etc/hosts

# Full fresh rebuild (interactive — asks for confirmation before wiping cluster + data)
./scripts/up.sh --fresh --data

# Non-interactive (CI / automation)
./scripts/up.sh --fresh --data --yes

# After completion, run regression suite
cd e2e && npm run test
```

---

## Issue 1 — Kubernetes Gateway API: GatewayClass Race Condition

### Where it broke
`infra/kgateway/install.sh` — the step that installs the Kubernetes Gateway API CRDs and
waits for the `istio` GatewayClass to be accepted.

### Symptom
```
error: no matching resources found
Error from server (NotFound): gatewayclasses.gateway.networking.k8s.io "istio" not found
```
The script called `kubectl wait --for=condition=Accepted gatewayclass/istio` immediately
after applying the Gateway API CRDs, but the `istio` GatewayClass is created
**asynchronously by istiod** — not by the CRD install itself. istiod watches for the CRD
to appear and then creates the GatewayClass object a few seconds later. `kubectl wait`
with a resource that does not yet exist exits immediately with NotFound instead of waiting.

### Root Cause
`kubectl wait` fails immediately (exit 1) when the resource does not exist — it does not
poll for the resource to appear. The GatewayClass race window is 5–15 seconds on a cold
cluster.

### Fix applied
Added a polling loop in `infra/kgateway/install.sh` that retries every 5 seconds (up to
24 attempts = 2 minutes) until `kubectl get gatewayclass istio` succeeds before calling
`kubectl wait`:

```bash
echo "Waiting for Istio GatewayClass to be created by istiod..."
for i in $(seq 1 24); do
  if kubectl get gatewayclass istio &>/dev/null 2>&1; then
    echo "  GatewayClass 'istio' found."
    break
  fi
  echo "  Not ready yet (attempt ${i}/24), retrying in 5s..."
  sleep 5
done
kubectl wait --for=condition=Accepted gatewayclass/istio --timeout=60s
```

### File changed
`infra/kgateway/install.sh`

---

## Issue 2 — Istio Gateway Service Gets a Random NodePort

### Where it broke
After `kubectl apply -f infra/kgateway/gateway.yaml`, the `bookstore-gateway-istio`
Service was created by Istio with a random high NodePort (e.g., 32683) instead of 30000.

### Symptom
```bash
$ curl -s http://myecom.net:30000/ecom/books
curl: (7) Failed to connect to myecom.net port 30000: Connection refused
```
The kind cluster `extraPortMappings` binds host port 30000 to the control-plane container
port 30000. If Istio's auto-created Service uses a different NodePort, the kind mapping
has no effect and the host port is effectively dead.

### Root Cause
When you define a `Gateway` resource with `gatewayClassName: istio`, Istio creates a
corresponding Service of type LoadBalancer/NodePort automatically. It assigns a NodePort
from Kubernetes's random NodePort range (30000–32767). Istio does not read any annotation
or spec field from the Gateway object to pin the NodePort value.

### Fix applied
Added a polling + patch block in `scripts/up.sh` right after `gateway.yaml` is applied.
The block waits for the Service to appear, then patches the HTTP port's NodePort to 30000:

```bash
info "Waiting for Istio to create bookstore-gateway-istio service..."
for i in $(seq 1 24); do
  if kubectl get svc bookstore-gateway-istio -n infra &>/dev/null 2>&1; then
    kubectl patch svc bookstore-gateway-istio -n infra --type='json' \
      -p='[{"op":"replace","path":"/spec/ports/1/nodePort","value":30000}]'
    info "Patched bookstore-gateway-istio NodePort → 30000"
    break
  fi
  info "  Service not ready yet (${i}/24), retrying in 5s..."
  sleep 5
done
```

> **Note**: `ports[0]` is the Istio status port (15021). `ports[1]` is the HTTP port (80).
> The patch uses index 1.

### File changed
`scripts/up.sh`

---

## Issue 3 — Istio STRICT mTLS Blocks NodePort Traffic from Host

### Where it broke
After applying `infra/istio/security/peer-auth.yaml` (namespace-wide STRICT
PeerAuthentication), services exposed via NodePort became unreachable from the host even
though kind `extraPortMappings` correctly forwarded the port.

### Symptom
```bash
$ curl -v http://localhost:32300/connectors     # Debezium REST API
* Connected to localhost (127.0.0.1) port 32300 (#0)
* Connection reset by peer
```
TCP connection succeeded (port was open) but was immediately reset. No HTTP response at
all. PgAdmin, Superset, and Flink showed the same behavior.

Kiali at port 32100 worked because `istio-system` had no STRICT PeerAuthentication applied.

### Root Cause
Istio Ambient Mesh routes ALL inbound pod traffic through `ztunnel` (a DaemonSet node
proxy). ztunnel expects inbound connections to arrive as HBONE (HTTP/2 CONNECT on port
15008). Plain TCP connections from the host arrive via kind's NodePort DNAT — they reach
the pod's IP as plaintext, not wrapped in HBONE. When PeerAuthentication is `STRICT`,
ztunnel rejects any non-HBONE inbound connection with a TCP RST.

```
Host (plaintext) → kind NodePort → iptables DNAT → Pod IP (plaintext)
                                                          ↑
                                               ztunnel expects HBONE here
                                               → rejects plaintext → RST
```

### First attempted fix (failed)
Tried adding namespace-wide `portLevelMtls`:
```yaml
# THIS DOES NOT WORK — portLevelMtls requires a selector
spec:
  mtls:
    mode: STRICT
  portLevelMtls:
    "8083":
      mode: PERMISSIVE
```
Kubernetes rejected this with: `portLevelMtls requires selector to be set`.

### Fix applied
Added workload-specific PeerAuthentication objects that select the individual pod by label
and set `portLevelMtls: PERMISSIVE` on exactly the NodePort-exposed port. The outer mTLS
mode is still STRICT (pod-to-pod traffic stays mTLS); only the specific NodePort is opened
to plaintext from the host:

```yaml
# infra/istio/security/peer-auth.yaml — added for each NodePort-exposed service

---
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: debezium-nodeport-permissive
  namespace: infra
spec:
  selector:
    matchLabels:
      app: debezium
  mtls:
    mode: STRICT
  portLevelMtls:
    "8083":
      mode: PERMISSIVE

---
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: pgadmin-nodeport-permissive
  namespace: infra
spec:
  selector:
    matchLabels:
      app: pgadmin
  mtls:
    mode: STRICT
  portLevelMtls:
    "80":
      mode: PERMISSIVE

---
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: superset-nodeport-permissive
  namespace: analytics
spec:
  selector:
    matchLabels:
      app: superset
  mtls:
    mode: STRICT
  portLevelMtls:
    "8088":
      mode: PERMISSIVE

---
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: flink-nodeport-permissive
  namespace: analytics
spec:
  selector:
    matchLabels:
      app: flink-jobmanager
  mtls:
    mode: STRICT
  portLevelMtls:
    "8081":
      mode: PERMISSIVE
```

### Key rule to remember
> `portLevelMtls` in Istio Ambient **requires** a `selector`. A namespace-wide
> PeerAuthentication cannot have `portLevelMtls`. One workload-specific
> PeerAuthentication is needed per NodePort-exposed pod.

### File changed
`infra/istio/security/peer-auth.yaml`

---

## Issue 4 — Debezium DB Credentials Secret Missing

### Where it broke
`infra/debezium/debezium.yaml` deployment — the pod crashed on startup because the
`debezium-db-credentials` Secret did not exist.

### Symptom
```
$ kubectl get pod -n infra -l app=debezium
NAME                       READY   STATUS             RESTARTS
debezium-7b9d6f5c4-xk9sm   0/1     CreateContainerError   0

Error: secret "debezium-db-credentials" not found
```

### Root Cause
The `debezium.yaml` manifest references `secretRef: name: debezium-db-credentials` to
get the PostgreSQL credentials for both the `ecom-db` and `inventory-db` connectors.
This Secret is not defined in any static manifest — it must be created at deploy time
from the existing DB secrets. The previous `infra-up.sh` script did not create it.

### Fix applied
Added a block in `scripts/up.sh` that reads the credentials from the pre-existing
database Secrets and creates `debezium-db-credentials` using `--dry-run=client -o yaml |
kubectl apply -f -` (idempotent):

```bash
ECOM_USER=$(kubectl get secret -n ecom ecom-db-secret -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
ECOM_PASS=$(kubectl get secret -n ecom ecom-db-secret -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)
INV_USER=$(kubectl get secret -n inventory inventory-db-secret -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
INV_PASS=$(kubectl get secret -n inventory inventory-db-secret -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)

kubectl create secret generic debezium-db-credentials -n infra \
  --from-literal=ECOM_DB_USER="$ECOM_USER" \
  --from-literal=ECOM_DB_PASSWORD="$ECOM_PASS" \
  --from-literal=INVENTORY_DB_USER="$INV_USER" \
  --from-literal=INVENTORY_DB_PASSWORD="$INV_PASS" \
  --dry-run=client -o yaml | kubectl apply -f -
```

### File changed
`scripts/up.sh`

---

## Issue 5 — Kafka CDC Topics Not Pre-Created

### Where it broke
Debezium connector registration (`infra/debezium/register-connectors.sh`) and the Flink
SQL runner both depend on CDC topic names like `ecom-connector.public.orders` existing.

### Symptom
After registering Debezium connectors:
```bash
$ curl -s localhost:32300/connectors/ecom-connector/status | python3 -m json.tool
{
  "connector": { "state": "RUNNING" },
  "tasks": [{ "state": "FAILED",
               "trace": "org.apache.kafka.common.errors.UnknownTopicOrPartitionException:
                         This server does not host this topic-partition." }]
}
```

And Flink SQL runner job failed immediately:
```
Caused by: org.apache.kafka.common.errors.UnknownTopicOrPartitionException:
This server does not host this topic-partition.
```

### Root Cause
`KAFKA_AUTO_CREATE_TOPICS_ENABLE=false` is set in the Kafka deployment (intentional —
uncontrolled auto-creation causes operational issues). The `kafka-topic-init` Job
in `infra/kafka/kafka.yaml` only created the application event topics:
- `order.created`
- `inventory.updated`

It did **not** create the 4 Debezium CDC topics:
- `ecom-connector.public.books`
- `ecom-connector.public.orders`
- `ecom-connector.public.order_items`
- `inventory-connector.public.inventory`

### Fix applied
Added the 4 CDC topics to the `kafka-topic-init` Job in `infra/kafka/kafka.yaml`:

```bash
create_topic "order.created"
create_topic "inventory.updated"
# Debezium CDC topics (auto-create disabled — must be pre-created)
create_topic "ecom-connector.public.books"
create_topic "ecom-connector.public.orders"
create_topic "ecom-connector.public.order_items"
create_topic "inventory-connector.public.inventory"
echo "All topics ready."
```

### File changed
`infra/kafka/kafka.yaml`

---

## Issue 6 — Keycloak Missing `sub` Claim in JWT → null user_id

### Where it broke
Every authenticated API call to `POST /cart`, `GET /cart`, `POST /checkout` returned HTTP
500 with a PostgreSQL constraint violation.

### Symptom
E2E test `cart.spec.ts › authenticated user can add a book to cart` failed:
```
error-context.md: page shows "Your cart is empty."
```

`ecom-service` pod logs:
```
ERROR o.h.engine.jdbc.spi.SqlExceptionHelper - ERROR: null value in column "user_id"
  of relation "cart_items" violates not-null constraint
Detail: Failing row contains (4655083f-..., null, 00000000-..., 1, 2026-03-01 07:17:40...)
```

### Diagnosis
Inspected the JWT access token stored in `fixtures/user1-session.json`:
```bash
cat e2e/fixtures/user1-session.json | python3 -c "
import sys, json, base64
data = json.load(sys.stdin)
for k, v in data.items():
    token = json.loads(v).get('access_token', '')
    payload = token.split('.')[1]
    payload += '=' * (4 - len(payload) % 4)
    print(json.dumps(json.loads(base64.urlsafe_b64decode(payload)), indent=2))
    break
"
```

JWT payload:
```json
{
  "exp": 1772350582,
  "iat": 1772350282,
  "jti": "onrtac:55eed8d2-...",
  "iss": "http://idp.keycloak.net:30000/realms/bookstore",
  "typ": "Bearer",
  "azp": "ui-client",
  "sid": "PsDjWKPMmchxBYS19si5j2F5",
  "scope": "openid roles email profile",
  "roles": ["customer"]
}
```

**The `sub` claim is completely absent.** `CartController` calls `jwt.getSubject()` which
maps to the `sub` claim. Without it, the method returns null. That null is passed to
`CartService.addToCart(null, request)` → `cart_items.user_id = null` → DB constraint
violation.

### Root Cause
Keycloak's built-in `openid` scope contains a protocol mapper called `oidc-sub-mapper`
that puts the user's internal UUID into the `sub` JWT claim. When `realm-export.json`
defines a `clientScopes` array with custom scopes (`roles`, `profile`, `email`), the
realm import **replaces all scopes** — including the built-in ones — with only what is
listed in the export file. The `openid` scope (and its `sub` mapper) was not in our
export, so it was never created.

The Keycloak realm returned `scope: "openid roles email profile"` in tokens (the `openid`
scope was recognized as an implicit request), but without the scope actually existing in
the realm with its mapper, no `sub` claim was emitted.

Checking the realm's client scopes confirmed:
```bash
curl -s http://idp.keycloak.net:30000/admin/realms/bookstore/client-scopes \
  -H "Authorization: Bearer $ADMIN_TOKEN" | python3 -c "
import sys, json
for s in json.load(sys.stdin):
    print(s['name'])
"
# Output:
# offline_access    ← built-in (survived import)
# roles             ← our custom
# email             ← our custom (but had no mappers!)
# profile           ← our custom (had no mappers!)
```

The `openid` scope, `acr`, `basic`, `web-origins` etc. were all missing.

### Fix applied

**Step 1**: Added `oidc-sub-mapper` to the `profile` scope in `infra/keycloak/realm-export.json`:

```json
{
  "name": "profile",
  "protocol": "openid-connect",
  "attributes": { "include.in.token.scope": "true" },
  "protocolMappers": [
    {
      "name": "sub",
      "protocol": "openid-connect",
      "protocolMapper": "oidc-sub-mapper",
      "consentRequired": false,
      "config": {
        "introspection.token.claim": "true",
        "access.token.claim": "true",
        "id.token.claim": "true",
        "lightweight.claim": "false",
        "userinfo.token.claim": "false"
      }
    },
    {
      "name": "preferred_username",
      "protocol": "openid-connect",
      "protocolMapper": "oidc-usermodel-attribute-mapper",
      "config": {
        "userinfo.token.claim": "true",
        "user.attribute": "username",
        "id.token.claim": "true",
        "access.token.claim": "true",
        "claim.name": "preferred_username",
        "jsonType.label": "String"
      }
    }
  ]
}
```

**Step 2**: Also added `email` mapper to the `email` scope (it was also missing mappers):
```json
{
  "name": "email",
  "protocol": "openid-connect",
  "protocolMappers": [
    {
      "name": "email",
      "protocol": "openid-connect",
      "protocolMapper": "oidc-usermodel-attribute-mapper",
      "config": {
        "userinfo.token.claim": "true",
        "user.attribute": "email",
        "id.token.claim": "true",
        "access.token.claim": "true",
        "claim.name": "email",
        "jsonType.label": "String"
      }
    }
  ]
}
```

**Verification**: After re-running the Keycloak import and re-running `auth.setup.ts`:
```json
{
  "sub": "0af1a940-2115-47d6-9e15-57b722e1775e",
  "preferred_username": "user1",
  "email": "user1@bookstore.local",
  "roles": ["customer"],
  ...
}
```

**Step 3**: Re-ran the auth fixture to refresh stored session tokens:
```bash
cd e2e && npx playwright test fixtures/auth.setup.ts --reporter=list
```

### File changed
`infra/keycloak/realm-export.json`

---

## Issue 7 — Analytics DDL Not Applied Before Flink Starts

### Where it broke
The Flink SQL runner Job was submitted but the 4 analytics DB tables (`fact_orders`,
`fact_order_items`, `dim_books`, `fact_inventory`) did not exist yet when Flink tried to
write to them.

### Symptom
Flink jobs were in `FAILED` state immediately after submission:
```bash
$ curl -s localhost:32200/jobs | python3 -c "
import sys, json
for j in json.load(sys.stdin)['jobs']:
    print(j['id'], j['status'])
"
# b3a12... FAILED
# 9c4f1... FAILED
# ...
```

Flink job exception (via `/jobs/{id}/exceptions`):
```
org.postgresql.util.PSQLException: ERROR: relation "fact_orders" does not exist
```

### Root Cause
The original `up.sh` applied the analytics DDL at the **end** of `bootstrap_fresh()`,
after Debezium connectors were registered. This is too late — Flink's JDBC sink connector
validates and starts writing to the target tables as soon as the streaming job starts.
If the tables do not exist, the JDBC sink fails immediately and the job enters FAILED
state. Flink's `fixed-delay` restart strategy retries a few times then gives up.

Additionally, the command had a silent bug:
```bash
# BEFORE — BROKEN (missing -i flag, stdin not passed to container)
kubectl exec -n analytics "$ANALYTICS_POD" -- \
  psql -U analyticsuser -d analyticsdb < analytics-ddl.sql
```
`kubectl exec` without `-i` does NOT pass the caller's stdin to the container. The
redirect `< file` provides stdin to the `kubectl exec` process, but kubectl discards it
unless the interactive flag `-i` is set. Result: psql gets no input and exits 0 silently.

### Fix applied

**Step 1**: Moved the DDL application to immediately after `analytics-db` is ready
(before Flink is deployed):

```bash
section "Deploying PostgreSQL instances"
kubectl apply -f "${REPO_ROOT}/infra/postgres/analytics-db.yaml"
wait_deploy analytics-db analytics

section "Applying analytics DB schema"
# Must happen BEFORE Flink is deployed — JDBC sink requires tables to pre-exist.
kubectl wait --for=condition=Ready pod -n analytics -l app=analytics-db --timeout=60s
ANALYTICS_POD=$(kubectl get pod -n analytics -l app=analytics-db \
  -o jsonpath='{.items[0].metadata.name}')
cat "${REPO_ROOT}/analytics/schema/analytics-ddl.sql" | \
  kubectl exec -i -n analytics "$ANALYTICS_POD" -- \
  psql -U analyticsuser -d analyticsdb

section "Deploying Flink (CDC analytics pipeline)"
# Flink starts here — tables now exist ✓
```

**Step 2**: Fixed `kubectl exec` to use `-i` (pipe stdin through):
```bash
# AFTER — CORRECT
cat "${REPO_ROOT}/analytics/schema/analytics-ddl.sql" | \
  kubectl exec -i -n analytics "$ANALYTICS_POD" -- \
  psql -U analyticsuser -d analyticsdb
```

**Step 3**: Removed the duplicate (now-stale) DDL section from the end of
`bootstrap_fresh()`.

### File changed
`scripts/up.sh`

---

## Issue 8 — verify-cdc.sh Queried Wrong Column Name

### Where it broke
`scripts/verify-cdc.sh` — the polling loop that checks if a test order appeared in
the analytics DB.

### Symptom
```
FAIL: Order did not appear in analytics-db within 30s.
Check: kubectl logs -n infra deploy/debezium
```
The CDC pipeline was actually working (Debezium connectors RUNNING, Flink jobs RUNNING),
but the script always timed out.

### Root Cause
The script polled `fact_orders` with:
```bash
SELECT COUNT(*) FROM fact_orders WHERE order_id = '${TEST_ORDER_ID}';
```
But the `fact_orders` table has a column named `id`, not `order_id`:
```sql
-- analytics/schema/analytics-ddl.sql
CREATE TABLE IF NOT EXISTS fact_orders (
    id          UUID PRIMARY KEY,   -- ← column is "id"
    user_id     TEXT NOT NULL,
    ...
);
```

The `WHERE order_id = '...'` clause always returned 0 rows even when the row existed,
causing the 30-second timeout.

### Fix applied
Changed the column name in `verify-cdc.sh`:
```bash
# BEFORE (wrong)
SELECT COUNT(*) FROM fact_orders WHERE order_id = '${TEST_ORDER_ID}';

# AFTER (correct)
SELECT COUNT(*) FROM fact_orders WHERE id = '${TEST_ORDER_ID}';
```

### File changed
`scripts/verify-cdc.sh`

---

## Issue 9 — Superset Bootstrap Missing 2 Pie Charts

### Where it broke
`infra/superset/bootstrap-job.yaml` — the Python bootstrap script that creates Superset
charts and dashboards.

### Symptom
E2E tests in `superset.spec.ts`:
```
✗  Superset API: all 16 charts exist
   Expected: 16 charts
   Received: 14 charts

✗  Chart: "Stock Status Distribution" pie chart is in chart list
✗  Chart: "Revenue Share by Genre" pie chart is in chart list
```

### Root Cause
The `upsert_dashboard()` call for "Inventory Analytics" referenced two chart variables
(`stock_status` and `rev_share_genre`) that were listed in the dashboard layout but the
corresponding `upsert_chart()` calls creating those charts were missing from the script.

### Fix applied
Added the two missing `upsert_chart()` calls before the `upsert_dashboard()` call:

```python
stock_status = upsert_chart(s, t, c, "Stock Status Distribution", "echarts_pie",
    ds["vw_inventory_health"],
    {
      "metric": metric("stock_quantity", "INTEGER"),
      "groupby": ["stock_status"],
      "row_limit": 10,
      "color_scheme": "supersetColors",
      "show_labels": True
    })

rev_share_genre = upsert_chart(s, t, c, "Revenue Share by Genre", "echarts_pie",
    ds["vw_revenue_by_genre"],
    {
      "metric": metric("revenue"),
      "groupby": ["genre"],
      "row_limit": 10,
      "color_scheme": "supersetColors",
      "show_labels": True
    })

upsert_dashboard(s, t, c, "Inventory Analytics",
    [inv_table, stock_res, inv_turn, rev_genre, stock_status, rev_share_genre])
```

### File changed
`infra/superset/bootstrap-job.yaml`

---

## Issue 10 — Keycloak Realm Missing `profile` and `email` Client Scopes

### Where it broke
The `auth.setup.ts` Playwright fixture that logs in as `user1` via Keycloak OIDC.

### Symptom
```
Error: Invalid scopes: openid profile email roles
```
Keycloak rejected the authorization code request because the `profile` and `email`
scopes were not defined in the realm.

### Root Cause
The original `realm-export.json` only defined the `roles` client scope in
`clientScopes`. Keycloak's import process creates scopes exactly as listed. The
`profile` and `email` scopes (which are standard OIDC built-ins) were not present
because they were not included in the import file.

### Fix applied
Added `profile` and `email` to both `clientScopes` (with protocol mappers) and to the
`ui-client`'s `defaultClientScopes` list in `realm-export.json`:

```json
"clients": [{
  "clientId": "ui-client",
  "defaultClientScopes": ["openid", "profile", "email", "roles"]
}],
"clientScopes": [
  { "name": "roles", ... },
  {
    "name": "profile",
    "protocolMappers": [
      { "name": "sub", "protocolMapper": "oidc-sub-mapper", ... },
      { "name": "preferred_username", "protocolMapper": "oidc-usermodel-attribute-mapper", ... }
    ]
  },
  {
    "name": "email",
    "protocolMappers": [
      { "name": "email", "protocolMapper": "oidc-usermodel-attribute-mapper", ... }
    ]
  }
]
```

> **Note**: This issue and Issue 6 (missing `sub` claim) share the same root cause:
> the realm import overrides Keycloak's built-in scopes. Both are fixed together in
> `realm-export.json`.

### File changed
`infra/keycloak/realm-export.json`

---

## Issue 11 — Superset Bootstrap Job ServiceAccount Race Condition

### Where it broke
`infra/superset/bootstrap-job.yaml` — the Kubernetes Job that runs the dashboard
bootstrap Python script.

### Symptom
```
$ kubectl get pod -n analytics -l job-name=superset-bootstrap
NAME                     READY   STATUS   RESTARTS
superset-bootstrap-xxx   0/1     Error    0

$ kubectl describe pod superset-bootstrap-xxx -n analytics
  Warning  Failed   ...  Error: container "bootstrap" is waiting to start:
  PodInitializing — pods "superset-bootstrap-sa" not found
```

### Root Cause
The `bootstrap-job.yaml` file defines both the `ServiceAccount` and the `Job` in the
same YAML file separated by `---`. When applied with `kubectl apply -f`, Kubernetes
applies resources in order but the Job pod can be scheduled before the ServiceAccount
is fully propagated. The Job referenced `serviceAccountName: superset-bootstrap-sa`
which did not yet exist.

### Fix applied
Deleted the stale/failed Job and re-applied the manifest (forcing the ServiceAccount
to be created first in a stable state):

```bash
kubectl delete job superset-bootstrap -n analytics --ignore-not-found
kubectl apply -f "${REPO_ROOT}/infra/superset/bootstrap-job.yaml"
kubectl wait --for=condition=complete job/superset-bootstrap -n analytics --timeout=300s
```

This is already the pattern in `scripts/up.sh` — the `kubectl delete job ... --ignore-not-found`
before `kubectl apply` ensures the Job always starts fresh.

### File changed
`scripts/up.sh` (the delete-before-apply pattern was already there; ensuring it runs
reliably is sufficient)

---

## Summary of All Changes

| # | Issue | File(s) changed |
|---|-------|-----------------|
| 1 | GatewayClass race condition | `infra/kgateway/install.sh` |
| 2 | Istio Gateway random NodePort | `scripts/up.sh` |
| 3 | Istio STRICT mTLS blocks NodePort | `infra/istio/security/peer-auth.yaml` |
| 4 | Debezium credentials Secret missing | `scripts/up.sh` |
| 5 | Kafka CDC topics not pre-created | `infra/kafka/kafka.yaml` |
| 6 | JWT missing `sub` claim → null user_id | `infra/keycloak/realm-export.json` |
| 7 | Analytics DDL applied after Flink / wrong `kubectl exec` | `scripts/up.sh` |
| 8 | verify-cdc.sh wrong column name | `scripts/verify-cdc.sh` |
| 9 | Superset bootstrap missing 2 pie charts | `infra/superset/bootstrap-job.yaml` |
| 10 | Keycloak missing profile/email scopes | `infra/keycloak/realm-export.json` |
| 11 | Superset Job ServiceAccount race | `scripts/up.sh` (pattern already there) |

---

## Post-Bootstrap Verification

After `up.sh --fresh --data` completes, run these checks in order:

### 1. All pods running
```bash
kubectl get pods -A | grep -Ev "Running|Completed"
# Should output nothing
```

### 2. External routes reachable
```bash
bash scripts/verify-routes.sh
# Expected: 8/8 checks pass
```

### 3. CDC pipeline working
```bash
bash scripts/verify-cdc.sh
# Expected: ✔ CDC verified: order appeared in analytics-db within Ns.
```

### 4. Smoke test
```bash
bash scripts/smoke-test.sh
# Expected: 23/23 checks pass
```

### 5. Full E2E regression
```bash
cd e2e
npx playwright test fixtures/auth.setup.ts --reporter=list  # refresh tokens first
npm run test
# Expected: 89 passed
```

---

## Keycloak Quick Diagnostics

If auth-related tests fail after a fresh import, decode the JWT to check claims:

```bash
# Get the stored session token
cat e2e/fixtures/user1-session.json | python3 -c "
import sys, json, base64
data = json.load(sys.stdin)
for k, v in data.items():
    token = json.loads(v).get('access_token', '')
    if token:
        payload = token.split('.')[1]
        payload += '=' * (4 - len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
        print('sub         :', claims.get('sub', 'MISSING ← problem!'))
        print('scope       :', claims.get('scope'))
        print('roles       :', claims.get('roles'))
        print('preferred_username:', claims.get('preferred_username', 'MISSING'))
    break
"
```

Expected output:
```
sub         : 0af1a940-2115-47d6-9e15-57b722e1775e
scope       : openid roles email profile
roles       : ['customer']
preferred_username: user1
```

If `sub` is `MISSING`, re-run `scripts/keycloak-import.sh` and then re-run the auth
fixture.
