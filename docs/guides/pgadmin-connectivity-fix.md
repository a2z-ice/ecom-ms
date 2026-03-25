# PgAdmin Database Connectivity -- Root Cause Analysis and Fix

**How AuthorizationPolicy + NetworkPolicy blocked PgAdmin, and the systematic debugging process**

---

## 1. The Problem

PgAdmin at `http://localhost:31111` was fully functional at the web UI level:

- Login worked (admin@bookstore.dev / CHANGE_ME)
- The "BookStore" server group showed all 4 pre-configured servers
- The UI rendered correctly with no JavaScript errors

But clicking any server to establish a database connection failed immediately:

```
connection to server at "ecom-db-rw.ecom.svc.cluster.local" (10.96.x.x), port 5432 failed:
  server closed the connection unexpectedly
  This probably means the server terminated abnormally before or while processing the request.
```

At the wire protocol level, the error was:

```
[Errno 104] Connection reset by peer
```

This happened for all 4 databases: ecom-db, inventory-db, analytics-db, and keycloak-db.

---

## 2. Initial Misdiagnosis (What We Thought)

Several wrong theories were investigated and ruled out before reaching the root cause.

### Theory 1: Istio Ambient ztunnel Breaks PostgreSQL L4

**Hypothesis:** ztunnel's HBONE tunneling corrupts or interferes with PostgreSQL's binary wire protocol (which starts with an SSLRequest or StartupMessage).

**Why it was wrong:** Debezium Server runs in the `infra` namespace and connects cross-namespace to `ecom-db-rw.ecom.svc.cluster.local` on port 5432. Debezium uses the same PostgreSQL wire protocol and it works perfectly through ztunnel. If ztunnel broke PostgreSQL L4 traffic, Debezium would also fail.

### Theory 2: portLevelMtls PERMISSIVE Needed

**Hypothesis:** The PostgreSQL port needs `portLevelMtls: PERMISSIVE` in the PeerAuthentication because PgAdmin sends plaintext and ztunnel expects mTLS.

**Why it was wrong:** ztunnel handles mTLS transparently for ambient-to-ambient connections. Both the source pod (PgAdmin) and the destination pod (PostgreSQL) are in ambient mesh namespaces. The ztunnel on PgAdmin's node wraps traffic in HBONE mTLS, and the ztunnel on the DB's node unwraps it. The application sees plaintext in both directions. No `PERMISSIVE` override is needed.

### Theory 3: PgAdmin Must Be Outside the Mesh

**Hypothesis:** Remove `istio.io/dataplane-mode=ambient` from admin-tools so PgAdmin traffic bypasses ztunnel entirely.

**Why it was wrong:** This made things WORSE. When PgAdmin is outside the mesh, its traffic arrives at the DB's ztunnel as non-HBONE plaintext. But the DB namespace has `mtls.mode: STRICT`, so ztunnel on the DB side rejects the non-HBONE inbound connection. Being inside the mesh is required, not optional.

### Theory 4: SSLRequest Causes the Reset

**Hypothesis:** PgAdmin sends an SSLRequest packet first (4 bytes: `\x00\x00\x00\x08\x04\xd2\x16\x2f`), and ztunnel misinterprets this as a protocol error.

**Why it was partially wrong:** While PgAdmin does send an SSLRequest, this is standard PostgreSQL behavior. Even sending a direct StartupMessage (skipping SSLRequest) resulted in the same connection reset. The reset came before any application-layer protocol exchange -- it was at the ztunnel RBAC layer.

### Theory 5: NodePort Bypass Needed

**Hypothesis:** Expose PostgreSQL directly via NodePort to bypass ztunnel entirely.

**Why it was wrong:** NodePorts do not bypass ztunnel when the destination pod is in the ambient mesh. The traffic still flows through the node's ztunnel process. And even if it did bypass, this would be a massive security hole -- exposing database ports directly on the host.

---

## 3. The Breakthrough

The key observation that cracked the case:

> Debezium Server (in the `infra` namespace) connects cross-namespace to ecom-db and it **works**. PgAdmin (in the `admin-tools` namespace) connects cross-namespace to ecom-db and it **fails**. If ztunnel itself was the problem, Debezium would also fail. So ztunnel is NOT the issue.

This shifted the investigation from "is ztunnel breaking the protocol?" to "what is different about admin-tools vs infra?"

The answer: the AuthorizationPolicy and NetworkPolicy on the database pods explicitly allow `infra` but do NOT mention `admin-tools`.

---

## 4. Root Cause (With Evidence)

Two security policies blocked PgAdmin's traffic. Both must allow a connection for it to succeed.

### AuthorizationPolicy

Each database namespace has an AuthorizationPolicy that restricts which namespaces can connect. Example from the `ecom` namespace:

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: ecom-db-policy
  namespace: ecom
