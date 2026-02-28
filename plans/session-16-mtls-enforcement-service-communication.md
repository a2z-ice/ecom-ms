# Session 16 — mTLS Enforcement & Synchronous Service-to-Service Communication

**Goal:** Fix five concrete gaps in Istio mTLS enforcement between services and add a real synchronous inter-service call (ecom-service → inventory-service at checkout).

## Root Cause Analysis

| # | Gap | Fix |
|---|-----|-----|
| 1 | **ServiceAccount identity mismatch** — Deployments used `default` SA; actual mTLS principal was `cluster.local/ns/ecom/sa/default`, not `cluster.local/ns/ecom/sa/ecom-service`. AuthorizationPolicy rule was dead. | Named ServiceAccounts + Deployment references |
| 2 | **No synchronous mTLS call existed** — `OrderService.checkout()` only published a Kafka event. `/inven/stock/reserve` was never called. | `InventoryClient.java` + `OrderService` pre-checkout reserve loop |
| 3 | **DB pods had no AuthorizationPolicies** — any pod in the cluster could reach them. | L4 DB policies per namespace |
| 4 | **NetworkPolicy missing egress to inventory** — `ecom-netpol.yaml` had no egress rule for ecom → inventory port 8000. | Updated ecom-netpol + new inventory-netpol |
| 5 | **Book/inventory UUID mismatch** — ecom seeded books with `gen_random_uuid()`, inventory used fixed sequential UUIDs. Reserve calls always failed with 404. | Liquibase changeset 005 re-seeds books with matching fixed UUIDs |

## Deliverables

### Istio Security
| File | Action |
|------|--------|
| `infra/istio/security/serviceaccounts.yaml` | NEW — named SAs: `ecom-service` (ecom ns) + `inventory-service` (inventory ns) |
| `infra/istio/security/authz-policies/ecom-db-policy.yaml` | NEW — L4: locks ecom-db to ecom/infra namespaces |
| `infra/istio/security/authz-policies/inventory-db-policy.yaml` | NEW — L4: locks inventory-db to inventory/infra namespaces |
| `infra/istio/security/authz-policies/keycloak-db-policy.yaml` | NEW — L4: locks keycloak-db to identity namespace |

### Network Policies
| File | Action |
|------|--------|
| `infra/kubernetes/network-policies/ecom-netpol.yaml` | Added: egress to inventory port 8000, HBONE port 15008, Prometheus ingress (observability ns), ui-service ingress |
| `infra/kubernetes/network-policies/inventory-netpol.yaml` | NEW — default-deny-all + allow ecom → inventory-service + inventory-db rules |

### Kubernetes Manifests
| File | Action |
|------|--------|
| `ecom-service/k8s/ecom-service.yaml` | `serviceAccountName: ecom-service` + `INVENTORY_SERVICE_URL` env var |
| `inventory-service/k8s/inventory-service.yaml` | `serviceAccountName: inventory-service` |
| `infra/kgateway/routes/inven-route.yaml` | Restricted to GET /inven/stock/* and GET /inven/health only |

### ecom-service Java Code
| File | Action |
|------|--------|
| `config/RestClientConfig.java` | NEW — `RestClient` bean with `INVENTORY_SERVICE_URL` base URL; forced HTTP/1.1 via `JdkClientHttpRequestFactory(HttpClient.newBuilder().version(HTTP_1_1).build())` |
| `client/InventoryClient.java` | NEW — `reserve(bookId, qty)` POST to inventory |
| `dto/InventoryReserveRequest.java` | NEW — snake_case fields matching FastAPI schema |
| `dto/InventoryReserveResponse.java` | NEW |
| `service/OrderService.java` | Pre-checkout inventory reserve loop before order creation |
| `resources/db/changelog/005-fix-book-uuids.yaml` | NEW — re-seeds books with fixed sequential UUIDs matching inventory |
| `resources/db/changelog/db.changelog-master.yaml` | Includes changeset 005 |

### E2E
| File | Action |
|------|--------|
| `e2e/mtls-enforcement.spec.ts` | NEW — 4 tests: external POST /reserve → 404, checkout without JWT → 401, checkout via mTLS succeeds, reserved count increases |

## Critical Implementation Notes

**Istio Ambient ztunnel L4 only:** L7 AuthorizationPolicy rules (methods, paths, `requestPrincipals`) are omitted by ztunnel → implicit deny-all. Use only namespace/principal checks.

**Gateway pod namespace:** Gateway runs in `infra` namespace (not `kgateway-system`) with `gatewayClassName: istio`. NetworkPolicy and AuthorizationPolicy must allow from `infra` namespace.

**HBONE port 15008:** Istio Ambient ztunnel uses port 15008 for inter-node mTLS tunneling. Pod NetworkPolicies needing cross-node connections require egress rule for port 15008.

**Java RestClient + Starlette:** Spring Boot 4.0's `JdkClientHttpRequestFactory` may send `h2c` upgrade headers → `400 "Invalid HTTP request received."` from uvicorn/Starlette. Fix: `HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build()`.

## Build & Deploy

```bash
cd ecom-service && mvn package -DskipTests
docker build -t bookstore/ecom-service:latest . && kind load docker-image bookstore/ecom-service:latest --name bookstore

cd ../inventory-service
docker build -t bookstore/inventory-service:latest . && kind load docker-image bookstore/inventory-service:latest --name bookstore

kubectl apply -f infra/istio/security/serviceaccounts.yaml
kubectl apply -f infra/istio/security/authz-policies/
kubectl apply -f infra/kubernetes/network-policies/
kubectl apply -f ecom-service/k8s/ecom-service.yaml
kubectl apply -f inventory-service/k8s/inventory-service.yaml
kubectl rollout restart deployment/ecom-service -n ecom
kubectl rollout restart deployment/inventory-service -n inventory
```

## Acceptance Criteria

- [x] `kubectl get sa -n ecom ecom-service` and `kubectl get sa -n inventory inventory-service` exist
- [x] External `POST http://api.service.net:30000/inven/stock/reserve` → 404
- [x] `POST http://api.service.net:30000/ecom/checkout` without JWT → 401
- [x] Checkout via UI succeeds (mTLS reserve call works end-to-end)
- [x] `GET /inven/stock/00000000-0000-0000-0000-000000000001` `reserved` field increases after checkout
- [x] E2E tests: 45/45 passing

## Status: Complete ✓
