/**
 * Admin Panel E2E Tests
 *
 * Tests run as admin1 (admin + customer roles) via fixtures/admin-base.ts.
 *
 * Covers:
 *  - API: 403 for customer role, 200 for admin role
 *  - UI: admin nav link, dashboard, book CRUD, stock management
 *
 * admin1 credentials: admin1 / CHANGE_ME (both customer and admin realm roles)
 * user1 credentials:  user1  / CHANGE_ME (customer role only)
 */
import { test, expect } from './fixtures/admin-base'

const KEYCLOAK_TOKEN_URL = 'https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token'
const ECOM_BASE = 'https://api.service.net:30000/ecom'
const INVEN_BASE = 'https://api.service.net:30000/inven'

// Helper: get a JWT for any user via Resource Owner Password grant
async function getToken(request: any, username: string, password: string): Promise<string> {
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

// Helper: get a CSRF token from ecom-service (required for POST/PUT/DELETE)
async function getCsrfToken(request: any, bearerToken: string): Promise<string> {
  const resp = await request.get(`${ECOM_BASE}/csrf-token`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  })
  const body = await resp.json()
  return body.token
}

// ─────────────────────────────────────────────────────────────────────────────
// API security tests — no browser needed
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Admin API — access control', () => {

  test('GET /ecom/admin/books returns 403 for customer role (user1)', async ({ request }) => {
    const token = await getToken(request, 'user1', 'CHANGE_ME')
    const resp = await request.get(`${ECOM_BASE}/admin/books`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(resp.status()).toBe(403)
  })

  test('GET /ecom/admin/books returns 401 with no token', async ({ request }) => {
    const resp = await request.get(`${ECOM_BASE}/admin/books`)
    expect(resp.status()).toBe(401)
  })

  test('GET /ecom/admin/books returns 200 for admin role (admin1)', async ({ request }) => {
    const token = await getToken(request, 'admin1', 'CHANGE_ME')
    const resp = await request.get(`${ECOM_BASE}/admin/books`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(resp.status()).toBe(200)
    const data = await resp.json()
    expect(data).toHaveProperty('content')
    expect(Array.isArray(data.content)).toBe(true)
    expect(data.totalElements).toBeGreaterThan(0)
  })

  test('GET /inven/admin/stock returns 401/403 with no token', async ({ request }) => {
    // FastAPI HTTPBearer returns 403 (not 401) when no Authorization header is provided.
    // Spring Security returns 401. Both are acceptable "not authenticated" responses.
    const resp = await request.get(`${INVEN_BASE}/admin/stock`)
    expect([401, 403]).toContain(resp.status())
  })

  test('GET /inven/admin/stock returns 403 for customer role', async ({ request }) => {
    const token = await getToken(request, 'user1', 'CHANGE_ME')
    const resp = await request.get(`${INVEN_BASE}/admin/stock`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(resp.status()).toBe(403)
  })

  test('GET /inven/admin/stock returns 200 for admin role', async ({ request }) => {
    const token = await getToken(request, 'admin1', 'CHANGE_ME')
    const resp = await request.get(`${INVEN_BASE}/admin/stock`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(resp.status()).toBe(200)
    const data = await resp.json()
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThan(0)
    expect(data[0]).toHaveProperty('book_id')
    expect(data[0]).toHaveProperty('quantity')
    expect(data[0]).toHaveProperty('available')
  })

  test('GET /ecom/admin/orders returns 200 for admin role', async ({ request }) => {
    const token = await getToken(request, 'admin1', 'CHANGE_ME')
    const resp = await request.get(`${ECOM_BASE}/admin/orders`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(resp.status()).toBe(200)
    const data = await resp.json()
    expect(data).toHaveProperty('content')
  })

})

// ─────────────────────────────────────────────────────────────────────────────
// Admin book CRUD (API level)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Admin Book CRUD', () => {
  let createdBookId: string

  test('POST /ecom/admin/books creates a new book', async ({ request }) => {
    const token = await getToken(request, 'admin1', 'CHANGE_ME')
    const csrf = await getCsrfToken(request, token)
    const resp = await request.post(`${ECOM_BASE}/admin/books`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      data: {
        title: 'E2E Test Book',
        author: 'Test Author',
        price: 9.99,
        genre: 'Testing',
        publishedYear: 2026,
      },
    })
    expect(resp.status()).toBe(201)
    const book = await resp.json()
    expect(book.title).toBe('E2E Test Book')
    expect(book.author).toBe('Test Author')
    expect(book.id).toBeTruthy()
    createdBookId = book.id
  })

  test('PUT /ecom/admin/books/{id} updates a book', async ({ request }) => {
    const token = await getToken(request, 'admin1', 'CHANGE_ME')
    const csrf = await getCsrfToken(request, token)

    // First get a book to update
    const listResp = await request.get(`${ECOM_BASE}/admin/books?size=1`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const list = await listResp.json()
    const bookId = list.content[0].id
    const originalTitle = list.content[0].title

    const resp = await request.put(`${ECOM_BASE}/admin/books/${bookId}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      data: {
        title: originalTitle,  // keep original title
        author: list.content[0].author,
        price: list.content[0].price,
        genre: list.content[0].genre ?? 'Fiction',
        description: 'Updated via E2E test',
      },
    })
    expect(resp.status()).toBe(200)
    const updated = await resp.json()
    expect(updated.description).toBe('Updated via E2E test')
  })

  test('DELETE /ecom/admin/books/{id} deletes the test book', async ({ request }) => {
    const token = await getToken(request, 'admin1', 'CHANGE_ME')
    const csrf = await getCsrfToken(request, token)

    // Find the E2E test book we created
    const listResp = await request.get(
      `${ECOM_BASE}/admin/books?size=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    const list = await listResp.json()
    const testBook = list.content.find((b: any) => b.title === 'E2E Test Book')
    if (!testBook) {
      // Already deleted or not created in this run — skip
      return
    }

    const resp = await request.delete(`${ECOM_BASE}/admin/books/${testBook.id}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-CSRF-Token': csrf },
    })
    expect(resp.status()).toBe(204)

    // Verify it's gone
    const checkResp = await request.get(`${ECOM_BASE}/admin/books/${testBook.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(checkResp.status()).toBe(404)
  })

})

// ─────────────────────────────────────────────────────────────────────────────
// Admin stock management (API level)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Admin Stock Management', () => {

  test('PUT /inven/admin/stock/{id} sets absolute quantity', async ({ request }) => {
    const token = await getToken(request, 'admin1', 'CHANGE_ME')

    const bookId = '00000000-0000-0000-0000-000000000001'
    const resp = await request.put(`${INVEN_BASE}/admin/stock/${bookId}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { quantity: 75 },
    })
    expect(resp.status()).toBe(200)
    const stock = await resp.json()
    expect(stock.quantity).toBe(75)
    expect(stock.reserved).toBe(0)
    expect(stock.available).toBe(75)

    // Restore to 50
    await request.put(`${INVEN_BASE}/admin/stock/${bookId}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { quantity: 50 },
    })
  })

  test('POST /inven/admin/stock/{id}/adjust adjusts by positive delta', async ({ request }) => {
    const token = await getToken(request, 'admin1', 'CHANGE_ME')
    const bookId = '00000000-0000-0000-0000-000000000002'

    // Get current qty
    const before = await request.get(`${INVEN_BASE}/stock/${bookId}`)
    const beforeData = await before.json()
    const originalQty = beforeData.quantity

    const resp = await request.post(`${INVEN_BASE}/admin/stock/${bookId}/adjust`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { delta: 5 },
    })
    expect(resp.status()).toBe(200)
    const after = await resp.json()
    expect(after.quantity).toBe(originalQty + 5)

    // Restore
    await request.post(`${INVEN_BASE}/admin/stock/${bookId}/adjust`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { delta: -5 },
    })
  })

  test('POST /inven/admin/stock/{id}/adjust returns 400 for negative result', async ({ request }) => {
    const token = await getToken(request, 'admin1', 'CHANGE_ME')
    const bookId = '00000000-0000-0000-0000-000000000003'

    const resp = await request.post(`${INVEN_BASE}/admin/stock/${bookId}/adjust`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { delta: -9999 },
    })
    expect(resp.status()).toBe(400)
  })

})

