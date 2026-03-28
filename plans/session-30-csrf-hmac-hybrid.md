# Session 30 — CSRF Service: Hybrid HMAC + Cuckoo Filter (Stateless High-Performance)

**Goal:** Re-architect the csrf-service from a fully Redis-dependent stateful model to a hybrid HMAC + Cuckoo filter architecture that achieves 1000x faster token generation, 600x faster validation, Redis-optional resilience, and closes the BREACH gap — without sacrificing any security property.

**Date:** 2026-03-28
**Status:** `[ ]` pending

---

## Overview

| Aspect | Current (Redis UUID) | Target (HMAC + Cuckoo) |
|---|---|---|
| Token generation | ~3ms (2 Redis ops) | ~2μs (pure CPU) |
| Token validation | ~2ms (2 Redis ops) | ~3μs (HMAC + in-memory Cuckoo) |
| Redis dependency | Critical path (every request) | Optional (L3 dedup + introspection cache) |
| BREACH protection | None | XOR masking on every response |
| Single-use enforcement | Deterministic (Redis DEL) | Cuckoo filter (deterministic delete, 0 false negatives) |
| Throughput per pod | ~5K RPS | ~200K RPS |
| Redis failure impact | Service degraded | Core functionality unaffected |

---

## Architecture

```
                    ┌─────────────────────────────────────────────────┐
                    │              csrf-service pod                   │
                    │                                                 │
Request ──────────► │  L1: In-Memory Cuckoo Filter (consumed JTIs)   │
                    │       ↓ not consumed                            │
                    │  L2: HMAC-SHA256 Verify (stateless)             │
                    │       ↓ signature valid + claims valid           │
                    │  L3: Redis Cuckoo Filter (cross-pod consumed)   │
                    │       ↓ not consumed (or Redis unavailable)     │
                    │  Mark consumed: L1 + async L3                   │
                    │                                                 │
                    │  XOR Masking: applied on every token response   │
                    └─────────────────────────────────────────────────┘
```

### Token Structure

```
Token = Base64URL(payload || HMAC-SHA256(key, payload))

payload (compact binary, ~80 bytes):
  sub    string    // JWT subject (user binding)
  org    string    // Request origin (origin binding)
  iat    int64     // Issued-at Unix timestamp (TTL check)
  jti    [16]byte  // Unique ID (single-use enforcement via Cuckoo)
```

### XOR BREACH Masking (on every response)

```
Masked  = Base64URL(random || (tokenBytes XOR random))
Unmask  = split in half → XOR second half with first → original token
```

### Key Management (KeyRing)

```
KeyRing:
  current   []byte      // Active 256-bit signing key
  previous  []byte      // Grace period for in-flight tokens (1 TTL window)
  rotatedAt time.Time   // Auto-rotate via CSRF_KEY_ROTATE_HOURS (default: 24h)
  source: K8s Secret CSRF_HMAC_KEY or auto-generated + stored in Redis
```

### Cuckoo Filter vs Bloom Filter

| Property | Bloom Filter | Cuckoo Filter |
|---|---|---|
| False positive rate | ~0.1% | ~0.01% (10x better at same memory) |
| False negatives | 0 | 0 |
| Supports delete | No | **Yes** (critical for rolling window cleanup) |
| Memory efficiency | Good | Better at <3% FP rate |
| Lookup speed | O(k) hash | O(1-2) lookups |

Cuckoo filter's delete support means we can remove expired JTIs instead of swapping entire filters.

---

## Deliverables

### Phase 1 — Core HMAC Token Engine

