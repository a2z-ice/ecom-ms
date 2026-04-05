---
name: fix-stability
description: Diagnose and fix the 7 known stability issues after up.sh — kafka-exporter missing, Kiali/Prometheus blocked, cert-dashboard missing, cart save() not flushing, gateway stale xDS, Istio Ambient non-mesh AuthZ denials
disable-model-invocation: true
allowed-tools: Bash, Read, Edit
---

Diagnose and fix the 7 recurring stability issues that appear after `bash scripts/up.sh` completes but some components are silently broken.

## Context

These issues are documented in detail at `docs/operations/up-sh-stability-fixes.md` and `html/up-sh-stability-fixes.html`. This skill runs the diagnostic checks and applies the fixes automatically.

## Diagnostic Matrix

Run all checks first, then apply only the fixes needed.

### Check 1 — kafka-exporter deployed
```bash
kubectl get deploy kafka-exporter -n infra -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "MISSING"
```
**Fix if missing:**
```bash
kubectl apply -f infra/kafka/kafka-exporter.yaml
kubectl rollout status deployment/kafka-exporter -n infra --timeout=120s
```

### Check 2 — Prometheus scrape targets healthy
```bash
# Prometheus must be able to scrape kafka-exporter
kubectl run -n observability curl-test --rm -i --restart=Never --image=curlimages/curl --timeout=10s -- \
  curl -s http://prometheus:9090/api/v1/targets 2>/dev/null \
  | python3 -c "import sys,json; t=json.load(sys.stdin)['data']['activeTargets']; bad=[x for x in t if x['health']!='up']; print(f'Unhealthy: {len(bad)}'); [print(' -', x['labels']['job'], x['lastError']) for x in bad]"
```
**Fix:** Usually resolved by Check 1 fix.

### Check 3 — Kiali can see Prometheus
```bash
curl -s http://localhost:32100/kiali/api/status 2>/dev/null \
  | python3 -c "import sys,json; svcs=[s['name'] for s in json.load(sys.stdin).get('externalServices',[])]; print('HAS_PROMETHEUS' if any('Prometheus' in s for s in svcs) else 'MISSING_PROMETHEUS')"
```
**Fix if MISSING_PROMETHEUS:**
1. Verify the Kiali config has `prometheus.url`:
```bash
kubectl get cm kiali -n istio-system -o yaml 2>/dev/null | grep -A1 "prometheus:" | grep "url:"
```
If missing, apply: `kubectl apply -f infra/observability/kiali/kiali-config-patch.yaml`

2. Verify the `prometheus-policy` AuthorizationPolicy uses ALLOW-ALL (`rules: [{}]`):
```bash
kubectl get authorizationpolicy prometheus-policy -n observability -o jsonpath='{.spec.rules}' 2>/dev/null
```
If it has `namespaces:` restrictions, apply: `kubectl apply -f infra/istio/security/authz-policies/observability-policy.yaml`

3. Check ztunnel for rejected connections:
```bash
kubectl logs -n istio-system -l app=ztunnel --tail=50 2>&1 | grep "policy rejection" | tail -3
```

4. Restart Kiali to force reconnection:
```bash
kubectl rollout restart deployment/kiali -n istio-system
kubectl rollout status deployment/kiali -n istio-system --timeout=60s
```

### Check 4 — cert-dashboard-operator deployed
```bash
kubectl get crd certdashboards.certs.bookstore.io 2>/dev/null >/dev/null && echo "OK" || echo "MISSING"
```
**Fix if MISSING:**
```bash
bash scripts/cert-dashboard-up.sh
```

