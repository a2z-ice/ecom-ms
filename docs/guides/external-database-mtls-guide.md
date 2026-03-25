# Connecting to External Databases from Istio Ambient Mesh

## AWS Aurora PostgreSQL Guide

**Step-by-step: ServiceEntry, DestinationRule, AuthorizationPolicy, NetworkPolicy, and application configuration**

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Prerequisites](#3-prerequisites)
4. [Step-by-Step Guide](#4-step-by-step-guide)
   - [Step 1: Create the ServiceEntry](#step-1-create-the-serviceentry)
   - [Step 2: Create the DestinationRule](#step-2-create-the-destinationrule-tls-origination)
   - [Step 3: Create/Update AuthorizationPolicy](#step-3-createupdate-authorizationpolicy)
   - [Step 4: Create/Update NetworkPolicy](#step-4-createupdate-networkpolicy-egress)
   - [Step 5: Store the RDS CA Certificate](#step-5-store-the-rds-ca-certificate)
   - [Step 6: Store Database Credentials](#step-6-store-database-credentials)
   - [Step 7: Mount Certificates and Configure Application](#step-7-mount-certificates-and-configure-application)
   - [Step 8: Verify Connectivity](#step-8-verify-connectivity)
5. [Troubleshooting Guide](#5-troubleshooting-guide)
6. [Comparison: Internal vs External Database Connections](#6-comparison-internal-vs-external-database-connections)
7. [AWS Aurora-Specific Configuration](#7-aws-aurora-specific-configuration)
8. [Checklist](#8-checklist)
9. [Key Takeaway](#9-key-takeaway)

---

## 1. Overview

When your application runs inside an Istio Ambient mesh with STRICT mTLS and you need to connect to an external database (AWS Aurora, Cloud SQL, Azure Database, etc.), you need to configure several layers:

- **ServiceEntry** -- Tell Istio about the external host so ztunnel knows how to route it
- **DestinationRule** -- Configure TLS settings for the external connection
- **AuthorizationPolicy** -- Allow your application's namespace to reach the external service
- **NetworkPolicy** -- Allow egress from your namespace to the external host
- **Application config** -- Connection string, SSL certificates, credentials

Each layer can independently block your connection, and the error messages are often misleading. This guide walks through every layer with production-tested YAML manifests.

### Why This Guide Exists

This guide is based on real debugging experience connecting PgAdmin to CloudNativePG PostgreSQL databases across Istio Ambient mesh namespaces in our BookStore platform. The lessons learned apply directly to connecting to any external database, including AWS Aurora.

**Hard-won lessons:**

1. **AuthorizationPolicy blocks by default.** Any new namespace or service connecting to a database MUST be explicitly allowed in the target's AuthorizationPolicy. The signature error is `Connection reset by peer` -- NOT a timeout, NOT an mTLS error. ztunnel enforces AuthorizationPolicy at L4 and resets connections from unauthorized sources.

2. **NetworkPolicy is a second layer.** Even if AuthorizationPolicy allows it, Kubernetes NetworkPolicy can still block. Both must allow the traffic.

3. **Ambient mesh is required on BOTH sides** (for in-mesh targets). If the source namespace is NOT in the ambient mesh (`istio.io/dataplane-mode=ambient`), its traffic does not go through ztunnel HBONE. The destination ztunnel will reject non-HBONE inbound to ambient pods.

4. **`portLevelMtls: PERMISSIVE` does NOT work in ambient mode.** Unlike sidecar mode, ztunnel does not support port-level mTLS granularity. You must keep both sides in the ambient mesh.

5. **Cross-namespace L4 PostgreSQL works when policies allow it.** Debezium (infra namespace) successfully connects to ecom-db (ecom namespace) via ztunnel HBONE. This proves the path works.

---

## 2. Architecture

### Traffic Flow: Application to External Database

```
Application Pod (ambient mesh namespace)
  |
  v
ztunnel (source node)
  |  Checks AuthorizationPolicy (egress)
  |  If external (ServiceEntry with MESH_EXTERNAL):
  |    ztunnel initiates direct TLS to external host
  |  If in-mesh:
  |    ztunnel wraps in HBONE mTLS to destination ztunnel
  |
  v
External Database (AWS Aurora PostgreSQL)
  |  TLS terminated at Aurora
  |  PostgreSQL wire protocol
  v
Database responds
```

### What Each Istio Resource Does

| Resource | Purpose | What Happens Without It |
|----------|---------|------------------------|
| **ServiceEntry** | Tells ztunnel the external host exists and how to resolve it | ztunnel may blackhole the connection or route it incorrectly |
| **DestinationRule** | Configures TLS origination (SIMPLE or MUTUAL) for the external connection | ztunnel sends plaintext, Aurora rejects if `rds.force_ssl=1` |
| **AuthorizationPolicy** | Explicitly allows your app to reach the external host | `Connection reset by peer` -- ztunnel silently drops the connection |
| **NetworkPolicy** | Kubernetes-level egress allow rule | Connection timeout -- packets never leave the pod network |

### Comparison with In-Mesh Database Connections

For in-mesh databases (like CNPG clusters in the BookStore platform), the path is different:

```
Application Pod (ecom namespace, ambient mesh)
  |
  v
ztunnel (source node) -- wraps in HBONE mTLS
  |  AuthorizationPolicy checked at destination ztunnel
  |
  v
ztunnel (destination node) -- unwraps HBONE
  |  NetworkPolicy checked by kube-proxy/CNI
  |
  v
Database Pod (ecom namespace, ambient mesh)
```

The key difference: for external databases, ztunnel handles TLS origination directly. For in-mesh databases, ztunnel handles HBONE tunneling transparently.

---

## 3. Prerequisites

Before starting, ensure you have:

- **Istio Ambient Mesh 1.29.1+** with STRICT mTLS enabled cluster-wide
- **AWS Aurora PostgreSQL** cluster with the endpoint hostname
- **SSL certificate bundle** -- AWS RDS CA certificate (`global-bundle.pem`)
- **Database credentials** -- username/password or IAM authentication token
- **Application namespace** labeled for ambient mesh:
  ```bash
  kubectl get ns ecom --show-labels | grep "istio.io/dataplane-mode"
  # Must show: istio.io/dataplane-mode=ambient
  ```
- **Network connectivity** between your Kubernetes cluster and Aurora's VPC (VPC peering, Transit Gateway, VPN, or Direct Connect)

---

## 4. Step-by-Step Guide

### Step 1: Create the ServiceEntry

The ServiceEntry tells Istio that the Aurora endpoint is a known external service. Without it, ztunnel has no routing information for the external hostname.

```yaml
apiVersion: networking.istio.io/v1
kind: ServiceEntry
metadata:
  name: aurora-postgres
  namespace: ecom  # Must be in the same namespace as your application
spec:
  hosts:
    - aurora-db.cluster-xxx.us-east-1.rds.amazonaws.com
  location: MESH_EXTERNAL
  ports:
    - number: 5432
      name: postgres
      protocol: TCP
  resolution: DNS
```

**Key fields explained:**

- `location: MESH_EXTERNAL` -- Tells ztunnel this host is outside the mesh. ztunnel will NOT attempt HBONE tunneling; instead, it initiates a direct connection.
- `resolution: DNS` -- Istio resolves the hostname via DNS. Aurora endpoints are DNS-based (they resolve to the current primary instance IP).
- `protocol: TCP` -- PostgreSQL is a TCP protocol. Do NOT use `HTTP` or `HTTPS` here -- that would cause Istio to attempt HTTP parsing on the PostgreSQL wire protocol, breaking the connection.
- `namespace: ecom` -- ServiceEntry is namespace-scoped. If multiple namespaces need access, create a ServiceEntry in each namespace, or use `exportTo: ["*"]`.

**Apply:**

```bash
kubectl apply -f infra/ecom/aurora-service-entry.yaml
```

**Verify the ServiceEntry is registered:**

```bash
kubectl get serviceentry -n ecom
# NAME              HOSTS                                                    LOCATION        RESOLUTION   AGE
# aurora-postgres   [aurora-db.cluster-xxx.us-east-1.rds.amazonaws.com]     MESH_EXTERNAL   DNS          5s
```

---

### Step 2: Create the DestinationRule (TLS Origination)

The DestinationRule configures how ztunnel establishes the TLS connection to Aurora. Aurora requires SSL by default (`rds.force_ssl` parameter).

**Option A: Server-side TLS only (SIMPLE) -- most common**

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: aurora-postgres-tls
  namespace: ecom
spec:
  host: aurora-db.cluster-xxx.us-east-1.rds.amazonaws.com
  trafficPolicy:
    tls:
      mode: SIMPLE
      caCertificates: /etc/certs/rds-ca-bundle.pem  # Verify Aurora's server certificate
```

`SIMPLE` mode means: the client (ztunnel) verifies the server's (Aurora's) certificate using the provided CA bundle, but does NOT present a client certificate. This is equivalent to `sslmode=verify-full` in PostgreSQL.

**Option B: Mutual TLS (MUTUAL) -- if Aurora requires client certificates**

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: aurora-postgres-mtls
  namespace: ecom
spec:
  host: aurora-db.cluster-xxx.us-east-1.rds.amazonaws.com
  trafficPolicy:
    tls:
      mode: MUTUAL
      clientCertificate: /etc/certs/client.pem
      privateKey: /etc/certs/client-key.pem
      caCertificates: /etc/certs/rds-ca-bundle.pem
```

`MUTUAL` mode means: the client presents its own certificate AND verifies the server's certificate. This is required if Aurora is configured with `rds.force_ssl=1` and client certificate verification.

**Apply:**

```bash
kubectl apply -f infra/ecom/aurora-destination-rule.yaml
```

---

### Step 3: Create/Update AuthorizationPolicy

> **CRITICAL**: This is the step most likely to be missed, and the resulting error (`Connection reset by peer`) gives NO indication that authorization is the cause.

The AuthorizationPolicy explicitly allows your application to connect to the external database. In Istio Ambient mesh with STRICT mTLS, the default behavior is deny-all for any traffic not covered by an ALLOW rule.

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-aurora-egress
  namespace: ecom
spec:
  action: ALLOW
  rules:
    - to:
        - operation:
            hosts:
              - "aurora-db.cluster-xxx.us-east-1.rds.amazonaws.com"
            ports:
              - "5432"
```

**Understanding how AuthorizationPolicy works in Ambient mode:**

- ztunnel enforces AuthorizationPolicy at L4 (TCP level, not HTTP level).
- When ztunnel receives a connection from a pod to an external host, it checks if any ALLOW rule matches.
- If no rule matches, ztunnel **resets the TCP connection**. The application sees `Connection reset by peer`.
- The error does NOT say "unauthorized" or "policy denied" -- it is a silent TCP reset.

**If you already have an AuthorizationPolicy in the namespace**, add the Aurora rule to it rather than creating a new one. Multiple AuthorizationPolicies in the same namespace combine with OR logic for ALLOW rules.

**Apply:**

```bash
kubectl apply -f infra/ecom/aurora-authz-policy.yaml
```

**Verify the policy is applied:**

```bash
kubectl get authorizationpolicy -n ecom
```

---

### Step 4: Create/Update NetworkPolicy (Egress)

Kubernetes NetworkPolicy provides a second layer of network control, independent of Istio. Even if the AuthorizationPolicy allows the traffic, NetworkPolicy can still block it.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-aurora-egress
  namespace: ecom
spec:
  podSelector:
    matchLabels:
      app: ecom-service  # Target specific pods, not the entire namespace
  policyTypes:
    - Egress
  egress:
    # Allow PostgreSQL traffic to Aurora VPC
    - to:
        - ipBlock:
            cidr: 10.0.0.0/8  # Adjust to your Aurora VPC CIDR
      ports:
        - port: 5432
          protocol: TCP
    # Allow DNS resolution (required for hostname-based connections)
    - to: []
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
```

**Important considerations:**

- The `cidr` must match your Aurora VPC's IP range. If you are using VPC peering or Transit Gateway, use the peered VPC's CIDR.
- DNS egress (`port 53`) is required because the application resolves the Aurora hostname via DNS. Without this rule, DNS queries are blocked and the connection times out before even reaching Aurora.
- If you already have a NetworkPolicy in the namespace with egress rules, add the Aurora CIDR to it. Multiple NetworkPolicies are additive (union of all allowed traffic).

**Apply:**

```bash
kubectl apply -f infra/ecom/aurora-network-policy.yaml
```

**Verify:**

```bash
kubectl get networkpolicy -n ecom
kubectl describe networkpolicy allow-aurora-egress -n ecom
```

---

### Step 5: Store the RDS CA Certificate

AWS Aurora uses certificates signed by the AWS RDS Certificate Authority. To verify Aurora's server certificate (`sslmode=verify-full`), your application needs the RDS CA bundle.

**Download the CA bundle:**

```bash
# Global bundle (covers all AWS regions)
curl -o rds-ca-bundle.pem \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

# Verify the bundle is valid
openssl x509 -in rds-ca-bundle.pem -text -noout | head -20
```

**Create the Kubernetes Secret:**

```bash
kubectl create secret generic aurora-ca-cert \
  --namespace ecom \
  --from-file=rds-ca-bundle.pem=rds-ca-bundle.pem
```

**Verify:**

```bash
kubectl get secret aurora-ca-cert -n ecom
kubectl get secret aurora-ca-cert -n ecom -o jsonpath='{.data}' | python3 -c \
  "import sys,json,base64; d=json.load(sys.stdin); print(f'CA bundle: {len(base64.b64decode(d[\"rds-ca-bundle.pem\"]))} bytes')"
```

---

### Step 6: Store Database Credentials

Never hardcode database credentials. Store them as Kubernetes Secrets and reference them via `secretKeyRef` in the Deployment.

```bash
kubectl create secret generic aurora-db-credentials \
  --namespace ecom \
  --from-literal=DB_HOST=aurora-db.cluster-xxx.us-east-1.rds.amazonaws.com \
  --from-literal=DB_PORT=5432 \
  --from-literal=DB_NAME=ecomdb \
  --from-literal=DB_USERNAME=ecomuser \
  --from-literal=DB_PASSWORD='<strong-password>' \
  --from-literal=DB_URL='jdbc:postgresql://aurora-db.cluster-xxx.us-east-1.rds.amazonaws.com:5432/ecomdb?sslmode=verify-full&sslrootcert=/certs/rds-ca-bundle.pem'
```

**For IAM Database Authentication** (alternative to static passwords):

```bash
# Generate a temporary auth token (valid for 15 minutes)
aws rds generate-db-auth-token \
  --hostname aurora-db.cluster-xxx.us-east-1.rds.amazonaws.com \
  --port 5432 \
  --username ecomuser \
  --region us-east-1
```

With IAM auth, you would use a sidecar or init container to periodically refresh the token and update the Secret. This is outside the scope of this guide but is the recommended approach for production.

---

### Step 7: Mount Certificates and Configure Application

#### Spring Boot (ecom-service)

Update the Deployment manifest to mount the CA certificate and inject credentials:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ecom-service
  namespace: ecom
spec:
  template:
    spec:
      containers:
        - name: ecom-service
          image: bookstore/ecom-service:latest
          env:
            - name: SPRING_DATASOURCE_URL
              valueFrom:
                secretKeyRef:
                  name: aurora-db-credentials
                  key: DB_URL
            - name: SPRING_DATASOURCE_USERNAME
              valueFrom:
                secretKeyRef:
                  name: aurora-db-credentials
                  key: DB_USERNAME
            - name: SPRING_DATASOURCE_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: aurora-db-credentials
                  key: DB_PASSWORD
          volumeMounts:
            - name: aurora-ca
              mountPath: /certs
              readOnly: true
      volumes:
        - name: aurora-ca
          secret:
            secretName: aurora-ca-cert
```

In `application.yml`:

```yaml
spring:
  datasource:
    url: ${SPRING_DATASOURCE_URL}
    username: ${SPRING_DATASOURCE_USERNAME}
    password: ${SPRING_DATASOURCE_PASSWORD}
    hikari:
      connection-timeout: 10000
      maximum-pool-size: 10
```

#### FastAPI (inventory-service)

Update the Deployment manifest similarly:

```yaml
env:
  - name: DATABASE_URL
    value: "postgresql://$(DB_USERNAME):$(DB_PASSWORD)@$(DB_HOST):$(DB_PORT)/$(DB_NAME)?sslmode=verify-full&sslrootcert=/certs/rds-ca-bundle.pem"
  - name: DB_USERNAME
    valueFrom:
      secretKeyRef:
        name: aurora-db-credentials
        key: DB_USERNAME
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: aurora-db-credentials
        key: DB_PASSWORD
  - name: DB_HOST
    valueFrom:
      secretKeyRef:
        name: aurora-db-credentials
        key: DB_HOST
  - name: DB_PORT
    valueFrom:
      secretKeyRef:
        name: aurora-db-credentials
        key: DB_PORT
  - name: DB_NAME
    valueFrom:
      secretKeyRef:
        name: aurora-db-credentials
        key: DB_NAME
volumeMounts:
  - name: aurora-ca
    mountPath: /certs
    readOnly: true
volumes:
  - name: aurora-ca
    secret:
      secretName: aurora-ca-cert
```

In Python (SQLAlchemy):

```python
import os
DATABASE_URL = os.environ["DATABASE_URL"]
# The sslmode and sslrootcert are embedded in the URL
engine = create_async_engine(DATABASE_URL)
```

---

### Step 8: Verify Connectivity

#### Quick Test from a Temporary Pod

```bash
# Run a PostgreSQL client pod in the same namespace
kubectl run dbtest --rm -it \
  --namespace ecom \
  --image=postgres:16-alpine \
  --overrides='
{
  "spec": {
    "containers": [{
      "name": "dbtest",
      "image": "postgres:16-alpine",
      "command": ["psql"],
      "args": [
        "host=aurora-db.cluster-xxx.us-east-1.rds.amazonaws.com port=5432 dbname=ecomdb user=ecomuser sslmode=verify-full sslrootcert=/certs/rds-ca-bundle.pem"
      ],
      "env": [{"name": "PGPASSWORD", "value": "<password>"}],
      "volumeMounts": [{"name": "ca", "mountPath": "/certs", "readOnly": true}],
      "stdin": true,
      "tty": true
    }],
    "volumes": [{"name": "ca", "secret": {"secretName": "aurora-ca-cert"}}]
  }
}' -- psql "host=aurora-db.cluster-xxx.us-east-1.rds.amazonaws.com port=5432 dbname=ecomdb user=ecomuser sslmode=verify-full sslrootcert=/certs/rds-ca-bundle.pem"
```

#### Test from the Application Pod

```bash
# Spring Boot
kubectl exec -n ecom deploy/ecom-service -- \
  sh -c 'curl -sf http://localhost:8080/ecom/actuator/health/db | head -20'

# FastAPI
kubectl exec -n inventory deploy/inventory-service -- \
  python3 -c "
import asyncio
from sqlalchemy.ext.asyncio import create_async_engine
import os
engine = create_async_engine(os.environ['DATABASE_URL'])
async def test():
    async with engine.connect() as conn:
        result = await conn.execute(text('SELECT 1'))
        print('Connection OK:', result.scalar())
asyncio.run(test())
"
```

#### Check ztunnel Logs for Connection Events

```bash
# Get ztunnel pods
kubectl get pods -n istio-system -l app=ztunnel

# Check for connection attempts to the Aurora endpoint
kubectl logs -n istio-system -l app=ztunnel --tail=50 | \
  grep "aurora-db.cluster"
```

---

## 5. Troubleshooting Guide

### Error Reference Table

| Symptom | Most Likely Cause | Fix |
|---------|-------------------|-----|
| `Connection reset by peer` | AuthorizationPolicy blocks the source namespace | Add ALLOW rule for the source namespace/pod to reach the external host on port 5432 |
| Connection timeout (no reset, no response) | NetworkPolicy blocks egress, OR source namespace not in ambient mesh | Check NetworkPolicy egress rules; verify namespace has `istio.io/dataplane-mode=ambient` label |
| `SSL error: certificate verify failed` | Missing or wrong CA certificate mounted | Mount the correct RDS CA bundle (`global-bundle.pem`); verify `sslrootcert` path points to the mounted file |
| `FATAL: password authentication failed for user` | Wrong credentials in Kubernetes Secret | Check the Secret values with `kubectl get secret -o jsonpath` |
| Connection works from one namespace but not another | Per-namespace AuthorizationPolicy + NetworkPolicy | Verify BOTH policies exist in both the source and target namespaces |
| Works with `sslmode=disable` but fails with `sslmode=verify-full` | CA cert not mounted or wrong file path | Verify volume mount path and that the file exists inside the container |
| `could not translate host name to address` | DNS resolution blocked by NetworkPolicy | Add DNS egress rule (port 53 UDP/TCP) to your NetworkPolicy |
| `connection refused` (not reset) | Aurora Security Group does not allow inbound from your cluster IP | Update Aurora's VPC Security Group to allow inbound TCP 5432 from your cluster's egress IP |

### Debugging Workflow

When a database connection fails, follow this order:

1. **Check AuthorizationPolicy FIRST.** This is the most common cause and the hardest to diagnose because `Connection reset by peer` does not mention "authorization" or "policy."

   ```bash
   kubectl get authorizationpolicy -n ecom -o yaml
   # Look for rules that match the external host and port
   ```

2. **Check NetworkPolicy.** Verify egress is allowed to the Aurora CIDR and DNS.

   ```bash
   kubectl get networkpolicy -n ecom -o yaml
   ```

3. **Check the namespace is in the ambient mesh.**

   ```bash
   kubectl get ns ecom --show-labels | grep dataplane-mode
   # Expected: istio.io/dataplane-mode=ambient
   ```

4. **Check the ServiceEntry exists.**

   ```bash
   kubectl get serviceentry -n ecom
   ```

5. **Check the DestinationRule exists.**

   ```bash
   kubectl get destinationrule -n ecom
   ```

6. **Check ztunnel logs.**

   ```bash
   kubectl logs -n istio-system -l app=ztunnel --tail=100 | grep -i "denied\|reset\|error"
   ```

7. **Test from a raw pod** (eliminates application-level issues).

   ```bash
   kubectl run nettest --rm -it --namespace ecom --image=busybox -- \
     sh -c 'nc -zv aurora-db.cluster-xxx.us-east-1.rds.amazonaws.com 5432'
   ```

---

## 6. Comparison: Internal vs External Database Connections

| Aspect | Internal DB (CNPG in-mesh) | External DB (AWS Aurora) |
|--------|---------------------------|-------------------------|
| **Network path** | ztunnel HBONE tunnel to destination ztunnel, then to pod | ztunnel direct TLS to external endpoint |
| **mTLS handling** | ztunnel handles transparently (HBONE) | ServiceEntry + DestinationRule for TLS origination |
| **AuthorizationPolicy** | Required on the DB namespace (ingress) | Required on the app namespace (egress) |
| **NetworkPolicy** | Required on the DB namespace (ingress allow) | Required on the app namespace (egress allow) |
| **SSL certificates** | CNPG auto-generates and rotates certs | AWS RDS CA bundle must be downloaded and mounted |
| **Service discovery** | Kubernetes DNS (ClusterIP / ExternalName) | ServiceEntry (DNS resolution by Istio) |
| **Failover** | CNPG auto-failover (updates `-rw` Service) | Aurora auto-failover (cluster endpoint DNS updates) |
| **Credential management** | Kubernetes Secret (auto-generated by CNPG) | Kubernetes Secret (manually created or IAM auth) |
| **Debugging signal** | ztunnel logs show HBONE tunnel events | ztunnel logs show direct outbound connection events |

---

## 7. AWS Aurora-Specific Configuration

### Cluster Endpoint vs Reader Endpoint

Aurora provides multiple endpoints:

| Endpoint Type | Use Case | Example |
|---------------|----------|---------|
| **Cluster endpoint** (read-write) | All write operations, primary reads | `aurora-db.cluster-xxx.us-east-1.rds.amazonaws.com` |
| **Reader endpoint** (read-only) | Read replicas, reporting queries | `aurora-db.cluster-ro-xxx.us-east-1.rds.amazonaws.com` |
| **Instance endpoint** | Direct connection to a specific instance | `aurora-instance-1.xxx.us-east-1.rds.amazonaws.com` |

For the BookStore platform, use the **cluster endpoint** for ecom-service and inventory-service (both need read-write). Use the **reader endpoint** for analytics queries (Superset, reporting).

If using both endpoints, create separate ServiceEntry and DestinationRule resources for each.

### Enforcing SSL on Aurora

Set the `rds.force_ssl` parameter to `1` in the Aurora parameter group:

```bash
aws rds modify-db-cluster-parameter-group \
  --db-cluster-parameter-group-name bookstore-aurora-params \
  --parameters "ParameterName=rds.force_ssl,ParameterValue=1,ApplyMethod=pending-reboot"
```

This ensures that ALL connections to Aurora must use SSL. Any plaintext connection attempt will be rejected by Aurora itself.

### VPC and Security Group Configuration

Aurora must be reachable from your Kubernetes cluster's network:

1. **VPC Peering** -- If the kind cluster runs in a different VPC (e.g., EKS in VPC-A, Aurora in VPC-B), set up VPC peering and update route tables.
2. **Transit Gateway** -- For multi-VPC architectures, use AWS Transit Gateway.
3. **Security Groups** -- Aurora's security group must allow inbound TCP on port 5432 from your cluster's egress IP or CIDR.

```bash
# Example: Allow inbound from EKS cluster's VPC CIDR
aws ec2 authorize-security-group-ingress \
  --group-id sg-0123456789abcdef0 \
  --protocol tcp \
  --port 5432 \
  --cidr 10.0.0.0/16
```

### IAM Database Authentication

Instead of static passwords, Aurora supports IAM-based authentication:

1. Enable IAM auth on the Aurora cluster.
2. Create a database user mapped to an IAM role.
3. Generate temporary auth tokens using `aws rds generate-db-auth-token`.
4. Tokens expire after 15 minutes -- use a sidecar or CronJob to refresh.

```sql
-- In Aurora, create the IAM-mapped user
CREATE USER ecomuser WITH LOGIN;
GRANT rds_iam TO ecomuser;
```

```bash
# Generate token
TOKEN=$(aws rds generate-db-auth-token \
  --hostname aurora-db.cluster-xxx.us-east-1.rds.amazonaws.com \
  --port 5432 \
  --username ecomuser \
  --region us-east-1)

# Use token as password
PGPASSWORD=$TOKEN psql \
  "host=aurora-db.cluster-xxx.us-east-1.rds.amazonaws.com port=5432 dbname=ecomdb user=ecomuser sslmode=verify-full sslrootcert=rds-ca-bundle.pem"
```

---

## 8. Checklist

Use this checklist when adding any new external database connection:

- [ ] **ServiceEntry** created with correct host, port 5432, protocol TCP, resolution DNS, location MESH_EXTERNAL
- [ ] **DestinationRule** created with TLS mode SIMPLE (or MUTUAL if client certs required)
- [ ] **AuthorizationPolicy** allows the connection (check BOTH source and target namespaces)
- [ ] **NetworkPolicy** allows egress to the external host CIDR on port 5432, plus DNS (port 53)
- [ ] **CA certificate** stored as Kubernetes Secret and volume-mounted in the application pod
- [ ] **Database credentials** stored in Kubernetes Secret (never hardcoded in manifests or code)
- [ ] **Application connection string** includes SSL parameters (`sslmode=verify-full`, `sslrootcert=...`)
- [ ] **Source namespace** is in the ambient mesh (`istio.io/dataplane-mode=ambient` label)
- [ ] **Connectivity verified** from inside the pod using psql or a test client
- [ ] **Aurora Security Group** allows inbound from the cluster's egress IP on port 5432
- [ ] **E2E tests** updated to cover the external database connection path

---

## 9. Key Takeaway

> **When you see `Connection reset by peer` connecting to ANY database (internal or external) from within the Istio Ambient mesh, check AuthorizationPolicy FIRST.** This is the number one cause and the hardest to diagnose because the error message does not mention "authorization" or "policy" -- ztunnel silently resets the TCP connection. Only after ruling out AuthorizationPolicy should you check NetworkPolicy, namespace mesh membership, ServiceEntry, and DestinationRule.

The debugging priority order:

1. AuthorizationPolicy (causes `Connection reset by peer`)
2. NetworkPolicy (causes timeout)
3. Namespace mesh label (causes rejection or timeout)
4. ServiceEntry (causes routing failure)
5. DestinationRule (causes SSL errors)
6. CA certificate mount (causes certificate verification failure)
7. Credentials (causes authentication failure)
8. Aurora Security Group (causes `connection refused`)

---

*BookStore Platform -- External Database Connectivity Guide*
*Based on real debugging experience with Istio Ambient Mesh 1.28+ and CloudNativePG PostgreSQL*
