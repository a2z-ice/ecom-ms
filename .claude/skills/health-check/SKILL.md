---
name: health-check
description: Run comprehensive health check across all services, databases, CDC pipeline, and observability stack
disable-model-invocation: true
allowed-tools: Bash
---

Run a full health check of the bookstore platform.

## Steps

1. Check all pods:
```bash
echo "=== Non-Healthy Pods ==="
kubectl get pods --all-namespaces | grep -v Running | grep -v Completed | grep -v NAMESPACE || echo "All pods healthy!"
```

2. Check CNPG clusters:
```bash
echo "=== CNPG Clusters ==="
for ns_cluster in "ecom/ecom-db" "inventory/inventory-db" "analytics/analytics-db" "identity/keycloak-db"; do
  ns=${ns_cluster%/*}; cluster=${ns_cluster#*/}
  phase=$(kubectl get cluster "$cluster" -n "$ns" -o jsonpath='{.status.phase}' 2>/dev/null)
  ready=$(kubectl get cluster "$cluster" -n "$ns" -o jsonpath='{.status.readyInstances}' 2>/dev/null)
  echo "  $cluster: $phase (ready=$ready/2)"
done
```

3. Check Debezium + Flink:
```bash
echo "=== Debezium Health ==="
echo -n "  ecom: "; curl -s http://localhost:32300/q/health | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "DOWN"
echo -n "  inventory: "; curl -s http://localhost:32301/q/health | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "DOWN"
echo "=== Flink Jobs ==="
curl -s http://localhost:32200/jobs/overview | python3 -c "import sys,json; [print(f\"  {j['name']}: {j['state']}\") for j in json.load(sys.stdin)['jobs']]" 2>/dev/null || echo "  UNAVAILABLE"
```

4. Check external routes:
```bash
echo "=== Routes ==="
for url in "https://api.service.net:30000/ecom/books" "https://api.service.net:30000/inven/health" "https://idp.keycloak.net:30000/realms/bookstore" "https://myecom.net:30000"; do
  code=$(curl -sk -o /dev/null -w "%{http_code}" "$url" 2>/dev/null)
  echo "  $url → $code"
done
```

5. Check tool endpoints:
```bash
echo "=== Tools ==="
for svc_port in "superset:32000/health" "kiali:32100/kiali/api/status" "flink:32200" "grafana:32500/api/health" "cert-dashboard:32600/healthz"; do
  name=${svc_port%%:*}; rest=${svc_port#*:}
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$rest" 2>/dev/null)
  echo "  $name → $code"
done
```

6. Check pod restart counts:
```bash
echo "=== Pod Restarts ==="
kubectl get pods --all-namespaces -o json | python3 -c "
import sys,json
data=json.load(sys.stdin)
issues=[]
for p in data['items']:
  for c in p['status'].get('containerStatuses',[]):
    r=c.get('restartCount',0)
    if r>0: issues.append((r,p['metadata']['namespace'],p['metadata']['name']))
issues.sort(reverse=True)
for r,ns,n in issues[:10]: print(f'  {r:4d} restarts: {ns}/{n}')
if not issues: print('  No restarts!')
"
```

7. Report the health status and any issues found.
