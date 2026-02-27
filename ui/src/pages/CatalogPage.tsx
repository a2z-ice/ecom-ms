import React, { useEffect, useState } from 'react'
import { booksApi, Book, Page } from '../api/books'
import { cartApi } from '../api/cart'
import { useAuth } from '../auth/AuthContext'
import { addToGuestCart } from '../hooks/useGuestCart'
import { Toast } from '../components/Toast'

const BOOK_ICONS = ['📚', '📖', '📕', '📗', '📘', '📙']
const bookIcon = (title: string) => BOOK_ICONS[title.charCodeAt(0) % BOOK_ICONS.length]

export default function CatalogPage() {
  const { user } = useAuth()
  const [page, setPage] = useState<Page<Book> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [addingId, setAddingId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    booksApi.list(0, 20)
      .then(setPage)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const handleAddToCart = async (book: Book) => {
    if (!user) {
      addToGuestCart({ bookId: book.id, title: book.title, price: book.price })
      setToast(`"${book.title}" added to cart`)
      return
    }
    setAddingId(book.id)
    try {
      await cartApi.add(book.id, 1)
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
        {page?.content.map(book => (
          <div key={book.id} className="book-card">
            <div className="book-cover">{bookIcon(book.title)}</div>
            <div className="book-body">
              <div className="book-title">{book.title}</div>
              <div className="book-author">{book.author}</div>
              {book.genre && <span className="book-genre">{book.genre}</span>}
              <div className="book-price">${book.price.toFixed(2)}</div>
              <button
                className="btn btn-primary"
                onClick={() => handleAddToCart(book)}
                disabled={addingId === book.id}
              >
                {addingId === book.id ? 'Adding...' : 'Add to Cart'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
