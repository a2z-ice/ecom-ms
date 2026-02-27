import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { guestCartCount } from '../hooks/useGuestCart'

export default function NavBar() {
  const { user, isLoading, login, logout } = useAuth()
  const [cartCount, setCartCount] = useState(0)

  // Refresh guest cart count when localStorage changes (cross-tab or same-tab via storage event)
  useEffect(() => {
    if (user) {
      // Authenticated: reset badge (server cart count not tracked here for simplicity)
      setCartCount(0)
      return
    }
    // Guest: count from localStorage
    const update = () => setCartCount(guestCartCount())
    update()
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [user])

  // When a guest adds an item in the same tab, the storage event doesn't fire.
  // Poll every 500ms as a lightweight workaround for same-tab updates.
  useEffect(() => {
    if (user) return
    const id = setInterval(() => setCartCount(guestCartCount()), 500)
    return () => clearInterval(id)
  }, [user])

  return (
    <nav className="nav">
      <Link to="/" className="nav-brand">📚 Book Store</Link>
      <Link to="/search" className="nav-link">Search</Link>
      <Link to="/cart" className="nav-link nav-cart-badge">
        Cart
        {!user && cartCount > 0 && (
          <span className="nav-cart-count">{cartCount}</span>
        )}
      </Link>
      <div className="nav-spacer" />
      {isLoading ? (
        <span className="nav-user" style={{ opacity: 0.4 }}>...</span>
      ) : user ? (
        <>
          <span className="nav-user">{user.profile.email}</span>
          <button className="btn btn-ghost" onClick={logout}>Logout</button>
        </>
      ) : (
        <button className="btn btn-outline" onClick={() => login()} style={{ color: '#fff', borderColor: '#cbd5e0' }}>Login</button>
      )}
    </nav>
  )
}
