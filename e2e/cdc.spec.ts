/**
 * CDC Pipeline E2E Test
 * Places an order via the UI, then polls the analytics DB directly
 * to verify the order appeared via Debezium CDC (max 30s).
 */
import { test, expect } from './fixtures/base'
import { pollUntilFound } from './helpers/db'

test.describe('CDC Pipeline', () => {

  test('order placed via UI appears in analytics DB within 30s', async ({ page }) => {
    // ── 1. Place an order ────────────────────────────────────────────────
    await page.goto('/')
    await page.screenshot({ path: 'screenshots/cdc-01-catalog-before-order.png', fullPage: true })

    await page.getByRole('button', { name: /add to cart/i }).first().click()
    await page.waitForTimeout(300)

    await page.goto('/cart')
    await page.screenshot({ path: 'screenshots/cdc-02-cart-before-checkout.png', fullPage: true })

    await page.getByRole('button', { name: /checkout/i }).click()
    await expect(page).toHaveURL(/order-confirmation/)
    await page.screenshot({ path: 'screenshots/cdc-03-order-confirmation.png', fullPage: true })

    // Extract orderId from URL
    const url = new URL(page.url())
    const orderId = url.searchParams.get('orderId')
    expect(orderId).toBeTruthy()

    // ── 2. Poll analytics DB for fact_orders ─────────────────────────────
    // fact_orders.id matches source orders.id (no rename in CDC pipeline)
    const rows = await pollUntilFound<{ id: string }>(
      'SELECT id FROM fact_orders WHERE id = $1',
      [orderId],
      30_000,
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(orderId)
    await page.screenshot({ path: 'screenshots/cdc-04-analytics-db-synced.png', fullPage: false })

    // ── 3. Verify order_items also synced ────────────────────────────────
    const itemRows = await pollUntilFound<{ order_id: string }>(
      'SELECT order_id FROM fact_order_items WHERE order_id = $1',
      [orderId],
      10_000,
    )
    expect(itemRows.length).toBeGreaterThan(0)
    await page.screenshot({ path: 'screenshots/cdc-05-order-items-synced.png', fullPage: false })
  })

  test('books dim table is populated in analytics DB', async ({ page }) => {
    await page.goto('/')
    await page.screenshot({ path: 'screenshots/cdc-06-catalog-for-dim-check.png', fullPage: true })

    // Verify dim_books has been populated from Debezium CDC snapshot
    const books = await pollUntilFound<{ id: string; title: string }>(
      'SELECT id, title FROM dim_books LIMIT 5',
      [],
      10_000,
    )
    expect(books.length).toBeGreaterThan(0)

    // Books should have titles (not null)
    books.forEach(book => expect(book.title).toBeTruthy())
    await page.screenshot({ path: 'screenshots/cdc-07-dim-books-populated.png', fullPage: false })
  })

  test('inventory table is synced to analytics DB', async ({ page }) => {
    await page.goto('/')

    // Verify fact_inventory has been populated from Debezium CDC snapshot
    const inventory = await pollUntilFound<{ book_id: string; quantity: number }>(
      'SELECT book_id, quantity FROM fact_inventory LIMIT 5',
      [],
      10_000,
    )
    expect(inventory.length).toBeGreaterThan(0)
    await page.screenshot({ path: 'screenshots/cdc-08-inventory-synced.png', fullPage: true })
  })
})
