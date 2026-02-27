/**
 * Cart E2E Tests
 * Covers adding items, viewing cart with totals, and unauthenticated redirect.
 */
import { test, expect } from './fixtures/base'

test.describe('Cart', () => {

  test('authenticated user can add a book to cart', async ({ page }) => {
    await page.goto('/')
    await page.screenshot({ path: 'screenshots/cart-01-catalog-before-add.png', fullPage: true })

    // Click the first "Add to Cart" button
    const addBtn = page.getByRole('button', { name: /add to cart/i }).first()
    await expect(addBtn).toBeVisible()
    await addBtn.click()
    // Wait for the API call to complete — button reverts from "Adding..." back to "Add to Cart"
    await expect(addBtn).not.toHaveText(/adding/i, { timeout: 5000 })
    await page.screenshot({ path: 'screenshots/cart-02-after-add-to-cart.png', fullPage: true })

    // Navigate to cart and verify item appears
    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: /your cart/i })).toBeVisible()
    const rows = page.locator('tbody tr')
    await expect(rows.first()).toBeVisible()
    const rowCount = await rows.count()
    expect(rowCount).toBeGreaterThan(0)
    await page.screenshot({ path: 'screenshots/cart-03-cart-with-items.png', fullPage: true })
  })

  test('cart shows total price', async ({ page }) => {
    await page.goto('/cart')
    // The cart page renders "Total: $XX.XX" as a paragraph
    await expect(page.getByText(/Total: \$\d+\.\d{2}/)).toBeVisible()
    await page.screenshot({ path: 'screenshots/cart-04-total-price.png', fullPage: true })
  })

  test('unauthenticated add-to-cart adds to guest cart (no login redirect)', async ({ browser }) => {
    // Session 14: clicking "Add to Cart" as a guest stores item in localStorage (guest cart),
    // shows a toast, and does NOT redirect to Keycloak.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })   // no storageState
    const page = await ctx.newPage()
    await page.goto('http://localhost:30000/')
    await page.screenshot({ path: 'screenshots/cart-05-unauthenticated-catalog.png', fullPage: true })

    await page.getByRole('button', { name: /add to cart/i }).first().click()
    // Should show a toast notification (not navigate away)
    await expect(page.locator('.toast')).toBeVisible()
    // URL stays on the catalog — no Keycloak redirect
    await expect(page).toHaveURL(/localhost:30000\/?$/)
    await page.screenshot({ path: 'screenshots/cart-06-unauthenticated-guest-add-to-cart.png', fullPage: true })
    await ctx.close()
  })
})
