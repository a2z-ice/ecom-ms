# TLS Manual Testing Guide — cert-manager Self-Signed CA

Comprehensive step-by-step verification of the TLS setup for the Book Store microservices platform. Each step includes commands, expected output, pass/fail criteria, and troubleshooting tips.

---

## Prerequisites

Before starting, ensure:

1. **Cluster running** with TLS enabled:
   ```bash
   bash scripts/up.sh --fresh --yes
   ```

2. **/etc/hosts** configured:
   ```
   127.0.0.1  idp.keycloak.net
   127.0.0.1  myecom.net
   127.0.0.1  api.service.net
   ```
   Verify:
   ```bash
   grep -E "myecom\.net|api\.service\.net|idp\.keycloak\.net" /etc/hosts
   ```
   **Pass:** All three hostnames resolve to `127.0.0.1`.

3. **CA certificate trusted** (optional — required for browser testing without warnings):
   ```bash
   bash scripts/trust-ca.sh --install
   ```
   This adds the BookStore CA to the macOS Keychain / system trust store so browsers and `curl` (without `-k`) accept the self-signed certificate.

---

## Step 1: Verify cert-manager Installation

Check that cert-manager is deployed and all three core components are running.

```bash
kubectl get pods -n cert-manager
```

**Expected output** (3 pods, all `Running`, `1/1` ready):
```
NAME                                       READY   STATUS    RESTARTS   AGE
cert-manager-<hash>                        1/1     Running   0          Xm
cert-manager-cainjector-<hash>             1/1     Running   0          Xm
cert-manager-webhook-<hash>                1/1     Running   0          Xm
```

Verify all three deployments explicitly:
```bash
kubectl get deploy -n cert-manager -o custom-columns=NAME:.metadata.name,READY:.status.readyReplicas,AVAILABLE:.status.availableReplicas
```

**Expected:**
```
NAME                      READY   AVAILABLE
cert-manager              1       1
cert-manager-cainjector   1       1
cert-manager-webhook      1       1
```

**Pass:** All 3 pods are `Running` with `1/1` ready. All 3 deployments show `READY=1`, `AVAILABLE=1`.

**Fail troubleshooting:**
- Check events: `kubectl describe pod -n cert-manager -l app=cert-manager`
- Check logs: `kubectl logs -n cert-manager -l app=cert-manager --tail=50`
- If webhook is not ready, cert-manager cannot issue certificates. Wait or restart: `kubectl rollout restart deploy -n cert-manager`

---

## Step 2: Verify Certificate Chain

The certificate chain has four resources that must all be healthy:

```
selfsigned-bootstrap (ClusterIssuer)
    └── bookstore-ca (Certificate, cert-manager ns) → bookstore-ca-secret (Secret)
        └── bookstore-ca-issuer (ClusterIssuer, references bookstore-ca-secret)
            └── bookstore-gateway-cert (Certificate, infra ns) → bookstore-gateway-tls (Secret)
```

### 2a. Check selfsigned-bootstrap ClusterIssuer

```bash
kubectl get clusterissuer selfsigned-bootstrap -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
```

**Expected:** `True`

### 2b. Check bookstore-ca-issuer ClusterIssuer

```bash
kubectl get clusterissuer bookstore-ca-issuer -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
```

**Expected:** `True`

### 2c. Check bookstore-ca Certificate (cert-manager namespace)

```bash
kubectl get certificate bookstore-ca -n cert-manager -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
```

**Expected:** `True`

Verify it is a CA certificate:
```bash
kubectl get certificate bookstore-ca -n cert-manager -o jsonpath='{.spec.isCA}'
```

**Expected:** `true`

### 2d. Check bookstore-gateway-cert Certificate (infra namespace)

```bash
kubectl get certificate bookstore-gateway-cert -n infra -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
```

**Expected:** `True`

### 2e. Check both secrets exist

```bash
kubectl get secret bookstore-ca-secret -n cert-manager -o jsonpath='{.metadata.name}'
kubectl get secret bookstore-gateway-tls -n infra -o jsonpath='{.metadata.name}'
```