| # | File | Description |
|---|---|---|
| 1.1 | `internal/token/hmac.go` | HMAC token generation + verification (payload encode/decode, HMAC-SHA256 sign/verify) |
| 1.2 | `internal/token/hmac_test.go` | Unit tests: generation, verification, tamper detection, expiry, user/origin binding |
| 1.3 | `internal/token/keyring.go` | Key management: load from env, dual-key rotation, grace period for in-flight tokens |
| 1.4 | `internal/token/keyring_test.go` | Unit tests: rotation, dual-key verification, expired previous key rejection |
| 1.5 | `internal/token/mask.go` | XOR BREACH masking: mask for response, unmask from request |
| 1.6 | `internal/token/mask_test.go` | Unit tests: mask/unmask round-trip, different mask per call, constant-time |

### Phase 2 — Cuckoo Filter (Single-Use Enforcement)

| # | File | Description |
|---|---|---|
| 2.1 | `internal/cuckoo/filter.go` | Cuckoo filter wrapper: Insert, Lookup, Delete, Count, rolling window management |
| 2.2 | `internal/cuckoo/filter_test.go` | Unit tests: insert/lookup/delete, capacity, false positive rate validation, rolling window |
| 2.3 | `internal/cuckoo/rolling.go` | Rolling window: current + previous filter, auto-rotate every TTL period, goroutine-safe |
| 2.4 | `internal/cuckoo/rolling_test.go` | Unit tests: rotation, cross-window lookup, expired cleanup, concurrent access |

### Phase 3 — Hybrid Store (L1 + L2 + L3)

| # | File | Description |
|---|---|---|
| 3.1 | `internal/store/hybrid.go` | `HybridStore` implementing `TokenStore` interface: HMAC generate, L1 Cuckoo + L2 HMAC + L3 Redis validate |
| 3.2 | `internal/store/hybrid_test.go` | Unit tests: all validation paths, Redis failure fallback, cross-pod dedup simulation |
| 3.3 | `internal/store/redis.go` | Updated: add `BFExists`/`BFAdd` methods for L3 Redis Cuckoo, keep backward compat |
| 3.4 | `internal/store/redis_test.go` | Updated: add L3 Cuckoo tests with miniredis |

### Phase 4 — Handler + Config Integration

| # | File | Description |
|---|---|---|
| 4.1 | `internal/config/config.go` | New env vars: `CSRF_MODE`, `CSRF_HMAC_KEY`, `CSRF_KEY_ROTATE_HOURS`, `CSRF_CUCKOO_CAPACITY`, `CSRF_CUCKOO_FP_RATE`, `CSRF_XOR_MASKING` |
| 4.2 | `internal/handler/token.go` | Updated: XOR mask on generation response, use HybridStore |
| 4.3 | `internal/handler/authz.go` | Updated: XOR unmask on validation, use HybridStore, eliminate sliding TTL Redis call |
| 4.4 | `internal/handler/handler_test.go` | Updated: all existing 19 tests pass + new HMAC/Cuckoo/masking tests |
| 4.5 | `internal/middleware/metrics.go` | New metrics: `csrf_hmac_operations_total`, `csrf_cuckoo_operations_total`, `csrf_xor_mask_total`, `csrf_key_rotations_total`, `csrf_l3_redis_fallback_total` |
| 4.6 | `main.go` | Updated: wire HybridStore based on CSRF_MODE, KeyRing init, Cuckoo filter init |

### Phase 5 — In-Memory Rate Limiting (Redis-Free)

| # | File | Description |
|---|---|---|
| 5.1 | `internal/ratelimit/local.go` | In-memory token bucket rate limiter (per-pod, no Redis) |
| 5.2 | `internal/ratelimit/local_test.go` | Unit tests: allow/deny, per-user isolation, window expiry, concurrent safety |
| 5.3 | `internal/ratelimit/limiter.go` | Updated: `RateLimitMode` selects Redis or local limiter |

### Phase 6 — Backward Compatibility + Migration

| # | File | Description |
|---|---|---|
| 6.1 | `internal/handler/authz.go` | Detect token format: UUID (legacy Redis) vs HMAC (new) → route to correct validator |
| 6.2 | `internal/store/hybrid.go` | `Validate()` tries HMAC first; if not HMAC format, falls back to Redis UUID lookup |
| 6.3 | `internal/handler/handler_test.go` | Tests: mixed-mode validation (legacy UUID + new HMAC tokens coexist during rollout) |

