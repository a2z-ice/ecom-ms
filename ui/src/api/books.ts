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

export const booksApi = {
  list: (page = 0, size = 20) =>
    api.get<Page<Book>>(`/ecom/books?page=${page}&size=${size}&sort=title`),

  search: (q: string, page = 0) =>
    api.get<Page<Book>>(`/ecom/books/search?q=${encodeURIComponent(q)}&page=${page}`),

  getStock: (bookId: string) =>
    api.get<{ available: number }>(`/inven/stock/${bookId}`),
}
