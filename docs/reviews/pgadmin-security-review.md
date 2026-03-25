# PgAdmin Connectivity Fix -- Security Review

**Impact assessment of adding admin-tools namespace to database access policies**

---

## 1. Change Summary

The following changes were made to enable PgAdmin (running in the `admin-tools` namespace) to connect to all 4 PostgreSQL database clusters:

| Change | Scope | Affected Resources |
|--------|-------|-------------------|
| Added `admin-tools` to AuthorizationPolicy | 4 DB namespaces | ecom-db-policy, inventory-db-policy, analytics-db-policy, keycloak-db-policy |
| Added `admin-tools` to NetworkPolicy | 4 DB namespaces | ecom-db-policy, inventory-db-policy, analytics-db-policy, keycloak-db-policy |
| Labeled admin-tools for ambient mesh | 1 namespace | admin-tools namespace (istio.io/dataplane-mode=ambient) |

**Total policies modified:** 8 (4 AuthorizationPolicies + 4 NetworkPolicies)
**Total namespaces modified:** 1 (admin-tools label)

---

## 2. Threat Model Assessment

| Threat | Before Fix | After Fix | Risk Change |
|--------|-----------|-----------|-------------|
| Unauthorized pod in admin-tools accessing DB | N/A (namespace existed but no DB access) | PgAdmin is the only pod; any new pod in admin-tools could reach DBs | LOW -- admin-tools is a controlled namespace with no other deployments |
| Lateral movement from compromised PgAdmin | Blocked by both AuthorizationPolicy and NetworkPolicy | Can reach 4 PostgreSQL clusters on port 5432 | MEDIUM -- PgAdmin has DB credentials for all 4 databases |
| Data exfiltration via PgAdmin | Not possible (no DB access) | Possible if PgAdmin is compromised (attacker can SELECT all tables) | MEDIUM -- mitigated by non-root container, read-only filesystem, and namespace isolation |
| CSRF/XSS on PgAdmin web UI | Exists (PgAdmin is a web application with known historical CVEs) | Same risk, but now with DB access the impact is higher | MEDIUM -- PgAdmin is only accessible from localhost (NodePort) |
| Network sniffing on PgAdmin-to-DB path | N/A (no connection existed) | Protected by ztunnel mTLS (HBONE tunnel) + PostgreSQL TLS 1.3 | LOW -- traffic is double-encrypted |
| Credential theft from PgAdmin config | PgAdmin stores server passwords in its internal SQLite DB | Same -- passwords are in the PgAdmin container | LOW -- read-only filesystem limits persistence; container restart clears state |
| Privilege escalation via SQL injection through PgAdmin | N/A | PgAdmin connects with per-service DB users (ecom, inventory, etc.) | LOW -- each user only owns its own database; no superuser access |

### Overall Risk Assessment

**Risk level: LOW-MEDIUM**

The primary risk is that PgAdmin becomes a pivot point if compromised. However, the attack surface is limited:
- PgAdmin is only accessible from localhost (NodePort 31111, not exposed via the HTTPS gateway)
- The container runs as non-root (UID 5050) with read-only filesystem
- Each DB connection uses a service-specific user with minimal privileges
- Network access is restricted to port 5432 on the 4 DB pods only

---

## 3. Security Controls in Place

### Network Layer (Defense in Depth)

**Layer 1 -- ztunnel mTLS (HBONE):**
- All traffic between PgAdmin and the DB pods is wrapped in an HTTP/2 CONNECT tunnel
- Mutual TLS with SPIFFE-based identity verification
- PeerAuthentication mode: STRICT on all DB namespaces
- Cipher suite: TLS 1.3 with ECDHE key exchange

**Layer 2 -- PostgreSQL TLS 1.3:**
- CNPG enforces `ssl=on` and `ssl_min_protocol_version=TLSv1.3` on all PostgreSQL instances
- Server certificates are managed by CNPG (auto-rotated)
- Even if ztunnel mTLS were somehow bypassed, the PostgreSQL connection itself is encrypted

**Layer 3 -- AuthorizationPolicy (Istio L4 RBAC):**
- ztunnel checks the SPIFFE identity of the source pod before allowing the connection
- Only specific namespaces are permitted: the service's own namespace, `infra` (Debezium), `cnpg-system` (operator), and now `admin-tools` (PgAdmin)
- Any pod not in an allowed namespace is rejected with a TCP RST

**Layer 4 -- NetworkPolicy (Kubernetes CNI):**
- Kubernetes-native packet filtering at the kernel level
- Restricts ingress to the same set of namespaces as the AuthorizationPolicy
- Provides defense-in-depth: even if Istio is compromised, the CNI-level policy still blocks unauthorized traffic

### Authentication

| Component | Method | Strength |
|-----------|--------|----------|
| PgAdmin web UI | Email + password (admin@bookstore.dev) | Standard -- single factor |
| PostgreSQL wire protocol | SCRAM-SHA-256 (auth type 10) | Strong -- salted challenge-response, no plaintext passwords on wire |
| DB credentials storage | Kubernetes Secrets (base64-encoded, etcd-backed) | Standard -- not encrypted at rest in default kind cluster |

### Authorization

