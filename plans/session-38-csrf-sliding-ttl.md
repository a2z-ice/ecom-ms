# CSRF Token Sliding TTL + Auto-Regeneration Enhancement

## Context

The current CSRF service uses a **fixed 30-minute TTL** for tokens in Redis. Once generated, the token lives for 30 minutes regardless of user activity. This creates two problems:

1. **Wide attack window:** If a CSRF token is stolen, the attacker has up to 30 minutes to use it
2. **Reactive renewal only:** After a POST consumes a token or the token expires, the next POST gets a 403, triggers a retry with a separate GET /csrf/token call — adding latency

**Goal:** Implement a two-part enhancement:
- **Sliding TTL** — shorter default TTL (10 min), refreshed on every authenticated GET/HEAD/OPTIONS
- **Auto-regeneration on expiry** — when a mutating request fails CSRF validation but the JWT is valid, auto-generate a new CSRF token and return it in the 403 response body. The UI reads it directly and retries (saving one network round trip)

---

## Security Analysis

### Why 10 Minutes?
- OWASP recommends tying CSRF tokens to session lifetime; NIST SP 800-63B recommends 15-min idle for AAL2
- Tokens are single-use on mutating requests — TTL only governs unused/stolen tokens
- 10 minutes: short enough to limit exposure, long enough that active users never notice

### Sliding TTL Security Properties
- **Active users unaffected** — every page load (GET) refreshes the TTL
- **Idle tokens expire 3x faster** — 10 min vs 30 min attack window
- **Race conditions are benign** — Redis `EXPIRE` on a `DEL`-ed key is a no-op

### Auto-Regeneration Security Properties
- **Safe from cross-origin attacks** — attacker can't read the 403 response body (blocked by CORS/same-origin policy)
- **No weaker than current flow** — the UI already retries with GET /csrf/token to get a new token; this just inlines it into the 403 response, saving one round trip
- **Token still tied to user** — new token is stored under `csrf:{userID}` in Redis, only usable with that user's JWT
- **JWT must be valid** — regeneration only happens when the JWT is valid (authenticated user whose CSRF expired). If JWT is missing/invalid, the request passes through to backend auth (existing behavior)

---

## Implementation Plan

### Part A: Server-Side — Sliding TTL

#### Step 1: Config — Add `SlidingTTL` field, reduce default TTL
**File:** `csrf-service/internal/config/config.go`
- Add `SlidingTTL bool` field to `Config` struct (after `FailClosed`, line 18)
- Change default TTL from `"30"` to `"10"` (line 38)
- Parse `CSRF_SLIDING_TTL` env var (default `"true"`) in `Load()` return struct

#### Step 2: Store — Add `RefreshTTL` method
**File:** `csrf-service/internal/store/redis.go`
- Add `RefreshTTL(ctx context.Context, userID string) error` to `TokenStore` interface
- Implement on `RedisStore` using Redis `EXPIRE` command — O(1), does not read the value
- Returns `nil` if key doesn't exist (not an error)

#### Step 3: Metrics — Add TTL renewal counter
**File:** `csrf-service/internal/middleware/metrics.go`
- Add `TTLRenewalsTotal *prometheus.CounterVec` with label `result` (`ok`, `error`, `no_token`)
- Register in `NewMetricsWithRegisterer`

#### Step 4: Handler struct — Add `SlidingTTL` field
**File:** `csrf-service/internal/handler/token.go`
- Add `SlidingTTL bool` to `Handler` struct (line 27)
- Update `New()` constructor signature to accept `slidingTTL bool` (line 31)

#### Step 5: Handler — Implement sliding TTL in ext_authz safe method branch
**File:** `csrf-service/internal/handler/authz.go`
- Modify safe-method branch (lines 25-29): if `SlidingTTL` enabled AND JWT present → refresh TTL via fire-and-forget goroutine (zero latency impact on GETs)

#### Step 6: Main — Wire new config
**File:** `csrf-service/main.go`
- Pass `cfg.SlidingTTL` to `handler.New()` (line 63)
- Add `"slidingTTL"` to startup config log (line 83)

---

### Part B: Server-Side — Auto-Regeneration on CSRF Failure

#### Step 7: Handler — Auto-regenerate token on CSRF failure with valid JWT
**File:** `csrf-service/internal/handler/authz.go`

When CSRF validation fails (missing/expired/invalid token) but the JWT `sub` is valid:
1. Generate a new CSRF token via `h.Store.Generate(ctx, claims.Sub, reqOrigin)`
2. Return **403** with the new token embedded in the response body:

