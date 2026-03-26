# CSRF Security Enhancements

## Overview

The CSRF service has been enhanced from a compliance checkbox into a real security layer. 8 enhancements close genuine security gaps, all deployed at the gateway level via Istio ext_authz.

## Why These Changes Matter

The original CSRF implementation protected against a threat that doesn't exist (traditional CSRF via cookies). JWTs in `Authorization` headers from in-memory storage make CSRF impossible. But the CSRF service sits at the gateway and sees every request — the most powerful enforcement position in the architecture.

These enhancements repurpose that position to solve **real** security problems.

---

## Enhancement 1: Single-Use CSRF Tokens

**Problem:** Multi-use tokens with sliding TTL. A stolen token could be replayed unlimited times for 30 minutes, with each use extending the TTL.

**Solution:** Tokens are consumed (deleted from Redis) after the first successful mutating request.

**How it works:**
- `GET /csrf/token` → generates token, stores in Redis with TTL
- `POST /ecom/cart` → validates token, **deletes it from Redis** on success
- Next mutation → 403 (token consumed) → UI auto-retries: fetches new token, retries once

**UI auto-retry:** `ui/src/api/client.ts:59-61` handles this transparently:
```typescript
if (resp.status === 403 && isMutating && !_csrfRetried) {
    await fetchCsrfToken()
    return request<T>(url, options, true)
}
```

**Important:** Single-use alone is not enough. If a token is stolen but the user never performs a mutation, the stolen token remains valid until TTL expires. The TTL (30min default) is the safety net. Combined with origin binding, the attacker also needs to match the exact origin.

---

## Enhancement 2: Configurable Fail-Closed Mode

**Problem:** Hardcoded fail-open meant a Redis DDoS silently disabled all CSRF protection.

**Solution:** Operators can choose fail-closed via `CSRF_FAIL_CLOSED=true`.

| Mode | Redis Error Behavior | Use Case |
|------|---------------------|----------|
| **Fail-open** (default) | Allow request through, log warning | General web apps — availability over security |
| **Fail-closed** | Return 503 Service Unavailable | Financial/compliance apps — security over availability |

**Env var:** `CSRF_FAIL_CLOSED=true|false` (default: `false`)

---

## Enhancement 3: Origin/Referer Validation

**Problem:** A stolen JWT could be used from any origin — curl, Postman, attacker's server.

**Solution:** The CSRF service validates the `Origin` header (falling back to `Referer`) against an allowed list.

**Flow:**
1. Read `Origin` header
2. If empty, extract `scheme://host:port` from `Referer`
3. If both empty: allow (unless `CSRF_REQUIRE_ORIGIN=true`)
4. Compare against allowed list
5. Mismatch → 403

**Env vars:**
- `CSRF_ALLOWED_ORIGINS=https://myecom.net:30000,https://localhost:30000` (comma-separated)
- `CSRF_REQUIRE_ORIGIN=true|false` (default: `false` — missing origin logs a warning but passes)

**Istio prerequisite:** `includeRequestHeadersInCheck` must include `origin` and `referer` — already updated in `csrf-service-up.sh` and `up.sh`.

---

## Enhancement 4: Token Binding to Origin

**Problem:** Exfiltrated CSRF token could be used from any origin.

**Solution:** Tokens are bound to the `Origin` header at generation time. Validation checks both token AND origin.

**Storage format:** `{token}|{origin}` in Redis (e.g., `550e8400...|https://myecom.net:30000`)

**Backward compatibility:** Tokens stored without `|` (pre-upgrade) are treated as origin-agnostic.

---

## Enhancement 5: Per-User Rate Limiting

**Problem:** An attacker with a stolen JWT could spam `GET /csrf/token` to overwrite the victim's token — targeted DoS preventing the victim from completing any mutation.

**Solution:** Sliding window rate limiter (Redis INCR + EXPIRE). Default: 10 generations per minute per user.

