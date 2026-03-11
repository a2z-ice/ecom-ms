# Step-by-Step mTLS Implementation Guide

This guide documents every issue encountered when implementing mTLS enforcement and synchronous
service-to-service communication in an Istio Ambient Mesh (ztunnel) environment. Each issue
includes: what it is, how to identify it, and the exact fix.

The end state: ecom-service calls inventory-service synchronously at checkout over mTLS;
external callers cannot reach the internal `/reserve` endpoint; databases are locked down
to their owning services; and all 45 E2E tests pass.

---

## Architecture Overview

```
External user / browser
  → Istio Gateway pod (in infra namespace)
      → ui-service:80 (nginx, ecom namespace)
          → ecom-service:8080 (Spring Boot, ecom namespace) ← JWT checked here
              → inventory-service:8000 (FastAPI, inventory namespace) ← mTLS pod-to-pod
```

All pod-to-pod traffic passes through **ztunnel** (Istio Ambient Mesh DaemonSet).
ztunnel intercepts traffic transparently and wraps it in **HBONE** (HTTP-Based Overlay
Network, port 15008) for encrypted mTLS transport between nodes.

SPIFFE identity format: `cluster.local/ns/<namespace>/sa/<serviceaccount>`

---

## Issue 1 — L7 AuthorizationPolicies Are Silently Ignored by ztunnel

### What happened

The initial `AuthorizationPolicy` used HTTP-level attributes:

```yaml
# BROKEN — ztunnel cannot enforce these
rules:
  - from:
      - source:
          principals: ["cluster.local/ns/ecom/sa/ecom-service"]
    to:
      - operation:
          methods: ["POST"]
          paths: ["/inven/stock/reserve"]
```

Both `ecom-service` and `inventory-service` returned **503** immediately after applying
these policies.

### Why it happens

Istio Ambient Mesh uses **ztunnel** as the L4 proxy. ztunnel operates at TCP level and
**cannot inspect HTTP attributes** (methods, paths, headers, request principals from JWT).
L7 enforcement requires a **waypoint proxy** (an Envoy sidecar deployed per service/namespace).

When you write an `AuthorizationPolicy` `ALLOW` rule that contains L7 attributes and there
is no waypoint proxy, ztunnel **silently omits that rule**. With all rules omitted, the
policy becomes an implicit deny-all — every connection is rejected.

### How to identify it

Check the ztunnel status on the policy:

```bash
kubectl get authorizationpolicy inventory-service-policy -n inventory -o yaml
```

Look for a `status` block like this:

```yaml
status:
  conditions:
    - message: >-
        ztunnel does not support HTTP attributes, i.e. attributes other than source namespace
        and source principal within source selector, and destination port within destination
        selector. Within an ALLOW policy, rules matching HTTP attributes are omitted.
        This will be more restrictive than requested.
      reason: UnsupportedValue
      type: Accepted
```

That message is the definitive indicator. Also check ztunnel logs:

```bash
# Find which node the affected pod is on
kubectl get pod -n inventory -l app=inventory-service -o wide

# Check ztunnel on that node for RBAC deny logs
kubectl logs -n istio-system -l app=ztunnel --field-selector spec.nodeName=<node> | grep -i "rbac\|deny\|DENIED"
```

### The fix

Rewrite all `AuthorizationPolicy` rules to **L4-only** (namespace and SPIFFE principal only —
no `to.operation.methods`, no `to.operation.paths`, no `source.requestPrincipals`):

```yaml
# CORRECT — L4 only, ztunnel can enforce this
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: inventory-service-policy
  namespace: inventory
spec:
  selector:
    matchLabels:
      app: inventory-service
  rules:
    # Istio gateway (external traffic) — infra namespace
    - from:
        - source:
            namespaces: ["infra"]
    # ecom-service mTLS call + ui-service nginx proxy — both in ecom namespace
    - from:
        - source:
            namespaces: ["ecom"]
```

L7 separation (blocking external POST to `/reserve`) is achieved at the **HTTPRoute level**
instead — only GET rules are exposed externally (see Issue 3 below).

