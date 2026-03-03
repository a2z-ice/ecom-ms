# Session 20 — Production-Grade Stock/Inventory Status in UI

## Goal

Surface real-time stock availability at every stage of the shopping funnel. The inventory service already tracks `quantity`, `reserved`, and `available` per book and exposes `GET /inven/stock/{book_id}`. Users currently see no stock information — they can add out-of-stock items to cart and only discover the problem at checkout via a 409 CONFLICT error.

## Industry Pattern (Amazon/Shopify)

- `available = 0` → **Out of Stock** (red) — "Add to Cart" disabled
- `1 ≤ available ≤ 3` → **Low Stock** (orange) — "Only X left"
- `available > 3` → **In Stock** (green) — button enabled, clean UX
- Stock badges appear **after** books render (progressive enhancement — never block page load)
- If inventory service is unavailable → show no badge, keep button enabled → checkout validates at 409

## Deliverables

| File | Change |
|---|---|
| `inventory-service/app/api/stock.py` | Add `GET /stock/bulk?book_ids=...` endpoint (before `/{book_id}` route) |
| `inventory-service/app/main.py` | Add `http://localhost:30000` to CORS `allow_origins` |
| `ui/src/api/books.ts` | Full `StockResponse` type; `getBulkStock()`; export `StockStatus` + `getStockStatus()` |
| `ui/src/components/StockBadge.tsx` (NEW) | Reusable colored stock status badge component |
| `ui/src/pages/CatalogPage.tsx` | Bulk stock fetch after books load; badges; disable OOS button |
| `ui/src/pages/SearchPage.tsx` | "Availability" column in results table; disable OOS button |
| `ui/src/pages/CartPage.tsx` | Per-item stock validation; warn qty > available; block checkout when OOS |
| `e2e/stock-management.spec.ts` (NEW) | E2E tests for stock display behavior |
| `plans/session-20-stock-management-ui.md` (NEW) | This file |
| `plans/implementation-plan.md` | Session 20 entry added |

## Build & Deploy Commands

```bash
# 1. Rebuild inventory-service (new bulk endpoint + CORS fix)
cd /Volumes/Other/rand/llm/microservice
docker build -t bookstore/inventory-service:latest ./inventory-service
kind load docker-image bookstore/inventory-service:latest --name bookstore
kubectl rollout restart deployment/inventory-service -n inventory
kubectl rollout status deployment/inventory-service -n inventory --timeout=60s

# 2. Rebuild UI
docker build \
  --build-arg VITE_KEYCLOAK_AUTHORITY=http://idp.keycloak.net:30000/realms/bookstore \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
  --build-arg VITE_REDIRECT_URI=http://localhost:30000/callback \
  -t bookstore/ui-service:latest ./ui
kind load docker-image bookstore/ui-service:latest --name bookstore
kubectl rollout restart deployment/ui-service -n ecom
kubectl rollout status deployment/ui-service -n ecom --timeout=60s

# 3. Run E2E
cd e2e && npm run test
```

## Acceptance Criteria

- [ ] `GET http://api.service.net:30000/inven/stock/bulk?book_ids=<id1>,<id2>` returns JSON array
- [ ] Catalog page shows stock badges for all books (In Stock / Low Stock / Out of Stock)
- [ ] "Add to Cart" button is disabled with "Out of Stock" text when `available = 0`
- [ ] Search results page shows "Availability" column
- [ ] Cart page shows per-item stock status
- [ ] Cart "Checkout" button is disabled with warning when any item is OOS or overstocked
- [ ] If inventory service is unreachable, no stock badges shown (button stays enabled)
- [ ] E2E: 89 existing + new stock tests all passing

## Status: Complete