```json
{
  "type": "about:blank",
  "title": "Forbidden",
  "status": 403,
  "detail": "CSRF token expired or invalid",
  "token": "550e8400-e29b-41d4-a716-446655440000"
}
```

New helper function:
```go
func (h *Handler) writeForbiddenWithNewToken(w http.ResponseWriter, ctx context.Context, userID, origin, detail string) {
    newToken, err := h.Store.Generate(ctx, userID, origin)
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusForbidden)
    if err == nil && newToken != "" {
        fmt.Fprintf(w, `{"type":"about:blank","title":"Forbidden","status":403,"detail":"%s","token":"%s"}`, detail, newToken)
        h.Metrics.RequestsTotal.WithLabelValues("authz_mutate", "regenerated").Inc()
    } else {
        fmt.Fprintf(w, `{"type":"about:blank","title":"Forbidden","status":403,"detail":"%s"}`, detail)
    }
}
```

Affected code paths in `ExtAuthzCheck`:
- `csrfToken == ""` (missing token, line 108-112) → `writeForbiddenWithNewToken`
- `!valid` (expired or mismatch, line 134-138) → `writeForbiddenWithNewToken`

Envoy ext_authz forwards the 403 body to the browser (confirmed: default behavior, matching existing `writeForbidden` pattern).

---

### Part C: UI-Side — Read Regenerated Token from 403 Response

#### Step 8: Update 403-retry logic to use inline token
**File:** `ui/src/api/client.ts`

Modify the 403-retry block (lines 58-62) to check the response body for a `token` field before falling back to `fetchCsrfToken()`:

```typescript
if (resp.status === 403 && isMutating && !_csrfRetried) {
  try {
    const body = await resp.json()
    if (body.token) {
      _csrfToken = body.token  // Use inline regenerated token
    } else {
      await fetchCsrfToken()   // Fallback: separate token fetch
    }
  } catch {
    await fetchCsrfToken()     // Fallback: response not JSON
  }
  return request<T>(url, options, true)
}
```

Saves one network round trip. Falls back to existing `fetchCsrfToken()` for backward compatibility.

---

### Part D: Unit Tests (Go)

#### Step 9: Store tests
**File:** `csrf-service/internal/store/redis_test.go`
- `TestRefreshTTL_ExistingKey` — set key with TTL, call RefreshTTL, verify TTL reset via `mr.TTL()`
- `TestRefreshTTL_MissingKey` — call on nonexistent key, verify no error
- `TestRefreshTTL_RedisDown` — close miniredis, verify error returned

#### Step 10: Handler tests
**File:** `csrf-service/internal/handler/handler_test.go`
- Update all `handler.New()` calls (5 setup functions + 2 inline) to include `slidingTTL` parameter
- **Sliding TTL tests:**
  - `TestExtAuthzCheck_SlidingTTL_RefreshesOnAuthenticatedGET` — generate token, send authenticated GET, wait 100ms, verify TTL refreshed
  - `TestExtAuthzCheck_SlidingTTL_NoRefreshOnUnauthenticatedGET` — no JWT, no Redis TTL change
  - `TestExtAuthzCheck_SlidingTTL_Disabled` — slidingTTL=false, no refresh
- **Auto-regeneration tests:**
  - `TestExtAuthzCheck_RegeneratesOnExpiredToken` — expired/missing token + valid JWT → 403 response body contains `token` field with valid UUID
  - `TestExtAuthzCheck_RegeneratesOnMissingCsrfHeader` — no X-CSRF-Token header + valid JWT → 403 response body contains `token` field
  - `TestExtAuthzCheck_RegeneratedTokenIsValid` — use the returned token in a follow-up POST → 200

---

### Part E: E2E Tests (Playwright)

#### Step 11: E2E test file
**File:** `e2e/csrf-sliding-ttl.spec.ts` (new file)

Uses the same patterns as existing `csrf.spec.ts`: `getToken()` helper for JWT, `getCsrfToken()` for CSRF, Playwright `request` fixture for API calls.

