# UX Architecture Review -- Book Store UI

**Date:** 2026-03-08
**Scope:** Full review of `ui/src/` -- React 19.2 + Vite + OIDC PKCE (Keycloak)
**Current state:** 24 source files (8 pages, 4 components, 4 API modules, 2 auth modules, 1 hook, 1 CSS file)

---

## 1. Current State Assessment

### What Works Well

- **Clean design system.** `styles.css` establishes CSS custom properties (`--color-primary`, `--color-accent`, etc.) with a consistent visual language. Cards have hover lift effects, buttons have clear states, and the color palette is professional.
- **Guest cart with merge-on-login.** The guest-to-authenticated cart merge flow (`useGuestCart.ts` + `CallbackPage.tsx` + `CartPage.tsx`) is well-implemented. Items persist in localStorage for guests and merge via `Promise.allSettled` on login.
- **Progressive stock loading.** Stock data loads asynchronously after books load (catalog/search), with graceful degradation if the inventory service is unreachable.
- **StockBadge visual hierarchy.** Three clear states (green/orange/red) with distinct colors and copy. Loading state uses a subtle placeholder.
- **Admin role gating.** `AdminRoute.tsx` handles three states correctly: loading, not-authenticated (redirect), not-admin (access denied message).
- **Auth UX resilience.** The OIDC flow handles the cross-origin `myecom.net` vs `localhost` problem with a relay mechanism, and `crypto.subtle` detection falls back gracefully.
- **Sticky nav.** NavBar is `position: sticky` with a high z-index, so it remains visible during scrolling.
- **Toast notifications.** Non-intrusive, auto-dismiss, positioned bottom-right.

### What Needs Improvement

The sections below detail every issue found, organized by UX domain and prioritized.

---

## 2. Prioritized Recommendations

### Legend
- **P0 -- Critical:** Broken functionality, data loss risk, or significant usability blocker
- **P1 -- High:** Major UX friction that affects most user journeys
- **P2 -- Medium:** Noticeable gaps that degrade the experience for some users
- **P3 -- Nice-to-have:** Polish items that elevate the product from functional to refined

---

### P0 -- Critical

#### P0-1. No error boundary -- unhandled exceptions crash the entire app

**Current:** No React error boundary anywhere. A rendering error in any component (including admin pages, cart, or stock badge) causes a white screen with no recovery path.

**Recommendation:** Add a top-level `ErrorBoundary` component wrapping `<BrowserRouter>` in `App.tsx`. Display a friendly "Something went wrong" message with a "Reload" button. Optionally add a second boundary around `<Routes>` so NavBar survives page-level crashes.

**Wireframe:**
```
+--------------------------------------------------+
|  [NavBar stays visible]                           |
+--------------------------------------------------+
|                                                    |
|     Something went wrong.                         |
|                                                    |
|     We're sorry -- an unexpected error occurred.  |
|     [Reload Page]  [Go to Home]                   |
|                                                    |
+--------------------------------------------------+
```

#### P0-2. OrderConfirmationPage exposes order data in URL and has no design

**Current:** Order ID and total are passed as query parameters (`?orderId=...&total=...`). The page is a bare `<div>` with inline padding, no page class, and a plain `<a>` link. The order total comes from the URL (user-editable), not from a server response.

**Recommendation:**
1. Pass order data via `useNavigate` state (not query params) -- prevents URL manipulation and accidental sharing of order details in browser history.
2. Apply the `page` and `page-title` CSS classes for visual consistency.
3. Add an order summary (items purchased), a success icon/animation, and a "View Order History" link (future).
4. Clear cart state on mount to prevent stale cart badge.

#### P0-3. Cart quantity controls have no error handling for server failures

**Current:** `handleServerQty` in `CartPage.tsx` calls `cartApi.add/update/remove` but has no `try/catch`. A network error or 500 will throw an unhandled promise rejection, and the UI will show stale data with no indication of failure.

**Recommendation:** Wrap `handleServerQty` in try/catch, show a toast on failure, and do not update the local item list until the server confirms.

