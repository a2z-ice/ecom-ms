# BookStore Platform — Manual Testing Guideline

Complete step-by-step testing instructions for all features of the BookStore e-commerce platform, covering every scenario exercised by the 36-test Playwright E2E suite. Tests are organised thematically; run them in order as later tests depend on state set up by earlier ones.

---

## Prerequisites

### Cluster Health Check

```bash
# All pods must be Running or Completed — no CrashLoopBackOff, Pending, or Error
kubectl get pods -A | grep -v -E "Running|Completed"
# Expected: empty output

# Verify all external routes return expected HTTP codes
bash /Volumes/Other/rand/llm/microservice/scripts/verify-routes.sh
```

### /etc/hosts

```
127.0.0.1  idp.keycloak.net
127.0.0.1  myecom.net
127.0.0.1  api.service.net
```

### Browser Setup

- Use **Google Chrome** (latest) or **Chromium**
- Open DevTools (F12) → Application tab before starting
- For tests that require no existing session: open a **private / incognito** window, or manually clear cookies, localStorage, and sessionStorage for `myecom.net` and `idp.keycloak.net`

### Service URLs & Credentials

| Service | URL | Username | Password |
|---------|-----|----------|----------|
| BookStore UI | `http://myecom.net:30000` | — | — |
| BookStore UI (secure) | `http://localhost:30000` | — | — |
| Keycloak Login | `http://idp.keycloak.net:30000/realms/bookstore` | user1 | `CHANGE_ME` |
| Keycloak Admin | `http://idp.keycloak.net:30000/admin` | admin | `CHANGE_ME` |
| Apache Superset | `http://localhost:32000` | admin | `CHANGE_ME` |
| PgAdmin | `http://localhost:31111` | admin@bookstore.local | `CHANGE_ME` |
| Kiali | `http://localhost:32100/kiali` | — | — (anonymous) |

> **Note — two UI origins:** `myecom.net:30000` and `localhost:30000` both serve the same app. OIDC PKCE requires `crypto.subtle` (Web Crypto API) which browsers only expose in **secure contexts** (HTTPS or localhost). Therefore `http://myecom.net:30000` cannot trigger OIDC directly; clicking Login there redirects to `localhost:30000/login?return=<path>` first, which then triggers Keycloak. `http://localhost:30000` is always a secure context.

---

## E2E Test Coverage Map

| MT ID | Manual Test | E2E Spec | E2E Tests |
|-------|-------------|----------|-----------|
| MT-01 | Public catalog — book listing | `catalog.spec.ts` | tests 1–2 |
| MT-02 | Unauthenticated guest cart — add without login | `catalog.spec.ts` test 3, `cart.spec.ts` test 3, `guest-cart.spec.ts` tests 1, 4 |
| MT-03 | OIDC PKCE login flow | `fixtures/auth.setup.ts`, `auth.spec.ts` test 1 |
| MT-04 | Token storage security | `auth.spec.ts` test 1 |
| MT-05 | Logout flow | `auth.spec.ts` test 2 |
| MT-06 | Unauthenticated cart access → Keycloak redirect | `auth.spec.ts` test 3 |
| MT-07 | Guest cart — login-to-checkout redirects to Keycloak | `guest-cart.spec.ts` test 2 |
| MT-08 | Guest cart — merge on login | `guest-cart.spec.ts` test 3 |
| MT-09 | Auth return URL — lands on original page after login | (manual verification of Session 15 feature) |
| MT-10 | Protected route — `/order-confirmation` guards unauthenticated access | (manual verification of Session 15 feature) |
| MT-11 | Authenticated catalog — Add to Cart buttons visible | `catalog.spec.ts` test 4 |
| MT-12 | Add to cart & cart totals (authenticated) | `cart.spec.ts` tests 1–2 |
| MT-13 | Book search — by title, author, no results | `search.spec.ts` tests 1–3 |
| MT-14 | Checkout flow & order confirmation | `checkout.spec.ts` tests 1–2 |
| MT-15 | CDC — order appears in analytics DB within 30 s | `cdc.spec.ts` test 1 |
| MT-16 | CDC — dim_books & fact_inventory sync | `cdc.spec.ts` tests 2–3 |
| MT-17 | Superset — dashboard and charts | `superset.spec.ts` tests 1–4 |
| MT-18 | Istio Gateway — all HTTP routes reachable | `istio-gateway.spec.ts` tests 1–4 |
| MT-19 | Istio Gateway — JWT enforcement & public stock endpoint | `istio-gateway.spec.ts` tests 5–6 |
| MT-20 | Kiali — service mesh dashboard and Prometheus | `kiali.spec.ts` tests 1–3 |
| MT-21 | API smoke tests (curl) | supporting `istio-gateway.spec.ts` |
| MT-22 | Full regression journey | cross-cutting |

