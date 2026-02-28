import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { cartApi } from '../api/cart'
import { guestCartCount } from '../hooks/useGuestCart'

export default function NavBar() {
  const { user, isLoading, login, logout } = useAuth()
  const [cartCount, setCartCount] = useState(0)

  // Authenticated: fetch cart count from server and listen for cartUpdated events
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

  // Guest: count from localStorage changes (cross-tab via storage event)
  useEffect(() => {
    if (user) return
    const update = () => setCartCount(guestCartCount())
    update()
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [user])

  // Guest: poll every 500ms for same-tab localStorage updates
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
        {cartCount > 0 && (
          <span className="nav-cart-count">{cartCount}</span>
        )}
      </Link>
      <div className="nav-spacer" />
      {isLoading ? (
        <span className="nav-user" style={{ opacity: 0.4 }}>...</span>
      ) : user ? (
        <>
          <span className="nav-user">{user.profile.email}</span>
          <button className="btn btn-ghost" onClick={logout} style={{ color: '#fff', borderColor: '#cbd5e0' }}>Logout</button>
        </>
      ) : (
        <button className="btn btn-outline" onClick={() => login()} style={{ color: '#fff', borderColor: '#cbd5e0' }}>Login</button>
      )}
    </nav>
  )
}