---

### P1 -- High

#### P1-1. No loading skeletons -- text-only loading states feel unpolished

**Current:** Every loading state is `<div className="loading-state">Loading...</div>` -- plain centered text. Catalog shows no indication of how many cards will appear.

**Recommendation:** Add skeleton screens that mirror the final layout:
- **Catalog:** Grid of placeholder cards with animated shimmer (gray rectangles for cover, title, author, price, button).
- **Cart:** Table skeleton rows.
- **Admin tables:** Row skeletons with alternating widths.
- **Search:** Skeleton rows matching `search-row` shape.

**Wireframe (Catalog Skeleton):**
```
+------- +------- +------- +-------+
| ###### | ###### | ###### | ######|  <- cover placeholder
| ####   | ####   | ####   | ####  |  <- title
| ###    | ###    | ###    | ###   |  <- author
| ##     | ##     | ##     | ##    |  <- price
| [####] | [####] | [####] | [####]|  <- button
+--------+--------+--------+-------+
```

#### P1-2. No 404 / catch-all route

**Current:** Navigating to any undefined path (e.g., `/settings`, `/orders`) renders nothing below the NavBar -- blank white space with no feedback.

**Recommendation:** Add a catch-all `<Route path="*" element={<NotFoundPage />} />` in `App.tsx`. Display a "Page not found" message with links to the catalog and search.

#### P1-3. No focus management after navigation

**Current:** After OIDC redirect or page transitions, focus is not managed. Screen reader users hear nothing after login completes. Tab order restarts from the top of the DOM, which is correct, but the `<main>` content area receives no focus announcement.

**Recommendation:**
1. Add `<main>` landmark around `<Routes>` in `App.tsx`.
2. Use a route-change listener to set focus to the `<h1>` of the new page (or a `role="status"` live region for transient messages like "Login successful").

#### P1-4. No responsive design -- tables and grids break on mobile

**Current:** `styles.css` has no `@media` queries. The cart table, admin tables, search rows, and nav all use fixed layouts that will overflow or become unusable below ~768px.

Specific breakpoints needed:
- **Nav (<640px):** Stack vertically or use hamburger menu. "Search" and "Cart" links need to remain accessible.
- **Book grid (<480px):** Should become a single column.
- **Cart table (<768px):** Convert to stacked card layout per item.
- **Admin tables (<768px):** Horizontal scroll wrapper or card layout.
- **Search form (<480px):** Full-width input and button stacked.

#### P1-5. `<a href="/">` instead of `<Link to="/">` in CartPage and OrderConfirmationPage

**Current:** "Continue Shopping" and "Browse Books" links use raw `<a href="/">` which causes a full page reload, destroying all in-memory React state (including the auth token from `InMemoryWebStorage`).

**Impact:** In the current setup with `sessionStorage` this may not lose auth, but it still causes unnecessary full reloads. More critically, it breaks SPA navigation patterns and any future in-memory state.

**Recommendation:** Replace all `<a href="...">` with `<Link to="...">` from react-router-dom throughout all pages.

#### P1-6. No confirmation or undo for destructive actions

**Current:** Admin book delete uses `window.confirm()` -- a native browser dialog that is not styleable, breaks the visual design, and is not accessible to screen readers in all contexts. Stock edit uses `window.alert()` for errors.

**Recommendation:** Replace `confirm()` and `alert()` with a custom modal/dialog component:
- Confirm dialog for delete with "Cancel" (primary) and "Delete" (danger) buttons.
- Inline error messages (not alerts) for validation failures.
- Consider undo pattern: "Deleted. [Undo]" toast with 5s TTL instead of pre-confirmation.

---

### P2 -- Medium

#### P2-1. No keyboard accessibility on interactive elements

