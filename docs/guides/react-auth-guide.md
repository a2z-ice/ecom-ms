# React Authentication, Authorization & Security: A Complete Guide

> **From Zero to Production** -- Learn OAuth2 / OIDC, JWT handling, CSRF protection, and secure API architecture in React by walking through a real production codebase line by line.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [OAuth2 & OpenID Connect Fundamentals](#2-oauth2--openid-connect-fundamentals)
3. [OIDC Configuration (`oidcConfig.ts`)](#3-oidc-configuration-oidcconfigts)
4. [Authentication Context (`AuthContext.tsx`)](#4-authentication-context-authcontexttsx)
5. [The Login Flow — Step by Step](#5-the-login-flow--step-by-step)
6. [The Callback Page (`CallbackPage.tsx`)](#6-the-callback-page-callbackpagetsx)
7. [Silent Token Renewal](#7-silent-token-renewal)
8. [The Logout Flow](#8-the-logout-flow)
9. [JWT Decoding & Role Extraction](#9-jwt-decoding--role-extraction)
10. [Route Protection (`ProtectedRoute.tsx` & `AdminRoute.tsx`)](#10-route-protection-protectedroutetsx--adminroutetsx)
11. [CSRF Token Management](#11-csrf-token-management)
12. [The API Client (`client.ts`)](#12-the-api-client-clientts)
13. [Domain API Modules (`books.ts`, `cart.ts`, `admin.ts`)](#13-domain-api-modules-booksts-cartts-admints)
14. [Application Wiring (`App.tsx` & `main.tsx`)](#14-application-wiring-apptsx--maintsx)
15. [Guest Cart & Cart Merge on Login](#15-guest-cart--cart-merge-on-login)
16. [Navigation & Conditional UI (`NavBar.tsx`)](#16-navigation--conditional-ui-navbartsx)
17. [Token Storage Security Model](#17-token-storage-security-model)
18. [Cross-Origin Authentication Relay](#18-cross-origin-authentication-relay)
19. [Complete Data Flow Diagrams](#19-complete-data-flow-diagrams)
20. [TypeScript Generics — The `<T>` Syntax](#20-typescript-generics--the-t-syntax)
21. [Promises & Async/Await Deep Dive](#21-promises--asyncawait-deep-dive)
22. [Spread & Destructuring — The `...` Syntax](#22-spread--destructuring--the--syntax)
23. [Advanced React Patterns Used in This App](#23-advanced-react-patterns-used-in-this-app)
24. [Summary & Security Checklist](#24-summary--security-checklist)

---

## 1. Architecture Overview

This React application is part of a microservices e-commerce platform. The security architecture spans multiple layers:

```
                    +------------------+
                    |   React SPA      |   (ui/)
                    |   Port 30000     |
                    +--------+---------+
                             |
                    HTTPS (TLS terminated at Istio Gateway)
                             |
              +--------------+--------------+
              |                             |
    +---------v----------+     +------------v-----------+
    | Keycloak (IdP)     |     | Istio ext_authz        |
    | OIDC / OAuth2      |     | CSRF Validation        |
    | Port 30000         |     | (csrf-service, Go)     |
    +--------------------+     +------------------------+
                                        |
              +-------------------------+------------------------+
              |                                                  |
    +---------v----------+                          +------------v-----------+
    | E-Commerce Service |    mTLS (Istio)          | Inventory Service      |
    | Spring Boot 4.0    | -----------------------> | FastAPI (Python)       |
    | /ecom/*            |                          | /inven/*               |
    +--------------------+                          +------------------------+
```

### Security Layers

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Authentication** | Keycloak + OIDC PKCE | Verify user identity |
| **Authorization** | JWT roles + React route guards | Control access to features |
| **Transport** | HTTPS + Istio mTLS | Encrypt all traffic |
| **CSRF Protection** | Gateway-level csrf-service | Prevent cross-site request forgery |
| **Token Storage** | In-memory + sessionStorage | Prevent token theft via XSS |

### Source File Map

```
ui/src/
  auth/
    oidcConfig.ts        ← OIDC UserManager configuration
    AuthContext.tsx       ← React Context for auth state + login/logout
  api/
    client.ts            ← HTTP client with JWT + CSRF headers
    books.ts             ← Book catalog & stock API
    cart.ts              ← Shopping cart API
    admin.ts             ← Admin CRUD APIs
  components/
    ProtectedRoute.tsx   ← Route guard: requires authentication
    AdminRoute.tsx       ← Route guard: requires admin role
    NavBar.tsx           ← Navigation with auth-aware UI
    ErrorBoundary.tsx    ← Global error catching
    Toast.tsx            ← User feedback notifications
    StockBadge.tsx       ← Stock status indicator
  hooks/
    useGuestCart.ts      ← Guest cart in localStorage
  pages/
    LoginPage.tsx        ← Initiates OIDC redirect
    CallbackPage.tsx     ← Handles OIDC callback + cart merge
    CatalogPage.tsx      ← Book listing (public)
    SearchPage.tsx       ← Book search (public)
    CartPage.tsx         ← Shopping cart (guest + auth)
    OrderConfirmationPage.tsx  ← Post-checkout (protected)
    NotFoundPage.tsx     ← 404 fallback
    admin/               ← Admin pages (code-split, lazy loaded)
  App.tsx                ← Root component with routing
  main.tsx               ← Application entry point
```

---

## 2. OAuth2 & OpenID Connect Fundamentals

Before diving into code, let's understand the protocol this application implements.

### What is OAuth2?

OAuth2 is an **authorization framework** that lets a user grant a third-party application limited access to their resources without sharing their password. The key actors:

| Actor | In Our App | Role |
|-------|-----------|------|
| **Resource Owner** | The user (customer/admin) | Owns the data |
| **Client** | React SPA (`ui-client`) | Wants access to the user's data |
| **Authorization Server** | Keycloak | Issues tokens after authentication |
| **Resource Server** | ecom-service, inventory-service | Protects APIs, validates tokens |

### What is OpenID Connect (OIDC)?

OIDC is an **identity layer** built on top of OAuth2. While OAuth2 only handles authorization ("can this app access my data?"), OIDC adds authentication ("who is this user?"). It introduces:

- **ID Token**: A JWT containing user identity claims (name, email, roles)
- **UserInfo Endpoint**: An API to fetch user profile data
- **Discovery Document**: A `.well-known/openid-configuration` URL that describes the IdP's capabilities

### Authorization Code Flow with PKCE

This app uses the most secure OAuth2 flow for SPAs: **Authorization Code Flow with Proof Key for Code Exchange (PKCE)**.

```
Step 1: Generate PKCE Challenge
  ┌──────────────┐
  │  React SPA   │  generates: code_verifier (random string)
  │              │  computes:  code_challenge = SHA256(code_verifier)
  └──────┬───────┘
         │
Step 2: Authorization Request
         │  GET /realms/bookstore/protocol/openid-connect/auth
         │    ?response_type=code
         │    &client_id=ui-client
         │    &redirect_uri=https://localhost:30000/callback
         │    &scope=openid profile email roles
         │    &code_challenge=<hash>
         │    &code_challenge_method=S256
         ▼
  ┌──────────────┐
  │   Keycloak   │  Shows login form → user authenticates
  │              │  Redirects to: /callback?code=<authorization_code>
  └──────┬───────┘
         │
Step 3: Token Exchange (happens in browser via oidc-client-ts)
         │  POST /realms/bookstore/protocol/openid-connect/token
         │    grant_type=authorization_code
         │    &code=<authorization_code>
         │    &code_verifier=<original_random_string>
         │    &redirect_uri=https://localhost:30000/callback
         │    &client_id=ui-client
         ▼
  ┌──────────────┐
  │   Keycloak   │  Verifies: SHA256(code_verifier) == code_challenge
  │              │  Returns: { access_token, id_token, refresh_token }
  └──────────────┘
```

**Why PKCE?** Without PKCE, an attacker who intercepts the authorization code (via browser history, logs, or a malicious browser extension) could exchange it for tokens. PKCE ensures that only the original requester (who knows the `code_verifier`) can complete the exchange.

### JWTs (JSON Web Tokens)

Tokens returned by Keycloak are JWTs — Base64-encoded JSON objects with three parts:

```
header.payload.signature
  │       │        │
  │       │        └── Cryptographic signature (verified by backend services)
  │       └── Claims: { sub, email, roles, exp, iss, ... }
  └── Algorithm info: { alg: "RS256", typ: "JWT" }
```

**Important**: The React app decodes the payload (for UI decisions like showing admin links) but **never verifies the signature**. Signature verification happens server-side — the backend services use Keycloak's JWKS (JSON Web Key Set) endpoint to verify every token.

### JWKS (JSON Web Key Set)

JWKS is a set of public keys published by Keycloak at:
```
https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/certs
```

Backend services (Spring Boot, FastAPI) fetch these keys and use them to verify JWT signatures. The React app never interacts with JWKS directly — that's a server-side concern.

---

## 3. OIDC Configuration (`oidcConfig.ts`)

This file configures the `UserManager` from the `oidc-client-ts` library — the engine that drives the entire OIDC flow.

### Full Source

```typescript
// File: ui/src/auth/oidcConfig.ts

import { UserManager, WebStorageStateStore } from 'oidc-client-ts'
```

**Line 1**: Import two classes from the `oidc-client-ts` library:
- `UserManager`: The central class that manages the entire OIDC lifecycle — login redirects, token exchange, silent renewal, and logout.
- `WebStorageStateStore`: An adapter that tells `UserManager` which browser storage mechanism to use for persisting user session data.

```typescript
// All config from Vite env vars (injected at build time via ConfigMap in k8s)
const AUTHORITY = import.meta.env.VITE_KEYCLOAK_AUTHORITY   // e.g. https://idp.keycloak.net:30000/realms/bookstore
const CLIENT_ID = import.meta.env.VITE_KEYCLOAK_CLIENT_ID   // ui-client
```

**Lines 3-5**: Read configuration from Vite environment variables.

- `import.meta.env` is Vite's way of exposing environment variables. Only variables prefixed with `VITE_` are exposed to client code (security measure — prevents leaking server-side secrets).
- `AUTHORITY` is the OIDC "authority" URL — the base URL of the Keycloak realm. `oidc-client-ts` appends `/.well-known/openid-configuration` to discover all endpoints automatically.
- `CLIENT_ID` identifies this application in Keycloak. The value `ui-client` corresponds to a client registration in the `bookstore` realm.
- These values are baked into the JavaScript bundle at build time (not runtime), because Vite replaces `import.meta.env.VITE_*` during the build step.

```typescript
// redirect_uri is derived from the current origin so the OIDC callback returns to the same
// host the user started from (localhost:30000 or myecom.net:30000). Both /callback paths
// are registered in Keycloak's ui-client redirectUris.
const REDIRECT_URI = `${window.location.origin}/callback`
```

**Lines 7-10**: Compute the redirect URI dynamically.

- `window.location.origin` returns the current protocol + hostname + port (e.g., `https://myecom.net:30000`).
- The app can be accessed from two origins: `https://localhost:30000` and `https://myecom.net:30000`. Both are registered as valid redirect URIs in Keycloak.
- Using dynamic origin means the callback always returns to whichever host the user started from — no hardcoded URLs needed.

```typescript
export const userManager = new UserManager({
  authority: AUTHORITY,
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: 'openid profile email roles',
```

**Lines 12-17**: Create and export the `UserManager` singleton.

- `authority`: Points to the Keycloak realm. `oidc-client-ts` will fetch the discovery document at `{authority}/.well-known/openid-configuration` to learn all endpoint URLs (authorize, token, userinfo, end_session, jwks_uri).
- `client_id`: The OAuth2 client identifier registered in Keycloak.
- `redirect_uri`: Where Keycloak sends the user after authentication.
- `response_type: 'code'`: Selects the **Authorization Code Flow**. The alternative `'token'` (Implicit Flow) is deprecated for security reasons.
- `scope`: The permissions requested:
  - `openid` — Required for OIDC; triggers ID token issuance
  - `profile` — Includes name, family_name, etc. in the ID token
  - `email` — Includes email in the ID token
  - `roles` — Custom scope mapped in Keycloak to include realm roles in the access token

```typescript
  // PKCE is enabled by default in oidc-client-ts when response_type is 'code'
```

**Line 19**: Important note — PKCE (S256) is automatically enabled by `oidc-client-ts` when using `response_type: 'code'`. No explicit configuration needed. The library generates the `code_verifier` and `code_challenge` internally.

```typescript
  // Tokens in sessionStorage — cleared on tab close (never localStorage)
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
```

**Lines 21-22**: Configure token storage.

- `WebStorageStateStore` wraps a Web Storage API implementation (either `sessionStorage` or `localStorage`).
- `window.sessionStorage` is chosen deliberately:
  - Data is cleared when the browser tab closes
  - Data is not shared between tabs
  - This limits the window of exposure if an XSS attack occurs
- `localStorage` would persist tokens across sessions and tabs — a larger attack surface

```typescript
  // Silent token refresh via hidden iframe
  automaticSilentRenew: true,
  silent_redirect_uri: `${window.location.origin}/silent-renew.html`,
```

**Lines 24-26**: Enable automatic token renewal.

- `automaticSilentRenew: true`: Tells `oidc-client-ts` to automatically refresh the access token before it expires, using a hidden iframe.
- `silent_redirect_uri`: Points to a minimal HTML page that the iframe loads. Keycloak redirects the iframe to this URL with new tokens.
- This provides seamless token renewal without interrupting the user.

```typescript
  // Load user info from ID token claims (not userinfo endpoint)
  loadUserInfo: false,
})
```

**Lines 28-30**: Disable the userinfo endpoint call.

- When `true`, `oidc-client-ts` would make an additional HTTP request to Keycloak's `/userinfo` endpoint after getting tokens.
- When `false`, user claims are read directly from the ID token (which already contains everything we need: email, name, roles).
- This saves one network round-trip on every login.

---

## 4. Authentication Context (`AuthContext.tsx`)

The `AuthContext` is the central nervous system of authentication in the React app. It provides auth state and methods to every component via React Context.

### Interface Definition

```typescript
// File: ui/src/auth/AuthContext.tsx

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'
import { User } from 'oidc-client-ts'
import { userManager } from './oidcConfig'
```

**Lines 1-9**: Import React hooks and types.

- `createContext`: Creates a React Context object for sharing auth state across the component tree without prop drilling.
- `useCallback`: Memoizes functions so they maintain referential equality across renders (prevents unnecessary re-renders of child components).
- `useContext`: Consumes the context value from within a component.
- `useEffect`: Runs side effects (event subscriptions, async initialization).
- `useState`: Manages component-local state.
- `User`: The `oidc-client-ts` type representing an authenticated user (contains access_token, id_token, profile claims, etc.).
- `userManager`: The singleton configured in `oidcConfig.ts`.

```typescript
interface AuthContextValue {
  user: User | null
  isLoading: boolean
  isAdmin: boolean
  login: (returnPath?: string) => void
  logout: () => Promise<void>
  getAccessToken: () => string | null
}
```

**Lines 11-18**: TypeScript interface defining what the context provides.

- `user`: The authenticated user object, or `null` if not logged in. Contains `access_token`, `id_token`, `profile` (with email, name), `refresh_token`, and `expires_at`.
- `isLoading`: `true` during initial auth check (prevents flash of "not logged in" UI).
- `isAdmin`: Derived from JWT claims — `true` if the user has the `admin` role.
- `login(returnPath?)`: Initiates OIDC login flow. Optional `returnPath` saves where to redirect after login.
- `logout()`: Ends the session (both local and Keycloak-side). Returns a Promise because it makes a network call.
- `getAccessToken()`: Returns the raw JWT string for API calls, or `null` if not authenticated.

```typescript
const AuthContext = createContext<AuthContextValue | null>(null)
```

**Line 20**: Create the context with a default value of `null`. Components that try to use this context outside of `AuthProvider` will get `null` (and the `useAuth` hook below will throw a helpful error).

### The AuthProvider Component

```typescript
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
```

**Lines 22-24**: The provider component manages two pieces of state:

- `user`: Initially `null` — we don't know yet if there's an existing session.
- `isLoading`: Initially `true` — the app is checking for an existing session. This prevents the UI from briefly showing "Login" before discovering the user is already authenticated.

### Initialization Effect

```typescript
  useEffect(() => {
    // Check for cross-origin auth relay: token passed in URL hash from localhost login flow.
    const rawHash = window.location.hash
    const hashRelay = rawHash.startsWith('#auth=') ? rawHash.slice('#auth='.length) : null

    ;(async () => {
      if (hashRelay) {
        try {
          const relayedUser = User.fromStorageString(decodeURIComponent(hashRelay))
          window.history.replaceState(null, '', window.location.pathname + window.location.search)
          await userManager.storeUser(relayedUser)
          setUser(relayedUser)
          setIsLoading(false)
          return
        } catch (e) {
          console.error('Auth relay restore failed:', e)
        }
      }
      const u = await userManager.getUser()
      setUser(u)
      setIsLoading(false)
    })()
```

**Lines 26-51**: This effect runs once on mount. It handles two scenarios:

**Scenario A: Cross-origin auth relay** (lines 30-47)
- Checks if the URL contains `#auth=<encoded-user-data>`.
- This happens when a user at `https://myecom.net:30000` had to authenticate via `https://localhost:30000` (because `crypto.subtle` wasn't available at the original origin).
- `User.fromStorageString()` deserializes the user from the encoded string.
- `window.history.replaceState(...)` immediately removes the token from the URL (and browser history) — security measure to prevent token leakage.
- `userManager.storeUser()` persists the user in sessionStorage so subsequent `getUser()` calls return it.

**Scenario B: Normal session restoration** (lines 48-50)
- `userManager.getUser()` checks sessionStorage for an existing session.
- If the user previously logged in (same tab, page refresh), their session is restored.
- If no session exists, `u` is `null`.

### Event Subscriptions

```typescript
    const handleUserLoaded = (u: User) => setUser(u)
    const handleUserUnloaded = () => setUser(null)

    userManager.events.addUserLoaded(handleUserLoaded)
    userManager.events.addUserUnloaded(handleUserUnloaded)
    userManager.events.addAccessTokenExpired(() => setUser(null))

    return () => {
      userManager.events.removeUserLoaded(handleUserLoaded)
      userManager.events.removeUserUnloaded(handleUserUnloaded)
    }
  }, [])
```

**Lines 53-64**: Subscribe to `oidc-client-ts` events.

- `userLoaded`: Fires when a new user session is established (after login or silent renewal). Updates React state with the fresh user.
- `userUnloaded`: Fires when the user session is removed (logout). Clears React state.
- `accessTokenExpired`: Fires when the access token expires and silent renewal failed. Clears state to force re-login.
- The cleanup function (returned from `useEffect`) removes event listeners when the component unmounts — prevents memory leaks.
- `[]` dependency array means this effect runs only once.

### Login Method

```typescript
  const login = useCallback((returnPath?: string) => {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      window.location.href =
        `https://localhost:30000/login?return=${encodeURIComponent(window.location.href)}`
      return
    }

    const resolvedPath = returnPath ?? (window.location.pathname + window.location.search)
    userManager.signinRedirect({ state: { returnUrl: resolvedPath } }).catch(err => {
      console.error('signinRedirect failed:', err)
    })
  }, [])
```

**Lines 66-82**: The login function with PKCE security check.

- **Lines 72-76**: PKCE requires `crypto.subtle` (the Web Crypto API). This API is only available in "secure contexts" (HTTPS or localhost). If it's missing, the app redirects to `https://localhost:30000/login` (which is always a secure context) and passes the current URL as a return parameter. After authentication completes at localhost, the token is relayed back via URL hash (see Section 18).
- **Line 78**: Computes the return path — either the explicitly provided path or the current page URL. This allows the user to be sent back to where they were before login.
- **Line 79**: `signinRedirect()` triggers the full OIDC Authorization Code Flow:
  1. Generates a PKCE `code_verifier` and `code_challenge`
  2. Stores the PKCE verifier, nonce, and state in sessionStorage
  3. Redirects the browser to Keycloak's authorization endpoint with all required parameters
- `{ state: { returnUrl: resolvedPath } }` passes custom data through the OIDC flow — Keycloak echoes the `state` parameter back in the callback, allowing the app to redirect to the original page after login.

### Logout Method

```typescript
  const logout = useCallback(async () => {
    const currentUser = await userManager.getUser()

    if (currentUser?.refresh_token) {
      const authority = userManager.settings.authority
      try {
        await fetch(`${authority}/protocol/openid-connect/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: userManager.settings.client_id,
            refresh_token: currentUser.refresh_token,
          }),
        })
      } catch {
        // Best-effort: even if Keycloak is unreachable, clear local state
      }
    }

    await userManager.removeUser()
    setUser(null)
    window.location.href = window.location.origin + '/'
  }, [])
```

**Lines 84-112**: Back-channel logout implementation.

- **Line 88**: Gets the current user to access the refresh token.
- **Lines 90-104**: **Back-channel logout** — sends a direct POST to Keycloak's logout endpoint instead of redirecting the browser. This approach:
  - Avoids a visible redirect to Keycloak's UI (better UX)
  - Uses `refresh_token` to identify which session to terminate
  - Is wrapped in try/catch because even if Keycloak is unreachable, we still want to clear local state
- **Line 107**: `removeUser()` clears the session from sessionStorage and fires the `userUnloaded` event.
- **Line 108**: Clears React state.
- **Line 111**: Navigates to the home page. Uses `window.location.href` (full page reload) rather than React Router's `navigate()` to ensure a clean state.

### Access Token Getter

```typescript
  const getAccessToken = useCallback(() => user?.access_token ?? null, [user])
```

**Line 114**: Returns the raw access token string from the in-memory `User` object.

- `useCallback` with `[user]` dependency ensures this function is recreated only when the user changes.
- Returns `null` if not authenticated.
- This function is passed to the API client via `setTokenProvider()` so it always has access to the current token.

### Admin Role Detection

```typescript
  const isAdmin = (() => {
    if (!user?.access_token) return false
    try {
      const payload = JSON.parse(atob(user.access_token.split('.')[1]))
      const roles: string[] = payload.roles ?? []
      return roles.includes('admin')
    } catch {
      return false
    }
  })()
```

**Lines 118-127**: Extracts the admin role from the JWT.

- **Line 119**: Early return if no access token.
- **Line 121**: Decodes the JWT payload:
  1. `user.access_token.split('.')[1]` — extracts the payload (middle part of the JWT)
  2. `atob(...)` — Base64-decodes the payload string
  3. `JSON.parse(...)` — Parses the JSON string into an object
- **Line 122**: Reads the `roles` array from the JWT payload. This is a custom claim configured in Keycloak's realm role mapper. Falls back to empty array if not present.
- **Line 123**: Checks if `'admin'` is in the roles array.
- **Important**: This is a **UI-only** check. The backend services independently validate the JWT and enforce authorization. Even if someone modified the client-side `isAdmin` flag, API calls would still be rejected by the server.

### Provider Render & Custom Hook

```typescript
  return (
    <AuthContext.Provider value={{ user, isLoading, isAdmin, login, logout, getAccessToken }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
```

**Lines 129-140**: The provider wraps the component tree and exposes all auth values.

- `<AuthContext.Provider>` makes the auth state available to any descendant component.
- `useAuth()` is a convenience hook that:
  1. Consumes the context value
  2. Throws a descriptive error if used outside `AuthProvider` (a common developer mistake)
  3. Returns the typed `AuthContextValue` — no null checks needed at call sites

---

## 5. The Login Flow -- Step by Step

Here is the complete login sequence, from button click to authenticated session:

```
    User                React App              Keycloak              Browser
     │                     │                      │                    │
     │  clicks "Login"     │                      │                    │
     ├────────────────────►│                      │                    │
     │                     │                      │                    │
     │                     │ 1. Check crypto.subtle                   │
     │                     │    (PKCE requires it)                    │
     │                     │                      │                    │
     │                     │ 2. Generate PKCE:    │                    │
     │                     │    code_verifier     │                    │
     │                     │    code_challenge    │                    │
     │                     │                      │                    │
     │                     │ 3. Store PKCE state  │                    │
     │                     │    in sessionStorage  │                    │
     │                     │                      │                    │
     │                     │ 4. Redirect to       │                    │
     │                     │    /auth?response_type=code              │
     │                     │    &code_challenge=... │                   │
     │                     ├─────────────────────►│                    │
     │                     │                      │                    │
     │                     │                      │ 5. Show login form │
     │                     │                      ├───────────────────►│
     │                     │                      │                    │
     │  enters credentials │                      │                    │
     ├────────────────────────────────────────────────────────────────►│
     │                     │                      │                    │
     │                     │                      │ 6. Validate creds  │
     │                     │                      │    Generate code   │
     │                     │                      │                    │
     │                     │ 7. Redirect to       │                    │
     │                     │    /callback?code=...│                    │
     │                     │◄─────────────────────┤                    │
     │                     │                      │                    │
     │                     │ 8. CallbackPage:     │                    │
     │                     │    Exchange code for  │                    │
     │                     │    tokens (with       │                    │
     │                     │    code_verifier)     │                    │
     │                     ├─────────────────────►│                    │
     │                     │                      │                    │
     │                     │ 9. Tokens returned:  │                    │
     │                     │    access_token       │                    │
     │                     │    id_token           │                    │
     │                     │    refresh_token      │                    │
     │                     │◄─────────────────────┤                    │
     │                     │                      │                    │
     │                     │ 10. Fetch CSRF token  │                    │
     │                     │ 11. Merge guest cart  │                    │
     │                     │ 12. Navigate to       │                    │
     │                     │     return URL         │                    │
     │                     │                      │                    │
     │  Authenticated UI   │                      │                    │
     │◄────────────────────┤                      │                    │
```

### What Triggers Login?

Login can be triggered from three places:

1. **NavBar "Login" button** → calls `login()` with no arguments
2. **ProtectedRoute** → calls `login(currentPath)` when an unauthenticated user visits a protected page
3. **AdminRoute** → calls `login('/admin')` when an unauthenticated user visits an admin page

---

## 6. The Callback Page (`CallbackPage.tsx`)

The callback page is the most complex component in the auth flow. It handles the OIDC callback, CSRF token acquisition, guest cart merging, and cross-origin relay.

### Full Source with Line-by-Line Explanation

```typescript
// File: ui/src/pages/CallbackPage.tsx

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { userManager } from '../auth/oidcConfig'
import { getGuestCart, clearGuestCart } from '../hooks/useGuestCart'
import { setCsrfToken } from '../api/client'
```

**Lines 1-6**: Imports.

- `useNavigate`: React Router hook for programmatic navigation.
- `userManager`: To complete the OIDC token exchange.
- `getGuestCart`, `clearGuestCart`: Guest cart utilities for merge-on-login.
- `setCsrfToken`: To cache the CSRF token in the API client module.

```typescript
export default function CallbackPage() {
  const navigate = useNavigate()

  useEffect(() => {
    userManager.signinRedirectCallback()
```

**Lines 8-11**: The effect runs once when the callback page mounts.

- `signinRedirectCallback()` is the critical function — it:
  1. Reads the authorization `code` from the current URL's query parameters
  2. Retrieves the PKCE `code_verifier` from sessionStorage (stored during `signinRedirect`)
  3. Sends a POST to Keycloak's token endpoint with the code + verifier
  4. Receives access_token, id_token, and refresh_token
  5. Stores the user session in sessionStorage
  6. Returns the `User` object

```typescript
      .then(async (user) => {
        const state = user.state as { returnUrl?: string } | undefined
        const returnUrl = state?.returnUrl || '/'
```

**Lines 12-14**: Extract the return URL from the OIDC state.

- The `state` parameter was set during `signinRedirect({ state: { returnUrl: ... } })`.
- Keycloak echoes this state back in the callback.
- If no return URL was set, default to `/` (home page).

```typescript
        // Fetch CSRF token before any mutating requests
        let csrfToken: string | null = null
        try {
          const csrfResp = await fetch('/csrf/token', {
            headers: { Authorization: `Bearer ${user.access_token}` },
          })
          if (csrfResp.ok) {
            const csrfData = await csrfResp.json()
            csrfToken = csrfData.token
            setCsrfToken(csrfToken)
          }
        } catch {
          // CSRF fetch failed — guest cart merge may fail with 403 but is best-effort
        }
```

**Lines 16-29**: Fetch a CSRF token immediately.

- The CSRF token is needed before any POST/PUT/DELETE requests (like merging the guest cart).
- `GET /csrf/token` is handled by the gateway-level CSRF service (Go microservice).
- The request includes the newly obtained access token for authentication.
- `setCsrfToken()` caches the token in the API client's module-level variable.
- If this fails, guest cart merge will likely fail (403), but the login itself succeeds — this is intentional (best-effort).

```typescript
        // Merge guest cart items to server cart if any exist
        const pending = getGuestCart()
        if (pending.length > 0) {
          await Promise.allSettled(
            pending.map(item =>
              fetch('/ecom/cart', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${user.access_token}`,
                  ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
                },
                body: JSON.stringify({ bookId: item.bookId, quantity: item.quantity }),
              })
            )
          )
          clearGuestCart()
        }
```

**Lines 31-48**: Guest cart merge.

- `getGuestCart()` reads items from `localStorage` that were added before login.
- `Promise.allSettled()` (not `Promise.all()`) sends all merge requests in parallel and waits for all to complete — it doesn't short-circuit on failure, so even if one item fails, the others still merge.
- Each request includes both the JWT (Authorization) and CSRF token (X-CSRF-Token) headers.
- `clearGuestCart()` removes the localStorage data after merge, regardless of individual success/failure.

```typescript
        // Cross-origin return: relay the auth token via URL hash
        const isAbsolute = returnUrl.startsWith('http://') || returnUrl.startsWith('https://')
        const isAllowedRedirect = (url: string): boolean => {
          const ALLOWED_ORIGINS = new Set([
            'https://localhost:30000',
            'https://myecom.net:30000',
          ])
          try {
            return ALLOWED_ORIGINS.has(new URL(url).origin)
          } catch {
            return false
          }
        }
        if (isAbsolute && isAllowedRedirect(returnUrl)) {
          const relay = encodeURIComponent(user.toStorageString())
          window.location.href = `${returnUrl}#auth=${relay}`
        } else if (pending.length > 0 && returnUrl === '/') {
          navigate('/cart')
        } else {
          navigate(returnUrl)
        }
```

**Lines 50-72**: Navigation after successful login.

- **Cross-origin relay** (lines 65-67): If the return URL is an absolute URL from an allowed origin, the user session is encoded and appended as a URL hash fragment (`#auth=...`). The destination origin's `AuthContext` will read and restore this session. The hash fragment is never sent to the server (HTTP spec), making this a safe client-side-only relay.
- **Cart redirect** (lines 68-69): If there were guest cart items and no specific return URL, redirect to `/cart` so the user can see their merged cart.
- **Normal redirect** (lines 70-71): Navigate to the saved return path.

```typescript
      .catch(err => {
        console.error('OIDC callback error:', err)
        navigate('/')
      })
  }, [navigate])

  return <div className="loading-state">Completing login...</div>
}
```

**Lines 74-81**: Error handling and render.

- If `signinRedirectCallback()` fails (e.g., the authorization code expired, PKCE verification failed, or Keycloak is unreachable), the user is redirected home.
- The component renders a loading message while the async work completes.

---

## 7. Silent Token Renewal

Access tokens have a limited lifetime (typically 5 minutes). Silent renewal refreshes them automatically without user interaction.

### How It Works

```
    React App (main frame)                    Hidden IFrame                    Keycloak
           │                                       │                              │
           │  Token expires in 60s                  │                              │
           │  (oidc-client-ts timer fires)          │                              │
           │                                       │                              │
           │  Creates hidden <iframe>              │                              │
           │  src = /auth?prompt=none&...          │                              │
           ├──────────────────────────────────────►│                              │
           │                                       │  GET /auth?prompt=none        │
           │                                       ├─────────────────────────────►│
           │                                       │                              │
           │                                       │  User has active SSO session  │
           │                                       │  Redirect to /silent-renew    │
           │                                       │  with new authorization code   │
           │                                       │◄─────────────────────────────┤
           │                                       │                              │
           │  IFrame loads /silent-renew.html       │                              │
           │  Script posts URL to parent            │                              │
           │◄──────────────────────────────────────┤                              │
           │                                       │                              │
           │  Exchanges code for new tokens         │                              │
           │  (same PKCE flow as initial login)     │                              │
           ├──────────────────────────────────────────────────────────────────────►│
           │                                       │                              │
           │  New tokens received                   │                              │
           │  userLoaded event fires                │                              │
           │  React state updated                   │                              │
           │                                       │                              │
```

### The Silent Renew Page

```html
<!-- File: ui/public/silent-renew.html -->

<!DOCTYPE html>
<html>
<head><title>Silent Renew</title></head>
<body>
<script>
  // Pass the authorization response URL back to the parent frame.
  // oidc-client-ts IFrameWindow expects: { url: string } via postMessage.
  parent.postMessage({ url: location.href }, location.origin);
</script>
</body>
</html>
```

This page does one thing: sends its URL (which contains the new authorization code) back to the parent frame using `postMessage`. The `oidc-client-ts` library's `IFrameWindow` class is listening for this message and completes the token exchange.

**Security considerations**:
- `location.origin` as the target origin ensures the message only goes to the same origin.
- The iframe's URL never leaves the browser — it's a client-side-only operation.

---

## 8. The Logout Flow

```
    User                React App                 Keycloak
     │                     │                         │
     │  clicks "Logout"    │                         │
     ├────────────────────►│                         │
     │                     │                         │
     │                     │ 1. Get refresh_token    │
     │                     │    from current user    │
     │                     │                         │
     │                     │ 2. POST /logout         │
     │                     │    client_id=ui-client  │
     │                     │    refresh_token=...    │
     │                     ├────────────────────────►│
     │                     │                         │
     │                     │    200 OK (session      │
     │                     │    terminated)           │
     │                     │◄────────────────────────┤
     │                     │                         │
     │                     │ 3. removeUser()         │
     │                     │    (clear sessionStorage)│
     │                     │                         │
     │                     │ 4. setUser(null)        │
     │                     │    (clear React state)  │
     │                     │                         │
     │                     │ 5. Redirect to /        │
     │  Home page (logged  │                         │
     │  out)               │                         │
     │◄────────────────────┤                         │
```

### Why Back-Channel Logout?

The standard OIDC logout flow (RP-Initiated Logout) redirects the browser to Keycloak's logout page, which then redirects back. This causes:
- A visible flash of Keycloak's UI
- Potential issues with SPA state loss during full page navigation

The back-channel approach used here (direct POST) provides:
- Instant logout with no visible redirect
- Keycloak SSO session is terminated (so other apps in the realm are also logged out)
- Even if the POST fails (network error), local state is still cleared

---

## 9. JWT Decoding & Role Extraction

### What's Inside a JWT?

A JWT access token from Keycloak looks like this when decoded:

```json
{
  "exp": 1711234567,
  "iat": 1711234267,
  "jti": "abc-123-def",
  "iss": "https://idp.keycloak.net:30000/realms/bookstore",
  "sub": "9d82bcb3-6e96-462c-bdb9-e677080e8920",
  "typ": "Bearer",
  "azp": "ui-client",
  "scope": "openid profile email roles",
  "email": "user1@bookstore.com",
  "name": "User One",
  "roles": ["customer", "admin"],
  "realm_access": {
    "roles": ["customer", "admin"]
  }
}
```

### Client-Side Decoding

```typescript
const payload = JSON.parse(atob(user.access_token.split('.')[1]))
```

This line performs three operations:

1. **`user.access_token.split('.')[1]`** — A JWT has three parts separated by dots: `header.payload.signature`. Index `[1]` extracts the payload.
2. **`atob(...)`** — Decodes the Base64-encoded payload string into a JSON string.
3. **`JSON.parse(...)`** — Parses the JSON string into a JavaScript object.

**Why not use a JWT library?** Because we're not verifying the signature — we're only reading claims for UI display purposes. The backend services handle verification using Keycloak's JWKS public keys.

### How JWKS Verification Works (Server-Side)

```
    API Request                 Backend Service              Keycloak
         │                           │                          │
         │  Authorization:           │                          │
         │  Bearer <jwt>             │                          │
         ├──────────────────────────►│                          │
         │                           │                          │
         │                           │ 1. Decode JWT header     │
         │                           │    → alg: RS256          │
         │                           │    → kid: "key-id-123"   │
         │                           │                          │
         │                           │ 2. Fetch JWKS (cached)   │
         │                           │    GET /certs             │
         │                           ├─────────────────────────►│
         │                           │                          │
         │                           │    { keys: [             │
         │                           │      { kid: "key-id-123" │
         │                           │        kty: "RSA",       │
         │                           │        n: "...",         │
         │                           │        e: "AQAB" }       │
         │                           │    ]}                     │
         │                           │◄─────────────────────────┤
         │                           │                          │
         │                           │ 3. Verify signature      │
         │                           │    using public key       │
         │                           │                          │
         │                           │ 4. Check claims:         │
         │                           │    - exp > now            │
         │                           │    - iss matches          │
         │                           │    - aud/azp valid        │
         │                           │                          │
         │  200 OK / 401 / 403      │                          │
         │◄──────────────────────────┤                          │
```

The React app never needs to do this — it trusts the backend to enforce authorization.

---

## 10. Route Protection (`ProtectedRoute.tsx` & `AdminRoute.tsx`)

### ProtectedRoute — Requires Authentication

```typescript
// File: ui/src/components/ProtectedRoute.tsx

import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, login } = useAuth()
  const location = useLocation()
```

**Lines 1-9**: The component consumes auth state and the current browser location.

```typescript
  useEffect(() => {
    if (!isLoading && !user) {
      login(location.pathname + location.search)
    }
  }, [isLoading, user, login, location])
```

**Lines 10-13**: When auth initialization is complete and the user isn't authenticated, trigger login with the current path saved. This ensures the user returns to this exact page after authenticating.

```typescript
  if (isLoading || !user) {
    return <div className="loading-state">Redirecting to login...</div>
  }

  return <>{children}</>
}
```

**Lines 15-19**: Render logic:
- While loading or not authenticated: show a loading message (the login redirect is happening).
- Once authenticated: render the protected content via `{children}`.

### AdminRoute — Requires Admin Role

```typescript
// File: ui/src/components/AdminRoute.tsx

export default function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, isAdmin, login } = useAuth()

  if (isLoading) {
    return <div>Loading...</div>
  }

  if (!user) {
    login('/admin')
    return null
  }

  if (!isAdmin) {
    return (
      <div>
        <h2>Access Denied</h2>
        <p>You need the <strong>admin</strong> role to access this page.</p>
      </div>
    )
  }

  return <>{children}</>
}
```

AdminRoute has three states (unlike ProtectedRoute's two):

1. **Loading**: Show loading indicator
2. **Not authenticated**: Trigger login (hardcoded to `/admin` return path)
3. **Authenticated but not admin**: Show "Access Denied" error
4. **Admin**: Render the admin page

**Key difference**: `ProtectedRoute` only checks authentication. `AdminRoute` also checks the `isAdmin` flag (derived from JWT roles).

---

## 11. CSRF Token Management

### What is CSRF?

Cross-Site Request Forgery (CSRF) is an attack where a malicious website tricks the user's browser into making unwanted requests to your application. For example:

```html
<!-- Malicious site -->
<img src="https://yourapp.com/api/transfer-money?to=attacker&amount=1000" />
```

If the user is logged in and cookies are sent automatically, this request would succeed.

### How This App Prevents CSRF

The application uses a **gateway-level CSRF service** — a dedicated Go microservice that:
1. Issues unique CSRF tokens (UUID v4) to authenticated users
2. Stores tokens in Redis with a 10-minute sliding TTL
3. Validates every mutating request (POST/PUT/DELETE/PATCH) at the Istio gateway level before the request reaches backend services

```
    React App              Istio Gateway           CSRF Service (Go)        Backend
         │                      │                        │                     │
         │  GET /csrf/token     │                        │                     │
         │  (JWT in header)     │                        │                     │
         ├─────────────────────►│                        │                     │
         │                      ├───────────────────────►│                     │
         │                      │  Generate UUID token   │                     │
         │                      │  Store in Redis        │                     │
         │                      │  (10min sliding TTL)   │                     │
         │                      │◄───────────────────────┤                     │
         │  { token: "uuid" }   │                        │                     │
         │◄─────────────────────┤                        │                     │
         │                      │                        │                     │
         │  POST /ecom/cart     │                        │                     │
         │  X-CSRF-Token: uuid  │                        │                     │
         │  Authorization: JWT  │                        │                     │
         ├─────────────────────►│                        │                     │
         │                      │ ext_authz check        │                     │
         │                      ├───────────────────────►│                     │
         │                      │ Validate token in Redis│                     │
         │                      │ (timing-safe compare)  │                     │
         │                      │◄───────────────────────┤                     │
         │                      │                        │                     │
         │                      │  Token valid → forward │                     │
         │                      ├──────────────────────────────────────────────►│
         │                      │                        │                     │
```

### CSRF Token Lifecycle in the React App

```typescript
// In client.ts

let _csrfToken: string | null = null                    // Module-level cache

export async function fetchCsrfToken(): Promise<string | null> {
  const token = _getToken?.()                            // Get JWT from in-memory User
  if (!token) return null                                // Not authenticated → no CSRF needed

  try {
    const resp = await fetch('/csrf/token', {
      headers: { Authorization: `Bearer ${token}` },     // JWT required to get CSRF token
    })
    if (resp.ok) {
      const data = await resp.json()
      _csrfToken = data.token                            // Cache in module variable
      return _csrfToken
    }
  } catch (e) {
    console.warn('CSRF token fetch failed:', e)
  }
  return null
}
```

**When is `fetchCsrfToken()` called?**

1. **On login** — `App.tsx` calls it when the `user` state changes
2. **On callback** — `CallbackPage.tsx` calls it immediately after token exchange
3. **On 403 retry** — `client.ts` calls it as a fallback when auto-regenerated token isn't in the 403 response body

### Sliding TTL

The CSRF token's TTL in Redis refreshes on every **authenticated safe method** (GET/HEAD/OPTIONS). This means as long as the user is actively browsing (making GET requests), their CSRF token stays valid. The token only expires after 10 minutes of complete inactivity.

### Auto-Regeneration on 403

When a CSRF token expires and a mutating request fails with 403, the CSRF service includes a **new token** in the 403 response body:

```json
{
  "error": "CSRF token expired",
  "token": "new-uuid-v4-token"
}
```

The API client reads this token and retries the request immediately — saving a round trip compared to fetching a new token via `GET /csrf/token`.

---

## 12. The API Client (`client.ts`)

The API client is a lightweight HTTP wrapper that handles JWT authentication, CSRF tokens, and error recovery.

### Module-Level State

```typescript
// File: ui/src/api/client.ts

let _getToken: (() => string | null) | null = null
let _csrfToken: string | null = null
```

**Lines 7-8**: Two module-level variables (not React state — these persist across renders):

- `_getToken`: A function that returns the current access token. Set once during app initialization via `setTokenProvider()`.
- `_csrfToken`: The cached CSRF token. Updated by `fetchCsrfToken()` or from 403 response bodies.

### Token Provider Setup

```typescript
export function setTokenProvider(fn: () => string | null) {
  _getToken = fn
}
```

**Lines 10-12**: Called from `App.tsx` with `getAccessToken` from `AuthContext`. This design pattern (dependency injection) decouples the API client from React — it doesn't import React, hooks, or context directly.

### CSRF Token Setter

```typescript
export function setCsrfToken(token: string | null) {
  _csrfToken = token
}
```

**Lines 14-16**: Direct setter for the CSRF token. Used by `CallbackPage.tsx` to cache the token fetched during the OIDC callback.

### The Core Request Function

```typescript
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])

async function request<T>(
  url: string,
  options: RequestInit = {},
  _csrfRetried = false,
): Promise<T> {
```

**Lines 38-44**: The core request function.

- Generic type `<T>` allows callers to specify the expected response type for TypeScript type safety.
- `url`: The API endpoint path (e.g., `/ecom/books`).
- `options`: Standard `fetch` options (method, body, headers, etc.).
- `_csrfRetried`: Internal flag to prevent infinite retry loops — only one retry is attempted.

```typescript
  const token = _getToken?.()
  const method = (options.method ?? 'GET').toUpperCase()
  const isMutating = MUTATING_METHODS.has(method)
```

**Lines 45-47**: Determine the request characteristics.

- `_getToken?.()` — Optional chaining; returns `undefined` if `_getToken` is null (before initialization).
- Default method is `GET` if not specified.
- `isMutating` — whether this request needs a CSRF token.

```typescript
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(isMutating && _csrfToken ? { 'X-CSRF-Token': _csrfToken } : {}),
  }
```

**Lines 49-54**: Build the headers object using spread syntax.

- **Line 50**: All requests send JSON.
- **Line 51**: Preserve any headers passed by the caller.
- **Line 52**: Add the JWT Authorization header if authenticated.
- **Line 53**: Add the CSRF token header only for mutating requests and only if a token exists.

The spread syntax `...(condition ? { key: value } : {})` is a common pattern for conditionally adding properties to an object.

```typescript
  const resp = await fetch(url, { ...options, headers })
```

**Line 56**: Execute the fetch request with merged options.

### CSRF Auto-Retry

```typescript
  if (resp.status === 403 && isMutating && !_csrfRetried) {
    try {
      const body = await resp.json()
      if (body.token) {
        _csrfToken = body.token           // Use auto-regenerated token from 403 body
      } else {
        await fetchCsrfToken()            // Fallback: fetch fresh token
      }
    } catch {
      await fetchCsrfToken()              // JSON parse failed → fetch fresh token
    }
    return request<T>(url, options, true)  // Retry with _csrfRetried = true
  }
```

**Lines 58-73**: CSRF token recovery.

- **Line 61**: Only retry if: (a) 403 response, (b) it's a mutating request, (c) we haven't already retried.
- **Line 63-65**: Try to read the auto-regenerated token from the 403 response body (saves a network request).
- **Line 67**: If the body doesn't contain a token, fetch one from the CSRF service.
- **Line 72**: Recursive call with `_csrfRetried = true` to prevent infinite recursion.

### Error Handling and Response Parsing

```typescript
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText)
    throw new Error(`HTTP ${resp.status}: ${text}`)
  }

  if (resp.status === 204) return undefined as T
  return resp.json()
}
```

**Lines 75-82**: Standard error handling.

- Non-OK responses throw an Error with the status code and response body.
- HTTP 204 (No Content) returns `undefined` — used by DELETE endpoints that return no body.
- All other successful responses are parsed as JSON.

### Exported API Methods

```typescript
export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body: unknown) =>
    request<T>(url, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(url: string, body: unknown) =>
    request<T>(url, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(url: string) => request<T>(url, { method: 'DELETE' }),
}
```

**Lines 84-91**: Convenience methods that wrap the `request` function.

- Each method sets the appropriate HTTP method.
- `post` and `put` serialize the body to JSON.
- All methods forward the generic type `<T>` for type safety.
- `delete` doesn't take a body parameter — the resource to delete is identified by the URL.

---

## 13. Domain API Modules (`books.ts`, `cart.ts`, `admin.ts`)

### Books API

```typescript
// File: ui/src/api/books.ts

import { api } from './client'

export interface Book {
  id: string
  title: string
  author: string
  price: number
  description: string
  coverUrl: string | null
  genre: string | null
  isbn: string | null
  publishedYear: number | null
}
```

**Lines 1-14**: TypeScript interfaces define the shape of API responses. These serve as both documentation and compile-time type checking.

- Fields that may not be present use `string | null` (union type).
- The `Book` interface mirrors the Java entity in ecom-service.

```typescript
export interface Page<T> {
  content: T[]
  totalElements: number
  totalPages: number
  number: number
  size: number
}
```

**Lines 15-21**: Generic page interface matching Spring Boot's `Page<T>` response format.

- `content`: The array of items for this page.
- `totalElements`: Total count across all pages (for "Showing X of Y").
- `totalPages`: Total number of pages.
- `number`: Current page index (0-based).
- `size`: Items per page.

```typescript
export interface StockResponse {
  book_id: string
  quantity: number
  reserved: number
  available: number
  updated_at: string
}

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock'

export function getStockStatus(available: number): StockStatus {
  if (available <= 0) return 'out_of_stock'
  if (available <= 3) return 'low_stock'
  return 'in_stock'
}
```

**Lines 23-37**: Stock data from the Inventory Service (Python FastAPI).

- Note the `snake_case` field names — they come from Python, not Java.
- `StockStatus` is a union type (string literal type) — TypeScript ensures only these three values are valid.
- `getStockStatus()` is a pure function that derives display status from the available quantity.

```typescript
export const booksApi = {
  list: (page = 0, size = 20) =>
    api.get<Page<Book>>(`/ecom/books?page=${page}&size=${size}&sort=title`),

  search: (q: string, page = 0) =>
    api.get<Page<Book>>(`/ecom/books/search?q=${encodeURIComponent(q)}&page=${page}`),

  getStock: (bookId: string) =>
    api.get<StockResponse>(`/inven/stock/${bookId}`),

  getBulkStock: (bookIds: string[]) =>
    api.get<StockResponse[]>(`/inven/stock/bulk?book_ids=${bookIds.join(',')}`),
}
```

**Lines 39-51**: The books API object.

- `list()` has default parameter values — `page = 0, size = 20` — so callers can omit them.
- `search()` uses `encodeURIComponent()` to safely encode the query string (handles spaces, special characters).
- `getBulkStock()` joins book IDs with commas for the query parameter — the inventory service splits them back.
- Note: `getStock()` goes to `/inven/stock/` (inventory service), while `list()` goes to `/ecom/books` (ecom service). The React app talks to two different backends.

### Cart API

```typescript
// File: ui/src/api/cart.ts

export interface CartItem {
  id: string
  book: { id: string; title: string; price: number }
  quantity: number
}

export const cartApi = {
  get: () => api.get<CartItem[]>('/ecom/cart'),
  add: (bookId: string, quantity: number) =>
    api.post<CartItem>('/ecom/cart', { bookId, quantity }),
  update: (cartItemId: string, quantity: number) =>
    api.put<CartItem>(`/ecom/cart/${cartItemId}`, { quantity }),
  remove: (cartItemId: string) => api.delete<void>(`/ecom/cart/${cartItemId}`),
  checkout: () => api.post<{ id: string; total: number; status: string }>('/ecom/checkout', {}),
}
```

**Key observations**:
- `get()` returns an array (not a Page), since carts are small.
- `add()` and `update()` use mutating methods → CSRF token is automatically attached.
- `checkout()` sends an empty body `{}` — the server reads the cart from the user's session (identified by JWT `sub` claim).
- `remove()` returns `void` — the server responds with 204 No Content.

### Admin API

```typescript
// File: ui/src/api/admin.ts

export const adminBooksApi = {
  list: (page = 0, size = 20) =>
    api.get<Page<Book>>(`/ecom/admin/books?page=${page}&size=${size}&sort=title`),
  get: (id: string) => api.get<Book>(`/ecom/admin/books/${id}`),
  create: (req: BookRequest) => api.post<Book>('/ecom/admin/books', req),
  update: (id: string, req: BookRequest) => api.put<Book>(`/ecom/admin/books/${id}`, req),
  delete: (id: string) => api.delete<void>(`/ecom/admin/books/${id}`),
}

export const adminOrdersApi = {
  list: (page = 0, size = 20) =>
    api.get<Page<AdminOrder>>(`/ecom/admin/orders?page=${page}&size=${size}`),
  get: (id: string) => api.get<AdminOrder>(`/ecom/admin/orders/${id}`),
}

export const adminStockApi = {
  list: (page = 0, size = 50) =>
    api.get<StockResponse[]>(`/inven/admin/stock?page=${page}&size=${size}`),
  setQuantity: (bookId: string, req: StockSetRequest) =>
    api.put<StockAdminResponse>(`/inven/admin/stock/${bookId}`, req),
  adjust: (bookId: string, req: StockAdjustRequest) =>
    api.post<StockAdminResponse>(`/inven/admin/stock/${bookId}/adjust`, req),
}
```

**Pattern**: Three separate API objects for three admin domains:
- `adminBooksApi` → ecom-service `/ecom/admin/books`
- `adminOrdersApi` → ecom-service `/ecom/admin/orders`
- `adminStockApi` → inventory-service `/inven/admin/stock`

All mutating operations (create, update, delete, setQuantity, adjust) automatically include both JWT and CSRF tokens via the `api.post/put/delete` methods.

---

## 14. Application Wiring (`App.tsx` & `main.tsx`)

### Entry Point (`main.tsx`)

```typescript
// File: ui/src/main.tsx

import './styles.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

- **Line 1**: Import global styles first (CSS is loaded before any component renders).
- **Line 7**: `document.getElementById('root')!` — the `!` is TypeScript's non-null assertion. We know this element exists in `index.html`.
- **Line 8**: `React.StrictMode` enables development-time checks (double-invokes effects to catch bugs, warns about deprecated APIs). It's stripped in production builds.

### Root Component (`App.tsx`)

```typescript
// File: ui/src/App.tsx

import React, { Suspense, useEffect } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { setTokenProvider, fetchCsrfToken } from './api/client'
import NavBar from './components/NavBar'
import ErrorBoundary from './components/ErrorBoundary'
import ProtectedRoute from './components/ProtectedRoute'
import AdminRoute from './components/AdminRoute'
// ... page imports ...
```

**Lines 1-10**: Imports establish the dependency graph:
- `BrowserRouter` enables client-side routing using the History API.
- `Suspense` provides fallback UI for lazy-loaded components.

```typescript
// Code-split admin pages — only loaded when an admin navigates to /admin/*
const AdminDashboard = React.lazy(() => import('./pages/admin/AdminDashboard'))
const AdminBooksPage = React.lazy(() => import('./pages/admin/AdminBooksPage'))
const AdminEditBookPage = React.lazy(() => import('./pages/admin/AdminEditBookPage'))
const AdminStockPage = React.lazy(() => import('./pages/admin/AdminStockPage'))
const AdminOrdersPage = React.lazy(() => import('./pages/admin/AdminOrdersPage'))
```

**Lines 18-22**: Code splitting with `React.lazy()`.

- `React.lazy()` takes a function that returns a dynamic `import()` call.
- Vite creates separate chunks for each admin page — they're not included in the main bundle.
- The admin JavaScript is only downloaded when an admin user navigates to `/admin/*`.
- This reduces the initial bundle size for regular users who never need admin functionality.

### AppWithAuth — The Wiring Layer

```typescript
function AppWithAuth() {
  const { getAccessToken, user } = useAuth()
  // Wire the in-memory token into the API client once
  setTokenProvider(getAccessToken)

  // Fetch CSRF token from ecom-service after authentication
  useEffect(() => {
    if (user) {
      fetchCsrfToken().catch(err => console.warn('CSRF token fetch failed:', err))
    }
  }, [user])
```

**Lines 24-34**: This inner component (inside `AuthProvider`) bridges auth and API:

- **Line 27**: `setTokenProvider(getAccessToken)` — passes the auth context's token getter to the API client module. This runs on every render, but it's a simple assignment (no performance concern).
- **Lines 30-33**: `useEffect` with `[user]` dependency — whenever the user changes (login/logout), fetch a new CSRF token. On logout (`user` becomes null), `fetchCsrfToken` returns null immediately (no token → no CSRF needed).

### Route Configuration

```typescript
  return (
    <BrowserRouter>
      <NavBar />
      <ErrorBoundary>
        <Suspense fallback={<div className="loading-state">Loading...</div>}>
          <Routes>
            <Route path="/" element={<CatalogPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/cart" element={<CartPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/callback" element={<CallbackPage />} />
            <Route path="/order-confirmation" element={
              <ProtectedRoute><OrderConfirmationPage /></ProtectedRoute>
            } />
            {/* Admin routes — require admin Keycloak realm role */}
            <Route path="/admin" element={<AdminRoute><AdminDashboard /></AdminRoute>} />
            <Route path="/admin/books" element={<AdminRoute><AdminBooksPage /></AdminRoute>} />
            <Route path="/admin/books/new" element={<AdminRoute><AdminEditBookPage /></AdminRoute>} />
            <Route path="/admin/books/:id" element={<AdminRoute><AdminEditBookPage /></AdminRoute>} />
            <Route path="/admin/stock" element={<AdminRoute><AdminStockPage /></AdminRoute>} />
            <Route path="/admin/orders" element={<AdminRoute><AdminOrdersPage /></AdminRoute>} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </BrowserRouter>
  )
```

**Route security levels**:

| Route | Guard | Access |
|-------|-------|--------|
| `/`, `/search`, `/cart` | None | Public (anyone) |
| `/login`, `/callback` | None | OIDC flow pages |
| `/order-confirmation` | `ProtectedRoute` | Authenticated users only |
| `/admin/*` | `AdminRoute` | Admin role required |
| `*` (catch-all) | None | 404 page |

### The Outer App Wrapper

```typescript
export default function App() {
  return (
    <AuthProvider>
      <AppWithAuth />
    </AuthProvider>
  )
}
```

**Lines 66-72**: The outer `App` component wraps everything in `AuthProvider`. This is why `AppWithAuth` is a separate component — it needs to call `useAuth()`, which requires being inside `AuthProvider`.

**Component hierarchy**:
```
App
  └── AuthProvider          ← provides auth context
        └── AppWithAuth     ← consumes auth, wires API client
              ├── BrowserRouter
              │     ├── NavBar
              │     └── ErrorBoundary
              │           └── Suspense
              │                 └── Routes
              │                       ├── CatalogPage (public)
              │                       ├── ProtectedRoute → OrderConfirmationPage
              │                       └── AdminRoute → AdminDashboard, etc.
```

---

## 15. Guest Cart & Cart Merge on Login

### The Problem

Unauthenticated users should be able to browse and add items to a cart. When they eventually log in, those items should seamlessly merge into their server-side cart.

### Guest Cart Storage (`useGuestCart.ts`)

```typescript
// File: ui/src/hooks/useGuestCart.ts

const GUEST_CART_KEY = 'bookstore_guest_cart'

export interface GuestCartItem {
  bookId: string
  title: string
  price: number
  quantity: number
}
```

**Lines 1-8**: The guest cart uses `localStorage` (not `sessionStorage`) because:
- It should persist across tab closes (a user might add items, close the tab, and return later).
- Only unauthenticated data (book IDs, titles, prices) is stored — no sensitive tokens.

```typescript
export function getGuestCart(): GuestCartItem[] {
  try {
    return JSON.parse(localStorage.getItem(GUEST_CART_KEY) ?? '[]')
  } catch {
    return []
  }
}
```

**Lines 10-16**: Safe getter with JSON parse error handling.

- `?? '[]'` — nullish coalescing; if the key doesn't exist in localStorage, parse an empty array.
- `try/catch` — if someone manually corrupted the localStorage value, return empty array instead of crashing.

```typescript
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

**Lines 18-28**: Add to cart with deduplication.

- `Omit<GuestCartItem, 'quantity'>` — TypeScript utility type that creates a type with all properties of `GuestCartItem` except `quantity`. Callers don't specify quantity (it's always 1 for a new add).
- If the book already exists in the cart, increment its quantity.
- If it's new, push it with quantity 1.
- Returns the updated cart for immediate UI update.

### The Merge Flow

```
  Before Login:                              After Login:

  localStorage                               Server Cart (DB)
  ┌────────────────────┐                     ┌────────────────────┐
  │ bookstore_guest_cart│                     │ User's Cart        │
  │                    │                     │                    │
  │ [{bookId: "abc",   │  ──── merge ────►  │ CartItem(abc, 2)   │
  │   quantity: 2},    │   (CallbackPage)    │ CartItem(def, 1)   │
  │  {bookId: "def",   │                     │                    │
  │   quantity: 1}]    │                     └────────────────────┘
  └────────────────────┘
           │
           └── clearGuestCart() ── deleted after merge
```

---

## 16. Navigation & Conditional UI (`NavBar.tsx`)

```typescript
// File: ui/src/components/NavBar.tsx

export default function NavBar() {
  const { user, isLoading, isAdmin, login, logout } = useAuth()
  const [cartCount, setCartCount] = useState(0)
```

**Lines 7-9**: The NavBar consumes all auth state to conditionally render UI elements.

### Authenticated Cart Count

```typescript
  useEffect(() => {
    if (!user) {
      setCartCount(0)
      return
    }
    const fetchCount = () => {
      cartApi.get()
        .then(items => setCartCount(items.reduce((n, i) => n + i.quantity, 0)))
        .catch(() => setCartCount(0))
    }
    fetchCount()
    window.addEventListener('cartUpdated', fetchCount)
    return () => window.removeEventListener('cartUpdated', fetchCount)
  }, [user])
```

**Lines 12-25**: Server cart count for authenticated users.

- `items.reduce((n, i) => n + i.quantity, 0)` — sums all item quantities to get the total count.
- `cartUpdated` is a custom DOM event dispatched by cart operations (add, remove, checkout). This avoids prop drilling — any component can trigger a cart count refresh by dispatching `window.dispatchEvent(new Event('cartUpdated'))`.
- Cleanup removes the event listener on unmount.

### Guest Cart Count

```typescript
  useEffect(() => {
    if (user) return
    const update = () => setCartCount(guestCartCount())
    update()
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [user])

  useEffect(() => {
    if (user) return
    const id = setInterval(() => setCartCount(guestCartCount()), 500)
    return () => clearInterval(id)
  }, [user])
```

**Lines 28-41**: Two mechanisms for guest cart count updates:

1. **`storage` event** — fires when localStorage is modified in **another tab**. This gives cross-tab synchronization for free.
2. **500ms polling** — the `storage` event doesn't fire for same-tab changes. Polling catches in-tab localStorage updates (e.g., when the user adds to cart on the same page).

### Conditional Rendering

```typescript
  return (
    <nav>
      <Link to="/">Book Store</Link>
      <Link to="/search">Search</Link>
      <Link to="/cart">
        Cart {cartCount > 0 && <span>{cartCount}</span>}
      </Link>
      {isAdmin && <Link to="/admin">Admin</Link>}
      {isLoading ? (
        <span>...</span>
      ) : user ? (
        <>
          <span>{user.profile.email}</span>
          <button onClick={logout}>Logout</button>
        </>
      ) : (
        <button onClick={() => login()}>Login</button>
      )}
    </nav>
  )
```

**UI states**:

| State | Cart | Admin Link | Right Side |
|-------|------|-----------|------------|
| Loading | Badge (0) | Hidden | `...` |
| Guest | Badge (from localStorage) | Hidden | Login button |
| Authenticated | Badge (from server) | Hidden | Email + Logout |
| Admin | Badge (from server) | Visible | Email + Logout |

---

## 17. Token Storage Security Model

### Storage Comparison

| Storage | XSS Accessible | Persists After Tab Close | Sent Automatically | Used In This App |
|---------|---------------|-------------------------|-------------------|-----------------|
| **JavaScript variable** | Only during XSS attack | No | No | CSRF token |
| **sessionStorage** | Only during XSS attack | No | No | User session (oidc-client-ts) |
| **localStorage** | Anytime (if XSS present) | Yes | No | Guest cart only |
| **HTTP-only cookie** | No (not accessible via JS) | Configurable | Yes (same-site) | Not used for tokens |

### Why Not localStorage for Tokens?

```
  XSS Attack Scenario with localStorage:

  1. Attacker injects script via XSS vulnerability
  2. Script reads: localStorage.getItem('oidc.user:...')
  3. Access token, refresh token, ID token all stolen
  4. Attacker can use tokens from any device, any time
  5. Tokens persist even after user closes browser

  ────────────────────────────────────────────

  XSS Attack Scenario with sessionStorage:

  1. Attacker injects script via XSS vulnerability
  2. Script reads: sessionStorage.getItem('oidc.user:...')
  3. Tokens stolen — but only for this tab
  4. When user closes tab, tokens are gone
  5. Tokens cannot be accessed from other tabs
  6. Attack window is limited to active session
```

### Why In-Memory for the Access Token?

The `getAccessToken()` function returns the token from the in-memory `User` object. The API client never reads from storage directly:

```typescript
// In AuthContext.tsx:
const getAccessToken = useCallback(() => user?.access_token ?? null, [user])

// In App.tsx:
setTokenProvider(getAccessToken)

// In client.ts — called on every request:
const token = _getToken?.()
```

This means:
- The token is in a JavaScript closure — not queryable by storage APIs
- It's automatically updated when silent renewal occurs (via React state)
- It's automatically cleared on logout (React state set to null)

### Defense in Depth

```
  Layer 1: Token in memory (JavaScript variable)
     ↓ protects against: localStorage scraping attacks

  Layer 2: sessionStorage for session persistence
     ↓ protects against: persistent token theft (closes with tab)

  Layer 3: PKCE on Authorization Code Flow
     ↓ protects against: authorization code interception

  Layer 4: CSRF token on mutating requests
     ↓ protects against: cross-site request forgery

  Layer 5: Server-side JWT validation (JWKS)
     ↓ protects against: token tampering

  Layer 6: Istio mTLS between services
     ↓ protects against: network eavesdropping

  Layer 7: HTTPS everywhere (cert-manager TLS)
     ↓ protects against: man-in-the-middle attacks
```

---

## 18. Cross-Origin Authentication Relay

### The Problem

The app can be accessed from two origins:
- `https://localhost:30000` — always a "secure context" (crypto.subtle available)
- `https://myecom.net:30000` — resolved via `/etc/hosts` to 127.0.0.1

PKCE requires `crypto.subtle`, which is only available in secure contexts. Most browsers treat `https://*` as secure, but some strict environments might not recognize `myecom.net` as secure despite HTTPS.

### The Solution

```
    https://myecom.net:30000           https://localhost:30000         Keycloak
              │                                  │                        │
              │ 1. User clicks Login             │                        │
              │    crypto.subtle missing?         │                        │
              │                                  │                        │
              │ 2. Redirect to localhost          │                        │
              │    /login?return=https://myecom.. │                        │
              ├─────────────────────────────────►│                        │
              │                                  │                        │
              │                                  │ 3. signinRedirect      │
              │                                  │    (PKCE works here)   │
              │                                  ├───────────────────────►│
              │                                  │                        │
              │                                  │ 4. Auth + callback     │
              │                                  │◄───────────────────────┤
              │                                  │                        │
              │                                  │ 5. Process tokens      │
              │                                  │    Fetch CSRF token    │
              │                                  │    Merge guest cart    │
              │                                  │                        │
              │ 6. Redirect back with token      │                        │
              │    in URL hash:                  │                        │
              │    https://myecom.net:30000/      │                        │
              │    #auth=<encoded-user>           │                        │
              │◄─────────────────────────────────┤                        │
              │                                  │                        │
              │ 7. AuthContext reads hash         │                        │
              │    Restores user session          │                        │
              │    Clears hash from URL           │                        │
              │                                  │                        │
```

### Security Measures

1. **URL hash is never sent to servers** — the `#` fragment is client-side only per the HTTP specification.
2. **Hash is cleared immediately** — `window.history.replaceState()` removes it from the URL and browser history.
3. **Origin allowlist** — only `https://localhost:30000` and `https://myecom.net:30000` are allowed relay targets.
4. **Token expires** — even if the hash is somehow captured, the tokens have short lifetimes.

---

## 19. Complete Data Flow Diagrams

### Full Authentication + API Request Lifecycle

```
    ┌─────────────────────────────────────────────────────────────────────┐
    │                         BROWSER                                      │
    │                                                                      │
    │   main.tsx                                                           │
    │     └── App.tsx                                                      │
    │           └── AuthProvider          ← manages auth state             │
    │                 └── AppWithAuth                                       │
    │                       │                                              │
    │                       ├── setTokenProvider()  → client.ts            │
    │                       │   (wires getAccessToken                      │
    │                       │    into API module)                           │
    │                       │                                              │
    │                       ├── fetchCsrfToken()  ─────────────┐           │
    │                       │   (on user change)               │           │
    │                       │                                  ▼           │
    │                       │                          GET /csrf/token     │
    │                       │                          Authorization: JWT  │
    │                       │                                  │           │
    │                       ├── NavBar                         │           │
    │                       │     ├── Login/Logout buttons     │           │
    │                       │     └── Cart count badge         │           │
    │                       │                                  │           │
    │                       └── Routes                         │           │
    │                             │                            │           │
    │                             ├── Public pages ────────────┤           │
    │                             │   (GET requests,           │           │
    │                             │    no CSRF needed)          │           │
    │                             │                            │           │
    │                             ├── Protected pages ─────────┤           │
    │                             │   (POST/PUT/DELETE,         │           │
    │                             │    JWT + CSRF-Token)        │           │
    │                             │                            │           │
    │                             └── Admin pages ─────────────┘           │
    │                                 (lazy loaded,                        │
    │                                  JWT + CSRF + admin role)            │
    │                                                                      │
    └──────────────────────────────────┬──────────────────────────────────┘
                                       │
                                       │ HTTPS (port 30000)
                                       ▼
    ┌─────────────────────────────────────────────────────────────────────┐
    │                    ISTIO GATEWAY (TLS termination)                    │
    │                                                                      │
    │   For mutating requests:                                             │
    │     1. ext_authz → csrf-service (validates X-CSRF-Token in Redis)   │
    │     2. RequestAuthentication (validates JWT via Keycloak JWKS)       │
    │     3. AuthorizationPolicy (checks roles, paths)                    │
    │                                                                      │
    │   For safe requests (GET/HEAD/OPTIONS):                              │
    │     1. RequestAuthentication (if JWT present)                        │
    │     2. AuthorizationPolicy                                           │
    │     3. csrf-service refreshes token TTL (fire-and-forget)           │
    │                                                                      │
    └──────────────┬──────────────────────────────┬───────────────────────┘
                   │                              │
                   ▼                              ▼
    ┌──────────────────────┐       ┌──────────────────────────┐
    │  E-Commerce Service  │ mTLS  │  Inventory Service       │
    │  (Spring Boot)       │◄─────►│  (FastAPI)               │
    │  /ecom/*             │       │  /inven/*                │
    │                      │       │                          │
    │  JWT validated again │       │  JWT validated again     │
    │  (defense in depth)  │       │  (defense in depth)      │
    └──────────────────────┘       └──────────────────────────┘
```

### Request Header Composition

```
    GET /ecom/books (public, no auth needed)
    ┌─────────────────────────────────────┐
    │ Content-Type: application/json      │
    └─────────────────────────────────────┘

    GET /ecom/cart (authenticated read)
    ┌─────────────────────────────────────┐
    │ Content-Type: application/json      │
    │ Authorization: Bearer <jwt>         │
    └─────────────────────────────────────┘

    POST /ecom/cart (authenticated mutation)
    ┌─────────────────────────────────────┐
    │ Content-Type: application/json      │
    │ Authorization: Bearer <jwt>         │
    │ X-CSRF-Token: <uuid>               │
    └─────────────────────────────────────┘
```

---

## 20. TypeScript Generics -- The `<T>` Syntax

Generics are one of TypeScript's most powerful features. They let you write reusable code that works with **any type** while preserving type safety. This app uses generics extensively in the API layer.

### The Problem Generics Solve

Without generics, you'd need separate functions for each return type:

```typescript
// WITHOUT generics — repetitive and unmaintainable
async function getBooks(url: string): Promise<Page<Book>> {
  const resp = await fetch(url)
  return resp.json()  // Returns Page<Book>
}

async function getCart(url: string): Promise<CartItem[]> {
  const resp = await fetch(url)
  return resp.json()  // Returns CartItem[]
}

async function getStock(url: string): Promise<StockResponse> {
  const resp = await fetch(url)
  return resp.json()  // Returns StockResponse
}
// ... endless repetition for every API type
```

### The Generic Solution

```typescript
// WITH generics — one function works for ALL types
async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const resp = await fetch(url, { ...options, headers })
  return resp.json()  // Returns T — whatever the caller specifies
}
```

**`<T>` is a type parameter** — a placeholder for a type that will be specified later. Think of it like a function parameter, but for types instead of values:

```
  Function parameter:  function greet(name: string) — "name" is filled in at call time
  Type parameter:      function request<T>(url: string): T — "T" is filled in at call time
```

### How It's Used in This App

```typescript
// When calling request<T>, the caller specifies T:

// T = Page<Book>
api.get<Page<Book>>('/ecom/books')
//       ^^^^^^^^^ — T is "Page<Book>"
//       The return type is Promise<Page<Book>>

// T = CartItem[]
api.get<CartItem[]>('/ecom/cart')
//       ^^^^^^^^^^ — T is "CartItem[]"
//       The return type is Promise<CartItem[]>

// T = StockResponse
api.get<StockResponse>(`/inven/stock/${bookId}`)
//       ^^^^^^^^^^^^^ — T is "StockResponse"
//       The return type is Promise<StockResponse>

// T = void (no response body expected)
api.delete<void>(`/ecom/cart/${cartItemId}`)
//          ^^^^ — T is "void"
//          The return type is Promise<void>
```

### Breaking Down the Syntax

```typescript
async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
//                     ^                                           ^^^^^^^^^
//                     │                                           │
//                     Type parameter declaration                  Return type uses T
//                     "This function accepts one type parameter"  "It returns a Promise of T"
```

```typescript
export const api = {
  get: <T>(url: string) => request<T>(url),
//     ^^^                         ^^^
//     │                           │
//     Declares T for this arrow   Passes T to request
//     function
//
  post: <T>(url: string, body: unknown) =>
    request<T>(url, { method: 'POST', body: JSON.stringify(body) }),
//  ^^^^^^^^^
//  Passes T through to request — type flows from caller to implementation
}
```

### Nested Generics

```typescript
interface Page<T> {
  content: T[]           // Array of whatever type T is
  totalElements: number
  totalPages: number
  number: number
  size: number
}

// Page<Book> becomes:
// {
//   content: Book[]     ← T is replaced with Book
//   totalElements: number
//   totalPages: number
//   number: number
//   size: number
// }

// So api.get<Page<Book>>(...) means:
// The outer <T> of request is Page<Book>
// The inner <T> of Page is Book
// Return type: Promise<Page<Book>> which is Promise<{ content: Book[], ... }>
```

### Generic Constraints

TypeScript also supports constraining generics (not heavily used in this codebase, but important to understand):

```typescript
// T must extend object (can't be string or number)
function processResponse<T extends object>(data: T): T {
  return data
}

// T must have an 'id' property
function findById<T extends { id: string }>(items: T[], id: string): T | undefined {
  return items.find(item => item.id === id)
}
```

### Utility Types with Generics

```typescript
// Omit<Type, Keys> — removes specified keys from a type
export function addToGuestCart(item: Omit<GuestCartItem, 'quantity'>): GuestCartItem[] {
//                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
// Omit<GuestCartItem, 'quantity'> creates:
// {
//   bookId: string     ← kept
//   title: string      ← kept
//   price: number      ← kept
//   // quantity: number ← REMOVED by Omit
// }
```

---

## 21. Promises & Async/Await Deep Dive

### What Is a Promise?

A Promise represents a value that will be available **in the future**. It's JavaScript's way of handling asynchronous operations (network requests, timers, file reads).

```typescript
// A Promise is in one of three states:
// 1. PENDING   — still waiting for the result
// 2. FULFILLED — completed successfully (has a value)
// 3. REJECTED  — failed (has an error)

//        ┌──── PENDING ────┐
//        │                 │
//        ▼                 ▼
//   FULFILLED          REJECTED
//   (value)            (error)
```

### Promise Syntax — Three Styles

```typescript
// STYLE 1: .then() chains (original Promise API)
fetch('/ecom/books')
  .then(response => response.json())      // Transform response to JSON
  .then(data => console.log(data))         // Use the data
  .catch(error => console.error(error))    // Handle errors

// STYLE 2: async/await (syntactic sugar over .then)
async function getBooks() {
  try {
    const response = await fetch('/ecom/books')   // Pause until fetch completes
    const data = await response.json()             // Pause until JSON parsing completes
    console.log(data)                              // Use the data
  } catch (error) {
    console.error(error)                           // Handle errors
  }
}

// STYLE 3: Mixed (used in CallbackPage.tsx)
userManager.signinRedirectCallback()
  .then(async (user) => {                // .then with an async callback
    const csrfResp = await fetch(...)    // await inside the .then
    // ...
  })
  .catch(err => {
    console.error('OIDC callback error:', err)
  })
```

### Promises in This Codebase

#### 1. The API Client Return Type

```typescript
async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
//                                                                 ^^^^^^^^^^
// This function returns a Promise that resolves to type T
// The "async" keyword means the function automatically wraps its return value in a Promise
```

When you write `async function`, the return value is **always** a `Promise`:

```typescript
async function getNumber(): Promise<number> {
  return 42    // JavaScript wraps this: return Promise.resolve(42)
}

// These are equivalent:
const a = await getNumber()     // a = 42 (unwrapped)
const b = getNumber()           // b = Promise<number> (still wrapped)
```

#### 2. Promise.allSettled vs Promise.all

```typescript
// In CallbackPage.tsx — merging guest cart items:

await Promise.allSettled(
  pending.map(item =>
    fetch('/ecom/cart', { method: 'POST', ... })
  )
)
```

**`Promise.allSettled`** waits for ALL promises to complete (succeed or fail):

```typescript
// Promise.all — FAILS FAST
// If ANY promise rejects, the whole thing rejects immediately
// Other promises may still be running but their results are lost
const results = await Promise.all([
  fetch('/cart/item1'),    // ✓ success
  fetch('/cart/item2'),    // ✗ fails → EVERYTHING fails
  fetch('/cart/item3'),    // ✓ success (but result is lost!)
])
// Throws error from item2

// Promise.allSettled — WAITS FOR ALL
// Every promise gets a result, regardless of success/failure
const results = await Promise.allSettled([
  fetch('/cart/item1'),    // { status: 'fulfilled', value: Response }
  fetch('/cart/item2'),    // { status: 'rejected',  reason: Error }
  fetch('/cart/item3'),    // { status: 'fulfilled', value: Response }
])
// results = array of 3 items, each with status + value/reason
```

**Why `allSettled` for cart merge?** If merging one item fails (maybe it's out of stock), we still want the other items to merge successfully. Using `Promise.all` would discard all results if any single item fails.

#### 3. Fire-and-Forget Promises

```typescript
// In App.tsx:
useEffect(() => {
  if (user) {
    fetchCsrfToken().catch(err => console.warn('CSRF token fetch failed:', err))
    //               ^^^^^^
    // The .catch() ensures the Promise rejection doesn't crash the app
    // But we DON'T await it — it runs in the background
  }
}, [user])
```

**Fire-and-forget** means starting an async operation without awaiting its result. The `.catch()` is critical — without it, an unhandled Promise rejection would be logged as an error (or crash the app in strict mode).

#### 4. The Async IIFE Pattern

```typescript
// In AuthContext.tsx:
useEffect(() => {
  ;(async () => {
    // ... async code here ...
    const u = await userManager.getUser()
    setUser(u)
    setIsLoading(false)
  })()
}, [])
```

**Why this pattern?** React's `useEffect` callback cannot be `async` directly:

```typescript
// THIS IS INVALID — React useEffect must return void or a cleanup function
useEffect(async () => {     // ❌ Returns a Promise, not void
  await someAsyncWork()
}, [])

// SOLUTION: Create and immediately invoke an async function inside the effect
useEffect(() => {           // ✓ Returns void (or cleanup function)
  (async () => {
    await someAsyncWork()
  })()                      // () at the end invokes the function immediately
}, [])
```

The `(async () => { ... })()` pattern is called an **Immediately Invoked Function Expression (IIFE)**. The semicolon before it (`;(async...`) prevents JavaScript from interpreting the `(` as a function call on the previous line.

#### 5. Optional Chaining with Async Operations

```typescript
const token = _getToken?.()
//                     ^^
// Optional chaining on function call
// If _getToken is null/undefined → returns undefined (no error)
// If _getToken is a function → calls it and returns the result
```

---

## 22. Spread & Destructuring -- The `...` Syntax

The `...` (three dots) operator has three different meanings in JavaScript/TypeScript depending on context.

### 1. Spread in Object Literals (Most Common in This App)

```typescript
// In client.ts — building headers:
const headers: HeadersInit = {
  'Content-Type': 'application/json',        // Always present
  ...(options.headers ?? {}),                 // Spread existing headers
  ...(token ? { Authorization: `Bearer ${token}` } : {}),     // Conditionally add auth
  ...(isMutating && _csrfToken ? { 'X-CSRF-Token': _csrfToken } : {}), // Conditionally add CSRF
}
```

**How object spread works:**

```typescript
// Spread copies all properties from one object into another:
const base = { a: 1, b: 2 }
const extended = { ...base, c: 3 }
// Result: { a: 1, b: 2, c: 3 }

// Later properties override earlier ones:
const override = { ...base, b: 99 }
// Result: { a: 1, b: 99 }

// Spreading an empty object does nothing:
const same = { ...base, ...{} }
// Result: { a: 1, b: 2 }
```

**The conditional spread pattern:**

```typescript
// This is the key pattern used throughout the codebase:
...(condition ? { key: value } : {})

// Read as:
// IF condition is true  → spread { key: value } → adds the property
// IF condition is false → spread {} → adds nothing

// Example breakdown from client.ts:
...(token ? { Authorization: `Bearer ${token}` } : {})

// When token = "abc123":
// → condition is truthy
// → spreads { Authorization: "Bearer abc123" }
// → header is added

// When token = null:
// → condition is falsy
// → spreads {}
// → nothing added
```

### 2. Spread in Arrays

```typescript
// Not heavily used in this app, but important to understand:
const arr1 = [1, 2, 3]
const arr2 = [0, ...arr1, 4]
// Result: [0, 1, 2, 3, 4]
```

### 3. Spread in Function Arguments (Rest Parameters)

```typescript
// Collecting remaining arguments:
function sum(...numbers: number[]): number {
  return numbers.reduce((total, n) => total + n, 0)
}
sum(1, 2, 3)  // numbers = [1, 2, 3], result = 6

// Spreading an array into function arguments:
const args = [1, 2, 3] as const
Math.max(...args)  // equivalent to Math.max(1, 2, 3)
```

### 4. Destructuring (The Receiving Side of `...`)

**Object destructuring** — extracting properties into variables:

```typescript
// In NavBar.tsx:
const { user, isLoading, isAdmin, login, logout } = useAuth()
//      ^^^^  ^^^^^^^^^  ^^^^^^^  ^^^^^  ^^^^^^
// These become local variables, extracted from the object returned by useAuth()

// Equivalent to:
const authContext = useAuth()
const user = authContext.user
const isLoading = authContext.isLoading
const isAdmin = authContext.isAdmin
const login = authContext.login
const logout = authContext.logout
```

**Destructuring in function parameters:**

```typescript
// In AuthProvider:
export function AuthProvider({ children }: { children: React.ReactNode }) {
//                           ^^^^^^^^^^
// Destructures the props object to extract "children" directly
// Without destructuring:
// export function AuthProvider(props: { children: React.ReactNode }) {
//   const children = props.children
```

**Destructuring with rest:**

```typescript
// Collecting remaining properties into a new object:
const { method, ...restOptions } = options
// method = options.method
// restOptions = everything else from options (body, headers, etc.)
```

### 5. Spread in JSX

```typescript
// Spreading props onto a component:
const buttonProps = { onClick: handleClick, disabled: true, className: 'btn' }
<button {...buttonProps}>Click me</button>
// Equivalent to:
<button onClick={handleClick} disabled={true} className="btn">Click me</button>

// Used in fetch:
const resp = await fetch(url, { ...options, headers })
//                              ^^^^^^^^^^
// Spreads all properties from "options" (method, body, etc.)
// then overrides "headers" with our custom headers object
```

### Complete Example: How Headers Are Built

```typescript
// Given:
const options = {
  method: 'POST',
  body: '{"bookId":"abc","quantity":1}',
  headers: { 'X-Custom': 'value' }          // Caller-provided header
}
const token = 'eyJhbGciOiJSUzI1NiIs...'     // JWT access token
const _csrfToken = 'a1b2c3d4-e5f6-...'      // CSRF UUID token
const isMutating = true                       // POST is a mutating method

// The spread expression:
const headers = {
  'Content-Type': 'application/json',
  ...(options.headers ?? {}),
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...(isMutating && _csrfToken ? { 'X-CSRF-Token': _csrfToken } : {}),
}

// Step-by-step evaluation:
// 1. Start:      { 'Content-Type': 'application/json' }
// 2. Spread options.headers:
//    → { 'Content-Type': 'application/json', 'X-Custom': 'value' }
// 3. token is truthy:
//    → { 'Content-Type': 'application/json', 'X-Custom': 'value',
//        'Authorization': 'Bearer eyJhbGciOiJSUzI1NiIs...' }
// 4. isMutating && _csrfToken is truthy:
//    → { 'Content-Type': 'application/json', 'X-Custom': 'value',
//        'Authorization': 'Bearer eyJhbGciOiJSUzI1NiIs...',
//        'X-CSRF-Token': 'a1b2c3d4-e5f6-...' }
```

---

## 23. Advanced React Patterns Used in This App

### Pattern 1: React Context + Custom Hook (Provider Pattern)

This is the most important architectural pattern in the app. It solves the "prop drilling" problem.

**The problem:**

```typescript
// WITHOUT Context — prop drilling nightmare:
<App user={user} login={login} logout={logout}>
  <Layout user={user}>                           // Just passing through
    <NavBar user={user} login={login} logout={logout} />
    <MainContent>
      <CartPage user={user}>                     // Just passing through
        <CartItem user={user} />                 // Finally needs it
      </CartPage>
    </MainContent>
  </Layout>
</App>
```

**The solution (used in this app):**

```typescript
// Step 1: Create Context with type
const AuthContext = createContext<AuthContextValue | null>(null)

// Step 2: Create Provider component (manages state)
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  // ... all auth logic ...
  return (
    <AuthContext.Provider value={{ user, isLoading, isAdmin, login, logout, getAccessToken }}>
      {children}
    </AuthContext.Provider>
  )
}

// Step 3: Create custom hook (consumes context)
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

// Step 4: Wrap app in Provider
<AuthProvider>
  <AppWithAuth />     {/* Everything inside can call useAuth() */}
</AuthProvider>

// Step 5: Use anywhere — no prop drilling!
function NavBar() {
  const { user, login, logout } = useAuth()   // Direct access
}
function CartPage() {
  const { user } = useAuth()                   // Direct access
}
```

**Why the custom hook throws an error:**

```typescript
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  //  ^^^^
  // If ctx is null, it means this component is NOT inside an AuthProvider
  // This is a developer error — catching it early with a clear message
  // saves hours of debugging "undefined is not a function" errors
  return ctx   // TypeScript now knows ctx is AuthContextValue (not null)
}
```

### Pattern 2: Module-Level State (Singleton State Outside React)

The API client uses module-level variables instead of React state:

```typescript
// In client.ts:
let _getToken: (() => string | null) | null = null
let _csrfToken: string | null = null
```

**Why not React state?**

```typescript
// React state is tied to a component's lifecycle:
function MyComponent() {
  const [token, setToken] = useState(null)
  // ↑ This state is destroyed when MyComponent unmounts
  //   It's scoped to this specific component instance
}

// Module-level state persists for the entire page lifecycle:
let _token = null  // Created once when the module is imported
                   // Survives component mount/unmount cycles
                   // Shared across all imports of this module
```

The API client needs state that:
- Persists across component lifecycle (not tied to any component)
- Is shared across all API calls (singleton)
- Is not reactive (no re-renders needed when it changes)

### Pattern 3: useCallback for Stable Function References

```typescript
const login = useCallback((returnPath?: string) => {
  // ... login logic ...
}, [])

const logout = useCallback(async () => {
  // ... logout logic ...
}, [])

const getAccessToken = useCallback(() => user?.access_token ?? null, [user])
```

**Why useCallback?**

Without `useCallback`, a new function is created on every render:

```typescript
// Without useCallback:
function AuthProvider({ children }) {
  const login = (returnPath) => { ... }
  //    ^^^^^ New function object every render

  return <AuthContext.Provider value={{ login, ... }}>
    {children}
  </AuthContext.Provider>
}

// Every render creates a new "login" function
// This makes the context value a new object (different reference)
// Every consumer re-renders even if nothing meaningful changed
```

With `useCallback`:

```typescript
// With useCallback:
const login = useCallback((returnPath) => { ... }, [])
//            ^^^^^^^^^^^                          ^^
//            "Memoize this function"              "Recreate only when
//                                                  these deps change"
//                                                  [] = never recreate

// Same function reference across renders → context value is stable
// Consumers only re-render when actual data (user, isAdmin, etc.) changes
```

**The `[user]` dependency in getAccessToken:**

```typescript
const getAccessToken = useCallback(() => user?.access_token ?? null, [user])
//                                                                   ^^^^^^
// This function is recreated ONLY when "user" changes
// Because the function closes over "user" — if user changes,
// the function needs to capture the new user reference
```

### Pattern 4: useEffect Cleanup Functions

```typescript
// In NavBar.tsx:
useEffect(() => {
  if (!user) return                        // Early return = no setup needed

  const fetchCount = () => { ... }
  fetchCount()                              // Initial fetch

  window.addEventListener('cartUpdated', fetchCount)   // Subscribe

  return () => {                            // ← CLEANUP FUNCTION
    window.removeEventListener('cartUpdated', fetchCount)  // Unsubscribe
  }
}, [user])
```

**When does cleanup run?**

```
  Component mounts
    │
    ▼
  Effect runs: addEventListener('cartUpdated', fetchCount)
    │
    │ ... user interacts with the page ...
    │
    ▼
  "user" changes (dependency array)
    │
    ▼
  CLEANUP runs first: removeEventListener('cartUpdated', fetchCount)  ← old handler removed
    │
    ▼
  Effect runs again: addEventListener('cartUpdated', fetchCount)       ← new handler added
    │
    │ ... more interaction ...
    │
    ▼
  Component unmounts
    │
    ▼
  CLEANUP runs: removeEventListener('cartUpdated', fetchCount)         ← final cleanup
```

**Why cleanup matters:** Without removing event listeners, each render would add **another** listener. After 10 re-renders, you'd have 10 listeners firing on every event — a memory leak.

### Pattern 5: Lazy Loading with React.lazy and Suspense

```typescript
// In App.tsx:

// Step 1: Define lazy components (at module level, NOT inside a component)
const AdminDashboard = React.lazy(() => import('./pages/admin/AdminDashboard'))
//    ^^^^^^^^^^^^^^                    ^^^^^^
//    This is a component              Dynamic import — returns a Promise
//    that loads on first render       Vite creates a separate chunk for this file

// Step 2: Wrap in Suspense to show a fallback while loading
<Suspense fallback={<div>Loading...</div>}>
  <Routes>
    <Route path="/admin" element={<AdminRoute><AdminDashboard /></AdminRoute>} />
  </Routes>
</Suspense>
```

**What happens at runtime:**

```
  User navigates to /admin
    │
    ▼
  React sees <AdminDashboard /> — a lazy component
    │
    ▼
  React suspends rendering and shows the Suspense fallback: "Loading..."
    │
    ▼
  Browser fetches the admin chunk: /assets/AdminDashboard-abc123.js
    │
    ▼
  Chunk loaded and parsed
    │
    ▼
  React resumes rendering with the actual AdminDashboard component
    │
    ▼
  User sees the admin dashboard
```

**Why lazy load?** The admin pages include forms, tables, and CRUD logic that regular users never need. Lazy loading keeps the main bundle small and loads admin code only on demand.

### Pattern 6: Conditional Rendering Patterns

This app uses four different conditional rendering techniques:

```typescript
// 1. Logical AND (&&) — show or hide
{isAdmin && <Link to="/admin">Admin</Link>}
// If isAdmin is true  → renders the Link
// If isAdmin is false → renders nothing

// 2. Ternary (? :) — show one OR the other
{user ? (
  <button onClick={logout}>Logout</button>
) : (
  <button onClick={() => login()}>Login</button>
)}

// 3. Early return — different entire renders
if (isLoading) return <div>Loading...</div>
if (!user) { login('/admin'); return null }
if (!isAdmin) return <div>Access Denied</div>
return <>{children}</>

// 4. Inline conditional in JSX attributes
<Link to="/admin" style={{ color: isAdmin ? '#fbd38d' : '#fff' }}>
```

### Pattern 7: Custom DOM Events for Cross-Component Communication

```typescript
// In CartPage.tsx (or any component that modifies the cart):
window.dispatchEvent(new Event('cartUpdated'))
//     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
// Creates and fires a custom DOM event

// In NavBar.tsx (listening for cart changes):
window.addEventListener('cartUpdated', fetchCount)
//                       ^^^^^^^^^^^^
// Listens for the custom event and refreshes the cart count
```

**Why custom events instead of state management?**

```
  Option A: Lift state up (prop drilling)
  ┌────────────────────────────┐
  │ App (owns cartCount state) │  ← every cart change flows through App
  │   ├── NavBar (reads count) │  ← receives count as prop
  │   └── CartPage (modifies)  │  ← receives setter as prop
  └────────────────────────────┘
  Problem: App re-renders on every cart change, even if only NavBar needs it

  Option B: Context (like AuthContext)
  Overkill for a simple "something changed" signal

  Option C: Custom DOM events ← Used in this app
  ┌────────────┐    'cartUpdated'    ┌────────────┐
  │ CartPage   │ ──────────────────► │ NavBar     │
  │ (dispatch) │                     │ (listener) │
  └────────────┘                     └────────────┘
  Minimal coupling. NavBar fetches fresh data from the server.
```

### Pattern 8: IIFE in useEffect (Async Effects)

```typescript
useEffect(() => {
  ;(async () => {                    // ← IIFE: Immediately Invoked Function Expression
    const u = await userManager.getUser()
    setUser(u)
    setIsLoading(false)
  })()                               // ← The () invokes the function immediately
}, [])
```

**The semicolon before `(`:**

```typescript
// Without the semicolon, JavaScript might parse this as:
const previousExpression = someValue
(async () => { ... })()
// ↑ JavaScript thinks: someValue(async () => { ... })()
//   "Call someValue as a function with an async function as argument"

// The semicolon prevents this:
;(async () => { ... })()
// ↑ Forces a new statement — no ambiguity
```

### Pattern 9: Null Coalescing and Optional Chaining

Used extensively throughout the codebase:

```typescript
// Optional chaining (?.) — safe property access
user?.access_token              // If user is null → undefined (no error)
user?.profile?.email            // Chain multiple levels safely

// Optional chaining on function calls
_getToken?.()                   // If _getToken is null → undefined (no error)
                                // If _getToken is a function → calls it

// Nullish coalescing (??) — default values for null/undefined
user?.access_token ?? null      // If access_token is undefined → null
options.method ?? 'GET'         // If method is undefined → 'GET'

// Combined pattern (very common):
const resolvedPath = returnPath ?? (window.location.pathname + window.location.search)
//                               ^^
// If returnPath is null/undefined → use current path
// If returnPath is a string → use it directly

// Difference from || (logical OR):
const a = '' ?? 'default'       // a = '' (empty string is NOT nullish)
const b = '' || 'default'       // b = 'default' (empty string IS falsy)

const c = 0 ?? 'default'        // c = 0 (zero is NOT nullish)
const d = 0 || 'default'        // d = 'default' (zero IS falsy)

// Use ?? when you want to preserve falsy values (0, '', false)
// Use || when you want to replace any falsy value
```

---

## 24. Summary & Security Checklist

### What You've Learned

| Topic | Key Takeaway |
|-------|-------------|
| **OAuth2/OIDC** | Authorization Code Flow with PKCE is the standard for SPAs |
| **oidc-client-ts** | Handles the entire OIDC lifecycle: redirects, token exchange, silent renewal, logout |
| **Token Storage** | In-memory for access token, sessionStorage for session persistence, never localStorage |
| **JWT** | Decoded client-side for UI only; verified server-side via JWKS |
| **CSRF** | Gateway-level protection with Redis-backed tokens, sliding TTL, auto-retry on 403 |
| **API Client** | Centralized request function with automatic header injection and error recovery |
| **Route Guards** | `ProtectedRoute` for auth, `AdminRoute` for role-based access |
| **Guest Cart** | localStorage for unauthenticated users, merged to server on login |
| **Code Splitting** | `React.lazy()` for admin pages — loaded only when needed |
| **Context Pattern** | `AuthProvider` + `useAuth()` for clean dependency injection |

### Security Checklist

- [ ] Tokens stored in memory / sessionStorage (never localStorage)
- [ ] PKCE enabled on Authorization Code Flow
- [ ] CSRF token required on all mutating requests
- [ ] JWT validated server-side (never trust client claims)
- [ ] Route guards prevent unauthorized UI access
- [ ] Admin role checked in both UI and backend
- [ ] Logout terminates both local and server sessions
- [ ] Silent renewal keeps tokens fresh without user interaction
- [ ] Cross-origin relay uses URL hash (not sent to servers)
- [ ] Hash cleared immediately from browser history
- [ ] Error boundaries prevent auth failures from crashing the app
- [ ] Guest cart uses localStorage only for non-sensitive data

---

*This guide is based on the BookStore Platform's React application — a production-aligned microservices e-commerce system deployed on Kubernetes with Istio service mesh, Keycloak OIDC, and gateway-level CSRF protection.*
