# BookStore Platform — API Reference

> **Version:** 1.1.0 · **Updated:** 2026-03-02 · **E2E Tests:** 120/120 passing

---

## Interactive API Documentation (Swagger UI)

Both services expose a **live Swagger UI** where you can browse endpoints, read descriptions, and execute requests directly in the browser — no curl required.

| Service | Swagger UI | OpenAPI JSON | ReDoc |
|---------|-----------|--------------|-------|
| **E-Commerce Service** | [`http://api.service.net:30000/ecom/swagger-ui/index.html`](http://api.service.net:30000/ecom/swagger-ui/index.html) | [`/ecom/v3/api-docs`](http://api.service.net:30000/ecom/v3/api-docs) | — |
| **Inventory Service** | [`http://api.service.net:30000/inven/docs`](http://api.service.net:30000/inven/docs) | [`/inven/openapi.json`](http://api.service.net:30000/inven/openapi.json) | [`/inven/redoc`](http://api.service.net:30000/inven/redoc) |

> **Prerequisite:** `/etc/hosts` must contain `127.0.0.1 api.service.net` and the kind cluster must be running (`bash scripts/up.sh`).

---

## Authentication

### How JWTs are issued

All protected endpoints use **Bearer JWT** tokens issued by Keycloak via OIDC Authorization Code + PKCE.

**Via UI (easiest):**
1. Log in at `http://localhost:30000` (user1 / CHANGE_ME)
2. Open DevTools → Application → Session Storage → find the OIDC user entry
3. Copy the `access_token` value

**Via curl (for scripts):**
```bash
TOKEN=$(curl -s -X POST \
  "http://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=ui-client&username=user1&password=CHANGE_ME" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

echo $TOKEN   # paste this into Swagger UI "Authorize" dialog
```

**In Swagger UI:**
1. Click the **Authorize** button (top right of the page)
2. Enter `Bearer <your_access_token>` in the BearerAuth field
3. Click **Authorize** → all protected endpoints now include the token automatically

---

## E-Commerce Service API

**Base URL:** `http://api.service.net:30000/ecom`
**Tech:** Spring Boot 4.0.3 / Java 21
**Swagger UI:** `http://api.service.net:30000/ecom/swagger-ui/index.html`

---

### Tag: Catalog — Public (no auth)

#### `GET /books`

List all books, paginated.

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | `0` | Page number (0-based) |
| `size` | integer | `20` | Items per page |
| `sort` | string | `title` | Sort field (`title`, `price`, `author`) |

**Example request:**
```bash
curl "http://api.service.net:30000/ecom/books?page=0&size=5&sort=price"
```

**Example response (200):**
```json
{
  "content": [
    {
      "id": "00000000-0000-0000-0000-000000000001",
      "title": "The Fellowship of the Ring",
      "author": "J.R.R. Tolkien",
      "price": 14.99,
      "description": "An epic fantasy adventure...",
      "coverUrl": null,
      "isbn": "978-0-618-57494-1",
      "genre": "Fantasy",
      "publishedYear": 1954,
      "createdAt": "2026-03-01T00:00:00Z"
    }
  ],
  "totalElements": 10,
  "totalPages": 2,
  "number": 0,
  "size": 5
}
```

---

#### `GET /books/search`

Full-text search across title, author, and genre.

**Query parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | **Yes** | Search term |
| `page` | integer | No | Page number (default: 0) |
| `size` | integer | No | Page size (default: 20) |

**Example requests:**
```bash
# Search by author
curl "http://api.service.net:30000/ecom/books/search?q=tolkien"

# Search by genre
curl "http://api.service.net:30000/ecom/books/search?q=fantasy"

# No results
curl "http://api.service.net:30000/ecom/books/search?q=doesnotexist"
# → {"content":[],"totalElements":0,...}
```

---

#### `GET /books/{id}`

Get a single book by UUID.

**Path parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Book UUID |

**Example:**
```bash
curl "http://api.service.net:30000/ecom/books/00000000-0000-0000-0000-000000000001"
```

**Responses:**
- `200` — Book object
- `404` — `{"status":404,"detail":"Book not found"}`

---

### Tag: Cart — Bearer JWT required

All cart endpoints require `Authorization: Bearer <token>`.

#### `GET /cart`

Returns all items in the authenticated user's cart.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://api.service.net:30000/ecom/cart"
```

**Response (200):**
```json
[
  {
    "id": "a1b2c3d4-...",
    "userId": "9d82bcb3-...",
    "book": {
      "id": "00000000-0000-0000-0000-000000000001",
      "title": "The Fellowship of the Ring",
      "price": 14.99
    },
    "quantity": 2,
    "createdAt": "2026-03-02T10:00:00Z"
  }
]
```

---

#### `POST /cart`

Add a book to the cart (or increment quantity if already present).

**Request body:**
```json
{
  "bookId": "00000000-0000-0000-0000-000000000001",
  "quantity": 1
}
```

```bash
curl -X POST "http://api.service.net:30000/ecom/cart" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"bookId":"00000000-0000-0000-0000-000000000001","quantity":1}'
```

**Responses:**
- `200` — CartItem object (created or updated)
- `400` — Validation error (quantity < 1)
- `401` — Invalid or missing token
- `404` — Book not found

---

#### `PUT /cart/{itemId}`

Set the exact quantity of a cart item.

```bash
curl -X PUT "http://api.service.net:30000/ecom/cart/<item-id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"quantity":3}'
```

**Responses:**
- `200` — Updated CartItem
- `400` — quantity < 1
- `404` — Item not found or doesn't belong to this user

---

#### `DELETE /cart/{itemId}`

Remove an item from the cart.

```bash
curl -X DELETE "http://api.service.net:30000/ecom/cart/<item-id>" \
  -H "Authorization: Bearer $TOKEN"
```

**Responses:**
- `204` — Removed successfully
- `404` — Item not found

---

### Tag: Checkout — Bearer JWT required

#### `POST /checkout`

Places an order from the current cart contents.

```bash
curl -X POST "http://api.service.net:30000/ecom/checkout" \
  -H "Authorization: Bearer $TOKEN"
```

**What happens internally:**
1. Cart items read from DB
2. `POST /inven/stock/reserve` called per item via mTLS → inventory decremented
3. Order created in DB
4. `order.created` event published to Kafka → CDC → analytics pipeline
5. Cart cleared

**Response (200):**
```json
{
  "id": "f7e6d5c4-...",
  "total": 29.98,
  "status": "PENDING"
}
```

**Error responses:**
- `401` — Missing/invalid token
- `409` — `{"status":409,"detail":"Insufficient stock: available=2 requested=5"}`
- `422` — Cart is empty

---

## Inventory Service API

**Base URL:** `http://api.service.net:30000/inven`
**Tech:** Python 3.12 / FastAPI / uvicorn
**Swagger UI:** `http://api.service.net:30000/inven/docs`
**ReDoc:** `http://api.service.net:30000/inven/redoc`

---

### Tag: stock — Public (no auth)

#### `GET /stock/bulk`

Fetch stock for multiple books in a single request.

**Query parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `book_ids` | string | **Yes** | Comma-separated UUIDs, max 50 |

```bash
curl "http://api.service.net:30000/inven/stock/bulk?book_ids=\
00000000-0000-0000-0000-000000000001,\
00000000-0000-0000-0000-000000000002"
```

**Response (200):**
```json
[
  {
    "book_id": "00000000-0000-0000-0000-000000000001",
    "quantity": 50,
    "reserved": 5,
    "available": 45,
    "updated_at": "2026-03-02T14:30:00Z"
  },
  {
    "book_id": "00000000-0000-0000-0000-000000000002",
    "quantity": 30,
    "reserved": 0,
    "available": 30,
    "updated_at": "2026-03-01T09:00:00Z"
  }
]
```

**Edge cases:**
- Unknown UUID → silently omitted from response
- Invalid UUID string → silently skipped
- Empty input → `[]`

---

#### `GET /stock/{book_id}`

Stock level for a single book.

```bash
curl "http://api.service.net:30000/inven/stock/00000000-0000-0000-0000-000000000001"
```

**Response (200):**
```json
{
  "book_id": "00000000-0000-0000-0000-000000000001",
  "quantity": 50,
  "reserved": 5,
  "available": 45,
  "updated_at": "2026-03-02T14:30:00Z"
}
```

**Responses:**
- `200` — Stock data
- `404` — `{"detail":"Book not found in inventory"}`

---

### Tag: reserve — Internal mTLS only

#### `POST /stock/reserve`

**Not accessible from outside the cluster.** Blocked at the Gateway HTTPRoute level.

This endpoint is documented here for completeness. It is called by `ecom-service` during checkout via mutual TLS.

**Request body:**
```json
{
  "book_id": "00000000-0000-0000-0000-000000000001",
  "quantity": 2
}
```

**Responses:**
- `200` — `{"book_id":"...","quantity_reserved":2,"remaining_available":43}`
- `409` — Insufficient stock
- `404` — Book not found

---

### Tag: health

#### `GET /health`

```bash
curl "http://api.service.net:30000/inven/health"
# → {"status":"ok"}
```

---

## Stock Status Field Reference

The `available` field drives all UI stock display logic:

| `available` | Badge | Button |
|-------------|-------|--------|
| `0` | 🔴 **Out of Stock** | Disabled |
| `1–3` | 🟠 **Only X left** | Enabled |
| `≥ 4` | 🟢 **In Stock** | Enabled |
| Service unreachable | *(no badge shown)* | Enabled (fail-open) |

Formula: `available = quantity - reserved`

---

## Common Error Responses

All errors from the E-Commerce Service use Spring's `ProblemDetail` format (RFC 7807):

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "detail": "Book not found",
  "instance": "/books/00000000-0000-0000-0000-999999999999"
}
```

Inventory Service errors use FastAPI's default format:

```json
{
  "detail": "Book not found in inventory"
}
```

---

## Rate Limiting

The E-Commerce Service applies rate limiting via **Bucket4j + Redis** on state-changing endpoints (cart and checkout). Defaults: 100 requests / 60 seconds per authenticated user. Exceeded requests return `429 Too Many Requests`.

---

## Kafka Events (CDC pipeline — not REST)

These are published to Kafka asynchronously and are NOT REST endpoints:

### `order.created` (published by E-Commerce Service on checkout)
```json
{
  "orderId": "f7e6d5c4-...",
  "userId": "9d82bcb3-...",
  "items": [
    {"bookId": "00000000-...", "quantity": 2, "price": 14.99}
  ],
  "total": 29.98,
  "timestamp": "2026-03-02T14:30:00Z"
}
```

### `inventory.updated` (published by Inventory Service after stock deduction)
```json
{
  "bookId": "00000000-...",
  "previousQuantity": 50,
  "newQuantity": 48,
  "orderId": "f7e6d5c4-...",
  "timestamp": "2026-03-02T14:30:01Z"
}
```

---

## Admin API (Session 21)

Requires `admin` Keycloak realm role. Customer tokens receive `403 Forbidden`.

### Get admin token (curl)

```bash
TOKEN=$(curl -s -X POST \
  "http://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=ui-client&username=admin1&password=CHANGE_ME" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
```

### E-Commerce Admin — Books (`/ecom/admin/books`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/books` | List all books (paginated) |
| GET | `/admin/books/{id}` | Get single book |
| POST | `/admin/books` | Create book → `201 Created` |
| PUT | `/admin/books/{id}` | Update book → `200 OK` |
| DELETE | `/admin/books/{id}` | Delete book → `204 No Content` |

**Create book example:**
```bash
curl -X POST "http://api.service.net:30000/ecom/admin/books" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"New Title","author":"Author","price":12.99,"genre":"Fiction"}'
```

### E-Commerce Admin — Orders (`/ecom/admin/orders`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/orders` | List all orders (all users, paginated) |
| GET | `/admin/orders/{id}` | Get order with items |

### Inventory Admin — Stock (`/inven/admin/stock`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/stock` | List all stock entries |
| PUT | `/admin/stock/{book_id}` | Set absolute quantity (resets reserved=0) |
| POST | `/admin/stock/{book_id}/adjust` | Adjust by delta (+/-) |

**Set quantity example:**
```bash
curl -X PUT "http://api.service.net:30000/inven/admin/stock/00000000-0000-0000-0000-000000000001" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"quantity": 100}'
```

**Adjust by delta example:**
```bash
curl -X POST "http://api.service.net:30000/inven/admin/stock/00000000-0000-0000-0000-000000000001/adjust" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"delta": -5}'
```

---

## URL Quick Reference

| Resource | URL |
|----------|-----|
| **Swagger UI — E-Commerce** | `http://api.service.net:30000/ecom/swagger-ui/index.html` |
| **Swagger UI — Inventory** | `http://api.service.net:30000/inven/docs` |
| **ReDoc — Inventory** | `http://api.service.net:30000/inven/redoc` |
| **OpenAPI JSON — E-Commerce** | `http://api.service.net:30000/ecom/v3/api-docs` |
| **OpenAPI JSON — Inventory** | `http://api.service.net:30000/inven/openapi.json` |
| **UI** | `http://localhost:30000` |
| **Keycloak Admin (gateway)** | `http://idp.keycloak.net:30000/admin` |
| **Keycloak Admin (direct)** | `http://localhost:32400/admin` (after fresh bootstrap) |
| **PgAdmin** | `http://localhost:31111` |
| **Superset** | `http://localhost:32000` |
| **Flink UI** | `http://localhost:32200` |
| **Debezium REST** | `http://localhost:32300` |
| **Kiali** | `http://localhost:32100/kiali` |
