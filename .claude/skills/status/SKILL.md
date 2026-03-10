---
name: status
description: Show full cluster status — pods, endpoints, Flink jobs, Debezium health
disable-model-invocation: true
argument-hint: [namespace]
allowed-tools: Bash
---

Show the current state of the bookstore platform.

## Steps

If a specific namespace is provided via `$ARGUMENTS`, show pods for that namespace only. Otherwise show everything.

1. **Pod status** — all namespaces (exclude kube-system, local-path-storage for brevity):
```bash
kubectl get pods -A --no-headers 2>/dev/null | grep -v kube-system | grep -v local-path-storage
```

2. **Non-running pods** (highlight problems):
```bash
kubectl get pods -A --no-headers 2>/dev/null | grep -v Running | grep -v Completed
```

3. **Key endpoints** — check HTTP status:
   - Books API: `http://api.service.net:30000/ecom/books`
   - UI: `http://myecom.net:30000/`
   - Keycloak: `http://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration`
   - Inventory: `http://api.service.net:30000/inven/health`
   - Superset: `http://localhost:32000/health`
   - Kiali: `http://localhost:32100/kiali/`
   - Flink: `http://localhost:32200/overview`
   - Grafana: `http://localhost:32500/api/health`
   - Debezium ecom: `http://localhost:32300/q/health`
   - Debezium inventory: `http://localhost:32301/q/health`
   - PgAdmin: `http://localhost:31111/misc/ping`
   - Keycloak Admin: `http://localhost:32400/admin/`

4. **Flink jobs**:
```bash
curl -s http://localhost:32200/jobs 2>/dev/null
```

5. Present a summary table with status indicators.
