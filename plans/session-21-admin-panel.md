# Session 21 — Admin Panel

## Goal

Provide a production-grade admin panel where users with the `admin` Keycloak realm role can:
- **Manage books**: create, view, edit, and delete books (catalog management)
- **Manage stock**: view current stock levels and set/adjust quantities per book
- **View orders**: read-only view of all orders across all users

Regular `customer` role users have zero access to any admin endpoint — enforced at three layers:
1. **Spring Security** — `@PreAuthorize("hasRole('ADMIN')")` on every admin controller
2. **FastAPI** — `require_role("admin")` dependency on every admin endpoint
3. **Kubernetes Gateway** — `/ecom/admin/**` already covered by broad ecom HTTPRoute; inventory admin paths exposed with JWT required

## Credentials

| User    | Password   | Roles              |
|---------|------------|--------------------|
| user1   | CHANGE_ME  | customer           |
| admin1  | CHANGE_ME  | customer, admin    |

---

## Deliverables

| File | Change |
|------|--------|
| `ecom-service/.../dto/BookRequest.java` | NEW — create/update book DTO with validation |
| `ecom-service/.../dto/AdminOrderResponse.java` | NEW — full order DTO for admin view |
| `ecom-service/.../controller/AdminBookController.java` | NEW — CRUD at `/admin/books` |
| `ecom-service/.../controller/AdminOrderController.java` | NEW — read-only at `/admin/orders` |
| `ecom-service/.../service/BookService.java` | UPDATE — add create, update, delete |
| `ecom-service/.../repository/OrderRepository.java` | UPDATE — add findAllBy paginated |
| `inventory-service/app/api/admin.py` | NEW — GET/PUT/POST at `/admin/stock/**` |
| `inventory-service/app/schemas/inventory.py` | UPDATE — StockSetRequest, StockAdjustRequest |
| `inventory-service/app/main.py` | UPDATE — include admin router, allow PUT/POST in CORS |
| `infra/kgateway/routes/inven-route.yaml` | UPDATE — expose /inven/admin/** |
| `ui/src/auth/AuthContext.tsx` | UPDATE — expose `isAdmin` boolean |
| `ui/src/components/AdminRoute.tsx` | NEW — admin-only route guard |
| `ui/src/components/NavBar.tsx` | UPDATE — Admin link for admin users |
| `ui/src/api/admin.ts` | NEW — admin API client |
| `ui/src/pages/admin/AdminDashboard.tsx` | NEW — stats cards |
| `ui/src/pages/admin/AdminBooksPage.tsx` | NEW — book list + create |
| `ui/src/pages/admin/AdminEditBookPage.tsx` | NEW — create/edit form |
| `ui/src/pages/admin/AdminStockPage.tsx` | NEW — stock management |
| `ui/src/App.tsx` | UPDATE — add /admin/* routes |
| `e2e/admin.spec.ts` | NEW — E2E coverage |
| `plans/session-21-admin-panel.md` | NEW — this file |
| `plans/implementation-plan.md` | UPDATE — Session 21 entry |

---

## Admin API Design

### ecom-service — Admin Books (`/admin/books`)

| Method | Path | Description | Role |
|--------|------|-------------|------|
| GET | `/admin/books` | List all books (paginated) | ADMIN |
| GET | `/admin/books/{id}` | Get single book | ADMIN |
| POST | `/admin/books` | Create book | ADMIN |
| PUT | `/admin/books/{id}` | Update book | ADMIN |
| DELETE | `/admin/books/{id}` | Delete book | ADMIN |

### ecom-service — Admin Orders (`/admin/orders`)

| Method | Path | Description | Role |
|--------|------|-------------|------|
| GET | `/admin/orders` | List all orders (paginated, desc) | ADMIN |
| GET | `/admin/orders/{id}` | Get single order with items | ADMIN |

### inventory-service — Admin Stock (`/admin/stock`)

| Method | Path | Description | Role |
|--------|------|-------------|------|
| GET | `/admin/stock` | List all stock entries | ADMIN |
| PUT | `/admin/stock/{book_id}` | Set absolute quantity | ADMIN |
| POST | `/admin/stock/{book_id}/adjust` | Adjust by delta (+/-) | ADMIN |

---

## Security Architecture

```
Browser (admin1 user)
    ↓  Bearer JWT (roles: ["admin", "customer"])
Istio Gateway
    ↓  Forward to service
ecom-service: Spring Security checks ROLE_ADMIN via @PreAuthorize
inventory-service: require_role("admin") FastAPI dependency
```

**No customer can reach admin endpoints** — if they try:
- ecom-service returns `403 Forbidden`
- inventory-service returns `403 Forbidden`

---

## UI Architecture

```
/admin              → AdminDashboard (stats: total books, total orders, low-stock count)
/admin/books        → AdminBooksPage (table with Create/Edit/Delete)
/admin/books/new    → AdminEditBookPage (create mode)
/admin/books/:id    → AdminEditBookPage (edit mode)
/admin/stock        → AdminStockPage (table with Set/Adjust quantity)
```

All admin pages wrapped in `<AdminRoute>` which:
1. Redirects to `/login` if not authenticated
2. Shows "Access denied" if authenticated but not admin
3. Does NOT redirect back from login — admin users should always go to `/admin` after login

**Role detection in browser**: Decodes the access token (without verification — authorization decisions still happen server-side) to read the `roles` claim.

---

## Build & Deploy

```bash
# 1. Rebuild ecom-service (new admin controllers)
cd /Volumes/Other/rand/llm/microservice
docker build -t bookstore/ecom-service:latest ./ecom-service
kind load docker-image bookstore/ecom-service:latest --name bookstore
kubectl rollout restart deployment/ecom-service -n ecom
kubectl rollout status deployment/ecom-service -n ecom --timeout=90s

# 2. Rebuild inventory-service (new admin stock endpoints)
docker build -t bookstore/inventory-service:latest ./inventory-service
kind load docker-image bookstore/inventory-service:latest --name bookstore
kubectl rollout restart deployment/inventory-service -n inventory
kubectl rollout status deployment/inventory-service -n inventory --timeout=60s

# 3. Apply gateway route update
kubectl apply -f infra/kgateway/routes/inven-route.yaml

# 4. Rebuild UI (admin pages)
docker build \
  --build-arg VITE_KEYCLOAK_AUTHORITY=http://idp.keycloak.net:30000/realms/bookstore \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
  --build-arg VITE_REDIRECT_URI=http://localhost:30000/callback \
  -t bookstore/ui-service:latest ./ui
kind load docker-image bookstore/ui-service:latest --name bookstore
kubectl rollout restart deployment/ui-service -n ecom
kubectl rollout status deployment/ui-service -n ecom --timeout=60s

# 5. Run E2E tests
cd e2e && npm run test
```

---

## Acceptance Criteria

- [ ] `GET /ecom/admin/books` returns 403 for user1 (customer role)
- [ ] `GET /ecom/admin/books` returns 200 for admin1 (admin role)
- [ ] `POST /ecom/admin/books` creates a new book
- [ ] `PUT /ecom/admin/books/{id}` updates a book
- [ ] `DELETE /ecom/admin/books/{id}` deletes a book
- [ ] `GET /ecom/admin/orders` returns all orders (admin only)
- [ ] `GET /inven/admin/stock` returns 403 for unauthenticated / customer
- [ ] `PUT /inven/admin/stock/{book_id}` sets absolute quantity (admin only)
- [ ] `POST /inven/admin/stock/{book_id}/adjust` adjusts stock (admin only)
- [ ] NavBar shows "Admin" link only when admin role present
- [ ] Admin pages accessible only when logged in as admin
- [ ] Non-admin users see "Access denied" on admin pages
- [ ] E2E: all new admin tests passing
- [ ] All 99+ existing E2E tests continue to pass

---

**Status:** In Progress
