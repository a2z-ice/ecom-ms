# Migrating the OTel Namespace from PERMISSIVE to STRICT mTLS

## Overview

The `otel` namespace currently uses **PERMISSIVE** mTLS because all three pods (OTel Collector, Loki, Tempo) have the annotation `ambient.istio.io/redirection: disabled`. This guide explains why PERMISSIVE is currently required and the exact steps to enforce STRICT mTLS.

---

## Why PERMISSIVE Is Required Today

### The Problem

All three otel pods have this annotation in their Deployment templates:

```yaml
annotations:
  ambient.istio.io/redirection: disabled
```

However, **Istio CNI overrides this annotation** in Ambient mode. If you inspect the running pods, they show `enabled`:

```bash
kubectl get pods -n otel -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.ambient\.istio\.io/redirection}{"\n"}{end}'
# Output: otel-collector-xxx   enabled
#         loki-xxx             enabled
#         tempo-xxx            enabled
```

Despite the override, the annotation has a side effect: it **prevents ztunnel from setting up proper HBONE listeners** on the destination (server) side. This means:

1. **Source ztunnel** (on the caller's node) wraps traffic in HBONE (port 15008) and attempts mTLS
2. **Destination ztunnel** (on the otel pod's node) receives the HBONE connection but has no proper listener for it (because the annotation partially inhibits setup)
3. With **PERMISSIVE**: ztunnel falls back to plaintext delivery when HBONE handshake fails → **works**
4. With **STRICT**: ztunnel requires a successful HBONE handshake, which fails → **connection timeout**

### Verified Behavior

When we tested STRICT on the otel namespace, ztunnel logged:

```
error="connection timed out, maybe a NetworkPolicy is blocking HBONE port 15008: deadline has elapsed"
```

This occurred even with HBONE port 15008 allowed in NetworkPolicy, confirming the issue is in ztunnel's HBONE listener setup, not NetworkPolicy.

### Current Security Model

Security is enforced by **NetworkPolicy** (CNI-level, independent of Istio):
- Default deny all ingress/egress (`otel-netpol.yaml`)
- Explicit allow per pod (OTel Collector, Loki, Tempo)
- HBONE port 15008 allowed for ztunnel tunneling

AuthorizationPolicies exist as defense-in-depth but are **not enforced** by ztunnel for pods with the annotation override.

---

## Prerequisites

Before starting, ensure:

1. All otel pods are running and healthy
2. E2E tests pass: `cd e2e && npx playwright test otel-loki.spec.ts --reporter=list`
3. Grafana dashboards show data (Loki logs + Tempo traces working)
4. No active incidents in the cluster

---

## Step-by-Step Migration

### Step 1: Understand the Annotation Removal Impact

Removing `ambient.istio.io/redirection: disabled` means:
- ztunnel will fully manage HBONE listeners on these pods
- All traffic to/from these pods will be mTLS-encrypted via HBONE
- The pods' application-level connections (HTTP/gRPC) will be wrapped in mTLS transparently
- AuthorizationPolicies in `otel-policy.yaml` will now be **actively enforced** by ztunnel

**What could break:**
- OTel Collector uses `insecure: true` in its exporter config to connect to Tempo/Loki. With full mesh enrollment, ztunnel handles mTLS transparently at L4, so `insecure: true` at the application level is fine — the pod sends plaintext, ztunnel encrypts it.
- Prometheus scraping OTel Collector metrics (ports 8888/8889) from the `observability` namespace. This should work since the observability namespace is already mesh-enrolled with STRICT mTLS.
- Grafana querying Loki (3100) and Tempo (3200). Grafana is mesh-enrolled, so source-side HBONE will work. Destination-side HBONE will now also work (annotation removed).

### Step 2: Remove the `disabled` Annotation from OTel Collector

Edit `infra/observability/otel-collector.yaml`:

```yaml
# BEFORE (line 18-20):
    metadata:
      labels:
        app: otel-collector
      annotations:
        # Exclude from Istio ambient mesh — services send plain gRPC to the collector
        ambient.istio.io/redirection: disabled

# AFTER:
    metadata:
      labels:
        app: otel-collector
      # annotation removed — fully mesh-enrolled for STRICT mTLS
```

### Step 3: Remove the `disabled` Annotation from Loki

Edit `infra/observability/loki/loki.yaml`:

```yaml
# BEFORE (line 63-65):
    metadata:
      labels:
        app: loki
      annotations:
        ambient.istio.io/redirection: disabled

# AFTER:
    metadata:
      labels:
        app: loki
      # annotation removed — fully mesh-enrolled for STRICT mTLS
```

### Step 4: Remove the `disabled` Annotation from Tempo

Edit `infra/observability/tempo/tempo.yaml`:

```yaml
# BEFORE (line 49-54):
    metadata:
      labels:
        app: tempo
      annotations:
        # Exclude Tempo from Istio ambient mesh — OTel Collector sends plain OTLP HTTP
        # and ztunnel interferes with the connection (connection reset on gRPC/HTTP)
        ambient.istio.io/redirection: disabled

# AFTER:
    metadata:
      labels:
        app: tempo
      # annotation removed — fully mesh-enrolled for STRICT mTLS
```

### Step 5: Change PeerAuthentication to STRICT

Edit `infra/istio/security/peer-auth.yaml` — find the otel namespace section:

```yaml
# BEFORE:
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: permissive-mtls
  namespace: otel
spec:
  mtls:
    mode: PERMISSIVE

# AFTER:
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: strict-mtls
  namespace: otel
spec:
  mtls:
    mode: STRICT
```

Also remove the inline PERMISSIVE PeerAuthentication in `scripts/infra-up.sh` (lines 122-131):

```bash
# REMOVE this entire block from infra-up.sh:
cat <<'OTEL_PA' | kubectl apply -f -
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: permissive-mtls
  namespace: otel
spec:
  mtls:
    mode: PERMISSIVE
OTEL_PA
```

Replace with:

```bash
# OTel PeerAuthentication is managed by infra/istio/security/peer-auth.yaml — no inline override needed.
```

### Step 6: Update AuthorizationPolicies (Already Correct)

The existing AuthorizationPolicies in `infra/istio/security/authz-policies/otel-policy.yaml` are already correct. Once the annotation is removed, ztunnel will enforce them:

| Policy | Allows From |
|--------|-------------|
| `otel-collector-policy` | ecom, inventory, observability |
| `loki-policy` | otel (collector), observability (Grafana) |
| `tempo-policy` | otel (collector), observability (Grafana) |

**Verify these match your data flow.** Any namespace not listed will be denied.

### Step 7: Review NetworkPolicies (No Changes Needed)

The NetworkPolicies in `infra/kubernetes/network-policies/otel-netpol.yaml` already include HBONE port 15008. No changes required — they will continue to work with STRICT mTLS.

### Step 8: Apply Changes

Apply in this order — PeerAuth first (while annotation still blocks STRICT enforcement), then manifests, then rolling restart:

```bash
# 1. Apply updated PeerAuthentication
kubectl apply -f infra/istio/security/peer-auth.yaml

# 2. Apply updated Deployments (annotation removed)
kubectl apply -f infra/observability/otel-collector.yaml
kubectl apply -f infra/observability/loki/loki.yaml
kubectl apply -f infra/observability/tempo/tempo.yaml

# 3. Force pod restart to pick up annotation changes
kubectl rollout restart deployment otel-collector -n otel
kubectl rollout restart deployment loki -n otel
kubectl rollout restart deployment tempo -n otel

# 4. Wait for all pods to be ready
kubectl rollout status deployment otel-collector -n otel --timeout=120s
kubectl rollout status deployment loki -n otel --timeout=120s
kubectl rollout status deployment tempo -n otel --timeout=120s
```

### Step 9: Verify Annotation Removal

```bash
kubectl get pods -n otel -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.ambient\.istio\.io/redirection}{"\n"}{end}'
```

**Expected**: Either no annotation at all, or `enabled` (without the `disabled` override).

### Step 10: Verify HBONE Connectivity

Check ztunnel logs for successful HBONE connections (no timeouts):

```bash
# Check ztunnel on the node where otel pods run
kubectl logs -n istio-system -l app=ztunnel --tail=50 | grep -E "(otel|loki|tempo)" | grep -v "error"
```

**Expected**: `dst.hbone_addr=...` entries showing successful HBONE connections.

### Step 11: Test Data Flow

```bash
# 1. Grafana → Loki (log query)
kubectl exec -n observability deploy/grafana -- wget -qO- --timeout=5 "http://loki.otel.svc.cluster.local:3100/ready"
# Expected: "ready"

# 2. Grafana → Tempo (trace query)
kubectl exec -n observability deploy/grafana -- wget -qO- --timeout=5 "http://tempo.otel.svc.cluster.local:3200/ready"
# Expected: "ready"

# 3. OTel Collector health
kubectl exec -n otel deploy/otel-collector -- wget -qO- --timeout=5 "http://localhost:13133/"
# Expected: {"status":"Server available"...}

# 4. Generate traffic to populate traces/logs
curl -s http://api.service.net:30000/ecom/books > /dev/null
curl -s http://api.service.net:30000/inven/stock/bulk?book_ids=00000000-0000-0000-0000-000000000001 > /dev/null

# 5. Wait 15s for OTel Collector to flush
sleep 15

# 6. Check Loki has labels (logs flowing)
kubectl exec -n observability deploy/grafana -- wget -qO- --timeout=5 "http://loki.otel.svc.cluster.local:3100/loki/api/v1/labels"
# Expected: JSON with labels like "service_name", "level"

# 7. Check Prometheus can still scrape OTel Collector
kubectl exec -n observability deploy/prometheus-server -- wget -qO- --timeout=5 "http://otel-collector.otel.svc.cluster.local:8889/metrics" | head -5
# Expected: Prometheus metrics output
```

### Step 12: Verify AuthorizationPolicy Enforcement

Test that unauthorized namespaces are blocked:

```bash
# This should FAIL (infra namespace is not in the allow list)
kubectl exec -n infra deploy/kafka -- bash -c "echo | timeout 3 bash -c 'cat > /dev/tcp/loki.otel.svc.cluster.local/3100'" 2>&1
# Expected: Connection refused or timeout

# This should SUCCEED (observability namespace is allowed)
kubectl exec -n observability deploy/grafana -- wget -qO- --timeout=5 "http://loki.otel.svc.cluster.local:3100/ready"
# Expected: "ready"
```

### Step 13: Run E2E Tests

```bash
cd e2e && npx playwright test otel-loki.spec.ts --reporter=list
```

**Expected**: All 43 tests pass.

### Step 14: Update Documentation

1. Update `infra/istio/security/peer-auth.yaml` comments to reflect STRICT
2. Update `infra/istio/security/authz-policies/otel-policy.yaml` comments — remove "defense-in-depth" wording since they're now actively enforced
3. Update `docs/guides/observability-issues-and-fixes.md` with the migration
4. Update `CLAUDE.md` otel namespace section

---

## Rollback Plan

If the migration fails (timeouts, broken data flow), rollback:

```bash
# 1. Revert PeerAuthentication to PERMISSIVE
kubectl apply -f - <<'EOF'
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: permissive-mtls
  namespace: otel
spec:
  mtls:
    mode: PERMISSIVE
EOF

# 2. Revert manifests (restore annotation) — use git
git checkout -- infra/observability/otel-collector.yaml
git checkout -- infra/observability/loki/loki.yaml
git checkout -- infra/observability/tempo/tempo.yaml
git checkout -- infra/istio/security/peer-auth.yaml
git checkout -- scripts/infra-up.sh

# 3. Re-apply and restart
kubectl apply -f infra/observability/otel-collector.yaml
kubectl apply -f infra/observability/loki/loki.yaml
kubectl apply -f infra/observability/tempo/tempo.yaml
kubectl rollout restart deployment otel-collector loki tempo -n otel
kubectl rollout status deployment otel-collector -n otel --timeout=120s
kubectl rollout status deployment loki -n otel --timeout=120s
kubectl rollout status deployment tempo -n otel --timeout=120s

# 4. Verify recovery
kubectl exec -n observability deploy/grafana -- wget -qO- --timeout=5 "http://loki.otel.svc.cluster.local:3100/ready"
```

---

## Known Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| ztunnel still doesn't set up HBONE listener properly after annotation removal | Low | High — all otel traffic breaks | Rollback plan above; test in isolation first |
| OTel Collector `insecure: true` config conflicts with ztunnel mTLS | Very Low | Medium — traces/logs lost | ztunnel handles mTLS at L4, app sees plaintext |
| Prometheus scraping breaks (port 8888/8889) | Low | Low — metrics only | observability namespace already STRICT + allowed in AuthzPolicy |
| Loki/Tempo storage data lost on restart | Expected | Low — emptyDir volumes | Logs/traces repopulate automatically after traffic resumes |
| ecom/inventory OTLP export to OTel Collector fails | Low | Medium — traces/logs lost | Both namespaces are STRICT + mesh-enrolled; should work |

---

## What Changes After Migration

| Aspect | Before (PERMISSIVE) | After (STRICT) |
|--------|---------------------|----------------|
| mTLS enforcement | Fallback to plaintext on HBONE failure | mTLS required; plaintext rejected |
| AuthorizationPolicy | Not enforced (defense-in-depth only) | Actively enforced by ztunnel |
| HBONE listener | Partially inhibited by annotation | Fully set up by ztunnel |
| NetworkPolicy | Primary security boundary | Still enforced (defense-in-depth with AuthzPolicy) |
| Pod annotation | `disabled` (overridden to `enabled`) | No annotation (natural `enabled`) |
| Lateral movement risk | Low (NetworkPolicy blocks) | Very Low (NetworkPolicy + AuthzPolicy + mTLS) |

---

## Summary

The migration requires exactly **4 file changes**:

1. `infra/observability/otel-collector.yaml` — remove annotation
2. `infra/observability/loki/loki.yaml` — remove annotation
3. `infra/observability/tempo/tempo.yaml` — remove annotation
4. `infra/istio/security/peer-auth.yaml` — change otel PERMISSIVE → STRICT
5. `scripts/infra-up.sh` — remove inline PERMISSIVE PeerAuthentication block

The key insight is that **the annotation is the root cause**, not the PeerAuthentication mode. Removing the annotation allows ztunnel to fully manage HBONE on these pods, which in turn allows STRICT to work. NetworkPolicies and AuthorizationPolicies require no changes.
