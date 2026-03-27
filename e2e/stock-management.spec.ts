/**
 * Stock Management E2E Tests
 * Covers stock badge display on catalog, search results, and cart pages.
 * Global setup resets all 10 seeded books to 50 units each before the test run.
 * OOS disabled-button behavior is tested via API structure verification only.
 *
 * Cart clearing is handled automatically by the base fixture (fixtures/base.ts).
 */
import { test, expect } from './fixtures/base'

test.describe('Stock Management', () => {

  test('bulk stock API returns correct structure', async ({ request }) => {
    // First get a book ID from the catalog API
    const booksResp = await request.get('https://api.service.net:30000/ecom/books?page=0&size=5')
    expect(booksResp.status()).toBe(200)
    const books = await booksResp.json()
    expect(books.content.length).toBeGreaterThan(0)

    const bookIds = books.content.slice(0, 3).map((b: any) => b.id).join(',')
    const stockResp = await request.get(`https://api.service.net:30000/inven/stock/bulk?book_ids=${bookIds}`)
    expect(stockResp.status()).toBe(200)

    const stocks = await stockResp.json()
    expect(Array.isArray(stocks)).toBe(true)
    expect(stocks.length).toBe(3)

    // Verify schema of each stock entry
    for (const s of stocks) {
      expect(s).toHaveProperty('book_id')
      expect(s).toHaveProperty('quantity')
      expect(s).toHaveProperty('reserved')
      expect(s).toHaveProperty('available')
      expect(s).toHaveProperty('updated_at')
      expect(typeof s.available).toBe('number')
      expect(s.available).toBeGreaterThanOrEqual(0)
    }
  })

  test('bulk stock API returns empty array for empty input', async ({ request }) => {
    const resp = await request.get('https://api.service.net:30000/inven/stock/bulk?book_ids=')
    expect(resp.status()).toBe(200)
    const stocks = await resp.json()
    expect(Array.isArray(stocks)).toBe(true)
    expect(stocks.length).toBe(0)
  })

  test('bulk stock API silently omits unknown UUIDs', async ({ request }) => {
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const resp = await request.get(`https://api.service.net:30000/inven/stock/bulk?book_ids=${fakeId}`)
    expect(resp.status()).toBe(200)
    const stocks = await resp.json()
    expect(Array.isArray(stocks)).toBe(true)
    expect(stocks.length).toBe(0)
  })

  test('catalog page shows In Stock badges for seeded books', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.book-card', { timeout: 10000 })

    // Wait for stock badges to appear (progressive enhancement)
    await expect(page.locator('span').filter({ hasText: 'In Stock' }).first()).toBeVisible({ timeout: 10000 })

    const inStockBadges = page.locator('span').filter({ hasText: 'In Stock' })
    const count = await inStockBadges.count()
    expect(count).toBeGreaterThan(0)

    await page.screenshot({ path: 'screenshots/stock-01-catalog-stock-badges.png', fullPage: true })
  })

  test('catalog page Add to Cart buttons are enabled for in-stock books', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.book-card', { timeout: 10000 })

    // Wait for stock data to load (badges appear)
    await expect(page.locator('span').filter({ hasText: 'In Stock' }).first()).toBeVisible({ timeout: 10000 })

    // All Add to Cart buttons should be enabled (all books have stock > 0)
    const addBtns = page.getByRole('button', { name: /add to cart/i })
    const btnCount = await addBtns.count()
    expect(btnCount).toBeGreaterThan(0)

    for (let i = 0; i < btnCount; i++) {
      await expect(addBtns.nth(i)).toBeEnabled()
    }
  })

  test('search page shows Availability column with stock badges', async ({ page }) => {
    await page.goto('/search?q=the')
    await page.waitForSelector('.search-row', { timeout: 10000 })

    // Wait for stock badges to load
    await expect(page.locator('span').filter({ hasText: /In Stock|Low Stock|Out of Stock|left/ }).first()).toBeVisible({ timeout: 10000 })

    const rows = page.locator('.search-row')
    const rowCount = await rows.count()
    expect(rowCount).toBeGreaterThan(0)

    // At least one stock badge should appear in search results
    const badges = page.locator('span').filter({ hasText: /In Stock|Low Stock|Out of Stock|left/ })
    const badgeCount = await badges.count()
    expect(badgeCount).toBeGreaterThan(0)

    await page.screenshot({ path: 'screenshots/stock-02-search-availability-column.png', fullPage: true })
  })

  test('search page Add to Cart buttons are enabled for in-stock results', async ({ page }) => {
    await page.goto('/search?q=the')
    await page.waitForSelector('.search-row', { timeout: 10000 })

    // Wait for stock badges to load
    await expect(page.locator('span').filter({ hasText: /In Stock|Low Stock|Out of Stock|left/ }).first()).toBeVisible({ timeout: 10000 })

    const addBtns = page.getByRole('button', { name: /add to cart/i })
    const btnCount = await addBtns.count()
    expect(btnCount).toBeGreaterThan(0)

    // First button should be enabled (all seeded books have stock)
    await expect(addBtns.first()).toBeEnabled()
  })

  test('cart page shows Availability column with per-item stock badges', async ({ page }) => {
    // Add a book to cart first — wait for auth + stock to load
    await page.goto('/')
    await expect(page.getByRole('button', { name: /logout/i })).toBeVisible()
    await expect(page.getByText('In Stock').first()).toBeVisible({ timeout: 10000 })
    const addBtn = page.getByRole('button', { name: /add to cart/i }).first()
    await expect(addBtn).toBeEnabled()

    // Wait for the POST /cart response to confirm the item was added
    const [cartResp] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/ecom/cart') && r.request().method() === 'POST'),
      addBtn.click(),
    ])
    expect(cartResp.status()).toBeLessThan(400)

    // Navigate to cart — use waitForResponse to ensure cart data is fetched
    const cartLoadPromise = page.waitForResponse(
      r => r.url().includes('/ecom/cart') && r.request().method() === 'GET',
    )
    await page.goto('/cart')
    const cartLoadResp = await cartLoadPromise
    expect(cartLoadResp.status()).toBeLessThan(400)
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 15000 })

    // Should show "Availability" header
    await expect(page.getByRole('columnheader', { name: /availability/i })).toBeVisible()

    // Should show at least one stock badge
    const badges = page.locator('span').filter({ hasText: /In Stock|Low Stock|Out of Stock|left/ })
    await expect(badges.first()).toBeVisible({ timeout: 5000 })

    await page.screenshot({ path: 'screenshots/stock-03-cart-stock-badges.png', fullPage: true })
  })

  test('cart checkout button is enabled when all items have sufficient stock', async ({ page }) => {
    // Add a book to ensure cart is not empty
    await page.goto('/')
    await expect(page.getByText('In Stock').first()).toBeVisible({ timeout: 10000 })
    const addBtn = page.getByRole('button', { name: /add to cart/i }).first()
    await expect(addBtn).toBeEnabled()

    // Wait for the POST /cart response (handles CSRF auto-retry)
    const [cartResp] = await Promise.all([
      page.waitForResponse((r: any) => r.url().includes('/ecom/cart') && r.request().method() === 'POST'),
      addBtn.click(),
    ])
    expect(cartResp.status()).toBeLessThan(400)

    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: /your cart/i })).toBeVisible()

    // Checkout button should be enabled (all books have 50 units, cart qty = 1)
    const checkoutBtn = page.getByRole('button', { name: /checkout/i })
    await expect(checkoutBtn).toBeEnabled({ timeout: 10000 })

    await page.screenshot({ path: 'screenshots/stock-04-cart-checkout-enabled.png', fullPage: true })
  })

  test('individual stock API returns correct structure', async ({ request }) => {
    // Use a known book ID with guaranteed seeded stock (book 1: 50 units)
    const bookId = '00000000-0000-0000-0000-000000000001'
    const resp = await request.get(`https://api.service.net:30000/inven/stock/${bookId}`)
    expect(resp.status()).toBe(200)
    const stock = await resp.json()

    expect(stock).toHaveProperty('book_id')
    expect(stock).toHaveProperty('quantity')
    expect(stock).toHaveProperty('reserved')
    expect(stock).toHaveProperty('available')
    expect(typeof stock.quantity).toBe('number')
    expect(typeof stock.available).toBe('number')
    expect(stock.quantity).toBeGreaterThan(0)
    // available = quantity - reserved (may vary across test runs due to checkouts)
    expect(stock.available).toBeGreaterThanOrEqual(0)
  })

})