---

## MT-01 — Public Catalog: Book Listing

**E2E coverage:** `catalog.spec.ts` — "loads book list without login", "each book card shows title, author, and price"

**Goal:** Catalog is publicly accessible; 10 books are visible without authentication.

**Steps:**
1. Open a fresh **incognito** window and navigate to `http://myecom.net:30000`
2. Verify the page title shows "BookStore" or "Book Store"
3. Verify the heading **"Book Catalog"** is visible
4. Count book cards — must be **≥ 10**
5. For the first book card, verify all three elements are present:
   - Book title (non-empty text)
   - Author name (non-empty text)
   - Price in `$XX.XX` format
6. Verify **no Login/auth prompt** appears; page loads fully without authentication
7. Open DevTools → Network tab, reload the page, verify `GET /ecom/books` returns HTTP 200

**Expected:** All 10 books visible with title, author, and price. No auth wall.

**Fail indicators:**
- Blank page or infinite spinner
- Fewer than 10 book cards
- Missing price or author on any card
- Console errors (CORS, 5xx)

---

## MT-02 — Unauthenticated Guest Cart: Add Without Login

**E2E coverage:** `catalog.spec.ts` test 3 (unauth sees Add to Cart), `cart.spec.ts` test 3 (add to guest cart), `guest-cart.spec.ts` tests 1 and 4 (add items, cart badge)

**Goal:** Unauthenticated users can add books to a localStorage guest cart without being redirected to Keycloak.

**Steps:**
1. Open an **incognito** window and navigate to `http://myecom.net:30000`
2. Verify all book cards show an **"Add to Cart"** button (NOT "Login to Buy")
3. Click **"Add to Cart"** on the first book
4. Verify a **toast notification** appears briefly (e.g. "Added to cart")
5. Verify the page URL **does not change** — you remain on the catalog, NOT redirected to Keycloak
6. Check the **Cart** link in the navbar — verify a numeric badge (e.g. `1`) appears
7. Click **"Add to Cart"** on a second book
8. Verify the navbar badge updates to `2`
9. Navigate to `http://myecom.net:30000/cart`
10. Verify the cart page shows a **"Browsing as guest"** notice
11. Verify both added books appear in the cart table with quantities and prices
12. Open DevTools → Application → Local Storage (`myecom.net`)
13. Verify a key `bookstore_guest_cart` exists with JSON data
14. Reload the page — verify the guest cart items are **still there** (persisted in localStorage)

**Expected:** Items stored in localStorage. Toast shown. No login redirect. Badge updates. Items survive page reload.

**Fail indicators:**
- "Login to Buy" button instead of "Add to Cart" for unauthenticated user
- Page redirects to Keycloak on button click
- No toast notification
- Cart badge not showing
- `bookstore_guest_cart` key absent from localStorage

---

## MT-03 — Authentication: OIDC PKCE Login Flow

**E2E coverage:** `fixtures/auth.setup.ts` — "authenticate as user1", `auth.spec.ts` test 1 — "tokens not in localStorage"

**Goal:** Full OIDC Authorization Code Flow with PKCE works end-to-end.

**Steps:**
1. Open a fresh **incognito** window and navigate to `http://myecom.net:30000`
2. Click the **Login** button in the navbar
3. Verify the browser navigates first to `http://localhost:30000/login?return=/` (the intermediate secure-context page added in Session 15 — visible for < 1 s)
4. Verify the browser then redirects to `http://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/auth`
5. On the Keycloak login form, fill:
   - **Username:** `user1`
   - **Password:** `CHANGE_ME`
6. Click **Sign In**
7. Verify the browser redirects to `http://localhost:30000/callback` (briefly) and then to the catalog
8. Verify the navbar now shows an email address (e.g. `user1@bookstore.local`) and a **Logout** button
9. Verify the **Login** button is gone

**Expected:** Full OIDC redirect → Keycloak login → callback → catalog. Logout button visible.

**Fail indicators:**
- Login button click does nothing (crypto.subtle error — check browser console)
- Keycloak returns error page
- Browser stays on Keycloak after Sign In (wrong credentials)
- Logout button not visible after login

---

## MT-04 — Token Storage Security

**E2E coverage:** `auth.spec.ts` test 1 — "tokens are not stored in localStorage after login"

**Goal:** Access tokens are stored only in memory / sessionStorage; localStorage stays clean.

**Steps:**
1. Log in as user1 (MT-03)
2. Open DevTools → **Application** tab
3. Select **Local Storage** → `myecom.net`
4. Search for any key containing: `token`, `access`, `auth`, `oidc`, `refresh`
5. Verify **zero** such keys exist in localStorage
6. Select **Session Storage** → `localhost:30000`
7. Verify OIDC library state keys are present (e.g. `oidc.user:http://idp.keycloak.net:30000/realms/bookstore:ui-client`)
8. Open **Network** tab, add a book to cart
9. Inspect the `POST /ecom/cart` request
10. Verify the request header includes `Authorization: Bearer <jwt-token>`
11. Verify the request header includes `X-CSRF-Token: <token>`

