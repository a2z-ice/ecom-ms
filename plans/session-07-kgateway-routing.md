# Session 07 — KGateway Routing

**Goal:** All external routes configured and verified end-to-end through Kubernetes Gateway API (Istio's built-in Gateway implementation).

## Deliverables

- `infra/kgateway/gateway.yaml` — Gateway resource:
  - `gatewayClassName: istio`
  - Listener on port 30000 (HTTP, NodePort)
  - Gateway pod runs in `infra` namespace
- `infra/kgateway/routes/ui-route.yaml` — `myecom.net` → `ui-service`
- `infra/kgateway/routes/ecom-route.yaml` — `api.service.net /ecom` → `ecom-service`
- `infra/kgateway/routes/inven-route.yaml` — `api.service.net /inven` → `inventory-service`
  - Restricted to GET /inven/stock/* and GET /inven/health only (POST /reserve not exposed externally)
- `infra/kgateway/routes/keycloak-route.yaml` — `idp.keycloak.net` → `keycloak-service`
- `scripts/verify-routes.sh` — `curl` smoke tests for all routes

## Host Resolution

Add to `/etc/hosts`:
```
127.0.0.1  idp.keycloak.net
127.0.0.1  myecom.net
127.0.0.1  api.service.net
```

## Acceptance Criteria

- [x] All four hostnames resolve and respond correctly from host machine
- [x] Path prefix stripping works: `/ecom/books` → ecom-service receives `/ecom/books` (consistent with service config)
- [x] No NodePort change required; all traffic through port 30000
- [x] `verify-routes.sh` exits 0

## Status: Complete ✓
