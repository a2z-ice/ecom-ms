import React from 'react'
import { useAuth } from '../auth/AuthContext'

/**
 * Route guard that only allows users with the admin Keycloak realm role.
 * - Not authenticated → triggers login redirect
 * - Authenticated but not admin → shows access denied
 * - Admin → renders children
 */
export default function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, isAdmin, login } = useAuth()

  if (isLoading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: '#718096' }}>
        Loading...
      </div>
    )
  }

  if (!user) {
    login('/admin')
    return null
  }

  if (!isAdmin) {
    return (
      <div style={{ padding: '2rem', maxWidth: '480px', margin: '4rem auto', textAlign: 'center' }}>
        <div style={{
          background: '#fff5f5',
          border: '1px solid #fc8181',
          borderRadius: '8px',
          padding: '2rem',
        }}>
          <h2 style={{ color: '#c53030', marginBottom: '0.5rem' }}>Access Denied</h2>
          <p style={{ color: '#742a2a' }}>
            You need the <strong>admin</strong> role to access this page.
          </p>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