**Expected:** No tokens in localStorage. OIDC state in sessionStorage. Bearer token on API calls.

---

## MT-05 — Authentication: Logout Flow

**E2E coverage:** `auth.spec.ts` test 2 — "logout redirects to catalog and shows Login button"

**Goal:** Logout clears the SSO session and returns user to unauthenticated state.

**Steps:**
1. Ensure you are logged in (MT-03)
2. Click the **Logout** button in the navbar
3. Verify the browser briefly visits Keycloak's end-session endpoint
4. Verify you are redirected back to the catalog
5. Verify the navbar shows the **Login** button (Logout is gone)
6. Open DevTools → Application → Session Storage → verify OIDC keys are cleared
7. Open a new tab (NOT incognito) and navigate to `http://localhost:30000/`
8. Verify the **Login** button is shown (SSO session cleared)

**Expected:** Logout clears Keycloak SSO session and OIDC tokens. Login button visible immediately.

---

## MT-06 — Unauthenticated Cart Access → Keycloak Redirect

**E2E coverage:** `auth.spec.ts` test 3 — "unauthenticated access to cart redirects to Keycloak"

**Goal:** Navigating to `/cart` without a session triggers a login redirect when cart is empty.

> **Note:** With the guest cart feature, visiting `/cart` when unauthenticated shows the **guest cart page** (which may be empty). The redirect to Keycloak only happens when clicking "Login to Checkout" button, not on page load. This test verifies the direct URL navigation behaviour.

**Steps:**
1. Open an **incognito** window (no stored auth)
2. Navigate directly to `http://localhost:30000/cart`
3. Verify the page shows the **guest cart view** (either empty with "Your cart is empty" or with any previously added guest items)
4. Verify the URL remains `/cart` (no immediate redirect — guest users can view the cart)
5. If cart is empty: navigate to catalog, add a book, return to cart
6. Verify the **"Login to Checkout"** button is visible
7. Do NOT click it yet — that is covered in MT-07

**Expected:** Unauthenticated users can reach `/cart` and see the guest cart. Redirect to Keycloak happens on clicking "Login to Checkout", not on page arrival.

---

## MT-07 — Guest Cart: Login-to-Checkout Redirects to Keycloak

**E2E coverage:** `guest-cart.spec.ts` test 2 — "checkout button redirects unauthenticated guest to Keycloak"

**Goal:** The "Login to Checkout" button triggers OIDC redirect correctly from a secure context.

**Steps:**
1. Open an **incognito** window and navigate to `http://localhost:30000` (use localhost, not myecom.net)
2. Add one book to the guest cart (click "Add to Cart")
3. Navigate to `http://localhost:30000/cart`
4. Verify the **"Login to Checkout"** button is visible
5. Click **"Login to Checkout"**
6. Verify the browser redirects to `http://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/auth` within 20 seconds
7. Verify the Keycloak login form appears

**Expected:** Clicking "Login to Checkout" from localhost triggers OIDC redirect to Keycloak.

**Fail indicators:**
- Button click does nothing (crypto.subtle error — must use localhost, not myecom.net)
- "Login to Checkout" button not visible on guest cart page
- Redirect takes > 20 seconds

---

## MT-08 — Guest Cart: Merge on Login

**E2E coverage:** `guest-cart.spec.ts` test 3 — "after login, guest cart items are preserved in authenticated cart"

**Goal:** Items added as guest are merged into the server-side cart after authentication.

**Steps:**
1. Open an **incognito** window and navigate to `http://localhost:30000`
2. Add **one book** to the guest cart
3. Navigate to `http://localhost:30000/cart`
4. Verify the guest cart table shows 1 row
5. Click **"Login to Checkout"**
6. On the Keycloak login form, sign in as `user1` / `CHANGE_ME`
7. After the OIDC callback, verify you are redirected to `/cart` (not `/`)
8. Verify the cart page now shows the **"Your Cart"** heading (authenticated view)
9. Verify the book you added as a guest is **still present** in the cart table (≥ 1 row)
10. Verify `localStorage.bookstore_guest_cart` is now **empty or deleted** (check DevTools)
11. Click **Checkout** and verify an order confirmation page appears

**Expected:** Guest cart items merged into authenticated server cart. localStorage cleared. Order completes.

**Fail indicators:**
- Cart empty after login (guest items lost)
- Redirect goes to `/` instead of `/cart` after callback
- `bookstore_guest_cart` not cleared after login
- "Login to Checkout" button still shown after auth

