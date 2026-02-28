/**
 * mTLS Enforcement E2E Tests — Session 16
 *
 * Verifies:
 * 1. External POST /inven/stock/reserve → 404 (HTTPRoute only exposes GET /stock and GET /health;
 *    POST /reserve is an internal-only endpoint not routed through the gateway)
 * 2. Full checkout succeeds end-to-end (ecom-service calls inventory via mTLS, order confirmed)
 * 3. POST /ecom/checkout without JWT → 401 (Spring Security enforces JWT)
 * 4. Stock reserved count increases after checkout (confirms mTLS reserve call actually ran)
 *
 * Architecture:
 *   ecom-service (SA: cluster.local/ns/ecom/sa/ecom-service)
 *     → POST /inven/stock/reserve  (pod-to-pod via Istio mTLS ztunnel, bypasses gateway)
 *       → AuthorizationPolicy (L4): allows infra namespace + ecom-service SA principal only
 *       → External callers → 404 (no matching HTTPRoute rule for POST /reserve)
 */
import { test, expect } from './fixtures/base'

const INVENTORY_BOOK_ID = '00000000-0000-0000-0000-000000000001' // "The Pragmatic Programmer"
const INVENTORY_STOCK_URL = `http://api.service.net:30000/inven/stock/${INVENTORY_BOOK_ID}`
const RESERVE_URL = 'http://api.service.net:30000/inven/stock/reserve'
const CHECKOUT_URL = 'http://api.service.net:30000/ecom/checkout'

test.describe('mTLS Enforcement', () => {

  test('external POST /reserve is blocked at gateway level (404 — no matching route)', async ({ request }) => {
    // The HTTPRoute for inventory-service only exposes:
    //   GET /inven/stock/* and GET /inven/health
    // POST /inven/stock/reserve has no matching route rule → gateway returns 404.
    // ecom-service calls this endpoint directly (pod-to-pod mTLS), bypassing the gateway.
    const res = await request.post(RESERVE_URL, {
      data: { book_id: INVENTORY_BOOK_ID, quantity: 1 },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status()).toBe(404)
  })

  test('checkout endpoint enforces JWT (401 without token)', async ({ request }) => {
    // POST /ecom/checkout without an Authorization header.
    // Spring Security OIDC resource server rejects the request before it reaches OrderService.
    const res = await request.post(CHECKOUT_URL)
    expect(res.status()).toBe(401)
  })

  test('checkout succeeds end-to-end via mTLS inventory reserve call', async ({ page }) => {
    // Uses authenticated browser context (user1 via storageState).
    // The checkout flow triggers ecom-service → inventory-service reserve call over mTLS.
    // If mTLS reserve fails, checkout returns 4xx and the order confirmation page never loads.
    await page.goto('/')

    // Add "The Pragmatic Programmer" (UUID 00000000-...-000000000001) to cart.
    // Search to locate it reliably regardless of display order.
    await page.goto('/search?q=Pragmatic')
    await page.waitForResponse(r =>
      r.url().includes('/ecom/books') && r.request().method() === 'GET'
    )
    const addBtn = page.getByRole('button', { name: /add to cart/i }).first()
    await expect(addBtn).toBeVisible()

    const [cartResp] = await Promise.all([
      page.waitForResponse(r =>
        r.url().includes('/ecom/cart') && r.request().method() === 'POST'
      ),
      addBtn.click(),
    ])
    expect(cartResp.status()).toBe(200)

    // Checkout
    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: /your cart/i })).toBeVisible()
    await page.getByRole('button', { name: /checkout/i }).click()

    // Success: order confirmation confirms ecom-service reserved stock via mTLS and placed order
    await expect(page).toHaveURL(/order-confirmation/, { timeout: 15_000 })
    await expect(page.getByRole('heading', { name: /order confirmed/i })).toBeVisible()
    await page.screenshot({ path: 'screenshots/mtls-checkout-confirmed.png', fullPage: true })
  })

  test('stock reserved count increases after checkout (mTLS reserve call side-effect)', async ({ page, request }) => {
    // Get the initial reserved count for the known book (public endpoint, no auth needed)
    const stockBefore = await request.get(INVENTORY_STOCK_URL)
    expect(stockBefore.status()).toBe(200)
    const { reserved: reservedBefore } = await stockBefore.json()

    // Add the same book to cart via search
    await page.goto('/search?q=Pragmatic')
    await page.waitForResponse(r =>
      r.url().includes('/ecom/books') && r.request().method() === 'GET'
    )
    const addBtn = page.getByRole('button', { name: /add to cart/i }).first()
    await expect(addBtn).toBeVisible()

    const [cartResp] = await Promise.all([
      page.waitForResponse(r =>
        r.url().includes('/ecom/cart') && r.request().method() === 'POST'
      ),
      addBtn.click(),
    ])
    expect(cartResp.status()).toBe(200)

    // Checkout
    await page.goto('/cart')
    await page.getByRole('button', { name: /checkout/i }).click()
    await expect(page).toHaveURL(/order-confirmation/, { timeout: 15_000 })

    // Verify reserved count increased — confirms ecom-service made the mTLS reserve call
    const stockAfter = await request.get(INVENTORY_STOCK_URL)
    expect(stockAfter.status()).toBe(200)
    const { reserved: reservedAfter } = await stockAfter.json()
    expect(reservedAfter).toBeGreaterThan(reservedBefore)

    await page.screenshot({ path: 'screenshots/mtls-stock-reserved.png', fullPage: true })
  })

})
