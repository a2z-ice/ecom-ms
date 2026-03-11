import { Link } from 'react-router-dom'

export default function NotFoundPage() {
  return (
    <div className="page" style={{ textAlign: 'center', paddingTop: '4rem' }}>
      <h1 className="page-title">Page not found</h1>
      <p style={{ color: 'var(--color-muted)', marginBottom: '2rem' }}>
        The page you're looking for doesn't exist or has been moved.
      </p>
      <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
        <Link to="/" className="btn btn-primary">Browse Catalog</Link>
        <Link to="/search" className="btn btn-outline">Search Books</Link>
      </div>
    </div>
  )
}
