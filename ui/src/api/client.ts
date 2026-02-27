/**
 * API client — attaches Authorization header from in-memory access token.
 * Never reads tokens from localStorage.
 */

let _getToken: (() => string | null) | null = null

export function setTokenProvider(fn: () => string | null) {
  _getToken = fn
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = _getToken?.()
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }

  const resp = await fetch(url, { ...options, headers })

  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText)
    throw new Error(`HTTP ${resp.status}: ${text}`)
  }

  if (resp.status === 204) return undefined as T
  return resp.json()
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body: unknown) =>
    request<T>(url, { method: 'POST', body: JSON.stringify(body) }),
  delete: <T>(url: string) => request<T>(url, { method: 'DELETE' }),
}
