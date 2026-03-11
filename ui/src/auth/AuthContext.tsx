import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'
import { User } from 'oidc-client-ts'
import { userManager } from './oidcConfig'

interface AuthContextValue {
  user: User | null
  isLoading: boolean
  isAdmin: boolean
  login: (returnPath?: string) => void
  logout: () => Promise<void>
  getAccessToken: () => string | null
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    // Check for cross-origin auth relay: token passed in URL hash from localhost login flow.
    // When login starts at http://myecom.net:30000 (no crypto.subtle), PKCE runs at
    // localhost:30000/callback, then the token is relayed here via #auth=<encoded-user>.
    const rawHash = window.location.hash
    const hashRelay = rawHash.startsWith('#auth=') ? rawHash.slice('#auth='.length) : null

    ;(async () => {
      if (hashRelay) {
        try {
          const relayedUser = User.fromStorageString(decodeURIComponent(hashRelay))
          // Clear the hash immediately — token must not stay in browser history.
          window.history.replaceState(null, '', window.location.pathname + window.location.search)
          await userManager.storeUser(relayedUser)
          setUser(relayedUser)
          setIsLoading(false)
          return
        } catch (e) {
          console.error('Auth relay restore failed:', e)
          // Fall through to normal load
        }
      }
      const u = await userManager.getUser()
      setUser(u)
      setIsLoading(false)
    })()

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

  const login = useCallback((returnPath?: string) => {
    // PKCE (S256) requires crypto.subtle, available only in secure contexts.
    // localhost is always secure. http://myecom.net:30000 resolves to 127.0.0.1 via
    // /etc/hosts — browsers that check the resolved IP (Chrome) treat it as secure too,
    // so crypto.subtle IS available there. Fall back to the localhost relay only if
    // crypto.subtle is genuinely absent (strict non-secure context).
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

  const logout = useCallback(async () => {
    // Back-channel logout: end the Keycloak SSO session via a direct POST
    // (no browser redirect, no Keycloak UI interaction).
    // Uses the OIDC RP-Initiated Logout spec with client_id + refresh_token.
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

    // Clear local session (sessionStorage + React state)
    await userManager.removeUser()
    setUser(null)

    // Navigate to home — no Keycloak redirect needed
    window.location.href = window.location.origin + '/'
  }, [])

  const getAccessToken = useCallback(() => user?.access_token ?? null, [user])

  // Decode the access token (no verification — authorization is still server-side)
  // to determine if the logged-in user has the admin realm role.
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
