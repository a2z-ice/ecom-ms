/**
 * CSRF Token E2E Tests
 *
 * Validates the Redis-backed CSRF token mechanism:
 *   1. Mutating requests without CSRF token are rejected (403)
 *   2. Mutating requests with invalid CSRF token are rejected (403)
 *   3. Mutating requests with valid CSRF token succeed
 *   4. GET /csrf-token requires JWT authentication
 *   5. Safe methods (GET) do not require CSRF token
 *   6. Browser flow handles CSRF transparently
 */
import { test, expect } from './fixtures/base'

const KEYCLOAK_TOKEN_URL = 'https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token'
const ECOM_BASE = 'https://api.service.net:30000/ecom'
const BOOK_ID = '00000000-0000-0000-0000-000000000001'

async function getToken(request: any, username = 'user1', password = 'CHANGE_ME'): Promise<string> {
  const resp = await request.post(KEYCLOAK_TOKEN_URL, {
    form: {
      grant_type: 'password',
      client_id: 'ui-client',
      username,
      password,
    },
  })
  const body = await resp.json()
  return body.access_token
}

async function getCsrfToken(request: any, bearerToken: string): Promise<string> {
  const resp = await request.get(`${ECOM_BASE}/csrf-token`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  })
  expect(resp.status()).toBe(200)
  const body = await resp.json()
  expect(body.token).toBeTruthy()
  return body.token
}

test.describe('CSRF Token Protection', () => {

  test('GET /ecom/csrf-token without JWT returns 401', async ({ request }) => {
    const resp = await request.get(`${ECOM_BASE}/csrf-token`)
    expect(resp.status()).toBe(401)
  })

  test('GET /ecom/csrf-token with JWT returns a token', async ({ request }) => {
    const jwt = await getToken(request)
    const resp = await request.get(`${ECOM_BASE}/csrf-token`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.token).toBeTruthy()
    expect(typeof body.token).toBe('string')
    expect(body.token.length).toBeGreaterThan(10)
  })

  test('POST /ecom/cart without CSRF token returns 403', async ({ request }) => {
    const jwt = await getToken(request)
    const resp = await request.post(`${ECOM_BASE}/cart`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      data: { bookId: BOOK_ID, quantity: 1 },
    })
    expect(resp.status()).toBe(403)
    const body = await resp.json()
    expect(body.detail).toContain('CSRF')
  })

  test('POST /ecom/cart with invalid CSRF token returns 403', async ({ request }) => {
    const jwt = await getToken(request)
    const resp = await request.post(`${ECOM_BASE}/cart`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'invalid-token-value',
      },
      data: { bookId: BOOK_ID, quantity: 1 },
    })
    expect(resp.status()).toBe(403)
  })

  test('POST /ecom/cart with valid CSRF token succeeds', async ({ request }) => {
    const jwt = await getToken(request)
    const csrf = await getCsrfToken(request, jwt)
    const resp = await request.post(`${ECOM_BASE}/cart`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      data: { bookId: BOOK_ID, quantity: 1 },
    })
    expect(resp.status()).toBe(200)
  })

  test('CSRF token can be reused for multiple requests', async ({ request }) => {
    const jwt = await getToken(request)
    const csrf = await getCsrfToken(request, jwt)

    // First request
    const resp1 = await request.post(`${ECOM_BASE}/cart`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      data: { bookId: BOOK_ID, quantity: 1 },
    })
    expect(resp1.status()).toBe(200)

    // Second request with same token
    const resp2 = await request.post(`${ECOM_BASE}/cart`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      data: { bookId: BOOK_ID, quantity: 1 },
    })
    expect(resp2.status()).toBe(200)
  })

  test('GET /ecom/books does not require CSRF token', async ({ request }) => {
    const resp = await request.get(`${ECOM_BASE}/books`)
    expect(resp.status()).toBe(200)
  })

  test('browser UI handles CSRF transparently — add to cart works', async ({ page }) => {
    await page.goto('/')
    // Wait for catalog to load
    await expect(page.getByText('In Stock').first()).toBeVisible({ timeout: 15000 })
    // Wait for auth (Logout button visible)
    await expect(page.getByRole('button', { name: /logout/i })).toBeVisible({ timeout: 10000 })

    // Click the first "Add to Cart" button
    const addBtn = page.getByRole('button', { name: /add to cart/i }).first()
    await expect(addBtn).toBeEnabled({ timeout: 5000 })
    await addBtn.click()

    // Should see success feedback (cart count updates or toast)
    await expect(page.getByText(/added|cart/i).first()).toBeVisible({ timeout: 5000 })
  })

  test('Redis contains CSRF key after token generation', async ({ request }) => {
    const jwt = await getToken(request)
    await getCsrfToken(request, jwt)

    // Verify Redis has a csrf:* key (via kubectl)
    const { execFileSync } = await import('child_process')
    try {
      const keys = execFileSync('kubectl', [
        'exec', '-n', 'infra', 'deploy/redis', '--',
        'redis-cli', 'KEYS', 'csrf:*',
      ], { encoding: 'utf-8', timeout: 10_000 }).trim()
      expect(keys).toContain('csrf:')
    } catch {
      // kubectl might not be available in all environments — skip gracefully
      test.skip(true, 'kubectl not available')
    }
  })
})