### Phase 7 — Kubernetes Deployment

| # | File | Description |
|---|---|---|
| 7.1 | `k8s/csrf-service.yaml` | Updated: new env vars, increased memory limit (32Mi→80Mi for Cuckoo filter), `CSRF_MODE=hybrid` |
| 7.2 | `k8s/csrf-service-secret` | Add `CSRF_HMAC_KEY` (256-bit random, base64-encoded) |
| 7.3 | `Dockerfile` | No changes needed (static Go binary) |

### Phase 8 — Unit Tests (Go)

All unit tests run with `go test -v ./...` — no real Redis needed (miniredis).

| Test File | Tests | What It Covers |
|---|---|---|
| `internal/token/hmac_test.go` | ~12 | Generation, verification, tamper detection, wrong key, expired token, wrong user, wrong origin, empty claims, max-length payload |
| `internal/token/keyring_test.go` | ~8 | Load from env, rotation, current+previous verify, expired previous reject, concurrent rotation, missing key error |
| `internal/token/mask_test.go` | ~6 | Round-trip, different mask per call, empty token, long token, unmask with wrong length, constant output length |
| `internal/cuckoo/filter_test.go` | ~10 | Insert+lookup, delete, capacity limit, false positive rate ≤0.01% (statistical), duplicate insert, empty lookup, concurrent insert/lookup |
| `internal/cuckoo/rolling_test.go` | ~8 | Rotation, cross-window lookup, post-rotation cleanup, concurrent rotation+lookup, timer-based auto-rotate |
| `internal/store/hybrid_test.go` | ~15 | HMAC generate (no Redis), validate happy path (L1 hit), validate (L1 miss → L3 hit), validate (L1+L3 miss = valid), Redis down → L1+L2 still work, single-use (second validate fails), origin binding, user binding, expiry, backward compat UUID, mixed-mode |
| `internal/ratelimit/local_test.go` | ~8 | Allow, deny at limit, per-user isolation, window reset, concurrent access, zero-config defaults |
| `internal/handler/handler_test.go` | ~30+ | All existing 19 tests refactored + new: HMAC token flow, XOR masked token flow, Cuckoo single-use, legacy UUID backward compat, Redis-down resilience, auto-regen with HMAC, BREACH masking on response, key rotation mid-flight, metrics incremented correctly |

**Total unit tests: ~100+** (up from current 19)

### Phase 9 — E2E Tests (Playwright)

| Test File | Tests | What It Covers |
|---|---|---|
| `e2e/csrf.spec.ts` | Updated (~20) | All existing tests adapted for HMAC tokens: token format detection (not UUID anymore), single-use, cross-service protection, safe methods bypass, Kubernetes HA, security hardening, health probes, Prometheus metrics |
| `e2e/csrf-sliding-ttl.spec.ts` | Updated (~12) | Sliding TTL now embedded in token (no Redis EXPIRE), auto-regeneration returns HMAC token, browser retry flow, cross-user isolation, Prometheus metrics for new counters |
| `e2e/csrf-hmac.spec.ts` | **NEW** (~25) | HMAC-specific E2E tests (see detailed list below) |
| `e2e/csrf-breach.spec.ts` | **NEW** (~8) | BREACH protection E2E tests (see detailed list below) |
| `e2e/csrf-migration.spec.ts` | **NEW** (~6) | Backward compatibility during rolling upgrade |

#### `e2e/csrf-hmac.spec.ts` — Detailed Test List

