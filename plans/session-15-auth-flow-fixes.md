# Session 15 — Auth Flow Fixes (Login Button, Return URL, Protected Routes)

**Goal:** Fix three bugs and two missing features in the UI authentication flow.

## Problems Addressed

1. **Silent OIDC failure at myecom.net** — `crypto.subtle` unavailable on plain HTTP non-localhost. Clicking Login silently fails.
2. **No return URL after login** — after OIDC redirect, user always lands on `/` regardless of where they came from.
3. **Login button flash** — `isLoading` not handled; Login button briefly appears even for authenticated users on page refresh.
4. **No route guard** — navigating to `/order-confirmation` while unauthenticated shows blank page.
5. **CartPage used `userManager` directly** — bypassed `AuthContext` login logic.

## Deliverables

| File | Change |
|------|--------|
| `ui/src/auth/AuthContext.tsx` | `login(returnPath?)` accepts optional return path. At non-localhost: redirects to `localhost:30000/login?return=<path>`. At localhost: calls `signinRedirect({ state: { returnUrl } })` |
| `ui/src/pages/LoginPage.tsx` | NEW — served at `/login?return=<path>`. Always runs at localhost (secure context). Triggers OIDC redirect with return path. |
| `ui/src/pages/CallbackPage.tsx` | Reads `user.state.returnUrl`, navigates to original page after auth. Guest cart merge logic preserved. |
| `ui/src/components/ProtectedRoute.tsx` | NEW — route guard. Calls `login()` with current path if unauthenticated, shows loading state. |
| `ui/src/components/NavBar.tsx` | Shows `...` during `isLoading` (prevents Login button flash). Uses `onClick={() => login()}` not `onClick={login}` (avoids passing `MouseEvent` as `returnPath`). |
| `ui/src/pages/CartPage.tsx` | Uses `login('/cart')` from `useAuth()` — removed direct `userManager` import. |
| `ui/src/App.tsx` | Adds `/login` route. Wraps `/order-confirmation` with `ProtectedRoute`. |

## Docker Build (Required — VITE vars baked in at build time)

```bash
cd ui
docker build \
  --build-arg VITE_KEYCLOAK_AUTHORITY=http://idp.keycloak.net:30000/realms/bookstore \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
  --build-arg VITE_REDIRECT_URI=http://localhost:30000/callback \
  -t bookstore/ui-service:latest .
kind load docker-image bookstore/ui-service:latest --name bookstore
kubectl rollout restart deployment/ui-service -n ecom
```

## Acceptance Criteria

- [x] Click Login at `myecom.net:30000` → redirects to `localhost:30000/login?return=/` → Keycloak (no silent fail)
- [x] Login from `/search?q=tolkien` → returns to `/search?q=tolkien` after auth
- [x] Page refresh when already logged in → no Login button flash (shows `...` during check)
- [x] Navigate to `/order-confirmation` without auth → redirects to login, returns after auth
- [x] "Login to Checkout" in cart → uses `login('/cart')`, returns to `/cart` after auth
- [x] E2E tests: 36/36 passing

## Status: Complete ✓
