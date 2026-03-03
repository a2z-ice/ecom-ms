import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { adminBooksApi, BookRequest } from '../../api/admin'
import { Book } from '../../api/books'

export default function AdminEditBookPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const isCreate = !id || id === 'new'

  const [form, setForm] = useState<BookRequest>({
    title: '', author: '', price: 0,
    description: '', coverUrl: '', isbn: '', genre: '', publishedYear: undefined,
  })
  const [loading, setLoading] = useState(!isCreate)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isCreate) return
    adminBooksApi.get(id!)
      .then((book: Book) => setForm({
        title: book.title,
        author: book.author,
        price: Number(book.price),
        description: book.description ?? '',
        coverUrl: book.coverUrl ?? '',
        isbn: book.isbn ?? '',
        genre: book.genre ?? '',
        publishedYear: book.publishedYear ?? undefined,
      }))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [id, isCreate])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const payload: BookRequest = {
      ...form,
      price: Number(form.price),
      publishedYear: form.publishedYear ? Number(form.publishedYear) : undefined,
      description: form.description || undefined,
      coverUrl: form.coverUrl || undefined,
      isbn: form.isbn || undefined,
      genre: form.genre || undefined,
    }
    try {
      if (isCreate) {
        await adminBooksApi.create(payload)
      } else {
        await adminBooksApi.update(id!, payload)
      }
      navigate('/admin/books')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const set = (field: keyof BookRequest) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [field]: e.target.value }))

  if (loading) {
    return <div style={{ padding: '2rem', color: '#718096' }}>Loading book...</div>
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.25rem' }}>
        {isCreate ? 'Add New Book' : 'Edit Book'}
      </h1>
      <p style={{ color: '#718096', marginBottom: '1.5rem', fontSize: '0.875rem' }}>
        {isCreate ? 'Fill in the details to add a new book to the catalog.' : 'Update book details.'}
      </p>

      {error && (
        <div style={{ background: '#fff5f5', border: '1px solid #fc8181', borderRadius: '6px', padding: '0.75rem 1rem', marginBottom: '1rem', color: '#c53030', fontSize: '0.875rem' }}>
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <FormField label="Title *">
          <input className="input" value={form.title} onChange={set('title')} required placeholder="The Fellowship of the Ring" />
        </FormField>

        <FormField label="Author *">
          <input className="input" value={form.author} onChange={set('author')} required placeholder="J.R.R. Tolkien" />
        </FormField>

        <FormField label="Price (USD) *">
          <input className="input" type="number" step="0.01" min="0.01" value={form.price || ''} onChange={set('price')} required placeholder="14.99" />
        </FormField>

        <FormField label="Genre">
          <input className="input" value={form.genre ?? ''} onChange={set('genre')} placeholder="Fantasy" />
        </FormField>

        <FormField label="ISBN">
          <input className="input" value={form.isbn ?? ''} onChange={set('isbn')} placeholder="978-0-618-57494-1" />
        </FormField>

        <FormField label="Published Year">
          <input className="input" type="number" min="1000" max="2100" value={form.publishedYear ?? ''} onChange={set('publishedYear')} placeholder="1954" />
        </FormField>

        <FormField label="Cover URL">
          <input className="input" value={form.coverUrl ?? ''} onChange={set('coverUrl')} placeholder="https://..." />
        </FormField>

        <FormField label="Description">
          <textarea
            className="input"
            value={form.description ?? ''}
            onChange={set('description')}
            rows={4}
            placeholder="A short synopsis..."
            style={{ resize: 'vertical' }}
          />
        </FormField>

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving...' : isCreate ? 'Create Book' : 'Save Changes'}
          </button>
          <button type="button" className="btn btn-outline" onClick={() => navigate('/admin/books')}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.375rem', color: '#4a5568' }}>
        {label}
      </label>
      {children}
    </div>
  )
}