```
HMAC Token Security
  ✓ GET /csrf/token returns a valid HMAC token (not UUID format)
  ✓ HMAC token is longer than UUID (contains payload + signature)
  ✓ same user gets different tokens on consecutive calls (unique JTI)
  ✓ token is bound to user — cannot be used by different user
  ✓ token expires after TTL (10 min default)
  ✓ expired token returns 403 with auto-regenerated new token
  ✓ tampered token (modified payload) returns 403
  ✓ tampered token (modified signature) returns 403
  ✓ truncated token returns 403
  ✓ empty X-CSRF-Token header returns 403

HMAC Single-Use (Cuckoo Filter)
  ✓ token consumed after first successful mutating request
  ✓ second use of same token returns 403
  ✓ 403 on second use includes auto-regenerated new token
  ✓ regenerated token from 403 body is valid for next request
  ✓ 100 sequential token-use cycles all succeed (no false positives)

HMAC Origin Binding
  ✓ token generated from origin A cannot be used from origin B
  ✓ token without origin binding works from any origin (backward compat)

HMAC Redis Resilience
  ✓ token generation works when Redis is unavailable (pure HMAC)
  ✓ token validation works when Redis is unavailable (L1 Cuckoo + HMAC)
  ✓ auto-regeneration works when Redis is unavailable

HMAC Key Rotation
  ✓ tokens signed with previous key still validate during grace period
  ✓ csrf_key_rotations_total metric increments after rotation

HMAC Performance
  ✓ token generation latency < 5ms (p99)
  ✓ token validation latency < 5ms (p99)
  ✓ 50 concurrent mutating requests all succeed (no token collision)
```

#### `e2e/csrf-breach.spec.ts` — Detailed Test List

```
BREACH XOR Masking
  ✓ GET /csrf/token returns XOR-masked token (Base64URL, longer than raw)
  ✓ two consecutive GET /csrf/token calls return different byte sequences
  ✓ both masked versions validate successfully on POST
  ✓ raw (unmasked) HMAC token is rejected when XOR masking is enabled
  ✓ response Content-Type is application/json (no HTML embedding)

BREACH Resistance
  ✓ 10 consecutive token fetches produce 10 unique byte sequences
  ✓ XOR-masked token in 403 auto-regeneration body also differs per call
  ✓ masked token size is exactly 2x the raw token size (random || xored)
```

#### `e2e/csrf-migration.spec.ts` — Detailed Test List

```
Rolling Upgrade Backward Compatibility
  ✓ legacy UUID token (from old csrf-service) still validates
  ✓ new HMAC token validates alongside legacy tokens
  ✓ auto-regeneration returns HMAC token (not UUID) regardless of input format
  ✓ browser flow works during mixed-mode (old UI cached UUID, new service)
  ✓ legacy token single-use still enforced via Redis fallback
  ✓ Prometheus metrics distinguish legacy vs HMAC validations
```

**Total E2E tests: ~70+** (up from current ~30)

---

## New Configuration (Environment Variables)

| Env Var | Default | Description |
|---|---|---|
| `CSRF_MODE` | `hybrid` | Token mode: `redis` (legacy UUID), `hmac` (pure stateless), `hybrid` (HMAC + L3 Redis) |
| `CSRF_HMAC_KEY` | (required in hmac/hybrid mode) | 256-bit key, base64-encoded. From K8s Secret. |
| `CSRF_KEY_ROTATE_HOURS` | `24` | Auto-rotate signing key interval. Previous key valid for 1 TTL window. |
| `CSRF_XOR_MASKING` | `true` | Enable BREACH XOR masking on token responses |
| `CSRF_CUCKOO_CAPACITY` | `1000000` | Expected consumed tokens per TTL window |
| `CSRF_CUCKOO_FP_RATE` | `0.0001` | False positive rate (0.01%) |
| `CSRF_RATELIMIT_MODE` | `local` | Rate limiter: `redis` (current) or `local` (in-memory token bucket) |

Existing env vars (`CSRF_TOKEN_TTL_MINUTES`, `CSRF_SLIDING_TTL`, `CSRF_FAIL_CLOSED`, `CSRF_ALLOWED_ORIGINS`, etc.) remain unchanged and functional.

---

