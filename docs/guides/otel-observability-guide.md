# OpenTelemetry Observability Guide

## Architecture

```
ecom-service (Java OTel Agent)  ──OTLP HTTP──┐
                                              ├──► OTel Collector ──► Tempo (traces)
inventory-service (Python OTel SDK) ──OTLP HTTP──┘        │        ──► Loki (logs)
                                                           └───────── Prometheus (metrics)
                                                                          │
                                                              Grafana ◄───┘
                                                         (localhost:32500)
```

### Components

| Component | Namespace | Technology | Purpose |
|-----------|-----------|------------|---------|
| OTel Collector | `otel` | `otel/opentelemetry-collector-contrib:0.104.0` | Receives OTLP, routes to backends |
| Grafana Tempo | `otel` | `grafana/tempo:2.6.1` | Trace storage & query |
| Grafana Loki | `otel` | `grafana/loki:latest` | Log aggregation |
| Prometheus | `observability` | Already deployed | Metrics scraping |
| Grafana | `observability` | `grafana/grafana:latest` | Visualization (NodePort 32500) |
| AlertManager | `observability` | Already deployed | Alert routing |

### Why a separate `otel` namespace?

Istio Ambient mesh (ztunnel) intercepts ALL traffic from mesh-enrolled pods. When OTel Collector and Tempo are in the same mesh namespace with STRICT mTLS, ztunnel's HBONE tunneling interferes with HTTP/gRPC connections between them. The `otel` namespace uses PERMISSIVE mTLS, which allows ztunnel to handle both mTLS and plaintext connections correctly.

---

## Step-by-Step: Testing Traces

### 1. Verify all OTel pods are running

```bash
kubectl get pods -n otel
# Expected: otel-collector, tempo, loki — all Running
kubectl get pods -n observability
# Expected: grafana, prometheus, alertmanager — all Running
```

### 2. Generate traffic

```bash
# Public API calls
curl http://api.service.net:30000/ecom/books
curl http://api.service.net:30000/inven/stock/00000000-0000-0000-0000-000000000001

# Search
curl "http://api.service.net:30000/ecom/books/search?q=Java"

# With authentication (admin)
TOKEN=$(curl -s -X POST \
  "http://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=ui-client&username=admin1&password=CHANGE_ME" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

curl -H "Authorization: Bearer $TOKEN" http://api.service.net:30000/ecom/cart
curl -H "Authorization: Bearer $TOKEN" http://api.service.net:30000/inven/admin/stock
```

### 3. Open Grafana

1. Open **http://localhost:32500** in your browser
2. Login: `admin` / `CHANGE_ME`

### 4. View Traces in Grafana

1. Click **Explore** (compass icon in left sidebar)
2. Select **Tempo** from the datasource dropdown (top left)
3. Choose **Search** query type
4. In the **Service Name** dropdown, select `ecom-service` or `inventory-service`
5. Click **Run query**
6. You'll see a list of traces — click any trace to see the full span waterfall

### 5. View a Trace Detail

Each trace shows:
- **Root span**: The HTTP request that started the trace (e.g., `GET /ecom/books`)
- **Child spans**: Database queries (PostgreSQL), Kafka operations, HTTP calls
- **Duration**: How long each span took
- **Attributes**: HTTP method, status code, URL, DB statements, etc.

Example trace for `GET /ecom/books`:
```
GET /ecom/books (ecom-service)              [12ms]
├── SELECT * FROM books (ecom-service)      [3ms]
└── spring.security (ecom-service)          [1ms]
```

Example trace for `POST /checkout` (cross-service):
```
POST /ecom/checkout (ecom-service)                    [150ms]
├── SELECT * FROM cart_items (ecom-service)            [2ms]
├── POST /inven/stock/reserve (ecom-service → inventory) [50ms]
│   ├── SELECT * FROM inventory (inventory-service)    [3ms]
│   └── UPDATE inventory (inventory-service)           [5ms]
├── INSERT INTO orders (ecom-service)                  [5ms]
└── kafka.send order.created (ecom-service)            [10ms]
```

### 6. View Pre-built Dashboards

Navigate to **Dashboards** in the left sidebar:

1. **Service Health** — Request rates, error rates, p50/p99 latency by service (from Istio metrics)
2. **Cluster Overview** — Pods by phase, restart counts, CPU/memory usage
3. **Distributed Tracing** — Recent traces table, OTel spans rate, collector health, service node graph

---

## Step-by-Step: Testing Logs

### 1. View Logs in Grafana

1. Click **Explore** → Select **Loki** datasource
2. Enter a LogQL query:
   ```
   {job="otel-collector"}
   ```
3. Click **Run query**

> **Note**: Application logs are currently sent to stdout (not to OTel Collector). To see application logs in Loki, you would need to configure a log collector (e.g., Promtail, Alloy) or configure the OTel Java agent to export logs. Currently, the OTel agent only exports traces (`OTEL_LOGS_EXPORTER=none`).

To view application logs directly:
```bash
# ecom-service logs (structured JSON via ECS)
kubectl logs -n ecom deploy/ecom-service --tail=20

# inventory-service logs (structured JSON)
kubectl logs -n inventory deploy/inventory-service --tail=20
```

---

## Step-by-Step: Testing Metrics & Monitoring

### 1. View Prometheus Metrics

```bash
# ecom-service actuator metrics
curl http://api.service.net:30000/ecom/actuator/prometheus | head -20

# inventory-service Prometheus metrics
curl http://api.service.net:30000/inven/metrics | head -20
```

### 2. View Metrics in Grafana

1. Click **Explore** → Select **Prometheus** datasource
2. Try these queries:

