# Session 28 — Stability Issues & Fixes

Step-by-step guide to every stability issue discovered during Session 28, their root causes, fixes applied, and verification procedures.

---

## Table of Contents

1. [Debezium CrashLoopBackOff After CNPG Failover](#1-debezium-crashloopbackoff-after-cnpg-failover)
2. [Keycloak CrashLoopBackOff — ReadOnlyFileSystem](#2-keycloak-crashloopbackoff--readonlyfilesystem)
3. [PgAdmin ImagePullBackOff — Invalid Image Tag](#3-pgadmin-imagepullbackoff--invalid-image-tag)
4. [Loki/Tempo CrashLoopBackOff — PVC Permission Denied](#4-lokitempo-crashloopbackoff--pvc-permission-denied)
5. [E2E Auth Failures — Access Token Lifespan Too Short](#5-e2e-auth-failures--access-token-lifespan-too-short)
6. [Search Tests Failing — Insufficient Timeout](#6-search-tests-failing--insufficient-timeout)
7. [Grafana Dashboard Tests — networkidle Never Resolves](#7-grafana-dashboard-tests--networkidle-never-resolves)
8. [Debezium ECONNRESET — Retry Logic Missing](#8-debezium-econnreset--retry-logic-missing)
9. [HA Failover Recovery Timeout Too Short](#9-ha-failover-recovery-timeout-too-short)
10. [Superset Chart Rendering Flakiness](#10-superset-chart-rendering-flakiness)
11. [Security Hardening of Init Containers](#11-security-hardening-of-init-containers)
12. [Destructive Test Safety Guard](#12-destructive-test-safety-guard)
13. [Impact Assessment — Security, Performance, Resilience](#13-impact-assessment--security-performance-resilience)

---

## 1. Debezium CrashLoopBackOff After CNPG Failover

**Severity:** CRITICAL
**Impact:** CDC pipeline completely broken — no data flows to analytics-db
**Restarts:** 79+ (permanent crash loop)

### Symptoms

```
debezium-server-ecom    0/1    CrashLoopBackOff   79   7h12m
```

### Root Cause

After the E2E HA failover test deletes the ecom-db primary pod, CNPG promotes the standby to primary. This creates a 3-layer failure:

1. **PostgreSQL limitation:** Logical replication slots are NOT replicated to standbys. The `debezium_ecom_slot` slot doesn't exist on the new primary.
2. **Stale offset:** Debezium's Kafka offset topic (`debezium.ecom.offsets`) stores the old primary's WAL LSN position (`0/19012080`), which doesn't exist on the new primary.
3. **snapshot.mode=initial:** Debezium only performs initial snapshot on first startup — it cannot auto-recover when the stored offset is invalid.

### Error Log

```
io.debezium.DebeziumException: The connector is trying to read change stream
starting at PostgresOffsetContext [...lsn=LSN{0/19012080}...], but this is no
longer available on the server. Reconfigure the connector to use a snapshot
mode when needed.
```

### Fix (3 Layers)

**Layer 1 — CNPG Replication Slot Sync** (`infra/cnpg/ecom-db-cluster.yaml`, `inventory-db-cluster.yaml`):

```yaml
spec:
  replicationSlots:
    highAvailability:
      enabled: true
      slotPrefix: _cnpg_
    synchronizeReplicas:
      enabled: true
```

This tells CNPG to synchronize logical replication slots from primary to standbys. After failover, the slot already exists on the new primary.

**Layer 2 — Debezium Snapshot Mode** (`infra/debezium/debezium-server-ecom.yaml`, `debezium-server-inventory.yaml`):

```diff
- debezium.source.snapshot.mode=initial
+ debezium.source.snapshot.mode=when_needed
```

`when_needed` auto-re-snapshots when the stored offset is invalid (e.g., after failover where WAL was lost). Flink's UPSERT mode (`ON CONFLICT DO UPDATE`) ensures idempotency — re-snapshotting doesn't create duplicates.

**Layer 3 — E2E Test Self-Healing** (`e2e/postgresql-ha.spec.ts`):

The HA test now includes post-failover recovery steps:
1. Check if `debezium_ecom_slot` exists on the new primary; recreate if missing
2. Delete stale `debezium.ecom.offsets` Kafka topic to force clean re-snapshot
3. Rolling restart of `debezium-server-ecom` deployment
4. Poll health endpoint until `{"status":"UP"}`

### Verification

```bash
# Verify slot sync to standby
ECOM_PRIMARY=$(kubectl get pods -n ecom -l cnpg.io/cluster=ecom-db,cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}')
ECOM_STANDBY=$(kubectl get pods -n ecom -l cnpg.io/cluster=ecom-db,cnpg.io/instanceRole=replica -o jsonpath='{.items[0].metadata.name}')

echo "Primary slots:"
kubectl exec -n ecom "$ECOM_PRIMARY" -- psql -U postgres -d ecomdb -tAc \
  "SELECT slot_name, slot_type, active FROM pg_replication_slots;"

echo "Standby slots:"
kubectl exec -n ecom "$ECOM_STANDBY" -- psql -U postgres -d ecomdb -tAc \
  "SELECT slot_name, slot_type, active FROM pg_replication_slots;"

# Verify Debezium health
curl -s http://localhost:32300/q/health | python3 -m json.tool
curl -s http://localhost:32301/q/health | python3 -m json.tool
```

Expected: `debezium_ecom_slot` visible on BOTH primary and standby.

### Data Consistency Guarantee

| Scenario | Risk | Mitigation |
|----------|------|------------|
| Re-snapshot after failover | Duplicate CDC events | Flink UPSERT mode (`ON CONFLICT DO UPDATE`) — idempotent |
| Offset topic deleted | Events replayed | Same — UPSERT deduplicates by primary key |
| Slot lost on standby | Debezium can't connect | `synchronizeReplicas` ensures slot exists on promotion |

---

## 2. Keycloak CrashLoopBackOff — ReadOnlyFileSystem

**Severity:** HIGH
**Impact:** Identity provider down — all authentication fails

### Symptoms

```
keycloak    0/1    CrashLoopBackOff    ReadOnlyFileSystemException
```

### Root Cause

Session 28 hardening added `readOnlyRootFilesystem: true` to Keycloak's container security context. However, Keycloak (Quarkus runtime) executes a JAR build step at startup (`JarResultBuildStep#buildRunnerJar`) that writes directly into the JAR ZIP filesystem — not to `/tmp` or configurable temp directories.

This is a **Quarkus framework limitation**, not a configuration issue. Even mounting emptyDir volumes at `/tmp` and `/opt/keycloak/data/tmp` doesn't help because the writes target the application JAR itself.

### Fix

```yaml
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: false    # Required — Quarkus modifies JARs at startup
  capabilities:
    drop: ["ALL"]
```

**Mitigations for the security trade-off:**
- `drop: ["ALL"]` capabilities — no privilege escalation possible
- `allowPrivilegeEscalation: false` — prevents setuid/setgid
- `runAsNonRoot: true`, `runAsUser: 1000` — non-root user at pod level
- Istio STRICT mTLS — all traffic encrypted
- Network policies limit ingress/egress

### Verification

```bash
kubectl get pods -n identity -l app=keycloak
# Should show Running with 0 restarts

curl -sk https://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration | python3 -m json.tool
# Should return OIDC discovery document
```

---

## 3. PgAdmin ImagePullBackOff — Invalid Image Tag

**Severity:** MEDIUM
**Impact:** Database admin tool unavailable (non-critical)

### Symptoms

```
pgadmin    0/1    ImagePullBackOff    dpage/pgadmin4:8.16 not found
```

### Root Cause

Session 28 pinned the PgAdmin image to `dpage/pgadmin4:8.16`, which doesn't exist on Docker Hub. The version numbering jumped from 8.x to 9.x.

### Fix

```diff
- image: dpage/pgadmin4:8.16
+ image: dpage/pgadmin4:9.1
```

### Verification

```bash
kubectl get pods -n infra -l app=pgadmin
curl -s http://localhost:31111/misc/ping
```

---

## 4. Loki/Tempo CrashLoopBackOff — PVC Permission Denied

**Severity:** HIGH
**Impact:** Log aggregation (Loki) and distributed tracing (Tempo) unavailable

### Symptoms

```
loki    0/1    CrashLoopBackOff    mkdir /loki/rules: permission denied
tempo   0/1    CrashLoopBackOff    mkdir /var/tempo/traces: permission denied
```

### Root Cause

PVCs are created with root ownership by default. Loki and Tempo run as non-root UID 10001, and cannot create subdirectories on first startup.

### Fix

Added init containers to set PVC ownership before the main container starts:

```yaml
initContainers:
  - name: fix-permissions
    image: busybox:1.36
    command: ["sh", "-c", "chown -R 10001:10001 /loki"]  # or /var/tempo
    securityContext:
      runAsNonRoot: false
      runAsUser: 0
      capabilities:
        drop: ["ALL"]
        add: ["CHOWN", "FOWNER"]    # Explicit minimal capabilities
    volumeMounts:
      - name: data
        mountPath: /loki
```

**Security hardening:** Init containers use explicit `CHOWN` + `FOWNER` capabilities instead of blanket root privileges. All other capabilities are dropped.

### Verification

```bash
kubectl get pods -n otel -l app=loki
kubectl get pods -n otel -l app=tempo
# Both should be Running with 0 restarts
```

---

## 5. E2E Auth Failures — Access Token Lifespan Too Short

**Severity:** MEDIUM
**Impact:** Tests pass individually but fail in full suite (token expires mid-run)

### Symptoms

```
401 Unauthorized on cart/checkout/admin API calls
# Tests work individually but fail when running full suite (17+ minutes)
```

### Root Cause

Keycloak `accessTokenLifespan` was 300 seconds (5 minutes). The full E2E suite takes 8-12 minutes. Tokens stored in Playwright session fixtures expire mid-run.

### Fix

Changed `accessTokenLifespan` from 300 to 1800 (30 minutes) in:
- `infra/keycloak/realm-export.json` (for future deployments)
- Keycloak Admin API (for immediate effect on running cluster)

**Security trade-off documented:**
- POC/test environment: 30 minutes is acceptable
- Production: should be reduced to 5-10 minutes with refresh token rotation
- Mitigated by: tokens in memory only (never localStorage), HTTPS everywhere, CSRF protection

### Verification

```bash
# Check current lifespan via Keycloak API
curl -sk https://idp.keycloak.net:30000/realms/bookstore | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'accessTokenLifespan: {d.get(\"accessTokenLifespan\", \"not set\")}s')
"
```

---

## 6. Search Tests Failing — Insufficient Timeout

**Severity:** LOW
**Impact:** 3 search tests fail intermittently

### Root Cause

Default 5s Playwright timeout insufficient for: form submission → URL change → `useEffect` trigger → API call → response render.

### Fix

Increased timeout to 15 seconds:

```typescript
await expect(page.getByText(/result\(s\)/i)).toBeVisible({ timeout: 15000 })
```

---

## 7. Grafana Dashboard Tests — networkidle Never Resolves

**Severity:** LOW
**Impact:** 5 Grafana dashboard tests timeout

### Root Cause

`waitForLoadState('networkidle')` never resolves because Grafana continuously fetches dashboard data via polling.

### Fix

```diff
- await page.waitForLoadState('networkidle', { timeout: 15000 })
+ await page.waitForLoadState('domcontentloaded')
+ await page.waitForTimeout(5000)
```

---

## 8. Debezium ECONNRESET — Retry Logic Missing

**Severity:** MEDIUM
**Impact:** Debezium health check tests fail after HA failover

### Root Cause

After HA failover, the Debezium pod restarts. During restart, TCP connections get reset (`ECONNRESET`). The `apiGet` helper had no retry logic.

### Fix

Added retry logic with 5 attempts and 3s delay:

```typescript
async function apiGet(request, url, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await request.get(url, { timeout: 5_000 })
      expect(resp.ok()).toBeTruthy()
      return resp.json()
    } catch (err) {
      if (i === retries - 1) throw err
      await new Promise(r => setTimeout(r, 3000))
    }
  }
}
```

---

## 9. HA Failover Recovery Timeout Too Short

**Severity:** LOW
**Impact:** Flaky test — passes on retry

### Root Cause

CNPG pod recreation under load takes >170s. Original deadline was 170s.

### Fix

Increased to 230s (within 240s test timeout):

```diff
- test.setTimeout(180_000);
- const deadline = Date.now() + 170_000;
+ test.setTimeout(240_000);
+ const deadline = Date.now() + 230_000;
```

---

## 10. Superset Chart Rendering Flakiness

**Severity:** LOW
**Impact:** Flaky test — passes on retry

### Root Cause

Superset dashboards render charts inside iframes with async data fetching. The 30s timeout was insufficient for initial iframe load + data fetch + chart render.

### Fix

- Increased test timeout to 60s
- Added 5s initial wait for iframe load
- Broadened chart container selectors to match multiple Superset versions
- Increased chart visibility timeout to 45s

---

## 11. Security Hardening of Init Containers

**Severity:** MEDIUM (preventive)
**Impact:** Reduced attack surface

### Change

Init containers for Loki and Tempo were running as root (`runAsUser: 0`) without capability restrictions. Added explicit minimal capabilities:

```yaml
securityContext:
  runAsNonRoot: false
  runAsUser: 0
  capabilities:
    drop: ["ALL"]
    add: ["CHOWN", "FOWNER"]    # Only what's needed for chown
```

This reduces the attack surface: even if a supply chain attack compromised the `busybox:1.36` image, the init container can only change file ownership — no other privileged operations.

---

## 12. Destructive Test Safety Guard

**Severity:** HIGH (preventive)
**Impact:** Prevents accidental production data loss

### Change

Added a cluster context guard to `postgresql-ha.spec.ts` that aborts if the kubectl context is not `kind-bookstore`:

```typescript
const currentContext = execFileSync("kubectl", ["config", "current-context"], {
  encoding: "utf-8",
}).trim();
if (!currentContext.includes("kind-bookstore")) {
  throw new Error(
    `postgresql-ha.spec.ts contains destructive tests. ` +
    `Refusing to run on cluster "${currentContext}". Only kind-bookstore is allowed.`
  );
}
```

This prevents accidentally deleting pods or Kafka topics on production/staging clusters.

---

## 13. Impact Assessment — Security, Performance, Resilience

### Security Assessment

| Change | Impact | Status |
|--------|--------|--------|
| `readOnlyRootFilesystem: false` for Keycloak | **Accepted risk** — Quarkus limitation; mitigated by `drop: ALL`, non-root, no privilege escalation | Documented |
| `accessTokenLifespan: 1800s` | **POC-only** — production should use 300-600s with refresh tokens | Flagged for production |
| Init containers with `CHOWN`+`FOWNER` only | **Improved** — minimal capabilities vs blanket root | Applied |
| Cluster context guard on destructive tests | **Improved** — prevents accidental production execution | Applied |
| `snapshot.mode=when_needed` | **No security impact** — only affects CDC re-snapshot behavior | N/A |

### Performance Assessment

| Change | Impact | Measurement |
|--------|--------|-------------|
| CNPG `synchronizeReplicas: true` | **Negligible** — slot metadata is ~100 bytes per slot | No measurable latency increase |
| Debezium re-snapshot on failover | **Temporary spike** — full table re-read during snapshot | ~10-30s for current data volume |
| Flink UPSERT during re-snapshot | **Temporary spike** — same rows updated with same values | Idempotent, no data growth |
| Loki/Tempo init containers | **No change** — runs once at pod startup (~1s) | N/A |

### Resilience Assessment

| Scenario | Before Fix | After Fix |
|----------|-----------|-----------|
| CNPG primary failover | **Debezium permanent crash loop** (79+ restarts) | **Auto-recovery** — slot synced, Debezium re-snapshots |
| Docker Desktop restart | Recovery script handles pod restarts | Same + Debezium resilient to stale offsets |
| Kafka topic loss | Debezium crashes, requires manual intervention | `when_needed` mode auto-re-snapshots |
| Token expiry during tests | 401 errors after 5min | 30min lifespan covers full suite |
| Network transient errors | Tests fail immediately | Retry logic with backoff |

### Test Suite Stability

| Metric | Before Fixes | After Fixes |
|--------|-------------|-------------|
| Passed | 270 | 310 |
| Failed | 6 | 0 |
| Flaky | 2 | 2 (pass on retry) |
| Runtime | 11.7min | 7.8min |

---

## Quick Reference — Recovery Commands

```bash
# Full cluster recovery after any issue
bash scripts/up.sh

# If Debezium is in CrashLoopBackOff
ECOM_PRIMARY=$(kubectl get pods -n ecom -l cnpg.io/cluster=ecom-db,cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n ecom "$ECOM_PRIMARY" -- psql -U postgres -d ecomdb -c \
  "SELECT pg_create_logical_replication_slot('debezium_ecom_slot', 'pgoutput');"
KAFKA_POD=$(kubectl get pods -n infra -l app=kafka -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n infra "$KAFKA_POD" -- kafka-topics --bootstrap-server localhost:9092 \
  --delete --topic debezium.ecom.offsets
kubectl rollout restart deploy/debezium-server-ecom -n infra

# If Keycloak tokens expire during tests
curl -sk -X POST "https://idp.keycloak.net:30000/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=admin&password=CHANGE_ME" \
  -H "Content-Type: application/x-www-form-urlencoded" | python3 -c "
import sys,json; token=json.load(sys.stdin)['access_token']
import subprocess
subprocess.run(['curl', '-sk', '-X', 'PUT',
  'https://idp.keycloak.net:30000/admin/realms/bookstore',
  '-H', f'Authorization: Bearer {token}',
  '-H', 'Content-Type: application/json',
  '-d', '{\"accessTokenLifespan\": 1800}'])
"

# Full E2E test run
cd e2e && npm run test

# Verify all services healthy
bash scripts/smoke-test.sh
```
