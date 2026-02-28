/**
 * UI Fixes E2E Tests
 * Covers three fixes:
 * 1. Nav cart badge shows count for authenticated users
 * 2. Minus (−) button decrements cart item quantity via PUT /cart/{id}
 * 3. Logout button is visually distinct (white text on dark navbar)
 */
import { test, expect } from './fixtures/base'

test.describe('UI Fixes', () => {

  test('authenticated nav cart badge shows count after adding a book', async ({ page }) => {
    await page.goto('http://localhost:30000/')
    // Confirm we are authenticated
    await expect(page.getByRole('button', { name: /logout/i })).toBeVisible()
    await page.screenshot({ path: 'screenshots/ui-fixes-01-auth-catalog.png', fullPage: true })

    // Add first book to cart
    const addBtn = page.getByRole('button', { name: /add to cart/i }).first()
    await addBtn.click()
    // Wait for the API call to complete
    await expect(addBtn).not.toHaveText(/adding/i, { timeout: 5000 })

    // Nav badge must now be visible with a positive count
    const badge = page.locator('.nav-cart-count')
    await expect(badge).toBeVisible({ timeout: 5000 })
    const badgeText = await badge.textContent()
    expect(parseInt(badgeText ?? '0')).toBeGreaterThan(0)
    await page.screenshot({ path: 'screenshots/ui-fixes-02-auth-cart-badge-visible.png', fullPage: true })
  })

  test('minus button decrements authenticated cart item quantity', async ({ page }) => {
    // Ensure at least one book is in the cart with qty ≥ 1
    await page.goto('http://localhost:30000/')
    const addBtn = page.getByRole('button', { name: /add to cart/i }).first()
    await addBtn.click()
    await expect(addBtn).not.toHaveText(/adding/i, { timeout: 5000 })

    // Navigate to cart
    await page.goto('http://localhost:30000/cart')
    await expect(page.getByRole('heading', { name: /your cart/i })).toBeVisible()
    await page.screenshot({ path: 'screenshots/ui-fixes-03-cart-before-minus.png', fullPage: true })

    const firstRow = page.locator('tbody tr').first()
    const qtySpan = firstRow.locator('.qty-ctrl span')
    const plusBtn = firstRow.locator('button.qty-btn').last()
    const minusBtn = firstRow.locator('button.qty-btn').first()

    // Click + to guarantee qty ≥ 2 and wait for the UI to update
    const qtyBeforePlus = parseInt(await qtySpan.textContent() ?? '1')
    await plusBtn.click()
    await expect(qtySpan).toHaveText(String(qtyBeforePlus + 1), { timeout: 5000 })

    const qtyBeforeMinus = parseInt(await qtySpan.textContent() ?? '2')

    // Click − and verify quantity decrements by 1
    await minusBtn.click()
    await expect(qtySpan).toHaveText(String(qtyBeforeMinus - 1), { timeout: 5000 })

    const qtyAfterMinus = parseInt(await qtySpan.textContent() ?? '0')
    expect(qtyAfterMinus).toBe(qtyBeforeMinus - 1)
    await page.screenshot({ path: 'screenshots/ui-fixes-04-minus-decremented.png', fullPage: true })
  })

  test('minus button removes cart item when quantity reaches zero', async ({ page }) => {
    // Add a single book to ensure at least one item is in the cart
    await page.goto('http://localhost:30000/')
    const addBtn = page.getByRole('button', { name: /add to cart/i }).first()
    await addBtn.click()
    await expect(addBtn).not.toHaveText(/adding/i, { timeout: 5000 })

    await page.goto('http://localhost:30000/cart')
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
      await minusBtn.click()
      qty--
      await expect(qtySpan).toHaveText(String(qty), { timeout: 5000 })
    }

    // Now qty is 1 — click − once more to remove the item
    await page.screenshot({ path: 'screenshots/ui-fixes-05-before-remove.png', fullPage: true })
    await minusBtn.click()

    // Row count must decrease by 1
    await expect(rows).toHaveCount(rowCountBefore - 1, { timeout: 5000 })
    await page.screenshot({ path: 'screenshots/ui-fixes-06-item-removed.png', fullPage: true })
  })

  test('logout button is visible with white text on dark navbar', async ({ page }) => {
    await page.goto('http://localhost:30000/')
    const logoutBtn = page.getByRole('button', { name: /logout/i })
    await expect(logoutBtn).toBeVisible()
    await page.screenshot({ path: 'screenshots/ui-fixes-07-logout-button.png', fullPage: true })

    // The inline style sets color: '#fff' — computed color must be white
    const color = await logoutBtn.evaluate(el => {
      return window.getComputedStyle(el).color
    })
    expect(color).toBe('rgb(255, 255, 255)')
  })

  test('nav cart badge updates count after checkout clears the cart', async ({ page }) => {
    // Add a book so cart is non-empty
    await page.goto('http://localhost:30000/')
    const addBtn = page.getByRole('button', { name: /add to cart/i }).first()
    await addBtn.click()
    await expect(addBtn).not.toHaveText(/adding/i, { timeout: 5000 })

    const badge = page.locator('.nav-cart-count')
    await expect(badge).toBeVisible({ timeout: 5000 })

    // Checkout
    await page.goto('http://localhost:30000/cart')
    await expect(page.getByRole('heading', { name: /your cart/i })).toBeVisible()
    const checkoutBtn = page.getByRole('button', { name: /checkout/i })
    await expect(checkoutBtn).toBeVisible()
    await checkoutBtn.click()

    // Should land on order confirmation
    await expect(page).toHaveURL(/\/order-confirmation/, { timeout: 10000 })
    await page.screenshot({ path: 'screenshots/ui-fixes-08-after-checkout-badge.png', fullPage: true })

    // Navigate back to catalog — badge should be gone (cart is now empty)
    await page.goto('http://localhost:30000/')
    await expect(badge).not.toBeVisible({ timeout: 5000 })
  })
})