**Current issues found:**
- `AdminCard` in `AdminDashboard.tsx` uses `onMouseEnter/onMouseLeave` for hover styles but has no `onFocus/onBlur` equivalent. Keyboard users see no visual change when focused.
- `qty-btn` elements have no `aria-label` (screen readers hear the raw character minus or plus).
- Order rows in `AdminOrdersPage.tsx` have `cursor: pointer` and `onClick` but use `<tr>`, which is not natively focusable. Keyboard users cannot expand order details.
- `StockBadge` uses color alone to convey status (red/orange/green) with text labels, which is good, but loading state `...` has no `aria-label`.
- Search form input has a `placeholder` but no associated `<label>` element.

**Recommendation:**
1. Add `aria-label` to all icon-only buttons (`qty-btn`, toast close, stock edit confirm/cancel).
2. Make expandable order rows keyboard-accessible with `tabIndex={0}` and `onKeyDown` for Enter/Space.
3. Add `onFocus/onBlur` handlers alongside `onMouseEnter/onMouseLeave`.
4. Add visually-hidden `<label>` elements for all form inputs (search, admin forms).
5. Add `role="status"` and `aria-label="Loading"` to the stock badge loading state.

#### P2-2. No page titles -- document title is always "Book Store"

**Current:** `index.html` sets `<title>Book Store</title>` and it never changes. Every page shows the same browser tab title, making multi-tab usage difficult and hurting SEO (irrelevant for this app but bad practice).

**Recommendation:** Add a `useDocumentTitle(title)` hook called in each page component:
- Catalog: "Book Catalog -- Book Store"
- Search: "Search: {query} -- Book Store" or "Search Books -- Book Store"
- Cart: "Your Cart (3) -- Book Store"
- Admin Dashboard: "Admin Dashboard -- Book Store"
- Order Confirmation: "Order Confirmed -- Book Store"

#### P2-3. Toast component lacks stacking and severity levels

**Current:** Only one toast can display at a time (single `toast` state string per page). No severity variants (success/error/warning). Error toasts ("Failed to add to cart") look identical to success toasts ("added to cart").

**Recommendation:** Create a toast context/provider that:
- Stacks multiple toasts vertically.
- Supports `success` (green), `error` (red), `warning` (orange), and `info` (blue) variants.
- Has a close button (accessibility).
- Announces to screen readers via `role="alert"` for errors and `role="status"` for success.

#### P2-4. No pagination in catalog

**Current:** `CatalogPage` fetches `page=0&size=20` and displays all results. There is no way to see books beyond the first 20. The `Page<T>` type includes `totalPages` and `number` but they are not used.

**Recommendation:** Add pagination controls (matching the pattern already used in `AdminBooksPage`) or infinite scroll with intersection observer.

#### P2-5. Guest cart poll interval is wasteful

**Current:** NavBar polls `guestCartCount()` every 500ms via `setInterval` to detect same-tab localStorage changes. This is because the `storage` event only fires for cross-tab changes.

**Recommendation:** Replace the 500ms polling with a custom event pattern (same as the `cartUpdated` event used for server cart). Dispatch a `guestCartUpdated` event from `addToGuestCart` and `updateGuestCartQty`, and listen for it in NavBar.

#### P2-6. Admin form input styling is inconsistent

**Current:** `AdminEditBookPage` uses `className="input"` on form fields, but there is no `.input` class defined in `styles.css`. This means form fields have no custom styling -- they use browser defaults, which look inconsistent with the rest of the design.

**Recommendation:** Add `.input` styles to `styles.css` matching the existing `.search-input` pattern (consistent border, border-radius, padding, focus state).

#### P2-7. Inline styles are pervasive in admin pages

**Current:** All admin pages and several components (`AdminRoute`, `AdminDashboard`, `AdminStockPage`, `AdminOrdersPage`, `AdminBooksPage`, `OrderConfirmationPage`, `StockBadge`) use extensive inline `style={{}}` objects instead of CSS classes.

**Impact:** Styles cannot be overridden, are not cached, increase bundle size slightly, and make responsive design via media queries impossible for those elements.

**Recommendation:** Extract admin-specific styles into CSS classes in `styles.css` or a new `admin.css` file. This is a prerequisite for P1-4 (responsive design).

