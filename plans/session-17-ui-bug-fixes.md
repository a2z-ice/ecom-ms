# Session 17 — UI Bug Fixes (Cart Badge, PUT Quantity Endpoint, Logout Styling)

**Goal:** Fix three UI bugs discovered post-Session 15: cart badge not showing for authenticated users, minus button broken (quantity goes negative), and logout button unstyled.

## Problems Addressed

1. **Cart badge missing for auth users** — NavBar fetched guest cart count only; after login badge disappeared.
2. **Minus button sends `quantity: -1`** — `CartRequest.java` has `@Min(1)` validation. Decrement sent `quantity: item.quantity - 1` which could be `0` or negative → `400 Bad Request`. No PUT endpoint existed.
3. **Logout button unstyled** — white background, dark text; visually inconsistent with Login button (white text on dark navbar).

## Deliverables

### Backend — ecom-service
| File | Action |
|------|--------|
| `dto/CartUpdateRequest.java` | NEW — `@Min(1) int quantity` (separate DTO for PUT, allows quantity 1+) |
| `service/CartService.java` | `setQuantity(itemId, userId, quantity)` method |
| `controller/CartController.java` | `PUT /cart/{itemId}` endpoint using `CartUpdateRequest` |

### Frontend — ui
| File | Action |
|------|--------|
| `api/client.ts` | `put()` method added alongside existing `get`, `post`, `delete` |
| `api/cart.ts` | `cartApi.update(itemId, quantity)` added |
| `pages/CartPage.tsx` | Minus button: `cartApi.update(item.id, item.quantity - 1)`; removes item when quantity reaches 0 |
| `components/NavBar.tsx` | Fetches server cart count via `cartApi.get()` when user is authenticated; listens for `cartUpdated` DOM event dispatched from CatalogPage/SearchPage/CartPage after mutations; logout button styled `color: '#fff', borderColor: '#cbd5e0'` |
| `pages/CatalogPage.tsx` | Dispatches `cartUpdated` DOM event after add-to-cart |
| `pages/SearchPage.tsx` | Dispatches `cartUpdated` DOM event after add-to-cart |
| `pages/CartPage.tsx` | Dispatches `cartUpdated` DOM event after any cart mutation |

### E2E
| File | Action |
|------|--------|
| `e2e/ui-fixes.spec.ts` | NEW — 5 tests: auth badge shows after login, minus decrements quantity, minus at 1 removes item, logout button has white text, badge clears after checkout |

## Cart Badge Logic

- Guest: count from localStorage `bookstore_guest_cart`
- Authenticated: count from `cartApi.get()` (server), refreshed on `cartUpdated` event
- Badge shown when `cartCount > 0` for either guest or auth state

## Acceptance Criteria

- [x] Cart badge appears for authenticated users after login (fetches from server)
- [x] Minus button decrements quantity via `PUT /cart/{id}` with `quantity - 1`
- [x] Minus at quantity 1 removes item from cart (DELETE)
- [x] Logout button has white text matching Login button style
- [x] Cart badge clears after successful checkout
- [x] E2E tests: 41/41 passing (base; later 45/45 with Session 16 mTLS tests)

## Build & Deploy

```bash
cd ecom-service && mvn package -DskipTests
docker build -t bookstore/ecom-service:latest . && kind load docker-image bookstore/ecom-service:latest --name bookstore
kubectl rollout restart deployment/ecom-service -n ecom

cd ../ui
docker build \
  --build-arg VITE_KEYCLOAK_AUTHORITY=http://idp.keycloak.net:30000/realms/bookstore \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
  --build-arg VITE_REDIRECT_URI=http://localhost:30000/callback \
  -t bookstore/ui-service:latest .
kind load docker-image bookstore/ui-service:latest --name bookstore
kubectl rollout restart deployment/ui-service -n ecom
```

## Status: Complete ✓
