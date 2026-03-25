# Inline Python Scripts Reference -- Shell Script Automation

**18 inline Python snippets across 8 shell scripts: what they do, why Python, and what they produce**

---

## 1. Overview

The BookStore platform's shell scripts use inline Python (`python3 -c "..."`) for JSON/YAML manipulation tasks that are impractical in pure bash. There are 18 usages across 8 scripts, falling into 5 patterns:

1. **JSON field extraction** (10 usages) -- extracting fields from API responses
2. **YAML+JSON ConfigMap manipulation** (3 usages) -- editing Istio mesh config
3. **NetworkPolicy JSON patching** (2 usages) -- inserting egress rules
4. **Token parsing** (2 usages) -- extracting JWTs from Keycloak responses
5. **File processing** (1 usage) -- reading schema files and JSON-escaping

All 18 snippets use only the Python standard library (`json`, `sys`) plus `yaml` (PyYAML) where YAML parsing is required. No third-party JSON tools like `jq` or `yq` are needed.

---

## 2. Script-by-Script Reference

### 2.1 scripts/up.sh (3 usages)

**Purpose:** Master bootstrap script -- creates/recovers the entire cluster.

#### Snippet 1: Istio extensionProvider Registration

- **Location:** `scripts/up.sh:378-396`
- **Pattern:** YAML+JSON ConfigMap manipulation
- **Condition:** Only runs if `csrf-ext-authz` is not already found in the Istio mesh config (checked via `grep -q` on line 376)

**Shell command (full pipe chain):**

```bash
kubectl get configmap istio -n istio-system -o json | python3 -c "
import sys, json, yaml
cm = json.load(sys.stdin)
mesh = yaml.safe_load(cm['data']['mesh'])
if 'extensionProviders' not in mesh:
    mesh['extensionProviders'] = []
mesh['extensionProviders'].append({
    'name': 'csrf-ext-authz',
    'envoyExtAuthzHttp': {
        'service': 'csrf-service.infra.svc.cluster.local',
        'port': 8080,
        'failOpen': True,
        'headersToUpstreamOnAllow': [],
        'includeRequestHeadersInCheck': ['authorization', 'x-csrf-token'],
    }
})
cm['data']['mesh'] = yaml.dump(mesh, default_flow_style=False)
json.dump(cm, sys.stdout)
" | kubectl apply -f -
```

**What the Python does line-by-line:**

| Line | Action |
|------|--------|
| `cm = json.load(sys.stdin)` | Parse the full ConfigMap JSON from kubectl |
| `mesh = yaml.safe_load(cm['data']['mesh'])` | The `mesh` key is embedded YAML inside JSON -- parse it into a Python dict |
| `if 'extensionProviders' not in mesh:` | Initialize the list if it does not exist yet |
| `mesh['extensionProviders'].append({...})` | Append the csrf-ext-authz provider definition |
| `cm['data']['mesh'] = yaml.dump(...)` | Re-serialize the modified dict back to YAML string |
| `json.dump(cm, sys.stdout)` | Re-serialize the full ConfigMap back to JSON for `kubectl apply` |

- **Input:** ConfigMap JSON from `kubectl get configmap istio -n istio-system -o json`
- **Output:** Modified ConfigMap JSON with the new extensionProvider appended, piped to `kubectl apply -f -`
- **Why Python:** The mesh config is YAML embedded inside a JSON ConfigMap. Bash cannot parse YAML, and `jq` cannot parse YAML either. Python with PyYAML handles both layers.

**Expected Output:**

The Python modifies the ConfigMap's `data.mesh` field. The resulting YAML embedded in the ConfigMap:

```yaml
defaultConfig:
  discoveryAddress: istiod.istio-system.svc:15012
  image:
    imageType: distroless
  proxyMetadata:
    ISTIO_META_ENABLE_HBONE: 'true'
defaultProviders:
  metrics:
  - prometheus
enablePrometheusMerge: true
extensionProviders:
- envoyExtAuthzHttp:
    failOpen: true
    headersToUpstreamOnAllow: []
    includeRequestHeadersInCheck:
    - authorization
    - x-csrf-token
    port: 8080
    service: csrf-service.infra.svc.cluster.local
  name: csrf-ext-authz
rootNamespace: istio-system
trustDomain: cluster.local
```

This YAML is wrapped back inside the ConfigMap JSON and applied via `kubectl apply -f -`.

