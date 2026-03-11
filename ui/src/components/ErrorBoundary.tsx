import React from 'react'

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, info.componentStack)
  }

  handleReload = () => {
    window.location.reload()
  }

  handleGoHome = () => {
    window.location.href = '/'
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="page" style={{ textAlign: 'center', paddingTop: '4rem' }}>
          <h1 className="page-title">Something went wrong</h1>
          <p style={{ color: 'var(--color-muted)', marginBottom: '2rem' }}>
            We're sorry — an unexpected error occurred.
          </p>
          <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
            <button className="btn btn-primary" onClick={this.handleReload}>
              Reload Page
            </button>
            <button className="btn btn-outline" onClick={this.handleGoHome}>
              Go to Home
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