### Key principle

With Istio Ambient and no waypoint proxy:
- **L4 enforcement**: ztunnel handles namespace and SPIFFE principal checks
- **L7 enforcement**: done at the gateway (HTTPRoute rules) or in application code (JWT, Spring Security)

---

## Issue 2 — Wrong Gateway Namespace in NetworkPolicies and AuthorizationPolicies

### What happened

Initial policies used `namespaces: ["kgateway-system"]` to allow gateway traffic.
All requests were still denied even after fixing the L7 issue.

### Why it happens

The cluster uses `gatewayClassName: istio` with the `Gateway` resource defined in the
`infra` namespace. When using `gatewayClassName: istio`, Istio creates the gateway
**Deployment/Pod in the same namespace as the `Gateway` resource** — not in a separate
gateway system namespace.

Verify where the gateway pod actually lives:

```bash
kubectl get pods -n infra | grep gateway
# bookstore-gateway-istio-dd88ff7dc-mbpr2   1/1   Running
```

```bash
kubectl get pod -n infra bookstore-gateway-istio-dd88ff7dc-mbpr2 \
  -o jsonpath='{.spec.serviceAccountName}'
# bookstore-gateway-istio  (in infra namespace)
```

The SPIFFE identity for gateway traffic is therefore:
`cluster.local/ns/infra/sa/bookstore-gateway-istio`

### How to identify it

```bash
# Check where the gateway pod is
kubectl get pods -A | grep gateway-istio

# Check which namespace the Gateway resource is in
kubectl get gateway -A
# NAME                 CLASS   ADDRESS   PROGRAMMED   AGE
# bookstore-gateway    istio   ...       True         ...
# NAMESPACE: infra ← this determines where the pod runs
```

```bash
# Confirm the service account on the pod
kubectl get pod -n <gateway-pod-namespace> <gateway-pod-name> \
  -o jsonpath='{.spec.serviceAccountName}'
```

### The fix

Replace every `kgateway-system` with `infra` in NetworkPolicies and AuthorizationPolicies:

```yaml
# In NetworkPolicies
- from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: infra   # NOT kgateway-system

# In AuthorizationPolicies
- from:
    - source:
        namespaces: ["infra"]                  # NOT kgateway-system
```

---

## Issue 3 — `/reserve` Endpoint Must Be Blocked Externally Without Waypoint Proxy

### What happened

The plan was to use an Istio `AuthorizationPolicy` to return 403 for external POST to
`/inven/stock/reserve`. But ztunnel cannot enforce the `methods: ["POST"]` rule.
The endpoint would have been accessible externally.

### The solution: HTTPRoute-level enforcement

Since ztunnel cannot filter by HTTP method or path, the correct approach is to **not
expose the endpoint at all** through the gateway. The `inven-route.yaml` HTTPRoute
only has rules for the public read endpoints:

```yaml
# infra/kgateway/routes/inven-route.yaml
rules:
  # Public stock read — GET only
  - matches:
      - path:
          type: PathPrefix
          value: /inven/stock
        method: GET
    backendRefs:
      - name: inventory-service
        namespace: inventory
        port: 8000
  # Health endpoint — GET only
  - matches:
      - path:
          type: Exact
          value: /inven/health
        method: GET
    backendRefs:
      - name: inventory-service
        namespace: inventory
        port: 8000
```

`POST /inven/stock/reserve` has **no matching rule** — the gateway returns **404**.

ecom-service calls this endpoint **pod-to-pod**, bypassing the gateway entirely.
ztunnel wraps that pod-to-pod connection in HBONE mTLS, using the ecom-service
SPIFFE identity as the client certificate.

### How to verify external blocking

```bash
# Should return 404 (no matching HTTPRoute rule)
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://api.service.net:30000/inven/stock/reserve \
  -H "Content-Type: application/json" \
  -d '{"book_id":"00000000-0000-0000-0000-000000000001","quantity":1}'
# 404
```

---

