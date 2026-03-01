# BookStore App Restart Guide

## The Problem: "upstream connect error or disconnect/reset before headers"

After restarting Docker Desktop, the entire stack fails with Istio's error:

```
upstream connect error or disconnect/reset before headers. reset reason: connection termination
```

All HTTP routes (API, UI, Keycloak) return 503 or time out. This is not a code bug — it is three independent infrastructure failures that must all be resolved together.

---

## Root Cause Analysis

### Root Cause 1: Stale HBONE registrations in Istio Ambient mesh

**What happens:** Istio Ambient mesh uses `ztunnel` (a DaemonSet) to implement mTLS tunneling via the HBONE protocol (HTTP/2 CONNECT on port 15008). When Docker restarts, all kind node containers restart, which restarts ztunnel. Ztunnel programs iptables rules on each node to intercept traffic and tunnel it. After a restart, **ztunnel clears and reprograms its iptables rules — but existing long-lived pods do not trigger re-registration**.

**Symptom:** ztunnel logs show:
```
error="connection failed: deadline has elapsed" dst.addr=10.244.2.35:15008
```
This means the gateway is trying to reach a pod via HBONE but ztunnel on that node has no iptables rule for that pod's HBONE inbound traffic.

**Fix:** Restart ztunnel first (to get a clean iptables state), then roll-restart every workload pod so each one registers fresh with the new ztunnel instance. DBs must restart before apps (apps run Liquibase/Alembic migrations on startup).

### Root Cause 2: Kafka topics lost on pod restart

**What happens:** Kafka is running in KRaft mode without persistent topic storage (outstanding item). After Docker restart, Kafka's pod restarts and loses all topics — including the internal Kafka Connect topics (`debezium.configs`, `debezium.offsets`, `debezium.status`) that store Debezium connector configurations.

**Symptom:** `GET /connectors` returns `[]` even though connectors were registered before.

**Fix:** Re-register the Debezium CDC connectors after restart.

### Root Cause 3: Debezium connector registration subtlety

**What happens:** The connector JSON files use the `${file:/path/to/secret}` syntax (Kafka Connect FileConfigProvider) for credentials. This syntax is only expanded at **task startup**, not during **connector validation**. Kafka Connect validates the connector config before storing it by attempting a live DB connection — using the literal `${file:...}` string as the username, which fails PostgreSQL authentication.

Additionally, the connector JSON files use the full `{"name": "...", "config": {...}}` wrapper format, which is correct for `POST /connectors` but **not** for `PUT /connectors/{name}/config` (which expects just the flat config object).

**Symptom:**
```
Failed testing connection for jdbc:postgresql://... with user '${file:/opt/kafka/...}'
FATAL: password authentication failed for user "${file:/opt/kafka/...}"
```

**Fix:** At re-registration time, extract actual credentials from the Kubernetes secret and inject them inline. Use `PUT /connectors/{name}/config` with only the config object (no outer wrapper). The credentials are stored in the Kafka config topic; FileConfigProvider continues to work for running tasks that read from mounted secret files.

---

## The Quick Fix

```bash
bash scripts/up.sh
```

`up.sh` auto-detects the scenario:
- **No kind cluster found** → full bootstrap from scratch
- **Cluster exists** → recovery mode: ztunnel restart + rolling pod restarts + connector re-registration + smoke test

---

## Manual Step-by-Step Recovery

If you need to understand or debug each step individually:

### Step 1 — Restart ztunnel

```bash
kubectl rollout restart daemonset/ztunnel -n istio-system
kubectl rollout status daemonset/ztunnel -n istio-system --timeout=90s
sleep 10   # allow mesh to stabilize before restarting pods
```

### Step 2 — Restart DB pods first

Apps run migrations (Liquibase, Alembic) on startup, so DBs must be ready before apps.

```bash
kubectl rollout restart deploy/ecom-db -n ecom
kubectl rollout restart deploy/inventory-db -n inventory
kubectl rollout restart deploy/keycloak-db -n identity
kubectl rollout restart deploy/analytics-db -n analytics

kubectl rollout status deploy/ecom-db -n ecom --timeout=120s
kubectl rollout status deploy/inventory-db -n inventory --timeout=120s
kubectl rollout status deploy/keycloak-db -n identity --timeout=120s
kubectl rollout status deploy/analytics-db -n analytics --timeout=120s
```

### Step 3 — Restart all application pods

```bash
kubectl rollout restart deploy/ecom-service -n ecom
kubectl rollout restart deploy/inventory-service -n inventory
kubectl rollout restart deploy/ui-service -n ecom
kubectl rollout restart deploy/keycloak -n identity
kubectl rollout restart deploy/kafka -n infra
kubectl rollout restart deploy/redis -n infra
kubectl rollout restart deploy/debezium -n infra
kubectl rollout restart deploy/pgadmin -n infra
kubectl rollout restart deploy/flink-jobmanager -n analytics
kubectl rollout restart deploy/flink-taskmanager -n analytics
kubectl rollout restart deploy/superset -n analytics
kubectl rollout restart deploy/prometheus -n observability

# Wait for critical services
kubectl rollout status deploy/keycloak -n identity --timeout=180s
kubectl rollout status deploy/kafka -n infra --timeout=120s
kubectl rollout status deploy/debezium -n infra --timeout=180s
```