```
test.describe('CSRF Sliding TTL Enhancement', () => {

  test.describe('Sliding TTL — Token renewal on activity', () => {

    test('authenticated GET request refreshes CSRF token TTL in Redis', async ({ request }) => {
      // 1. Get JWT and CSRF token
      // 2. Check initial Redis TTL via kubectl exec redis-cli TTL csrf:<user-id>
      // 3. Wait 2 seconds (TTL should decrease by ~2s)
      // 4. Make authenticated GET /ecom/books with JWT
      // 5. Check Redis TTL again — should be back near full TTL (sliding refresh)
      // Assert TTL after GET > TTL before GET (proving refresh occurred)
    })

    test('unauthenticated GET does not create or refresh CSRF token', async ({ request }) => {
      // 1. Make GET /ecom/books without JWT
      // 2. Verify no csrf:* key was created/modified in Redis
    })

    test('CSRF token expires after idle period exceeds TTL', async ({ request }) => {
      // 1. Get JWT and CSRF token
      // 2. Use kubectl to set a very short TTL on the csrf key (e.g., 2s) to simulate expiry
      // 3. Wait 3 seconds
      // 4. Attempt POST with the old CSRF token
      // 5. Expect 403 (token expired)
    })

  })

  test.describe('Auto-regeneration — New token in 403 response', () => {

    test('403 response includes new token when CSRF is missing but JWT is valid', async ({ request }) => {
      // 1. Get JWT (no CSRF token)
      // 2. POST /ecom/cart without X-CSRF-Token header
      // 3. Expect 403 with JSON body containing "token" field
      // 4. Verify token is valid UUID v4 format
    })

    test('403 response includes new token when CSRF is expired but JWT is valid', async ({ request }) => {
      // 1. Get JWT and CSRF token
      // 2. Use kubectl to delete the csrf key from Redis (simulate expiry)
      // 3. POST /ecom/cart with the old (now expired) CSRF token
      // 4. Expect 403 with JSON body containing "token" field
      // 5. Verify the new token is different from the old one
    })

    test('regenerated token from 403 is usable for the next mutating request', async ({ request }) => {
      // 1. Get JWT (no CSRF token)
      // 2. POST /ecom/cart without CSRF → 403 with new token
      // 3. Extract token from 403 response body
      // 4. POST /ecom/cart with the extracted token
      // 5. Expect 200 (token is valid and accepted)
    })

    test('403 response for unauthenticated request does NOT include token', async ({ request }) => {
      // 1. POST /ecom/cart without JWT and without CSRF
      // 2. Response should be 200 (pass-through to backend, which returns 401)
      // OR if JWT present but invalid, verify no token regeneration
    })

    test('regenerated token is single-use', async ({ request }) => {
      // 1. Trigger 403 with JWT → get regenerated token
      // 2. Use token for POST → 200 (consumed)
      // 3. Use same token again → 403 (consumed, but gets another regenerated token)
      // 4. Verify the second 403 also contains a new token
    })

    test('cross-user token in 403 is tied to the requesting user', async ({ request }) => {
      // 1. User1 gets JWT, triggers 403 → gets regenerated token
      // 2. Admin1 gets JWT, tries to use user1's regenerated token
      // 3. Expect 403 (token is per-user)
    })

  })

  test.describe('Browser flow — transparent CSRF renewal', () => {

    test('browser add-to-cart works after CSRF token expires', async ({ page }) => {
      // 1. Login via browser
      // 2. Use kubectl to delete the csrf key from Redis (simulate expiry)
      // 3. Click "Add to Cart" button
      // 4. The UI should:
      //    a. POST /cart → 403 with new token in body
      //    b. Read token from 403 body
      //    c. Retry POST /cart with new token → 200
      // 5. Verify cart item appears on page
      // Monitor network requests to confirm only 2 calls (not 3)
    })

    test('browser checkout works with regenerated CSRF token', async ({ page }) => {
      // 1. Login, add items to cart
      // 2. Navigate to cart page
      // 3. Delete csrf key from Redis (simulate expiry)
      // 4. Click "Checkout" button
      // 5. Verify order confirmation page appears (CSRF retry transparent)
    })

  })

  test.describe('Metrics', () => {

    test('csrf_ttl_renewals_total metric exists and increments', async ({ request }) => {
      // 1. Get JWT, generate CSRF token
      // 2. Make several authenticated GET requests
      // 3. Check Prometheus metrics (via kubectl exec busybox wget)
      // 4. Verify csrf_ttl_renewals_total{result="ok"} counter > 0
    })

    test('regenerated counter increments on auto-regeneration', async ({ request }) => {
      // 1. Trigger a 403 with auto-regeneration
      // 2. Check Prometheus metrics
      // 3. Verify csrf_requests_total{method="authz_mutate",result="regenerated"} > 0
    })

  })

})
```

---

