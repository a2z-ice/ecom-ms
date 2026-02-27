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
  login: (returnPath?: string) => void
  logout: () => Promise<void>
  getAccessToken: () => string | null
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    userManager.getUser().then(u => {
      setUser(u)
      setIsLoading(false)
    })

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
    const resolvedPath = returnPath ?? (window.location.pathname + window.location.search)

    // PKCE requires crypto.subtle — only available in secure contexts.
    // localhost is always secure; http://myecom.net:30000 is not.
    if (window.location.hostname !== 'localhost') {
      window.location.href =
        `http://localhost:30000/login?return=${encodeURIComponent(resolvedPath)}`
      return
    }

    userManager.signinRedirect({ state: { returnUrl: resolvedPath } }).catch(err => {
      console.error('signinRedirect failed:', err)
    })
  }, [])

  const logout = useCallback(
    () => userManager.signoutRedirect({ post_logout_redirect_uri: window.location.origin }),
    [],
  )

  const getAccessToken = useCallback(() => user?.access_token ?? null, [user])

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout, getAccessToken }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