### Check 5 — Cart increment works (backend bug)
```bash
# Quick test: verify POST /ecom/cart twice with same book increments quantity
TOKEN=$(curl -sk -X POST "https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=ui-client&username=user1&password=CHANGE_ME" \
  -H "Content-Type: application/x-www-form-urlencoded" 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))")

ECOM_POD=$(kubectl get pod -n ecom -l cnpg.io/cluster=ecom-db,cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n ecom "$ECOM_POD" -c postgres -- psql -U postgres -d ecomdb -c "DELETE FROM cart_items WHERE user_id='10db1335-9901-4fb5-bea7-947002ad938a'" 2>&1 >/dev/null

CSRF=$(curl -sk "https://api.service.net:30000/csrf/token" -H "Authorization: Bearer $TOKEN" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
R1=$(curl -sk -X POST "https://api.service.net:30000/ecom/cart" -H "Authorization: Bearer $TOKEN" -H "X-CSRF-Token: $CSRF" -H "Content-Type: application/json" -d '{"bookId":"00000000-0000-0000-0000-000000000002","quantity":1}' 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['quantity'])")

CSRF=$(curl -sk "https://api.service.net:30000/csrf/token" -H "Authorization: Bearer $TOKEN" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
R2=$(curl -sk -X POST "https://api.service.net:30000/ecom/cart" -H "Authorization: Bearer $TOKEN" -H "X-CSRF-Token: $CSRF" -H "Content-Type: application/json" -d '{"bookId":"00000000-0000-0000-0000-000000000002","quantity":1}' 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['quantity'])")

echo "First add qty=$R1, second add qty=$R2 (expected: 1, 2)"
[[ "$R2" == "2" ]] && echo "OK" || echo "BROKEN - cart not incrementing"
```
**Fix if BROKEN:** Verify `CartService.java` uses `saveAndFlush()` instead of `save()`:
```bash
grep -c "saveAndFlush" ecom-service/src/main/java/com/bookstore/ecom/service/CartService.java
# Should be 2 (one in each branch of addToCart)
```
If missing, apply the Hibernate 7 flush fix (see `docs/operations/up-sh-stability-fixes.md` Issue #5), then rebuild and reload the ecom-service image.

### Check 6 — Gateway xDS stream healthy
```bash
kubectl logs -n infra deploy/bookstore-gateway-istio --tail=20 2>&1 \
  | grep -E "xds-grpc closed since ([0-9]{3,})" | head -3
```
If output shows "closed since NNN seconds ago" where N > 60, the gateway has stale config.

**Fix:**
```bash
# Restart istiod first (may have expired workload certs)
kubectl rollout restart deploy/istiod -n istio-system
kubectl rollout status deploy/istiod -n istio-system --timeout=90s

# Restart ztunnel (HBONE plumbing)
kubectl rollout restart daemonset/ztunnel -n istio-system
kubectl rollout status daemonset/ztunnel -n istio-system --timeout=90s

# Restart gateway + re-patch NodePorts (Istio may reassign them)
kubectl rollout restart deploy/bookstore-gateway-istio -n infra
kubectl rollout status deploy/bookstore-gateway-istio -n infra --timeout=90s
kubectl patch svc bookstore-gateway-istio -n infra --type='merge' \
  -p='{"spec":{"ports":[{"name":"https","port":8443,"targetPort":8443,"nodePort":30000,"protocol":"TCP"},{"name":"http","port":8080,"targetPort":8080,"nodePort":30080,"protocol":"TCP"}]}}'

# Verify
sleep 10 && curl -sk --max-time 10 "https://api.service.net:30000/ecom/books" 2>&1 | head -c 100
```

### Check 7 — Workload certs not expired
```bash
kubectl logs -n istio-system -l app=ztunnel --tail=30 2>&1 | grep "CertificateExpired" | head -3
```
**Fix if certs expired:** Same as Check 6 (restart istiod → ztunnel → gateway).

## Quick All-in-One Diagnosis

Run this first to get a status summary:
```bash
echo "=== Platform Stability Check ==="
echo ""
echo "1. kafka-exporter:"
kubectl get deploy kafka-exporter -n infra -o jsonpath='{.status.readyReplicas}/{.spec.replicas}' 2>/dev/null && echo " ready" || echo "MISSING"
echo ""
echo "2. cert-dashboard CRD:"
kubectl get crd certdashboards.certs.bookstore.io --no-headers 2>/dev/null && echo "OK" || echo "MISSING"
echo ""
echo "3. Kiali → Prometheus:"
curl -s http://localhost:32100/kiali/api/status 2>/dev/null | python3 -c "import sys,json; svcs=[s['name'] for s in json.load(sys.stdin).get('externalServices',[])]; print('OK' if any('Prometheus' in s for s in svcs) else 'BROKEN')" 2>/dev/null || echo "Kiali unreachable"
echo ""
echo "4. Gateway xDS stream:"
kubectl logs -n infra deploy/bookstore-gateway-istio --tail=5 2>&1 | grep -E "xds-grpc closed since" | tail -1 || echo "OK (no recent xDS errors)"
echo ""
echo "5. Workload cert expiry errors:"
kubectl logs -n istio-system -l app=ztunnel --tail=50 2>&1 | grep -c "CertificateExpired" || echo "0"
echo ""
echo "6. Gateway reachability:"
curl -sk --max-time 5 -o /dev/null -w "HTTP %{http_code}" "https://api.service.net:30000/ecom/books" 2>&1
echo ""
```

## When to Use This Skill
- After `bash scripts/up.sh` completes but some dashboards show errors
- When Kiali dashboard is empty or says "No data"
- When E2E tests fail with `upstream request timeout` or kafka-exporter not found
- After Docker Desktop sleep/wake or day rollover
- Whenever the user reports "things are broken after up.sh"

## Related Docs
- Full post-mortem: `docs/operations/up-sh-stability-fixes.md`
- HTML version: `html/up-sh-stability-fixes.html`
- Memory: `memory/feedback_up_sh_stability_lessons.md`
