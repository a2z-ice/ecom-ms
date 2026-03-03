import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminBooksApi, adminOrdersApi, adminStockApi } from '../../api/admin'

interface Stats {
  totalBooks: number
  totalOrders: number
  lowStockCount: number
  outOfStockCount: number
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      adminBooksApi.list(0, 1),
      adminOrdersApi.list(0, 1),
      adminStockApi.list(0, 200),
    ])
      .then(([books, orders, stock]) => {
        setStats({
          totalBooks: books.totalElements,
          totalOrders: orders.totalElements,
          lowStockCount: stock.filter(s => s.available > 0 && s.available <= 3).length,
          outOfStockCount: stock.filter(s => s.available <= 0).length,
        })
      })
      .catch(err => setError(err.message))
  }, [])

  return (
    <div style={{ padding: '2rem', maxWidth: '900px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 700, marginBottom: '0.25rem' }}>
        Admin Dashboard
      </h1>
      <p style={{ color: '#718096', marginBottom: '2rem' }}>
        Manage books, stock levels, and view orders.
      </p>

      {error && (
        <div style={{ background: '#fff5f5', border: '1px solid #fc8181', borderRadius: '6px', padding: '1rem', marginBottom: '1.5rem', color: '#c53030' }}>
          Failed to load stats: {error}
        </div>
      )}

      {/* Stats cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '2.5rem' }}>
        <StatCard label="Total Books" value={stats?.totalBooks} color="#4299e1" />
        <StatCard label="Total Orders" value={stats?.totalOrders} color="#48bb78" />
        <StatCard label="Low Stock" value={stats?.lowStockCount} color="#ed8936" />
        <StatCard label="Out of Stock" value={stats?.outOfStockCount} color="#e53e3e" />
      </div>

      {/* Quick links */}
      <h2 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>Quick Actions</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
        <AdminCard to="/admin/books" title="Manage Books" description="Add, edit, or remove books from the catalog." />
        <AdminCard to="/admin/books/new" title="Add New Book" description="Create a new book entry in the catalog." />
        <AdminCard to="/admin/stock" title="Manage Stock" description="Set or adjust inventory quantities." />
        <AdminCard to="/admin/orders" title="View Orders" description="Browse all customer orders." />
      </div>
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: number | undefined; color: string }) {
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #e2e8f0',
      borderRadius: '8px',
      padding: '1.5rem',
      borderTop: `4px solid ${color}`,
    }}>
      <div style={{ fontSize: '2rem', fontWeight: 700, color }}>
        {value === undefined ? '—' : value}
      </div>
      <div style={{ color: '#718096', fontSize: '0.875rem', marginTop: '0.25rem' }}>{label}</div>
    </div>
  )
}

function AdminCard({ to, title, description }: { to: string; title: string; description: string }) {
  return (
    <Link to={to} style={{ textDecoration: 'none' }}>
      <div style={{
        background: '#fff',
        border: '1px solid #e2e8f0',
        borderRadius: '8px',
        padding: '1.25rem',
        cursor: 'pointer',
        transition: 'box-shadow 0.15s',
      }}
        onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)')}
        onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
      >
        <div style={{ fontWeight: 600, marginBottom: '0.25rem', color: '#2d3748' }}>{title}</div>
        <div style={{ fontSize: '0.875rem', color: '#718096' }}>{description}</div>
      </div>
    </Link>
  )
}
