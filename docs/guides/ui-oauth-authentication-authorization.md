# UI Authentication & Authorization — OIDC PKCE with Keycloak

**Book Store Platform — React Frontend Security Deep Dive**

This document explains how the React UI implements the full OpenID Connect Authorization Code flow with PKCE, how tokens are stored and used, how the authentication state is propagated through the component tree, and how both client-side and server-side authorization work together.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Technology Stack](#2-technology-stack)
3. [OAuth 2.0 / OIDC Concepts](#3-oauth-20--oidc-concepts)
4. [Architecture Diagram](#4-architecture-diagram)
5. [OIDC Configuration](#5-oidc-configuration)
6. [The Full Login Flow — Step by Step](#6-the-full-login-flow--step-by-step)
7. [Token Storage Strategy](#7-token-storage-strategy)
8. [AuthContext — Shared Authentication State](#8-authcontext--shared-authentication-state)
9. [Route Protection](#9-route-protection)
10. [API Client — Attaching Tokens to Requests](#10-api-client--attaching-tokens-to-requests)
11. [Authorization — Role-Based Access Control](#11-authorization--role-based-access-control)
12. [Guest Cart — Pre-Login Persistence](#12-guest-cart--pre-login-persistence)
13. [Logout Flow](#13-logout-flow)
14. [Silent Token Renewal](#14-silent-token-renewal)
15. [Server-Side Enforcement (Istio + Spring Security)](#15-server-side-enforcement-istio--spring-security)
16. [Security Invariants](#16-security-invariants)
17. [Customization Guide](#17-customization-guide)
18. [Troubleshooting](#18-troubleshooting)
19. [Screenshot Reference](#19-screenshot-reference)

---

## 1. Overview

The UI implements **OpenID Connect Authorization Code flow with PKCE** (Proof Key for Code Exchange). This is the current industry standard for browser-based applications. It eliminates the need for a client secret in the browser while protecting the authorization code exchange from interception.

Key security properties enforced:

| Property | Implementation |
|----------|---------------|
| No client secret in browser | PKCE replaces secret with ephemeral code verifier |
| Tokens never in localStorage | Stored in `sessionStorage` only — cleared on tab close |
| Tokens never in URL | Authorization code is exchanged server-side by the library |
| Server-side validation | Every API request validated by Spring Security + Istio |
| CSRF protection | Kubernetes NetworkPolicies + Istio mTLS |
| Role-based access | Keycloak realm roles decoded from JWT `roles` claim |

---

## 2. Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| UI Framework | React | 19.2 |
| OIDC Library | `oidc-client-ts` | latest |
| Identity Provider | Keycloak | 26.5.4 |
| Realm | `bookstore` | — |
| Client ID | `ui-client` | public (no secret) |
| Token Validation (backend) | Spring Security OIDC Resource Server | Spring Boot 4.0.3 |
| Service Mesh Auth | Istio Ambient + RequestAuthentication | 1.28.4 |

---

## 3. OAuth 2.0 / OIDC Concepts

### 3.1 Authorization Code Flow (without PKCE)

The basic flow before PKCE was added:

```
Browser                  Keycloak                  ecom-service
   │                        │                           │
   │  1. GET /login         │                           │
   │──────────────────────►│                           │
   │  2. redirect_uri?code=X│                           │
   │◄──────────────────────│                           │
   │  3. POST /token        │                           │
   │    code=X              │                           │
   │──────────────────────►│                           │
   │  4. access_token       │                           │
   │◄──────────────────────│                           │
   │  5. GET /ecom/books    │                           │
   │    Bearer: access_token│───────────────────────►  │
   │                        │                           │  6. validate token
```

**Problem:** If an attacker intercepts the authorization code `X` in step 2 (via browser history, referrer headers, or a malicious extension), they can exchange it for tokens.

### 3.2 Authorization Code + PKCE (What We Use)

PKCE prevents code interception attacks:

```
Browser generates:
  code_verifier  = random 64-char string (kept in memory)
  code_challenge = BASE64URL(SHA-256(code_verifier))

1. GET /authorize?
     response_type=code
     &client_id=ui-client
     &redirect_uri=http://localhost:30000/callback
     &scope=openid profile email roles
     &code_challenge=<hash>              ← sent to Keycloak
     &code_challenge_method=S256

2. User authenticates at Keycloak
   Keycloak returns ?code=X to /callback

3. POST /token
     code=X
     &code_verifier=<original random>   ← Keycloak re-hashes and compares
     &client_id=ui-client

4. Keycloak verifies SHA-256(code_verifier) == code_challenge
   If match → returns access_token, id_token, refresh_token
   If mismatch (code was stolen) → rejects
```

An attacker who intercepts code `X` cannot exchange it — they don't have `code_verifier`.

### 3.3 Token Types

| Token | Lifetime | Purpose |
|-------|----------|---------|
| `access_token` | 5 minutes | Bearer credential for API calls |
| `id_token` | 5 minutes | User identity (email, name, sub UUID) |
| `refresh_token` | 30 minutes | Obtains new access_token silently |

---

## 4. Architecture Diagram

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                     AUTHENTICATION & AUTHORIZATION FLOW                     ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║  ┌─────────────────────────────────────────────────────────────────────┐    ║
║  │  BROWSER  (http://localhost:30000)                                   │    ║
║  │                                                                      │    ║
║  │  ┌───────────────┐    ┌────────────────┐   ┌──────────────────────┐ │    ║
║  │  │  AuthProvider  │    │   oidcConfig   │   │   api/client.ts      │ │    ║
║  │  │  (React ctx)   │    │  UserManager   │   │   fetch + Bearer     │ │    ║
║  │  │               │    │                │   │                      │ │    ║
║  │  │  user:User|null│◄──│ getUser()      │   │  getAccessToken()    │ │    ║
║  │  │  isAdmin:bool  │   │ signinRedirect │   │  → Authorization:    │ │    ║
║  │  │  login()       │   │ signoutRedirect│   │     Bearer <token>   │ │    ║
║  │  │  logout()      │   │ events.*       │   │                      │ │    ║
║  │  └───────┬────────┘   └────────────────┘   └──────────────────────┘ │    ║
║  │          │                                                            │    ║
║  │  ┌───────▼──────────────────────────────────────────────────────┐   │    ║
║  │  │  Route Guards                                                  │   │    ║
║  │  │  ProtectedRoute: !user → login(returnPath)                    │   │    ║
║  │  │  AdminRoute:     !user → login('/admin')                      │   │    ║
║  │  │                  !isAdmin → <Access Denied />                  │   │    ║
║  │  └──────────────────────────────────────────────────────────────┘   │    ║
║  │                                                                      │    ║
║  │  Token storage: sessionStorage (cleared on tab close)               │    ║
║  └──────────────────────────────────────────────────────────────────────┘    ║
║           │  1. redirect to /authorize                                        ║
║           │  4. POST /token (code exchange)                                   ║
║           │  7. GET /userinfo (optional)                                      ║
║           ▼                                                                   ║
║  ┌─────────────────────────────────────────────────────────────────────┐    ║
║  │  KEYCLOAK  (http://idp.keycloak.net:30000/realms/bookstore)          │    ║
║  │                                                                      │    ║
║  │  Client: ui-client (public, no secret)                               │    ║
║  │  Users:  user1 (customer role), admin1 (customer + admin roles)      │    ║
║  │  Scopes: openid, profile, email, roles                               │    ║
║  │  JWKS:   /realms/bookstore/protocol/openid-connect/certs             │    ║
║  │                                                                      │    ║
║  │  Access Token Claims:                                                 │    ║
║  │  { "sub": "uuid", "email": "user@x.com",                            │    ║
║  │    "roles": ["customer"], "exp": 1709123456 }                        │    ║
║  └──────────────────────────────────────────────────────────────────────┘    ║
║           │  5. API call with Bearer token                                    ║
║           ▼                                                                   ║
║  ┌─────────────────────────────────────────────────────────────────────┐    ║
║  │  ISTIO GATEWAY  (port 30000)                                         │    ║
║  │  → validates JWT via RequestAuthentication (JWKS)                    │    ║
║  │  → AuthorizationPolicy: namespace-level L4 rules                     │    ║
║  └──────────────────────────────────────────────────────────────────────┘    ║
║           │                                                                   ║
║           ▼                                                                   ║
║  ┌─────────────────────────────────────────────────────────────────────┐    ║
║  │  ECOM-SERVICE  (Spring Boot)                                         │    ║
║  │  → SecurityConfig: OIDC Resource Server validates JWT                │    ║
║  │  → @PreAuthorize("hasRole('ADMIN')") on admin endpoints              │    ║
║  │  → jwt.getSubject() → user_id for DB queries                         │    ║
║  └──────────────────────────────────────────────────────────────────────┘    ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

---

## 5. OIDC Configuration

**File:** `ui/src/auth/oidcConfig.ts`

```typescript
import { UserManager, WebStorageStateStore } from 'oidc-client-ts'

// All config from Vite env vars — baked in at Docker build time (not runtime)
const AUTHORITY = import.meta.env.VITE_KEYCLOAK_AUTHORITY
// e.g. http://idp.keycloak.net:30000/realms/bookstore

const CLIENT_ID = import.meta.env.VITE_KEYCLOAK_CLIENT_ID
// e.g. ui-client

// Dynamic origin: works from both localhost:30000 AND myecom.net:30000
// Both /callback URIs are registered in Keycloak ui-client redirectUris
const REDIRECT_URI = `${window.location.origin}/callback`

export const userManager = new UserManager({
  authority: AUTHORITY,
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',          // Authorization Code flow
  scope: 'openid profile email roles',

  // PKCE S256 is automatic in oidc-client-ts when response_type='code'
  // The library generates code_verifier, hashes it, and sends code_challenge

  // Tokens in sessionStorage — cleared when tab/browser closes
  // Never in localStorage (survives tab close — too persistent for tokens)
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),

  // Silent token refresh via hidden iframe (30s before expiry)
  automaticSilentRenew: true,
  silent_redirect_uri: `${window.location.origin}/silent-renew.html`,

  // Load user claims from ID token (already have email/name in JWT)
  // Setting false avoids an extra /userinfo round-trip
  loadUserInfo: false,
})
```

### 5.1 Keycloak ui-client Registration

The `ui-client` is registered in the `bookstore` realm with:

```json
{
  "clientId": "ui-client",
  "publicClient": true,              // no client_secret needed
  "directAccessGrantsEnabled": true, // allows password grant (for API testing only)
  "standardFlowEnabled": true,       // Authorization Code flow
  "redirectUris": [
    "http://localhost:30000/*",
    "http://myecom.net:30000/*"
  ],
  "webOrigins": [
    "http://localhost:30000",
    "http://myecom.net:30000"
  ],
  "postLogoutRedirectUris": ["+"],   // inherits from redirectUris
  "defaultClientScopes": [
    "openid", "profile", "email", "roles"
  ]
}
```

### 5.2 Build-Time vs Runtime Config

Vite bakes `VITE_*` env vars into the JavaScript bundle at build time. These cannot be changed after the Docker image is built. This means:

```bash
# Building the ui-service image REQUIRES --build-arg for VITE_ vars
docker build \
  --build-arg VITE_KEYCLOAK_AUTHORITY=http://idp.keycloak.net:30000/realms/bookstore \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
  --build-arg VITE_REDIRECT_URI=http://localhost:30000/callback \
  -t bookstore/ui-service:latest ./ui
```

> The `VITE_REDIRECT_URI` build arg is not actually used at runtime — `oidcConfig.ts` derives the redirect URI dynamically from `window.location.origin`. The build arg is kept for documentation purposes only.

---

## 6. The Full Login Flow — Step by Step

### 6.1 Normal Login from localhost:30000

```
User                Browser (localhost:30000)              Keycloak (idp.keycloak.net:30000)
 │                          │                                          │
 │  clicks Login button     │                                          │
 │─────────────────────────►│                                          │
 │                          │  1. generate code_verifier (64 chars)   │
 │                          │     code_challenge = SHA256(verifier)   │
 │                          │     store verifier in sessionStorage    │
 │                          │                                          │
 │                          │  2. redirect to Keycloak /authorize:    │
 │                          │  GET /realms/bookstore/protocol/         │
 │                          │    openid-connect/auth?                  │
 │                          │    client_id=ui-client                   │
 │                          │    &redirect_uri=localhost:30000/callback│
 │                          │    &code_challenge=<hash>                │
 │                          │    &code_challenge_method=S256           │
 │                          │    &scope=openid profile email roles     │
 │                          │    &state=<csrf-nonce>                   │
 │                          │─────────────────────────────────────────►
 │  Keycloak login page     │                                          │
 │◄─────────────────────────│──────────────────────────────────────────
 │  enters user1/CHANGE_ME  │                                          │
 │─────────────────────────►│                                          │
 │                          │                                          │
 │                          │  3. Keycloak authenticates user          │
 │                          │     stores code_challenge for code=X    │
 │                          │     redirect to:                         │
 │                          │     localhost:30000/callback?code=X      │
 │                          │                                          │
 │                          │◄─────────────────────────────────────────
 │                          │  /callback route renders CallbackPage    │
 │                          │  oidcClient.signinRedirectCallback()     │
 │                          │                                          │
 │                          │  4. POST /token:                        │
 │                          │     code=X                               │
 │                          │     &code_verifier=<original 64 chars>  │
 │                          │     &client_id=ui-client                 │
 │                          │─────────────────────────────────────────►
 │                          │                                          │  verify:
 │                          │                                          │  SHA256(verifier)==challenge
 │                          │                                          │  issue tokens
 │                          │  5. response:                            │
 │                          │     { access_token, id_token,           │
 │                          │       refresh_token, expires_in }        │
 │                          │◄─────────────────────────────────────────
 │                          │                                          │
 │                          │  6. store user in sessionStorage         │
 │                          │     merge guest cart (if any)           │
 │                          │     navigate to returnUrl               │
 │◄─────────────────────────│                                          │
 │  authenticated UI        │                                          │
```

### 6.2 Login Initiated from a Protected Route

When a user navigates directly to `/cart` or `/order-confirmation` without being logged in, `ProtectedRoute` calls `login(location.pathname)`. The returnPath is stored in the OIDC `state` parameter and recovered after callback:

```typescript
// ProtectedRoute.tsx — triggered when user visits /cart without auth
useEffect(() => {
  if (!isLoading && !user) {
    login(location.pathname + location.search)  // e.g. "/cart"
  }
}, [isLoading, user, login, location])

// AuthContext.tsx — login() encodes returnPath in OIDC state
userManager.signinRedirect({
  state: { returnUrl: resolvedPath }  // → stored in sessionStorage with code_verifier
})

// CallbackPage.tsx — recovered after token exchange
const state = user.state as { returnUrl?: string } | undefined
const returnUrl = state?.returnUrl || '/'
navigate(returnUrl)  // → navigates back to /cart
```

### 6.3 Cross-Origin Relay (myecom.net → localhost)

Some configurations require PKCE at `localhost:30000` even when the user started at `myecom.net:30000`. The relay works via URL hash:

```
1. User at myecom.net:30000, crypto.subtle absent
   login() → redirect to http://localhost:30000/login?return=http://myecom.net:30000/cart

2. LoginPage at localhost:30000:
   signinRedirect({ state: { returnUrl: "http://myecom.net:30000/cart" } })

3. After token exchange at localhost:30000/callback:
   returnUrl is absolute → relay via hash
   window.location.href = "http://myecom.net:30000/cart#auth=<base64-encoded-user>"

4. myecom.net:30000 loads AuthContext:
   sees #auth= in URL hash
   User.fromStorageString(decoded) → restore user
   window.history.replaceState(null, '', '/cart')  // clear hash immediately
```

> **Note:** In practice, Chrome treats `http://myecom.net:30000` as a secure context (the hostname resolves to `127.0.0.1` via `/etc/hosts` — loopback). Chrome's secure context check operates on the resolved IP, not the hostname, so `crypto.subtle` IS available and this relay path is not triggered. It remains as a fallback for strict non-secure contexts.

---

## 7. Token Storage Strategy

### 7.1 sessionStorage (What We Use)

```
Keycloak issues tokens
       │
       ▼
oidc-client-ts stores User object
in sessionStorage under key:
  oidc.user:http://idp.keycloak.net:30000/realms/bookstore:ui-client
       │
       ▼
Cleared automatically when:
  - Tab is closed
  - Browser session ends
  - Explicit logout

NOT cleared when:
  - Page is refreshed (still in same tab session)
  - Browser is minimized
  - System sleep/wake
```

### 7.2 Why Not localStorage?

```
localStorage hazard:
  - Survives browser close → token persists until expiry (5 min by default)
  - XSS attack can read localStorage from any script on the page
  - Shared between all tabs → one compromised tab exposes all tabs

sessionStorage benefits:
  - Isolated per tab — one compromised tab cannot read another tab's tokens
  - Cleared on tab close — reduces attack window
  - Still accessible across same-tab page refreshes
```

### 7.3 Why Tokens Are Never in Application State

The `getAccessToken()` function reads directly from the `User` object returned by `userManager.getUser()`. The access token itself is NOT stored in React state (`useState`). Only the `User` object reference is in state. This means:

- The token is read fresh from `sessionStorage` on every API call via `_getToken()` in `api/client.ts`
- If the token is renewed silently, the fresh token is automatically available on the next call
- React state re-renders are triggered by `user` object changes, not token string changes

---

## 8. AuthContext — Shared Authentication State

**File:** `ui/src/auth/AuthContext.tsx`

AuthContext is a React Context that makes authentication state available to the entire component tree without prop drilling.

### 8.1 Context Shape

```typescript
interface AuthContextValue {
  user: User | null      // null = not logged in
  isLoading: boolean     // true during initial session check
  isAdmin: boolean       // derived from access_token roles claim
  login: (returnPath?: string) => void
  logout: () => Promise<void>
  getAccessToken: () => string | null
}
```

### 8.2 Initialization Sequence

```
App mounts
    │
    ▼
AuthProvider renders
    │
    ▼
useEffect runs:
    │
    ├─ Check URL hash for #auth= relay token
    │   └─ if found: restore User from storage string, clear hash
    │
    └─ else: userManager.getUser()
        └─ reads from sessionStorage
            ├─ token found and not expired → setUser(u)
            └─ token missing or expired → setUser(null)
    │
    ▼
Register event listeners:
    userManager.events.addUserLoaded()      → setUser(u) on silent renewal
    userManager.events.addUserUnloaded()    → setUser(null) on logout
    userManager.events.addAccessTokenExpired() → setUser(null)
    │
    ▼
setIsLoading(false)
    │
    ▼
Components render with correct initial state
```

### 8.3 isAdmin Derivation

The `isAdmin` flag is derived from the access token without making any network call:

```typescript
const isAdmin = (() => {
  if (!user?.access_token) return false
  try {
    // JWT is base64url-encoded: header.payload.signature
    // We decode the payload (middle part) without verifying the signature
    // Authorization decisions are still enforced server-side
    const payload = JSON.parse(atob(user.access_token.split('.')[1]))
    const roles: string[] = payload.roles ?? []
    return roles.includes('admin')
  } catch {
    return false
  }
})()
```

> **Security note:** Client-side role decoding is for UX only (showing/hiding UI elements). All admin operations are re-validated server-side by Spring Security's `@PreAuthorize("hasRole('ADMIN')")`. A user who manually sets `isAdmin=true` in browser DevTools gets nothing — the API rejects the request.

### 8.4 Access Token Payload Example

```json
{
  "exp": 1709127056,
  "iat": 1709126756,
  "jti": "f3a2b1c0-...",
  "iss": "http://idp.keycloak.net:30000/realms/bookstore",
  "sub": "9d82bcb3-6e96-462c-bdb9-e677080e8920",
  "typ": "Bearer",
  "azp": "ui-client",
  "session_state": "abc...",
  "acr": "1",
  "scope": "openid email profile roles",
  "email_verified": true,
  "roles": ["customer"],          ← realm roles (from custom mapper)
  "preferred_username": "user1",
  "email": "user1@bookstore.com"
}

// admin1 token:
{
  "roles": ["customer", "admin"],   ← both roles
  "preferred_username": "admin1",
  ...
}
```

---

## 9. Route Protection

### 9.1 Application Routes

**File:** `ui/src/App.tsx`

```typescript
export default function App() {
  return (
    <AuthProvider>
      <AppWithAuth />
    </AuthProvider>
  )
}

function AppWithAuth() {
  const { getAccessToken } = useAuth()
  setTokenProvider(getAccessToken)   // wire token into API client once

  return (
    <BrowserRouter>
      <NavBar />
      <Routes>
        {/* Public routes — accessible without login */}
        <Route path="/"        element={<CatalogPage />} />
        <Route path="/search"  element={<SearchPage />} />
        <Route path="/cart"    element={<CartPage />} />    {/* guest mode until checkout */}
        <Route path="/login"   element={<LoginPage />} />
        <Route path="/callback" element={<CallbackPage />} />

        {/* Protected — requires any valid session */}
        <Route path="/order-confirmation" element={
          <ProtectedRoute><OrderConfirmationPage /></ProtectedRoute>
        } />

        {/* Admin — requires 'admin' realm role */}
        <Route path="/admin"           element={<AdminRoute><AdminDashboard /></AdminRoute>} />
        <Route path="/admin/books"     element={<AdminRoute><AdminBooksPage /></AdminRoute>} />
        <Route path="/admin/books/new" element={<AdminRoute><AdminEditBookPage /></AdminRoute>} />
        <Route path="/admin/books/:id" element={<AdminRoute><AdminEditBookPage /></AdminRoute>} />
        <Route path="/admin/stock"     element={<AdminRoute><AdminStockPage /></AdminRoute>} />
        <Route path="/admin/orders"    element={<AdminRoute><AdminOrdersPage /></AdminRoute>} />
      </Routes>
    </BrowserRouter>
  )
}
```

### 9.2 ProtectedRoute

**File:** `ui/src/components/ProtectedRoute.tsx`

```typescript
export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, login } = useAuth()
  const location = useLocation()

  useEffect(() => {
    // Once loading is done and no user → trigger login
    if (!isLoading && !user) {
      login(location.pathname + location.search)  // preserve destination
    }
  }, [isLoading, user, login, location])

  // Show loading state during initial check OR while redirecting
  if (isLoading || !user) {
    return <div className="loading-state">Redirecting to login...</div>
  }

  return <>{children}</>
}
```

Decision tree:
```
Request /order-confirmation
    │
    ▼
ProtectedRoute renders
    │
    ├─ isLoading=true → show "Redirecting..." (sessionStorage check in progress)
    │
    ├─ isLoading=false, user=null → login('/order-confirmation')
    │   → OIDC redirect → Keycloak → callback → navigate('/order-confirmation')
    │
    └─ isLoading=false, user≠null → render <OrderConfirmationPage />
```

### 9.3 AdminRoute

**File:** `ui/src/components/AdminRoute.tsx`

```typescript
export default function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, isAdmin, login } = useAuth()

  if (isLoading) return <div>Loading...</div>

  if (!user) {
    login('/admin')    // redirect to login, return to /admin after
    return null
  }

  if (!isAdmin) {
    // User is logged in but lacks admin role → show access denied (no redirect)
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <div style={{ background: '#fff5f5', border: '1px solid #fc8181', ... }}>
          <h2 style={{ color: '#c53030' }}>Access Denied</h2>
          <p>You need the <strong>admin</strong> role to access this page.</p>
        </div>
      </div>
    )
  }

  return <>{children}</>  // user is logged in AND has admin role
}
```

---

## 10. API Client — Attaching Tokens to Requests

**File:** `ui/src/api/client.ts`

```typescript
// Token provider is set once at app startup (App.tsx: setTokenProvider(getAccessToken))
let _getToken: (() => string | null) | null = null

export function setTokenProvider(fn: () => string | null) {
  _getToken = fn
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = _getToken?.()      // read current token (from sessionStorage)

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers ?? {}),
    // Attach token only if available — public endpoints work without it
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }

  const resp = await fetch(url, { ...options, headers })

  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText)
    throw new Error(`HTTP ${resp.status}: ${text}`)
  }

  if (resp.status === 204) return undefined as T
  return resp.json()
}

export const api = {
  get:    <T>(url: string)               => request<T>(url),
  post:   <T>(url: string, body: unknown) => request<T>(url, { method: 'POST', body: JSON.stringify(body) }),
  put:    <T>(url: string, body: unknown) => request<T>(url, { method: 'PUT',  body: JSON.stringify(body) }),
  delete: <T>(url: string)               => request<T>(url, { method: 'DELETE' }),
}
```

### 10.1 Request Header Example

For authenticated requests, every call sends:

```http
GET /ecom/cart HTTP/1.1
Host: api.service.net:30000
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json
```

For public API calls (e.g. `GET /ecom/books`), the header is omitted if there is no token — the request still succeeds because Spring Security allows public endpoints without authentication.

---

## 11. Authorization — Role-Based Access Control

Authorization is enforced at three layers:

### 11.1 Layer 1: Istio RequestAuthentication (JWT Validation)

**File:** `infra/istio/security/request-auth.yaml`

```yaml
apiVersion: security.istio.io/v1
kind: RequestAuthentication
metadata:
  name: keycloak-jwt
  namespace: ecom
spec:
  jwtRules:
    - issuer: "http://idp.keycloak.net:30000/realms/bookstore"
      jwksUri: "http://keycloak.identity.svc.cluster.local:8080/realms/bookstore/protocol/openid-connect/certs"
      forwardOriginalToken: true   # passes validated JWT to the pod
```

Istio's ztunnel fetches the JWKS (public keys) from Keycloak and validates every JWT's signature, expiry, and issuer. An invalid token returns `401 Unauthorized` before the request reaches the pod.

### 11.2 Layer 2: Istio AuthorizationPolicy (Network-Level)

**File:** `infra/istio/security/authz-policies/ecom-service-policy.yaml`

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: ecom-service-policy
  namespace: ecom
spec:
  selector:
    matchLabels:
      app: ecom-service
  rules:
    # Allow: traffic from Istio gateway (external users)
    - from:
        - source:
            namespaces: ["infra"]
    # Allow: ui-service nginx proxy (same namespace)
    - from:
        - source:
            namespaces: ["ecom"]
    # Allow: Prometheus scraping
    - from:
        - source:
            namespaces: ["observability"]
```

This is L4-only (no waypoint proxy in Istio Ambient). It enforces namespace isolation — only traffic from `infra`, `ecom`, and `observability` namespaces can reach ecom-service. Direct pod-to-pod calls from other namespaces are blocked by ztunnel.

### 11.3 Layer 3: Spring Security (Application-Level)

**File:** `ecom-service/src/main/java/com/bookstore/ecom/config/SecurityConfig.java`

```java
@Configuration
@EnableMethodSecurity(prePostEnabled = true)
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        return http
            .authorizeHttpRequests(auth -> auth
                // Public — no token required
                .requestMatchers(GET, "/ecom/books/**").permitAll()
                .requestMatchers("/ecom/books/search").permitAll()
                .requestMatchers("/actuator/health/**").permitAll()

                // Protected — any valid JWT
                .requestMatchers("/ecom/cart/**").authenticated()
                .requestMatchers(POST, "/ecom/checkout").authenticated()

                // Admin — JWT with 'admin' role (enforced by @PreAuthorize below)
                .requestMatchers("/ecom/admin/**").authenticated()
                .anyRequest().authenticated()
            )
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtConverter()))
            )
            .csrf(csrf -> csrf.disable())   // Istio mTLS replaces CSRF for API
            .sessionManagement(session ->
                session.sessionCreationPolicy(SessionCreationPolicy.STATELESS)
            )
            .build()
    }
}
```

**Admin endpoint protection with `@PreAuthorize`:**

```java
// AdminBookController.java
@RestController
@RequestMapping("/ecom/admin/books")
@PreAuthorize("hasRole('ADMIN')")  // ← rejected at method entry if role missing
public class AdminBookController {

    @GetMapping
    public List<BookResponse> listBooks() { ... }

    @PostMapping
    public ResponseEntity<BookResponse> createBook(@Valid @RequestBody BookRequest req) { ... }

    @PutMapping("/{id}")
    public BookResponse updateBook(@PathVariable UUID id, @RequestBody BookRequest req) { ... }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteBook(@PathVariable UUID id) { ... }
}
```

**JWT Role Converter** (maps Keycloak `roles` claim to Spring Security authorities):

```java
// JwtAuthenticationConverter reads the 'roles' array from the token payload
// and converts each role to a GrantedAuthority with ROLE_ prefix
// so hasRole('ADMIN') matches the 'admin' value in Keycloak
private JwtAuthenticationConverter jwtConverter() {
    var converter = new JwtAuthenticationConverter();
    converter.setJwtGrantedAuthoritiesConverter(jwt -> {
        List<String> roles = jwt.getClaimAsStringList("roles");
        if (roles == null) return List.of();
        return roles.stream()
            .map(r -> new SimpleGrantedAuthority("ROLE_" + r.toUpperCase()))
            .collect(Collectors.toList());
    });
    return converter;
}
```

### 11.4 Three-Layer Authorization Matrix

```
Request: GET /ecom/admin/books  (no token)
   │
   ▼
Istio RequestAuthentication: no JWT → pass (permitAll, JWT not required at this layer)
   │
   ▼
Spring Security: .requestMatchers("/ecom/admin/**").authenticated()
   → JWT missing → 401 Unauthorized
   (request never reaches controller)

Request: GET /ecom/admin/books  (token with roles=["customer"])
   │
   ▼
Istio RequestAuthentication: JWT valid → forward to pod
   │
   ▼
Spring Security: JWT present → authenticated=true
   → reach controller
   │
   ▼
@PreAuthorize("hasRole('ADMIN')"): roles=["ROLE_CUSTOMER"] → no ROLE_ADMIN
   → 403 Forbidden

Request: GET /ecom/admin/books  (token with roles=["customer","admin"])
   │
   ▼
Istio: valid JWT → pass
Spring Security: authenticated → pass
@PreAuthorize: ROLE_ADMIN present → allow → 200 OK
```

---

## 12. Guest Cart — Pre-Login Persistence

Users can add books to cart before logging in. The guest cart is stored in `localStorage` (appropriate for non-sensitive shopping data, not tokens).

**File:** `ui/src/hooks/useGuestCart.ts`

```typescript
const GUEST_CART_KEY = 'bookstore_guest_cart'

export function addToGuestCart(item: Omit<GuestCartItem, 'quantity'>): GuestCartItem[] {
  const cart = getGuestCart()
  const existing = cart.find(i => i.bookId === item.bookId)
  if (existing) {
    existing.quantity++
  } else {
    cart.push({ ...item, quantity: 1 })
  }
  localStorage.setItem(GUEST_CART_KEY, JSON.stringify(cart))
  return cart
}
```

### 12.1 Cart Merge on Login

**File:** `ui/src/pages/CallbackPage.tsx`

After OIDC callback and token receipt, pending guest cart items are merged into the server cart:

```typescript
const pending = getGuestCart()    // read from localStorage
if (pending.length > 0) {
  await Promise.allSettled(
    pending.map(item =>
      fetch('/ecom/cart', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.access_token}`,  // fresh token
        },
        body: JSON.stringify({ bookId: item.bookId, quantity: item.quantity }),
      })
    )
  )
  clearGuestCart()   // remove from localStorage after successful merge
}
```

---

## 13. Logout Flow

**File:** `ui/src/auth/AuthContext.tsx`

```typescript
const logout = useCallback(async () => {
  // 1. Remove user from sessionStorage immediately
  //    App shows unauthenticated state before Keycloak redirect completes
  await userManager.removeUser()
  setUser(null)

  // 2. Redirect to Keycloak end_session_endpoint
  //    Keycloak invalidates the session server-side (SSO logout)
  //    post_logout_redirect_uri must match registerd postLogoutRedirectUris in Keycloak
  //    Trailing slash is required to match http://localhost:30000/* wildcard
  await userManager.signoutRedirect({
    post_logout_redirect_uri: window.location.origin + '/',
  })
}, [])
```

Keycloak logout URL:
```
GET http://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/logout
  ?post_logout_redirect_uri=http://localhost:30000/
  &id_token_hint=<id_token>
```

This invalidates the Keycloak session (SSO), preventing the user from being silently re-authenticated via other apps using the same realm.

---

## 14. Silent Token Renewal

Access tokens expire after 5 minutes. The `oidc-client-ts` library handles renewal automatically using a hidden iframe:

```
T+0:00   User logs in → access_token expires at T+5:00
T+4:30   automaticSilentRenew triggers (30s before expiry)
          hidden iframe loads: /silent-renew.html
          iframe calls: userManager.signinSilentCallback()
          → uses refresh_token to get new access_token from Keycloak
          → userManager.events.userLoaded fires
          → AuthContext setUser(newUser)
T+5:00   Old token expired — new token already in sessionStorage
T+34:30  Refresh token expires → silent renewal fails
          → events.accessTokenExpired → setUser(null)
          → NavBar shows Login button
```

The `silent-renew.html` file (served as a static asset):
```html
<!DOCTYPE html>
<html>
<head><title>Silent Renew</title></head>
<body>
<script src="/oidc-client-ts.min.js"></script>
<script>
  new UserManager().signinSilentCallback()
</script>
</body>
</html>
```

---

## 15. Server-Side Enforcement (Istio + Spring Security)

Even if the React UI is bypassed entirely (e.g. `curl` from terminal), all security is enforced:

```bash
# Public endpoint — no token needed
curl http://api.service.net:30000/ecom/books
# → 200 OK

# Protected endpoint — no token
curl http://api.service.net:30000/ecom/cart
# → 401 Unauthorized

# Admin endpoint — customer token
TOKEN=$(curl -s -X POST http://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token \
  -d "grant_type=password&client_id=ui-client&username=user1&password=CHANGE_ME" \
  -H "Content-Type: application/x-www-form-urlencoded" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
curl -H "Authorization: Bearer $TOKEN" http://api.service.net:30000/ecom/admin/books
# → 403 Forbidden

# Admin endpoint — admin token
ADMIN_TOKEN=$(curl -s -X POST http://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token \
  -d "grant_type=password&client_id=ui-client&username=admin1&password=CHANGE_ME" \
  -H "Content-Type: application/x-www-form-urlencoded" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://api.service.net:30000/ecom/admin/books
# → 200 OK with book list
```

---

## 16. Security Invariants

These must be maintained if the authentication system is modified:

| Invariant | Mechanism | If Broken |
|-----------|-----------|-----------|
| Tokens never in localStorage | `WebStorageStateStore(sessionStorage)` | XSS can steal tokens |
| Client secret never in browser | Public client, PKCE flow | Not applicable (no secret exists) |
| Server re-validates every request | Spring Security `oauth2ResourceServer()` | Client-side auth bypass works |
| Admin role checked server-side | `@PreAuthorize("hasRole('ADMIN')")` | UI-only admin check is bypassable |
| Logout invalidates server session | `signoutRedirect()` with Keycloak end_session | SSO sessions persist |
| PKCE verifier never leaves browser | Library internal (not in URL, not logged) | Code interception possible |

---

## 17. Customization Guide

### 17.1 Adding a New Protected Route

```typescript
// 1. Add route in App.tsx wrapped with ProtectedRoute
<Route path="/profile" element={
  <ProtectedRoute><ProfilePage /></ProtectedRoute>
} />

// 2. Access user data in the component
function ProfilePage() {
  const { user } = useAuth()
  return <div>Hello, {user?.profile.email}</div>
}
```

### 17.2 Adding a New Role

To add a `manager` role with access to specific pages:

**Step 1: Create role in Keycloak**
```bash
# Via Keycloak admin console at localhost:32400/admin
# Realm → Roles → Add Role: "manager"
# Assign to relevant users: Users → <user> → Role Mappings
```

**Step 2: Create a ManagerRoute component**
```typescript
// ui/src/components/ManagerRoute.tsx
export default function ManagerRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, login } = useAuth()

  const isManager = (() => {
    if (!user?.access_token) return false
    const payload = JSON.parse(atob(user.access_token.split('.')[1]))
    return (payload.roles ?? []).includes('manager')
  })()

  if (isLoading) return <div>Loading...</div>
  if (!user) { login('/manager'); return null }
  if (!isManager) return <div>Access Denied — requires manager role</div>
  return <>{children}</>
}
```

**Step 3: Add backend enforcement**
```java
// In your controller
@PreAuthorize("hasRole('MANAGER')")
public ResponseEntity<?> managerEndpoint() { ... }
```

### 17.3 Extending the Access Token Lifetime

Edit `infra/keycloak/realm-export.json`:

```json
{
  "accessTokenLifespan": 900,           // 15 minutes (default: 300s)
  "refreshTokenMaxReuse": 0,
  "ssoSessionIdleTimeout": 1800,        // 30 minutes
  "ssoSessionMaxLifespan": 36000        // 10 hours
}
```

Then re-import the realm:
```bash
bash scripts/keycloak-import.sh
```

### 17.4 Adding a Custom Claim to the Token

To add a `department` claim from a user attribute:

**Step 1: Add attribute to user** (Keycloak Admin → Users → Attributes: `department=engineering`)

**Step 2: Add mapper to ui-client scope** (Keycloak Admin → Clients → ui-client → Client Scopes → Add mapper → User Attribute → name: `department`, Token Claim Name: `department`)

**Step 3: Read in the UI**
```typescript
const payload = JSON.parse(atob(user.access_token.split('.')[1]))
const department: string = payload.department ?? 'unknown'
```

**Step 4: Read in Spring Security**
```java
@GetMapping("/profile")
public Map<String, Object> profile(@AuthenticationPrincipal Jwt jwt) {
  return Map.of(
    "sub", jwt.getSubject(),
    "email", jwt.getClaimAsString("email"),
    "department", jwt.getClaimAsString("department")
  );
}
```

### 17.5 Changing the Token Storage to Cookies (Advanced)

If your security requirements mandate HTTP-only cookies for refresh tokens:

1. Implement a BFF (Backend for Frontend) pattern — the ecom-service receives the authorization code and exchanges it for tokens, then sets an `HttpOnly; Secure; SameSite=Strict` cookie
2. The UI never sees the refresh token
3. The BFF validates the cookie session on every API call and injects the access token into the backend request

This is a significant architectural change — the current sessionStorage approach is appropriate for same-origin SPAs.

---

## 18. Troubleshooting

### 18.1 Login Redirect Loop

**Symptom:** Browser keeps redirecting between app and Keycloak without logging in.

**Causes:**
- `redirect_uri` in `oidcConfig.ts` doesn't match Keycloak `redirectUris` exactly
- `code_challenge` method mismatch (Keycloak requires S256)
- Keycloak session cookie blocked (third-party cookie restrictions)

**Debug:**
```bash
# Check Keycloak client config
curl -s "http://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/.well-known/openid-configuration" | python3 -m json.tool | grep -E "authorization|token|jwks"
```

### 18.2 401 on Protected API Calls

**Symptom:** Logged-in user gets 401 from `/ecom/cart`.

**Causes:**
- Access token expired (5 min) and silent renewal failed
- JWKS URL in Spring Security config doesn't match Keycloak issuer

**Debug:**
```bash
# Decode token to check expiry (replace with your token)
TOKEN="eyJ..."
echo "${TOKEN}" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool | grep -E "exp|iat|iss"
```

### 18.3 403 on Admin API Calls

**Symptom:** admin1 user gets 403 on `/ecom/admin/books`.

**Causes:**
- `admin` role not assigned to user in Keycloak realm (not client)
- JWT converter not reading `roles` claim correctly (check claim path)

**Debug:**
```bash
# Decode admin token and check roles
ADMIN_TOKEN=$(curl -s -X POST http://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token \
  -d "grant_type=password&client_id=ui-client&username=admin1&password=CHANGE_ME" \
  -H "Content-Type: application/x-www-form-urlencoded" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
echo "${ADMIN_TOKEN}" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('roles:', d.get('roles'))"
```

### 18.4 sub Claim Missing (null user_id)

**Symptom:** Cart items fail to save with `null value in column "user_id"`.

**Cause:** Custom realm import removed built-in `openid` scope including the `sub` claim mapper.

**Fix:** The `oidc-sub-mapper` is included in `realm-export.json`:
```json
{
  "name": "sub",
  "protocol": "openid-connect",
  "protocolMapper": "oidc-sub-mapper",
  "consentRequired": false
}
```
Re-import realm: `bash scripts/keycloak-import.sh`

---

## 19. Screenshot Reference

Screenshots are captured during E2E runs and saved to `e2e/screenshots/`:

| File | Content |
|------|---------|
| `auth-setup-01-homepage.png` | Catalog page before login — Login button visible |
| `auth-setup-02-keycloak-login.png` | Keycloak login form (PKCE redirect) |
| `auth-setup-03-credentials-filled.png` | Login form with user1 credentials |
| `auth-setup-04-logged-in.png` | App after login — user email in NavBar |
| `auth-01-logged-in-state.png` | Authenticated NavBar with user email + Logout |
| `auth-02-no-localstorage-tokens.png` | DevTools showing empty localStorage (tokens in sessionStorage) |
| `auth-03-before-logout.png` | NavBar before clicking Logout |
| `auth-04-logout-redirect.png` | Keycloak logout confirmation / redirect back |
| `auth-05-logged-out-fresh-page.png` | App after logout — Login button, no user state |
| `auth-06-unauth-cart-redirect.png` | Redirect to Keycloak when unauthenticated user tries checkout |
| `admin-01-navbar-admin-link.png` | NavBar showing gold Admin link for admin1 |
| `admin-02-dashboard.png` | Admin dashboard with stats |
| `admin-03-books-list.png` | Admin books management table |
| `admin-04-create-book-form.png` | Book creation form |
| `admin-05-stock-management.png` | Stock management page |
| `admin-06-orders-list.png` | All orders table (admin only) |
| `api-02-keycloak-openid-config.png` | Keycloak OIDC discovery endpoint response |

---

*Generated by Claude Code — Session 22 (Debezium Server migration)*
