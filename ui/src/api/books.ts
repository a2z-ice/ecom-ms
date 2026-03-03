import { api } from './client'

export interface Book {
  id: string
  title: string
  author: string
  price: number
  description: string
  coverUrl: string | null
  genre: string | null
  isbn: string | null
  publishedYear: number | null
}

export interface Page<T> {
  content: T[]
  totalElements: number
  totalPages: number
  number: number
  size: number
}

export interface StockResponse {
  book_id: string
  quantity: number
  reserved: number
  available: number
  updated_at: string
}

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock'

export function getStockStatus(available: number): StockStatus {
  if (available <= 0) return 'out_of_stock'
  if (available <= 3) return 'low_stock'
  return 'in_stock'
}

export const booksApi = {
  list: (page = 0, size = 20) =>
    api.get<Page<Book>>(`/ecom/books?page=${page}&size=${size}&sort=title`),

  search: (q: string, page = 0) =>
    api.get<Page<Book>>(`/ecom/books/search?q=${encodeURIComponent(q)}&page=${page}`),

  getStock: (bookId: string) =>
    api.get<StockResponse>(`/inven/stock/${bookId}`),

  getBulkStock: (bookIds: string[]) =>
    api.get<StockResponse[]>(`/inven/stock/bulk?book_ids=${bookIds.join(',')}`),
}