**Expected:** `bookstore-ca-secret` and `bookstore-gateway-tls` respectively.

Verify the gateway TLS secret contains all required keys:
```bash
kubectl get secret bookstore-gateway-tls -n infra -o jsonpath='{.data}' | python3 -c "import sys,json; keys=json.load(sys.stdin).keys(); print(sorted(keys))"
```

**Expected:** `['ca.crt', 'tls.crt', 'tls.key']`

### 2f. Show full chain overview

```bash
kubectl get clusterissuers,certificates --all-namespaces
```

**Expected output (4 resources, all Ready):**
```
NAME                                              READY   AGE
clusterissuer.cert-manager.io/bookstore-ca-issuer   True    Xm
clusterissuer.cert-manager.io/selfsigned-bootstrap  True    Xm

NAMESPACE       NAME                                            READY   SECRET                  AGE
cert-manager    certificate.cert-manager.io/bookstore-ca        True    bookstore-ca-secret     Xm
infra           certificate.cert-manager.io/bookstore-gateway-cert   True    bookstore-gateway-tls   Xm
```

**Pass:** All 4 resources show `Ready=True`. Both secrets exist with the correct keys.

**Fail troubleshooting:**
- If a ClusterIssuer is not Ready: `kubectl describe clusterissuer <name>`
- If a Certificate is not Ready: `kubectl describe certificate <name> -n <ns>` — check Events section
- If the secret is missing: `kubectl get events -n <ns> --field-selector reason=Issuing` — look for errors
- Common issue: cert-manager webhook not ready yet. Wait 30s and retry.

---

## Step 3: Inspect Certificate Details

Extract the actual TLS certificate from the Kubernetes secret and verify its properties with openssl.

### 3a. Extract and display full certificate text

```bash
kubectl get secret bookstore-gateway-tls -n infra \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -text -noout
```

### 3b. Check Subject Alternative Names (SANs)

```bash
kubectl get secret bookstore-gateway-tls -n infra \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | \
  openssl x509 -text -noout | grep -A1 "Subject Alternative Name"
```

**Expected:** All five SANs present:
```
X509v3 Subject Alternative Name:
    DNS:myecom.net, DNS:api.service.net, DNS:idp.keycloak.net, DNS:localhost, IP Address:127.0.0.1
```

**Pass:** All 5 SANs are listed: `myecom.net`, `api.service.net`, `idp.keycloak.net`, `localhost`, `127.0.0.1`.

### 3c. Check issuer

```bash
kubectl get secret bookstore-gateway-tls -n infra \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -issuer
```

**Expected:** Contains `BookStore CA` (e.g., `issuer=CN=BookStore CA`)

### 3d. Check algorithm (ECDSA P-256)

```bash
kubectl get secret bookstore-gateway-tls -n infra \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | \
  openssl x509 -text -noout | grep -E "Public Key Algorithm|ASN1 OID"
```

**Expected:**
```
Public Key Algorithm: id-ecPublicKey
ASN1 OID: prime256v1
```

Verify via the Certificate spec:
```bash
kubectl get certificate bookstore-gateway-cert -n infra \
  -o jsonpath='algorithm={.spec.privateKey.algorithm}, size={.spec.privateKey.size}'
```

**Expected:** `algorithm=ECDSA, size=256`

### 3e. Check validity period (~30 days)

```bash
kubectl get secret bookstore-gateway-tls -n infra \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -dates
```

**Expected:** `notAfter` is approximately 30 days after `notBefore`. Example:
```
notBefore=Mar 10 00:00:00 2026 GMT
notAfter=Apr  9 00:00:00 2026 GMT
```

### 3f. Check key usage (TLS Web Server Authentication)

```bash
kubectl get secret bookstore-gateway-tls -n infra \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | \
  openssl x509 -text -noout | grep -A2 "Extended Key Usage"
```

**Expected:**
```
X509v3 Extended Key Usage:
    TLS Web Server Authentication
```

