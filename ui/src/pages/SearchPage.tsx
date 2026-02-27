import React, { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { booksApi, Book, Page } from '../api/books'
import { cartApi } from '../api/cart'
import { useAuth } from '../auth/AuthContext'
import { addToGuestCart } from '../hooks/useGuestCart'
import { Toast } from '../components/Toast'

export default function SearchPage() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState(searchParams.get('q') ?? '')
  const [result, setResult] = useState<Page<Book> | null>(null)
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    const q = searchParams.get('q')
    if (!q) return
    setLoading(true)
    booksApi.search(q)
      .then(setResult)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [searchParams])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (query.trim()) setSearchParams({ q: query.trim() })
  }

  const handleAdd = async (book: Book) => {
    if (!user) {
      addToGuestCart({ bookId: book.id, title: book.title, price: book.price })
      setToast(`"${book.title}" added to cart`)
      return
    }
    try {
      await cartApi.add(book.id, 1)
      setToast(`"${book.title}" added to cart`)
    } catch {
      setToast('Failed to add to cart')
    }
  }

  return (
    <div className="page">
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
      <h1 className="page-title">Search Books</h1>
      <form onSubmit={handleSearch} className="search-form">
        <input
          className="search-input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by title, author or genre..."
        />
        <button type="submit" className="btn btn-outline">Search</button>
      </form>

      {loading && <div className="loading-state">Searching...</div>}
      {result && (
        <div>
          <p className="result-count">{result.totalElements} result(s)</p>
          <div className="search-results">
            {result.content.map(book => (
              <div key={book.id} className="search-row">
                <div className="search-row-info">
                  <div className="search-row-title">{book.title}</div>
                  <div className="search-row-meta">{book.author}{book.genre ? ` · ${book.genre}` : ''}</div>
                </div>
                <span className="search-row-price">${book.price.toFixed(2)}</span>
                <button className="btn btn-outline" onClick={() => handleAdd(book)}>
                  Add to Cart
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
