# Observability Dashboard Issues & Fixes — Step-by-Step

This document explains every issue found with the Grafana observability dashboards and the exact fix applied for each one. It covers the full debugging journey from symptom to root cause to resolution.

---

## Table of Contents

1. [Issue 1: No Logs in Loki (Empty Label Dropdown)](#issue-1-no-logs-in-loki)
2. [Issue 2: Tempo Service Graph "Datasource prometheus was not found"](#issue-2-tempo-service-graph-datasource-error)
3. [Issue 3: Service Health Dashboard Shows No Data](#issue-3-service-health-dashboard-no-data)
4. [Issue 4: Cluster Overview Dashboard Shows No Data](#issue-4-cluster-overview-dashboard-no-data)
5. [Issue 5: OTel Collector Prometheus Target DOWN](#issue-5-otel-collector-target-down)
6. [Issue 6: inventory-service Prometheus Target DOWN](#issue-6-inventory-service-target-down)
7. [Issue 7: kube-state-metrics Target DOWN](#issue-7-kube-state-metrics-target-down)
8. [Issue 8: kubelet cAdvisor 403 Forbidden](#issue-8-kubelet-cadvisor-403)
9. [Summary of All Files Changed](#summary-of-all-files-changed)

---

## Issue 1: No Logs in Loki

### Symptom

Grafana Loki Explore view was completely empty. The label filter dropdown showed zero labels — no `service_name`, no `level`, nothing. The Application Logs dashboard showed "No data".

### Root Cause

Both microservices had `OTEL_LOGS_EXPORTER=none` in their Kubernetes Deployment manifests:

```yaml
# ecom-service/k8s/ecom-service.yaml (BEFORE)
- name: OTEL_LOGS_EXPORTER
  value: "none"
```

This told the OTel agents to send only traces, not logs. Additionally, the OTel Collector's Loki exporter had no label mapping configured — even if logs arrived, resource attributes like `service.name` wouldn't become Loki labels.

### Fix — 4 Files Changed

**File 1: `ecom-service/k8s/ecom-service.yaml`**

Changed `OTEL_LOGS_EXPORTER` from `none` to `otlp` and added resource attributes:

```yaml
# AFTER
- name: OTEL_LOGS_EXPORTER
  value: "otlp"
- name: OTEL_RESOURCE_ATTRIBUTES
  value: "service.namespace=ecom,deployment.environment=production"
```

The OTel Java Agent auto-bridges Logback (Spring Boot's logging framework) to OTLP — no application code changes needed.

**File 2: `inventory-service/k8s/inventory-service.yaml`**

Added the same env vars:

```yaml
- name: OTEL_LOGS_EXPORTER
  value: "otlp"
- name: OTEL_TRACES_EXPORTER
  value: "otlp"
- name: OTEL_METRICS_EXPORTER
  value: "none"
- name: OTEL_RESOURCE_ATTRIBUTES
  value: "service.namespace=inventory,deployment.environment=production"
```

**File 3: `inventory-service/app/main.py`**

Unlike Java (where the OTel agent auto-bridges), Python requires explicit setup. Added:

```python
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter

provider = LoggerProvider(resource=resource)
provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter()))
handler = LoggingHandler(level=logging.DEBUG, logger_provider=provider)
logging.getLogger().addHandler(handler)
```

This bridges every `logging.info(...)` call to OTel log records.

**File 4: `infra/observability/otel-collector.yaml`**

Added the `resource/loki` processor that maps resource attributes to Loki labels:

```yaml
processors:
  resource/loki:
    attributes:
      - action: insert
        key: loki.resource.labels
        value: service.name, service.namespace, deployment.environment

exporters:
  loki:
    endpoint: http://loki.otel.svc.cluster.local:3100/loki/api/v1/push
    default_labels_enabled:
      job: true
      level: true

service:
  pipelines:
    logs:
      receivers: [otlp]
      processors: [memory_limiter, resource/loki, batch/logs]
      exporters: [loki]
```

Without the `resource/loki` processor, `service.name` would be buried in the log body, not queryable as a Loki label.

### Verification

```bash
# Check labels exist in Loki
curl -s 'http://localhost:32500/api/datasources/proxy/uid/loki/loki/api/v1/labels' \
  -H 'Authorization: Basic YWRtaW46Q0hBTkdFX01F' | python3 -m json.tool
```

Expected labels: `service_name`, `service_namespace`, `deployment_environment`, `level`, `job`.

---

## Issue 2: Tempo Service Graph Datasource Error

### Symptom

In Grafana Explore, selecting **Tempo > Query type > Service Graph** showed:

> **Query error** — Datasource prometheus was not found

### Root Cause

Grafana's datasource provisioning did not set explicit `uid` values for Prometheus and Tempo. Grafana auto-generated random UIDs (e.g., `PBFA97CFB590B2093`). But Tempo's `serviceMap` was configured as:

```yaml
serviceMap:
  datasourceUid: prometheus  # literal string "prometheus"
```

This literal string didn't match the auto-generated UID `PBFA97CFB590B2093`.

### Fix — 1 File Changed

**File: `infra/observability/grafana/grafana.yaml`**

Added explicit `uid` to all three datasources:

```yaml
datasources:
  - name: Prometheus
    type: prometheus
    uid: prometheus          # <-- ADDED
    url: http://prometheus.observability.svc.cluster.local:9090
  - name: Tempo
    type: tempo
    uid: tempo               # <-- ADDED
    url: http://tempo.otel.svc.cluster.local:3200
    jsonData:
      serviceMap:
        datasourceUid: prometheus   # now resolves correctly
      tracesToLogsV2:
        datasourceUid: loki         # already had uid: loki
  - name: Loki
    type: loki
    uid: loki                # already existed
    url: http://loki.otel.svc.cluster.local:3100
```

### Important: Grafana PVC Reset Required

Grafana's provisioner **cannot change the UID** of an existing datasource in its SQLite database. After adding explicit UIDs, the Grafana PVC data must be cleared:

```bash
# Delete Grafana pod (PVC data must be wiped to re-provision)
kubectl delete deployment grafana -n observability
# Clean the PVC
kubectl run grafana-cleanup -n observability --image=busybox --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"c","image":"busybox","command":["sh","-c","rm -rf /data/*"],"volumeMounts":[{"name":"d","mountPath":"/data"}]}],"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"grafana-pvc"}}]}}'
kubectl wait --for=condition=Ready pod/grafana-cleanup -n observability --timeout=30s
kubectl delete pod grafana-cleanup -n observability
# Re-apply
kubectl apply -f infra/observability/grafana/grafana.yaml
```

### Verification

```bash
# Check datasource UIDs
curl -s 'http://localhost:32500/api/datasources' \
  -H 'Authorization: Basic YWRtaW46Q0hBTkdFX01F' \
  | python3 -c "import sys,json; [print(f'{d[\"name\"]}: uid={d[\"uid\"]}') for d in json.load(sys.stdin)]"
```

Expected: `Prometheus: uid=prometheus`, `Tempo: uid=tempo`, `Loki: uid=loki`.

---

## Issue 3: Service Health Dashboard Shows No Data

### Symptom

The Service Health dashboard loaded but every panel was empty — "No data" on all graphs.

### Root Cause

The original dashboard used `istio_requests_total` (L7 HTTP request metrics). In **Istio Ambient mode**, only ztunnel runs (no sidecar envoy proxies). ztunnel operates at **L4 only** and exposes only TCP metrics:

- `istio_tcp_connections_opened_total` (L4)
- `istio_tcp_connections_closed_total` (L4)
- `istio_tcp_sent_bytes_total` (L4)
- `istio_tcp_received_bytes_total` (L4)

L7 metrics like `istio_requests_total`, `istio_request_duration_milliseconds`, `istio_request_bytes` require a **waypoint proxy**, which is not deployed in this cluster.

### Fix — 1 File Changed

**File: `infra/observability/grafana/grafana.yaml`**

Completely rewrote the `service-health.json` dashboard with 7 panels using metrics that actually exist:

| Panel | PromQL | Source |
|-------|--------|--------|
| Request Rate (ecom-service) | `sum(rate(http_server_requests_seconds_count{job="ecom-service"}[5m])) by (uri)` | Spring Boot Micrometer |
| Error Rate (5xx) | `sum(rate(http_server_requests_seconds_count{job="ecom-service",status=~"5.."}[5m]))` | Spring Boot Micrometer |
| Avg Response Time | `rate(http_server_requests_seconds_sum{job="ecom-service"}[5m]) / rate(http_server_requests_seconds_count{job="ecom-service"}[5m])` | Spring Boot Micrometer |
| Max Response Time | `http_server_requests_seconds_max{job="ecom-service"}` | Spring Boot Micrometer |
| Service Up Status | `up{job=~"ecom-service\|inventory-service\|otel-collector"}` | Prometheus `up` metric |
| Mesh TCP Connections | `sum(rate(istio_tcp_connections_opened_total[5m])) by (pod)` | ztunnel L4 |
| Mesh TCP Throughput | `sum(rate(istio_tcp_sent_bytes_total[5m]))` | ztunnel L4 |

Dashboard tags changed from `["istio", "service-mesh"]` to `["service-health", "opentelemetry"]`.

### Why These Metrics Work

- **Spring Boot Micrometer** (`http_server_requests_seconds_*`): Exposed by ecom-service at `/ecom/actuator/prometheus`. These are application-level HTTP metrics (request count, latency, status codes) — independent of Istio.
- **Prometheus `up` metric**: Automatically generated for every scrape target. `1` = target is healthy, `0` = target is down.
- **ztunnel TCP metrics** (`istio_tcp_*`): L4 connection/byte counters from ztunnel DaemonSet pods. Available in Ambient mode without waypoint proxies.

---

## Issue 4: Cluster Overview Dashboard Shows No Data

### Symptom

The Cluster Overview dashboard showed empty panels for pod status, CPU usage, and memory usage.

### Root Cause — 3 Issues

1. **kube-state-metrics not deployed**: `kube_pod_status_phase`, `kube_pod_container_status_restarts_total` and other cluster state metrics come from kube-state-metrics. This component was never deployed.

2. **kubelet cAdvisor 403**: Container CPU/memory metrics (`container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`) come from kubelet's cAdvisor endpoint. Prometheus's ClusterRole was missing the `nodes/proxy` resource, so API proxy requests returned 403 Forbidden.

3. **Dashboard datasource UIDs missing**: The Cluster Overview panels had `"datasource": { "type": "prometheus", "uid": "" }` (empty UID) instead of `"uid": "prometheus"`.

### Fix — 3 Files Changed

**File 1: `infra/observability/kube-state-metrics/kube-state-metrics.yaml` (NEW)**

Created a complete kube-state-metrics deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kube-state-metrics
  namespace: observability
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: kube-state-metrics
  template:
    metadata:
      labels:
        app.kubernetes.io/name: kube-state-metrics
      annotations:
        ambient.istio.io/redirection: disabled
    spec:
      serviceAccountName: kube-state-metrics
      containers:
        - name: kube-state-metrics
          image: registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.13.0
          ports:
            - name: http-metrics
              containerPort: 8080
            - name: telemetry
              containerPort: 8081
```

Plus ServiceAccount, ClusterRole (with permissions to list/watch pods, deployments, nodes, etc.), and ClusterRoleBinding.

**File 2: `infra/observability/prometheus/prometheus.yaml`**

Added `nodes/proxy` to the ClusterRole (fixes cAdvisor 403):

```yaml
rules:
  - apiGroups: [""]
    resources: [nodes, nodes/metrics, nodes/proxy, services, endpoints, pods]
    #                                  ^^^^^^^^^^^^ ADDED
    verbs: [get, list, watch]
```

Added scrape config for kube-state-metrics:

```yaml
- job_name: 'kube-state-metrics'
  static_configs:
    - targets: ['kube-state-metrics.observability.svc.cluster.local:8080']
```

Added scrape config for kubelet cAdvisor (via API proxy):

```yaml
- job_name: 'kubelet-cadvisor'
  scheme: https
  tls_config:
    insecure_skip_verify: true
  bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
  kubernetes_sd_configs:
    - role: node
  relabel_configs:
    - target_label: __address__
      replacement: kubernetes.default.svc:443
    - source_labels: [__meta_kubernetes_node_name]
      target_label: __metrics_path__
      replacement: /api/v1/nodes/$1/proxy/metrics/cadvisor
    - source_labels: [__meta_kubernetes_node_name]
      target_label: node
```

**File 3: `infra/observability/grafana/grafana.yaml`**

Fixed `cluster-overview.json` — added `"uid": "prometheus"` to all panel datasources and scoped queries to application namespaces:

```json
{
  "datasource": { "type": "prometheus", "uid": "prometheus" },
  "targets": [{
    "expr": "sum(kube_pod_status_phase{namespace=~\"ecom|inventory|identity|infra|analytics|otel|observability\"}) by (phase)"
  }]
}
```

### Verification

```bash
# Check kube-state-metrics is running
kubectl get pods -n observability -l app.kubernetes.io/name=kube-state-metrics

# Check Prometheus can scrape it
curl -s 'http://localhost:32500/api/datasources/proxy/uid/prometheus/api/v1/query?query=kube_pod_status_phase' \
  -H 'Authorization: Basic YWRtaW46Q0hBTkdFX01F' \
  | python3 -c "import sys,json; r=json.load(sys.stdin); print(f'Results: {len(r[\"data\"][\"result\"])}')"
```

---

## Issue 5: OTel Collector Prometheus Target DOWN

### Symptom

Prometheus showed the `otel-collector` target as DOWN with error "EOF".

### Root Cause

The OTel Collector container declared port 8888 (internal metrics), but the **Kubernetes Service** did not expose it. Prometheus was trying to reach port 8888 via the Service DNS name, which had no matching port.

### Fix — 1 File Changed

**File: `infra/observability/otel-collector.yaml`**

Added port 8888 to the Service definition:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: otel-collector
  namespace: otel
spec:
  ports:
    - name: otlp-grpc
      port: 4317
    - name: otlp-http
      port: 4318
    - name: internal-metrics    # <-- ADDED
      port: 8888
      targetPort: 8888
    - name: prometheus-exporter
      port: 8889
```

### Verification

```bash
# Check target is up
curl -s 'http://localhost:32500/api/datasources/proxy/uid/prometheus/api/v1/query?query=up{job="otel-collector"}' \
  -H 'Authorization: Basic YWRtaW46Q0hBTkdFX01F' \
  | python3 -c "import sys,json; r=json.load(sys.stdin)['data']['result']; print(f'otel-collector: {r[0][\"value\"][1]}' if r else 'NOT FOUND')"
```

---

## Issue 6: inventory-service Prometheus Target DOWN

### Symptom

Prometheus showed inventory-service as DOWN with "connection reset by peer".

### Root Cause — 3 Layers

This was the most complex issue. Three separate security layers were blocking Prometheus:

**Layer 1: NetworkPolicy** — The inventory namespace had `default-deny-all` ingress. The `allow-to-inventory-service` policy allowed traffic from `infra` and `ecom` namespaces, but NOT `observability`.

**Layer 2: HBONE tunnel port** — Even after adding `observability` as an allowed namespace, the NetworkPolicy only allowed the application port (8000). In Istio Ambient mode, all cross-namespace mTLS traffic goes through the HBONE tunnel on **port 15008**. Port 15008 must also be allowed.

**Layer 3: AuthorizationPolicy** — The `inventory-service-policy` AuthorizationPolicy only allowed traffic from `infra` and `ecom` namespaces. When ANY ALLOW rule exists on a workload, all traffic not matching an ALLOW rule is **implicitly denied**. Prometheus from `observability` was being denied by Istio's authorization engine.

### Fix — 2 Files Changed

**File 1: `infra/kubernetes/network-policies/inventory-netpol.yaml`**

Added Prometheus scraping ingress from the observability namespace:

```yaml
# Prometheus scraping /metrics (port 8000 for app, port 15008 for HBONE tunnel)
- from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: observability
  ports:
    - port: 8000
    - port: 15008
```

**File 2: `infra/istio/security/authz-policies/inventory-service-policy.yaml`**

Added the observability namespace to the allow list:

```yaml
rules:
  - from:
      - source:
          namespaces: ["infra"]
  - from:
      - source:
          namespaces: ["ecom"]
  # Allow Prometheus metrics scraping from observability namespace
  - from:                              # <-- ADDED
      - source:
          namespaces: ["observability"]
```

### How to Debug This Pattern

When a Prometheus target shows "connection reset by peer" in Istio Ambient mode, check in order:

```bash
# 1. Check ztunnel logs for RBAC/policy denials
kubectl logs -n istio-system -l app=ztunnel --tail=100 | grep -i "denied\|RBAC\|policy\|inventory"

# 2. Check NetworkPolicy allows both the app port AND 15008
kubectl get networkpolicy -n inventory -o yaml | grep -A5 "observability"

# 3. Check AuthorizationPolicy includes observability namespace
kubectl get authorizationpolicy -n inventory -o yaml | grep -A3 "namespaces"
```

The key insight: **In Istio Ambient mode, cross-namespace Prometheus scraping requires THREE things:**
1. NetworkPolicy: allow app port + port 15008 (HBONE) from observability
2. AuthorizationPolicy: allow observability namespace
3. PeerAuthentication: STRICT or PERMISSIVE both work (traffic goes through HBONE mTLS tunnel)

---

## Issue 7: kube-state-metrics Target DOWN

### Symptom

After deploying kube-state-metrics, Prometheus showed it as DOWN with "context deadline exceeded".

### Root Cause

The observability namespace had a `default-deny-ingress` NetworkPolicy. kube-state-metrics had no ingress rule allowing Prometheus to reach it.

### Fix — 1 File Changed

**File: `infra/kubernetes/network-policies/observability-netpol.yaml`**

Added a NetworkPolicy allowing Prometheus to scrape kube-state-metrics:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kube-state-metrics-ingress
  namespace: observability
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: kube-state-metrics
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: prometheus
      ports:
        - port: 8080
        - port: 8081
    # HBONE tunnel port for Istio Ambient
    - ports:
        - port: 15008
```

---

## Issue 8: kubelet cAdvisor 403 Forbidden

### Symptom

Prometheus's kubelet-cadvisor targets showed UP but returned no metrics. Logs showed `403 Forbidden` when accessing `/api/v1/nodes/<node>/proxy/metrics/cadvisor`.

### Root Cause

The Prometheus ClusterRole had:

```yaml
resources: [nodes, nodes/metrics, services, endpoints, pods]
```

The cAdvisor scrape config accesses metrics via the Kubernetes API server proxy: `/api/v1/nodes/<node>/proxy/metrics/cadvisor`. This requires the `nodes/proxy` sub-resource, which was missing.

### Fix — 1 File Changed

**File: `infra/observability/prometheus/prometheus.yaml`**

Added `nodes/proxy` to the ClusterRole resources:

```yaml
rules:
  - apiGroups: [""]
    resources: [nodes, nodes/metrics, nodes/proxy, services, endpoints, pods]
    verbs: [get, list, watch]
```

---

## Summary of All Files Changed

| # | File | Issues Fixed | Type |
|---|------|-------------|------|
| 1 | `ecom-service/k8s/ecom-service.yaml` | Issue 1 | Env var change |
| 2 | `inventory-service/k8s/inventory-service.yaml` | Issue 1 | Env var change |
| 3 | `inventory-service/app/main.py` | Issue 1 | Python OTel SDK setup |
| 4 | `infra/observability/otel-collector.yaml` | Issues 1, 5 | Processor + Service port |
| 5 | `infra/observability/grafana/grafana.yaml` | Issues 2, 3, 4 | UIDs + dashboard rewrites |
| 6 | `infra/observability/loki/loki.yaml` | Issue 1 | Image pinning + config |
| 7 | `infra/observability/kube-state-metrics/kube-state-metrics.yaml` | Issue 4 | NEW deployment |
| 8 | `infra/observability/prometheus/prometheus.yaml` | Issues 4, 8 | Scrape configs + RBAC |
| 9 | `infra/kubernetes/network-policies/inventory-netpol.yaml` | Issue 6 | Prometheus ingress |
| 10 | `infra/kubernetes/network-policies/observability-netpol.yaml` | Issue 7 | kube-state-metrics ingress |
| 11 | `infra/istio/security/authz-policies/inventory-service-policy.yaml` | Issue 6 | Observability allow |
| 12 | `e2e/otel-loki.spec.ts` | All | 43 automated tests |

### Apply Order

After making all changes, apply in this order:

```bash
# 1. Deploy kube-state-metrics
kubectl apply -f infra/observability/kube-state-metrics/kube-state-metrics.yaml

# 2. Update Prometheus (RBAC + scrape configs)
kubectl apply -f infra/observability/prometheus/prometheus.yaml
kubectl rollout restart deployment prometheus -n observability

# 3. Update NetworkPolicies
kubectl apply -f infra/kubernetes/network-policies/inventory-netpol.yaml
kubectl apply -f infra/kubernetes/network-policies/observability-netpol.yaml

# 4. Update AuthorizationPolicy
kubectl apply -f infra/istio/security/authz-policies/inventory-service-policy.yaml

# 5. Update OTel Collector (add port 8888 to Service)
kubectl apply -f infra/observability/otel-collector.yaml

# 6. Rebuild and redeploy services (for OTEL_LOGS_EXPORTER change)
docker build -t bookstore/ecom-service:latest ./ecom-service
docker build -t bookstore/inventory-service:latest ./inventory-service
kind load docker-image bookstore/ecom-service:latest --name bookstore
kind load docker-image bookstore/inventory-service:latest --name bookstore
kubectl rollout restart deployment ecom-service -n ecom
kubectl rollout restart deployment inventory-service -n inventory

# 7. Reset Grafana PVC and redeploy (for UID + dashboard changes)
kubectl delete deployment grafana -n observability
kubectl run grafana-cleanup -n observability --image=busybox --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"c","image":"busybox","command":["sh","-c","rm -rf /data/*"],"volumeMounts":[{"name":"d","mountPath":"/data"}]}],"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"grafana-pvc"}}]}}'
kubectl wait --for=condition=Ready pod/grafana-cleanup -n observability --timeout=30s
kubectl delete pod grafana-cleanup -n observability
kubectl apply -f infra/observability/grafana/grafana.yaml

# 8. Verify all Prometheus targets are UP (wait ~30s for scraping)
sleep 30
curl -s 'http://localhost:32500/api/datasources/proxy/uid/prometheus/api/v1/targets' \
  -H 'Authorization: Basic YWRtaW46Q0hBTkdFX01F' \
  | python3 -c "
import sys, json
targets = json.load(sys.stdin)['data']['activeTargets']
for t in sorted(targets, key=lambda x: x['labels'].get('job','')):
    print(f'{t[\"labels\"][\"job\"]:30s} {t[\"health\"]:6s} {t.get(\"lastError\",\"\")[:60]}')
print(f'\nTotal: {len(targets)} targets, {sum(1 for t in targets if t[\"health\"]==\"up\")} up')
"
```

### Run E2E Tests

```bash
cd e2e
npx playwright test otel-loki.spec.ts --reporter=list
# Expected: 43 passed
```
