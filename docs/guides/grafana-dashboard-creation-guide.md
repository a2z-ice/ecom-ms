# How to Create Grafana Dashboards Manually — Step-by-Step Guide

This guide walks you through creating each of the 4 Grafana dashboards from scratch using the Grafana UI. Use this if you want to build dashboards manually instead of relying on the provisioned ConfigMap, or if you want to understand how each panel is configured.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Dashboard 1: Service Health](#dashboard-1-service-health)
3. [Dashboard 2: Cluster Overview](#dashboard-2-cluster-overview)
4. [Dashboard 3: Distributed Tracing](#dashboard-3-distributed-tracing)
5. [Dashboard 4: Application Logs](#dashboard-4-application-logs)
6. [How to Export a Dashboard as JSON](#how-to-export-a-dashboard-as-json)
7. [How to Provision Dashboards via ConfigMap](#how-to-provision-dashboards-via-configmap)

---

## Prerequisites

1. **Grafana running** at `http://localhost:32500`
2. **Login**: `admin` / `CHANGE_ME`
3. **Datasources configured** (these should already be provisioned):
   - **Prometheus** (uid: `prometheus`) — `http://prometheus.observability.svc.cluster.local:9090`
   - **Loki** (uid: `loki`) — `http://loki.otel.svc.cluster.local:3100`
   - **Tempo** (uid: `tempo`) — `http://tempo.otel.svc.cluster.local:3200`
4. **Metrics flowing**: Verify at `http://localhost:32500` > Explore > Prometheus > query `up` — you should see 11+ active targets

### Verify Datasources

Before creating dashboards, confirm datasources are working:

1. Go to **Connections > Data sources** in the left sidebar
2. Click **Prometheus** > scroll to bottom > click **Save & test** — should show "Successfully queried the Prometheus API"
3. Click **Loki** > **Save & test** — should show "Data source successfully connected"
4. Click **Tempo** > **Save & test** — should show "Data source successfully connected"

---

## Dashboard 1: Service Health

This dashboard monitors application-level HTTP metrics (from Spring Boot Micrometer), service availability, and Istio mesh L4 traffic.

### Step 1: Create the Dashboard

1. Click **Dashboards** in the left sidebar
2. Click **New** > **New Dashboard**
3. Click the gear icon (Dashboard settings) at the top right
4. Set:
   - **Title**: `Service Health`
   - **Tags**: `service-health`, `opentelemetry`
   - **Time range**: Last 1 hour
5. Click **Save dashboard** > set UID to `service-health` > click **Save**

### Step 2: Panel 1 — Request Rate (ecom-service)

1. Click **Add visualization**
2. Select datasource: **Prometheus**
3. In the query editor, switch to **Code** mode (toggle at top right of query box)
4. Enter PromQL:
   ```
   sum(rate(http_server_requests_seconds_count{job="ecom-service"}[5m])) by (uri)
   ```
5. Set **Legend**: `{{ uri }}`
6. Panel settings (right sidebar):
   - **Title**: `Request Rate (ecom-service)`
   - **Visualization**: Time series (default)
7. Under **Standard options**:
   - **Unit**: requests/sec (`reqps`)
8. Under **Graph styles**:
   - **Style**: Lines
   - **Fill opacity**: 10
9. Resize the panel: drag bottom-right corner to **12 columns wide, 8 rows tall**
10. Click **Apply**

### Step 3: Panel 2 — Error Rate (5xx)

1. Click **Add** > **Visualization**
2. Datasource: **Prometheus**
3. **Query A** (Code mode):
   ```
   sum(rate(http_server_requests_seconds_count{job="ecom-service",status=~"5.."}[5m]))
   ```
   Legend: `ecom-service 5xx`
4. Click **+ Query** to add Query B:
   ```
   sum(rate(http_server_requests_seconds_count{job="inventory-service",status=~"5.."}[5m]))
   ```
   Legend: `inventory-service 5xx`
5. Panel settings:
   - **Title**: `Error Rate (5xx)`
   - **Unit**: requests/sec
   - **Fill opacity**: 10
6. Under **Thresholds**:
   - Base: green
   - Add threshold: `0.1` → red
7. Position: drag to the **right** of Panel 1 (12 columns wide, 8 rows tall)
8. Click **Apply**

### Step 4: Panel 3 — Avg Response Time (ecom-service)

1. **Add** > **Visualization** > Prometheus
2. PromQL:
   ```
   rate(http_server_requests_seconds_sum{job="ecom-service"}[5m]) / rate(http_server_requests_seconds_count{job="ecom-service"}[5m])
   ```
   Legend: `{{ uri }}`
3. Panel settings:
   - **Title**: `Avg Response Time (ecom-service)`
   - **Unit**: seconds (s)
   - **Fill opacity**: 10
4. Position: **below** Panel 1 (row 2, left side, 12w x 8h)
5. Click **Apply**

### Step 5: Panel 4 — Max Response Time

1. **Add** > **Visualization** > Prometheus
2. **Query A**:
   ```
   http_server_requests_seconds_max{job="ecom-service"}
   ```
   Legend: `ecom {{ uri }}`
3. **Query B** (click + Query):
   ```
   http_server_requests_seconds_max{job="inventory-service"}
   ```
   Legend: `inventory {{ handler }}`
4. Panel settings:
   - **Title**: `Max Response Time`
   - **Unit**: seconds (s)
   - **Fill opacity**: 10
5. Position: **right** of Panel 3 (row 2, right side, 12w x 8h)
6. Click **Apply**

### Step 6: Panel 5 — Service Up Status

1. **Add** > **Visualization** > Prometheus
2. PromQL:
   ```
   up{job=~"ecom-service|inventory-service|otel-collector"}
   ```
   Legend: `{{ job }}`
3. Change visualization type from **Time series** to **Stat** (dropdown at top right)
4. Panel settings:
   - **Title**: `Service Up Status`
5. Under **Value mappings** (right sidebar > scroll down):
   - Click **Add value mapping**
   - Type: **Value** > `0` → text: `DOWN`, color: red
   - Click **Add** > `1` → text: `UP`, color: green
6. Under **Thresholds**:
   - Base: red
   - Add threshold: `1` → green
7. Position: row 3, left, **8w x 4h**
8. Click **Apply**

### Step 7: Panel 6 — Mesh TCP Connections (ztunnel)

1. **Add** > **Visualization** > Prometheus
2. **Query A**:
   ```
   sum(rate(istio_tcp_connections_opened_total[5m])) by (pod)
   ```
   Legend: `opened {{ pod }}`
3. **Query B**:
   ```
   sum(rate(istio_tcp_connections_closed_total[5m])) by (pod)
   ```
   Legend: `closed {{ pod }}`
4. Panel settings:
   - **Title**: `Mesh TCP Connections (ztunnel)`
   - **Unit**: counts/sec (cps)
   - **Fill opacity**: 10
5. Position: row 3, middle, **8w x 8h**
6. Click **Apply**

### Step 8: Panel 7 — Mesh TCP Throughput (ztunnel)

1. **Add** > **Visualization** > Prometheus
2. **Query A**:
   ```
   sum(rate(istio_tcp_sent_bytes_total[5m]))
   ```
   Legend: `sent`
3. **Query B**:
   ```
   sum(rate(istio_tcp_received_bytes_total[5m]))
   ```
   Legend: `received`
4. Panel settings:
   - **Title**: `Mesh TCP Throughput (ztunnel)`
   - **Unit**: bytes/sec (Bps)
   - **Fill opacity**: 10
5. Position: row 3, right, **8w x 8h**
6. Click **Apply**

### Step 9: Save

Click the **Save** icon (floppy disk) at the top right, then **Save**.

---

## Dashboard 2: Cluster Overview

This dashboard shows Kubernetes cluster state using kube-state-metrics and container resource usage from kubelet cAdvisor.

### Step 1: Create the Dashboard

1. **Dashboards** > **New** > **New Dashboard**
2. Settings:
   - **Title**: `Cluster Overview`
   - **Tags**: `kubernetes`, `cluster`
   - **UID**: `cluster-overview`
3. Save

### Step 2: Panel 1 — Pods by Phase

1. **Add** > **Visualization** > Prometheus
2. PromQL:
   ```
   sum(kube_pod_status_phase{namespace=~"ecom|inventory|identity|infra|analytics|otel|observability"}) by (phase)
   ```
   Legend: `{{ phase }}`
3. Change visualization type to **Pie chart**
4. Panel settings:
   - **Title**: `Pods by Phase`
5. Position: row 1, left, **8w x 8h**
6. Click **Apply**

### Step 3: Panel 2 — Pod Restart Count (Top 10)

1. **Add** > **Visualization** > Prometheus
2. PromQL:
   ```
   topk(10, kube_pod_container_status_restarts_total{namespace=~"ecom|inventory|identity|infra|analytics|otel|observability"})
   ```
   Legend: `{{ namespace }}/{{ pod }}`
3. Change visualization type to **Bar gauge**
4. Panel settings:
   - **Title**: `Pod Restart Count (Top 10)`
5. Under **Bar gauge** options:
   - **Orientation**: Horizontal
6. Under **Thresholds**:
   - Base: green
   - Add: `3` → yellow
   - Add: `10` → red
7. Position: row 1, middle, **8w x 8h**
8. Click **Apply**

### Step 4: Panel 3 — Running Pods by Namespace

1. **Add** > **Visualization** > Prometheus
2. PromQL:
   ```
   sum(kube_pod_status_phase{phase="Running", namespace=~"ecom|inventory|identity|infra|analytics|otel|observability"}) by (namespace)
   ```
   Legend: `{{ namespace }}`
3. Change visualization type to **Bar gauge**
4. Panel settings:
   - **Title**: `Running Pods by Namespace`
   - **Orientation**: Horizontal
5. Position: row 1, right, **8w x 8h**
6. Click **Apply**

### Step 5: Panel 4 — CPU Usage by Container

1. **Add** > **Visualization** > Prometheus
2. PromQL:
   ```
   sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD",namespace=~"ecom|inventory|identity|infra|analytics|otel|observability"}[5m])) by (namespace, container)
   ```
   Legend: `{{ namespace }}/{{ container }}`
3. Panel settings:
   - **Title**: `CPU Usage by Container`
   - **Visualization**: Time series
   - **Unit**: short
   - **Fill opacity**: 10
4. Position: row 2, left, **12w x 8h**
5. Click **Apply**

> **Note on the query**: `container!=""` excludes the pause container. `container!="POD"` excludes the pod-level cgroup. These filters ensure you only see actual application containers.

### Step 6: Panel 5 — Memory Usage by Container

1. **Add** > **Visualization** > Prometheus
2. PromQL:
   ```
   sum(container_memory_working_set_bytes{container!="",container!="POD",namespace=~"ecom|inventory|identity|infra|analytics|otel|observability"}) by (namespace, container)
   ```
   Legend: `{{ namespace }}/{{ container }}`
3. Panel settings:
   - **Title**: `Memory Usage by Container`
   - **Visualization**: Time series
   - **Unit**: bytes
   - **Fill opacity**: 10
4. Position: row 2, right, **12w x 8h**
5. Click **Apply**

### Step 7: Save

Save the dashboard.

---

## Dashboard 3: Distributed Tracing

This dashboard shows trace data from Tempo, OTel Collector health metrics, and a service node graph.

### Step 1: Create the Dashboard

1. **Dashboards** > **New** > **New Dashboard**
2. Settings:
   - **Title**: `Distributed Tracing`
   - **Tags**: `tracing`, `opentelemetry`, `tempo`
   - **UID**: `distributed-tracing`
3. Save

### Step 2: Panel 1 — Recent Traces

1. **Add** > **Visualization**
2. Select datasource: **Tempo**
3. Query type should default to **Search** (or select it from the dropdown)
4. Set **Limit**: `20`
5. Change visualization type to **Table**
6. Panel settings:
   - **Title**: `Recent Traces`
7. Position: row 1, full width, **24w x 10h**
8. Click **Apply**

> **Tip**: After applying, you should see a table with columns: Trace ID, Start time, Service, Name, Duration. Click any Trace ID to drill into the span waterfall.

### Step 3: Panel 2 — OTel Spans Received (rate/5m)

1. **Add** > **Visualization** > Prometheus
2. PromQL:
   ```
   sum(rate(otelcol_receiver_accepted_spans[5m])) by (receiver)
   ```
   Legend: `{{ receiver }}`
3. Panel settings:
   - **Title**: `OTel Spans Received (rate/5m)`
   - **Unit**: short
   - **Fill opacity**: 10
4. Position: row 2, left, **12w x 8h**
5. Click **Apply**

> **Important metric name**: The OTel Collector internal metrics (port 8888) do NOT use the `_total` suffix. It's `otelcol_receiver_accepted_spans`, not `otelcol_receiver_accepted_spans_total`.

### Step 4: Panel 3 — OTel Collector Health

1. **Add** > **Visualization** > Prometheus
2. PromQL:
   ```
   up{job="otel-collector"}
   ```
   Legend: `otel-collector`
3. Change visualization type to **Stat**
4. Panel settings:
   - **Title**: `OTel Collector Health`
5. Value mappings:
   - `0` → text: `DOWN`, color: red
   - `1` → text: `UP`, color: green
6. Thresholds:
   - Base: red
   - Add: `1` → green
7. Position: row 2, middle-right, **6w x 8h**
8. Click **Apply**

### Step 5: Panel 4 — OTel Spans Dropped

1. **Add** > **Visualization** > Prometheus
2. PromQL:
   ```
   sum(rate(otelcol_receiver_refused_spans[5m])) by (receiver)
   ```
   Legend: `{{ receiver }}`
3. Panel settings:
   - **Title**: `OTel Spans Dropped`
   - **Unit**: short
   - **Fill opacity**: 10
4. Position: row 2, right, **6w x 8h**
5. Click **Apply**

### Step 6: Panel 5 — Service Node Graph

1. **Add** > **Visualization**
2. Select datasource: **Tempo**
3. Change Query type to **Service Graph** (dropdown below the datasource selector)
4. Change visualization type to **Node Graph**
5. Panel settings:
   - **Title**: `Service Node Graph`
6. Position: row 3, full width, **24w x 10h**
7. Click **Apply**

> **Note**: The Service Graph requires Tempo's `metrics_generator` to produce span metrics. Without it, this panel shows "No data" — but the panel configuration is still valid. The important thing is that it connects to the Prometheus datasource correctly (no "datasource not found" error).

### Step 7: Save

Save the dashboard.

---

## Dashboard 4: Application Logs

This dashboard displays Loki log streams from both microservices with filtering and volume charts.

### Step 1: Create the Dashboard

1. **Dashboards** > **New** > **New Dashboard**
2. Settings:
   - **Title**: `Application Logs`
   - **Tags**: `loki`, `logs`, `opentelemetry`
   - **UID**: `application-logs`
3. Save

### Step 2: Panel 1 — Application Logs — All Services

1. **Add** > **Visualization**
2. Select datasource: **Loki**
3. Switch to **Code** mode and enter:
   ```
   {service_name=~".+"}
   ```
4. Change visualization type to **Logs**
5. Panel settings:
   - **Title**: `Application Logs — All Services`
6. Under **Logs** options (right sidebar):
   - **Show time**: enabled
   - **Show labels**: enabled
   - **Show common labels**: disabled
   - **Wrap log message**: enabled
   - **Enable log details**: enabled
   - **Order**: Descending
   - **Deduplication**: None
7. Position: row 1, full width, **24w x 14h**
8. Click **Apply**

### Step 3: Panel 2 — ecom-service Logs

1. **Add** > **Visualization** > **Loki**
2. LogQL:
   ```
   {service_name="ecom-service"}
   ```
3. Visualization: **Logs** (same options as Panel 1)
4. **Title**: `ecom-service Logs`
5. Position: row 2, full width, **24w x 12h**
6. Click **Apply**

### Step 4: Panel 3 — inventory-service Logs

1. **Add** > **Visualization** > **Loki**
2. LogQL:
   ```
   {service_name="inventory-service"}
   ```
3. Visualization: **Logs** (same options)
4. **Title**: `inventory-service Logs`
5. Position: row 3, full width, **24w x 12h**
6. Click **Apply**

### Step 5: Panel 4 — Log Volume by Service

1. **Add** > **Visualization** > **Loki**
2. LogQL:
   ```
   sum by (service_name) (count_over_time({service_name=~".+"}[5m]))
   ```
   Legend: `{{ service_name }}`
3. Visualization: **Time series**
4. Panel settings:
   - **Title**: `Log Volume by Service`
   - **Unit**: short
5. Under **Graph styles**:
   - **Style**: Bars
   - **Fill opacity**: 50
   - **Stack series**: Normal
6. Position: row 4, left, **12w x 8h**
7. Click **Apply**

### Step 6: Panel 5 — Error Logs by Service

1. **Add** > **Visualization** > **Loki**
2. LogQL:
   ```
   sum by (service_name) (count_over_time({service_name=~".+"} |~ "(?i)(error|exception|fatal)"[5m]))
   ```
   Legend: `{{ service_name }}`
3. Visualization: **Time series**
4. Panel settings:
   - **Title**: `Error Logs by Service`
   - **Unit**: short
5. Under **Graph styles**:
   - **Style**: Bars
   - **Fill opacity**: 50
   - **Stack series**: Normal
6. Under **Standard options** > **Color scheme**: Fixed > **red**
7. Position: row 4, right, **12w x 8h**
8. Click **Apply**

### Step 7: Save

Save the dashboard.

---

## How to Export a Dashboard as JSON

If you've created a dashboard manually and want to save it for version control or provisioning:

1. Open the dashboard
2. Click the **Share** icon (arrow out of box) at the top
3. Select the **Export** tab
4. Toggle **Export for sharing externally**: ON
   - This replaces the numeric datasource IDs with datasource names, making the JSON portable
5. Click **Save to file** — downloads a `.json` file
6. Or click **View JSON** and copy the content

> **Tip**: When exporting for ConfigMap provisioning, set `"id": null` in the JSON (Grafana auto-assigns IDs). Keep the `"uid"` field as it ensures stable URLs.

---

## How to Provision Dashboards via ConfigMap

Instead of creating dashboards manually each time, you can provision them automatically via Kubernetes ConfigMaps. This is what the bookstore cluster uses.

### Step 1: Dashboard Provider ConfigMap

This tells Grafana where to find dashboard JSON files:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-dashboard-providers
  namespace: observability
data:
  dashboards.yaml: |
    apiVersion: 1
    providers:
      - name: 'default'
        orgId: 1
        folder: ''
        type: file
        disableDeletion: false
        editable: true
        options:
          path: /var/lib/grafana/dashboards
          foldersFromFilesStructure: false
```

### Step 2: Dashboard JSON ConfigMap

Put each dashboard JSON as a separate key:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-dashboards
  namespace: observability
data:
  service-health.json: |
    { "title": "Service Health", "uid": "service-health", "panels": [...] }
  cluster-overview.json: |
    { "title": "Cluster Overview", "uid": "cluster-overview", "panels": [...] }
  distributed-tracing.json: |
    { "title": "Distributed Tracing", "uid": "distributed-tracing", "panels": [...] }
  application-logs.json: |
    { "title": "Application Logs", "uid": "application-logs", "panels": [...] }
```

### Step 3: Mount in Grafana Deployment

```yaml
containers:
  - name: grafana
    volumeMounts:
      - name: dashboard-providers
        mountPath: /etc/grafana/provisioning/dashboards
      - name: dashboards
        mountPath: /var/lib/grafana/dashboards
volumes:
  - name: dashboard-providers
    configMap:
      name: grafana-dashboard-providers
  - name: dashboards
    configMap:
      name: grafana-dashboards
```

### Step 4: Apply and Restart

```bash
kubectl apply -f infra/observability/grafana/grafana.yaml
kubectl rollout restart deployment grafana -n observability
```

Grafana will read the JSON files on startup and create the dashboards automatically. Changes to the ConfigMap require a pod restart (ConfigMaps are mounted as volumes and not hot-reloaded by Grafana).

---

## Quick Reference: All PromQL Queries Used

| Dashboard | Panel | Query |
|-----------|-------|-------|
| Service Health | Request Rate | `sum(rate(http_server_requests_seconds_count{job="ecom-service"}[5m])) by (uri)` |
| Service Health | Error Rate 5xx | `sum(rate(http_server_requests_seconds_count{job="ecom-service",status=~"5.."}[5m]))` |
| Service Health | Avg Response Time | `rate(http_server_requests_seconds_sum{job="ecom-service"}[5m]) / rate(http_server_requests_seconds_count{job="ecom-service"}[5m])` |
| Service Health | Max Response Time | `http_server_requests_seconds_max{job="ecom-service"}` |
| Service Health | Service Up | `up{job=~"ecom-service\|inventory-service\|otel-collector"}` |
| Service Health | TCP Connections | `sum(rate(istio_tcp_connections_opened_total[5m])) by (pod)` |
| Service Health | TCP Throughput | `sum(rate(istio_tcp_sent_bytes_total[5m]))` |
| Cluster Overview | Pods by Phase | `sum(kube_pod_status_phase{namespace=~"ecom\|inventory\|..."}) by (phase)` |
| Cluster Overview | Restart Count | `topk(10, kube_pod_container_status_restarts_total{namespace=~"..."})` |
| Cluster Overview | Running Pods | `sum(kube_pod_status_phase{phase="Running", namespace=~"..."}) by (namespace)` |
| Cluster Overview | CPU Usage | `sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD",namespace=~"..."}[5m])) by (namespace, container)` |
| Cluster Overview | Memory Usage | `sum(container_memory_working_set_bytes{container!="",container!="POD",namespace=~"..."}) by (namespace, container)` |
| Distributed Tracing | Spans Received | `sum(rate(otelcol_receiver_accepted_spans[5m])) by (receiver)` |
| Distributed Tracing | Collector Health | `up{job="otel-collector"}` |
| Distributed Tracing | Spans Dropped | `sum(rate(otelcol_receiver_refused_spans[5m])) by (receiver)` |

## Quick Reference: All LogQL Queries Used

| Dashboard | Panel | Query |
|-----------|-------|-------|
| Application Logs | All Services | `{service_name=~".+"}` |
| Application Logs | ecom-service | `{service_name="ecom-service"}` |
| Application Logs | inventory-service | `{service_name="inventory-service"}` |
| Application Logs | Log Volume | `sum by (service_name) (count_over_time({service_name=~".+"}[5m]))` |
| Application Logs | Error Logs | `sum by (service_name) (count_over_time({service_name=~".+"} \|~ "(?i)(error\|exception\|fatal)"[5m]))` |