#### P2-8. No visual feedback during add-to-cart on SearchPage

**Current:** `CatalogPage` shows "Adding..." on the button during `cartApi.add()`, but `SearchPage` has no loading state for the add-to-cart button. The user gets no feedback until the toast appears.

**Recommendation:** Add the same `addingId` pattern from `CatalogPage` to `SearchPage`.

#### P2-9. Book cards have no link to a detail page

**Current:** Book cards in the catalog show title, author, genre, price, stock, and an "Add to Cart" button, but there is no way to see a book's full description, ISBN, published year, or cover URL. The `Book` type has all these fields, but they are never displayed to customers.

**Recommendation:** Add a `BookDetailPage` at `/books/:id` with the full book information. Make book titles in catalog cards and search results clickable links to this page. Include an "Add to Cart" button on the detail page as well.

#### P2-10. Session expiry has no user-facing notification

**Current:** `AuthContext` listens for `accessTokenExpired` and sets `user` to `null`, which silently switches the UI to guest mode. If the user is mid-checkout or editing their cart, they lose context with no explanation.

**Recommendation:** Show a modal or banner when session expires: "Your session has expired. Please log in again to continue." with a "Log In" button that preserves the current page path as returnUrl.

---

### P3 -- Nice-to-Have

#### P3-1. No breadcrumb navigation in admin section

**Current:** Admin pages have a "Dashboard" back button in the header, but there is no breadcrumb trail showing the hierarchy (Dashboard > Books > Edit "Title").

**Recommendation:** Add a simple breadcrumb component to admin pages. Example: `Admin / Books / Edit "The Great Gatsby"`.

#### P3-2. No empty search state illustration

**Current:** Before searching, the search page shows nothing below the form. After searching with no results, it shows "0 result(s)" with an empty `search-results` div.

**Recommendation:**
- Before search: Show a subtle illustration or prompt text ("Enter a title, author, or genre to search").
- Zero results: "No books match your search. Try different keywords." with a suggestion to browse the catalog.

#### P3-3. No dark mode support

**Current:** The CSS custom properties in `:root` are light-mode only. There is no `@media (prefers-color-scheme: dark)` block.

**Recommendation:** Add a dark mode variant using the existing CSS custom properties. Override `--color-bg`, `--color-card`, `--color-text`, `--color-border`, `--color-primary`, and `--color-muted` inside a `prefers-color-scheme: dark` media query.

#### P3-4. NavBar cart count does not animate on change

**Current:** The cart badge number updates instantly with no visual indication that it changed. Users may not notice the count going from 2 to 3.

**Recommendation:** Add a brief scale-bounce animation (CSS `@keyframes`) to `.nav-cart-count` when the value changes. Trigger via a key change on the `<span>`.

#### P3-5. No favicon

**Current:** `index.html` has no `<link rel="icon">`. The browser tab shows a generic icon.

**Recommendation:** Add a book-themed favicon (SVG preferred for scalability). Can use an inline SVG data URI for simplicity.

#### P3-6. Admin dashboard stat cards could link to their respective pages

**Current:** `StatCard` is a display-only component. Clicking "Total Books: 10" does nothing.

**Recommendation:** Make stat cards clickable links: "Total Books" links to `/admin/books`, "Total Orders" to `/admin/orders`, "Low Stock" and "Out of Stock" to `/admin/stock` (optionally with a filter query param).

#### P3-7. No book cover images -- emoji placeholders only

**Current:** Book cards show an emoji based on `title.charCodeAt(0) % 6`. The `Book` type has a `coverUrl` field but it is never used on the customer-facing side.

**Recommendation:** If `coverUrl` is set, render an `<img>` with lazy loading and a fallback to the current emoji placeholder. Add `alt={book.title}` for accessibility.

#### P3-8. Admin orders page shows raw UUIDs

**Current:** Order ID and User ID are shown as truncated UUIDs (`abc12345...`). User ID is meaningless to admins.