## Issue 4 — NetworkPolicy `default-deny-all` Blocked ztunnel HBONE Traffic (Port 15008)

### What happened

After adding `default-deny-all` NetworkPolicies to namespaces, all services became
unreachable — including connections that had explicit allow rules. Connections
timed out rather than being rejected immediately.

### Why it happens

Istio Ambient Mesh uses **HBONE** (HTTP-Based Overlay Network) on port 15008 for
inter-pod encrypted transport. When pod A calls pod B, ztunnel does not make a
direct TCP connection on the destination's application port. Instead:

1. ztunnel on pod A's node opens a connection to ztunnel on pod B's node **on port 15008**
2. The connection is wrapped in HTTP CONNECT tunneling
3. mTLS is established inside the tunnel

**If port 15008 is blocked by a NetworkPolicy egress rule, ztunnel cannot establish the
tunnel, and ALL outbound connections from that pod fail — even those with explicit allow rules
for the application port.**

### How to identify it

```bash
# Test direct connectivity via wget from inside the pod (bypasses ztunnel)
kubectl exec -n ecom deployment/ecom-service -- \
  wget -qO- --timeout=5 http://inventory-service.inventory.svc.cluster.local:8000/inven/health

# If that works but normal connections time out, HBONE is likely blocked
```

```bash
# Check ztunnel logs for tunnel establishment errors
kubectl logs -n istio-system -l app=ztunnel | grep -i "15008\|hbone\|tunnel\|connect"
```

```bash
# Confirm which NetworkPolicies apply to the pod
kubectl get networkpolicy -n ecom
# Then describe each to check egress rules
kubectl describe networkpolicy allow-gateway-to-ecom -n ecom
```

### The fix

Every NetworkPolicy that has egress rules **must include port 15008**:

```yaml
egress:
  # Istio Ambient Mesh HBONE — ztunnel uses port 15008 for inter-pod mTLS tunneling.
  # Without this rule, ztunnel cannot establish encrypted tunnels to any destination
  # and all connections time out.
  - to: []
    ports:
      - port: 15008
  # DNS — required for service discovery
  - to: []
    ports:
      - port: 53
        protocol: UDP
```

The `to: []` with no selector means "to any destination" — this is intentional because
the ztunnel-to-ztunnel connection goes to the remote node IP, not the destination pod IP.

---

## Issue 5 — `default-deny-all` Caused 504 Gateway Timeout on UI

### What happened

After applying NetworkPolicies to the `ecom` namespace, the UI returned
`504 Gateway Time-out` on every page load. The gateway could not reach ui-service.

### Why it happens

`default-deny-all` with `podSelector: {}` applies to **all pods in the namespace**,
including `ui-service`. There was no NetworkPolicy allowing ingress to ui-service from
the gateway, and no egress policy allowing ui-service to proxy API calls to the backends.

Multiple missing allow rules caused cascading failures:

1. No ingress rule: gateway → ui-service (→ 504)
2. No egress rule: ui-service → ecom-service (nginx proxy for `/ecom/*` calls)
3. No egress rule: ui-service → inventory-service (nginx proxy for `/inven/*` calls)
4. No ingress rule to ecom-service from ui-service (ecom-service policy only allowed infra)

### How to identify it

```bash
# Check if UI pod is receiving any traffic
kubectl logs -n ecom deployment/ui-service -c ui-service | tail -20
# Complete silence = blocked at NetworkPolicy level (no connections reaching nginx)

# Test gateway → ui-service connectivity
kubectl exec -n infra deployment/bookstore-gateway-istio -- \
  curl -s -o /dev/null -w "%{http_code}" http://ui-service.ecom.svc.cluster.local:80
# Hangs or returns 000 = NetworkPolicy blocking

# Check which policies exist in the namespace
kubectl get networkpolicy -n ecom
# If you see default-deny-all but no allow-gateway-to-ui, that's the problem
```

### The fix

Add a dedicated NetworkPolicy for ui-service with ingress from gateway and
egress to both backend services:

```yaml
# infra/kubernetes/network-policies/ecom-netpol.yaml
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-gateway-to-ui
  namespace: ecom
spec:
  podSelector:
    matchLabels:
      app: ui-service
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: infra   # gateway pod
  egress:
    # nginx proxy → ecom-service (same namespace)
    - to:
        - podSelector:
            matchLabels:
              app: ecom-service
      ports:
        - port: 8080
    # nginx proxy → inventory-service (different namespace)
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: inventory
      ports:
        - port: 8000
    # HBONE tunneling (Istio Ambient)
    - to: []
      ports:
        - port: 15008
    # DNS
    - to: []
      ports:
        - port: 53
          protocol: UDP
```

Also add an ingress rule for ui-service to the ecom-service NetworkPolicy, since
ui-service's nginx proxy calls ecom-service from the `ecom` namespace:

```yaml
# In allow-gateway-to-ecom NetworkPolicy
ingress:
  - from:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: infra    # gateway
  - from:
      - podSelector:
          matchLabels:
            app: ui-service                        # nginx proxy (same namespace)
  - from:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: observability  # Prometheus scraping
```

### Key rule about NetworkPolicy

NetworkPolicy rules are **additive (OR logic)**. Each separate policy adds more
allow rules on top. `default-deny-all` is just the starting baseline — every
subsequent policy grants additional access.

---

## Issue 6 — Java RestClient Sent HTTP/2 Upgrade Headers, Breaking FastAPI

### What happened

ecom-service could reach inventory-service (503 was gone), but checkout still failed
with HTTP 400 ("Invalid HTTP request received") or HTTP 422 with null body.
Manual `wget` from inside the ecom-service pod worked fine.

### Why it happens

Spring Boot 4.0's `RestClient` defaults to `JdkClientHttpRequestFactory` backed by
Java's `HttpClient`. Java's `HttpClient` may send HTTP/2 cleartext upgrade headers
on plain HTTP connections:

```
Connection: Upgrade, HTTP2-Settings
Upgrade: h2c
HTTP2-Settings: <base64 encoded h2 settings>
```