---

## MT-09 — Auth Return URL: Land on Original Page After Login

**E2E coverage:** Session 15 feature — manual verification (no dedicated E2E test, covered by guest-cart flow)

**Goal:** After logging in from a specific page, the user returns to that page (not always `/`).

**Steps:**
1. Open an **incognito** window at `http://localhost:30000`
2. Navigate to `http://localhost:30000/search` (the search page)
3. Type `python` in the search box and click Search — verify results appear
4. Click **Login** in the navbar (from the `/search?q=python` URL)
5. Complete Keycloak login as user1 / `CHANGE_ME`
6. After the OIDC callback, verify the browser lands on `/search?q=python` — **not** on `/`
7. Verify the search results are visible for "python" with the authenticated navbar

**Expected:** Original page (`/search?q=python`) restored after auth. Not redirected to home.

**Fail indicators:**
- Lands on `/` (home) after login instead of the search page
- Search results not visible / query string lost

---

## MT-10 — Protected Route: `/order-confirmation` Guards Unauthenticated Access

**E2E coverage:** Session 15 feature — manual verification (`ProtectedRoute` component)

**Goal:** Navigating directly to `/order-confirmation` without a session triggers a login redirect.

**Steps:**
1. Open an **incognito** window at `http://localhost:30000`
2. Navigate directly to `http://localhost:30000/order-confirmation`
3. Verify the page shows a brief "Redirecting to login..." message
4. Verify the browser then redirects to Keycloak (or to `localhost:30000/login?return=/order-confirmation`)
5. Complete login as user1 / `CHANGE_ME`
6. After the OIDC callback, verify you land on `/order-confirmation` (the original destination)

**Expected:** Protected route blocks unauthenticated access and restores the destination after login.

**Fail indicators:**
- Order confirmation page renders without a session (broken/empty state)
- No redirect to login
- After login, lands on `/` instead of `/order-confirmation`

---

## MT-11 — Authenticated Catalog: Add to Cart Buttons Visible

**E2E coverage:** `catalog.spec.ts` test 4 — "authenticated user sees Add to Cart buttons"

**Goal:** After login, catalog shows actionable "Add to Cart" buttons for all books.

**Steps:**
1. Log in as user1 (MT-03 — use `localhost:30000` for login)
2. Navigate to `http://myecom.net:30000` (or `http://localhost:30000`)
3. Verify the navbar shows the Logout button (authenticated)
4. Verify all book cards show **"Add to Cart"** buttons (no "Login to Buy" anywhere)
5. Count the buttons — must equal the number of book cards (≥ 10)

**Expected:** All book cards have "Add to Cart" buttons when authenticated.

---

## MT-12 — Add to Cart & Cart Totals (Authenticated)

**E2E coverage:** `cart.spec.ts` tests 1 and 2 — "authenticated user can add a book to cart", "cart shows total price"

**Goal:** Authenticated users can add books to the server cart and see accurate totals.

**Steps:**
1. Log in as user1
2. On the catalog, click **"Add to Cart"** on the first book
3. Verify the button briefly shows **"Adding..."** then returns to "Add to Cart"
4. Open DevTools → Network tab — verify `POST /ecom/cart` returned 2xx
5. Navigate to `/cart`
6. Verify the **"Your Cart"** heading is visible (authenticated view)
7. Verify at least **1 row** in the cart table:
   - Book title
   - Quantity (`1`)
   - Unit price (`$XX.XX`)
   - Subtotal
8. Verify a **"Total: $XX.XX"** line is visible
9. Go back to catalog and add a **second different book**
10. Return to `/cart` and verify **2 rows** are listed
11. Verify the total equals the sum of both subtotals

**Expected:** Items added, persisted server-side, total calculated correctly.

**Fail indicators:**
- Cart empty after adding (API error — check console)
- `POST /ecom/cart` returns 401 (JWT not attached)
- Total does not match sum of items

---

## MT-13 — Book Search

**E2E coverage:** `search.spec.ts` tests 1, 2, 3 — title search, author search, zero results

**Goal:** The search page returns relevant results and handles no-match queries correctly.

**Steps:**
1. Navigate to `http://myecom.net:30000/search`
2. Verify an empty search box and search button
3. Type **`Python`** and click Search
4. Verify results appear containing "Python" in the title (e.g. *Learning Python*)
5. Verify a result count indicator is visible (e.g. "3 results")
6. Clear the search box and type **`Martin Kleppmann`** and click Search
7. Verify *Designing Data-Intensive Applications* appears in results
8. Clear the search box and type **`xyznotabook9999`** and click Search
9. Verify a **"0 results"** message appears (no book cards)
10. Open DevTools → Network — verify each search sends `GET /ecom/books/search?q=<term>` and returns 200