**Recommendation:** Replace User ID with the user's email (requires API change to include it in `AdminOrderResponse`). Show full Order ID on hover via `title` attribute or in the expanded detail row.

#### P3-9. No transition animation between pages

**Current:** Route changes are instant with no visual transition. Content appears/disappears abruptly.

**Recommendation:** Add a simple fade-in transition to page content using CSS animations on the `.page` container (e.g., `animation: fadeIn 0.15s ease`).

#### P3-10. Search results do not highlight the matched term

**Current:** Search results show book titles and metadata with no indication of which part matched the query.

**Recommendation:** Highlight the search query substring within the title, author, and genre fields using a `<mark>` tag or styled `<span>`.

---

## 3. Component-Level Suggestions

### NavBar.tsx
- Replace 500ms polling with custom event dispatch (P2-5).
- Add `aria-label="Main navigation"` to the `<nav>` element.
- Add `aria-label="Shopping cart, N items"` to the cart link.
- Consider adding a skip-to-content link as the first child for keyboard users.
- The `...` loading indicator for auth state could use `aria-label="Checking authentication"`.

### CatalogPage.tsx
- Add pagination controls (P2-4).
- Add skeleton loading (P1-1).
- Make book titles link to a detail page (P2-9).
- The `bookIcon` function is clever but should fall back to `coverUrl` if available (P3-7).

### SearchPage.tsx
- Add `addingId` loading state for add-to-cart buttons (P2-8).
- Add empty state messaging (P3-2).
- Add `<label>` for the search input (P2-1).
- Consider debounced search-as-you-type for better UX (optional, query param approach is also valid).

### CartPage.tsx
- Replace `<a href="/">` with `<Link to="/">` (P1-5).
- Add try/catch to `handleServerQty` (P0-3).
- Consider a "Remove" button per item (currently decrementing to 0 removes, which is not obvious).
- The guest cart "Login to Checkout" button should explain what happens ("Your cart items will be saved").

### OrderConfirmationPage.tsx
- Complete redesign needed (P0-2). Should show order items, have proper styling, and use navigate state instead of URL params.

### StockBadge.tsx
- Add `aria-label` to loading state (P2-1).
- Consider using the same styled element via CSS classes instead of repeated inline style objects (P2-7).
- The `Infinity` sentinel value for "not loaded yet" is fragile. Consider a dedicated `unknown` state.

### Toast.tsx
- Add `role="status"` or `role="alert"` for screen reader announcement (P2-3).
- Add severity variants (P2-3).
- Add close button for users who want to dismiss immediately.
- Consider `aria-live="polite"` for success and `aria-live="assertive"` for errors.

### AdminRoute.tsx
- The "Access Denied" message should include a "Go Back" or "Go to Home" button.
- `login('/admin')` is called during render, which is a side effect in the render phase. It should be in a `useEffect` (same pattern as `ProtectedRoute`).

### AdminEditBookPage.tsx
- Add client-side validation feedback (required fields, price > 0, year range) before submission.
- The `.input` CSS class is missing from `styles.css` (P2-6).
- Add an "Unsaved changes" warning if the user navigates away with a dirty form.
- The price input allows `0` despite `min="0.01"` if the user types manually.

### AdminStockPage.tsx
- The "Set Qty" action resets reserved to 0 -- this should have a confirmation or warning since it affects in-flight orders.
- Inline editing UX is good but the confirm/cancel buttons use unicode symbols that may render differently across browsers. Use text or SVG icons.
- `alert()` for validation errors should be replaced with inline messaging (P1-6).

### AdminOrdersPage.tsx
- Expandable rows need keyboard accessibility (P2-1).
- Missing `key` prop on the React Fragment wrapping order row + expanded row (uses `<>` instead of `<React.Fragment key={...}>`). This is a React warning in development.
- Consider adding order status filtering (All / Confirmed / Pending).

### AuthContext.tsx
- Session expiry silently drops to guest mode (P2-10).
- `isAdmin` is computed on every render via JWT decode (atob + JSON.parse). Should be memoized with `useMemo`.
- The `isAdmin` computation parses `payload.roles` but Keycloak typically nests roles under `realm_access.roles`. The current flat `roles` key works because the realm mapper is configured to put them there, but this is fragile.

