# Session 14 — Data Persistence, Full-Stack Automation, Kiali Fix & Real Ecommerce UI

## Context

Five problems addressed:

1. **Data loss on cluster recreation** — PostgreSQL, Superset, Kafka, Redis PVCs backed by ephemeral local-path provisioner lose data when cluster is deleted. Fix: `extraMounts` in kind nodes + `local-hostpath` StorageClass + hostPath PVs backed by `data/` directory on the macOS host.

2. **No single-command bootstrap** — `scripts/stack-up.sh` provides one-command full lifecycle management. `scripts/cluster-down.sh` provides clean teardown with optional `--purge-data`.

3. **Kiali traffic graph broken** — Kiali looks for `http://prometheus.istio-system:9090` but Prometheus is in `observability` namespace. Fix: `ExternalName` Service named `prometheus` in `istio-system` aliasing `prometheus.observability.svc.cluster.local`.

4. **Guest cart missing** — Unauthenticated users can now add items to localStorage cart, view it, and only need to log in at checkout. Guest cart is synced to server cart after OIDC callback.

5. **UI redesign** — Professional ecommerce card layout with CSS design system, toast notifications, cart badge, quantity controls.

---

## Files Changed / Created

### Infrastructure
| File | Action |
|------|--------|
| `infra/kind/cluster.yaml` | Added `extraMounts` (DATA_DIR placeholder) to all 3 nodes |
| `infra/storage/storageclass.yaml` | NEW — `local-hostpath` StorageClass |
| `infra/storage/persistent-volumes.yaml` | NEW — 7 hostPath PVs |
| `infra/postgres/ecom-db.yaml` | PVC: `storageClassName: local-hostpath`, `volumeName: ecom-db-pv` |
| `infra/postgres/inventory-db.yaml` | Same pattern |
| `infra/postgres/analytics-db.yaml` | Same pattern |
| `infra/keycloak/keycloak.yaml` | keycloak-db PVC updated |
| `infra/superset/superset.yaml` | superset PVC updated |
| `infra/kafka/kafka.yaml` | kafka PVC updated |
| `infra/redis/redis.yaml` | redis PVC updated |
| `infra/observability/kiali/prometheus-alias.yaml` | NEW — ExternalName Service |

### Scripts
| File | Action |
|------|--------|
| `scripts/stack-up.sh` | NEW — full one-command bootstrap |
| `scripts/sanity-test.sh` | NEW — comprehensive sanity checks |
| `scripts/cluster-down.sh` | NEW — clean teardown with optional `--purge-data` |
| `scripts/cluster-up.sh` | Updated: DATA_DIR substitution before `kind create cluster` |

### UI
| File | Action |
|------|--------|
| `ui/src/hooks/useGuestCart.ts` | NEW — localStorage guest cart management |
| `ui/src/components/Toast.tsx` | NEW — inline toast notification |
| `ui/src/styles.css` | NEW — design system (CSS custom properties + classes) |
| `ui/src/main.tsx` | Import `styles.css` |
| `ui/src/pages/CatalogPage.tsx` | Guest cart, card layout, toast |
| `ui/src/pages/CartPage.tsx` | Guest cart display, qty controls, Login-to-Checkout |
| `ui/src/pages/CallbackPage.tsx` | Sync guest cart to server after OIDC callback |
| `ui/src/pages/SearchPage.tsx` | Guest cart support |
| `ui/src/components/NavBar.tsx` | Cart badge (guest + auth count), always-visible cart link |
| `ui/src/api/cart.ts` | Added `remove()` method |

### Backend
| File | Action |
|------|--------|
| `ecom-service/.../CartService.java` | Added `removeItem()` method |
| `ecom-service/.../CartController.java` | Added `DELETE /cart/{id}` endpoint |

### E2E
| File | Action |
|------|--------|
| `e2e/guest-cart.spec.ts` | NEW — 4 tests: add-as-guest, checkout-redirect, cart-preserved-after-login, badge |

### Misc
| File | Action |
|------|--------|
| `.gitignore` | NEW — excludes data/ subdirs |
| `data/.gitkeep` | NEW — tracks directory scaffold |

---

## Data Directory Structure

```
data/
├── ecom-db/        # PostgreSQL uid 999
├── inventory-db/   # PostgreSQL uid 999
├── analytics-db/   # PostgreSQL uid 999
├── keycloak-db/    # PostgreSQL uid 999
├── superset/       # uid 1000 (Superset SQLite)
├── kafka/          # uid 1000 (KRaft logs)
└── redis/          # uid 999 (AOF + RDB)
```

All directories bind-mounted into every kind node via `extraMounts`. `DATA_DIR` placeholder in `cluster.yaml` is substituted at runtime by `cluster-up.sh` / `stack-up.sh`.

---

## Guest Cart Flow

1. Guest browses catalog → clicks "Add to Cart" → item stored in `localStorage` under key `bookstore_guest_cart`
2. Guest visits `/cart` → sees `localStorage` cart with qty +/- controls
3. Guest clicks "Login to Checkout" → `userManager.signinRedirect()` called
4. After OIDC callback (`/callback`): `CallbackPage` reads `localStorage` guest cart, POSTs each item to `/ecom/cart` with the new access_token, clears `localStorage`, navigates to `/cart`
5. Auth cart now has all items → guest can click "Checkout"

---

## Verification

```bash
# 1. Kiali traffic graph
# Navigate to http://localhost:32100/kiali — graph should load without prometheus error

# 2. Full sanity test
./scripts/sanity-test.sh

# 3. Guest cart flow (manual)
# Open browser in incognito → add items → /cart → Login to Checkout → login → /cart → Checkout

# 4. E2E tests (must all pass)
cd e2e && npm run test
npx playwright test guest-cart.spec.ts

# 5. Persistence test (after next cluster recreation)
./scripts/cluster-down.sh  # data preserved in ./data/
./scripts/stack-up.sh      # cluster recreated with data intact
kubectl exec -n ecom deploy/ecom-db -- psql -U $POSTGRES_USER -d $POSTGRES_DB -c "SELECT COUNT(*) FROM books"
# Should show 10
```