---

#### Snippet 2: Gateway Egress NetworkPolicy Patch

- **Location:** `scripts/up.sh:471-479`
- **Pattern:** NetworkPolicy JSON patching
- **Condition:** Only runs if the gateway-egress NetworkPolicy exists AND does not already contain `csrf-service` (checked on line 469)

**Shell command (full pipe chain):**

```bash
echo "$_GW_EGRESS" | python3 -c "
import sys, json
pol = json.load(sys.stdin)
pol['spec']['egress'].insert(0, {
    'to': [{'podSelector': {'matchLabels': {'app': 'csrf-service'}}}],
    'ports': [{'port': 8080, 'protocol': 'TCP'}]
})
json.dump(pol, sys.stdout)
" | kubectl apply -f -
```

**What the Python does line-by-line:**

| Line | Action |
|------|--------|
| `pol = json.load(sys.stdin)` | Parse the NetworkPolicy JSON |
| `pol['spec']['egress'].insert(0, {...})` | Insert a new egress rule at position 0 (highest priority) |
| `json.dump(pol, sys.stdout)` | Re-serialize the modified policy for `kubectl apply` |

- **Input:** NetworkPolicy JSON previously fetched via `kubectl get networkpolicy gateway-egress -n infra -o json` and stored in `$_GW_EGRESS`
- **Output:** Modified NetworkPolicy JSON with csrf-service egress rule inserted at the front
- **Why Python:** Inserting an element at a specific position in a JSON array requires parsing the full structure. `jq` could theoretically do this, but `jq` is not guaranteed to be installed.

**Expected Output:**

After the Python inserts the csrf-service rule, the NetworkPolicy YAML looks like:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: gateway-egress
  namespace: infra
spec:
  podSelector:
    matchLabels:
      gateway.networking.k8s.io/gateway-name: bookstore-gateway
  policyTypes:
    - Egress
  egress:
    - ports:                           # rule[0]: csrf-service (INSERTED by Python)
        - port: 8080
          protocol: TCP
      to:
        - podSelector:
            matchLabels:
              app: csrf-service
    - ports:                           # rule[1]: ecom namespace
        - port: 8080
          protocol: TCP
      to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ecom
    - ports:                           # rule[2]: inventory namespace
        - port: 8000
          protocol: TCP
      to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: inventory
    - ports:                           # rule[3]: identity namespace
        - port: 8080
          protocol: TCP
      to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: identity
    - ports:                           # rule[4]: UI service
        - port: 80
          protocol: TCP
      to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ecom
    - ports:                           # rule[5]: DNS
        - port: 53
          protocol: UDP
      to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
    - ports:                           # rule[6]: HBONE tunnel
        - port: 15008