### client.ts (API)
- No request timeout. A hanging server connection will block the UI indefinitely.
- No retry logic for transient failures (503, network errors).
- Error messages expose raw HTTP response bodies to users (e.g., Spring Boot's `ProblemDetail` JSON). Should extract a user-friendly message.

### oidcConfig.ts
- References `silent_redirect_uri` pointing to `silent-renew.html`, but this file does not exist in the project. Silent renewal will fail.
- Comment says "Tokens in sessionStorage" but earlier project docs mention "in-memory only". The `WebStorageStateStore({ store: window.sessionStorage })` is sessionStorage, not in-memory. This contradicts the CLAUDE.md security invariant "tokens in memory only (never localStorage)". SessionStorage is not localStorage, but it is still persistent storage within the tab lifetime. The `InMemoryWebStorage` class from `oidc-client-ts` should be used if the in-memory requirement is real.

---

## 4. Architecture Observations

### Positive Patterns
1. **Token provider injection** (`setTokenProvider` in `client.ts`) cleanly separates auth concern from API calls.
2. **Event-driven cart badge** (`cartUpdated` custom event) avoids prop drilling.
3. **Separate guest/server cart paths** in CartPage is clean, though code duplication could be reduced.

### Structural Concerns
1. **No state management library.** All state is component-local `useState`. For this app's complexity, this is fine, but the cart badge pattern (custom DOM events) is a workaround for not having shared state. If the app grows, consider React Context for cart state or a lightweight state manager.
2. **API error messages are raw.** The pattern `throw new Error(`HTTP ${resp.status}: ${text}`)` leaks server implementation details. User-facing messages should be extracted and sanitized.
3. **No centralized error handling.** Each page manages its own `error` state independently. A shared error context or error boundary strategy would reduce duplication.
4. **Inline styles vs CSS classes split.** The codebase has two styling paradigms: CSS classes in `styles.css` (customer pages) and inline styles (admin pages, components). This makes responsive design and theming difficult. Should converge on one approach.

---

## 5. Proposed Implementation Sessions

If these recommendations are implemented, a suggested ordering by session:

| Session | Theme | Items | Effort |
|---------|-------|-------|--------|
| 23 | Critical Fixes | P0-1, P0-2, P0-3, P1-2, P1-5 | 1 session |
| 24 | Accessibility Foundation | P2-1, P1-3, P2-2, P2-3 (toast upgrade) | 1 session |
| 25 | Responsive Design | P1-4, P2-7 (prerequisite: extract inline styles) | 1-2 sessions |
| 26 | Loading and Error UX | P1-1 (skeletons), P2-10, P1-6, P2-8 | 1 session |
| 27 | Feature Enhancements | P2-4 (pagination), P2-9 (book detail), P3-2, P3-5 | 1 session |
| 28 | Admin Polish | P3-1, P3-6, P3-8, P2-6 | 1 session |
| 29 | Visual Polish | P3-3, P3-4, P3-7, P3-9, P3-10 | 1 session |

Each session should include E2E test updates for any changed user flows.

---

## 6. Security Note

**`oidcConfig.ts` line 22:** The user store is configured as `new WebStorageStateStore({ store: window.sessionStorage })`. The CLAUDE.md document states: "Tokens stored in memory only (never localStorage)". While sessionStorage is not localStorage, it is still a persistent web storage API (survives same-tab navigation, readable by any script in the same origin). If the security requirement is truly "in-memory only", the store should use `new InMemoryWebStorage()` from `oidc-client-ts`. This discrepancy should be reviewed with the security team.

Additionally, the `silent_redirect_uri` references `/silent-renew.html` which does not exist in the project. The `automaticSilentRenew: true` setting will cause silent renewal to fail, potentially logging users out unexpectedly when their access token expires. Either create the `silent-renew.html` file or disable `automaticSilentRenew`.