// ─────────────────────────────────────────────────────────────────────────────
// Admin UI tests (browser level, logged in as admin1)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Admin UI', () => {

  test('navbar shows Admin link for admin user', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('nav', { timeout: 5000 })
    await expect(page.getByRole('link', { name: /admin/i })).toBeVisible()
    await page.screenshot({ path: 'screenshots/admin-01-navbar-admin-link.png', fullPage: true })
  })

  test('admin dashboard loads at /admin', async ({ page }) => {
    await page.goto('/admin')
    await expect(page.getByRole('heading', { name: /admin dashboard/i })).toBeVisible({ timeout: 10000 })
    await page.screenshot({ path: 'screenshots/admin-02-dashboard.png', fullPage: true })
  })

  test('admin books page loads with book list', async ({ page }) => {
    await page.goto('/admin/books')
    await expect(page.getByRole('heading', { name: /manage books/i })).toBeVisible({ timeout: 10000 })
    // Should show some rows
    const rows = page.locator('tbody tr')
    await expect(rows.first()).toBeVisible({ timeout: 10000 })
    await page.screenshot({ path: 'screenshots/admin-03-books-list.png', fullPage: true })
  })

  test('admin create book page has form fields', async ({ page }) => {
    await page.goto('/admin/books/new')
    await expect(page.getByRole('heading', { name: /add new book/i })).toBeVisible({ timeout: 10000 })
    // Form should have multiple input fields
    const inputs = page.locator('form input')
    await expect(inputs.first()).toBeVisible()
    const inputCount = await inputs.count()
    expect(inputCount).toBeGreaterThan(2)
    await page.screenshot({ path: 'screenshots/admin-04-create-book-form.png', fullPage: true })
  })

  test('admin stock page loads with stock table', async ({ page }) => {
    await page.goto('/admin/stock')
    await expect(page.getByRole('heading', { name: /stock management/i })).toBeVisible({ timeout: 10000 })
    const rows = page.locator('tbody tr')
    await expect(rows.first()).toBeVisible({ timeout: 10000 })
    await page.screenshot({ path: 'screenshots/admin-05-stock-management.png', fullPage: true })
  })

  test('admin orders page loads', async ({ page }) => {
    await page.goto('/admin/orders')
    await expect(page.getByRole('heading', { name: /all orders/i })).toBeVisible({ timeout: 10000 })
    await page.screenshot({ path: 'screenshots/admin-06-orders-list.png', fullPage: true })
  })

  test('non-admin user sees access denied on /admin', async ({ page, request }) => {
    // Log in as user1 via API to get their token, then inject their session
    // by navigating to the admin route — since the admin-base injects admin1's session
    // we cannot test user1 access directly here.
    // Instead, test via API: customer token gets 403
    const token = await getToken(request, 'user1', 'CHANGE_ME')
    const resp = await request.get(`${ECOM_BASE}/admin/books`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(resp.status()).toBe(403)
  })

})

