# Session 12 — Playwright End-to-End Tests

**Goal:** Full E2E test coverage for every user-facing feature, the CDC pipeline, and Superset reports.

## Deliverables

- `e2e/` — Playwright project (TypeScript)
  - `playwright.config.ts` — `workers: 1` (sequential), `baseURL: http://localhost:30000`
  - `e2e/fixtures/auth.setup.ts` — OIDC login via Keycloak UI → saves:
    - `fixtures/user1.json` — storageState (cookies + localStorage)
    - `fixtures/user1-session.json` — sessionStorage saved separately (Playwright `storageState` does NOT capture sessionStorage)
  - `e2e/helpers/db.ts` — analytics DB queries via `kubectl exec` (uses `execFileSync` not `execSync` — avoids shell quoting issues with SQL)
  - `e2e/helpers/auth.ts` — auth utilities

## Test Files

| File | Coverage |
|------|----------|
| `catalog.spec.ts` | Book list, titles, prices |
| `search.spec.ts` | Keyword search, filtered results |
| `auth.spec.ts` | OIDC PKCE login/logout, tokens not in localStorage |
| `cart.spec.ts` | Add-to-cart, cart persists post-login |
| `checkout.spec.ts` | Complete checkout, order confirmation, stock decremented |
| `cdc.spec.ts` | Place order, poll analytics DB, verify row appears |
| `superset.spec.ts` | Superset dashboard, both charts rendered |
| `istio-gateway.spec.ts` | HTTPRoute enforcement, JWT validation |
| `kiali.spec.ts` | Kiali dashboard, graph, Prometheus connectivity |
| `guest-cart.spec.ts` | Guest cart, persist across reload, merge on login |
| `ui-fixes.spec.ts` | Nav badge, minus decrement, logout styling |
| `mtls-enforcement.spec.ts` | External reserve → 403/404, JWT → 401, mTLS checkout |

## Critical Test Patterns

- **OIDC PKCE requires `localhost`**: `http://myecom.net:30000` is plain HTTP (non-localhost) — `crypto.subtle` unavailable. Use `http://localhost:30000` for any test triggering OIDC signin
- **CDC assertions**: `pollUntilFound()` with 1s interval, max 30s — never fixed sleep
- **Analytics DB**: query via `kubectl exec` (no NodePort needed)
- **Keycloak SSO**: fresh browser contexts may auto-authenticate; use `try/catch` around `waitForURL(KC_URL)` with short timeout

## Test Run Commands

```bash
cd e2e
npm run test                      # all tests (headless, sequential)
npm run test:ui                   # Playwright UI mode
npm run test:headed               # headed browser
npx playwright test catalog.spec.ts  # single file
npm run report                    # open last HTML report
```

## Acceptance Criteria

- [x] All 45 specs pass with 0 failures against a live cluster
- [x] `auth.spec.ts` asserts localStorage is empty after login
- [x] `cdc.spec.ts` passes within 30-second polling window
- [x] `superset.spec.ts` asserts chart elements exist and are non-empty

## Status: Complete ✓ — 45/45 passing