```promql
# Request rate by service (from Istio)
sum(rate(istio_requests_total[5m])) by (destination_service_name)

# Error rate (5xx)
sum(rate(istio_requests_total{response_code=~"5.*"}[5m])) by (destination_service_name)

# p99 latency
histogram_quantile(0.99, sum(rate(istio_request_duration_milliseconds_bucket[5m])) by (destination_service_name, le))

# OTel Collector spans received
sum(rate(otelcol_receiver_accepted_spans[5m])) by (receiver)
```

### 3. View Alerting Rules

```bash
# Check Prometheus alert rules
curl -s http://localhost:32500/api/datasources/proxy/uid/PBFA97CFB590B2093/api/v1/rules \
  -u admin:CHANGE_ME | python3 -m json.tool | head -40
```

Pre-configured alert rules:
- **HighErrorRate** — Fires when 5xx error rate > 5% for 5 minutes
- **PodRestartLoop** — Fires when pod restarts > 3 in 15 minutes
- **HighLatency** — Fires when p99 latency > 5000ms for 5 minutes
- **KafkaConsumerLag** — Fires when consumer lag > 1000 for 10 minutes

---

## API Reference

### OTel Collector

```bash
# Health check
kubectl exec -n otel deploy/otel-collector -- wget -qO- http://localhost:13133/ 2>/dev/null
```

### Tempo

```bash
# Tempo readiness
kubectl exec -n otel deploy/tempo -- wget -qO- http://localhost:3200/ready 2>/dev/null || \
  kubectl get pods -n otel -l app=tempo  # Check pod status instead

# Search traces via Grafana proxy
curl -s "http://localhost:32500/api/datasources/proxy/uid/P214B5B846CF3925F/api/search?limit=5" \
  -u admin:CHANGE_ME | python3 -m json.tool

# Search by service name
curl -s "http://localhost:32500/api/datasources/proxy/uid/P214B5B846CF3925F/api/search?limit=5&tags=service.name%3Decom-service" \
  -u admin:CHANGE_ME | python3 -m json.tool

# Get trace by ID
TRACE_ID="<paste-trace-id-here>"
curl -s "http://localhost:32500/api/datasources/proxy/uid/P214B5B846CF3925F/api/traces/$TRACE_ID" \
  -u admin:CHANGE_ME | python3 -m json.tool
```

### Grafana

| URL | Description |
|-----|-------------|
| `http://localhost:32500` | Grafana UI (admin / CHANGE_ME) |
| `http://localhost:32500/explore` | Explore (query Tempo/Loki/Prometheus) |
| `http://localhost:32500/dashboards` | Pre-built dashboards |
| `http://localhost:32500/d/distributed-tracing` | Distributed Tracing dashboard |
| `http://localhost:32500/d/service-health` | Service Health dashboard |
| `http://localhost:32500/d/cluster-overview` | Cluster Overview dashboard |

---

## Service OTel Configuration

### ecom-service (Java)

The OTel Java agent (`v2.25.0`) auto-instruments:
- Spring MVC (HTTP requests)
- JDBC / Hibernate (database queries)
- Kafka (producer/consumer)
- RestClient (outbound HTTP calls)

Configuration via environment variables in `ecom-service/k8s/ecom-service.yaml`:
```yaml
- name: JAVA_TOOL_OPTIONS
  value: "-XX:MaxRAMPercentage=75.0 -XX:+UseG1GC -javaagent:/otel/opentelemetry-javaagent.jar"
- name: OTEL_SERVICE_NAME
  value: "ecom-service"
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: "http://otel-collector.otel.svc.cluster.local:4318"
- name: OTEL_EXPORTER_OTLP_PROTOCOL
  value: "http/protobuf"
- name: OTEL_TRACES_EXPORTER
  value: "otlp"
- name: OTEL_METRICS_EXPORTER
  value: "none"    # Prometheus handles metrics
- name: OTEL_LOGS_EXPORTER
  value: "none"    # Logs go to stdout (structured ECS format)
```

### inventory-service (Python)

OTel Python SDK instruments FastAPI:
- HTTP requests (FastAPI routes)
- Database queries (SQLAlchemy — when enabled)

Configuration in `inventory-service/app/main.py`:
```python
if os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
    # Initialize TracerProvider with OTLP HTTP exporter
    # Instrument FastAPI app
```

Environment variables in `inventory-service/k8s/inventory-service.yaml`:
```yaml
- name: OTEL_SERVICE_NAME
  value: "inventory-service"
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: "http://otel-collector.otel.svc.cluster.local:4318"
- name: OTEL_EXPORTER_OTLP_PROTOCOL
  value: "http/protobuf"
```

---

## Troubleshooting

### No traces appearing in Tempo

1. Check OTel Collector is receiving spans:
   ```bash
   kubectl logs -n otel deploy/otel-collector --tail=20 | grep TracesExporter
   # Should show "resource spans: N, spans: M"
   ```

2. Check for export errors:
   ```bash
   kubectl logs -n otel deploy/otel-collector --tail=50 | grep -i "error\|failed"
   ```

3. Check service-side OTel agent:
   ```bash
   # Java agent
   kubectl logs -n ecom deploy/ecom-service | grep -i "otel\|otlp"
   # Python SDK
   kubectl logs -n inventory deploy/inventory-service | grep -i "otel\|otlp"
   ```

### Tempo returning errors

```bash
kubectl logs -n otel deploy/tempo --tail=20
```

### OTel Collector not receiving data

Check if services can reach the collector (ztunnel may block cross-namespace traffic):
```bash
kubectl logs -n istio-system ds/ztunnel --tail=50 | grep "otel\|4318"
```

The `otel` namespace must be enrolled in the Istio mesh (with PERMISSIVE mTLS) for ztunnel to establish HBONE tunnels from mesh pods to it.
