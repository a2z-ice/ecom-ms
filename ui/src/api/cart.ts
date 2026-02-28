import { api } from './client'

export interface CartItem {
  id: string
  book: { id: string; title: string; price: number }
  quantity: number
}

export const cartApi = {
  get: () => api.get<CartItem[]>('/ecom/cart'),
  add: (bookId: string, quantity: number) =>
    api.post<CartItem>('/ecom/cart', { bookId, quantity }),
  update: (cartItemId: string, quantity: number) =>
    api.put<CartItem>(`/ecom/cart/${cartItemId}`, { quantity }),
  remove: (cartItemId: string) => api.delete<void>(`/ecom/cart/${cartItemId}`),
  checkout: () => api.post<{ id: string; total: number; status: string }>('/ecom/checkout', {}),
}
