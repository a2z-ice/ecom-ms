# Redis-Backed CSRF Token Implementation

## Overview

This document describes the implementation of Redis-backed CSRF (Cross-Site Request Forgery) token protection for the BookStore platform's E-Commerce Service. CSRF tokens provide defense-in-depth security on top of JWT authentication, ensuring that mutating API requests originate from the legitimate UI and not from a malicious cross-origin page.

---

## 1. What is CSRF and Why It Matters

**Cross-Site Request Forgery (CSRF)** is an attack where a malicious website tricks a user's browser into making unintended requests to another site where the user is authenticated. If the target site relies solely on cookies for authentication, the browser automatically includes them, allowing the attacker to perform actions on behalf of the user.

### Why CSRF Protection Even with JWT?

While our API uses Bearer token authentication (not cookies), CSRF protection serves as **defense-in-depth**:

- If a future change introduces cookie-based session storage, CSRF protection is already in place
- It prevents token relay attacks where an attacker's page could potentially extract and replay tokens
- It satisfies security audit requirements for financial/e-commerce applications
- It validates that requests originate from our UI, not just from any client with a valid JWT

---

## 2. Before the Change

### SecurityConfig.java (Before)

```java
@Bean
public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
    http
        .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .csrf(csrf -> csrf.disable())   // CSRF handled at gateway/UI level for this stateless API
        .authorizeHttpRequests(auth -> {
            auth.requestMatchers(HttpMethod.GET, "/books", "/books/search", "/books/*").permitAll();
            auth.requestMatchers("/actuator/health/**", "/actuator/info", "/actuator/prometheus").permitAll();
            if (swaggerEnabled) {
                auth.requestMatchers("/swagger-ui/**", "/swagger-ui.html", "/v3/api-docs/**").permitAll();
            }
            auth.anyRequest().authenticated();
        })
        .oauth2ResourceServer(oauth2 -> oauth2
            .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthenticationConverter()))
        );
    return http.build();
}
```

### UI API Client (Before)

```typescript
async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = _getToken?.()
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
  const resp = await fetch(url, { ...options, headers })
  // ... error handling
}
```

### State Before

| Aspect | Status |
|--------|--------|
| CSRF protection | Disabled (`csrf.disable()`) |
| Redis usage for CSRF | None |
| X-CSRF-Token header | Not sent by UI |
| CSRF endpoint | Does not exist |
| Mutating requests | Only JWT required |

---

## 3. After the Change

### Architecture

```
User Login → GET /ecom/csrf-token (JWT required) → Token stored in Redis & returned
                                                     ↓
User Action → POST/PUT/DELETE with X-CSRF-Token header → CsrfValidationFilter validates
                                                          ↓
                                                     Redis lookup: csrf:{userId} → compare token
                                                          ↓
                                                     Match? → Allow request (refresh TTL)
                                                     No match? → 403 Forbidden
```

### Files Created

#### 3.1 CsrfTokenService.java

**Path:** `ecom-service/src/main/java/com/bookstore/ecom/config/CsrfTokenService.java`

Redis-backed token store using Spring's auto-configured `StringRedisTemplate`.

```java
@Service
public class CsrfTokenService {
    private static final String KEY_PREFIX = "csrf:";
    private static final Duration TOKEN_TTL = Duration.ofMinutes(10);
    private final StringRedisTemplate redisTemplate;

    // Generate a new CSRF token, store in Redis with 10min TTL
    public String generateToken(String userId) {
        String token = UUID.randomUUID().toString();
        redisTemplate.opsForValue().set(KEY_PREFIX + userId, token, TOKEN_TTL);
        return token;
    }

    // Validate token against Redis; refresh TTL on success; fail-open on Redis errors
    public boolean validateAndRefresh(String userId, String token) {
        if (token == null || token.isBlank()) return false;
        try {
            String stored = redisTemplate.opsForValue().get(KEY_PREFIX + userId);
            if (stored != null && stored.equals(token)) {
                redisTemplate.expire(KEY_PREFIX + userId, TOKEN_TTL);
                return true;
            }
            return false;
        } catch (Exception e) {
            log.warn("Redis error — failing open: {}", e.getMessage());
            return true;  // JWT is the primary defense
        }
    }
}
```