**Pass:** All sub-checks pass — SANs match, issuer is BookStore CA, ECDSA P-256, ~30 day validity, server auth key usage.

**Fail troubleshooting:**
- If SANs are wrong: check `infra/cert-manager/gateway-certificate.yaml` `dnsNames` and `ipAddresses` fields
- If issuer is wrong: check `issuerRef` in the Certificate manifest points to `bookstore-ca-issuer`
- If algorithm is wrong: check `privateKey.algorithm` and `privateKey.size` in the Certificate spec

---

## Step 4: Test HTTPS Endpoints

Verify all gateway-exposed services respond correctly over HTTPS. Use `-sk` flags (`-s` for silent, `-k` to accept self-signed cert).

### 4a. UI — https://myecom.net:30000/

```bash
curl -sk -o /dev/null -w "HTTP %{http_code}\n" https://myecom.net:30000/
```

**Expected:** `HTTP 200`

Verify HTML content:
```bash
curl -sk https://myecom.net:30000/ | head -1
```

**Expected:** Line contains `<!doctype html>` or `<!DOCTYPE html>`

### 4b. ecom API — https://api.service.net:30000/ecom/books

```bash
curl -sk https://api.service.net:30000/ecom/books | python3 -m json.tool | head -5
```

**Expected:** `HTTP 200` with JSON containing a `content` array of books.

### 4c. Inventory health — https://api.service.net:30000/inven/health

```bash
curl -sk https://api.service.net:30000/inven/health
```

**Expected:** `{"status":"ok"}`

### 4d. Keycloak OIDC discovery

```bash
curl -sk https://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration | python3 -m json.tool | head -10
```

**Expected:** `HTTP 200` with JSON. Verify `issuer` starts with `https://`:
```bash
curl -sk https://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('issuer:', d['issuer']); assert d['issuer'].startswith('https://'), 'FAIL: issuer not HTTPS'"
```

**Expected:** `issuer: https://idp.keycloak.net:30000/realms/bookstore`

### 4e. Cart endpoint (no auth) — expect 401

```bash
curl -sk -o /dev/null -w "HTTP %{http_code}\n" https://api.service.net:30000/ecom/cart
```

**Expected:** `HTTP 401`

### 4f. localhost:30000

```bash
curl -sk -o /dev/null -w "HTTP %{http_code}\n" https://localhost:30000/
```

**Expected:** `HTTP 200`

**Pass:** All 6 endpoints return their expected HTTP status codes. Keycloak discovery `issuer` starts with `https://`.

**Fail troubleshooting:**
- Connection refused: check gateway pod is running: `kubectl get pods -n infra -l istio.io/gateway-name=bookstore-gateway`
- SSL error: check the gateway has the TLS secret mounted: `kubectl describe gateway bookstore-gateway -n infra`
- 503/404: check HTTPRoutes are attached: `kubectl get httproute --all-namespaces`
- Keycloak issuer is HTTP instead of HTTPS: check `KC_HOSTNAME_URL` and `KC_PROXY_HEADERS` env vars in Keycloak deployment

---

## Step 5: Test HTTP-to-HTTPS Redirect

HTTP requests on port 30080 should return `301 Moved Permanently` redirecting to the HTTPS equivalent on port 30000.

### 5a. Basic redirect

```bash
curl -sv http://myecom.net:30080/ 2>&1 | grep -E "< HTTP|< [Ll]ocation"
```

**Expected:**
```
< HTTP/1.1 301 Moved Permanently
< location: https://myecom.net:30000/
```

### 5b. API redirect

```bash
curl -sv http://api.service.net:30080/ecom/books 2>&1 | grep -E "< HTTP|< [Ll]ocation"
```

**Expected:**
```
< HTTP/1.1 301 Moved Permanently
< location: https://api.service.net:30000/ecom/books
```

### 5c. Verify redirect preserves path

```bash
LOCATION=$(curl -sk -o /dev/null -w "%{redirect_url}" http://myecom.net:30080/some/deep/path)
echo "$LOCATION"
```

