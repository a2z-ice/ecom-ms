import { api } from './client'
import { Book, Page, StockResponse } from './books'

// ---- Book admin ----

export interface BookRequest {
  title: string
  author: string
  price: number
  description?: string
  coverUrl?: string
  isbn?: string
  genre?: string
  publishedYear?: number
}

// ---- Order admin ----

export interface AdminOrderItem {
  bookId: string
  title: string
  quantity: number
  priceAtPurchase: number
}

export interface AdminOrder {
  id: string
  userId: string
  total: number
  status: string
  createdAt: string
  items: AdminOrderItem[]
}

// ---- Stock admin ----

export interface StockSetRequest {
  quantity: number
}

export interface StockAdjustRequest {
  delta: number
}

export interface StockAdminResponse extends StockResponse {}

// ---- API client ----

export const adminBooksApi = {
  list: (page = 0, size = 20) =>
    api.get<Page<Book>>(`/ecom/admin/books?page=${page}&size=${size}&sort=title`),

  get: (id: string) =>
    api.get<Book>(`/ecom/admin/books/${id}`),

  create: (req: BookRequest) =>
    api.post<Book>('/ecom/admin/books', req),

  update: (id: string, req: BookRequest) =>
    api.put<Book>(`/ecom/admin/books/${id}`, req),

  delete: (id: string) =>
    api.delete<void>(`/ecom/admin/books/${id}`),
}

export const adminOrdersApi = {
  list: (page = 0, size = 20) =>
    api.get<Page<AdminOrder>>(`/ecom/admin/orders?page=${page}&size=${size}`),

  get: (id: string) =>
    api.get<AdminOrder>(`/ecom/admin/orders/${id}`),
}

export const adminStockApi = {
  list: (page = 0, size = 50) =>
    api.get<StockResponse[]>(`/inven/admin/stock?page=${page}&size=${size}`),

  setQuantity: (bookId: string, req: StockSetRequest) =>
    api.put<StockAdminResponse>(`/inven/admin/stock/${bookId}`, req),

  adjust: (bookId: string, req: StockAdjustRequest) =>
    api.post<StockAdminResponse>(`/inven/admin/stock/${bookId}/adjust`, req),
}
