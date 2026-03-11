---
name: operator
description: Manage the cert-dashboard Kubernetes operator — build, test, deploy, rebuild, verify, and troubleshoot
disable-model-invocation: true
argument-hint: <action> [--no-cache]
allowed-tools: Bash, Read, Grep, Glob
---

Manage the cert-dashboard-operator (Go-based Kubernetes operator for cert-manager certificate monitoring and renewal).

## Arguments
`$ARGUMENTS` must be one of: `status`, `test`, `build`, `deploy`, `rebuild`, `logs`, `verify`, or `troubleshoot`.

## Project layout
```
cert-dashboard-operator/
  api/v1alpha1/           CRD types (CertDashboard)
  cmd/dashboard/          Dashboard binary entrypoint
  internal/controller/    Reconciler (creates Deployment + Service + RBAC)
  internal/dashboard/     HTTP server, handlers, cert watcher, auth, metrics
  internal/dashboard/templates/  Embedded HTML/CSS/JS (Go embed.FS)
  internal/webhook/       CRD validation webhook
  config/                 CRD, RBAC, manager manifests
  bundle/                 OLM bundle
  rebuild-deploy.sh       Mature rebuild/redeploy script
```

## Actions

### status
Show operator and dashboard pod status, CR readiness, and endpoint health.
```bash
echo "=== Pods ==="
kubectl get pods -n cert-dashboard -o wide
echo ""
echo "=== CertDashboard CR ==="
kubectl get certdashboard -n cert-dashboard -o wide
echo ""
echo "=== Endpoints ==="
echo -n "Health:  "; curl -s --max-time 5 http://localhost:32600/healthz
echo ""
echo -n "Certs:   "; curl -s --max-time 5 http://localhost:32600/api/certs | python3 -c "import sys,json; certs=json.load(sys.stdin); print(f'{len(certs)} certificates'); [print(f'  - {c[\"name\"]} ({c[\"namespace\"]}) status={c[\"status\"]}') for c in certs]"
echo ""
echo -n "Metrics: "; curl -s --max-time 5 http://localhost:32600/metrics | grep -c "cert_dashboard_"; echo " cert_dashboard_* metrics"
echo ""
echo "=== ClusterRole (tokenreviews) ==="
kubectl get clusterrole bookstore-certs-role -o jsonpath='{.rules}' 2>/dev/null | python3 -c "import sys,json; rules=json.load(sys.stdin); has_tr=[r for r in rules if 'tokenreviews' in r.get('resources',[])]; print('tokenreviews rule: PRESENT' if has_tr else 'tokenreviews rule: MISSING')"
```

### test
Run all Go tests (webhook, dashboard handlers, cert watcher, controller with envtest).
```bash
cd /Volumes/Other/rand/llm/microservice/cert-dashboard-operator
echo "=== go vet ==="
go vet ./...
echo ""
echo "=== Webhook tests ==="
go test ./internal/webhook/ -v -count=1
echo ""
echo "=== Dashboard tests ==="
go test ./internal/dashboard/ -v -count=1
echo ""
echo "=== Controller tests (envtest) ==="
make test
```

### build
Build Docker images (operator + dashboard share one image with different entrypoints).
Add `--no-cache` from `$ARGUMENTS` if present to force a clean build (required when Go embed.FS templates change).
```bash
cd /Volumes/Other/rand/llm/microservice/cert-dashboard-operator
# Check if --no-cache was requested
NO_CACHE=""
echo "$ARGUMENTS" | grep -q "no-cache" && NO_CACHE="--no-cache"
docker build $NO_CACHE -t bookstore/cert-dashboard-operator:latest .
docker tag bookstore/cert-dashboard-operator:latest bookstore/cert-dashboard:latest
echo "Image size: $(docker image inspect bookstore/cert-dashboard-operator:latest --format '{{.Size}}' | awk '{printf "%.0fMB", $1/1048576}')"
```

### deploy
Full deploy: test, build, load into kind, install OLM + CRD + operator + CR.
```bash
cd /Volumes/Other/rand/llm/microservice
bash scripts/cert-dashboard-up.sh
```

### rebuild
Rebuild and redeploy to a running cluster. Uses `--no-cache` and clears old images from kind nodes.
IMPORTANT: Required when changing Go embed.FS templates (HTML/CSS/JS) — cached Docker layers won't pick up embedded file changes.
```bash
cd /Volumes/Other/rand/llm/microservice/cert-dashboard-operator
bash rebuild-deploy.sh
```

### logs
Show operator and dashboard logs.
```bash
echo "=== Operator logs (last 50 lines) ==="
kubectl logs -n cert-dashboard -l app=cert-dashboard-operator --tail=50
echo ""
echo "=== Dashboard logs (last 50 lines) ==="
kubectl logs -n cert-dashboard -l app=cert-dashboard --tail=50
```

