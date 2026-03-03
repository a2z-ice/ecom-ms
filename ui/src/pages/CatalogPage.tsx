import React, { useEffect, useState } from 'react'
import { booksApi, Book, Page, StockResponse } from '../api/books'
import { cartApi } from '../api/cart'
import { useAuth } from '../auth/AuthContext'
import { addToGuestCart } from '../hooks/useGuestCart'
import { Toast } from '../components/Toast'
import { StockBadge } from '../components/StockBadge'

const BOOK_ICONS = ['📚', '📖', '📕', '📗', '📘', '📙']
const bookIcon = (title: string) => BOOK_ICONS[title.charCodeAt(0) % BOOK_ICONS.length]

export default function CatalogPage() {
  const { user } = useAuth()
  const [page, setPage] = useState<Page<Book> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [addingId, setAddingId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [stockMap, setStockMap] = useState<Record<string, StockResponse>>({})
  const [stockLoading, setStockLoading] = useState(false)

  useEffect(() => {
    booksApi.list(0, 20)
      .then(p => {
        setPage(p)
        // Fetch stock after books load — progressive enhancement
        if (p.content.length > 0) {
          setStockLoading(true)
          booksApi.getBulkStock(p.content.map(b => b.id))
            .then(stocks => {
              const map: Record<string, StockResponse> = {}
              for (const s of stocks) map[s.book_id] = s
              setStockMap(map)
            })
            .catch(() => { /* graceful degradation: no badges shown */ })
            .finally(() => setStockLoading(false))
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const handleAddToCart = async (book: Book) => {
    const stock = stockMap[book.id]
    if (stock && stock.available === 0) return
    if (!user) {
      addToGuestCart({ bookId: book.id, title: book.title, price: book.price })
      setToast(`"${book.title}" added to cart`)
      return
    }
    setAddingId(book.id)
    try {
      await cartApi.add(book.id, 1)
      window.dispatchEvent(new Event('cartUpdated'))
      setToast(`"${book.title}" added to cart`)
    } catch {
      setToast('Failed to add to cart')
    } finally {
      setAddingId(null)
    }
  }

  if (loading) return <div className="loading-state">Loading catalog...</div>
  if (error)   return <div className="error-state">Error: {error}</div>

  return (
    <div className="page">
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
      <h1 className="page-title">Book Catalog</h1>
      <div className="book-grid">
        {page?.content.map(book => {
          const stock = stockMap[book.id]
          const isOOS = stock !== undefined && stock.available === 0
          const isAdding = addingId === book.id
          return (
            <div key={book.id} className="book-card">
              <div className="book-cover">{bookIcon(book.title)}</div>
              <div className="book-body">
                <div className="book-title">{book.title}</div>
                <div className="book-author">{book.author}</div>
                {book.genre && <span className="book-genre">{book.genre}</span>}
                <div className="book-price">${book.price.toFixed(2)}</div>
                <div style={{ marginBottom: '0.5rem' }}>
                  <StockBadge
                    available={stock !== undefined ? stock.available : Infinity}
                    loading={stockLoading && stock === undefined}
                  />
                </div>
                <button
                  className="btn btn-primary"
                  onClick={() => handleAddToCart(book)}
                  disabled={isAdding || isOOS}
                >
                  {isAdding ? 'Adding...' : isOOS ? 'Out of Stock' : 'Add to Cart'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
