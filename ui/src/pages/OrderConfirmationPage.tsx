import { useSearchParams } from 'react-router-dom'

export default function OrderConfirmationPage() {
  const [params] = useSearchParams()
  return (
    <div style={{ padding: '2rem', textAlign: 'center' }}>
      <h1>Order Confirmed!</h1>
      <p>Order ID: <strong>{params.get('orderId')}</strong></p>
      <p>Total: <strong>${params.get('total')}</strong></p>
      <a href="/">Continue Shopping</a>
    </div>
  )
}