**Expected:** `https://myecom.net:30000/some/deep/path`

**Pass:** All HTTP requests on port 30080 return `301` with `Location` header pointing to `https://<same-host>:30000/<same-path>`.

**Fail troubleshooting:**
- Connection refused on 30080: check that kind `cluster.yaml` has `hostPort: 30080` in `extraPortMappings` and that the gateway service has a port named `http` with `nodePort: 30080`
  ```bash
  kubectl get svc bookstore-gateway-istio -n infra -o jsonpath='{.spec.ports[?(@.name=="http")].nodePort}'
  ```
  Expected: `30080`
- No redirect (200 instead of 301): check that the `https-redirect` HTTPRoute exists in the `infra` namespace and attaches to the `http` listener:
  ```bash
  kubectl get httproute https-redirect -n infra -o jsonpath='{.spec.parentRefs[0].sectionName}'
  ```
  Expected: `http`
- Port 30080 not configured: requires `bash scripts/up.sh --fresh` with updated `cluster.yaml`

---

## Step 6: Test Keycloak OIDC Over HTTPS

### 6a. Obtain a token via password grant

```bash
curl -sk -X POST \
  "https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=ui-client&username=user1&password=CHANGE_ME"
```

**Expected:** JSON response with `access_token`, `refresh_token`, `token_type: "Bearer"`, and `expires_in`.

Store the token for subsequent tests:
```bash
TOKEN=$(curl -sk -X POST \
  "https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=ui-client&username=user1&password=CHANGE_ME" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
echo "Token length: ${#TOKEN}"
```

**Expected:** Token length is > 100 characters (typically ~800-1200).

### 6b. Use token to call a protected endpoint

```bash
curl -sk -H "Authorization: Bearer $TOKEN" https://api.service.net:30000/ecom/cart
```

**Expected:** `HTTP 200` with JSON (empty cart or cart contents). NOT `401`.

### 6c. Verify all OIDC discovery URLs are HTTPS

```bash
curl -sk https://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration | \
  python3 -c "
import sys, json
d = json.load(sys.stdin)
endpoints = ['issuer','authorization_endpoint','token_endpoint','jwks_uri','userinfo_endpoint','end_session_endpoint']
for ep in endpoints:
    val = d.get(ep, 'MISSING')
    ok = val.startswith('https://') if val != 'MISSING' else False
    print(f'  {ep}: {\"PASS\" if ok else \"FAIL\"} ({val[:60]}...)')
"
```

**Expected:** All 6 endpoints show `PASS` and start with `https://`.

**Pass:** Token is obtained over HTTPS. Protected endpoint accepts the token. All OIDC discovery endpoints use HTTPS.

**Fail troubleshooting:**
- 401 on token endpoint: verify Keycloak user exists — `user1` / `CHANGE_ME`. Reset password if needed (see CLAUDE.md).
- OIDC discovery returns HTTP URLs: Keycloak needs `KC_HOSTNAME_URL=https://idp.keycloak.net:30000` and `KC_PROXY_HEADERS=xforwarded` configured.

---

## Step 7: Test Admin API Over HTTPS

### 7a. Get admin1 token

```bash
ADMIN_TOKEN=$(curl -sk -X POST \
  "https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=ui-client&username=admin1&password=CHANGE_ME" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
echo "Admin token length: ${#ADMIN_TOKEN}"
```

**Expected:** Token length > 100.

### 7b. Admin books endpoint

```bash
curl -sk -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.service.net:30000/ecom/admin/books
```

**Expected:** `HTTP 200`

### 7c. Admin stock endpoint

```bash
curl -sk -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.service.net:30000/inven/admin/stock
```

**Expected:** `HTTP 200`

### 7d. Admin orders endpoint

```bash
curl -sk -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.service.net:30000/ecom/admin/orders
```

**Expected:** `HTTP 200`

### 7e. Verify user1 (non-admin) gets 403 on admin endpoints

