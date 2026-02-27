const GUEST_CART_KEY = 'bookstore_guest_cart'

export interface GuestCartItem {
  bookId: string
  title: string
  price: number
  quantity: number
}

export function getGuestCart(): GuestCartItem[] {
  try {
    return JSON.parse(localStorage.getItem(GUEST_CART_KEY) ?? '[]')
  } catch {
    return []
  }
}

export function addToGuestCart(item: Omit<GuestCartItem, 'quantity'>): GuestCartItem[] {
  const cart = getGuestCart()
  const existing = cart.find(i => i.bookId === item.bookId)
  if (existing) {
    existing.quantity++
  } else {
    cart.push({ ...item, quantity: 1 })
  }
  localStorage.setItem(GUEST_CART_KEY, JSON.stringify(cart))
  return cart
}

export function updateGuestCartQty(bookId: string, delta: number): GuestCartItem[] {
  const cart = getGuestCart()
    .map(i => i.bookId === bookId ? { ...i, quantity: i.quantity + delta } : i)
    .filter(i => i.quantity > 0)
  localStorage.setItem(GUEST_CART_KEY, JSON.stringify(cart))
  return cart
}

export function clearGuestCart(): void {
  localStorage.removeItem(GUEST_CART_KEY)
}

export function guestCartCount(): number {
  return getGuestCart().reduce((n, i) => n + i.quantity, 0)
}
