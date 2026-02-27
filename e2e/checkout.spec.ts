/**
 * Checkout E2E Tests
 * Covers the complete checkout flow: add to cart → checkout → order confirmation,
 * and verifies the cart is cleared after a successful order.
 */
import { test, expect } from './fixtures/base'

test.describe('Checkout', () => {

  test('complete checkout flow', async ({ page }) => {
    // ── Step 1: Add a book to cart ────────────────────────────────────────
    await page.goto('/')
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
    await expect(checkoutBtn).toBeVisible()
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
    await page.goto('/cart')
    // Wait for cart page to finish loading (heading visible means cart data is fetched)
    await expect(page.getByRole('heading', { name: /your cart/i })).toBeVisible({ timeout: 10000 })

    const emptyMsg = page.getByText(/your cart is empty/i)
    // Cart may have been cleared by previous test
    if (await emptyMsg.isVisible()) {
      // Add item and wait for the POST /ecom/cart response before navigating to cart
      await page.goto('/')
      const addBtn = page.getByRole('button', { name: /add to cart/i }).first()
      await expect(addBtn).toBeVisible()
      const [cartResp] = await Promise.all([
        page.waitForResponse(r => r.url().includes('/ecom/cart') && r.request().method() === 'POST'),
        addBtn.click(),
      ])
      await cartResp.finished()
      await page.goto('/cart')
    }

    await page.screenshot({ path: 'screenshots/checkout-06-cart-before-final-checkout.png', fullPage: true })
    await page.getByRole('button', { name: /checkout/i }).click()
    await expect(page).toHaveURL(/order-confirmation/)
    await page.screenshot({ path: 'screenshots/checkout-07-second-order-confirmed.png', fullPage: true })

    await page.goto('/cart')
    await expect(page.getByText(/your cart is empty/i)).toBeVisible()
    await page.screenshot({ path: 'screenshots/checkout-08-empty-cart-after-checkout.png', fullPage: true })
  })
})
