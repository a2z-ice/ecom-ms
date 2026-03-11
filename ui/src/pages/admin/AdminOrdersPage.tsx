import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminOrdersApi, AdminOrder } from '../../api/admin'

export default function AdminOrdersPage() {
  const [orders, setOrders] = useState<AdminOrder[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const PAGE_SIZE = 20

  const load = (p: number) => {
    setLoading(true)
    setError(null)
    adminOrdersApi.list(p, PAGE_SIZE)
      .then(data => {
        setOrders(data.content)
        setTotal(data.totalElements)
        setPage(p)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load(0) }, [])

  return (
    <div style={{ padding: '2rem', maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>All Orders</h1>
          <p style={{ color: '#718096', fontSize: '0.875rem' }}>{total} orders total</p>
        </div>
        <Link to="/admin" style={{ textDecoration: 'none' }}>
          <button className="btn btn-outline">← Dashboard</button>
        </Link>
      </div>

      {error && (
        <div style={{ background: '#fff5f5', border: '1px solid #fc8181', borderRadius: '6px', padding: '1rem', marginBottom: '1rem', color: '#c53030' }}>
          {error}
        </div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f7fafc', borderBottom: '1px solid #e2e8f0' }}>
              <th style={th}>Order ID</th>
              <th style={th}>User ID</th>
              <th style={th}>Total</th>
              <th style={th}>Status</th>
              <th style={th}>Created At</th>
              <th style={{ ...th, width: '80px' }}>Items</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: '#a0aec0' }}>Loading...</td></tr>
            ) : orders.length === 0 ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: '#a0aec0' }}>No orders yet</td></tr>
            ) : orders.map(order => (
              <>
                <tr
                  key={order.id}
                  style={{ borderBottom: '1px solid #e2e8f0', cursor: 'pointer' }}
                  onClick={() => setExpanded(expanded === order.id ? null : order.id)}
                >
                  <td style={{ ...td, fontFamily: 'monospace', fontSize: '0.75rem', color: '#718096' }}>
                    {order.id.slice(0, 8)}...
                  </td>
                  <td style={{ ...td, fontFamily: 'monospace', fontSize: '0.75rem', color: '#718096' }}>
                    {order.userId.slice(0, 8)}...
                  </td>
                  <td style={td}>${Number(order.total).toFixed(2)}</td>
                  <td style={td}>
                    <span style={{
                      padding: '0.2rem 0.6rem',
                      borderRadius: '12px',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      background: order.status === 'CONFIRMED' ? '#c6f6d5' : '#fefcbf',
                      color: order.status === 'CONFIRMED' ? '#276749' : '#744210',
                    }}>{order.status}</span>
                  </td>
                  <td style={{ ...td, fontSize: '0.8rem', color: '#718096' }}>
                    {new Date(order.createdAt).toLocaleString()}
                  </td>
                  <td style={{ ...td, textAlign: 'center', color: '#4299e1' }}>
                    {expanded === order.id ? '▲' : '▼'} {order.items.length}
                  </td>
                </tr>
                {expanded === order.id && (
                  <tr key={`${order.id}-items`}>
                    <td colSpan={6} style={{ padding: '0 1rem 1rem', background: '#f7fafc' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.5rem' }}>
                        <thead>
                          <tr>
                            <th style={{ ...th, fontSize: '0.7rem' }}>Book</th>
                            <th style={{ ...th, fontSize: '0.7rem' }}>Qty</th>
                            <th style={{ ...th, fontSize: '0.7rem' }}>Price/unit</th>
                            <th style={{ ...th, fontSize: '0.7rem' }}>Subtotal</th>
                          </tr>
                        </thead>
                        <tbody>
                          {order.items.map(item => (
                            <tr key={item.bookId}>
                              <td style={{ ...td, fontSize: '0.8rem' }}>{item.title}</td>
                              <td style={{ ...td, fontSize: '0.8rem' }}>{item.quantity}</td>
                              <td style={{ ...td, fontSize: '0.8rem' }}>${Number(item.priceAtPurchase).toFixed(2)}</td>
                              <td style={{ ...td, fontSize: '0.8rem' }}>${(item.quantity * Number(item.priceAtPurchase)).toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {total > PAGE_SIZE && (
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginTop: '1.25rem' }}>
          <button className="btn btn-outline" disabled={page === 0} onClick={() => load(page - 1)}>Previous</button>
          <span style={{ padding: '0.5rem 1rem', color: '#718096' }}>Page {page + 1} of {Math.ceil(total / PAGE_SIZE)}</span>
          <button className="btn btn-outline" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => load(page + 1)}>Next</button>
        </div>
      )}
    </div>
  )
}

const th: React.CSSProperties = {
  padding: '0.75rem 1rem',
  textAlign: 'left',
  fontSize: '0.75rem',
  fontWeight: 600,
  color: '#4a5568',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
}

const td: React.CSSProperties = {
  padding: '0.75rem 1rem',
  fontSize: '0.875rem',
  color: '#2d3748',
}