## New Prometheus Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `csrf_hmac_operations_total` | Counter | `op` (generate/verify), `result` (ok/invalid/expired/tampered) | HMAC token operations |
| `csrf_cuckoo_operations_total` | Counter | `op` (insert/lookup/delete), `tier` (l1/l3) | Cuckoo filter operations |
| `csrf_xor_mask_total` | Counter | `op` (mask/unmask) | XOR masking operations |
| `csrf_key_rotations_total` | Counter | — | Key rotation events |
| `csrf_l3_redis_fallback_total` | Counter | `result` (hit/miss/error) | L3 Redis Cuckoo lookups |
| `csrf_token_format_total` | Counter | `format` (hmac/uuid_legacy) | Token format detection (migration tracking) |

Existing metrics (`csrf_requests_total`, `csrf_redis_errors_total`, etc.) unchanged.

---

## New Dependencies

| Package | Version | Purpose |
|---|---|---|
| `github.com/seiflotfy/cuckoofilter` | latest | Cuckoo filter implementation (or `github.com/panmari/cuckoofilter`) |

No other new dependencies. HMAC, SHA256, XOR — all Go stdlib (`crypto/hmac`, `crypto/sha256`, `crypto/rand`, `encoding/base64`).

---

## Build & Deploy

```bash
# Unit tests (no Redis needed — miniredis)
cd csrf-service
go test -v -count=1 ./...

# Build + deploy
bash scripts/csrf-service-up.sh

# E2E tests
cd e2e
npx playwright test csrf.spec.ts csrf-sliding-ttl.spec.ts csrf-hmac.spec.ts csrf-breach.spec.ts csrf-migration.spec.ts
```

---

## Acceptance Criteria

### Security (must ALL pass)

- [ ] HMAC tokens are unforgeable — tampered tokens rejected (unit + e2e)
- [ ] Tokens are user-bound — cross-user usage rejected (unit + e2e)
- [ ] Tokens are origin-bound — cross-origin usage rejected (unit + e2e)
- [ ] Tokens expire after TTL — expired tokens rejected (unit + e2e)
- [ ] Single-use enforced — second use of same token rejected (unit + e2e)
- [ ] Auto-regeneration returns valid new HMAC token in 403 body (unit + e2e)
- [ ] XOR BREACH masking: every response returns different byte sequence (unit + e2e)
- [ ] XOR masked token validates correctly after unmasking (unit + e2e)
- [ ] Timing-safe comparison used for HMAC verify (`hmac.Equal`) (code review)
- [ ] Key rotation: tokens signed with previous key valid during grace period (unit + e2e)
- [ ] 256-bit HMAC key loaded from K8s Secret (never hardcoded) (code review)
- [ ] Constant-time origin comparison preserved (`subtle.ConstantTimeCompare`) (code review)

### Performance (must ALL pass)

- [ ] Token generation: 0 Redis operations (pure CPU)
- [ ] Token validation (happy path): 0-1 Redis operations (L1 Cuckoo + HMAC)
- [ ] Sliding TTL: 0 Redis operations (TTL embedded in token `iat`)
- [ ] Rate limiting (local mode): 0 Redis operations (in-memory token bucket)
- [ ] `csrf_request_duration_seconds` p99 < 5ms for both generate and authz handlers

### Resilience (must ALL pass)

- [ ] Redis completely down → token generation still works
- [ ] Redis completely down → token validation still works (L1 + HMAC)
- [ ] Redis completely down → auto-regeneration still works
- [ ] Redis completely down → only cross-pod single-use dedup degrades

### Backward Compatibility (must ALL pass)

- [ ] Legacy UUID tokens (from before upgrade) still validate via Redis fallback
- [ ] Mixed-mode: old and new tokens coexist during rolling deployment
- [ ] All existing E2E tests in `csrf.spec.ts` and `csrf-sliding-ttl.spec.ts` pass (adapted)
- [ ] `CSRF_MODE=redis` restores exact current behavior (escape hatch)

