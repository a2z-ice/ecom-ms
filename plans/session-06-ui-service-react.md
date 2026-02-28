# Session 06 — UI Service (React)

**Goal:** React 19.2 SPA implementing the full user journey — catalog, search, cart, login, checkout.

## Deliverables

- `ui/` — React 19.2 project (Vite)
  - `src/auth/` — OIDC PKCE flow using `oidc-client-ts`
    - `UserManager` configured with `userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() })`
    - Tokens stored in memory (React context) — never localStorage or sessionStorage
    - CSRF token fetched from backend on app load, stored in React state, sent as `X-CSRF-Token` header
  - Pages: `CatalogPage`, `SearchPage`, `CartPage`, `CheckoutPage`, `CallbackPage`, `OrderConfirmationPage`
  - `src/api/client.ts` — fetch wrapper: attaches `Authorization: Bearer <token>` + `X-CSRF-Token`
  - Nginx `default.conf` — SPA routing (`try_files $uri /index.html`), security headers (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Content-Security-Policy`), proxy for `/ecom` and `/inven`
- `ui/Dockerfile` — multi-stage: `node` build → `nginx:alpine`, non-root

**CRITICAL:** VITE_ vars must be baked in at build time — pass via `--build-arg`:
```bash
docker build \
  --build-arg VITE_KEYCLOAK_AUTHORITY=http://idp.keycloak.net:30000/realms/bookstore \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
  --build-arg VITE_REDIRECT_URI=http://localhost:30000/callback \
  -t bookstore/ui-service:latest .
```

## Auth Flow

1. Anonymous user sees catalog and search (no token required)
2. "Add to cart" or "Checkout" triggers redirect to Keycloak
3. After login, redirect back with auth code → exchanged for tokens
4. Access token stored in memory only (React state via `AuthContext`)
5. `GET /ecom/books` returns paginated Spring Page `{content: [...], totalElements: N}` — NOT a raw array

## Acceptance Criteria

- [x] `myecom.net:30000` loads catalog without login
- [x] Search returns filtered results
- [x] Clicking "Login" redirects to Keycloak; successful login returns to app
- [x] Cart shows items post-login; checkout submits order
- [x] No tokens in localStorage or sessionStorage
- [x] CSP headers present on all responses

## Status: Complete ✓
