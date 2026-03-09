import { useLocation, useSearchParams, Navigate, Link } from 'react-router-dom'

export default function OrderConfirmationPage() {
  const location = useLocation()
  const [params] = useSearchParams()

  // Prefer state passed via navigate(), fall back to query params for backward compatibility
  const state = location.state as { orderId?: string; total?: number } | null
  const orderId = state?.orderId ?? params.get('orderId')
  const total = state?.total != null ? state.total.toFixed(2) : params.get('total')

  // If no order data at all, redirect to catalog
  if (!orderId || total == null) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="page" style={{ textAlign: 'center', paddingTop: '2rem' }}>
      <h1 className="page-title">Order Confirmed!</h1>
      <p>Order ID: <strong>{orderId}</strong></p>
      <p>Total: <strong>${total}</strong></p>
      <Link to="/" className="btn btn-outline" style={{ display: 'inline-block', marginTop: '1rem' }}>
        Continue Shopping
      </Link>
    </div>
  )
}