### Tests (must ALL pass)

- [ ] `go test -v ./...` — 100+ unit tests, 0 failures
- [ ] E2E: `csrf.spec.ts` — all existing tests pass (adapted for HMAC)
- [ ] E2E: `csrf-sliding-ttl.spec.ts` — all existing tests pass (adapted)
- [ ] E2E: `csrf-hmac.spec.ts` — 25 new tests, 0 failures
- [ ] E2E: `csrf-breach.spec.ts` — 8 new tests, 0 failures
- [ ] E2E: `csrf-migration.spec.ts` — 6 new tests, 0 failures

### Observability (must ALL pass)

- [ ] New Prometheus metrics registered and incrementing correctly
- [ ] `csrf_token_format_total{format="hmac"}` incrementing for new tokens
- [ ] `csrf_hmac_operations_total` tracking generate/verify outcomes
- [ ] `csrf_cuckoo_operations_total` tracking L1/L3 operations
- [ ] `csrf_key_rotations_total` increments on scheduled rotation

---

## Implementation Order

```
Phase 1 (Core HMAC)          ← No dependencies, start here
    │
Phase 2 (Cuckoo Filter)      ← No dependencies, can parallel with Phase 1
    │
Phase 3 (Hybrid Store)       ← Depends on Phase 1 + 2
    │
Phase 4 (Handler + Config)   ← Depends on Phase 3
    │
Phase 5 (Local Rate Limit)   ← Independent, can parallel with Phase 4
    │
Phase 6 (Backward Compat)    ← Depends on Phase 4
    │
Phase 7 (K8s Deployment)     ← Depends on Phase 4
    │
Phase 8 (Unit Tests)         ← Continuous, each phase includes its tests
    │
Phase 9 (E2E Tests)          ← Depends on Phase 7 (deployed to cluster)
```

**Parallelizable**: Phase 1 + Phase 2 + Phase 5 can be implemented simultaneously.

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| HMAC key compromised | Key rotation (24h default), key from K8s Secret (not env), previous key expires after 1 TTL window |
| Cuckoo filter full | Monitor `csrf_cuckoo_operations_total{op="insert",result="full"}`, auto-rotate creates new filter |
| False positive in Cuckoo (valid token rejected) | Auto-regeneration handles transparently, 0.01% FP rate = 1 in 10,000 |
| Rolling upgrade breaks existing sessions | Backward compat: UUID tokens fall through to Redis validation |
| Memory pressure from Cuckoo filter | 1M capacity at 0.01% FP ≈ 8MB. Pod memory limit raised 32→80Mi. |
| Key not set in hybrid/hmac mode | Startup fails with clear error message — no silent degradation |

---

## Files Changed Summary

| Category | New Files | Modified Files |
|---|---|---|
| **Core HMAC** | `internal/token/hmac.go`, `keyring.go`, `mask.go` + tests | — |
| **Cuckoo Filter** | `internal/cuckoo/filter.go`, `rolling.go` + tests | — |
| **Store** | `internal/store/hybrid.go` + test | `internal/store/redis.go`, `redis_test.go` |
| **Handler** | — | `internal/handler/token.go`, `authz.go`, `handler_test.go` |
| **Config** | — | `internal/config/config.go` |
| **Metrics** | — | `internal/middleware/metrics.go` |
| **Wiring** | — | `main.go` |
| **Rate Limit** | `internal/ratelimit/local.go` + test | `internal/ratelimit/limiter.go` |
| **K8s** | — | `k8s/csrf-service.yaml` |
| **Dependencies** | — | `go.mod`, `go.sum` |
| **E2E** | `e2e/csrf-hmac.spec.ts`, `csrf-breach.spec.ts`, `csrf-migration.spec.ts` | `e2e/csrf.spec.ts`, `csrf-sliding-ttl.spec.ts` |

**New files: 13** | **Modified files: 14** | **Total: 27 files**