**Expected:** Title and author search return matching books. Invalid queries show zero-results message.

**Fail indicators:**
- All books shown regardless of query (search not filtering)
- No results message absent for invalid query
- Network request not sent (search only filters client-side)

---

## MT-14 — Checkout Flow & Order Confirmation

**E2E coverage:** `checkout.spec.ts` tests 1 and 2 — "complete checkout flow", "cart is empty after successful checkout"

**Goal:** Checkout creates a server-side order, shows a confirmation, and clears the cart.

**Steps:**
1. Log in as user1
2. Add at least **1 book** to the cart
3. Navigate to `/cart`
4. Review the items and verify a **Checkout** button is present
5. Click **Checkout**
6. Monitor DevTools Network — verify `POST /ecom/checkout` returns 2xx with an order ID
7. Verify the browser navigates to `/order-confirmation?orderId=<uuid>&total=<amount>`
8. Verify the **"Order Confirmed"** heading is visible
9. Verify **Order ID** (UUID format) is displayed
10. Verify **Total** amount is displayed
11. Navigate back to `/cart`
12. Verify the cart shows **"Your cart is empty"**

**Expected:** Order placed server-side. Confirmation page with UUID order ID and total. Cart cleared.

**Fail indicators:**
- Checkout button does nothing
- `POST /ecom/checkout` returns 5xx (inventory or Kafka issue)
- No redirect to `/order-confirmation`
- Cart not cleared after successful checkout

---

## MT-15 — CDC Pipeline: Order Appears in Analytics DB Within 30 s

**E2E coverage:** `cdc.spec.ts` test 1 — "order placed via UI appears in analytics DB within 30s"

**Goal:** A placed order propagates through Debezium → Kafka → analytics-consumer → analytics-db within 30 seconds.

**Prerequisites:** Note the order ID from MT-14 (visible in the URL).

**Steps:**
1. Place an order (MT-14) and copy the `orderId` UUID from the URL
2. Open a terminal and run:
   ```bash
   kubectl exec -n analytics deployment/analytics-db -- \
     psql -U analyticsuser analyticsdb \
     -c "SELECT id, total, created_at FROM fact_orders WHERE id = '<ORDER_ID>';"
   ```
3. If no row yet, retry every 5 seconds for up to 30 seconds
4. Verify the row appears with:
   - `id` matching the order UUID
   - `total` matching the checkout total
5. Also query `fact_order_items`:
   ```bash
   kubectl exec -n analytics deployment/analytics-db -- \
     psql -U analyticsuser analyticsdb \
     -c "SELECT order_id, quantity FROM fact_order_items WHERE order_id = '<ORDER_ID>';"
   ```
6. Verify ≥ 1 row in `fact_order_items`

**Expected:** Order and order items appear in analytics DB within 30 seconds.

**Debugging if it fails:**
```bash
# Check Debezium ecom connector status
kubectl exec -n infra deployment/debezium -- \
  curl -s localhost:8083/connectors/ecom-connector/status | python3 -m json.tool

# Check analytics consumer logs
kubectl logs -n analytics deployment/analytics-consumer --tail=50
```

---

## MT-16 — CDC Pipeline: dim_books & fact_inventory Sync

**E2E coverage:** `cdc.spec.ts` tests 2 and 3 — "books dim table is populated", "inventory table is synced"

**Goal:** Book catalog and inventory data are replicated to the analytics DB via CDC.

**Steps (dim_books):**
1. Run:
   ```bash
   kubectl exec -n analytics deployment/analytics-db -- \
     psql -U analyticsuser analyticsdb \
     -c "SELECT id, title, author FROM dim_books ORDER BY title LIMIT 5;"
   ```
2. Verify ≥ 1 row returned with non-null title and author
3. Compare with `http://myecom.net:30000` catalog — titles should match

**Steps (fact_inventory):**
4. Run:
   ```bash
   kubectl exec -n analytics deployment/analytics-db -- \
     psql -U analyticsuser analyticsdb \
     -c "SELECT book_id, quantity FROM fact_inventory LIMIT 5;"
   ```
5. Verify ≥ 1 row returned with non-zero quantity
6. After placing an order, re-query within 30 seconds and verify the purchased book's quantity decreased

**Expected:** Both tables populated. Inventory reflects post-order stock levels.

---

## MT-17 — Apache Superset: Dashboard and Charts

**E2E coverage:** `superset.spec.ts` tests 1–4 — "dashboard exists", "Sales Volume chart renders", "Sales Over Time chart renders", "dashboard loads with SVG/canvas elements"

**Goal:** The "Book Store Analytics" dashboard exists with two functioning ECharts visualisations.

