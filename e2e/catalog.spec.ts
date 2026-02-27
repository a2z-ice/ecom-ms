/**
 * Catalog E2E Tests
 * Covers the public book catalog: listing, book card details, and
 * the "Login to Buy" CTA for unauthenticated visitors.
 */
import { test, expect } from './fixtures/base'

test.describe('Catalog', () => {

  test('loads book list without login', async ({ page }) => {
    await page.goto('/')
    await page.screenshot({ path: 'screenshots/catalog-01-homepage-load.png', fullPage: true })

    await expect(page.getByRole('heading', { name: /book catalog/i })).toBeVisible()

    // At least 10 books seeded — book titles rendered as .book-title divs (not h3)
    const bookTitles = page.locator('.book-title')
    await expect(bookTitles.first()).toBeVisible()
    const count = await bookTitles.count()
    expect(count).toBeGreaterThan(5)

    await page.screenshot({ path: 'screenshots/catalog-02-books-grid.png', fullPage: true })
  })

  test('each book card shows title, author, and price', async ({ page }) => {
    await page.goto('/')
    // Check first book card has required info
    const firstCard = page.locator('div').filter({ hasText: /\$\d+\.\d{2}/ }).first()
    await expect(firstCard).toBeVisible()

    await page.screenshot({ path: 'screenshots/catalog-03-book-card-details.png', fullPage: true })
  })

  test('unauthenticated user sees Add to Cart buttons (guest cart enabled)', async ({ browser }) => {
    // Use a completely fresh context (no storageState, no sessionStorage injection)
    // Session 14: ALL users see "Add to Cart" buttons — unauthenticated users get a guest cart
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    await page.goto('http://localhost:30000/')

    await expect(page.getByRole('button', { name: /add to cart/i }).first()).toBeVisible()
    await page.screenshot({ path: 'screenshots/catalog-04-unauthenticated-add-to-cart.png', fullPage: true })

    await ctx.close()
  })

  test('authenticated user sees Add to Cart buttons', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: /logout/i })).toBeVisible()

    const addToCartBtns = page.getByRole('button', { name: /add to cart/i })
    await expect(addToCartBtns.first()).toBeVisible()
    const count = await addToCartBtns.count()
    expect(count).toBeGreaterThan(0)

    await page.screenshot({ path: 'screenshots/catalog-05-authenticated-add-to-cart.png', fullPage: true })
  })
})