```bash
USER_TOKEN=$(curl -sk -X POST \
  "https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=ui-client&username=user1&password=CHANGE_ME" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

curl -sk -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $USER_TOKEN" \
  https://api.service.net:30000/ecom/admin/books
```

**Expected:** `HTTP 403` (Forbidden)

```bash
curl -sk -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $USER_TOKEN" \
  https://api.service.net:30000/inven/admin/stock
```

**Expected:** `HTTP 403` (Forbidden)

**Pass:** admin1 gets `200` on all three admin endpoints. user1 gets `403` on admin endpoints.

**Fail troubleshooting:**
- admin1 gets 403: verify admin1 has the `admin` realm role in Keycloak. Check at `http://localhost:32400/admin` > Users > admin1 > Role Mappings.
- user1 gets 200 on admin: security misconfiguration — check `@PreAuthorize("hasRole('ADMIN')")` in ecom-service and `require_role("admin")` in inventory-service.

---

## Step 8: Verify Tool NodePorts Stay HTTP

All diagnostic/admin tool ports are NOT behind the TLS gateway — they remain plain HTTP on their own NodePorts.

```bash
echo "--- PgAdmin (31111) ---"
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:31111/misc/ping

echo "--- Superset (32000) ---"
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:32000/health

echo "--- Kiali (32100) ---"
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:32100/kiali/

echo "--- Flink (32200) ---"
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:32200/overview

echo "--- Debezium ecom (32300) ---"
curl -s http://localhost:32300/q/health

echo "--- Debezium inventory (32301) ---"
curl -s http://localhost:32301/q/health

echo "--- Keycloak Admin (32400) ---"
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:32400/admin/master/console/

echo "--- Grafana (32500) ---"
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:32500/api/health
```

**Expected results:**

| Port  | Service              | Expected Response                        |
|-------|----------------------|------------------------------------------|
| 31111 | PgAdmin              | `HTTP 200`                               |
| 32000 | Superset             | `HTTP 200`                               |
| 32100 | Kiali                | `HTTP 200`                               |
| 32200 | Flink                | `HTTP 200`                               |
| 32300 | Debezium ecom        | `{"status":"UP",...}`                    |
| 32301 | Debezium inventory   | `{"status":"UP",...}`                    |
| 32400 | Keycloak Admin       | `HTTP 200` (or `302` redirect to login)  |
| 32500 | Grafana              | `HTTP 200` with JSON health              |

**Pass:** All 8 tool ports respond over plain HTTP. None require HTTPS.

**Fail troubleshooting:**
- Connection refused: the tool pod may not be running. Check: `kubectl get pods --all-namespaces | grep <service-name>`
- Timeout: verify the kind `extraPortMappings` include the port. Check: `docker port bookstore-control-plane`

---

## Step 9: Gateway TLS Configuration

Verify the Kubernetes Gateway resource is correctly configured with both HTTPS and HTTP listeners.

### 9a. Gateway has HTTPS listener on port 8443

```bash
kubectl get gateway bookstore-gateway -n infra \
  -o jsonpath='{.spec.listeners[?(@.name=="https")].port}'
```

**Expected:** `8443`

### 9b. HTTPS listener uses TLS Terminate mode

```bash
kubectl get gateway bookstore-gateway -n infra \
  -o jsonpath='{.spec.listeners[?(@.name=="https")].tls.mode}'
```

**Expected:** `Terminate`

### 9c. HTTPS listener references the correct TLS secret

```bash
kubectl get gateway bookstore-gateway -n infra \
  -o jsonpath='{.spec.listeners[?(@.name=="https")].tls.certificateRefs[0].name}'
```

**Expected:** `bookstore-gateway-tls`

### 9d. Gateway has HTTP listener on port 8080 (for redirects)

```bash
kubectl get gateway bookstore-gateway -n infra \
  -o jsonpath='{.spec.listeners[?(@.name=="http")].port}'
```

**Expected:** `8080`

### 9e. Verify gateway service NodePorts

