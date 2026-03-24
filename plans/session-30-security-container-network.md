# Session 30 — Security: Container & Network Layer

## Goal
Eliminate critical container and network security gaps.

## Deliverables

| # | Item | Files |
|---|------|-------|
| 1 | `.dockerignore` for ecom-service, inventory-service, ui | 3 new files |
| 2 | Gateway egress restricted to named namespaces/ports | `infra/kubernetes/network-policies/infra-netpol.yaml` |
| 3 | Kafka ingress restricted to named pods | `infra/kubernetes/network-policies/infra-netpol.yaml` |
| 4 | Inventory CORS — remove DELETE | `inventory-service/app/main.py` |
| 5 | Cert-dashboard RBAC — remove create/delete on ClusterRoles | `cert-dashboard-operator/config/rbac/role.yaml` |
| 6 | Ecom logging — `${LOG_LEVEL:INFO}` | `ecom-service/src/main/resources/application.yml` |
| 7 | PSS `restricted` for ecom/inventory | `infra/namespaces.yaml` |
| 8 | E2E tests | `e2e/security-hardening.spec.ts` |

## Acceptance Criteria
- Gateway egress restricted to ecom(8080), inventory(8000), identity(8080), UI(80), DNS, HBONE
- Kafka ingress restricted to debezium-server-ecom, debezium-server-inventory, schema-registry, kafka-exporter
- No DELETE in inventory CORS
- PSS `restricted` on ecom and inventory namespaces
- All existing E2E tests pass

## Status: COMPLETE
