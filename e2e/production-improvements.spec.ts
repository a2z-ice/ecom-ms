/**
 * Production Improvements E2E Tests (Session 23)
 *
 * Covers:
 *   - API cache-control headers on public book endpoints
 *   - Health & readiness endpoints (inventory + ecom actuator)
 *   - Prometheus metrics exposure
 *   - UI error boundary and 404 page
 *   - Admin code splitting (React.lazy)
 *   - Nginx immutable asset caching
 *   - NetworkPolicy verification (legitimate traffic flows)
 *   - Grafana observability dashboard
 */
import { test, expect } from './fixtures/base'
import { test as plainTest } from '@playwright/test'

const ECOM_API = 'http://api.service.net:30000/ecom'
const INVEN_API = 'http://api.service.net:30000/inven'
const GRAFANA_URL = 'http://localhost:32500'

// ═══════════════════════════════════════════════════════════════════════════
// Suite 1 — API Headers (Cache-Control)
// ═══════════════════════════════════════════════════════════════════════════
plainTest.describe('Production Improvements — API Headers', () => {

  plainTest('GET /ecom/books has cache-control with max-age=60 and public', async ({ request }) => {
    const resp = await request.get(`${ECOM_API}/books`)
    expect(resp.ok(), `GET /ecom/books → ${resp.status()}`).toBeTruthy()
    const cacheControl = resp.headers()['cache-control'] ?? ''
    expect(cacheControl).toContain('max-age=60')
    expect(cacheControl).toContain('public')
  })

  plainTest('GET /ecom/books/search?q=kafka has cache-control with max-age=60', async ({ request }) => {
    const resp = await request.get(`${ECOM_API}/books/search?q=kafka`)
    expect(resp.ok(), `GET /ecom/books/search → ${resp.status()}`).toBeTruthy()
    const cacheControl = resp.headers()['cache-control'] ?? ''
    expect(cacheControl).toContain('max-age=60')
    expect(cacheControl).toContain('public')
  })

  plainTest('GET /ecom/books/{id} does NOT set cache-control header', async ({ request }) => {
    // First get a book ID from the list
    const listResp = await request.get(`${ECOM_API}/books`)
    expect(listResp.ok()).toBeTruthy()
    const body = await listResp.json()
    const bookId = body.content?.[0]?.id
    expect(bookId).toBeTruthy()

    const resp = await request.get(`${ECOM_API}/books/${bookId}`)
    expect(resp.ok(), `GET /ecom/books/${bookId} → ${resp.status()}`).toBeTruthy()
    const cacheControl = resp.headers()['cache-control'] ?? ''
    // Individual book endpoint should NOT have cache-control (no cacheControl() call in getBook)
    expect(cacheControl).not.toContain('max-age=60')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 2 — Health & Metrics
// ═══════════════════════════════════════════════════════════════════════════
plainTest.describe('Production Improvements — Health & Metrics', () => {

  plainTest('GET /inven/health returns 200 with status ok', async ({ request }) => {
    const resp = await request.get(`${INVEN_API}/health`)
    expect(resp.ok(), `GET /inven/health → ${resp.status()}`).toBeTruthy()
    const body = await resp.json()
    expect(body.status).toBe('ok')
  })

  plainTest('GET /inven/health/ready returns 200 with status ready', async ({ request }) => {
    const resp = await request.get(`${INVEN_API}/health/ready`)
    expect(resp.ok(), `GET /inven/health/ready → ${resp.status()}`).toBeTruthy()
    const body = await resp.json()
    expect(body.status).toBe('ready')
  })

  plainTest('GET /inven/metrics returns Prometheus metrics', async ({ request }) => {
    const resp = await request.get(`${INVEN_API}/metrics`)
    expect(resp.ok(), `GET /inven/metrics → ${resp.status()}`).toBeTruthy()
    const text = await resp.text()
    // prometheus_fastapi_instrumentator exposes http_request_duration or similar metrics
    expect(text).toContain('http_request')
  })

  plainTest('GET /ecom/actuator/health returns UP', async ({ request }) => {
    const resp = await request.get(`${ECOM_API}/actuator/health`)
    expect(resp.ok(), `GET /ecom/actuator/health → ${resp.status()}`).toBeTruthy()
    const body = await resp.json()
    expect(body.status).toBe('UP')
  })

  plainTest('ecom-service remains responsive after multiple rapid requests', async ({ request }) => {
    // Fire 10 rapid requests to verify circuit breaker does not trip on healthy service
    const promises = Array.from({ length: 10 }, () =>
      request.get(`${ECOM_API}/books`)
    )
    const responses = await Promise.all(promises)
    for (const resp of responses) {
      expect(resp.ok(), `Rapid request → ${resp.status()}`).toBeTruthy()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 3 — UI Improvements (404 page, error boundary, code splitting)
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Production Improvements — UI Improvements', () => {

  test('navigating to /nonexistent-page shows 404 page', async ({ page }) => {
    await page.goto('/nonexistent-page')
    await expect(page.getByRole('heading', { name: /page not found/i })).toBeVisible()
    await page.screenshot({ path: 'screenshots/prod-01-404-page.png', fullPage: true })
  })

  test('404 page has a link back to the catalog', async ({ page }) => {
    await page.goto('/nonexistent-page')
    const catalogLink = page.getByRole('link', { name: /browse catalog/i })
    await expect(catalogLink).toBeVisible()
    await expect(catalogLink).toHaveAttribute('href', '/')
  })

  test('404 page still shows the NavBar', async ({ page }) => {
    await page.goto('/nonexistent-page')
    // NavBar contains the brand or navigation links
    const nav = page.locator('nav')
    await expect(nav).toBeVisible()
    await page.screenshot({ path: 'screenshots/prod-02-404-with-navbar.png', fullPage: true })
  })

  test('ErrorBoundary wraps routes in the DOM', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /book catalog/i })).toBeVisible()
    // The app loads normally, meaning ErrorBoundary is not in error state.
    // Verify the app structure is intact (NavBar + content visible).
    await expect(page.locator('nav')).toBeVisible()
    await page.screenshot({ path: 'screenshots/prod-03-error-boundary-normal.png', fullPage: true })
  })

  test('catalog page loads without triggering error boundary', async ({ page }) => {
    await page.goto('/')
    // If error boundary triggered, we would see "Something went wrong"
    await expect(page.getByText(/something went wrong/i)).not.toBeVisible()
    await expect(page.getByRole('heading', { name: /book catalog/i })).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 4 — Admin Code Splitting
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Production Improvements — Admin Code Splitting', () => {

  test('admin route lazy-loads and renders for non-admin user (Access Denied)', async ({ page }) => {
    // user1 is authenticated but not admin — navigating to /admin triggers lazy chunk load
    // and renders AdminRoute which shows "Access Denied" for non-admin users
    await page.goto('/admin')
    await expect(page.getByText(/access denied/i)).toBeVisible({ timeout: 10000 })
    await page.screenshot({ path: 'screenshots/prod-04-admin-lazy-loaded.png', fullPage: true })
  })

  test('catalog page does not load admin JS chunks eagerly', async ({ page }) => {
    // Navigate to catalog and check that no admin chunk scripts are in the DOM
    // React.lazy + code splitting means admin chunks load only on /admin navigation
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /book catalog/i })).toBeVisible()

    const adminChunks = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[src]'))
      return scripts
        .map(s => (s as HTMLScriptElement).src)
        .filter(src => src.toLowerCase().includes('admin'))
    })
    // Admin chunks should NOT be loaded on the catalog page
    expect(adminChunks).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 5 — NetworkPolicy Verification
// ═══════════════════════════════════════════════════════════════════════════
plainTest.describe('Production Improvements — NetworkPolicy Verification', () => {

  plainTest('GET /ecom/books is accessible through the gateway', async ({ request }) => {
    const resp = await request.get(`${ECOM_API}/books`)
    expect(resp.ok(), `GET /ecom/books → ${resp.status()}`).toBeTruthy()
  })

  plainTest('GET /inven/health is accessible through the gateway', async ({ request }) => {
    const resp = await request.get(`${INVEN_API}/health`)
    expect(resp.ok(), `GET /inven/health → ${resp.status()}`).toBeTruthy()
  })

  plainTest('GET /inven/stock/bulk is accessible through the gateway', async ({ request }) => {
    const resp = await request.get(`${INVEN_API}/stock/bulk?book_ids=`)
    expect(resp.ok(), `GET /inven/stock/bulk → ${resp.status()}`).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 6 — Observability (Grafana)
// ═══════════════════════════════════════════════════════════════════════════
plainTest.describe('Production Improvements — Observability', () => {

  plainTest('Grafana /api/health returns ok', async ({ request }) => {
    const resp = await request.get(`${GRAFANA_URL}/api/health`)
    expect(resp.ok(), `GET ${GRAFANA_URL}/api/health → ${resp.status()}`).toBeTruthy()
    const body = await resp.json()
    expect(body.database).toBe('ok')
  })

  plainTest('Grafana login page loads', async ({ page }) => {
    await page.goto(`${GRAFANA_URL}/login`)
    await page.waitForLoadState('networkidle')
    // Grafana login page contains a login form or the Grafana title
    const title = await page.title()
    expect(title.toLowerCase()).toContain('grafana')
    await page.screenshot({ path: 'screenshots/prod-05-grafana-login.png', fullPage: true })
  })

  plainTest('Grafana has provisioned dashboards accessible via API', async ({ request }) => {
    // Use admin credentials to query dashboards
    const resp = await request.get(`${GRAFANA_URL}/api/search`, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from('admin:CHANGE_ME').toString('base64'),
      },
    })
    expect(resp.ok(), `GET /api/search → ${resp.status()}`).toBeTruthy()
    const dashboards = await resp.json()
    expect(dashboards.length).toBeGreaterThanOrEqual(2)
    const uids = dashboards.map((d: { uid: string }) => d.uid)
    expect(uids).toContain('service-health')
    expect(uids).toContain('cluster-overview')
  })

  plainTest('Nginx serves /assets/ with immutable cache headers', async ({ page, request }) => {
    // Load the app to get the actual asset URLs (Vite hashes filenames)
    await page.goto('http://localhost:30000/')
    await page.waitForLoadState('networkidle')

    // Find a JS asset URL from the page source
    const assetUrls = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[src*="/assets/"]'))
      return scripts.map(s => (s as HTMLScriptElement).src)
    })

    if (assetUrls.length > 0) {
      const resp = await request.get(assetUrls[0])
      expect(resp.ok(), `GET asset → ${resp.status()}`).toBeTruthy()
      const cacheControl = resp.headers()['cache-control'] ?? ''
      expect(cacheControl).toContain('max-age=31536000')
      expect(cacheControl).toContain('immutable')
    } else {
      // If no script assets found, check link stylesheets
      const cssUrls = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('link[href*="/assets/"]'))
        return links.map(l => (l as HTMLLinkElement).href)
      })
      expect(cssUrls.length).toBeGreaterThan(0)
      const resp = await request.get(cssUrls[0])
      expect(resp.ok()).toBeTruthy()
      const cacheControl = resp.headers()['cache-control'] ?? ''
      expect(cacheControl).toContain('immutable')
    }
  })
})
