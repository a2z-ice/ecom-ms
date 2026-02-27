import { test, expect } from '@playwright/test'

const BASE_URL = 'http://myecom.net:30000'
// OIDC (PKCE) uses Web Crypto API which requires a secure context.
// http://myecom.net:30000 is plain HTTP — not a secure context — so crypto.subtle
// is unavailable there. Use localhost:30000 for tests that trigger signinRedirect().
// localhost is always treated as a secure context by browsers.
const OIDC_BASE = 'http://localhost:30000'
const KC_URL    = 'http://idp.keycloak.net:30000'

// All tests run WITHOUT pre-authenticated storage state — they start as guests.
// (No test.use({ storageState }) here)

test.describe('Guest Cart Flow', () => {

  test('guest can add items to cart without logging in', async ({ browser }) => {
    const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    await page.goto(BASE_URL)

    // All "Add to Cart" buttons should be visible (no "Login to Buy")
    const addBtns = page.getByRole('button', { name: /add to cart/i })
    await expect(addBtns.first()).toBeVisible()
    await page.screenshot({ path: 'screenshots/guest-cart-01-catalog-unauthenticated.png', fullPage: true })

    // Add two distinct books
    await addBtns.first().click()
    await expect(page.locator('.toast')).toBeVisible()
    await page.screenshot({ path: 'screenshots/guest-cart-02-toast-after-add.png', fullPage: true })
    await page.waitForTimeout(300)

    await addBtns.nth(1).click()
    await page.waitForTimeout(300)

    // Navigate to /cart — should see guest cart rows
    await page.goto(`${BASE_URL}/cart`)
    await expect(page.locator('tbody tr')).toHaveCount(2)
    await page.screenshot({ path: 'screenshots/guest-cart-03-guest-cart-page.png', fullPage: true })

    await ctx.close()
  })

  test('checkout button redirects unauthenticated guest to Keycloak', async ({ browser }) => {
    const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()

    // Use localhost (secure context) so crypto.subtle / PKCE is available for OIDC redirect.
    // Pre-populate guest cart via localStorage
    await page.goto(OIDC_BASE)
    await page.evaluate(() => {
      localStorage.setItem('bookstore_guest_cart', JSON.stringify([
        { bookId: 'test-book-1', title: 'Test Book', price: 9.99, quantity: 1 },
      ]))
    })

    await page.goto(`${OIDC_BASE}/cart`)
    const loginBtn = page.getByRole('button', { name: /login to checkout/i })
    await expect(loginBtn).toBeVisible()
    await page.screenshot({ path: 'screenshots/guest-cart-04-login-to-checkout.png', fullPage: true })

    await loginBtn.click()
    // signinRedirect() is async (fetches OIDC metadata first) — allow up to 20s
    await page.waitForURL(/idp\.keycloak\.net/, { timeout: 20000 })
    await page.screenshot({ path: 'screenshots/guest-cart-05-redirected-to-keycloak.png', fullPage: true })

    await ctx.close()
  })

  test('after login, guest cart items are preserved in authenticated cart', async ({ browser }) => {
    const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    // Use localhost (secure context) so crypto.subtle / PKCE is available for OIDC redirect.
    await page.goto(OIDC_BASE)

    // Add one book as guest
    const addBtns = page.getByRole('button', { name: /add to cart/i })
    await expect(addBtns.first()).toBeVisible()
    await addBtns.first().click()
    await page.waitForTimeout(300)

    // Navigate to cart and click "Login to Checkout"
    await page.goto(`${OIDC_BASE}/cart`)
    await expect(page.locator('tbody tr')).toHaveCount(1)
    await page.getByRole('button', { name: /login to checkout/i }).click()

    // Keycloak may auto-login (SSO) or show login form.
    // With SSO the browser passes through idp.keycloak.net too fast for waitForURL to detect it.
    // Use a short timeout to check — if login form is shown, fill credentials; otherwise skip.
    const needsLogin = await page.waitForURL(`${KC_URL}/**`, { timeout: 5000 }).then(() => true).catch(() => false)
    if (needsLogin) {
      await page.getByLabel('Username').fill('user1')
      await page.locator('#password').fill('CHANGE_ME')
      await page.getByRole('button', { name: /sign in/i }).click()
    }

    // CallbackPage syncs guest cart items to server then navigates to /cart.
    // OIDC redirect_uri is http://localhost:30000/callback (baked at build time).
    await page.waitForURL(/\/cart$/, { timeout: 30000 })
    await expect(page.getByRole('heading', { name: /your cart/i })).toBeVisible()

    // Guest cart item should be synced — at least 1 item present in the authenticated cart
    const rowCount = await page.locator('tbody tr').count()
    expect(rowCount).toBeGreaterThanOrEqual(1)
    await page.screenshot({ path: 'screenshots/guest-cart-06-cart-after-login.png', fullPage: true })

    // Proceed to checkout
    await page.getByRole('button', { name: /^checkout$/i }).click()
    await expect(page).toHaveURL(/order-confirmation/)
    await page.screenshot({ path: 'screenshots/guest-cart-07-order-confirmed.png', fullPage: true })

    await ctx.close()
  })

  test('cart badge in navbar shows item count for guests', async ({ browser }) => {
    const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    await page.goto(BASE_URL)

    const addBtns = page.getByRole('button', { name: /add to cart/i })
    await expect(addBtns.first()).toBeVisible()

    // Add first item — badge should appear with count 1
    await addBtns.first().click()
    await page.waitForTimeout(600) // allow interval poll to update badge
    await expect(page.locator('.nav-cart-count')).toHaveText('1')
    await page.screenshot({ path: 'screenshots/guest-cart-08-cart-badge.png', fullPage: true })

    await ctx.close()
  })

})
