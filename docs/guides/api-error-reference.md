# API Error Reference

Complete error code reference for the BookStore platform APIs.

## Common Headers

### Idempotency-Key (Session 34)

The `POST /ecom/checkout` endpoint accepts an optional `Idempotency-Key` header to prevent duplicate orders (e.g., from double-clicks or retries).

| Header | Type | Required | Description |
|--------|------|----------|-------------|
| `Idempotency-Key` | `string` (max 64 chars) | No | Unique key per checkout attempt. If an order already exists with this key, the existing order is returned (HTTP 200) instead of creating a duplicate. |

**Behavior:**
- Key present + order exists → returns existing order (HTTP 200, no side effects)
- Key present + no order → creates new order with key
- Key absent → creates order without idempotency (backward compatible)

**Recommended usage:** Generate a UUID client-side (`crypto.randomUUID()`) and attach it to the checkout request. Retry with the same key on network errors.

---

## E-Commerce Service (Spring Boot)

Base URL: `https://api.service.net:30000/ecom`

Response format: [RFC 7807 Problem Detail](https://datatracker.ietf.org/doc/html/rfc7807)

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "Human-readable error description"
}
```

### Error Codes

| Status | Title | When | Retry? | Example Detail |
|--------|-------|------|--------|----------------|
| 400 | Bad Request | Business rule violation | No | `"Cannot checkout: cart is empty"` |
| 400 | Bad Request | Validation failure | No (fix input) | `"quantity: must be greater than 0; bookId: must not be null"` |
| 401 | Unauthorized | Missing or invalid JWT | No (re-authenticate) | Spring Security default |
| 403 | Forbidden | Insufficient role | No | Spring Security default |
| 404 | Not Found | Resource does not exist | No | `"Book not found: <uuid>"` |
| 409 | Conflict | Insufficient stock during checkout | After stock replenishment | `"Insufficient stock: available=2 requested=5"` |
| 422 | Unprocessable Entity | Empty cart on checkout | No (add items first) | `"Cart is empty"` |
| 429 | Too Many Requests | Rate limit exceeded | Yes (after delay) | Bucket4j rate limit response |
| 503 | Service Unavailable | Inventory service unreachable | Yes (with backoff) | Circuit breaker open |

### Endpoints

| Method | Path | Auth | Rate Limit | Notes |
|--------|------|------|------------|-------|
| `GET` | `/books` | Public | 200/min | Book catalog |
| `GET` | `/books/search?q=` | Public | 200/min | Search by title/author |
| `GET` | `/books/{id}` | Public | 200/min | Single book |
| `GET` | `/cart` | JWT | 60/min | User's cart |
| `POST` | `/cart` | JWT | 60/min | Add to cart |
| `DELETE` | `/cart/{itemId}` | JWT | 60/min | Remove from cart |
| `POST` | `/checkout` | JWT | 10/min | Place order (supports `Idempotency-Key`) |
| `GET` | `/admin/orders` | JWT + admin | 30/min | All orders (paginated) |
| `GET` | `/admin/books` | JWT + admin | 30/min | Book management |

---

## Inventory Service (FastAPI)

Base URL: `https://api.service.net:30000/inven`

Response format: Simple JSON

```json
{
  "detail": "Human-readable error description"
}
```

### Error Codes

| Status | When | Retry? | Example Detail |
|--------|------|--------|----------------|
| 400 | Invalid adjustment would cause negative stock | No (fix input) | `"Adjustment would result in negative quantity: current=5 delta=-10"` |
| 401 | Invalid or expired JWT | No (re-authenticate) | `"Invalid or expired token"` |
| 403 | Missing required role | No | `"Role 'admin' required"` |
| 404 | Book not in inventory | No | `"Book not found in inventory"` |
| 409 | Insufficient stock for reservation | After stock replenishment | `"Insufficient stock: available=2 requested=5"` |
| 422 | Request body validation failure | No (fix input) | FastAPI auto-generated validation error |
| 503 | Database unreachable | Yes (with backoff) | `"not ready"` (health endpoint) |

### Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET` | `/health` | Public | Liveness probe |
| `GET` | `/health/ready` | Public | Readiness probe (checks DB) |
| `GET` | `/stock/{book_id}` | Public | Stock level for a book |
| `GET` | `/stock/bulk?book_ids=` | Public | Bulk stock check |
| `POST` | `/stock/reserve` | mTLS (ecom-service only) | Reserve stock (internal) |
| `GET` | `/admin/stock` | JWT + admin | All stock levels |
| `PUT` | `/admin/stock/{book_id}` | JWT + admin | Set stock level |
| `POST` | `/admin/stock/{book_id}/adjust` | JWT + admin | Adjust stock by delta |
| `GET` | `/admin/dlq` | JWT + admin | DLQ messages |
| `POST` | `/admin/dlq/{msg_id}/retry` | JWT + admin | Retry DLQ message |

---

## Validation Error Format (422)

### FastAPI (Inventory Service)

```json
{
  "detail": [
    {
      "type": "missing",
      "loc": ["body", "book_id"],
      "msg": "Field required",
      "input": {}
    }
  ]
}
```

### Spring Boot (E-Commerce Service)

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "bookId: must not be null; quantity: must be greater than 0"
}
```