**Steps:**
1. Navigate to `http://localhost:32000/login/`
2. Log in with `admin` / `CHANGE_ME`
3. Verify redirect to `/superset/welcome`
4. Click **Dashboards** in the top menu
5. Verify **"Book Store Analytics"** is listed
6. Navigate to `http://localhost:32000/chart/list/`
7. Verify **"Product Sales Volume"** is listed
8. Verify **"Sales Over Time"** is listed
9. Click **Dashboards** again and open **"Book Store Analytics"**
10. Wait for charts to render (up to 30 seconds)
11. Verify at least 2 chart containers render (SVG or canvas elements)
12. Hover over bar/line elements in each chart — verify tooltips appear with values
13. Verify chart 1 (bar chart) shows books on X-axis with sales volume
14. Verify chart 2 (line/area chart) shows dates on X-axis with revenue

**Expected:** Both charts render with live data. No "No data" messages.

**Fail indicators:**
- "No data found" on chart
- Infinite loading spinner
- Dashboard does not exist in the list

---

## MT-18 — Istio Gateway: All HTTP Routes Reachable

**E2E coverage:** `istio-gateway.spec.ts` tests 1–4 — UI route, ecom /books, inventory /health, Keycloak OIDC discovery

**Goal:** All external routes configured in Kubernetes HTTPRoute objects respond correctly.

**Steps:**
```bash
# 1. UI — React app served from myecom.net:30000
curl -s -o /dev/null -w "UI: %{http_code}\n" http://myecom.net:30000/
# Expected: 200

# 2. E-Commerce API — books catalog (Spring Page response)
curl -s http://api.service.net:30000/ecom/books | python3 -c "
import sys, json
d = json.load(sys.stdin)
books = d.get('content', d) if isinstance(d, dict) else d
print(f'Books API: {len(books)} books returned')
"
# Expected: "Books API: 10 books returned"

# 3. Inventory API — health check
curl -s http://api.service.net:30000/inven/health
# Expected: {"status": "ok"}

# 4. Keycloak — OIDC discovery document
curl -s "http://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('issuer:', d['issuer'])"
# Expected: issuer: http://idp.keycloak.net:30000/realms/bookstore
```

**Expected:** All routes return 200. Books count ≥ 10. Inventory health = ok. OIDC issuer correct.

---

## MT-19 — Istio Gateway: JWT Enforcement & Public Stock Endpoint

**E2E coverage:** `istio-gateway.spec.ts` tests 5 and 6 — "cart endpoint enforces JWT", "/inven/stock/{id} is publicly reachable"

**Goal:** JWT-protected endpoints reject unauthenticated requests; public endpoints respond without auth.

**Steps:**
```bash
# 1. Protected endpoint — no token (must return 401)
curl -s -o /dev/null -w "Cart (no token): %{http_code}\n" \
  http://api.service.net:30000/ecom/cart
# Expected: 401

# 2. Protected endpoint — invalid token (must return 401)
curl -s -o /dev/null -w "Cart (bad token): %{http_code}\n" \
  -H "Authorization: Bearer invalid.token.here" \
  http://api.service.net:30000/ecom/cart
# Expected: 401

# 3. Public inventory stock endpoint
curl -s "http://api.service.net:30000/inven/stock/00000000-0000-0000-0000-000000000001"
# Expected: {"book_id": "...", "quantity": <number>}
```

**Also verify mTLS is enforced:**
```bash
# All application namespaces should be labelled for ambient mesh
kubectl get namespaces --show-labels | grep "istio.io/dataplane-mode=ambient"
# Expected: ecom, inventory, identity, infra, analytics, observability all listed
```

**Expected:** 401 for unauthenticated cart requests. 200 with quantity for public stock endpoint.

---

## MT-20 — Kiali: Service Mesh Dashboard and Prometheus

**E2E coverage:** `kiali.spec.ts` tests 1–3 — "Kiali login page or dashboard loads", "graph section is accessible", "Kiali can reach Prometheus"

**Goal:** Kiali is reachable at NodePort 32100, graph loads without Prometheus errors.

> **No port-forward needed.** Kiali is exposed via a Docker proxy container (`kiali-proxy`) forwarding `localhost:32100` → kind node IP:32100.

**Steps:**
1. Open `http://localhost:32100/kiali` in a browser
2. Verify the Kiali UI loads (login page or dashboard)
3. Verify the URL contains `/kiali` (not ERR_CONNECTION_REFUSED)
4. Navigate to **Graph** → select namespaces: `ecom`, `inventory`
5. Verify the graph loads **without** any of these error messages:
   - "Prometheus is not reachable"
   - "Cannot connect to Prometheus"
   - "unreachable"
6. Verify service nodes appear in the graph (ecom-service, inventory-service, etc.)
7. Verify no warning/alert banners about Prometheus connectivity