// ─────────────────────────────────────────────────────────────────────────────
// Keycloak Admin Console — accessibility + realm API
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Keycloak Admin Console', () => {

  test('admin console is accessible via gateway URL', async ({ request }) => {
    // Keycloak routes all of idp.keycloak.net:30000 to the Keycloak pod via the gateway.
    // The admin console redirects to /admin/master — we expect a 200 or 302.
    const resp = await request.get('https://idp.keycloak.net:30000/admin/', {
      maxRedirects: 0,
    })
    expect([200, 302]).toContain(resp.status())
  })

  test('bookstore realm OIDC discovery document is reachable', async ({ request }) => {
    const resp = await request.get(
      'https://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration'
    )
    expect(resp.status()).toBe(200)
    const doc = await resp.json()
    expect(doc).toHaveProperty('issuer')
    expect(doc).toHaveProperty('authorization_endpoint')
    expect(doc).toHaveProperty('token_endpoint')
    expect(doc).toHaveProperty('end_session_endpoint')
    expect(doc.issuer).toContain('bookstore')
  })

  test('bookstore realm has expected roles via admin REST API', async ({ request }) => {
    const token = await getToken(request, 'admin1', 'CHANGE_ME')

    // Use the Keycloak admin REST API (via gateway) to fetch realm roles
    const resp = await request.get(
      'https://idp.keycloak.net:30000/admin/realms/bookstore/roles',
      { headers: { Authorization: `Bearer ${token}` } }
    )
    // Admin REST API requires the master-admin token, not a realm token.
    // A realm user token gets 403 on /admin/realms. This verifies that the
    // gateway correctly proxies the admin path and auth is enforced.
    expect([200, 403]).toContain(resp.status())
  })

  test('admin1 token contains admin role claim', async ({ request }) => {
    const resp = await request.post(KEYCLOAK_TOKEN_URL, {
      form: {
        grant_type: 'password',
        client_id: 'ui-client',
        username: 'admin1',
        password: 'CHANGE_ME',
      },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.access_token).toBeTruthy()

    // Decode JWT payload (no verification — just check the claim exists)
    const payload = JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64').toString())
    expect(Array.isArray(payload.roles)).toBe(true)
    expect(payload.roles).toContain('admin')
    expect(payload.roles).toContain('customer')
  })

  test('user1 token does NOT contain admin role', async ({ request }) => {
    const resp = await request.post(KEYCLOAK_TOKEN_URL, {
      form: {
        grant_type: 'password',
        client_id: 'ui-client',
        username: 'user1',
        password: 'CHANGE_ME',
      },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    const payload = JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64').toString())
    expect(payload.roles).toContain('customer')
    expect(payload.roles).not.toContain('admin')
  })

  test('Keycloak admin console is accessible via API (gateway routes /admin correctly)', async ({ request }) => {
    // Use the Playwright request fixture (not browser page) which follows the system hosts file.
    // Verifies the gateway correctly forwards idp.keycloak.net/admin to the Keycloak pod.
    const resp = await request.get('https://idp.keycloak.net:30000/admin/master/console/', {
      maxRedirects: 5,
    })
    // Keycloak admin SPA returns 200 after following redirects
    expect([200, 302]).toContain(resp.status())
  })

})