```bash
echo "HTTPS NodePort:"
kubectl get svc bookstore-gateway-istio -n infra \
  -o jsonpath='{.spec.ports[?(@.name=="https")].nodePort}'

echo ""
echo "HTTP NodePort:"
kubectl get svc bookstore-gateway-istio -n infra \
  -o jsonpath='{.spec.ports[?(@.name=="http")].nodePort}'
```

**Expected:** HTTPS = `30000`, HTTP = `30080`

### 9f. All application HTTPRoutes attach to the HTTPS listener

```bash
for route_ns in "ui-route:ecom" "ecom-route:ecom" "keycloak-route:identity" "inven-route:inventory"; do
  ROUTE="${route_ns%%:*}"
  NS="${route_ns##*:}"
  SECTION=$(kubectl get httproute "$ROUTE" -n "$NS" \
    -o jsonpath='{.spec.parentRefs[0].sectionName}')
  echo "$ROUTE ($NS): sectionName=$SECTION"
done
```

**Expected:** All four routes show `sectionName=https`.

### 9g. Redirect route attaches to the HTTP listener

```bash
kubectl get httproute https-redirect -n infra \
  -o jsonpath='{.spec.parentRefs[0].sectionName}'
```

**Expected:** `http`

**Pass:** Gateway has both listeners (8443 HTTPS, 8080 HTTP). NodePorts are 30000 and 30080. All app routes attach to `https`. Redirect route attaches to `http`.

**Fail troubleshooting:**
- Missing listener: check `infra/kgateway/gateway.yaml` for the listener definitions
- Wrong NodePort: the `up.sh` script patches the auto-created gateway service. Run: `kubectl patch svc bookstore-gateway-istio -n infra --type=json -p '[{"op":"replace","path":"/spec/ports/0/nodePort","value":30000}]'`
- Route not attaching: check `parentRefs` in each HTTPRoute manifest includes `sectionName: https`

---

## Step 10: Verify Rotation Configuration

### 10a. Check the rotation ConfigMap

```bash
kubectl get configmap tls-rotation-config -n infra -o yaml
```

**Expected data values:**

| Key                | Expected Value | Meaning            |
|--------------------|----------------|--------------------|
| `cert-duration`    | `720h`         | 30 days            |
| `cert-renew-before`| `168h`         | 7 days before expiry |
| `ca-duration`      | `87600h`       | 10 years           |
| `ca-renew-before`  | `8760h`        | 1 year before expiry |

Verify each value:
```bash
kubectl get configmap tls-rotation-config -n infra \
  -o jsonpath='cert-duration={.data.cert-duration}
cert-renew-before={.data.cert-renew-before}
ca-duration={.data.ca-duration}
ca-renew-before={.data.ca-renew-before}'
```

### 10b. Verify Certificate spec matches ConfigMap

```bash
echo "Gateway cert duration: $(kubectl get certificate bookstore-gateway-cert -n infra -o jsonpath='{.spec.duration}')"
echo "Gateway cert renewBefore: $(kubectl get certificate bookstore-gateway-cert -n infra -o jsonpath='{.spec.renewBefore}')"
echo "CA cert duration: $(kubectl get certificate bookstore-ca -n cert-manager -o jsonpath='{.spec.duration}')"
echo "CA cert renewBefore: $(kubectl get certificate bookstore-ca -n cert-manager -o jsonpath='{.spec.renewBefore}')"
```

**Expected:** Values match the ConfigMap (720h, 168h, 87600h, 8760h).

### 10c. Renewal time is in the future