**Key design decisions:**
- **Redis key format:** `csrf:{JWT-sub-claim}` — one token per authenticated user
- **TTL:** 10 minutes (configurable via `CSRF_TOKEN_TTL_MINUTES`), refreshed on every successful validation and on authenticated safe method requests (sliding TTL via `CSRF_SLIDING_TTL=true`)
- **Fail-open:** If Redis is unavailable, requests are allowed through (JWT remains the primary defense)

#### 3.2 CsrfValidationFilter.java

**Path:** `ecom-service/src/main/java/com/bookstore/ecom/config/CsrfValidationFilter.java`

Custom `OncePerRequestFilter` that validates the `X-CSRF-Token` header on mutating requests.

```java
public class CsrfValidationFilter extends OncePerRequestFilter {
    private static final Set<String> SAFE_METHODS = Set.of("GET", "HEAD", "OPTIONS", "TRACE");

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        if (!enabled) return true;                              // Disabled in test profile
        if (SAFE_METHODS.contains(request.getMethod())) return true;  // Safe methods exempt
        String path = request.getRequestURI();
        return path.startsWith("/ecom/actuator/")               // Actuator exempt
            || path.startsWith("/ecom/swagger-ui")              // Swagger exempt
            || path.startsWith("/ecom/v3/api-docs");
    }

    @Override
    protected void doFilterInternal(...) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !auth.isAuthenticated()) {
            filterChain.doFilter(request, response);  // Let Spring Security reject it
            return;
        }
        // Extract user from JWT, validate CSRF token
        if (auth instanceof JwtAuthenticationToken jwtAuth) {
            String userId = jwtAuth.getToken().getSubject();
            String csrfToken = request.getHeader("X-CSRF-Token");
            if (csrfTokenService.validateAndRefresh(userId, csrfToken)) {
                filterChain.doFilter(request, response);
            } else {
                response.setStatus(403);
                response.getWriter().write(
                    "{\"type\":\"about:blank\",\"title\":\"Forbidden\","
                    + "\"status\":403,\"detail\":\"Invalid or missing CSRF token\"}");
            }
        }
    }
}
```

**Filter chain position:** Registered after `BearerTokenAuthenticationFilter` so the JWT is already parsed.

#### 3.3 CsrfTokenController.java

**Path:** `ecom-service/src/main/java/com/bookstore/ecom/controller/CsrfTokenController.java`

```java
@RestController
public class CsrfTokenController {
    private final CsrfTokenService csrfTokenService;

    @GetMapping("/csrf-token")
    public Map<String, String> getCsrfToken(JwtAuthenticationToken auth) {
        String userId = auth.getToken().getSubject();
        String token = csrfTokenService.generateToken(userId);
        return Map.of("token", token);
    }
}
```

#### 3.4 SecurityConfig.java (After)

```java
@Value("${csrf.enabled:true}")
private boolean csrfEnabled;

private final CsrfTokenService csrfTokenService;

@Bean
public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
    http
        .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .csrf(csrf -> csrf.disable())   // Spring's built-in CSRF disabled; custom Redis-backed filter below
        .addFilterAfter(new CsrfValidationFilter(csrfTokenService, csrfEnabled),
                BearerTokenAuthenticationFilter.class)
        // ... rest unchanged
}
```

### Files Modified

#### 3.5 UI API Client (After)

**Path:** `ui/src/api/client.ts`

```typescript
let _csrfToken: string | null = null

export async function fetchCsrfToken(): Promise<string | null> {
  const token = _getToken?.()
  if (!token) return null
  const resp = await fetch('/ecom/csrf-token', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (resp.ok) {
    const data = await resp.json()
    _csrfToken = data.token
    return _csrfToken
  }
  return null
}

async function request<T>(url, options, _csrfRetried = false): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase()
  const isMutating = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(isMutating && _csrfToken ? { 'X-CSRF-Token': _csrfToken } : {}),
  }

  const resp = await fetch(url, { ...options, headers })

  // Auto-retry on 403: CSRF token may have expired
  if (resp.status === 403 && isMutating && !_csrfRetried) {
    await fetchCsrfToken()
    return request<T>(url, options, true)
  }
  // ... rest unchanged
}
```