```

---

#### Snippet 3: Debezium Health Check

- **Location:** `scripts/up.sh:680`
- **Pattern:** JSON field extraction

**Shell command (full pipe chain):**

```bash
curl -sf --max-time 10 "http://localhost:${port}/q/health" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo ""
```

**What the Python does:**

| Line | Action |
|------|--------|
| `json.load(sys.stdin)` | Parse the health endpoint JSON response |
| `.get('status','')` | Extract the `status` field, defaulting to empty string |
| `print(...)` | Output the value for the calling bash variable |

- **Input:** JSON from Debezium Server health endpoint (e.g., `{"status":"UP","checks":[...]}`)
- **Output:** String `UP` or empty string
- **Condition:** Called inside `_debezium_health()` helper function during healthy-cluster verification
- **Why Python:** The health response is a JSON object. Bash `grep` could match "UP" but would also match false positives in nested fields.

**Expected Output:**

When healthy:
```
UP
```

When Debezium is down:
```
(empty string)
```

---

### 2.2 scripts/smoke-test.sh (3 usages)

**Purpose:** Full-stack smoke test -- pods, HTTP routes, Kafka lag, Debezium health, admin API access control.

#### Snippet 1: Debezium Health Status Extraction

- **Location:** `scripts/smoke-test.sh:105-107`
- **Pattern:** JSON field extraction

```bash
STATUS=$(curl -s --max-time 10 "${url}/q/health" 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','UNKNOWN'))" 2>/dev/null \
  || echo "UNKNOWN")
```

- **Input:** JSON from Debezium Server health endpoint (`http://localhost:32300/q/health` or `:32301`)
- **Output:** String `UP` or `UNKNOWN` (stored in `$STATUS`)
- **Condition:** Runs for both ecom and inventory Debezium Server instances in a loop

**Expected Output:**

When healthy:
```
UP
```

When Debezium is down:
```
UNKNOWN
```

---

#### Snippet 2: Admin Token Extraction

- **Location:** `scripts/smoke-test.sh:124-128`
- **Pattern:** Token parsing

```bash
ADMIN_TOKEN=$(curl -sk --max-time 15 -X POST \
  "https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=ui-client&username=admin1&password=CHANGE_ME" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo "")
```

- **Input:** Keycloak token response JSON (`{"access_token":"eyJ...","token_type":"Bearer",...}`)
- **Output:** JWT access token string (stored in `$ADMIN_TOKEN`)
- **Condition:** Always runs; token is used to test admin API endpoints
- **Why Python:** The access_token is a nested JSON field containing dots and special characters that would break naive bash string extraction.

**Expected Output:**

When Keycloak is healthy:
```
eyJhbGciOiJSUzI1NiIsInR5cCIgOiAiSldUIiwia2lkIiA6IC...
```
(Full JWT is ~995 characters, truncated for display)

When Keycloak is down:
```
(empty string)
```

---

#### Snippet 3: Customer Token Extraction

- **Location:** `scripts/smoke-test.sh:141-145`
- **Pattern:** Token parsing

```bash
CUSTOMER_TOKEN=$(curl -sk --max-time 15 -X POST \
  "https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=ui-client&username=user1&password=CHANGE_ME" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo "")
```

- **Input:** Keycloak token response JSON (same structure, different user: `user1`)
- **Output:** JWT access token string (stored in `$CUSTOMER_TOKEN`)
- **Condition:** Always runs; token used to verify that customer role is denied on admin endpoints

**Expected Output:**

When Keycloak is healthy:
```
eyJhbGciOiJSUzI1NiIsInR5cCIgOiAiSldUIiwia2lkIiA6IC...
```
(Full JWT is ~995 characters, truncated for display)

When Keycloak is down:
```
(empty string)
```

---

### 2.3 scripts/sanity-test.sh (1 usage)

**Purpose:** Comprehensive cluster health check -- pod status, routes, Kafka, Debezium.

#### Snippet 1: Debezium Health Status

- **Location:** `scripts/sanity-test.sh:131-133`
- **Pattern:** JSON field extraction

```bash
STATUS=$(curl -s --max-time 10 "http://localhost:${port}/q/health" 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','UNKNOWN'))" 2>/dev/null \
  || echo "UNKNOWN")
```

- **Input:** Debezium Server health JSON
- **Output:** String `UP` or `UNKNOWN`
- **Condition:** Loops over both ecom (port 32300) and inventory (port 32301)

**Expected Output:**

When healthy:
```
UP
```

When Debezium is down:
```
UNKNOWN
```

---

### 2.4 scripts/full-stack-test.sh (4 usages)

**Purpose:** Comprehensive full-stack validation with scored sections and detailed reporting.

#### Snippet 1: Book Count from API

- **Location:** `scripts/full-stack-test.sh:344-345`
- **Pattern:** JSON field extraction (array length)

```bash
BOOK_COUNT=$(curl -sk --max-time 15 "https://api.service.net:30000/ecom/books" 2>/dev/null \
  | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
```

- **Input:** JSON array of books from ecom-service (`[{"id":"...","title":"...",...}, ...]`)
- **Output:** Integer count of books (e.g., `15`)
- **Condition:** Always runs as part of API tests section
- **Why Python:** Counting elements in a JSON array requires parsing; `wc -l` would count lines, not array elements.

**Expected Output:**

When healthy:
```
10
```

When API is down:
```
0
```

---

#### Snippet 2: Certificate Count from Dashboard API

- **Location:** `scripts/full-stack-test.sh:368-369`
- **Pattern:** JSON field extraction (array length)

```bash
CERT_COUNT=$(curl -s --max-time 10 "http://localhost:32600/api/certs" 2>/dev/null \
  | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
```

- **Input:** JSON array of certificates from cert-dashboard API
- **Output:** Integer count of certificates
- **Condition:** Only runs if the `cert-dashboard` namespace exists

**Expected Output:**

When healthy:
```
2
```

When API is down:
```
0
```

---

#### Snippet 3: Debezium Health Status

- **Location:** `scripts/full-stack-test.sh:395-397`
- **Pattern:** JSON field extraction

```bash
STATUS=$(curl -s --max-time 10 "${url}/q/health" 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','UNKNOWN'))" 2>/dev/null \
  || echo "UNKNOWN")
```

- **Input:** Debezium Server health JSON
- **Output:** String `UP` or `UNKNOWN`

**Expected Output:**

When healthy:
```
UP
```

When Debezium is down:
```
UNKNOWN
```

---

#### Snippet 4: Flink Running Job Count

- **Location:** `scripts/full-stack-test.sh:405-407`
- **Pattern:** JSON field extraction (filtered count)

```bash
FLINK_JOBS=$(curl -s --max-time 10 "http://localhost:32200/jobs/overview" 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for j in d.get('jobs',[]) if j['state']=='RUNNING'))" 2>/dev/null \
  || echo "0")
```

**What the Python does:**

| Expression | Action |
|------------|--------|
| `d=json.load(sys.stdin)` | Parse Flink REST API jobs overview |
| `d.get('jobs',[])` | Get the jobs array, defaulting to empty list |
| `sum(1 for j in ... if j['state']=='RUNNING')` | Count only jobs whose state is `RUNNING` |

- **Input:** Flink jobs overview JSON (`{"jobs":[{"jid":"...","state":"RUNNING",...},...]}"`)
- **Output:** Integer count of running jobs (expected: 4)
- **Why Python:** Filtering a JSON array by a nested field value and counting matches is beyond what bash string operations can reliably do.

**Expected Output:**

When Flink is healthy with all jobs running:
```
4
```

When Flink is down:
```
0
```

---

### 2.5 scripts/cert-dashboard-up.sh (1 usage)

**Purpose:** Build and deploy the cert-dashboard operator and its CRD/CR.

#### Snippet 1: Certificate Count from API

- **Location:** `scripts/cert-dashboard-up.sh:425`
- **Pattern:** JSON field extraction (array length)

```bash
CERT_COUNT=$(curl -s "http://localhost:${DASHBOARD_PORT}/api/certs" 2>/dev/null \
  | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
```

- **Input:** JSON array of certificates from the cert-dashboard API
- **Output:** Integer count of certificates
- **Condition:** Runs during post-deploy verification

**Expected Output:**

When healthy:
```
2
```

When API is down:
```
0
```

---

### 2.6 infra/schema-registry/register-schemas.sh (3 usages)

**Purpose:** Register JSON schemas with the Confluent Schema Registry for Kafka topic validation.

#### Snippet 1: Schema Payload Generation (File Read + JSON Escape)

- **Location:** `infra/schema-registry/register-schemas.sh:72-77`
- **Pattern:** File processing

```bash
payload=$(python3 -c "
import json
with open('$schema_file') as f:
    schema = f.read().strip()
print(json.dumps({'schemaType': 'JSON', 'schema': schema}))
")
```

**What the Python does:**

| Line | Action |
|------|--------|
| `with open('$schema_file') as f:` | Open the JSON schema file (path interpolated by bash) |
| `schema = f.read().strip()` | Read the entire file content as a string |
| `json.dumps({'schemaType': 'JSON', 'schema': schema})` | Wrap in the Schema Registry envelope, properly JSON-escaping the schema content |

- **Input:** A JSON schema file on disk (e.g., `schemas/order-created-value.json`)
- **Output:** Schema Registry payload JSON where the schema content is a JSON-escaped string inside a wrapper object
- **Condition:** Runs for each subject/schema pair in the `SUBJECTS` array
- **Why Python:** The schema file content must be JSON-escaped (quotes, newlines, backslashes) and embedded as a string value inside another JSON object. Bash cannot safely escape arbitrary JSON content.

This is the most complex snippet -- it solves the "JSON inside JSON" escaping problem that would be fragile or impossible with `sed`/`awk`.

**Expected Output:**

Input file (`schemas/order-created-value.json`):
```json
{
  "type": "object",
  "title": "Application Event — order.created",
  "properties": {
    "orderId": { "type": "string", "format": "uuid" },
    "userId": { "type": "string" },
    "items": { "type": "array", ... }
  }
}
```

Output (the schema content is JSON-escaped and embedded as a string):
```json
{
  "schemaType": "JSON",
  "schema": "{\n  \"type\": \"object\",\n  \"title\": \"Application Event \\u2014 order.created\",\n  \"properties\": {\n    \"orderId\": { \"type\": \"string\", \"format\": \"uuid\" },\n    ..."
}
```

---

#### Snippet 2: Schema ID Extraction

- **Location:** `infra/schema-registry/register-schemas.sh:92`
- **Pattern:** JSON field extraction

```bash
schema_id=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','?'))" 2>/dev/null || echo "?")
```

- **Input:** Schema Registry registration response JSON (`{"id":1}`)
- **Output:** Schema ID integer or `?` on failure

**Expected Output:**

When registration succeeds:
```
1
```
(or `2`, `3`, etc. -- the schema version ID returned by the registry)

When registration fails:
```
?
```

---

#### Snippet 3: Subject List Pretty-Printing

- **Location:** `infra/schema-registry/register-schemas.sh:103-108`
- **Pattern:** JSON field extraction (array iteration with sorting)

```bash
kubectl exec -n infra $SR_POD -- curl -sf "${SR_URL}/subjects" | python3 -c "
import sys, json
subjects = json.load(sys.stdin)
for s in sorted(subjects):
    print(f'  - {s}')
" 2>/dev/null || warn "Could not list subjects"
```

- **Input:** JSON array of subject names (`["order-created-value","inventory-updated-value",...]`)
- **Output:** Sorted, indented list printed to stdout
- **Why Python:** Sorting a JSON array and formatting each element requires parsing. Bash `sort` operates on lines, not JSON array elements.

**Expected Output:**

```
  - ecom-connector.public.books-value
  - ecom-connector.public.order_items-value
  - ecom-connector.public.orders-value
  - inventory-connector.public.inventory-value
  - inventory.updated-value
  - order.created-value
```

---

### 2.7 infra/debezium/register-connectors.sh (1 usage)

**Purpose:** Wait for Debezium Server instances to become healthy.

#### Snippet 1: Debezium Health Status

- **Location:** `infra/debezium/register-connectors.sh:30-32`
- **Pattern:** JSON field extraction

```bash
status=$(curl -sf "${url}/q/health" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null \
  || echo "")
```

- **Input:** Debezium Server health JSON
- **Output:** String `UP` or empty
- **Condition:** Called in a polling loop (`_wait_healthy`) that retries up to 60 times

**Expected Output:**

When healthy:
```
UP
```

When Debezium is down:
```
(empty string)
```

---

### 2.8 csrf-service/scripts/csrf-service-up.sh (2 usages)

**Purpose:** Build and deploy the CSRF validation service, including Istio integration.

#### Snippet 1: Istio extensionProvider Registration

- **Location:** `csrf-service/scripts/csrf-service-up.sh:75-95`
- **Pattern:** YAML+JSON ConfigMap manipulation
- **Condition:** Only if `csrf-ext-authz` not already in mesh config (checked via `grep -q` on line 71)

```bash
kubectl get configmap istio -n istio-system -o json | python3 -c "
import sys, json, yaml
cm = json.load(sys.stdin)
mesh = yaml.safe_load(cm['data']['mesh'])
if 'extensionProviders' not in mesh:
    mesh['extensionProviders'] = []
existing = [p for p in mesh['extensionProviders'] if p.get('name') == 'csrf-ext-authz']
if not existing:
    mesh['extensionProviders'].append({
        'name': 'csrf-ext-authz',
        'envoyExtAuthzHttp': {
            'service': 'csrf-service.infra.svc.cluster.local',
            'port': 8080,
            'failOpen': True,
            'headersToUpstreamOnAllow': [],
            'includeRequestHeadersInCheck': ['authorization', 'x-csrf-token'],
        }
    })
cm['data']['mesh'] = yaml.dump(mesh, default_flow_style=False)
json.dump(cm, sys.stdout)
" | kubectl apply -f -
```

This is the same logic as `up.sh` snippet 1 but with an additional defensive check: it filters the existing `extensionProviders` list for a matching `name` before appending (line 81). This makes it safe to run even if the outer `grep -q` check had a false negative.

- **Input:** Istio ConfigMap JSON
- **Output:** Modified ConfigMap JSON with csrf-ext-authz provider
- **Why Python:** Same as up.sh -- YAML inside JSON requires dual parsing.

**Expected Output:**

Same as up.sh Snippet 1 -- the resulting `data.mesh` YAML will contain the `csrf-ext-authz` extensionProvider. See the expected output under [Snippet 1: Istio extensionProvider Registration](#snippet-1-istio-extensionprovider-registration) above.

---

#### Snippet 2: Gateway Egress NetworkPolicy Patch

- **Location:** `csrf-service/scripts/csrf-service-up.sh:176-184`
- **Pattern:** NetworkPolicy JSON patching
- **Condition:** Only if gateway-egress exists and does not contain `csrf-service` (line 172)

```bash
echo "$GATEWAY_EGRESS" | python3 -c "
import sys, json
pol = json.load(sys.stdin)
pol['spec']['egress'].insert(0, {
    'to': [{'podSelector': {'matchLabels': {'app': 'csrf-service'}}}],
    'ports': [{'port': 8080, 'protocol': 'TCP'}]
})
json.dump(pol, sys.stdout)
" | kubectl apply -f -
```

- **Input:** NetworkPolicy JSON from `$GATEWAY_EGRESS` variable
- **Output:** Modified NetworkPolicy JSON with csrf-service egress rule at position 0
- **Why Python:** Same as up.sh snippet 2 -- array insertion in JSON requires parsing.

**Expected Output:**

Same as up.sh Snippet 2 -- the resulting NetworkPolicy will have the csrf-service egress rule inserted at position 0. See the expected output under [Snippet 2: Gateway Egress NetworkPolicy Patch](#snippet-2-gateway-egress-networkpolicy-patch) above.

---

## 3. Pattern Catalog

### Pattern 1: JSON Field Extraction (10 usages)

The most common pattern. Extracts a single field from a JSON API response.

**Canonical example:**

```bash
VALUE=$(curl -s http://api/endpoint \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('key', 'default'))" \
  2>/dev/null || echo "fallback")
```

**When to use:** Any time you need a single value from a JSON response in a bash variable.

**Common gotchas:**
- Always include `2>/dev/null` after the Python command to suppress parse errors on malformed input
- Always include `|| echo "fallback"` to handle cases where curl or Python fails entirely
- Use `.get('key', 'default')` rather than `['key']` to avoid KeyError on missing fields

**Variations seen:**
- `len(json.load(sys.stdin))` -- count array elements
- `sum(1 for j in d.get('jobs',[]) if j['state']=='RUNNING')` -- filtered count

---

### Pattern 2: YAML+JSON ConfigMap Edit (3 usages)

Modifies an Istio ConfigMap that contains embedded YAML inside a JSON structure.

**Canonical example:**

```bash
kubectl get configmap NAME -n NAMESPACE -o json | python3 -c "
import sys, json, yaml
cm = json.load(sys.stdin)
mesh = yaml.safe_load(cm['data']['mesh'])
# ... modify mesh dict ...
cm['data']['mesh'] = yaml.dump(mesh, default_flow_style=False)
json.dump(cm, sys.stdout)
" | kubectl apply -f -
```

**When to use:** When you need to modify Istio mesh configuration or any ConfigMap with embedded YAML.

**Common gotchas:**
- Requires PyYAML (`yaml` module) -- verify it is available: `python3 -c "import yaml"`
- Use `yaml.safe_load` (not `yaml.load`) to avoid arbitrary code execution
- Use `default_flow_style=False` in `yaml.dump` to produce human-readable block-style YAML
- Always check for the key's existence before appending to avoid duplicates

---

### Pattern 3: NetworkPolicy JSON Patch (2 usages)

Reads a NetworkPolicy, inserts a rule, and reapplies it.

**Canonical example:**

```bash
kubectl get networkpolicy NAME -n NAMESPACE -o json | python3 -c "
import sys, json
pol = json.load(sys.stdin)
pol['spec']['egress'].insert(0, {
    'to': [{'podSelector': {'matchLabels': {'app': 'target-app'}}}],
    'ports': [{'port': 8080, 'protocol': 'TCP'}]
})
json.dump(pol, sys.stdout)
" | kubectl apply -f -
```

**When to use:** When you need to programmatically add rules to an existing NetworkPolicy without replacing the entire spec.

**Common gotchas:**
- `insert(0, ...)` places the rule at the front -- Kubernetes evaluates rules in order
- Always store the JSON in a variable first and check for existence/duplicates before patching
- The full resource (including metadata, apiVersion, etc.) must be preserved -- `json.load`/`json.dump` handles this naturally

---

### Pattern 4: Token Extraction (2 usages)

Extracts JWT access tokens from Keycloak OIDC token responses.

**Canonical example:**

```bash
TOKEN=$(curl -sk -X POST "https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=ui-client&username=USER&password=PASS" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo "")
```

**When to use:** When you need to obtain a JWT from Keycloak for API testing in shell scripts.

**Common gotchas:**
- JWTs contain dots, equals signs, and base64 characters that can confuse bash parameter expansion -- always quote the variable
- Use `-sk` with curl when the Keycloak endpoint uses a self-signed certificate
- Check for empty token before using it: `[[ -n "$TOKEN" ]]`

---

### Pattern 5: File Read + JSON Escape (1 usage)

Reads a file and embeds its content as a JSON-escaped string inside a wrapper object.

**Canonical example:**

```bash
payload=$(python3 -c "
import json
with open('path/to/schema.json') as f:
    schema = f.read().strip()
print(json.dumps({'schemaType': 'JSON', 'schema': schema}))
")
```

**When to use:** When a file's content must be embedded as a string value inside a JSON payload (e.g., Schema Registry, API gateways, configuration endpoints).

**Common gotchas:**
- `json.dumps()` handles all necessary escaping: quotes become `\"`, newlines become `\n`, backslashes become `\\`
- The file path is interpolated by bash into the Python code -- ensure the path does not contain single quotes
- Use `.strip()` to remove trailing newlines that could cause issues

---

## 4. Why Python Instead of jq/yq/bash

| Alternative | Limitation |
|-------------|-----------|
| `jq` | Not installed on all systems; cannot parse YAML; requires separate installation |
| `yq` | Not standard; multiple incompatible versions exist (kislyuk/yq vs mikefarah/yq) |
| `bash` string ops | Fragile for JSON; breaks on special characters, nested objects, arrays |
| `sed`/`awk` | Cannot safely manipulate JSON arrays or nested structures; no understanding of JSON syntax |
| `python3` | Pre-installed on macOS and Linux; handles JSON+YAML natively; safe string escaping; predictable error handling |

The key advantage of `python3 -c` is that it requires **zero additional dependencies** beyond the OS default Python installation. Every macOS and modern Linux distribution ships with Python 3 and the `json` module. The `yaml` module (PyYAML) is needed only for the 3 ConfigMap manipulation snippets and is available in the project's Python environment.

---

## 5. Summary Table

| Script | Usages | Patterns Used | Input Sources | Output Types |
|--------|--------|---------------|---------------|--------------|
| `scripts/up.sh` | 3 | YAML+JSON, JSON patch, field extract | ConfigMap, NetworkPolicy, health API | Modified K8s objects, status strings |
| `scripts/smoke-test.sh` | 3 | Field extract, token parse | Health API, Keycloak token API | Status strings, JWT tokens |
| `scripts/full-stack-test.sh` | 4 | Field extract, array ops | Various APIs (ecom, cert-dashboard, Debezium, Flink) | Counts, status strings |
| `scripts/sanity-test.sh` | 1 | Field extract | Health API | Status string |
| `scripts/cert-dashboard-up.sh` | 1 | Field extract | Dashboard API | Count |
| `infra/schema-registry/register-schemas.sh` | 3 | File read+escape, field extract, array pretty-print | Schema files, registration API | JSON payload, IDs, formatted list |
| `infra/debezium/register-connectors.sh` | 1 | Field extract | Health API | Status string |
| `csrf-service/scripts/csrf-service-up.sh` | 2 | YAML+JSON, JSON patch | ConfigMap, NetworkPolicy | Modified K8s objects |
| **Total** | **18** | **5 patterns** | | |

---

## 6. Quick Reference: Adding New Python Snippets

When adding a new inline Python snippet to a shell script, follow these conventions:

1. **Always include error handling:** `2>/dev/null || echo "fallback"`
2. **Use `.get()` not `[]`:** Prevents KeyError on unexpected responses
3. **Keep it single-purpose:** Each snippet should do one thing
4. **Quote the variable capture:** `VAR=$(...)`
5. **Use `sys.stdin`:** Pipe data in rather than passing as arguments (avoids shell escaping issues)
6. **Test with malformed input:** Ensure the fallback value is returned when the API is down or returns HTML errors
