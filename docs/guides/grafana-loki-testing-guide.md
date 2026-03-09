# Grafana + Loki Log Pipeline: Testing & Verification Guide

This guide walks you through manually verifying that application logs from **ecom-service** (Spring Boot) and **inventory-service** (FastAPI) are flowing through the OpenTelemetry pipeline into Grafana Loki, with step-by-step instructions and screenshots.

---

## Background: What Was Wrong and How It Was Fixed

### Problem 1 — No Logs in Loki (empty label filter dropdown)

Loki was deployed and running, but **no logs appeared** in the Grafana Loki Explore view. The label filter dropdown was completely empty — no `service_name`, no `level`, nothing.

**Root cause**: Both microservices had `OTEL_LOGS_EXPORTER=none` in their Kubernetes manifests. This meant the OTel agents (Java agent for ecom-service, Python SDK for inventory-service) were only sending **traces** to the OTel Collector. No log data was being exported at all, so Loki received zero log streams.

Additionally, the OTel Collector's `loki` exporter had no label mapping configured, so even if logs were sent, resource attributes like `service.name` would not have become Loki labels (they would have been embedded in the log body instead of being queryable labels).

### Problem 2 — Tempo Service Graph: "Datasource prometheus was not found"

Selecting **Tempo > Query type > Service Graph** in Grafana Explore showed:

> **Query error** — Datasource prometheus was not found

**Root cause**: Grafana's datasource provisioning config did not set explicit `uid` values for the Prometheus and Tempo datasources. Grafana auto-generated random UIDs (e.g. `PBFA97CFB590B2093` for Prometheus). However, Tempo's `serviceMap` cross-reference was configured as `datasourceUid: prometheus` — a literal string that did not match the auto-generated UID. The same issue affected the `tracesToLogsV2` link from Tempo to Loki (though Loki already had `uid: loki` set explicitly, so that one worked).

**Why it matters**: The Tempo Service Graph feature queries Prometheus for span metrics (`traces_spanmetrics_*`) to render the dependency graph between services. Without the correct Prometheus datasource reference, Grafana cannot find the metrics backend and the Service Graph panel fails entirely.

### Problem 3 — Service Health & Cluster Overview Dashboards: No Data

Both the **Service Health** and **Cluster Overview** dashboards in Grafana showed empty panels with no data.

**Root causes (Service Health)**: The original dashboard used `istio_requests_total` (L7 request metrics). In Istio **Ambient mode**, only ztunnel (L4) metrics are available — `istio_tcp_connections_opened_total`, `istio_tcp_sent_bytes_total`, etc. L7 metrics like `istio_requests_total` require a **waypoint proxy**, which is not deployed in this cluster.

**Root causes (Cluster Overview)**:
1. **kube-state-metrics not deployed** — `kube_pod_status_phase`, `kube_pod_container_status_restarts_total`, and other cluster state metrics were unavailable
2. **kubelet cAdvisor 403** — Prometheus ClusterRole was missing `nodes/proxy` resource, so cAdvisor scraping returned 403 Forbidden
3. **Prometheus couldn't scrape inventory-service** — Three layered issues:
   - NetworkPolicy in inventory namespace didn't allow ingress from observability namespace on port 15008 (HBONE tunnel)
   - AuthorizationPolicy on inventory-service only allowed `infra` and `ecom` namespaces — observability was implicitly denied
   - OTel Collector Service didn't expose port 8888 (internal metrics) — only the container had it

### The Fixes

**Fix 1 — Log Pipeline (8 files, Problems 1 & 2)**