### Step 4 — Re-register Debezium connectors

```bash
# Wait for Debezium REST API (NodePort 32300)
until curl -sf http://localhost:32300/connectors > /dev/null 2>&1; do sleep 5; done

ECOM_USER=$(kubectl get secret -n infra debezium-db-credentials \
  -o jsonpath='{.data.ECOM_DB_USER}' | base64 -d)
ECOM_PASS=$(kubectl get secret -n infra debezium-db-credentials \
  -o jsonpath='{.data.ECOM_DB_PASSWORD}' | base64 -d)
INV_USER=$(kubectl get secret -n infra debezium-db-credentials \
  -o jsonpath='{.data.INVENTORY_DB_USER}' | base64 -d)
INV_PASS=$(kubectl get secret -n infra debezium-db-credentials \
  -o jsonpath='{.data.INVENTORY_DB_PASSWORD}' | base64 -d)

REPO=.
for entry in "ecom-connector:$ECOM_USER:$ECOM_PASS" "inventory-connector:$INV_USER:$INV_PASS"; do
  connector=${entry%%:*}; rest=${entry#*:}; user=${rest%%:*}; pass=${rest#*:}
  python3 -c "
import json
with open('${REPO}/infra/debezium/connectors/${connector}.json') as f:
    c = json.load(f)
c['config']['database.user'] = '$user'
c['config']['database.password'] = '$pass'
print(json.dumps(c['config']))
" | curl -sf -X PUT -H "Content-Type: application/json" --data @- \
    "http://localhost:32300/connectors/${connector}/config" > /dev/null
  echo "Registered $connector"
done
```

### Step 5 — Smoke test

```bash
bash scripts/smoke-test.sh
```

---

## Port Exposure: No Proxies Needed

All service ports are exposed directly via kind's `extraPortMappings` in `infra/kind/cluster.yaml`:

| Port  | Service           | URL                                |
|-------|-------------------|------------------------------------|
| 30000 | Main gateway      | `http://myecom.net:30000`          |
| 31111 | PgAdmin           | `http://localhost:31111`           |
| 32000 | Superset          | `http://localhost:32000`           |
| 32100 | Kiali             | `http://localhost:32100/kiali`     |
| 32200 | Flink dashboard   | `http://localhost:32200`           |
| 32300 | Debezium REST API | `http://localhost:32300/connectors`|

Kind maps each `containerPort` on the control-plane node to the corresponding `hostPort` on `127.0.0.1`. No Docker proxy containers (`socat`, `alpine/socat`) are needed or used.

> **Note:** These port mappings are baked into the kind cluster at creation time. If you are running an older cluster that was created before the `cluster.yaml` was updated, the mappings for 32100/32200/32300 will be missing. Run `bash scripts/down.sh && bash scripts/up.sh` to recreate the cluster with all port mappings.

---

## Why the Old Proxy Approach Was Fragile

The previous workaround used `docker run ... alpine/socat` proxy containers to bridge the host to the kind node:

```bash
docker run -d --name kiali-proxy --network kind -p 32100:32100 alpine/socat \
  TCP-LISTEN:32100,fork,reuseaddr TCP:172.19.0.4:32100
```

This had two critical problems:

1. **IP changes on Docker restart** — kind node IPs (e.g., `172.19.0.4`) are assigned by Docker's internal network and change after every Docker Desktop restart. The proxy containers would restart with `--restart unless-stopped` but keep their old CMD args pointing to the stale IP, causing silent connection failures.

2. **Additional moving part** — Three extra Docker containers (`kiali-proxy`, `flink-proxy`, `debezium-proxy`) that could fail independently and were not managed by Kubernetes.

The fix: add `extraPortMappings` directly to `infra/kind/cluster.yaml` for all required ports. Kind's own port mapping is stable across Docker restarts because it is part of the container's port binding (not an IP address).

---

## Debezium Connector JSON Format Reference

The files in `infra/debezium/connectors/` use the `POST /connectors` wrapper format:

```json
{
  "name": "ecom-connector",
  "config": { ... }
}
```

When using `PUT /connectors/{name}/config` (idempotent update), send **only** the `config` object:

```bash
# Correct — config object only
python3 -c "import json; c=json.load(open('ecom-connector.json')); print(json.dumps(c['config']))" \
  | curl -X PUT -H "Content-Type: application/json" --data @- \
    http://localhost:32300/connectors/ecom-connector/config
```

The `register-connectors.sh` script handles this correctly using `PUT` with extracted credentials.