### verify
Run the 8 standard verification checks.
```bash
echo "1. Operator pod"
kubectl get pods -n cert-dashboard -l app=cert-dashboard-operator -o jsonpath='{.items[0].status.phase}'
echo ""
echo "2. Dashboard pod"
kubectl get pods -n cert-dashboard -l app=cert-dashboard -o jsonpath='{.items[0].status.phase}'
echo ""
echo "3. CR ready"
kubectl get certdashboard bookstore-certs -n cert-dashboard -o jsonpath='{.status.ready}'
echo ""
echo "4. Health endpoint"
curl -s --max-time 5 http://localhost:32600/healthz
echo ""
echo "5. Certs API"
curl -s --max-time 5 http://localhost:32600/api/certs | python3 -c "import sys,json; print(f'{len(json.load(sys.stdin))} certs')"
echo ""
echo "6. Metrics"
curl -s --max-time 5 http://localhost:32600/metrics | grep -c "cert_dashboard_"
echo " cert_dashboard_* metrics"
echo "7. Security: capabilities drop ALL"
kubectl get pod -n cert-dashboard -l app=cert-dashboard -o jsonpath='{.items[0].spec.containers[0].securityContext.capabilities.drop[0]}'
echo ""
echo "8. Security: seccomp RuntimeDefault"
kubectl get pod -n cert-dashboard -l app=cert-dashboard -o jsonpath='{.items[0].spec.securityContext.seccompProfile.type}'
echo ""
echo ""
echo "9. Auth: POST /api/renew without token"
curl -s -o /dev/null -w "HTTP %{http_code}" --max-time 5 -X POST http://localhost:32600/api/renew
echo " (expected 401)"
```

### troubleshoot
Diagnose common issues with the cert-dashboard operator.
```bash
echo "=== Pod events ==="
kubectl get events -n cert-dashboard --sort-by='.lastTimestamp' | tail -20
echo ""
echo "=== Operator pod describe (conditions + events) ==="
kubectl describe pod -n cert-dashboard -l app=cert-dashboard-operator 2>/dev/null | grep -A 20 "Conditions:"
echo ""
echo "=== Dashboard pod describe (conditions + events) ==="
kubectl describe pod -n cert-dashboard -l app=cert-dashboard 2>/dev/null | grep -A 20 "Conditions:"
echo ""
echo "=== ClusterRole rules ==="
kubectl get clusterrole bookstore-certs-role -o yaml 2>/dev/null | grep -A 5 "rules:" || echo "ClusterRole not found"
echo ""
echo "=== Operator RBAC ==="
kubectl get clusterrole cert-dashboard-operator -o yaml 2>/dev/null | grep -A 20 "rules:" || echo "Operator ClusterRole not found"
echo ""
echo "=== Images on kind nodes ==="
for node in bookstore-control-plane bookstore-worker bookstore-worker2; do
  echo "--- $node ---"
  docker exec "$node" crictl images 2>/dev/null | grep cert-dashboard || echo "  (no cert-dashboard images)"
done
echo ""
echo "=== OLM status ==="
kubectl get csv -n cert-dashboard 2>/dev/null || echo "No CSVs in cert-dashboard namespace"
echo ""
echo "=== cert-manager certificates ==="
kubectl get certificates -A 2>/dev/null
```

## Key facts
- **Namespace**: `cert-dashboard`
- **NodePort**: 32600 (exposed via kind extraPortMappings)
- **Dashboard URL**: `http://localhost:32600`
- **API endpoints**: `GET /healthz`, `GET /api/certs`, `POST /api/renew`, `GET /api/sse/{id}`, `GET /metrics`
- **Auth**: POST /api/renew requires Kubernetes ServiceAccount token via `Authorization: Bearer <token>` header
- **Token generation**: `kubectl create token bookstore-certs -n cert-dashboard --duration=10m`
- **Renewal mechanism**: Deletes the TLS secret; cert-manager re-issues automatically
- **Rate limit**: 1 renewal per 10 seconds globally; auth checked BEFORE rate limit
- **Single Docker image**: Both `/manager` (operator) and `/dashboard` entrypoints; tagged as both `bookstore/cert-dashboard-operator:latest` and `bookstore/cert-dashboard:latest`
- **Go embed.FS**: Templates in `internal/dashboard/templates/` are embedded at compile time. Changing HTML/CSS/JS requires `--no-cache` Docker build
- **Image caching gotcha**: kind nodes cache `:latest` tag. After rebuild, clear old images with `crictl rmi` on all 3 nodes before `kind load`
- **RBAC chain**: operator SA must hold tokenreviews/create permission to grant it to the dashboard's ClusterRole (Kubernetes escalation prevention)
- **E2E tests**: `e2e/cert-dashboard.spec.ts` (32 tests), `e2e/cert-dashboard-screenshots.spec.ts`, `e2e/cert-dashboard-usermanual-screenshots.spec.ts`
- **Go tests**: 44 total (controller 8, handlers 11, cert_watcher 7, webhook 9, + dashboard unit tests)