Starlette/uvicorn (FastAPI's ASGI server) uses `h11` as its HTTP/1.1 parser. The h11
parser treats these upgrade headers as an invalid HTTP/1.1 request and returns:

```
400 Invalid HTTP request received.
```

Occasionally the connection would succeed but the body would be null (422 Unprocessable
Entity from FastAPI's Pydantic validation), likely due to race conditions in the upgrade
negotiation.

### How to identify it

Check inventory-service logs when a checkout is attempted:

```bash
kubectl logs -n inventory deployment/inventory-service | tail -20
# Expected: INFO:     10.244.x.x - "POST /inven/stock/reserve HTTP/1.1" 200 OK
# Broken:   ERROR:    Invalid HTTP request received.
#           INFO:     10.244.x.x - "POST /inven/stock/reserve HTTP/1.1" 400 Bad Request
```

Test manually from inside the ecom-service pod using wget (which sends pure HTTP/1.1):

```bash
kubectl exec -n ecom deployment/ecom-service -- \
  wget -qO- \
  --post-data='{"book_id":"00000000-0000-0000-0000-000000000001","quantity":1}' \
  --header='Content-Type: application/json' \
  http://inventory-service.inventory.svc.cluster.local:8000/inven/stock/reserve
# {"book_id":"...","quantity_reserved":1,"remaining_available":9}
# If this works but RestClient fails, the Java HTTP/2 upgrade is the issue
```

Check exact headers being sent:

```bash
# Run a debug request capturing headers (e.g., via httpbin in-cluster or tcpdump on inventory pod)
kubectl exec -n inventory deployment/inventory-service -- \
  python3 -c "
import socket
s = socket.socket()
s.bind(('', 9999))
s.listen(1)
conn, _ = s.accept()
print(conn.recv(4096).decode())
"
# From another terminal, make a RestClient call and capture the raw headers
```

### The fix

Force HTTP/1.1 explicitly in `RestClientConfig.java`:

```java
// ecom-service/src/main/java/com/bookstore/ecom/config/RestClientConfig.java
@Bean
public RestClient inventoryRestClient(@Value("${INVENTORY_SERVICE_URL}") String baseUrl) {
    // Force HTTP/1.1 to avoid h2c upgrade headers that Starlette/uvicorn's h11 parser rejects.
    // Java's default HttpClient may send Connection:Upgrade/Upgrade:h2c which cause
    // "400 Invalid HTTP request received" from FastAPI on plain HTTP.
    var httpClient = HttpClient.newBuilder()
        .version(HttpClient.Version.HTTP_1_1)
        .build();
    return RestClient.builder()
        .baseUrl(baseUrl)
        .requestFactory(new JdkClientHttpRequestFactory(httpClient))
        .build();
}
```

---

## Issue 7 — JWT Guard on `/reserve` Must Be Removed

### What happened

The original `/reserve` endpoint in `inventory-service/app/api/stock.py` required an
`admin` role JWT:

```python
@router.post("/reserve", response_model=ReserveResponse)
async def reserve_stock(
    request: ReserveRequest,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_role("admin")),   # ← blocks mTLS-only calls
):
```

ecom-service's mTLS calls had no JWT (they are service-to-service, no user token).
The endpoint returned 401/403 for all internal calls.

### Why it happens

JWT middleware (`require_role`) reads an `Authorization: Bearer <token>` header.
Service-to-service mTLS calls from ecom-service carry **no JWT** — their identity
is established by the mTLS certificate (SPIFFE principal), not a JWT.
You cannot have both JWT and mTLS required on the same endpoint unless the calling
service obtains a service account token (not done here).

### The fix

Remove the JWT dependency from `/reserve`. Authorization is now enforced entirely
by the Istio `AuthorizationPolicy` (L4 namespace check) + HTTPRoute (endpoint not exposed
externally) + NetworkPolicy (only ecom namespace pods can reach port 8000):

```python
@router.post("/reserve", response_model=ReserveResponse)
async def reserve_stock(
    request: ReserveRequest,
    db: AsyncSession = Depends(get_db),
    # Authorization enforced by Istio mTLS: only ecom namespace (ecom-service SA)
    # may call this endpoint. The endpoint is not exposed via the gateway HTTPRoute.
):
```

---

## Issue 8 — ServiceAccount Identity Mismatch

### What happened

The original `AuthorizationPolicy` referenced SPIFFE principal
`cluster.local/ns/ecom/sa/ecom-service`, but both Deployments used the `default`
ServiceAccount. The actual principal was `cluster.local/ns/ecom/sa/default`.
The rule never matched any real request.

### How to identify it

```bash
# Check which ServiceAccount the Deployment uses
kubectl get pod -n ecom -l app=ecom-service -o jsonpath='{.items[0].spec.serviceAccountName}'
# default  ← not ecom-service

# See the actual SPIFFE identity presented
kubectl exec -n ecom deployment/ecom-service -- \
  cat /var/run/secrets/kubernetes.io/serviceaccount/namespace
# ecom
# Principal would be: cluster.local/ns/ecom/sa/default
```

### The fix

Create named ServiceAccounts and assign them in the Deployments:

```yaml
# infra/istio/security/serviceaccounts.yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ecom-service
  namespace: ecom
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: inventory-service
  namespace: inventory
```

```yaml
# ecom-service/k8s/ecom-service.yaml — spec.template.spec
serviceAccountName: ecom-service
```

```yaml
# inventory-service/k8s/inventory-service.yaml — spec.template.spec
serviceAccountName: inventory-service
```

After the rollout, verify:

```bash
kubectl get pod -n ecom -l app=ecom-service -o jsonpath='{.items[0].spec.serviceAccountName}'
# ecom-service  ✓
```

---

## Summary: Complete Policy Configuration

### AuthorizationPolicy rules (L4-only, namespace-based)

| Policy | Namespace | Allows from |
|--------|-----------|-------------|
| `ecom-service-policy` | ecom | infra (gateway), ecom (ui-service), observability (Prometheus) |
| `inventory-service-policy` | inventory | infra (gateway), ecom (ecom-service + ui-service) |
| `ecom-db-policy` | ecom | ecom (ecom-service), infra (Debezium) |
| `inventory-db-policy` | inventory | inventory (inventory-service), infra (Debezium) |
| `keycloak-db-policy` | identity | identity (Keycloak) |

### NetworkPolicy egress rules

Every pod that makes outbound connections needs these in its egress:
- **Port 15008** (HBONE/ztunnel tunneling) — `to: []` (any destination)
- **Port 53 UDP** (DNS) — `to: []`
- Specific application ports per destination service

### HTTPRoute L7 filtering

```
GET  /inven/stock/{book_id}  → exposed (public)
GET  /inven/health           → exposed (public)
POST /inven/stock/reserve    → NOT exposed (internal-only, ecom-service calls pod-to-pod)
```

---

## Manual mTLS Testing Procedures

### 1. Verify mTLS is active between namespaces

```bash
# Check PeerAuthentication (should be STRICT in all service namespaces)
kubectl get peerauthentication -A
# NAME            MODE    AGE
# ecom-mtls       STRICT  ...   (namespace: ecom)
# inventory-mtls  STRICT  ...   (namespace: inventory)

# Check ztunnel is running on all nodes
kubectl get pods -n istio-system -l app=ztunnel
# Should have one ztunnel pod per node (DaemonSet)
```

### 2. Verify SPIFFE certificate identity

```bash
# Get the actual principal ecom-service presents to inventory-service
kubectl exec -n ecom deployment/ecom-service -- \
  cat /var/run/secrets/kubernetes.io/serviceaccount/namespace
# ecom

# List the cert files injected by Istio
kubectl exec -n ecom deployment/ecom-service -- ls /var/run/secrets/istio/
# ca-certificates.crt  cert-chain.pem  key.pem  root-cert.pem

# Decode the certificate and check the SPIFFE URI in SAN
kubectl exec -n ecom deployment/ecom-service -- \
  openssl x509 -in /var/run/secrets/istio/cert-chain.pem -noout -text \
  | grep -A1 "Subject Alternative Name"
# URI:spiffe://cluster.local/ns/ecom/sa/ecom-service
```

### 3. Test that the internal `/reserve` endpoint is NOT reachable from outside

```bash
# External request — should return 404 (no HTTPRoute rule for POST /reserve)
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://api.service.net:30000/inven/stock/reserve \
  -H "Content-Type: application/json" \
  -d '{"book_id":"00000000-0000-0000-0000-000000000001","quantity":1}'
# Expected: 404

# External GET to /stock — should return 200 (public endpoint)
curl -s -o /dev/null -w "%{http_code}" \
  http://api.service.net:30000/inven/stock/00000000-0000-0000-0000-000000000001
# Expected: 200
```

### 4. Test that ecom-service CAN reach inventory-service via mTLS (pod-to-pod)

```bash
# From ecom-service pod, call /reserve directly (bypasses gateway)
kubectl exec -n ecom deployment/ecom-service -- \
  wget -qO- \
  --post-data='{"book_id":"00000000-0000-0000-0000-000000000001","quantity":1}' \
  --header='Content-Type: application/json' \
  http://inventory-service.inventory.svc.cluster.local:8000/inven/stock/reserve
# Expected: {"book_id":"...","quantity_reserved":1,"remaining_available":N}
```

### 5. Test that an unauthorized pod CANNOT reach inventory-service's /reserve

```bash
# Spawn a test pod in a namespace that is NOT ecom
kubectl run test-pod --image=alpine --restart=Never -n default -- sleep 3600
kubectl exec -n default test-pod -- \
  wget -qO- --timeout=5 \
  --post-data='{"book_id":"00000000-0000-0000-0000-000000000001","quantity":1}' \
  --header='Content-Type: application/json' \
  http://inventory-service.inventory.svc.cluster.local:8000/inven/stock/reserve
# Expected: timeout or connection refused (blocked by AuthorizationPolicy + NetworkPolicy)
kubectl delete pod test-pod -n default
```

### 6. Observe live mTLS traffic in Kiali

```bash
# Open Kiali at http://localhost:32100/kiali
# Navigate to: Graph → Namespace: inventory
# Expand the inventory-service node
# Click the edge between ecom-service and inventory-service
# Look for: mTLS icon (padlock), TCP metrics
```

### 7. Check ztunnel logs for mTLS connection events

```bash
# Watch ztunnel on the inventory-service node during a checkout
kubectl get pod -n inventory -l app=inventory-service -o wide
# Note the NODE column

# Get ztunnel on that node
ZTUNNEL=$(kubectl get pod -n istio-system -l app=ztunnel \
  --field-selector spec.nodeName=<NODE> -o jsonpath='{.items[0].metadata.name}')

# Watch for HBONE connections during checkout
kubectl logs -n istio-system $ZTUNNEL -f | grep -i "hbone\|15008\|reserve\|ecom"
```

### 8. Confirm all E2E tests pass

```bash
cd e2e
npm run test
# Expected: 45/45 passing
# mtls-enforcement.spec.ts covers:
#   - External POST /reserve → 404
#   - Checkout without JWT → 401
#   - Full checkout via mTLS → order confirmed
#   - Stock reserved count increases after checkout
```

---

## Deployment Order

When applying all changes from scratch, follow this order to avoid race conditions:

```bash
# 1. ServiceAccounts first (pods need them on startup)
kubectl apply -f infra/istio/security/serviceaccounts.yaml

# 2. NetworkPolicies
kubectl apply -f infra/kubernetes/network-policies/ecom-netpol.yaml
kubectl apply -f infra/kubernetes/network-policies/inventory-netpol.yaml

# 3. AuthorizationPolicies
kubectl apply -f infra/istio/security/authz-policies/

# 4. HTTPRoutes (update to restrict POST /reserve)
kubectl apply -f infra/kgateway/routes/inven-route.yaml

# 5. Deploy updated service images
kubectl apply -f ecom-service/k8s/ecom-service.yaml
kubectl apply -f inventory-service/k8s/inventory-service.yaml

# 6. Restart to pick up new ServiceAccount + env vars
kubectl rollout restart deployment/ecom-service -n ecom
kubectl rollout restart deployment/inventory-service -n inventory

# 7. Wait for rollout
kubectl rollout status deployment/ecom-service -n ecom --timeout=90s
kubectl rollout status deployment/inventory-service -n inventory --timeout=60s

# 8. Run smoke test
curl -s http://api.service.net:30000/ecom/health
curl -s http://api.service.net:30000/inven/health

# 9. Run all E2E tests
cd e2e && npm run test
```

---

## Quick Diagnosis Checklist

If services return unexpected status codes after applying policies:

| Symptom | Likely cause | Check command |
|---------|-------------|---------------|
| 503 after applying AuthzPolicy | L7 attributes in ztunnel policy | `kubectl get authorizationpolicy <name> -n <ns> -o yaml` → look for `UnsupportedValue` status |
| 504 on UI | Missing NetworkPolicy for ui-service | `kubectl get networkpolicy -n ecom` — check for `allow-gateway-to-ui` |
| Timeout on ecom→inventory | HBONE port 15008 blocked | `kubectl describe networkpolicy -n ecom` — check egress for port 15008 |
| 400 from inventory-service | Java HTTP/2 upgrade headers | Check inventory logs: `Invalid HTTP request received` |
| 401 on `/reserve` from ecom | JWT guard still in place | Check `inventory-service/app/api/stock.py` for `require_role` |
| AuthzPolicy principal never matches | Wrong ServiceAccount | `kubectl get pod -n <ns> -l app=<svc> -o jsonpath='{.items[0].spec.serviceAccountName}'` |
| External POST /reserve returns 200 | HTTPRoute missing method filter | `kubectl get httproute inven-route -n inventory -o yaml` — verify `method: GET` |