```bash
RENEWAL=$(kubectl get certificate bookstore-gateway-cert -n infra -o jsonpath='{.status.renewalTime}')
echo "Renewal time: $RENEWAL"
echo "Current time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

**Expected:** `renewalTime` is in the future (approximately 23 days from certificate issuance — i.e., 30 days minus 7 days renewBefore).

### 10d. Check notBefore/notAfter dates

```bash
echo "notBefore: $(kubectl get certificate bookstore-gateway-cert -n infra -o jsonpath='{.status.notBefore}')"
echo "notAfter:  $(kubectl get certificate bookstore-gateway-cert -n infra -o jsonpath='{.status.notAfter}')"
```

**Expected:** `notBefore` is in the past (at or before now). `notAfter` is approximately 30 days after `notBefore`.

**Pass:** ConfigMap values match Certificate specs. Renewal time is in the future. Certificate validity is ~30 days.

**Fail troubleshooting:**
- ConfigMap missing: `kubectl apply -f infra/cert-manager/rotation-config.yaml`
- Values mismatch: update the Certificate manifests to match the ConfigMap or vice versa
- Renewal time in the past: the certificate may need manual renewal (see Step 11)

---

## Step 11: Test Certificate Rotation

This test simulates what happens when cert-manager auto-renews the gateway certificate.

### 11a. Record current certificate serial number and revision

```bash
SERIAL_BEFORE=$(kubectl get secret bookstore-gateway-tls -n infra \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -serial)
REVISION_BEFORE=$(kubectl get certificate bookstore-gateway-cert -n infra \
  -o jsonpath='{.status.revision}')
echo "Serial before: $SERIAL_BEFORE"
echo "Revision before: $REVISION_BEFORE"
```

### 11b. Force renewal by deleting the TLS secret

```bash
kubectl delete secret bookstore-gateway-tls -n infra
```

cert-manager detects the missing secret and immediately re-issues the certificate.

### 11c. Wait for cert-manager to re-issue

```bash
echo "Waiting for certificate to become Ready..."
kubectl wait certificate bookstore-gateway-cert -n infra \
  --for=condition=Ready --timeout=60s
