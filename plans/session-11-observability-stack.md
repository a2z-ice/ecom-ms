# Session 11 — Observability Stack

**Goal:** Metrics, tracing, and dashboards for all services.

## Deliverables

- `infra/observability/prometheus/prometheus.yaml` — Prometheus deployed to `observability` namespace
  - Scrape configs: `istiod` (port 15014, `/metrics`), `ztunnel` DaemonSet (port 15020, `/stats/prometheus`), ecom-service, inventory-service
  - RBAC: ServiceAccount + ClusterRole + ClusterRoleBinding
- `infra/observability/kiali/` — Kiali Deployment connected to Prometheus and Istio
  - `prometheus-alias.yaml` — ExternalName Service `prometheus.istio-system` → `prometheus.observability:9090`
  - `kiali-config-patch.yaml` — disables ingressgateway/egressgateway/cni-node checks + Grafana
  - `kiali-nodeport.yaml` — NodePort at port 32100
- `infra/observability/otel-collector.yaml` — OpenTelemetry Collector
- `infra/observability/grafana/` — Grafana Deployment (optional dashboards)

## Kiali NodePort Access

Kiali is accessible at `http://localhost:32100/kiali` via a Docker socat proxy container:
```bash
CTRL_IP=$(kubectl get node bookstore-control-plane -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')
docker rm -f kiali-proxy 2>/dev/null
docker run -d --name kiali-proxy --network kind --restart unless-stopped \
  -p 32100:32100 alpine/socat TCP-LISTEN:32100,fork,reuseaddr TCP:${CTRL_IP}:32100
```

## Prometheus → Kiali Bridge

Kiali defaults to `http://prometheus.istio-system:9090`. Bridge via ExternalName service:
- After applying `prometheus-alias.yaml`, restart Kiali to pick up the live Prometheus connection
- Verify: `GET /kiali/api/status` — Prometheus must appear in `externalServices`

## Kiali Traffic Graph

Traffic graph uses L4 TCP metrics (`istio_tcp_connections_*`) from ztunnel — no L7 metrics (`istio_requests_total`) because no waypoint proxy is deployed. Expect ~10 nodes and ~12 edges for ecom+inventory namespaces.

## Acceptance Criteria

- [x] Kiali accessible at `http://localhost:32100/kiali`
- [x] Kiali traffic graph shows ≥10 nodes and ≥12 edges
- [x] Prometheus scrapes istiod and ztunnel successfully
- [x] `GET /kiali/api/status` shows Prometheus in `externalServices`

## Status: Complete ✓