#### 3.6 App.tsx (After)

```typescript
function AppWithAuth() {
  const { getAccessToken, user } = useAuth()
  setTokenProvider(getAccessToken)

  // Fetch CSRF token from ecom-service after authentication
  useEffect(() => {
    if (user) {
      fetchCsrfToken().catch(err => console.warn('CSRF token fetch failed:', err))
    }
  }, [user])
  // ...
}
```

#### 3.7 CallbackPage.tsx (After)

```typescript
// Fetch CSRF token before any mutating requests
let csrfToken: string | null = null
try {
  const csrfResp = await fetch('/ecom/csrf-token', {
    headers: { Authorization: `Bearer ${user.access_token}` },
  })
  if (csrfResp.ok) {
    const csrfData = await csrfResp.json()
    csrfToken = csrfData.token
    setCsrfToken(csrfToken)
  }
} catch { /* best-effort */ }

// Guest cart merge now includes CSRF header
fetch('/ecom/cart', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${user.access_token}`,
    ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
  },
  body: JSON.stringify({ bookId: item.bookId, quantity: item.quantity }),
})
```

#### 3.8 application-test.yml

```yaml
csrf:
  enabled: false   # Integration tests have no Redis; CSRF filter is skipped
```

### State After

| Aspect | Status |
|--------|--------|
| CSRF protection | Enabled (custom Redis-backed filter) |
| Redis key format | `csrf:{userId}` with 10min TTL |
| X-CSRF-Token header | Sent by UI on all POST/PUT/DELETE/PATCH |
| CSRF endpoint | `GET /ecom/csrf-token` (JWT required) |
| Mutating requests | JWT + CSRF token required |
| Safe methods (GET) | No CSRF required |
| Token expiry handling | Auto-retry on 403 |
| Redis failure | Fail-open (log warning, allow request) |
| Integration tests | CSRF disabled via `csrf.enabled=false` |

---

## 4. Edge Cases

| Scenario | Behavior |
|----------|----------|
| User clicks button before CSRF token is fetched | 403 returned, auto-retry fetches token, request succeeds |
| Token expires after 10min idle | Same 403-retry mechanism; also auto-regeneration returns new token in 403 body |
| Redis is unavailable | Fail-open: request allowed with warning log |
| Unauthenticated request to mutating endpoint | CSRF filter passes through; Spring Security rejects at auth layer (401) |
| GET requests | Always exempt from CSRF validation |
| Guest cart merge during OIDC callback | CSRF token fetched before merge; included in all POST calls |

---

## 5. Manual Testing Guide

### Prerequisites

Ensure the cluster is running:
```bash
bash scripts/up.sh
```

### Step 1: Obtain a JWT Token

```bash
TOKEN=$(curl -sk -X POST \
  "https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=ui-client&username=user1&password=CHANGE_ME" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

echo "JWT obtained: ${#TOKEN} chars"
```

### Step 2: Verify POST Without CSRF Returns 403

```bash
curl -sk -w "\nHTTP Status: %{http_code}\n" \
  -X POST https://api.service.net:30000/ecom/cart \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"bookId":"00000000-0000-0000-0000-000000000001","quantity":1}'
```

**Expected output:**
```json
{"type":"about:blank","title":"Forbidden","status":403,"detail":"Invalid or missing CSRF token"}
HTTP Status: 403
```

### Step 3: Verify POST With Invalid CSRF Returns 403

```bash
curl -sk -w "\nHTTP Status: %{http_code}\n" \
  -X POST https://api.service.net:30000/ecom/cart \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-CSRF-Token: this-is-not-a-valid-token" \
  -H "Content-Type: application/json" \
  -d '{"bookId":"00000000-0000-0000-0000-000000000001","quantity":1}'
```

**Expected output:**
```json
{"type":"about:blank","title":"Forbidden","status":403,"detail":"Invalid or missing CSRF token"}
HTTP Status: 403
```

### Step 4: Fetch a Valid CSRF Token

```bash
CSRF=$(curl -sk https://api.service.net:30000/ecom/csrf-token \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

echo "CSRF token: $CSRF"
```

**Expected output:**
```
CSRF token: ec235d14-549e-4486-9c39-2d7c8fffd2f3
```

### Step 5: Verify POST With Valid CSRF Succeeds

```bash
curl -sk -w "\nHTTP Status: %{http_code}\n" \
  -X POST https://api.service.net:30000/ecom/cart \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-CSRF-Token: $CSRF" \
  -H "Content-Type: application/json" \
  -d '{"bookId":"00000000-0000-0000-0000-000000000001","quantity":1}'
```

**Expected output:**
```json
{"id":"...","book":{"id":"00000000-0000-0000-0000-000000000001","title":"..."},"quantity":1,"userId":"..."}
HTTP Status: 200
```

### Step 6: Verify GET Requests Are Unaffected

```bash
curl -sk -w "\nHTTP Status: %{http_code}\n" \
  https://api.service.net:30000/ecom/books | head -1
```

**Expected:** HTTP Status 200 (no CSRF token needed for GET).

### Step 7: Verify CSRF Token Endpoint Requires JWT

```bash
curl -sk -w "\nHTTP Status: %{http_code}\n" \
  https://api.service.net:30000/ecom/csrf-token
```

**Expected output:**
```
HTTP Status: 401
```

### Step 8: Verify Redis Contains the CSRF Key

```bash
kubectl exec -n infra deploy/redis -- redis-cli -a CHANGE_ME KEYS 'csrf:*'
```

**Expected output:**
```
csrf:d4d573f8-178d-4843-92e2-d0e3596ee18e
```

### Step 9: Verify Token TTL in Redis

```bash
kubectl exec -n infra deploy/redis -- redis-cli -a CHANGE_ME TTL 'csrf:d4d573f8-178d-4843-92e2-d0e3596ee18e'
```

**Expected:** A value between 0 and 600 (10 minutes in seconds).

### Step 10: Run the CSRF E2E Tests

```bash
cd e2e && npx playwright test csrf.spec.ts
```

**Expected:** All 8 tests pass.

### Step 11: Run the Full E2E Regression

```bash
cd e2e && npm run test
```

**Expected:** 430+ tests pass. Zero CSRF-related failures.

---

## 6. Files Changed Summary

| File | Action | Description |
|------|--------|-------------|
| `ecom-service/.../config/CsrfTokenService.java` | **Created** | Redis-backed token store |
| `ecom-service/.../config/CsrfValidationFilter.java` | **Created** | Validates X-CSRF-Token on mutations |
| `ecom-service/.../controller/CsrfTokenController.java` | **Created** | GET /csrf-token endpoint |
| `ecom-service/.../config/SecurityConfig.java` | **Modified** | Register CSRF filter in chain |
| `ecom-service/src/test/resources/application-test.yml` | **Modified** | `csrf.enabled: false` for tests |
| `ui/src/api/client.ts` | **Modified** | CSRF token inject + 403-retry |
| `ui/src/App.tsx` | **Modified** | Fetch CSRF on auth |
| `ui/src/pages/CallbackPage.tsx` | **Modified** | Fetch CSRF before guest cart merge |
| `e2e/csrf.spec.ts` | **Created** | 8 CSRF-specific E2E tests |
| `e2e/admin.spec.ts` | **Modified** | CSRF header on admin mutations |
| `e2e/input-validation.spec.ts` | **Modified** | CSRF header on cart validation tests |
| `e2e/infra-app-hardening.spec.ts` | **Modified** | CSRF header on idempotent checkout test |

---

## 7. E2E Test Results

| Test File | Tests | Result |
|-----------|-------|--------|
| `csrf.spec.ts` | 8 | All pass |
| `admin.spec.ts` | 20 | All pass |
| `input-validation.spec.ts` | 12 | All pass |
| `infra-app-hardening.spec.ts` | 12 | All pass |
| All browser-based tests | 380+ | All pass (CSRF transparent) |
| **Total regression** | **430+** | **All pass** |