| File | Change | Why |
|------|--------|-----|
| `ecom-service/k8s/ecom-service.yaml` | `OTEL_LOGS_EXPORTER` changed from `none` to `otlp`; added `OTEL_RESOURCE_ATTRIBUTES=service.namespace=ecom,deployment.environment=production` | The OTel Java agent auto-bridges Logback (Spring Boot's default logging framework) to OTLP when `OTEL_LOGS_EXPORTER=otlp` is set. No application code changes needed. The resource attributes enrich every log record with namespace and environment metadata. |
| `inventory-service/k8s/inventory-service.yaml` | Added `OTEL_LOGS_EXPORTER=otlp`, `OTEL_TRACES_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=none`, `OTEL_RESOURCE_ATTRIBUTES=service.namespace=inventory,deployment.environment=production` | Tells the Python OTel SDK to export logs via OTLP HTTP to the collector. |
| `inventory-service/app/main.py` | Added `LoggerProvider` + `LoggingHandler` from OTel Python SDK, attached to Python's root logger | Unlike the Java agent (which auto-bridges), Python requires explicit setup: create a `LoggerProvider` with `BatchLogRecordProcessor` + `OTLPLogExporter`, then attach a `LoggingHandler` to Python's `logging` root. This bridges every `logging.info(...)` call to OTel log records. |
| `infra/observability/otel-collector.yaml` | Added `resource/loki` processor with `loki.resource.labels` hint; added `default_labels_enabled` (job + level) to loki exporter; added `batch/logs` processor (2s flush); exposed port 8888 in Service | The `resource/loki` processor inserts a `loki.resource.labels` attribute telling the Loki exporter which resource attributes to promote to Loki stream labels. Without this, `service.name` would be buried inside the log body and not appear as a filterable label. Port 8888 exposure enables Prometheus to scrape OTel Collector internal metrics. |
| `infra/observability/loki/loki.yaml` | Pinned image to `grafana/loki:3.4.2` (was `latest`); added `allow_structured_metadata`, ingestion rate limits, analytics disabled | Production hardening. Pinned version prevents unexpected breaking changes. |
| `infra/observability/grafana/grafana.yaml` | Added explicit `uid: prometheus` and `uid: tempo` to datasource provisioning; added "Application Logs" dashboard (5 panels) | **Fixes Tempo Service Graph error.** Without explicit UIDs, Grafana auto-generates random ones (e.g. `PBFA97CFB590B2093`). Tempo's `serviceMap.datasourceUid: prometheus` then can't resolve to the actual Prometheus datasource. Setting `uid: prometheus` and `uid: tempo` makes all cross-datasource references (`tracesToLogsV2`, `serviceMap`, derived fields) resolve correctly. Also adds the logs dashboard. |
| `e2e/otel-loki.spec.ts` | New file — 43 E2E tests | Automated verification of the entire observability pipeline (logs, metrics, tracing, dashboards). |

**Fix 2 — Dashboard Metrics & Scraping (Problem 3)**

| File | Change | Why |
|------|--------|-----|
| `infra/observability/kube-state-metrics/kube-state-metrics.yaml` | NEW — deploys kube-state-metrics v2.13.0 | Provides `kube_pod_status_phase`, `kube_pod_container_status_restarts_total`, and other cluster state metrics for the Cluster Overview dashboard |
| `infra/observability/prometheus/prometheus.yaml` | Added 4 scrape configs: `inventory-service`, `otel-collector`, `kube-state-metrics`, `kubelet-cadvisor`; added `nodes/proxy` to ClusterRole | Enables Prometheus to scrape all targets. `nodes/proxy` is required for kubelet cAdvisor API proxy access |
| `infra/observability/grafana/grafana.yaml` | Service Health dashboard rewritten (7 panels using HTTP + mesh TCP metrics); Cluster Overview scoped to app namespaces | Service Health now uses `http_server_requests_seconds_*` (Spring Boot Micrometer), `istio_tcp_*` (ztunnel L4), and `up` (target health) instead of non-existent `istio_requests_total` |
| `infra/kubernetes/network-policies/inventory-netpol.yaml` | Added Prometheus scraping ingress from observability (ports 8000 + 15008) | HBONE tunnel port 15008 required for cross-namespace mTLS in Ambient mode |
| `infra/kubernetes/network-policies/observability-netpol.yaml` | Added kube-state-metrics ingress NetworkPolicy | Allows Prometheus to scrape kube-state-metrics |
| `infra/istio/security/authz-policies/inventory-service-policy.yaml` | Added observability namespace to allowed sources | **Key fix**: AuthorizationPolicy implicit deny was blocking Prometheus scraping |

> **Grafana PVC reset required after UID change**: Grafana's provisioner cannot change the UID of an existing datasource in its database. After adding explicit `uid` values, the Grafana PVC data must be cleared (or the deployment deleted and PVC wiped) before restarting. The provisioner then creates fresh datasources with the correct UIDs on first boot.

> **Istio Ambient + Prometheus scraping**: In Ambient mode, `ambient.istio.io/redirection: disabled` annotations are overridden by Istio CNI — you cannot opt pods out of ztunnel. Prometheus traffic goes through the HBONE tunnel on port 15008. Both **NetworkPolicy** (port 15008 ingress) and **AuthorizationPolicy** (observability namespace allow) must be configured for cross-namespace scraping to work.

### How the Log Pipeline Works (After Fix)

```
ecom-service (Spring Boot)              inventory-service (FastAPI)
    |  OTel Java Agent auto-bridges          |  Python LoggingHandler → OTel SDK
    |  Logback → OTLP log records            |  logging.info() → OTLP log records
    v                                         v
    +---- OTLP HTTP (port 4318) ------------>+
                                              |
                                   OTel Collector (otel namespace)
                                      |  resource/loki processor:
                                      |    adds loki.resource.labels hint
                                      |  batch/logs processor: 2s flush
                                      v
                                   Loki Exporter
                                      |  Maps resource attributes to labels:
                                      |    service.name → service_name
                                      |    service.namespace → service_namespace
                                      |    deployment.environment → deployment_environment
                                      |  Default labels: job, level
                                      v
                                   Grafana Loki (otel namespace, port 3100)
                                      |  TSDB v13, filesystem storage
                                      v
                                   Grafana (observability namespace, port 32500)
                                      |  Loki datasource
                                      |  Application Logs dashboard
                                      v
                                   You query: {service_name="ecom-service"}
```

### Loki Labels Available After Fix

| Label | Values | Source |
|-------|--------|--------|
| `service_name` | `ecom-service`, `inventory-service` | `OTEL_SERVICE_NAME` env var → `service.name` resource attribute |
| `service_namespace` | `ecom`, `inventory` | `OTEL_RESOURCE_ATTRIBUTES` → `service.namespace` |
| `deployment_environment` | `production` | `OTEL_RESOURCE_ATTRIBUTES` → `deployment.environment` |
| `level` | `DEBUG`, `INFO`, `WARN` | OTel log record severity → `default_labels_enabled.level` |
| `job` | `ecom/ecom-service`, `inventory/inventory-service` | `default_labels_enabled.job` (auto-composed from namespace/service) |

---

## Prerequisites

- Bookstore cluster running (`bash scripts/up.sh`)
- Grafana accessible at `http://localhost:32500`
- Credentials: `admin` / `CHANGE_ME`

---

## Step 1: Open Grafana Login Page

Open your browser and go to:

```
http://localhost:32500
```

You will see the Grafana login screen:

![Grafana Login Page](../images/grafana-loki/guide-01-grafana-login.png)

Enter:
- **Email or username**: `admin`
- **Password**: `CHANGE_ME`

Click **Log in**.

---

## Step 2: Grafana Home Page

After logging in, you land on the Grafana home page:

![Grafana Home](../images/grafana-loki/guide-02-grafana-home.png)

---

## Step 3: Navigate to Explore

Click **Explore** in the left sidebar. This opens the ad-hoc query interface:

![Explore Page](../images/grafana-loki/guide-03-explore-page.png)

Make sure the **datasource dropdown** (top-left of the query area) is set to **Loki**. If it shows "Prometheus" or "Tempo", click it and select **Loki**.

---

## Step 4: Open the Label Browser

Click the **Label browser** button (next to "Kick start your query"). A modal opens showing all available Loki labels:

![Loki Label Browser](../images/grafana-loki/guide-04-loki-label-browser.png)

You should see these labels:
- **deployment_environment**
- **job**
- **level**
- **service_name**
- **service_namespace**

Click on **service_name** to select it, then you can see its values (`ecom-service`, `inventory-service`). Click **Show logs** to query.

---

## Step 5: Query All Service Logs

In the query field, type:

```
{service_name=~".+"}
```

Click the blue **Run query** button (or press Shift+Enter). You will see:

![All Services Logs](../images/grafana-loki/guide-05-all-services-logs.png)

Key things to notice:
- **Logs volume** chart at the top — color-coded by level (green=info, blue=debug, orange=warning)
- **Log lines** below with timestamps, severity, and structured log bodies
- **Common labels** bar showing `deployment_environment=production`
- Line count and bytes processed

---

## Step 6: Filter by ecom-service

Change the query to:

```
{service_name="ecom-service"}
```

Click **Run query**:

![ecom-service Logs](../images/grafana-loki/guide-06-ecom-service-logs.png)

You'll see Spring Boot logs including:
- Hibernate/JPA queries
- HTTP request handling
- Kafka producer events
- Spring Security / JWT validation

Notice the **common labels** bar shows `job=ecom/ecom-service`, `service_name=ecom-service`.

---

## Step 7: Filter by inventory-service

Change the query to:

```
{service_name="inventory-service"}
```

Click **Run query**:

![inventory-service Logs](../images/grafana-loki/guide-07-inventory-service-logs.png)

You'll see FastAPI/Python logs including:
- Kafka consumer partition assignments
- JWKS cache fetches
- HTTP request logs
- Database queries

Notice the common labels show `service_name=inventory-service`, `job=inventory/inventory-service`.

---

## Step 8: Filter by Log Level

To see only warnings from ecom-service:

```
{service_name="ecom-service", level="WARN"}
```

![WARN Level Filter](../images/grafana-loki/guide-08-warn-level-filter.png)

You can combine any labels:
- `{level="DEBUG"}` — all debug logs across services
- `{service_namespace="ecom", level="INFO"}` — INFO logs from the ecom namespace
- `{deployment_environment="production"}` — all production logs

---

## Step 9: Application Logs Dashboard

Go to **Dashboards** in the left sidebar, then click **Application Logs**:

Or navigate directly to:
```
http://localhost:32500/d/application-logs/application-logs
```

![Application Logs Dashboard](../images/grafana-loki/guide-09-application-logs-dashboard.png)

This dashboard has 5 panels:

| Panel | Description |
|-------|-------------|
| **Application Logs — All Services** | Combined log stream from all services |
| **ecom-service Logs** | Filtered to `{service_name="ecom-service"}` |
| **inventory-service Logs** | Filtered to `{service_name="inventory-service"}` |
| **Log Volume by Service** | Stacked bar chart showing log counts per 5-min window by service |
| **Error Logs by Service** | Red bar chart showing error/exception/fatal log counts per 5-min window |

---

## Step 10: Tempo — Search Recent Traces

Switch the datasource dropdown to **Tempo** and select **Query type > Search**. Or navigate directly:

```
http://localhost:32500/explore  (select Tempo datasource, Search tab)
```

Click **Run query** to see recent traces:

![Tempo Recent Traces](../images/grafana-loki/guide-14-tempo-recent-traces.png)

You'll see a table with:
- **Trace ID** (clickable — opens the full trace waterfall)
- **Start time**
- **Service** (e.g. `inventory-service`, `ecom-service`)
- **Name** (e.g. `GET /health/ready`, `GET /ecom/books`)
- **Duration**

Click any Trace ID to drill into the span waterfall and see the full request lifecycle across services.

---

## Step 11: Tempo — Service Graph

Select **Query type > Service Graph** in the Tempo Explore view:

![Tempo Service Graph](../images/grafana-loki/guide-13-tempo-service-graph.png)

> **Note**: The Service Graph requires Tempo's `metrics_generator` to be enabled to produce span metrics (`traces_spanmetrics_*`). Without it, you'll see "No service graph data found" — this is expected in the current configuration. The important thing is that the "Datasource prometheus was not found" error is **gone** — the Prometheus datasource resolves correctly via its explicit `uid: prometheus`.
>
> To enable the Service Graph with real data, Tempo's config would need:
> ```yaml
> metrics_generator:
>   processor:
>     service_graphs:
>       dimensions: [service.namespace]
>   storage:
>     path: /var/tempo/generator/wal
>     remote_write:
>       - url: http://prometheus.observability.svc.cluster.local:9090/api/v1/write
> ```

---

## Step 12: Distributed Tracing Dashboard

Go to **Dashboards** > **Distributed Tracing**:

```
http://localhost:32500/d/distributed-tracing/distributed-tracing
```

![Distributed Tracing Dashboard](../images/grafana-loki/guide-10-distributed-tracing-dashboard.png)

This dashboard shows:
- Recent traces from Tempo
- OTel spans received rate
- OTel Collector health status
- Service node graph

---

## Step 13: Service Health Dashboard

Go to **Dashboards** > **Service Health**:

```
http://localhost:32500/d/service-health/service-health
```

![Service Health Dashboard](../images/grafana-loki/guide-11-service-health-dashboard.png)

This dashboard has 7 panels using metrics that are actually available in Istio Ambient mode:

| Panel | Metric Source | Description |
|-------|---------------|-------------|
| **Request Rate (ecom-service)** | `http_server_requests_seconds_count` | Spring Boot Micrometer HTTP request rate |
| **Error Rate (5xx)** | `http_server_requests_seconds_count{status=~"5.."}` | 5xx error percentage |
| **Avg Response Time** | `rate(sum/count)` on `http_server_requests_seconds` | Average response latency |
| **Max Response Time** | `http_server_requests_seconds_max` | Peak response latency |
| **Service Up Status** | `up{job=~"ecom-service\|inventory-service\|otel-collector"}` | Prometheus target health (1=up, 0=down) |
| **Mesh TCP Connections (ztunnel)** | `istio_tcp_connections_opened/closed_total` | L4 connection count from ztunnel |
| **Mesh TCP Throughput (ztunnel)** | `istio_tcp_sent/received_bytes_total` | L4 byte throughput from ztunnel |

> **Note**: This dashboard does NOT use `istio_requests_total` (L7 metrics) because Istio Ambient mode only exposes L4 metrics from ztunnel. L7 metrics require a waypoint proxy, which is not deployed in this cluster.

---

## Step 14: Cluster Overview Dashboard

Go to **Dashboards** > **Cluster Overview**:

```
http://localhost:32500/d/cluster-overview/cluster-overview
```

Shows Kubernetes cluster state and resource usage:

| Panel | Metric Source | Description |
|-------|---------------|-------------|
| **Pods by Phase** | `kube_pod_status_phase` | Count of pods in Running/Pending/Failed states (from kube-state-metrics) |
| **Pod Restarts** | `kube_pod_container_status_restarts_total` | Container restart counts (from kube-state-metrics) |
| **CPU Usage** | `container_cpu_usage_seconds_total` | Container CPU usage (from kubelet cAdvisor) |
| **Memory Usage** | `container_memory_working_set_bytes` | Container memory usage (from kubelet cAdvisor) |

Queries are scoped to application namespaces: `ecom`, `inventory`, `identity`, `infra`, `analytics`, `otel`, `observability`.

> **Requires**: kube-state-metrics deployed in observability namespace + Prometheus ClusterRole with `nodes/proxy` for cAdvisor access.

---

## Step 15: All Dashboards Overview

Go to **Dashboards** in the left sidebar to see all 4 available dashboards:

![Dashboards List](../images/grafana-loki/guide-12-dashboards-list.png)

| Dashboard | Tags | Datasource |
|-----------|------|------------|
| **Application Logs** | logs, loki, opentelemetry | Loki |
| **Cluster Overview** | cluster, kubernetes | Prometheus (kube-state-metrics + cAdvisor) |
| **Distributed Tracing** | opentelemetry, tempo, tracing | Tempo + Prometheus |
| **Service Health** | service-health, opentelemetry | Prometheus (Spring Boot Micrometer + ztunnel L4) |

---

## Generating Test Traffic

If you want to see more logs flowing in real-time, generate traffic with:

```bash
# Hit ecom-service endpoints
curl http://api.service.net:30000/ecom/books
curl 'http://api.service.net:30000/ecom/books/search?q=java'

# Hit inventory-service endpoints
curl http://api.service.net:30000/inven/stock/00000000-0000-0000-0000-000000000001

# Authenticated request (generates JWT validation logs)
TOKEN=$(curl -s -X POST \
  "http://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=ui-client&username=user1&password=CHANGE_ME" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

curl -H "Authorization: Bearer $TOKEN" http://api.service.net:30000/ecom/cart
```

After generating traffic, wait ~5 seconds (OTel batch flush interval), then click **Refresh** in Grafana or re-run the query.

---

## Useful LogQL Queries

```logql
# All logs from both services
{service_name=~".+"}

# Only ecom-service errors
{service_name="ecom-service"} |~ "(?i)error|exception"

# Inventory-service Kafka consumer logs
{service_name="inventory-service"} |= "Kafka"

# Count logs per service in last 5 minutes
sum by (service_name) (count_over_time({service_name=~".+"}[5m]))

# Tail logs in real-time (click "Live" button in Grafana Explore)
{service_name="ecom-service"}
```

---

## Running E2E Tests

To verify the entire pipeline automatically:

```bash
cd e2e
npx playwright test otel-loki.spec.ts --reporter=list
```

This runs 43 tests across 9 suites:

| Suite | Tests | Coverage |
|-------|-------|----------|
| **Loki Log Labels** | 6 | Label existence (`service_name`, `level`, `job`, etc.) and values |
| **Loki Log Queries** | 3 | Log results for ecom-service, inventory-service, and combined (24h range) |
| **Application Logs Dashboard** | 3 | Dashboard structure and panel count |
| **Service Health Dashboard** | 6 | Panel structure + live metrics data (request rate, service up, TCP connections) |
| **Cluster Overview Dashboard** | 7 | Panel structure + live metrics (pod phases, CPU, memory from kube-state-metrics/cAdvisor) |
| **Distributed Tracing Dashboard** | 6 | Panel structure + OTel Collector metrics (spans, log records) |
| **Prometheus Scrape Targets** | 2 | All targets healthy, 11+ active targets |
| **Grafana Datasources** | 4 | Datasource UIDs correct, all 4 dashboards exist |
| **Grafana Dashboard UI** | 5 | Screenshots of all dashboards + Loki Explore view |

---

## Troubleshooting

### No labels in Loki

1. Check OTel Collector is running: `kubectl get pods -n otel`
2. Check Collector logs for errors: `kubectl logs -n otel deploy/otel-collector --tail=20`
3. Verify services have `OTEL_LOGS_EXPORTER=otlp`:
   ```bash
   kubectl get deploy ecom-service -n ecom -o jsonpath='{.spec.template.spec.containers[0].env}' | python3 -m json.tool | grep -A1 OTEL_LOGS
   ```

### Logs appear but no service_name label

The OTel Collector `resource/loki` processor must be in the logs pipeline. Check:
```bash
kubectl get configmap otel-collector-config -n otel -o jsonpath='{.data.config\.yaml}' | grep -A2 "resource/loki"
```

### Tempo Service Graph: "Datasource prometheus was not found"

This means the Tempo datasource's `serviceMap.datasourceUid` doesn't match any actual datasource UID in Grafana.

1. Check the current datasource UIDs:
   ```bash
   curl -s 'http://localhost:32500/api/datasources' \
     -H 'Authorization: Basic YWRtaW46Q0hBTkdFX01F' \
     | python3 -c "import sys,json; [print(f'{d[\"name\"]}: uid={d[\"uid\"]}') for d in json.load(sys.stdin)]"
   ```
2. If Prometheus shows a random UID like `PBFA97CFB590B2093` instead of `prometheus`, the provisioned config wasn't applied. Fix:
   ```bash
   # Ensure grafana.yaml has uid: prometheus and uid: tempo in datasources
   # Then clear the Grafana DB and restart:
   kubectl delete deployment grafana -n observability
   kubectl run grafana-cleanup -n observability --image=busybox --restart=Never \
     --overrides='{"spec":{"containers":[{"name":"c","image":"busybox","command":["sh","-c","rm -rf /data/*"],"volumeMounts":[{"name":"d","mountPath":"/data"}]}],"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"grafana-pvc"}}]}}' \
     && kubectl wait --for=condition=Ready pod/grafana-cleanup -n observability --timeout=30s \
     && kubectl delete pod grafana-cleanup -n observability
   kubectl apply -f infra/observability/grafana/grafana.yaml
   ```

### Prometheus target DOWN (connection reset by peer)

In Istio Ambient mode, cross-namespace scraping requires three things:
1. **NetworkPolicy** allows ingress from `observability` namespace on both the app port AND port 15008 (HBONE tunnel)
2. **AuthorizationPolicy** includes `observability` namespace in its allow rules (implicit deny blocks unlisted namespaces)
3. **PeerAuthentication** — namespace-wide PERMISSIVE or STRICT both work (Prometheus goes through HBONE mTLS tunnel)

Check which layer is blocking:
```bash
# Check ztunnel logs for RBAC denials
kubectl logs -n istio-system -l app=ztunnel --tail=50 | grep -i "denied\|RBAC\|policy"

# Check if target is up from Prometheus
curl -s 'http://localhost:32500/api/datasources/proxy/uid/prometheus/api/v1/targets' \
  -H 'Authorization: Basic YWRtaW46Q0hBTkdFX01F' \
  | python3 -c "import sys,json; [print(f'{t[\"labels\"][\"job\"]}: {t[\"health\"]} - {t.get(\"lastError\",\"\")}') for t in json.load(sys.stdin)['data']['activeTargets']]"
```

### Cluster Overview dashboard shows no data

kube-state-metrics must be deployed. Check:
```bash
kubectl get deploy kube-state-metrics -n observability
kubectl get pods -n observability -l app.kubernetes.io/name=kube-state-metrics
```

For cAdvisor metrics (CPU/memory), Prometheus ClusterRole needs `nodes/proxy`:
```bash
kubectl get clusterrole prometheus -o yaml | grep -A2 "nodes"
```

### Loki rejects logs with "entry too old"

Loki's `reject_old_samples_max_age` is 168h (7 days). If system clocks are skewed, logs may be rejected. Check: `kubectl logs -n otel deploy/loki --tail=20 | grep "too old"`.

---

## Architecture Reference

| Component | Namespace | Port | URL |
|-----------|-----------|------|-----|
| Grafana | observability | 32500 | http://localhost:32500 |
| Loki | otel | 3100 | Internal only |
| Tempo | otel | 3200 | Internal only |
| OTel Collector | otel | 4317/4318/8888 | Internal only (8888 = internal metrics) |
| Prometheus | observability | 9090 | Internal only |
| kube-state-metrics | observability | 8080 | Internal only |
| Kiali | istio-system | 32100 | http://localhost:32100/kiali |
