import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cartApi, CartItem } from '../api/cart'
import { useAuth } from '../auth/AuthContext'
import {
  getGuestCart,
  updateGuestCartQty,
  clearGuestCart,
  GuestCartItem,
} from '../hooks/useGuestCart'
import { Toast } from '../components/Toast'

export default function CartPage() {
  const { user, isLoading, login } = useAuth()
  const navigate = useNavigate()
  const [serverItems, setServerItems] = useState<CartItem[]>([])
  const [guestItems, setGuestItems] = useState<GuestCartItem[]>([])
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (isLoading) return

    if (!user) {
      // Guest mode — read from localStorage
      setGuestItems(getGuestCart())
      setLoading(false)
      return
    }

    // Authenticated — merge any pending guest cart first, then load server cart
    const pending = getGuestCart()
    const syncAndLoad = async () => {
      if (pending.length > 0) {
        await Promise.allSettled(
          pending.map(item => cartApi.add(item.bookId, item.quantity))
        )
        clearGuestCart()
      }
      const items = await cartApi.get()
      setServerItems(items)
      setLoading(false)
    }
    syncAndLoad().catch(() => setLoading(false))
  }, [user, isLoading])

  // Guest qty controls
  const handleGuestQty = (bookId: string, delta: number) => {
    setGuestItems(updateGuestCartQty(bookId, delta))
  }

  // Auth qty controls
  const handleServerQty = async (item: CartItem, delta: number) => {
    if (delta > 0) {
      await cartApi.add(item.book.id, 1)
    } else {
      if (item.quantity <= 1) {
        await cartApi.remove(item.id)
      } else {
        await cartApi.update(item.id, item.quantity - 1)
      }
    }
    const updated = await cartApi.get()
    setServerItems(updated)
    window.dispatchEvent(new Event('cartUpdated'))
  }

  const handleLoginToCheckout = () => {
    login('/cart')
  }

  const handleCheckout = async () => {
    setChecking(true)
    try {
      const order = await cartApi.checkout()
      window.dispatchEvent(new Event('cartUpdated'))
      navigate(`/order-confirmation?orderId=${order.id}&total=${order.total}`)
    } catch (e: any) {
      setToast('Checkout failed: ' + e.message)
    } finally {
      setChecking(false)
    }
  }

  if (isLoading) return <div className="loading-state">Loading...</div>
  if (loading)   return <div className="loading-state">Loading cart...</div>

  // ── Guest cart view ─────────────────────────────────────────────────────
  if (!user) {
    const total = guestItems.reduce((s, i) => s + i.price * i.quantity, 0)
    return (
      <div className="page">
        {toast && <Toast message={toast} onDone={() => setToast(null)} />}
        <h1 className="page-title">Your Cart</h1>
        {guestItems.length === 0 ? (
          <div className="empty-state">
            <p>Your cart is empty.</p>
            <a href="/" className="btn btn-outline" style={{ display: 'inline-block', marginTop: '1rem' }}>Browse Books</a>
          </div>
        ) : (
          <>
            <div className="badge-info">Browsing as guest — your items are saved locally</div>
            <table className="cart-table">
              <thead>
                <tr>
                  <th>Book</th>
                  <th>Qty</th>
                  <th style={{ textAlign: 'right' }}>Price</th>
                  <th style={{ textAlign: 'right' }}>Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {guestItems.map(item => (
                  <tr key={item.bookId}>
                    <td className="book-title">{item.title}</td>
                    <td>
                      <div className="qty-ctrl">
                        <button className="qty-btn" onClick={() => handleGuestQty(item.bookId, -1)}>−</button>
                        <span>{item.quantity}</span>
                        <button className="qty-btn" onClick={() => handleGuestQty(item.bookId, 1)}>+</button>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>${item.price.toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}>${(item.price * item.quantity).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="cart-total">Total: ${total.toFixed(2)}</div>
            <div className="cart-actions">
              <a href="/" className="btn btn-ghost">Continue Shopping</a>
              <button className="btn btn-primary btn-lg" onClick={handleLoginToCheckout}>
                Login to Checkout
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  // ── Authenticated cart view ─────────────────────────────────────────────
  const total = serverItems.reduce((s, i) => s + i.book.price * i.quantity, 0)
  return (
    <div className="page">
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
      <h1 className="page-title">Your Cart</h1>
      {serverItems.length === 0 ? (
        <div className="empty-state">
          <p>Your cart is empty.</p>
          <a href="/" className="btn btn-outline" style={{ display: 'inline-block', marginTop: '1rem' }}>Browse Books</a>
        </div>
      ) : (
        <>
          <table className="cart-table">
            <thead>
              <tr>
                <th>Book</th>
                <th>Qty</th>
                <th style={{ textAlign: 'right' }}>Price</th>
                <th style={{ textAlign: 'right' }}>Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {serverItems.map(item => (
                <tr key={item.id}>
                  <td className="book-title">{item.book.title}</td>
                  <td>
                    <div className="qty-ctrl">
                      <button className="qty-btn" onClick={() => handleServerQty(item, -1)}>−</button>
                      <span>{item.quantity}</span>
                      <button className="qty-btn" onClick={() => handleServerQty(item, 1)}>+</button>
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}>${item.book.price.toFixed(2)}</td>
                  <td style={{ textAlign: 'right' }}>${(item.book.price * item.quantity).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="cart-total">Total: ${total.toFixed(2)}</div>
          <div className="cart-actions">
            <a href="/" className="btn btn-ghost">Continue Shopping</a>
            <button
              className="btn btn-primary btn-lg"
              onClick={handleCheckout}
              disabled={checking}
            >
              {checking ? 'Processing...' : 'Checkout'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
