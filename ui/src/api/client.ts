/**
 * API client — attaches Authorization header from in-memory access token
 * and X-CSRF-Token header on mutating requests (POST/PUT/DELETE/PATCH).
 * Never reads tokens from localStorage.
 */

let _getToken: (() => string | null) | null = null
let _csrfToken: string | null = null

export function setTokenProvider(fn: () => string | null) {
  _getToken = fn
}

export function setCsrfToken(token: string | null) {
  _csrfToken = token
}

/** Fetch a CSRF token from the ecom-service and cache it. */
export async function fetchCsrfToken(): Promise<string | null> {
  const token = _getToken?.()
  if (!token) return null

  try {
    const resp = await fetch('/csrf/token', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (resp.ok) {
      const data = await resp.json()
      _csrfToken = data.token
      return _csrfToken
    }
  } catch (e) {
    console.warn('CSRF token fetch failed:', e)
  }
  return null
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])

async function request<T>(
  url: string,
  options: RequestInit = {},
  _csrfRetried = false,
): Promise<T> {
  const token = _getToken?.()
  const method = (options.method ?? 'GET').toUpperCase()
  const isMutating = MUTATING_METHODS.has(method)

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(isMutating && _csrfToken ? { 'X-CSRF-Token': _csrfToken } : {}),
  }

  const resp = await fetch(url, { ...options, headers })

  // Auto-retry on 403 for mutating requests — CSRF token may have expired
  if (resp.status === 403 && isMutating && !_csrfRetried) {
    await fetchCsrfToken()
    return request<T>(url, options, true)
  }

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
  put: <T>(url: string, body: unknown) =>
    request<T>(url, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(url: string) => request<T>(url, { method: 'DELETE' }),
}