**Verify Prometheus is live:**
```bash
curl -s "http://localhost:32100/kiali/api/status" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ext = d.get('externalServices', [])
prom = next((s for s in ext if s.get('name','').lower() == 'prometheus'), None)
print('Prometheus status:', prom)
"
# Expected: Prometheus entry with no error
```

**If kiali-proxy is not running (e.g. after cluster recreation):**
```bash
CTRL_IP=$(kubectl get node bookstore-control-plane \
  -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')
docker rm -f kiali-proxy 2>/dev/null
docker run -d --name kiali-proxy \
  --network kind --restart unless-stopped \
  -p 32100:32100 \
  alpine/socat TCP-LISTEN:32100,fork,reuseaddr TCP:${CTRL_IP}:32100
```

**Expected:** Kiali reachable. Graph loads. No Prometheus error banners.

---

## MT-21 — API Smoke Tests

**Goal:** Comprehensive curl verification of all API endpoints.

```bash
# ── Public Endpoints ─────────────────────────────────────────────────────────

# Book catalog (Spring Page format)
curl -s http://api.service.net:30000/ecom/books \
  | python3 -c "import sys,json; d=json.load(sys.stdin); books=d.get('content',d); print(f'{len(books)} books')"
# Expected: 10 books

# Book search by title
curl -s "http://api.service.net:30000/ecom/books/search?q=python" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); books=d.get('content',d); print(f'{len(books)} results')"
# Expected: ≥ 1 result

# Book search — no results
curl -s "http://api.service.net:30000/ecom/books/search?q=xyznotabook" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); books=d.get('content',d); print(f'{len(books)} results')"
# Expected: 0 results

# Inventory health
curl -s http://api.service.net:30000/inven/health
# Expected: {"status": "ok"}

# Inventory stock (sequential seed UUID)
curl -s "http://api.service.net:30000/inven/stock/00000000-0000-0000-0000-000000000001"
# Expected: {"book_id": "...", "quantity": <number>}

# Keycloak OIDC discovery
curl -s "http://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('issuer:', d['issuer'])"
# Expected: issuer: http://idp.keycloak.net:30000/realms/bookstore

# ── Protected Endpoints ───────────────────────────────────────────────────────

# Cart without token — must 401
curl -s -o /dev/null -w "Status: %{http_code}\n" http://api.service.net:30000/ecom/cart
# Expected: Status: 401

# ── Infrastructure ────────────────────────────────────────────────────────────

# Kafka topics
kubectl exec -n infra deployment/kafka -- \
  kafka-topics --bootstrap-server localhost:9092 --list
# Expected includes: order.created, inventory.updated

# Debezium connectors
kubectl exec -n infra deployment/debezium -- \
  curl -s localhost:8083/connectors | python3 -m json.tool
# Expected: ["ecom-connector","inventory-connector"]

# Debezium connector status
kubectl exec -n infra deployment/debezium -- \
  curl -s localhost:8083/connectors/ecom-connector/status \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['connector']['state'])"
# Expected: RUNNING

# Non-root containers
kubectl exec -n ecom deployment/ecom-service -- id
# Expected: uid=1000
kubectl exec -n inventory deployment/inventory-service -- id
# Expected: uid=1000
```

---

## MT-22 — Full Regression Journey

**Goal:** Single end-to-end test that exercises all components together.

**Steps:**
1. Open an **incognito** window at `http://myecom.net:30000`
2. Verify the catalog loads with ≥ 10 books (MT-01)
3. Click **"Add to Cart"** on "Learning Python" — verify toast appears (MT-02)
4. Navigate to `/cart` — verify guest cart shows 1 item with "Browsing as guest" notice
5. Navigate to `http://localhost:30000` and click **Login** in the navbar
6. Sign in as user1 / `CHANGE_ME` on Keycloak
7. Verify redirected back to catalog at `localhost:30000` with Logout button
8. Navigate to `/cart` — verify the guest item ("Learning Python") is now in the authenticated cart
9. Add **"Clean Code"** from the catalog to the cart
10. Return to `/cart` — verify **2 items** with correct prices
11. Note the total, click **Checkout**
12. Verify redirect to `/order-confirmation` with an order UUID and the same total
13. Copy the order UUID from the URL
14. Navigate to `/cart` — verify it shows "Your cart is empty"
15. Open a terminal and poll analytics DB:
    ```bash
    for i in $(seq 1 6); do
      result=$(kubectl exec -n analytics deployment/analytics-db -- \
        psql -U analyticsuser analyticsdb -t \
        -c "SELECT id FROM fact_orders WHERE id = '<ORDER_ID>';")
      [ -n "$result" ] && echo "Found after ${i}x5s!" && break
      echo "Attempt $i — waiting..."
      sleep 5
    done
    ```
