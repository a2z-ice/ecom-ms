/**
 * Checkout E2E Tests
 * Covers the complete checkout flow: add to cart → checkout → order confirmation,
 * and verifies the cart is cleared after a successful order.
 */
import { test, expect } from './fixtures/base'
import * as fs from 'fs'
import * as path from 'path'

/** Read auth token from session file for API-level cart clearing */
function getAuthToken(): string {
  try {
    const sessionData: Record<string, string> = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures/user1-session.json'), 'utf-8')
    )
    for (const [key, value] of Object.entries(sessionData)) {
      if (key.startsWith('oidc.user:')) {
        return JSON.parse(value).access_token
      }
    }
  } catch { /* ignore */ }
  return ''
}

test.describe('Checkout', () => {

  // Clear server cart before each test to avoid cross-test state pollution
  test.beforeEach(async ({ request }) => {
    const token = getAuthToken()
    if (!token) return
    const resp = await request.get('http://localhost:30000/ecom/cart', {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (!resp.ok()) return
    const items = await resp.json()
    if (!Array.isArray(items)) return
    for (const item of items) {
      await request.delete(`http://localhost:30000/ecom/cart/${item.id}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
    }
  })

  test('complete checkout flow', async ({ page }) => {
    // ── Step 1: Add a book to cart ────────────────────────────────────────
    await page.goto('/')
    await expect(page.getByRole('button', { name: /logout/i })).toBeVisible()
    await expect(page.getByText('In Stock').first()).toBeVisible({ timeout: 10000 })
    await page.screenshot({ path: 'screenshots/checkout-01-catalog.png', fullPage: true })

    const addBtn = page.getByRole('button', { name: /add to cart/i }).first()
    await expect(addBtn).toBeVisible()

    // Wait for the POST /ecom/cart response to confirm the item was added
    const [cartResp] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/ecom/cart') && r.request().method() === 'POST'),
      addBtn.click(),
    ])
    await cartResp.finished()
    await page.screenshot({ path: 'screenshots/checkout-02-item-added.png', fullPage: true })

    // ── Step 2: Go to cart ────────────────────────────────────────────────
    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: /your cart/i })).toBeVisible()
    await page.screenshot({ path: 'screenshots/checkout-03-cart-ready.png', fullPage: true })

    // ── Step 3: Click Checkout ────────────────────────────────────────────
    const checkoutBtn = page.getByRole('button', { name: /checkout/i })
    await expect(checkoutBtn).toBeEnabled({ timeout: 10000 })
    await page.screenshot({ path: 'screenshots/checkout-04-checkout-button.png', fullPage: true })
    await checkoutBtn.click()

    // ── Step 4: Order confirmation ────────────────────────────────────────
    await expect(page).toHaveURL(/order-confirmation/)
    await expect(page.getByRole('heading', { name: /order confirmed/i })).toBeVisible()
    await expect(page.getByText(/order id/i)).toBeVisible()
    await expect(page.getByText(/total/i)).toBeVisible()
    await page.screenshot({ path: 'screenshots/checkout-05-order-confirmation.png', fullPage: true })
  })

  test('cart is empty after successful checkout', async ({ page }) => {
    // Add an item first (cart was cleared by beforeEach)
    await page.goto('/')
    await expect(page.getByRole('button', { name: /logout/i })).toBeVisible()
    await expect(page.getByText('In Stock').first()).toBeVisible({ timeout: 10000 })
    const addBtn = page.getByRole('button', { name: /add to cart/i }).first()
    const [cartResp] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/ecom/cart') && r.request().method() === 'POST'),
      addBtn.click(),
    ])
    await cartResp.finished()

    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: /your cart/i })).toBeVisible()

    await page.screenshot({ path: 'screenshots/checkout-06-cart-before-final-checkout.png', fullPage: true })
    const checkoutBtn = page.getByRole('button', { name: /checkout/i })
    await expect(checkoutBtn).toBeEnabled({ timeout: 10000 })
    await checkoutBtn.click()
    await expect(page).toHaveURL(/order-confirmation/)
    await page.screenshot({ path: 'screenshots/checkout-07-second-order-confirmed.png', fullPage: true })

    await page.goto('/cart')
    await expect(page.getByText(/your cart is empty/i)).toBeVisible()
    await page.screenshot({ path: 'screenshots/checkout-08-empty-cart-after-checkout.png', fullPage: true })
  })
})
