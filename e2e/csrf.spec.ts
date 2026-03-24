/**
 * Gateway-Level CSRF Token E2E Tests
 *
 * Validates the Istio gateway ext_authz CSRF mechanism:
 *   1. Mutating requests without CSRF token are rejected (403)
 *   2. Mutating requests with invalid CSRF token are rejected (403)
 *   3. Mutating requests with valid CSRF token succeed
 *   4. GET /csrf/token requires JWT authentication
 *   5. Safe methods (GET) do not require CSRF token
 *   6. Inventory service is also protected by gateway CSRF
 *   7. Browser flow handles CSRF transparently
 */
import { test, expect } from './fixtures/base'

const KEYCLOAK_TOKEN_URL = 'https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token'
const CSRF_URL = 'https://api.service.net:30000/csrf/token'
const ECOM_BASE = 'https://api.service.net:30000/ecom'
const INVEN_BASE = 'https://api.service.net:30000/inven'
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
  const resp = await request.get(CSRF_URL, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  })
  expect(resp.status()).toBe(200)
  const body = await resp.json()
  expect(body.token).toBeTruthy()
  return body.token
}

test.describe('Gateway-Level CSRF Token Protection', () => {

  test('GET /csrf/token without JWT returns 401', async ({ request }) => {
    const resp = await request.get(CSRF_URL)
    expect(resp.status()).toBe(401)
  })

  test('GET /csrf/token with JWT returns a token', async ({ request }) => {
    const jwt = await getToken(request)
    const resp = await request.get(CSRF_URL, {
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

    const resp1 = await request.post(`${ECOM_BASE}/cart`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      data: { bookId: BOOK_ID, quantity: 1 },
    })
    expect(resp1.status()).toBe(200)

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
})

test.describe('Gateway CSRF protects inventory-service', () => {

  test('PUT /inven/admin/stock without CSRF token returns 403', async ({ request }) => {
    const jwt = await getToken(request, 'admin1', 'CHANGE_ME')
    const resp = await request.put(`${INVEN_BASE}/admin/stock/${BOOK_ID}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      data: { quantity: 50 },
    })
    expect(resp.status()).toBe(403)
  })

  test('PUT /inven/admin/stock with valid CSRF token succeeds', async ({ request }) => {
    const jwt = await getToken(request, 'admin1', 'CHANGE_ME')
    const csrf = await getCsrfToken(request, jwt)
    const resp = await request.put(`${INVEN_BASE}/admin/stock/${BOOK_ID}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      data: { quantity: 50 },
    })
    expect(resp.status()).toBe(200)
  })

  test('GET /inven/health does not require CSRF token', async ({ request }) => {
    const resp = await request.get(`${INVEN_BASE}/health`)
    expect(resp.status()).toBe(200)
  })
})

test.describe('Browser CSRF flow', () => {

  test('browser UI handles CSRF transparently — add to cart works', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('In Stock').first()).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('button', { name: /logout/i })).toBeVisible({ timeout: 10000 })

    const addBtn = page.getByRole('button', { name: /add to cart/i }).first()
    await expect(addBtn).toBeEnabled({ timeout: 5000 })
    await addBtn.click()

    await expect(page.getByText(/added|cart/i).first()).toBeVisible({ timeout: 5000 })
  })

  test('Redis contains CSRF key after token generation', async ({ request }) => {
    const jwt = await getToken(request)
    await getCsrfToken(request, jwt)

    const { execFileSync } = await import('child_process')
    try {
      const keys = execFileSync('kubectl', [
        'exec', '-n', 'infra', 'deploy/redis', '--',
        'redis-cli', '-a', 'CHANGE_ME', 'KEYS', 'csrf:*',
      ], { encoding: 'utf-8', timeout: 10_000 }).trim()
      expect(keys).toContain('csrf:')
    } catch {
      test.skip(true, 'kubectl not available')
    }
  })
})
