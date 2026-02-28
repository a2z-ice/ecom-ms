# Session 14 — Data Persistence, Kiali Fix & Guest Cart

**Goal:** Persistent storage for all DB/Kafka/Redis instances, Kiali traffic graph working with Prometheus, and guest cart UX for unauthenticated users.

## Problems Addressed

1. **Data loss on cluster recreation** — PVCs backed by ephemeral provisioner lose data when cluster is deleted
2. **Kiali traffic graph broken** — Kiali looks for `http://prometheus.istio-system:9090` but Prometheus was in `observability` namespace
3. **Guest cart missing** — Unauthenticated users had no cart before login
4. **No single-command bootstrap** — manual multi-step cluster setup
5. **No clean teardown** — no way to remove cluster and optionally purge host data

## Deliverables

### Infrastructure — Persistence
| File | Action |
|------|--------|
| `infra/kind/cluster.yaml` | `extraMounts` (DATA_DIR placeholder) to all 3 nodes for 7 data dirs |
| `infra/storage/storageclass.yaml` | NEW — `local-hostpath` StorageClass, `WaitForFirstConsumer`, `Retain` |
| `infra/storage/persistent-volumes.yaml` | NEW — 7 hostPath PVs (ecom-db, inventory-db, analytics-db, keycloak-db, superset, kafka, redis) |
| `infra/postgres/ecom-db.yaml` | PVC: `storageClassName: local-hostpath`, `volumeName: ecom-db-pv` |
| `infra/postgres/inventory-db.yaml` | Same pattern |
| `infra/postgres/analytics-db.yaml` | Same pattern |
| `infra/keycloak/keycloak.yaml` | keycloak-db PVC updated |
| `infra/superset/superset.yaml` | superset PVC updated |
| `infra/kafka/kafka.yaml` | kafka PVC updated |
| `infra/redis/redis.yaml` | redis PVC updated |

### Infrastructure — Kiali Fix
| File | Action |
|------|--------|
| `infra/observability/kiali/prometheus-alias.yaml` | NEW — ExternalName Service bridging `prometheus.istio-system` → `prometheus.observability:9090` |
| `infra/observability/kiali/kiali-config-patch.yaml` | Kiali ConfigMap patch: only checks istiod (not ingressgateway/egressgateway/cni-node), Grafana disabled |
| `infra/observability/kiali/kiali-nodeport.yaml` | NodePort Service at port 32100 |

### Scripts
| File | Action |
|------|--------|
| `scripts/stack-up.sh` | NEW — one-command full bootstrap (11 steps) |
| `scripts/sanity-test.sh` | NEW — comprehensive sanity checks |
| `scripts/cluster-down.sh` | NEW — clean teardown with `--purge-data` option |
| `scripts/cluster-up.sh` | Updated: DATA_DIR substitution via `sed` before `kind create cluster` |

### UI — Guest Cart
| File | Action |
|------|--------|
| `ui/src/hooks/useGuestCart.ts` | NEW — localStorage-backed guest cart under key `bookstore_guest_cart` |
| `ui/src/pages/CatalogPage.tsx` | Guest cart, card layout, toast |
| `ui/src/pages/CartPage.tsx` | Guest cart display, qty controls, Login-to-Checkout |
| `ui/src/pages/CallbackPage.tsx` | Sync guest cart to server cart after OIDC callback, then clear localStorage |
| `ui/src/pages/SearchPage.tsx` | Guest cart support |
| `ui/src/components/NavBar.tsx` | Cart badge (guest + auth count) |

### E2E
| File | Action |
|------|--------|
| `e2e/guest-cart.spec.ts` | NEW — 4 tests: add-as-guest, checkout-redirect, cart-preserved-after-login, badge |
| `e2e/istio-gateway.spec.ts` | NEW — 6 tests covering all HTTPRoutes and JWT enforcement |
| `e2e/kiali.spec.ts` | NEW — 3 tests for Kiali dashboard, graph, Prometheus connectivity |

## Data Directory Structure

```
data/
├── ecom-db/        # PostgreSQL uid 999 — hostPath bind-mounted into all 3 kind nodes
├── inventory-db/
├── analytics-db/
├── keycloak-db/
├── superset/       # uid 1000
├── kafka/          # uid 1000
└── redis/          # uid 999
```

`DATA_DIR` placeholder in `cluster.yaml` is substituted at runtime by `cluster-up.sh` via `sed`.

## Guest Cart Flow

1. Guest browses → "Add to Cart" → stored in `localStorage` under `bookstore_guest_cart`
2. Guest visits `/cart` → sees localStorage cart
3. "Login to Checkout" → `signinRedirect()` called
4. After OIDC callback: `CallbackPage` reads guest cart → POSTs each item to `/ecom/cart` with access_token → clears localStorage → navigates to `/cart`

## Acceptance Criteria

- [x] Kiali traffic graph shows ≥10 nodes and ≥12 edges
- [x] Prometheus scrapes istiod and ztunnel successfully
- [x] Kiali accessible at `http://localhost:32100/kiali`
- [x] All 4 PostgreSQL instances backed by `local-hostpath` StorageClass
- [x] Guest users can add items without login; merge into server cart on login
- [x] E2E tests: 36/36 passing

## Status: Complete ✓
