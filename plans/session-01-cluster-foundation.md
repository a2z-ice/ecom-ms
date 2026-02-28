# Session 01 — Cluster Foundation

**Goal:** A running kind cluster with Istio Ambient Mesh, KGateway, and all namespaces ready. No applications yet.

## Deliverables

- `infra/kind/cluster.yaml` — kind cluster config with:
  - `hostMapping` entries for `myecom.net`, `api.service.net`, `idp.keycloak.net` → node IP
  - `NodePort` range including 30000 and 31111
- `infra/namespaces.yaml` — namespaces: `ecom`, `inventory`, `analytics`, `identity`, `infra`, `observability`
  - Each namespace labelled for Istio ambient: `istio.io/dataplane-mode: ambient`
- `infra/istio/install.sh` — installs Istio Ambient Mesh 1.28.4 via `istioctl` with ambient profile
- `infra/kgateway/install.sh` — installs KGateway CRDs and controller (latest)
- `scripts/cluster-up.sh` — idempotent script: creates cluster, installs Istio, KGateway, applies namespaces

## Acceptance Criteria

- [x] `kubectl get nodes` shows cluster ready
- [x] `istioctl verify-install` passes
- [x] KGateway controller pod running in `kgateway-system`
- [x] All namespaces exist with correct Istio labels
- [x] No port-forwarding required to reach NodePort 30000 from host

## Status: Complete ✓