16. Verify the order appears within 30 seconds
17. Navigate to `http://localhost:32000` → Superset → "Book Store Analytics" dashboard
18. Verify both charts render (bar chart and line chart)
19. Navigate to `http://localhost:32100/kiali` — verify the graph loads without Prometheus errors
20. Return to the BookStore UI and click **Logout**
21. Verify the Login button appears and sessionStorage is cleared

**Expected:** All 21 steps complete without error. Guest cart merged. Order in analytics DB within 30 s. Superset charts live. Kiali healthy.

---

## Test Execution Checklist

| ID | Description | E2E Tests | Pass | Fail | Notes |
|----|-------------|-----------|------|------|-------|
| MT-01 | Public catalog — book listing | catalog:1–2 | ☐ | ☐ | |
| MT-02 | Guest cart — add without login, badge | catalog:3, cart:3, guest-cart:1,4 | ☐ | ☐ | |
| MT-03 | OIDC PKCE login flow | auth-setup:1, auth:1 | ☐ | ☐ | |
| MT-04 | Token storage security (no localStorage) | auth:1 | ☐ | ☐ | |
| MT-05 | Logout flow | auth:2 | ☐ | ☐ | |
| MT-06 | Unauth cart access — guest cart shown | auth:3 | ☐ | ☐ | |
| MT-07 | Guest cart — login-to-checkout → Keycloak | guest-cart:2 | ☐ | ☐ | |
| MT-08 | Guest cart — merge on login | guest-cart:3 | ☐ | ☐ | |
| MT-09 | Auth return URL — original page restored | (Session 15) | ☐ | ☐ | |
| MT-10 | Protected route — /order-confirmation | (Session 15) | ☐ | ☐ | |
| MT-11 | Authenticated catalog — Add to Cart buttons | catalog:4 | ☐ | ☐ | |
| MT-12 | Add to cart & cart totals (authenticated) | cart:1–2 | ☐ | ☐ | |
| MT-13 | Book search — title, author, no results | search:1–3 | ☐ | ☐ | |
| MT-14 | Checkout flow & order confirmation | checkout:1–2 | ☐ | ☐ | |
| MT-15 | CDC — order in analytics DB within 30 s | cdc:1 | ☐ | ☐ | |
| MT-16 | CDC — dim_books & fact_inventory sync | cdc:2–3 | ☐ | ☐ | |
| MT-17 | Superset dashboard and charts | superset:1–4 | ☐ | ☐ | |
| MT-18 | Istio Gateway — all routes reachable | istio-gateway:1–4 | ☐ | ☐ | |
| MT-19 | Istio Gateway — JWT enforcement & public stock | istio-gateway:5–6 | ☐ | ☐ | |
| MT-20 | Kiali — dashboard, graph, Prometheus | kiali:1–3 | ☐ | ☐ | |
| MT-21 | API smoke tests | (supporting) | ☐ | ☐ | |
| MT-22 | Full regression journey | all | ☐ | ☐ | |

---

## Automated Test Reference

All 36 scenarios above are covered by the Playwright E2E suite:

```bash
cd /Volumes/Other/rand/llm/microservice/e2e

# Full suite — generates screenshots in e2e/screenshots/
npm run test

# Open HTML report
npm run report

# Run a single spec
npx playwright test catalog.spec.ts
npx playwright test guest-cart.spec.ts
npx playwright test kiali.spec.ts
npx playwright test istio-gateway.spec.ts

# Headed browser (watch execution)
npm run test:headed

# Playwright Inspector (step-through debugging)
npm run test:ui
```

**Test files and coverage:**

| Spec File | Tests | Coverage Area |
|-----------|-------|---------------|
| `fixtures/auth.setup.ts` | 1 | OIDC login, save browser state |
| `auth.spec.ts` | 3 | Token security, logout, unauth redirect |
| `catalog.spec.ts` | 4 | Book listing, card details, unauth/auth Add to Cart |
| `cart.spec.ts` | 3 | Auth add-to-cart, totals, guest add-to-cart |
| `guest-cart.spec.ts` | 4 | Guest add, badge, login-to-checkout, merge-on-login |
| `search.spec.ts` | 3 | Title search, author search, zero results |
| `checkout.spec.ts` | 2 | Complete checkout, empty cart after order |
| `cdc.spec.ts` | 3 | Order in analytics DB, dim_books, fact_inventory |
| `superset.spec.ts` | 4 | Dashboard exists, both charts, SVG/canvas rendered |
| `istio-gateway.spec.ts` | 6 | UI, books API, inventory health, Keycloak, JWT enforcement, public stock |
| `kiali.spec.ts` | 3 | Kiali reachable, graph loads, no Prometheus errors |
| **Total** | **36** | |

Manual testing should be performed when:
- First deploying to a new environment
- After significant infrastructure changes (cluster recreation, cert rotation)
- Before release sign-off
- When investigating issues not caught by automated tests
