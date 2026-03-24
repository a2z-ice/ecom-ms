# Session 31 — Security: Application Layer (JWT, Validation)

## Goal
Fix JWT audience validation gaps and add input bounds on mutating endpoints.

## Deliverables

| # | Item | Files |
|---|------|-------|
| 1 | JWT audience validation — ecom-service | `SecurityConfig.java` |
| 2 | Fix inventory `verify_aud: False` | `inventory-service/app/middleware/auth.py` |
| 3 | `jwt_audience` setting | `inventory-service/app/config.py` |
| 4 | `@Max(99)` on CartRequest quantity | `ecom-service/dto/CartRequest.java` |
| 5 | `@Max(99)` on CartUpdateRequest quantity | `ecom-service/dto/CartUpdateRequest.java` |
| 6 | `le=99` on ReserveRequest quantity | `inventory-service/app/schemas/inventory.py` |
| 7 | Remove root initContainers from observability | `prometheus.yaml`, `tempo.yaml`, `loki.yaml` |
| 8 | E2E tests | `e2e/input-validation.spec.ts` |

## Acceptance Criteria
- JWT tokens validated against `account` audience in both services
- Cart/reserve quantities bounded 1-99
- No root initContainers in observability stack
- All existing tests pass

## Status: COMPLETE