### Part F: Deployment & Documentation

#### Step 12: Kubernetes manifest
**File:** `csrf-service/k8s/csrf-service.yaml`
- Add/update env vars: `CSRF_TOKEN_TTL_MINUTES: "10"`, `CSRF_SLIDING_TTL: "true"`

#### Step 13: Build & Deploy — CSRF Service
```bash
bash scripts/csrf-service-up.sh   # builds, tests, deploys csrf-service to kind
```

#### Step 14: Build & Deploy — UI Service
**New file:** `scripts/ui-service-up.sh`

Create a shell script (following existing `csrf-service-up.sh` pattern) that:
1. Runs `npm run build` in `ui/` to verify TypeScript compiles
2. Docker builds with all `VITE_` build args (Keycloak authority, client ID, redirect URI)
3. Loads image into kind cluster
4. Restarts the deployment and waits for rollout

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== UI Service: Build & Deploy ==="

# 1. TypeScript build check
echo "→ npm run build (TypeScript + Vite)..."
cd ui
npm run build
cd ..

# 2. Docker build
echo "→ Docker build..."
docker build \
  --build-arg VITE_KEYCLOAK_AUTHORITY=https://idp.keycloak.net:30000/realms/bookstore \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
  --build-arg VITE_REDIRECT_URI=https://localhost:30000/callback \
  -t bookstore/ui-service:latest ./ui

# 3. Load into kind
echo "→ Loading image into kind cluster..."
kind load docker-image bookstore/ui-service:latest --name bookstore

# 4. Rollout restart
echo "→ Restarting deployment..."
kubectl rollout restart deploy/ui-service -n ecom
kubectl rollout status deploy/ui-service -n ecom --timeout=120s

echo "=== UI Service: Done ==="
```

Usage: `bash scripts/ui-service-up.sh`

#### Step 15: Update CLAUDE.md
- CSRF Service section: "30min TTL" → "10min sliding TTL (refreshed on every authenticated request)"
- Document auto-regeneration behavior and inline token in 403 response
- Add `CSRF_SLIDING_TTL` to env var documentation

#### Step 16: Save session plan
**File:** `plans/session-38-csrf-sliding-ttl.md`
- Copy this plan to the plans folder following the naming convention

---

## Files Modified (Summary)

| # | File | Change |
|---|------|--------|
| 1 | `csrf-service/internal/config/config.go` | Add `SlidingTTL`, change default TTL 30→10 |
| 2 | `csrf-service/internal/store/redis.go` | Add `RefreshTTL` to interface + implementation |
| 3 | `csrf-service/internal/middleware/metrics.go` | Add `TTLRenewalsTotal` counter |
| 4 | `csrf-service/internal/handler/token.go` | Add `SlidingTTL` to Handler + constructor |
| 5 | `csrf-service/internal/handler/authz.go` | Sliding TTL + auto-regeneration on CSRF failure |
| 6 | `csrf-service/main.go` | Wire `SlidingTTL` config |
| 7 | `csrf-service/k8s/csrf-service.yaml` | Add env vars |
| 8 | `ui/src/api/client.ts` | Read regenerated token from 403 body |
| 9 | `csrf-service/internal/store/redis_test.go` | 3 new tests for RefreshTTL |
| 10 | `csrf-service/internal/handler/handler_test.go` | 6 new tests + update all New() calls |
| 11 | `e2e/csrf-sliding-ttl.spec.ts` | **NEW** — ~12 E2E tests across 5 describe blocks |
| 12 | `CLAUDE.md` | Update CSRF documentation |
| 13 | `scripts/ui-service-up.sh` | **NEW** — UI build & deploy script |
| 14 | `plans/session-38-csrf-sliding-ttl.md` | Session plan |

---

## Verification

1. **Go unit tests:** `cd csrf-service && go test -v ./...` — all pass (19 existing + 6 new)
2. **Build & deploy CSRF service:** `bash scripts/csrf-service-up.sh`
3. **Build & deploy UI service:** `bash scripts/ui-service-up.sh`
4. **E2E tests (new):** `cd e2e && npx playwright test csrf-sliding-ttl.spec.ts`
5. **Full E2E suite:** `cd e2e && npm run test` — all existing tests still pass
6. **Manual verification:**
   - Login → browse pages → verify Redis TTL stays near 600s (sliding)
   - Wait 10+ min idle → POST → verify 403 body contains new token → retry succeeds
   - Browser DevTools: confirm 2 requests on retry (not 3)
