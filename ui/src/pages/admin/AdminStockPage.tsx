import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminBooksApi } from '../../api/admin'
import { adminStockApi } from '../../api/admin'
import { Book } from '../../api/books'
import { StockResponse } from '../../api/books'
import { StockBadge } from '../../components/StockBadge'

interface StockRow {
  stock: StockResponse
  book?: Book
}

export default function AdminStockPage() {
  const [rows, setRows] = useState<StockRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState<string>('')
  const [editMode, setEditMode] = useState<'set' | 'adjust'>('set')
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    setError(null)
    Promise.all([
      adminStockApi.list(0, 200),
      adminBooksApi.list(0, 200),
    ])
      .then(([stock, booksPage]) => {
        const bookMap = new Map(booksPage.content.map(b => [b.id, b]))
        setRows(stock.map(s => ({ stock: s, book: bookMap.get(s.book_id) })))
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const startEdit = (bookId: string, mode: 'set' | 'adjust') => {
    setEditId(bookId)
    setEditMode(mode)
    setEditValue('')
  }

  const cancelEdit = () => {
    setEditId(null)
    setEditValue('')
  }

  const saveEdit = async (bookId: string) => {
    const val = parseInt(editValue, 10)
    if (isNaN(val)) {
      alert('Enter a valid number')
      return
    }
    setSaving(true)
    try {
      if (editMode === 'set') {
        await adminStockApi.setQuantity(bookId, { quantity: val })
      } else {
        await adminStockApi.adjust(bookId, { delta: val })
      }
      cancelEdit()
      load()
    } catch (err: any) {
      alert(`Failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Stock Management</h1>
          <p style={{ color: '#718096', fontSize: '0.875rem' }}>Set absolute quantities or adjust by delta.</p>
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
              <th style={th}>Book</th>
              <th style={th}>Total Qty</th>
              <th style={th}>Reserved</th>
              <th style={th}>Available</th>
              <th style={th}>Status</th>
              <th style={{ ...th, width: '220px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: '#a0aec0' }}>Loading...</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: '#a0aec0' }}>No stock entries</td></tr>
            ) : rows.map(({ stock, book }) => (
              <tr key={stock.book_id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                <td style={td}>
                  <div style={{ fontWeight: 500 }}>{book?.title ?? '—'}</div>
                  <div style={{ fontSize: '0.75rem', color: '#a0aec0' }}>{String(stock.book_id).slice(0, 8)}...</div>
                </td>
                <td style={td}>{stock.quantity}</td>
                <td style={td}>{stock.reserved}</td>
                <td style={td}>{stock.available}</td>
                <td style={td}><StockBadge available={stock.available} /></td>
                <td style={td}>
                  {editId === stock.book_id ? (
                    <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
                      <input
                        type="number"
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        placeholder={editMode === 'set' ? 'new qty' : '+/- delta'}
                        style={{ width: '80px', padding: '0.25rem 0.5rem', border: '1px solid #cbd5e0', borderRadius: '4px', fontSize: '0.875rem' }}
                        autoFocus
                      />
                      <button
                        className="btn btn-sm"
                        onClick={() => saveEdit(stock.book_id)}
                        disabled={saving}
                        style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem', background: '#ebf8ff', color: '#2b6cb0', borderColor: '#90cdf4' }}
                      >{saving ? '...' : '✓'}</button>
                      <button
                        className="btn btn-sm"
                        onClick={cancelEdit}
                        style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem' }}
                      >✕</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '0.375rem' }}>
                      <button
                        className="btn btn-sm"
                        onClick={() => startEdit(stock.book_id, 'set')}
                        style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem', background: '#ebf8ff', color: '#2b6cb0', borderColor: '#90cdf4' }}
                        title="Set absolute quantity"
                      >Set Qty</button>
                      <button
                        className="btn btn-sm"
                        onClick={() => startEdit(stock.book_id, 'adjust')}
                        style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem' }}
                        title="Adjust by delta (use negative to reduce)"
                      >± Adjust</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ marginTop: '1rem', fontSize: '0.8rem', color: '#a0aec0' }}>
        <strong>Set Qty</strong> — replaces total quantity and resets reserved to 0.<br />
        <strong>± Adjust</strong> — adds or subtracts from current quantity (use negative to reduce).
      </p>
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
