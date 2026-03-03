import React from 'react'
import { getStockStatus } from '../api/books'

interface StockBadgeProps {
  available: number
  loading?: boolean
}

export function StockBadge({ available, loading }: StockBadgeProps) {
  if (loading) {
    return (
      <span style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '9999px',
        fontSize: '0.72rem',
        fontWeight: 500,
        background: '#e2e8f0',
        color: '#a0aec0',
        letterSpacing: '0.02em',
      }}>
        ···
      </span>
    )
  }

  const status = getStockStatus(available)

  if (status === 'out_of_stock') {
    return (
      <span style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '9999px',
        fontSize: '0.72rem',
        fontWeight: 600,
        background: '#fed7d7',
        color: '#c53030',
        letterSpacing: '0.02em',
      }}>
        Out of Stock
      </span>
    )
  }

  if (status === 'low_stock') {
    return (
      <span style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '9999px',
        fontSize: '0.72rem',
        fontWeight: 600,
        background: '#feebc8',
        color: '#c05621',
        letterSpacing: '0.02em',
      }}>
        Only {available} left
      </span>
    )
  }

  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '9999px',
      fontSize: '0.72rem',
      fontWeight: 600,
      background: '#c6f6d5',
      color: '#276749',
      letterSpacing: '0.02em',
    }}>
      In Stock
    </span>
  )
}
