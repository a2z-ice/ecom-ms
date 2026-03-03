import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { adminBooksApi } from '../../api/admin'
import { Book } from '../../api/books'

export default function AdminBooksPage() {
  const navigate = useNavigate()
  const [books, setBooks] = useState<Book[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const PAGE_SIZE = 20

  const load = (p: number) => {
    setLoading(true)
    setError(null)
    adminBooksApi.list(p, PAGE_SIZE)
      .then(data => {
        setBooks(data.content)
        setTotal(data.totalElements)
        setPage(p)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load(0) }, [])

  const handleDelete = async (book: Book) => {
    if (!confirm(`Delete "${book.title}"? This cannot be undone.`)) return
    setDeleting(book.id)
    try {
      await adminBooksApi.delete(book.id)
      load(page)
    } catch (err: any) {
      alert(`Failed to delete: ${err.message}`)
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '1100px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Manage Books</h1>
          <p style={{ color: '#718096', fontSize: '0.875rem' }}>{total} books total</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <Link to="/admin" style={{ textDecoration: 'none' }}>
            <button className="btn btn-outline">← Dashboard</button>
          </Link>
          <button className="btn btn-primary" onClick={() => navigate('/admin/books/new')}>
            + Add Book
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: '#fff5f5', border: '1px solid #fc8181', borderRadius: '6px', padding: '1rem', marginBottom: '1rem', color: '#c53030' }}>
          {error}
        </div>
      )}

      {/* Table */}
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f7fafc', borderBottom: '1px solid #e2e8f0' }}>
              <th style={th}>Title</th>
              <th style={th}>Author</th>
              <th style={th}>Genre</th>
              <th style={th}>Price</th>
              <th style={th}>ISBN</th>
              <th style={{ ...th, width: '130px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: '#a0aec0' }}>Loading...</td></tr>
            ) : books.length === 0 ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: '#a0aec0' }}>No books found</td></tr>
            ) : books.map(book => (
              <tr key={book.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                <td style={td}>{book.title}</td>
                <td style={td}>{book.author}</td>
                <td style={td}>{book.genre ?? '—'}</td>
                <td style={td}>${Number(book.price).toFixed(2)}</td>
                <td style={{ ...td, fontSize: '0.75rem', color: '#718096' }}>{book.isbn ?? '—'}</td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => navigate(`/admin/books/${book.id}`)}
                      style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem' }}
                    >Edit</button>
                    <button
                      className="btn btn-sm"
                      onClick={() => handleDelete(book)}
                      disabled={deleting === book.id}
                      style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem', background: '#fff5f5', color: '#c53030', borderColor: '#fc8181' }}
                    >{deleting === book.id ? '...' : 'Delete'}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
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
