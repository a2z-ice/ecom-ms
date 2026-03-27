# CSRF Architecture Deep Dive

## Table of Contents

1. [Is CSRF a Real Threat in This Architecture?](#1-is-csrf-a-real-threat-in-this-architecture)
2. [Why This Project Implements CSRF Despite Bearer Tokens](#2-why-this-project-implements-csrf-despite-bearer-tokens)
3. [How CSRF Works in This Project — End-to-End](#3-how-csrf-works-in-this-project--end-to-end)
4. [Token Lifecycle](#4-token-lifecycle)
5. [Token Generation](#5-token-generation)
6. [Token Storage in Redis](#6-token-storage-in-redis)
7. [Token Validation](#7-token-validation)
8. [Token Expiration and Refresh](#8-token-expiration-and-refresh)
9. [Istio ext_authz Integration — Gateway-Level Enforcement](#9-istio-ext_authz-integration--gateway-level-enforcement)
10. [UI Integration — React Client](#10-ui-integration--react-client)
11. [Fail-Open Design — Graceful Degradation](#11-fail-open-design--graceful-degradation)
12. [Comparison with Standard CSRF Implementations](#12-comparison-with-standard-csrf-implementations)
13. [Security Properties Analysis](#13-security-properties-analysis)
14. [Kubernetes Production Configuration](#14-kubernetes-production-configuration)
15. [Observability and Metrics](#15-observability-and-metrics)
16. [Test Coverage](#16-test-coverage)
17. [Known Limitations and Trade-offs](#17-known-limitations-and-trade-offs)
18. [Request Flow Diagrams](#18-request-flow-diagrams)

---

## 1. Is CSRF a Real Threat in This Architecture?

### The Short Answer

**No.** Traditional CSRF is not a meaningful threat when authentication uses `Authorization: Bearer <JWT>` headers with tokens stored exclusively in JavaScript memory.

### Why Traditional CSRF Exists

CSRF (Cross-Site Request Forgery) exploits a fundamental browser behavior: **cookies are automatically attached to every request to a domain**, regardless of which site initiated the request. A malicious page at `evil.com` can submit a form or trigger a fetch to `api.service.net`, and the browser will dutifully send the victim's session cookie along with the request. The server sees a valid cookie and executes the action, never knowing it was forged.

The three conditions required for a CSRF attack are:

1. **Automatic credential attachment** — the browser sends credentials (cookies) without JavaScript involvement
2. **Cross-origin request capability** — the attacker's page can trigger requests to the target
3. **Predictable request structure** — the attacker knows what parameters to send

### Why This Architecture Is Immune

In this project, **condition #1 is broken by design**:

- JWTs are stored in JavaScript memory (`InMemoryWebStorage` via `oidc-client-ts`), never in cookies or `localStorage`
- Every API request requires explicit JavaScript code to read the token and attach it as an `Authorization: Bearer <token>` header
- A malicious page at `evil.com` cannot access the in-memory variables of `myecom.net` (Same-Origin Policy prevents this)
- Even if the attacker submits a form or uses `<img src="...">` to trigger a request, no `Authorization` header is attached — the request arrives unauthenticated and is rejected with 401

```
evil.com → POST api.service.net/ecom/cart
  ❌ No cookies to send (not using cookie auth)
  ❌ No Authorization header (can't access myecom.net's JS memory)
  → Server returns 401 Unauthorized
  → Attack fails completely
```

This is not a novel defense. Bearer token authentication is widely recognized as inherently CSRF-resistant. The OWASP CSRF Prevention Cheat Sheet explicitly states:

> *"If your application uses REST APIs with JWT in the Authorization header (not cookies), CSRF is not a concern because the browser does not automatically send the header."*

### What Could Re-Introduce CSRF Risk

The architecture would become vulnerable only if:

1. **Cookies were added for authentication** — e.g., storing the JWT or session ID in a cookie (even with `HttpOnly; SameSite=Lax`, `SameSite` can be bypassed in some edge cases with older browsers or subdomain attacks)
2. **Token storage moved to localStorage** — while localStorage itself doesn't enable CSRF (it requires JS to read), it opens XSS-to-CSRF attack chains where an XSS vulnerability steals the token
3. **A proxy or middleware silently converts headers to cookies** — some API gateways offer "cookie-to-header" translation that could introduce ambient credentials

None of these conditions exist today.

---

## 2. Why This Project Implements CSRF Despite Bearer Tokens

Given that traditional CSRF is not a threat, the CSRF service exists as a **defense-in-depth** measure. Here is the rationale:

### 2.1 Defense Against Future Regressions

Software evolves. A future developer might:
- Add cookie-based session management for a new feature
- Integrate a third-party OAuth library that uses cookies
- Add a "remember me" feature using persistent cookies

The gateway-level CSRF enforcement acts as a safety net that catches these regressions before they become exploitable.

### 2.2 Request Origin Verification

Even without cookie-based CSRF risk, the CSRF token serves as proof that the request originated from the application's own UI. This defends against:

- **Token replay attacks**: If a JWT is leaked (e.g., via a logs aggregator or referer header), the attacker also needs a valid CSRF token bound to that JWT's `sub` claim
- **Stolen JWT usage**: A CSRF token tied to the user's identity adds a second factor that an attacker must obtain independently

### 2.3 Compliance and Audit Requirements

Security audits and compliance frameworks (SOC 2, PCI-DSS, ISO 27001) often require CSRF protection as a checkbox item regardless of the authentication mechanism. Having a documented, tested, and deployed CSRF layer satisfies these requirements without debate.

### 2.4 Gateway-Level Enforcement Is Language-Agnostic

Because CSRF validation happens at the Istio gateway (via ext_authz), every backend service — Java, Python, Go, or any future addition — is automatically protected without implementing CSRF logic in each service. This is a significant architectural advantage over per-service CSRF middleware.

---

## 3. How CSRF Works in This Project — End-to-End

### Architecture Overview

```
┌──────────────┐     ┌─────────────────────────┐     ┌───────────────────┐
│              │     │   Istio Gateway (Envoy)  │     │                   │
│   Browser    │────▶│                          │────▶│  Backend Service  │
│   (React)    │     │  ┌─────────────────────┐ │     │  (ecom / inven)   │
│              │     │  │ ext_authz (CUSTOM)   │ │     │                   │
│  In-memory:  │     │  │                     │ │     │                   │
│  - JWT       │     │  │ ┌─────────────────┐ │ │     │                   │
│  - CSRF token│     │  │ │  csrf-service   │ │ │     │                   │
│              │     │  │ │  (Go, port 8080)│ │ │     │                   │
│              │     │  │ │                 │ │ │     │                   │
│              │     │  │ │ ┌─────────────┐ │ │ │     │                   │
│              │     │  │ │ │    Redis     │ │ │ │     │                   │
│              │     │  │ │ │  csrf:<sub>  │ │ │ │     │                   │
│              │     │  │ │ └─────────────┘ │ │ │     │                   │
│              │     │  │ └─────────────────┘ │ │     │                   │
│              │     │  └─────────────────────┘ │     │                   │
└──────────────┘     └─────────────────────────┘     └───────────────────┘
```

### The Pattern: Server-Side Token with Custom Header

This implementation follows the **Synchronizer Token Pattern** (also called "stateful CSRF"), adapted for a microservices context:

1. Server generates a token and stores it in Redis, keyed by user identity
2. Server returns the token to the client
3. Client sends the token in a custom header (`X-CSRF-Token`) on mutating requests
4. Gateway intercepts the request and validates the token before forwarding

This is NOT the Double Submit Cookie pattern (which stores tokens in both a cookie and a header). There are no cookies involved at any point.

---

## 4. Token Lifecycle

```
┌─────────────┐   GET /csrf/token   ┌──────────────┐   SET csrf:<sub>   ┌─────────┐
│   Browser   │──────────────────▶  │ csrf-service │──────────────────▶ │  Redis  │
│             │◀──────────────────  │              │                    │         │
│             │   { token: uuid }   │              │                    │         │
└─────────────┘                     └──────────────┘                    └─────────┘
      │
      │  POST /ecom/cart
      │  Authorization: Bearer <jwt>
      │  X-CSRF-Token: <uuid>
      ▼
┌─────────────┐                     ┌──────────────┐   GET csrf:<sub>   ┌─────────┐
│   Gateway   │──── ext_authz ────▶ │ csrf-service │──────────────────▶ │  Redis  │
│   (Envoy)   │◀──────────────────  │              │◀──────────────────  │         │
│             │   200 OK / 403      │              │   <stored token>   │         │
└─────────────┘                     └──────────────┘                    └─────────┘
      │
      │ (if 200)
      ▼
┌─────────────┐
│   Backend   │
│   Service   │
└─────────────┘
```

### Lifecycle States

| State | Trigger | Redis Key | TTL |
|-------|---------|-----------|-----|
| **Not Created** | User not authenticated | — | — |
| **Generated** | `GET /csrf/token` with valid JWT | `csrf:<sub>` = `<uuid>` | 10 minutes |
| **Validated + Refreshed** | Successful ext_authz check or authenticated safe method (sliding TTL) | `csrf:<sub>` (same value) | 10 minutes (reset) |
| **Expired** | 10 minutes without any authenticated request | Key deleted by Redis | — |
| **Regenerated** | Another `GET /csrf/token` call | `csrf:<sub>` = `<new-uuid>` | 10 minutes |

### Key Behaviors

- **One token per user**: Calling `GET /csrf/token` again overwrites the previous token in Redis. The old token immediately becomes invalid.
- **Multi-use tokens**: A token can be used for unlimited mutating requests until it expires or is replaced.
- **Sliding expiration**: Each successful validation or authenticated safe method request (GET/HEAD/OPTIONS) resets the 10-minute TTL via Redis EXPIRE (configurable via `CSRF_SLIDING_TTL`, default: `true`). An active user's token never expires.
- **No grace period**: Once the Redis key expires (TTL reaches 0), the token is gone. The next mutating request will fail with 403.

---

## 5. Token Generation

### Algorithm

Tokens are generated using UUID v4 (RFC 4122), which is based on cryptographically secure random number generation:

```go
// csrf-service/internal/store/redis.go:50-57
func (s *RedisStore) Generate(ctx context.Context, userID string) (string, error) {
    token := uuid.New().String()  // UUID v4: 122 bits of random entropy
    if err := s.client.Set(ctx, keyPrefix+userID, token, s.ttl).Err(); err != nil {
        slog.Warn("Failed to store CSRF token in Redis", "user", userID, "error", err)
        return token, err  // Return token anyway (fail-open)
    }
    return token, nil
}
```

### Token Format

```
550e8400-e29b-41d4-a716-446655440000
└──────────────────────────────────────┘
  36 characters, 32 hex digits + 4 hyphens
  122 bits of cryptographic randomness
  Version 4 (random), variant 1 (RFC 4122)
```

### Entropy Analysis

- **Source**: Go's `crypto/rand` (via `github.com/google/uuid`)
- **Entropy**: 122 bits (6 bits are fixed: 4 version bits + 2 variant bits)
- **Collision probability**: 2^-61 for a birthday collision among 2^61 tokens — effectively impossible
- **Brute-force resistance**: An attacker guessing randomly has a 1 in 5.3 × 10^36 chance per attempt

### Why UUID v4 and Not HMAC-Based Tokens

Many CSRF implementations use HMAC-signed tokens (e.g., Django's `csrf_token` uses `HMAC-SHA256`). This project chose UUID v4 because:

1. **Stateful validation anyway**: Tokens are stored in Redis, so cryptographic binding to user identity is redundant — Redis lookup already establishes the binding
2. **Simpler implementation**: No secret key management, no rotation of signing keys
3. **No information leakage**: UUID v4 reveals nothing about the user, server, or timestamp (unlike HMAC tokens that might leak the message structure)

---

## 6. Token Storage in Redis

### Key Format

```
csrf:<keycloak-sub-claim>
```

Example:
```
csrf:9d82bcb3-6e96-462c-bdb9-e677080e8920
```

### Data Stored

Only the token string is stored as the Redis value. No metadata (timestamp, IP, user agent) is persisted.

```
KEY:   csrf:9d82bcb3-6e96-462c-bdb9-e677080e8920
VALUE: 550e8400-e29b-41d4-a716-446655440000
TTL:   600 seconds (10 minutes)
TYPE:  string
```

### Redis Connection Configuration

```go
// csrf-service/internal/store/redis.go:36-47
redis.NewClient(&redis.Options{
    Addr:         "redis.infra.svc.cluster.local:6379",
    Password:     "<from-k8s-secret>",
    DB:           0,
    DialTimeout:  2 * time.Second,
    ReadTimeout:  1 * time.Second,
    WriteTimeout: 1 * time.Second,
    PoolSize:     10,
    MinIdleConns: 2,
})
```

### Redis Server Configuration

The shared Redis instance (`infra/redis/redis.yaml`) runs with:
- **Maxmemory**: 200MB with `allkeys-lru` eviction policy
- **Persistence**: AOF (appendonly) + RDB snapshots every 60 seconds
- **Connection timeout**: 300 seconds idle, TCP keepalive every 60 seconds

**LRU eviction impact on CSRF**: If Redis reaches 200MB, the `allkeys-lru` policy will evict least-recently-used keys, which could include CSRF tokens. In practice, each CSRF token uses ~100 bytes of Redis memory. Even with 100,000 concurrent users, CSRF tokens would consume only ~10MB — well within limits. The eviction concern is theoretical.

### Shared Redis Instance

CSRF tokens share the same Redis instance with:
- Rate limiting (Bucket4j from ecom-service)
- Session data (if any future feature adds sessions)

The `csrf:` key prefix prevents namespace collisions. No separate Redis database is used (`DB: 0` for all).

---

## 7. Token Validation

### Validation Flow

```go
// csrf-service/internal/store/redis.go:59-76
func (s *RedisStore) Validate(ctx context.Context, userID, token string) (bool, error) {
    stored, err := s.client.Get(ctx, keyPrefix+userID).Result()
    if err != nil {
        if err == redis.Nil {
            return false, nil  // No token stored — invalid
        }
        slog.Warn("Redis error during CSRF validation — failing open", ...)
        return true, err  // Fail-open on Redis errors
    }

    valid := subtle.ConstantTimeCompare([]byte(stored), []byte(token)) == 1
    if valid {
        // Refresh TTL on successful validation (sliding expiration)
        s.client.Expire(ctx, keyPrefix+userID, s.ttl)
    }
    return valid, nil
}
```

### Step-by-Step Validation

1. **Redis GET**: Fetch stored token from `csrf:<sub>`
2. **Key not found** (`redis.Nil`): Return `(false, nil)` — token invalid, no error
3. **Redis error** (connection timeout, etc.): Return `(true, err)` — **fail-open**
4. **Token comparison**: `crypto/subtle.ConstantTimeCompare` — timing-safe
5. **TTL refresh**: On match, reset TTL to 10 minutes from now
6. **Return result**: `(true, nil)` if valid, `(false, nil)` if mismatch

### Timing-Safe Comparison

The comparison uses Go's `crypto/subtle.ConstantTimeCompare`, which executes in constant time regardless of how many characters match. This prevents timing side-channel attacks where an attacker measures response times to guess tokens character by character.

```go
// Always takes the same amount of time, whether 0 or 36 characters match
valid := subtle.ConstantTimeCompare([]byte(stored), []byte(token)) == 1
```

Without this, an attacker could:
1. Send token `aaaa...` and measure 1.2ms response
2. Send token `5aaa...` and measure 1.3ms response (one more character matched)
3. Send token `55aa...` and measure 1.4ms response
4. Repeat until the full 36-character token is guessed

With `ConstantTimeCompare`, every comparison takes identical time, making this attack impossible.

### JWT Subject Extraction (How User Identity Is Determined)

```go
// csrf-service/internal/jwt/extract.go:15-37
func ExtractSub(authHeader string) string {
    if !strings.HasPrefix(authHeader, "Bearer ") {
        return ""
    }
    token := strings.TrimPrefix(authHeader, "Bearer ")
    parts := strings.Split(token, ".")
    if len(parts) != 3 {
        return ""
    }
    payload, err := base64.RawURLEncoding.DecodeString(parts[1])
    if err != nil {
        return ""
    }
    var claims struct {
        Sub string `json:"sub"`
    }
    if err := json.Unmarshal(payload, &claims); err != nil {
        return ""
    }
    return claims.Sub
}
```

**Important**: The csrf-service does NOT verify the JWT signature. It only base64-decodes the payload to extract the `sub` claim. This is safe because:

1. **Istio `RequestAuthentication`** validates the JWT signature against Keycloak's JWKS endpoint *before* the request reaches any service
2. By the time csrf-service sees the request, the JWT is guaranteed authentic by the mesh infrastructure
3. This design keeps the csrf-service stateless (no need to fetch JWKS or manage key rotation)

---

## 8. Token Expiration and Refresh

### Expiration Mechanism

Redis native key expiration handles token lifecycle. When a token is created or refreshed:

```
SETEX csrf:<sub> 600 <token>
```

After 600 seconds (10 minutes) of inactivity, Redis automatically deletes the key. No background jobs, no sweep processes, no application-level expiration checks.

### Sliding Window Behavior

```
Time 0:00  — User logs in, GET /csrf/token → token created, TTL = 10min
Time 5:00  — User browses catalog (GET), sliding TTL refreshes → TTL reset to 10min from now
Time 10:00 — User adds to cart (POST), CSRF validates → TTL reset to 10min from now
Time 15:00 — User checks out (POST), CSRF validates → TTL reset to 10min from now
Time 25:00 — No activity for 10 minutes → Redis deletes key automatically
Time 55:01 — User tries POST → 403 (no token in Redis)
Time 55:02 — UI auto-retries: fetches new token, retries POST → succeeds
```

### Auto-Recovery in the UI

The React client handles token expiration transparently:

```typescript
// ui/src/api/client.ts:58-62
// Auto-retry on 403 for mutating requests — CSRF token may have expired
if (resp.status === 403 && isMutating && !_csrfRetried) {
    await fetchCsrfToken()           // Get new token from csrf-service
    return request<T>(url, options, true)  // Retry original request (once)
}
```

This means token expiration is invisible to the user in most cases. The only scenario where the user sees a failure is if the retry also fails (e.g., Redis is down and fail-open is somehow disabled, or the JWT itself has expired).

### Comparison with Common TTL Strategies

| Strategy | This Project | Django CSRF | Spring Security CSRF |
|----------|-------------|-------------|---------------------|
| **TTL** | 10 minutes (sliding) | Session lifetime (days/weeks) | Session lifetime |
| **Refresh** | On each successful validation | On page load (new token per form) | Per-session |
| **Multi-use** | Yes | Yes (per-session token) | Yes (per-session token) |
| **Storage** | Redis | Database/signed cookie | HTTP session (server-side) |
| **Auto-recovery** | UI retries on 403 | User refreshes page | User refreshes page |

The 10-minute sliding TTL is more aggressive than most frameworks, which typically tie CSRF tokens to the session lifetime. This is a deliberate trade-off: shorter TTL reduces the window of exposure if a token leaks, at the cost of more frequent token generation. Additionally, sliding TTL now extends to authenticated safe method requests (GET/HEAD/OPTIONS), so browsing activity keeps the token alive without requiring mutations.

---

## 9. Istio ext_authz Integration — Gateway-Level Enforcement

### How It Works

The CSRF service is registered as an Istio **external authorization provider** (ext_authz). Every request passing through the Istio gateway is intercepted and sent to csrf-service for a decision before being forwarded to the backend.

### Configuration Chain

**Step 1: Extension Provider Registration** (Istio mesh config)

```yaml
extensionProviders:
- name: csrf-ext-authz
  envoyExtAuthzHttp:
    service: csrf-service.infra.svc.cluster.local
    port: 8080
    failOpen: true
    headersToUpstreamOnAllow: []
    includeRequestHeadersInCheck:
      - authorization
      - x-csrf-token
```

- `failOpen: true`: If csrf-service is unreachable, allow the request through (Envoy-level fail-open, in addition to the application-level fail-open in the Go code)
- `includeRequestHeadersInCheck`: Only these two headers are forwarded to csrf-service — no body, no other headers
- `headersToUpstreamOnAllow: []`: csrf-service does not inject headers into the upstream request

**Step 2: AuthorizationPolicy** (`infra/istio/csrf-envoy-filter.yaml`)

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: csrf-ext-authz
  namespace: infra
spec:
  targetRefs:
    - kind: Gateway
      group: gateway.networking.k8s.io
      name: bookstore-gateway
  action: CUSTOM
  provider:
    name: csrf-ext-authz
  rules:
    - {}   # Applies to ALL requests through the gateway
```

- `action: CUSTOM`: Delegates the authorization decision to the named extension provider
- `rules: [{}]`: Empty rule matches everything — all requests are checked
- `targetRefs`: Only applies to the `bookstore-gateway` Gateway resource (not to service-to-service traffic)

**Step 3: HTTPRoute for Token Generation** (`infra/kgateway/routes/csrf-route.yaml`)

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: csrf-route
  namespace: infra
spec:
  parentRefs:
    - name: bookstore-gateway
      namespace: infra
      sectionName: https
  hostnames:
    - "api.service.net"
  rules:
    - matches:
        - path:
            type: Exact
            value: /csrf/token
      backendRefs:
        - name: csrf-service
          port: 8080
```

This exposes `GET /csrf/token` as a public-facing endpoint for the UI to fetch tokens.

### Request Processing Order

For every request through the gateway:

```
1. TLS termination (Envoy decrypts HTTPS)
2. Istio RequestAuthentication (JWT signature validation against Keycloak JWKS)
3. Istio AuthorizationPolicy CUSTOM (ext_authz → csrf-service)
   └── csrf-service decision: 200 (allow) or 403 (deny)
4. Istio AuthorizationPolicy ALLOW/DENY (other policies)
5. HTTPRoute matching (forward to backend)
```

CSRF validation happens AFTER JWT validation but BEFORE the request reaches any backend service.

### What ext_authz Sees

The csrf-service receives a synthesized HTTP request from Envoy with only the headers listed in `includeRequestHeadersInCheck`:

```http
GET / HTTP/1.1
:method: POST                          ← Original HTTP method
:path: /ecom/cart                      ← Original path
Authorization: Bearer eyJhbGc...       ← Forwarded header
X-Csrf-Token: 550e8400-e29b-...       ← Forwarded header
```

The csrf-service inspects `:method` to determine if the request is safe or mutating.

---

## 10. UI Integration — React Client

### Token Storage

CSRF tokens are stored in a module-level variable in `ui/src/api/client.ts`:

```typescript
let _csrfToken: string | null = null
```

This is in-memory storage — the token is lost on page refresh, tab close, or navigation away. This is intentional: it mirrors the JWT storage pattern (also in-memory via `InMemoryWebStorage`) and ensures no persistent state leaks to disk.

### Token Fetch

Token fetching is triggered by two events:

**1. After OIDC callback** (`ui/src/pages/CallbackPage.tsx`):
```typescript
const csrfResp = await fetch('/csrf/token', {
    headers: { Authorization: `Bearer ${user.access_token}` },
})
if (csrfResp.ok) {
    const csrfData = await csrfResp.json()
    csrfToken = csrfData.token
    setCsrfToken(csrfToken)
}
```

This fetches the token early so that the guest cart merge (which uses POST) can include it.

**2. After authentication state is established** (`ui/src/App.tsx`):
```typescript
useEffect(() => {
    if (user) {
        fetchCsrfToken().catch(err => console.warn('CSRF token fetch failed:', err))
    }
}, [user])
```

This handles the case where the user was already authenticated (e.g., token refresh) and ensures the CSRF token is available.

### Token Attachment

The API client automatically attaches the CSRF token to mutating requests:

```typescript
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])

const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(isMutating && _csrfToken ? { 'X-CSRF-Token': _csrfToken } : {}),
}
```

GET, HEAD, OPTIONS, and TRACE requests never include `X-CSRF-Token`.

### Auto-Retry on 403

```typescript
if (resp.status === 403 && isMutating && !_csrfRetried) {
    await fetchCsrfToken()
    return request<T>(url, options, true)  // _csrfRetried = true prevents infinite loop
}
```

The retry happens at most once. If the retry also fails with 403, the error propagates to the caller. This prevents infinite loops if the 403 is caused by something other than an expired CSRF token (e.g., an authorization issue in the backend).

---

## 11. Fail-Open Design — Graceful Degradation

The CSRF service implements fail-open at two levels:

### Level 1: Application-Level (Go Code)

```go
// Token generation: return token even if Redis write fails
func (s *RedisStore) Generate(...) (string, error) {
    token := uuid.New().String()
    if err := s.client.Set(...).Err(); err != nil {
        return token, err  // Token returned, error also returned
    }
    return token, nil
}

// Token validation: return true on Redis errors
func (s *RedisStore) Validate(...) (bool, error) {
    stored, err := s.client.Get(...).Result()
    if err != nil {
        if err == redis.Nil {
            return false, nil  // ← NOT fail-open (token genuinely missing)
        }
        return true, err  // ← Fail-open on connection/timeout errors
    }
    // ...
}
```

- `redis.Nil` (key not found): This is a legitimate validation failure, NOT a Redis error. Returns `false` — the token is genuinely invalid or expired.
- Any other error (connection refused, timeout, auth failure): This is infrastructure failure. Returns `true` — fail-open to avoid blocking legitimate traffic.

### Level 2: Istio-Level (Envoy Configuration)

```yaml
envoyExtAuthzHttp:
    failOpen: true
```

If the csrf-service pods are all down (not just Redis), Envoy allows the request through. This prevents a CSRF infrastructure outage from taking down the entire platform.

### Rationale

The fail-open design is justified because:

1. **JWT is the primary defense**: Every request is authenticated by JWT, which is validated by Istio `RequestAuthentication` (separate from the ext_authz flow). Even if CSRF validation is skipped, the request is still authenticated.
2. **CSRF is defense-in-depth**: As established in Section 1, CSRF is not a meaningful attack vector in this architecture. The CSRF layer adds value but is not load-bearing for security.
3. **Availability over perfect security**: A Redis outage should not cascade into a complete service outage for all users. The risk of allowing a few unauthenticated requests (which JWT still blocks) is far lower than the cost of a full outage.

### Metrics for Monitoring Fail-Open Events

```
csrf_requests_total{method="authz_mutate", result="redis_error_failopen"}
csrf_redis_errors_total
```

These Prometheus metrics allow operators to detect when fail-open is being triggered and investigate the underlying Redis issue.

---

## 12. Comparison with Standard CSRF Implementations

### Pattern Classification

| Pattern | Description | Used Here? |
|---------|-------------|-----------|
| **Synchronizer Token** | Server generates token, stores it server-side, validates on each request | **Yes** (Redis-backed) |
| **Double Submit Cookie** | Token in both a cookie and a header; server compares the two | No (no cookies at all) |
| **SameSite Cookie** | Browser attribute that restricts cookie sending on cross-origin requests | No (no cookies at all) |
| **Origin Header Check** | Server validates `Origin` or `Referer` header matches expected domain | No (handled by CORS instead) |
| **Custom Request Headers** | Require a header that cannot be set by HTML forms (e.g., `X-Requested-With`) | Partially (the `X-CSRF-Token` header serves this role) |
| **Encrypted Token** | Token contains encrypted user data; server decrypts to validate | No (stateful validation via Redis instead) |

### Comparison with Django's CSRF

| Aspect | This Project | Django |
|--------|-------------|--------|
| Token generation | UUID v4 (122 bits) | 64-char hex (256 bits), HMAC-SHA256 signed |
| Token storage (server) | Redis with 10min TTL | Not stored — validated via HMAC signature |
| Token storage (client) | In-memory JS variable | `csrftoken` cookie + hidden form field |
| Token delivery | JSON response from API | Set-Cookie header + template tag |
| Token submission | `X-CSRF-Token` custom header | `csrfmiddlewaretoken` POST field or `X-CSRFToken` header |
| Scope | Per-user (one token per user) | Per-session (rotated per login) |
| Validation | Redis lookup + constant-time compare | HMAC verification (stateless) |
| Multi-use | Yes (sliding TTL) | Yes (per-session) |
| Safe methods | GET, HEAD, OPTIONS, TRACE | GET, HEAD, OPTIONS, TRACE |

### Comparison with Spring Security's CSRF

| Aspect | This Project | Spring Security |
|--------|-------------|----------------|
| Token generation | UUID v4 | UUID (via `CsrfTokenRepository`) |
| Token storage | Redis (centralized) | HTTP Session (per-server or session store) |
| Validation | Gateway-level (all services) | Per-application filter chain |
| Enforcement | Istio ext_authz | `CsrfFilter` in `SecurityFilterChain` |
| SPA support | Yes (API-first design) | Requires `CookieCsrfTokenRepository` config |
| Fail-open | Yes (Redis errors) | No (hard failure on session errors) |

### Compliance with OWASP CSRF Prevention Cheat Sheet

| OWASP Recommendation | Compliance | Notes |
|----------------------|-----------|-------|
| Use Synchronizer Token Pattern | ✅ | Server-side token in Redis |
| Tokens must be unique per user session | ✅ | One token per `sub` claim |
| Tokens must be unpredictable | ✅ | UUID v4, 122 bits entropy |
| Tokens must be validated on the server | ✅ | Redis lookup in csrf-service |
| Use constant-time comparison | ✅ | `crypto/subtle.ConstantTimeCompare` |
| Protect all mutating operations | ✅ | POST, PUT, DELETE, PATCH |
| Allow safe methods without token | ✅ | GET, HEAD, OPTIONS, TRACE |
| Do not transmit tokens in URLs | ✅ | Custom header only |
| Consider using SameSite cookies | N/A | No cookies used |

---

## 13. Security Properties Analysis

### What the CSRF Layer Defends Against

1. **JWT replay with stolen tokens**: If an attacker obtains a JWT (from logs, network capture, etc.), they also need the CSRF token to perform mutations. The CSRF token is never logged (it exists only in Redis and the request header).

2. **Unauthorized automation**: Scripts or tools that have a valid JWT but did not obtain a CSRF token through the intended UI flow will be blocked on mutating requests.

3. **Future cookie-based auth regressions**: If a developer adds cookie-based authentication, CSRF protection is already in place.

### What the CSRF Layer Does NOT Defend Against

1. **XSS (Cross-Site Scripting)**: If an attacker can execute JavaScript in the application's origin, they can read the in-memory CSRF token, read the in-memory JWT, and make authenticated+CSRF-valid requests. CSRF protection does not mitigate XSS. The project addresses XSS through CSP headers, input sanitization, and React's built-in escaping.

2. **Server-side request forgery (SSRF)**: Internal service-to-service requests bypass the gateway and therefore bypass CSRF. This is by design — mTLS provides the authentication layer for internal traffic.

3. **JWT theft via XSS**: If the JWT is stolen via XSS, the attacker can also steal the CSRF token from the same in-memory variable. CSRF adds no value in an XSS scenario.

### Token Isolation Between Users

Tokens are bound to the JWT `sub` claim (Keycloak user ID). The E2E tests explicitly verify that user1's CSRF token cannot be used by admin1:

```typescript
// e2e/csrf.spec.ts — "user1 CSRF token cannot be used by admin1"
// Obtains CSRF token for user1, then tries to use it with admin1's JWT → 403
```

This prevents token-sharing attacks where one authenticated user tries to use another user's CSRF token.

---

## 14. Kubernetes Production Configuration

### Deployment Topology

```
infra namespace
├── csrf-service (Deployment: 2 replicas, HPA: 2-5)
│   ├── Pod 1: csrf-service container (65532:65532, distroless)
│   └── Pod 2: csrf-service container (65532:65532, distroless)
├── csrf-service (Service: ClusterIP, port 8080)
├── csrf-service-pdb (PDB: minAvailable 1)
└── csrf-service (HPA: CPU 70%, 2-5 replicas)
```

### Resource Allocation

| Resource | Request | Limit |
|----------|---------|-------|
| CPU | 50m | 200m |
| Memory | 32Mi | 64Mi |

The csrf-service is extremely lightweight — it's a stateless Go binary that makes Redis lookups. 32Mi memory is sufficient for the binary plus connection pool overhead.

### High Availability

- **Replicas**: Minimum 2 (via HPA `minReplicas`)
- **PDB**: At least 1 pod always available during voluntary disruptions
- **Rolling updates**: `maxSurge: 1, maxUnavailable: 0` (zero-downtime deployments)
- **Pre-stop hook**: `sleep 5` allows in-flight requests to complete before pod termination
- **Graceful shutdown**: Go server drains connections for 10 seconds on SIGTERM

### Security Hardening

```yaml
# Pod-level
securityContext:
  runAsNonRoot: true
  runAsUser: 65532       # distroless nonroot user
  fsGroup: 65532
  seccompProfile:
    type: RuntimeDefault

# Container-level
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
```

- **No shell**: distroless base image has no OS, no shell, no package manager
- **Read-only filesystem**: Container cannot write to any filesystem path
- **No capabilities**: All Linux capabilities dropped
- **Seccomp**: RuntimeDefault profile limits available syscalls

---

## 15. Observability and Metrics

### Prometheus Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `csrf_requests_total` | Counter | `method`, `result` | Total requests processed |
| `csrf_redis_errors_total` | Counter | — | Redis connectivity errors |
| `csrf_request_duration_seconds` | Histogram | `handler` | Request latency distribution |

### Label Values for `csrf_requests_total`

| `method` | `result` | Meaning |
|----------|----------|---------|
| `generate` | `ok` | Token successfully generated |
| `generate` | `unauthorized` | No JWT provided for token generation |
| `authz_safe` | `ok` | Safe method (GET/HEAD/OPTIONS/TRACE) passed through |
| `authz_noauth` | `ok` | Mutating request without JWT passed through (backend will 401) |
| `authz_mutate` | `ok` | Mutating request with valid JWT + valid CSRF token |
| `authz_mutate` | `missing_token` | Mutating request with JWT but no CSRF header |
| `authz_mutate` | `invalid_token` | Mutating request with wrong CSRF token |
| `authz_mutate` | `redis_error_failopen` | Redis error, request allowed through |

### Health Endpoints

| Endpoint | Probe Type | Behavior |
|----------|-----------|----------|
| `/healthz` | Readiness | Pings Redis; returns 200 if reachable, 503 if not |
| `/livez` | Liveness | Always returns 200 (process is alive) |

### Scrape Configuration

```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "8080"
  prometheus.io/path: "/metrics"
```

---

## 16. Test Coverage

### Unit Tests (Go — 19 tests total)

**Handler tests** (`internal/handler/handler_test.go` — 11 tests):
- Token generation with and without JWT
- Safe method pass-through (GET, HEAD, OPTIONS, TRACE)
- Mutating request without JWT (pass-through to backend)
- Mutating request without CSRF header (403)
- Mutating request with invalid token (403)
- Mutating request with valid token (200)
- PUT and DELETE method enforcement
- Missing stored token (403)
- Health and liveness endpoints

**Store tests** (`internal/store/redis_test.go` — 6 tests):
- Token generation and Redis storage verification
- Valid token comparison
- Invalid token rejection
- Missing token handling
- Redis connectivity check
- Redis-down error handling

**JWT tests** (`internal/jwt/extract_test.go` — 8 test cases):
- Valid JWT with string sub
- Valid JWT with UUID sub
- Missing Bearer prefix
- Empty string
- Bearer-only header
- Malformed JWT (2 parts instead of 3)
- Invalid base64 encoding
- Valid base64 but no sub claim

All tests use `miniredis` (in-memory Redis implementation) — no real Redis instance is needed to run tests.

### E2E Tests (Playwright — `e2e/csrf.spec.ts`)

**Gateway-Level CSRF Token Protection** (7 tests):
- GET /csrf/token without JWT → 401
- GET /csrf/token with JWT → token returned
- POST /ecom/cart without CSRF → 403
- POST /ecom/cart with invalid CSRF → 403
- POST /ecom/cart with valid CSRF → success
- Token reuse across multiple requests → all succeed
- GET /ecom/books without CSRF → success (safe method)

**Cross-Service Protection** (3 tests):
- PUT /inven/admin/stock without CSRF → 403
- PUT /inven/admin/stock with valid CSRF → success
- GET /inven/health without CSRF → success

**Browser Integration** (2 tests):
- UI handles CSRF transparently (add-to-cart works end-to-end)
- Redis contains CSRF key after token generation

**Kubernetes Production Config** (9+ tests):
- Deployment replicas, HPA bounds, PDB, rolling update strategy
- Prometheus annotations, health probes, security context
- Container resource limits

**Token Security** (5 tests):
- Each generation produces unique token
- Token format is UUID v4 (36 chars with hyphens)
- Different users get different tokens
- Cross-user token usage blocked (user1's token fails for admin1)
- 403 response does not leak internal details

---

## 17. Known Limitations and Trade-offs

### Single Token Per User

Only one CSRF token exists per user at any time. If a user has multiple browser tabs:

1. Tab A fetches a CSRF token → `token-1` stored in Redis
2. Tab B fetches a CSRF token → `token-2` overwrites `token-1` in Redis
3. Tab A tries to use `token-1` → **fails with 403** (Redis has `token-2`)

This is a known limitation. Most users don't have multiple tabs performing mutating operations simultaneously. The UI's auto-retry on 403 mitigates this: Tab A gets 403, fetches new token (now `token-3`), and retries — but this invalidates Tab B's `token-2`.

**Mitigation options** (not implemented, listed for reference):
- Store a set of tokens per user (max N tokens)
- Use HMAC-signed stateless tokens (no Redis lookup needed)

### Redis as Single Point of Failure

The CSRF service depends on a single Redis instance. If Redis goes down:
- Token generation returns a token but doesn't persist it (the subsequent validation will fail-open)
- Token validation fails-open (requests are allowed through)
- This is acceptable because JWT remains the primary authentication mechanism

### No Token Binding to Request Details

The token is not bound to the specific URL, method, or body of the request. A valid CSRF token can be used for any mutating endpoint (POST to `/ecom/cart`, DELETE to `/ecom/cart/1`, etc.). This is standard practice — most CSRF implementations (Django, Spring Security, Rails) also use per-session/per-user tokens rather than per-request tokens.

### 10-Minute TTL and Idle Users

If a user is completely idle for 10+ minutes (no page loads, no navigation) and then tries a mutating action, the CSRF token will have expired. However, the sliding TTL mechanism refreshes the token on every authenticated GET request, so normal browsing keeps the token alive. If the token does expire, the auto-regeneration feature returns a fresh token in the 403 response body, and the UI retries transparently — the user may notice only a brief delay.

### No CSRF on Service-to-Service Calls

Internal service-to-service communication (e.g., ecom-service calling inventory-service) does not go through the gateway and therefore bypasses CSRF. This is by design — Istio mTLS provides mutual authentication for internal traffic.

---

## 18. Request Flow Diagrams

### Successful Mutating Request

```
Browser                Gateway (Envoy)         csrf-service         Redis         Backend
  │                         │                      │                  │              │
  │  POST /ecom/cart        │                      │                  │              │
  │  Auth: Bearer <jwt>     │                      │                  │              │
  │  X-CSRF-Token: <token>  │                      │                  │              │
  │────────────────────────▶│                      │                  │              │
  │                         │                      │                  │              │
  │                         │  ext_authz check     │                  │              │
  │                         │  (POST, auth, csrf)  │                  │              │
  │                         │─────────────────────▶│                  │              │
  │                         │                      │                  │              │
  │                         │                      │  GET csrf:<sub>  │              │
  │                         │                      │─────────────────▶│              │
  │                         │                      │  <stored token>  │              │
  │                         │                      │◀─────────────────│              │
  │                         │                      │                  │              │
  │                         │                      │  ConstantTime    │              │
  │                         │                      │  Compare: MATCH  │              │
  │                         │                      │                  │              │
  │                         │                      │  EXPIRE csrf:<sub> 600          │
  │                         │                      │─────────────────▶│              │
  │                         │                      │                  │              │
  │                         │  200 OK              │                  │              │
  │                         │◀─────────────────────│                  │              │
  │                         │                      │                  │              │
  │                         │  Forward to backend  │                  │              │
  │                         │─────────────────────────────────────────────────────▶ │
  │                         │                      │                  │              │
  │  200 OK (cart updated)  │                      │                  │              │
  │◀────────────────────────│                      │                  │              │
```

### Failed Request (Expired Token) with Auto-Retry

```
Browser                Gateway (Envoy)         csrf-service         Redis
  │                         │                      │                  │
  │  POST /ecom/cart        │                      │                  │
  │  Auth: Bearer <jwt>     │                      │                  │
  │  X-CSRF-Token: <old>    │                      │                  │
  │────────────────────────▶│                      │                  │
  │                         │  ext_authz check     │                  │
  │                         │─────────────────────▶│                  │
  │                         │                      │  GET csrf:<sub>  │
  │                         │                      │─────────────────▶│
  │                         │                      │  (nil — expired) │
  │                         │                      │◀─────────────────│
  │                         │  403 Forbidden       │                  │
  │                         │◀─────────────────────│                  │
  │  403 Forbidden          │                      │                  │
  │◀────────────────────────│                      │                  │
  │                         │                      │                  │
  │  [UI auto-retry logic]  │                      │                  │
  │                         │                      │                  │
  │  GET /csrf/token        │                      │                  │
  │  Auth: Bearer <jwt>     │                      │                  │
  │────────────────────────▶│                      │                  │
  │                         │─────────────────────▶│                  │
  │                         │                      │  SET csrf:<sub>  │
  │                         │                      │  <new-token>     │
  │                         │                      │  TTL 600         │
  │                         │                      │─────────────────▶│
  │  { token: <new> }       │                      │                  │
  │◀────────────────────────│                      │                  │
  │                         │                      │                  │
  │  POST /ecom/cart        │                      │                  │
  │  X-CSRF-Token: <new>    │  (retry)             │                  │
  │────────────────────────▶│─────────────────────▶│                  │
  │                         │                      │  GET csrf:<sub>  │
  │                         │                      │─────────────────▶│
  │                         │                      │  <new-token>     │
  │                         │                      │◀─────────────────│
  │                         │  200 OK              │  MATCH ✓         │
  │                         │◀─────────────────────│                  │
  │  200 OK                 │                      │                  │
  │◀────────────────────────│                      │                  │
```
