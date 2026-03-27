/**
 * UI Fixes E2E Tests
 * Covers three fixes:
 * 1. Nav cart badge shows count for authenticated users
 * 2. Minus (−) button decrements cart item quantity via PUT /cart/{id}
 * 3. Logout button is visually distinct (white text on dark navbar)
 *
 * Cart clearing is handled automatically by the base fixture (fixtures/base.ts).
 */
import { test, expect } from './fixtures/base'

/** Helper: add the first in-stock book to cart and wait for API response */
async function addBookToCart(page: any) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: /logout/i })).toBeVisible()
  await expect(page.getByText('In Stock').first()).toBeVisible({ timeout: 10000 })

  const addBtn = page.getByRole('button', { name: /add to cart/i }).first()
  await expect(addBtn).toBeEnabled()

  // Wait for the POST /cart response (handles CSRF auto-retry transparently)
  const [cartResp] = await Promise.all([
    page.waitForResponse((r: any) => r.url().includes('/ecom/cart') && r.request().method() === 'POST'),
    addBtn.click(),
  ])
  expect(cartResp.status()).toBeLessThan(400)
}

test.describe('UI Fixes', () => {

  test('authenticated nav cart badge shows count after adding a book', async ({ page }) => {
    await addBookToCart(page)
    await page.screenshot({ path: 'screenshots/ui-fixes-01-auth-catalog.png', fullPage: true })

    // Nav badge must now be visible with a positive count
    const badge = page.locator('.nav-cart-count')
    await expect(badge).toBeVisible({ timeout: 10000 })
    const badgeText = await badge.textContent()
    expect(parseInt(badgeText ?? '0')).toBeGreaterThan(0)
    await page.screenshot({ path: 'screenshots/ui-fixes-02-auth-cart-badge-visible.png', fullPage: true })
  })

  test('minus button decrements authenticated cart item quantity', async ({ page }) => {
    await addBookToCart(page)

    // Navigate to cart
    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: /your cart/i })).toBeVisible()
    await page.screenshot({ path: 'screenshots/ui-fixes-03-cart-before-minus.png', fullPage: true })

    const firstRow = page.locator('tbody tr').first()
    const qtySpan = firstRow.locator('.qty-ctrl span')
    const plusBtn = firstRow.locator('button.qty-btn').last()
    const minusBtn = firstRow.locator('button.qty-btn').first()

    // Click + to guarantee qty ≥ 2 and wait for the API response
    const qtyBeforePlus = parseInt(await qtySpan.textContent() ?? '1')
    await Promise.all([
      page.waitForResponse((r: any) => r.url().includes('/ecom/cart') && r.status() < 400),
      plusBtn.click(),
    ])
    await expect(qtySpan).toHaveText(String(qtyBeforePlus + 1), { timeout: 10000 })

    const qtyBeforeMinus = parseInt(await qtySpan.textContent() ?? '2')

    // Click − and wait for response
    await Promise.all([
      page.waitForResponse((r: any) => r.url().includes('/ecom/cart') && r.status() < 400),
      minusBtn.click(),
    ])
    await expect(qtySpan).toHaveText(String(qtyBeforeMinus - 1), { timeout: 10000 })

    const qtyAfterMinus = parseInt(await qtySpan.textContent() ?? '0')
    expect(qtyAfterMinus).toBe(qtyBeforeMinus - 1)
    await page.screenshot({ path: 'screenshots/ui-fixes-04-minus-decremented.png', fullPage: true })
  })

  test('minus button removes cart item when quantity reaches zero', async ({ page }) => {
    await addBookToCart(page)

    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: /your cart/i })).toBeVisible()

    const rows = page.locator('tbody tr')
    const rowCountBefore = await rows.count()
    expect(rowCountBefore).toBeGreaterThan(0)

    // Reduce first item's quantity to exactly 1
    const firstRow = rows.first()
    const qtySpan = firstRow.locator('.qty-ctrl span')
    const minusBtn = firstRow.locator('button.qty-btn').first()

    let qty = parseInt(await qtySpan.textContent() ?? '1')
    while (qty > 1) {
      await Promise.all([
        page.waitForResponse((r: any) => r.url().includes('/ecom/cart') && r.status() < 400),
        minusBtn.click(),
      ])
      qty--
      await expect(qtySpan).toHaveText(String(qty), { timeout: 10000 })
    }

    // Now qty is 1 — click − once more to remove the item
    await page.screenshot({ path: 'screenshots/ui-fixes-05-before-remove.png', fullPage: true })
    await Promise.all([
      page.waitForResponse((r: any) => r.url().includes('/ecom/cart')),
      minusBtn.click(),
    ])

    // Row count must decrease by 1
    await expect(rows).toHaveCount(rowCountBefore - 1, { timeout: 10000 })
    await page.screenshot({ path: 'screenshots/ui-fixes-06-item-removed.png', fullPage: true })
  })

  test('logout button is visible with white text on dark navbar', async ({ page }) => {
    await page.goto('/')
    const logoutBtn = page.getByRole('button', { name: /logout/i })
    await expect(logoutBtn).toBeVisible()
    await page.screenshot({ path: 'screenshots/ui-fixes-07-logout-button.png', fullPage: true })

    // The inline style sets color: '#fff' — computed color must be white
    const color = await logoutBtn.evaluate((el: Element) => {
      return window.getComputedStyle(el).color
    })
    expect(color).toBe('rgb(255, 255, 255)')
  })

  test('nav cart badge updates count after checkout clears the cart', async ({ page }) => {
    await addBookToCart(page)

    const badge = page.locator('.nav-cart-count')
    await expect(badge).toBeVisible({ timeout: 10000 })

    // Checkout
    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: /your cart/i })).toBeVisible()
    const checkoutBtn = page.getByRole('button', { name: /checkout/i })
    await expect(checkoutBtn).toBeEnabled({ timeout: 10000 })
    await checkoutBtn.click()

    // Should land on order confirmation
    await expect(page).toHaveURL(/\/order-confirmation/, { timeout: 15000 })
    await page.screenshot({ path: 'screenshots/ui-fixes-08-after-checkout-badge.png', fullPage: true })

    // Navigate back to catalog — badge should be gone (cart is now empty)
    await page.goto('/')
    await expect(badge).not.toBeVisible({ timeout: 10000 })
  })
})
