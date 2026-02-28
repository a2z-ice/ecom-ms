# Session 04 — E-Commerce Service (Spring Boot)

**Goal:** Fully functional Spring Boot service with JWT-secured REST APIs, Liquibase-managed DB, and Kafka producer.

## Deliverables

- `ecom-service/` — Spring Boot 4.0.3 project (Maven)
  - `src/main/resources/db/changelog/` — Liquibase changelogs:
    - `books` table (id, title, author, price, description, cover_url)
    - `cart_items` table (id, user_id, book_id, quantity)
    - `orders` table (id, user_id, total, status, created_at)
    - `order_items` table (id, order_id, book_id, quantity, price)
    - Seed data: 10 books
  - `application.yml` — all values from env vars (no hardcoded config)
  - Spring Security: `SecurityFilterChain` as OIDC Resource Server, Keycloak JWKS URI from env
  - REST controllers: `BookController`, `CartController`, `OrderController`
  - Kafka producer: publishes `order.created` event on `POST /checkout`
  - Rate limiting via Bucket4j + Redis
  - `GlobalExceptionHandler` (`@RestControllerAdvice`) returns `ProblemDetail` for `ResourceNotFoundException`, `BusinessException`, `MethodArgumentNotValidException`
- `ecom-service/Dockerfile` — multi-stage, non-root, minimal JRE image
- `ecom-service/k8s/` — Deployment, Service, ConfigMap, Secret
  - Liquibase runs as init container before app starts

## API Contract

```
GET  /ecom/books                 → public, no auth
GET  /ecom/books/search?q=...    → public, no auth
GET  /ecom/books/{id}            → public, no auth
GET  /ecom/cart                  → requires JWT (role: customer)
POST /ecom/cart                  → requires JWT (role: customer)
POST /ecom/checkout              → requires JWT (role: customer)
```

## Event Schema — `order.created`

```json
{
  "orderId": "uuid",
  "userId": "string",
  "items": [{ "bookId": "uuid", "quantity": 2, "price": 19.99 }],
  "total": 39.98,
  "timestamp": "ISO-8601"
}
```

## Spring Boot 4.0 Known Issues (Already Fixed)

1. `KafkaTemplate<String, Object>` injection fails with autoconfigured `KafkaTemplate<?,?>` — fix: explicit `KafkaConfig.java` `@Bean`
2. Hibernate validation runs BEFORE Liquibase — fix: `spring.jpa.hibernate.ddl-auto: none` + explicit `LiquibaseConfig.java` `@Bean("liquibase")`
3. Actuator health subpaths: use `/actuator/health/**` pattern (not `/actuator/health`)
4. `readOnlyRootFilesystem` + Tomcat needs writable `/tmp` — fix: `emptyDir` volume at `/tmp`
5. Jackson 3.x rename: `com.fasterxml.jackson` → `tools.jackson`; use `Jackson3JsonSerializer.java`

## Acceptance Criteria

- [x] `GET /ecom/books` returns book list (no auth required)
- [x] `POST /ecom/checkout` with valid JWT publishes event to `order.created` topic
- [x] Liquibase migrations run automatically on pod start
- [x] Invalid JWT returns 401; missing role returns 403
- [x] Pod runs as non-root

## Status: Complete ✓
