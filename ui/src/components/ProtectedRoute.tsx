import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, login } = useAuth()
  const location = useLocation()

  useEffect(() => {
    if (!isLoading && !user) {
      login(location.pathname + location.search)
    }
  }, [isLoading, user, login, location])

  if (isLoading || !user) {
    return <div className="loading-state">Redirecting to login...</div>
  }

  return <>{children}</>
}