| Control | Details |
|---------|---------|
| DB user privileges | Each service user (ecom, inventory, analytics, keycloak) only owns its own database. No cross-database access. No superuser. |
| PgAdmin container | Runs as UID 5050 (pgadmin user), not root |
| PgAdmin filesystem | Read-only root filesystem with specific writable tmpfs mounts |
| Namespace isolation | admin-tools has no access to any service other than the 4 DB pods (AuthorizationPolicy + NetworkPolicy on other services do not include admin-tools) |
| PodSecurity | admin-tools namespace uses `baseline` PodSecurity standard (not `privileged`) |

### Blast Radius Analysis

If PgAdmin is compromised, the attacker can:
- Read and write data in all 4 PostgreSQL databases (ecom, inventory, analytics, keycloak)
- Execute SQL as the respective service user on each database

The attacker CANNOT:
- Access ecom-service, inventory-service, or any application pod
- Access Kafka, Redis, or any other infrastructure service
- Access the Kubernetes API (no ServiceAccount token mounted with elevated permissions)
- Escape the container (non-root, read-only FS, capabilities dropped)
- Reach any service outside the 4 DB pods (AuthorizationPolicy + NetworkPolicy blocks all other destinations)
- Access the host network or other nodes

---

## 4. Recommendations

### Recommendation 1: Rotate DB Passwords (Priority: HIGH)

The current passwords are placeholder values (`CHANGE_ME`). In any environment beyond local development, these must be replaced with strong random passwords.

```bash
# Generate and apply strong passwords
for svc in ecom inventory analytics keycloak; do
  PASSWORD=$(openssl rand -base64 32)
  kubectl -n $svc create secret generic ${svc}-db-credentials \
    --from-literal=password="$PASSWORD" \
    --dry-run=client -o yaml | kubectl apply -f -
done
```

Update PgAdmin's server configuration to match the new passwords.

### Recommendation 2: Add PgAdmin Authentication Hardening (Priority: MEDIUM)

- Enable PgAdmin's built-in login attempt limiting (`MAX_LOGIN_ATTEMPTS=5`)
- Consider restricting PgAdmin access to specific source IPs if deployed beyond localhost
- Set `PGADMIN_CONFIG_LOGIN_BANNER` to warn that this is an administrative tool

### Recommendation 3: Enable Audit Logging (Priority: MEDIUM)

PgAdmin logs all executed SQL queries. Ensure these logs are collected and retained:

```yaml
env:
  - name: PGADMIN_CONFIG_CONSOLE_LOG_LEVEL
    value: "10"  # DEBUG level for comprehensive logging
```

Additionally, enable `pgaudit` on the PostgreSQL side (CNPG supports this) to log all SQL statements at the database level regardless of the client.

### Recommendation 4: Create Read-Only DB Users (Priority: MEDIUM)

For safer day-to-day browsing, create read-only users for PgAdmin:

```sql
-- On each database
CREATE ROLE pgadmin_readonly WITH LOGIN PASSWORD '<strong-password>';
GRANT CONNECT ON DATABASE ecomdb TO pgadmin_readonly;
GRANT USAGE ON SCHEMA public TO pgadmin_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pgadmin_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO pgadmin_readonly;
```

Configure PgAdmin to use these read-only users by default, with the full-privilege users available only when write access is explicitly needed.

### Recommendation 5: Restrict admin-tools Egress (Priority: LOW)

Add an egress NetworkPolicy to the admin-tools namespace to ensure PgAdmin can only reach the 4 DB services and nothing else:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: pgadmin-egress
  namespace: admin-tools
spec:
  podSelector:
    matchLabels:
      app: pgadmin
  policyTypes: [Egress]
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ecom
      podSelector:
        matchLabels:
          cnpg.io/cluster: ecom-db
    ports:
    - port: 5432
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: inventory
      podSelector:
        matchLabels:
          cnpg.io/cluster: inventory-db
    ports:
    - port: 5432
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: analytics
      podSelector:
        matchLabels:
          cnpg.io/cluster: analytics-db
    ports:
    - port: 5432
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: identity
      podSelector:
        matchLabels:
          cnpg.io/cluster: keycloak-db
    ports:
    - port: 5432
  - to:  # DNS resolution
    - namespaceSelector: {}
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
```

---

## 5. Verdict

The fix is **APPROVED** for the local development environment.

### Justification

The security posture remains acceptable because:

1. **Double encryption** -- ztunnel mTLS (HBONE) + PostgreSQL TLS 1.3 protect data in transit
2. **SCRAM-SHA-256 authentication** -- the strongest PostgreSQL auth method; no plaintext passwords on the wire
3. **Namespace-scoped access** -- PgAdmin is allowed to reach only the 4 DB pods, not the entire cluster
4. **Dual-layer enforcement** -- both AuthorizationPolicy (Istio) and NetworkPolicy (CNI) must pass; compromising one layer does not bypass the other
5. **Minimal privilege container** -- non-root (UID 5050), read-only filesystem, all capabilities dropped
6. **Localhost-only exposure** -- PgAdmin is on NodePort 31111, not routed through the HTTPS gateway; only accessible from the developer's machine

### For Production Deployment

Before deploying to any non-local environment, implement all 5 recommendations above, with priority on:
- Recommendation 1 (rotate passwords) -- MUST do
- Recommendation 4 (read-only users) -- SHOULD do
- Recommendation 5 (egress restriction) -- SHOULD do
- Recommendations 2-3 (hardening, audit) -- NICE to have

### Sign-Off

| Reviewer | Date | Decision |
|----------|------|----------|
| Security Review | 2026-03-25 | APPROVED for local dev |