```

**Expected:** `certificate.cert-manager.io/bookstore-gateway-cert condition met`

If `kubectl wait` is not available or times out, poll manually:
```bash
for i in $(seq 1 30); do
  STATUS=$(kubectl get certificate bookstore-gateway-cert -n infra \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
  echo "Attempt $i: Ready=$STATUS"
  [ "$STATUS" = "True" ] && break
  sleep 2
done
```

### 11d. Verify new certificate

```bash
SERIAL_AFTER=$(kubectl get secret bookstore-gateway-tls -n infra \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -serial)
REVISION_AFTER=$(kubectl get certificate bookstore-gateway-cert -n infra \
  -o jsonpath='{.status.revision}')
echo "Serial after: $SERIAL_AFTER"
echo "Revision after: $REVISION_AFTER"
```

**Expected:** `SERIAL_AFTER` differs from `SERIAL_BEFORE`. `REVISION_AFTER` is greater than `REVISION_BEFORE`.

### 11e. Verify HTTPS still works after rotation

Allow 3-5 seconds for the Istio gateway to pick up the new certificate, then test:

```bash
sleep 5
curl -sk -o /dev/null -w "HTTP %{http_code}\n" https://myecom.net:30000/
curl -sk -o /dev/null -w "HTTP %{http_code}\n" https://api.service.net:30000/ecom/books
curl -sk -o /dev/null -w "HTTP %{http_code}\n" https://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration
```

**Expected:** All return `HTTP 200`.

**Pass:** Serial number changed. Revision incremented. Certificate is Ready. HTTPS endpoints work with the new certificate.

**Fail troubleshooting:**
- Certificate stuck in `Issuing` state: `kubectl describe certificate bookstore-gateway-cert -n infra` — check Events
- HTTPS broken after rotation: the gateway pod may need a restart to pick up the new secret. Istio should handle this automatically via SDS (Secret Discovery Service), but if not: `kubectl rollout restart deploy -n infra -l istio.io/gateway-name=bookstore-gateway`
- Same serial number: cert-manager may have restored the old secret from cache. Delete and wait longer.

---

## Step 12: Browser Testing

These tests verify the full user experience in a real browser.

### 12a. Navigate to https://myecom.net:30000

Open a browser and go to `https://myecom.net:30000`.

**If CA is trusted** (ran `bash scripts/trust-ca.sh --install`):
- Page loads without any certificate warning
- Browser shows a lock icon (or "Connection is secure")
- Clicking the lock shows "BookStore CA" as the certificate issuer

**If CA is NOT trusted:**
- Browser shows a certificate warning (NET::ERR_CERT_AUTHORITY_INVALID or similar)
- Proceed past the warning to verify the page loads
- This is expected for self-signed CA without trust installation

**Pass (CA trusted):** No certificate warning. Lock icon visible. Catalog page loads.
**Pass (CA not trusted):** Warning is displayed (expected). Page loads after accepting.

### 12b. Login as user1

1. Click "Login" in the navbar
2. Keycloak login page appears — verify the URL bar shows `https://idp.keycloak.net:30000/...`
3. Enter `user1` / `CHANGE_ME`
4. After redirect, verify you are logged in (navbar shows username/Logout)

**Pass:** Keycloak login page is served over HTTPS. Login succeeds. Redirect back to the app works.

### 12c. Complete a checkout flow

1. Add a book to cart (click "Add to Cart" on any in-stock book)
2. Navigate to cart (click cart icon in navbar)
3. Click "Checkout"
4. Verify order confirmation page appears

**Pass:** Full checkout flow completes over HTTPS without errors.

### 12d. Login as admin1

1. Logout from user1
2. Login as `admin1` / `CHANGE_ME`
3. Verify "Admin" link appears in the navbar (gold colored)
4. Click "Admin" — admin dashboard loads at `/admin`
5. Navigate to Books, Stock, and Orders pages

**Pass:** Admin panel is accessible over HTTPS. All admin pages load.

---

## Step 13: Run Automated Tests

### 13a. Smoke test

```bash
cd /Volumes/Other/rand/llm/microservice && bash scripts/smoke-test.sh
```

**Expected:** All checks pass (green output, exit code 0).

**Pass:** Script exits with code 0 and reports all checks passed.

### 13b. Route verification

```bash
cd /Volumes/Other/rand/llm/microservice && bash scripts/verify-routes.sh
```

**Expected:** All routes respond with expected HTTP status codes.

**Pass:** Script exits with code 0.

### 13c. E2E test suite

```bash
cd /Volumes/Other/rand/llm/microservice/e2e && npm run test
```

**Expected:** All tests pass (the TLS-specific tests in `tls-cert-manager.spec.ts` are included in the full suite).

**Pass:** All tests pass (0 failures). The `tls-cert-manager.spec.ts` suite specifically covers Steps 1-5 and 9-11 programmatically.

**Fail troubleshooting:**
- If only TLS tests fail: check certificate status (Step 2) — the most common cause is a certificate not being Ready
- If auth tests fail after rotation (Step 11): the gateway may need a moment to pick up the new cert. Re-run after 10 seconds.
- If redirect tests are skipped: port 30080 is not configured. Run `bash scripts/up.sh --fresh --yes` to rebuild with the updated kind cluster config.

---

## Quick Reference — All Commands Summary

```bash
# Step 1: cert-manager pods
kubectl get pods -n cert-manager

# Step 2: Certificate chain
kubectl get clusterissuers,certificates --all-namespaces

# Step 3: Certificate details
kubectl get secret bookstore-gateway-tls -n infra -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -text -noout

# Step 4: HTTPS endpoints
curl -sk https://myecom.net:30000/
curl -sk https://api.service.net:30000/ecom/books
curl -sk https://api.service.net:30000/inven/health
curl -sk https://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration

# Step 5: HTTP redirect
curl -sv http://myecom.net:30080/ 2>&1 | grep -E "< HTTP|< [Ll]ocation"

# Step 6: OIDC token
curl -sk -X POST "https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=ui-client&username=user1&password=CHANGE_ME"

# Step 11: Force rotation
kubectl delete secret bookstore-gateway-tls -n infra
kubectl wait certificate bookstore-gateway-cert -n infra --for=condition=Ready --timeout=60s
```