spec:
  selector:
    matchLabels:
      cnpg.io/cluster: ecom-db
  rules:
  - from:
    - source:
        namespaces: [ecom]          # ecom-service
  - from:
    - source:
        namespaces: [infra]         # Debezium
  - from:
    - source:
        namespaces: [cnpg-system]   # CNPG operator
  # admin-tools NOT listed -- PgAdmin BLOCKED
```

When ztunnel processes an inbound connection to the ecom-db pod, it checks the source's SPIFFE identity. PgAdmin's identity is `spiffe://cluster.local/ns/admin-tools/sa/pgadmin`. Since `admin-tools` is not in the allowed namespaces list, ztunnel sends a TCP RST -- which appears as "Connection reset by peer" at the application level.

### NetworkPolicy

Each database namespace also has a Kubernetes NetworkPolicy that restricts ingress at the CNI level:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ecom-db-policy
  namespace: ecom
spec:
  podSelector:
    matchLabels:
      cnpg.io/cluster: ecom-db
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: ecom-service               # ecom-service allowed
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: infra      # Debezium allowed
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: cnpg-system  # CNPG allowed
  # admin-tools NOT listed -- PgAdmin BLOCKED
```

The same pattern existed for all 4 database namespaces: `ecom`, `inventory`, `analytics`, and `identity`.

---

## 5. The Fix

### Step 1: Ensure admin-tools Is in the Ambient Mesh

PgAdmin's namespace must be labeled for Istio ambient mode so ztunnel wraps its traffic in HBONE mTLS. Without this, the DB-side ztunnel rejects the connection as non-mTLS.

```bash
kubectl label namespace admin-tools istio.io/dataplane-mode=ambient --overwrite
```

### Step 2: Update AuthorizationPolicy for Each DB Namespace

Add `admin-tools` to the allowed namespaces in each database's AuthorizationPolicy:

```bash
# ecom namespace
kubectl -n ecom patch authorizationpolicy ecom-db-policy --type=json \
  -p '[{"op":"add","path":"/spec/rules/-","value":{"from":[{"source":{"namespaces":["admin-tools"]}}]}}]'

# inventory namespace
kubectl -n inventory patch authorizationpolicy inventory-db-policy --type=json \
  -p '[{"op":"add","path":"/spec/rules/-","value":{"from":[{"source":{"namespaces":["admin-tools"]}}]}}]'

# analytics namespace
kubectl -n analytics patch authorizationpolicy analytics-db-policy --type=json \
  -p '[{"op":"add","path":"/spec/rules/-","value":{"from":[{"source":{"namespaces":["admin-tools"]}}]}}]'

# identity namespace
kubectl -n identity patch authorizationpolicy keycloak-db-policy --type=json \
  -p '[{"op":"add","path":"/spec/rules/-","value":{"from":[{"source":{"namespaces":["admin-tools"]}}]}}]'
```

### Step 3: Update NetworkPolicy for Each DB Namespace

Add `admin-tools` to the allowed namespaces in each database's NetworkPolicy:

```bash
# ecom namespace
kubectl -n ecom patch networkpolicy ecom-db-policy --type=json \
  -p '[{"op":"add","path":"/spec/ingress/-","value":{"from":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"admin-tools"}}}]}}]'

# inventory namespace
kubectl -n inventory patch networkpolicy inventory-db-policy --type=json \
  -p '[{"op":"add","path":"/spec/ingress/-","value":{"from":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"admin-tools"}}}]}}]'

# analytics namespace
kubectl -n analytics patch networkpolicy analytics-db-policy --type=json \
  -p '[{"op":"add","path":"/spec/ingress/-","value":{"from":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"admin-tools"}}}]}}]'

# identity namespace
kubectl -n identity patch networkpolicy keycloak-db-policy --type=json \
  -p '[{"op":"add","path":"/spec/ingress/-","value":{"from":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"admin-tools"}}}]}}]'
```

---

## 6. Verification

After applying the fix, a Python wire-protocol test confirmed connectivity to all 4 databases:

```
ecom-db-rw.ecom.svc:        SUCCESS (SSL=True, auth=10)
inventory-db-rw.inventory.svc:   SUCCESS (SSL=True, auth=10)
analytics-db-rw.analytics.svc:   SUCCESS (SSL=True, auth=10)
keycloak-db-rw.identity.svc:     SUCCESS (SSL=True, auth=10)
```

- **SSL=True** -- the connection uses TLS 1.3 between PgAdmin and PostgreSQL (application-level encryption on top of ztunnel mTLS)
- **auth=10** -- SASL/SCRAM-SHA-256 authentication (the most secure PostgreSQL authentication method, defined in the PostgreSQL wire protocol as AuthenticationSASL = 10)

PgAdmin UI verification:
1. Logged in at `http://localhost:31111`
2. Expanded "BookStore" server group
3. Clicked each of the 4 servers -- all connected successfully
4. Ran `SELECT version();` on each -- all returned PostgreSQL 17.x