**Response on limit:** `429 Too Many Requests` with `Retry-After: 60` header.

**Env var:** `CSRF_RATE_LIMIT=10` (per minute per user)

---

## Enhancement 6: JWT Audience Validation

**Problem:** CSRF service only extracted `sub` from JWTs. A JWT from a different Keycloak client (wrong `aud` claim) was accepted.

**Solution:** Opt-in audience validation. When enabled, JWT `aud` claim must match the allowed list.

**Env vars:**
- `CSRF_VALIDATE_AUDIENCE=true|false` (default: `false` — opt-in)
- `CSRF_ALLOWED_AUDIENCES=ui-client` (comma-separated)

**RFC 7519 compliance:** Handles `aud` as both string and `[]string`.

---

## Enhancement 7: Open Redirect Fix + Security Headers

**Problem:** `CallbackPage.tsx` redirected to unvalidated `returnUrl` with auth token in URL hash. Missing HSTS and CSP directives.

**Fixes:**
- **Open redirect:** Added origin whitelist (`localhost:30000`, `myecom.net:30000`) — unknown origins redirect to `/`
- **HSTS:** `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- **CSP additions:** `base-uri 'self'; form-action 'self';`
- **New header:** `X-Permitted-Cross-Domain-Policies: none`

---

## Enhancement 8: Anomaly Detection Metrics

**Problem:** Suspicious patterns (rapid token regeneration, cross-user token attempts, origin mismatches) were invisible.

**New Prometheus metrics:**

| Metric | Labels | Alert On |
|--------|--------|----------|
| `csrf_anomaly_total` | `type` | Rising `origin_mismatch`, `bad_audience`, `rapid_regeneration` |
| `csrf_origin_checks_total` | `result` | Rising `rejected` or `missing` |
| `csrf_rate_limit_total` | `result` | Rising `rejected` |

**Anomaly types:** `cross_user_token`, `origin_mismatch`, `bad_audience`, `rapid_regeneration`, `origin_missing`

---

## Configuration Reference

| Env Var | Default | Description |
|---------|---------|-------------|
| `CSRF_FAIL_CLOSED` | `false` | Return 503 (not fail-open) on Redis errors |
| `CSRF_TOKEN_TTL_MINUTES` | `30` | Max token lifetime (consumed earlier via single-use) |
| `CSRF_ALLOWED_ORIGINS` | `https://myecom.net:30000,https://localhost:30000` | Allowed request origins |
| `CSRF_REQUIRE_ORIGIN` | `false` | Reject if Origin AND Referer both missing |
| `CSRF_ALLOWED_AUDIENCES` | `ui-client` | Allowed JWT audience values |
| `CSRF_VALIDATE_AUDIENCE` | `false` | Enable audience validation |
| `CSRF_RATE_LIMIT` | `10` | Max token generations per minute per user |

---

## Defense Layering

```
Request → TLS termination → JWT validation (Istio)
    → Origin validation (csrf-service)
    → Audience validation (csrf-service, opt-in)
    → CSRF token validation (csrf-service)
        → Token consumed on success (single-use)
        → Token bound to origin
        → Token expires after TTL (30min max)
    → Rate limiting on token generation
    → Forward to backend
```

Each layer catches a different attack vector. No single mechanism is sufficient alone.

---

## Test Coverage

**49 tests** across 6 packages, all using miniredis (no real Redis needed):
- `internal/store/`: 16 tests (single-use, origin binding, fail-open/closed, generate, validate)
- `internal/handler/`: 22 tests (all HTTP handlers, origin, audience, rate limiting, fail-closed)
- `internal/jwt/`: 18 test cases (extract, audience validation, RFC 7519 edge cases)
- `internal/origin/`: 7 tests (allowed, rejected, missing, Referer fallback, precedence)
- `internal/ratelimit/`: 5 tests (within limit, exceeds, per-user isolation, Redis down, noop)