---

## 7. Comparison Table -- Why Each Service Works

| Service | Namespace | Target DB | AuthzPolicy | NetworkPolicy | Result |
|---------|-----------|-----------|-------------|---------------|--------|
| ecom-service | ecom | ecom-db | ecom allowed | ecom pods allowed | WORKS |
| inventory-service | inventory | inventory-db | inventory allowed | inventory pods allowed | WORKS |
| debezium-ecom | infra | ecom-db | infra allowed | infra ns allowed | WORKS |
| debezium-inventory | infra | inventory-db | infra allowed | infra ns allowed | WORKS |
| flink-jobmanager | analytics | analytics-db | analytics allowed | analytics pods allowed | WORKS |
| superset | analytics | analytics-db | analytics allowed | analytics pods allowed | WORKS |
| keycloak | identity | keycloak-db | identity allowed | identity pods allowed | WORKS |
| cnpg-operator | cnpg-system | all 4 DBs | cnpg-system allowed | cnpg-system ns allowed | WORKS |
| **pgadmin (before fix)** | **admin-tools** | **all 4 DBs** | **NOT allowed** | **NOT allowed** | **BLOCKED** |
| **pgadmin (after fix)** | **admin-tools** | **all 4 DBs** | **admin-tools added** | **admin-tools added** | **WORKS** |

---

## 8. Connection Flow Diagram

The complete path of a PgAdmin database connection after the fix:

```
PgAdmin pod (admin-tools namespace, ambient mesh member)
  |
  | [1] PgAdmin opens TCP connection to ecom-db-rw.ecom.svc:5432
  v
ztunnel on PgAdmin's node
  |
  | [2] Wraps TCP stream in HBONE tunnel (HTTP/2 CONNECT)
  | [3] Encrypts with mTLS (SPIFFE identity: ns/admin-tools/sa/pgadmin)
  v
ztunnel on DB pod's node
  |
  | [4] Terminates HBONE tunnel
  | [5] Checks AuthorizationPolicy: admin-tools in allowed namespaces? YES
  | [6] Unwraps to plaintext TCP stream
  v
Kubernetes NetworkPolicy (CNI level)
  |
  | [7] Checks ingress rules: admin-tools namespace allowed? YES
  v
PostgreSQL pod (ecom-db-1, port 5432)
  |
  | [8] Receives SSLRequest -> responds 'S' (SSL supported)
  | [9] TLS 1.3 handshake (CNPG server certificate)
  | [10] Receives StartupMessage (user=ecom, database=ecomdb)
  | [11] SCRAM-SHA-256 authentication challenge/response
  | [12] AuthenticationOk -> ReadyForQuery
  v
PgAdmin displays database tree and is ready for queries
```

---

## 9. Lessons Learned

### Lesson 1: AuthorizationPolicy + NetworkPolicy = Dual-Layer Defense

Both security layers must allow the traffic independently. An AuthorizationPolicy operates at the ztunnel/Istio level (L4 RBAC based on SPIFFE identity). A NetworkPolicy operates at the CNI/kernel level (IP-based packet filtering). Missing either one blocks the connection, even if the other allows it.

### Lesson 2: "Connection reset by peer" from ztunnel = AuthorizationPolicy Denial

When ztunnel's RBAC rejects a connection, the symptom is a TCP RST that appears as `[Errno 104] Connection reset by peer` at the application level. This is NOT a protocol mismatch, NOT an mTLS issue, and NOT a PostgreSQL configuration problem. Always check AuthorizationPolicy first when you see this error in an ambient mesh environment.

### Lesson 3: Test with a Known-Working Service First

Debezium's successful cross-namespace PostgreSQL connection proved that ztunnel, PostgreSQL, and the wire protocol all worked correctly. The only difference between Debezium and PgAdmin was the source namespace. This comparison eliminated 90% of the possible causes in one step.

### Lesson 4: New Namespaces Need Explicit Access

When deploying a new service in a new namespace that needs to access existing services, always check:
1. AuthorizationPolicy on the target service -- does it allow the new namespace?
2. NetworkPolicy on the target service -- does it allow the new namespace?
3. Is the new namespace in the ambient mesh (if the target requires mTLS)?

This is by design -- zero-trust networking means no implicit access. Every cross-namespace connection must be explicitly authorized at both layers.

### Lesson 5: The Error Message Is Misleading

"Connection to server closed unexpectedly" and "server terminated abnormally" suggest a PostgreSQL crash. In reality, PostgreSQL never saw the connection at all. The RST came from ztunnel, which sits between PgAdmin and PostgreSQL. Always consider the full network path, not just the two endpoints.
