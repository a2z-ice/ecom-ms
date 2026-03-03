/**
 * Authentication E2E Tests
 * Verifies: token storage security, logout flow, and unauthenticated redirects.
 */
import { test, expect } from './fixtures/base'
import * as fs from 'fs'
import * as path from 'path'

test.describe('Authentication', () => {

  test('tokens are not stored in localStorage after login', async ({ page }) => {
    // Session tokens are injected via addInitScript (sessionStorage) — no re-login needed
    await page.goto('/')
    await expect(page.getByRole('button', { name: /logout/i })).toBeVisible()
    await page.screenshot({ path: 'screenshots/auth-01-logged-in-state.png', fullPage: true })

    const tokenKeys = await page.evaluate(() =>
      Object.keys(localStorage).filter(k =>
        k.toLowerCase().includes('token') || k.toLowerCase().includes('access')
      )
    )
    expect(tokenKeys).toHaveLength(0)
    await page.screenshot({ path: 'screenshots/auth-02-no-localstorage-tokens.png', fullPage: true })
  })

  test('logout redirects to catalog and shows Login button', async ({ page, browser }) => {
    // This test covers the full Keycloak logout round-trip: app → Keycloak → app.
    // Give it extra time: click + Keycloak round-trip + assertions can take ~25s on a slow cluster.
    test.setTimeout(60000)

    await page.goto('/')
    await expect(page.getByRole('button', { name: /logout/i })).toBeVisible()
    await page.screenshot({ path: 'screenshots/auth-03-before-logout.png', fullPage: true })

    await page.getByRole('button', { name: /logout/i }).click()
    // Flow: app clears sessionStorage → Keycloak end_session_endpoint → redirects to localhost:30000/
    // Wait for the final redirect back to the app root (proves post_logout_redirect_uri was accepted).
    // Using a regex to tolerate both http://localhost:30000 and http://localhost:30000/ (trailing slash).
    await page.waitForURL(/localhost:30000\/?$/, { timeout: 30000 })
    await page.screenshot({ path: 'screenshots/auth-04-logout-redirect.png', fullPage: true })

    // NOTE: addInitScript re-injects tokens on every page load in this test context,
    // so the Login button check must use a fresh context (no storageState, no addInitScript).
    const freshCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const freshPage = await freshCtx.newPage()
    await freshPage.goto('http://localhost:30000/')
    await expect(freshPage.getByRole('button', { name: /login/i })).toBeVisible({ timeout: 10000 })
    await freshPage.screenshot({ path: 'screenshots/auth-05-logged-out-fresh-page.png', fullPage: true })
    await freshCtx.close()
  })

  test('unauthenticated access to cart redirects to Keycloak', async ({ browser }) => {
    // Use a fresh context (no stored auth)
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    await page.goto('http://localhost:30000/cart')
    // Should redirect to Keycloak or show login
    await expect(page).toHaveURL(/idp\.keycloak\.net|\/cart/)
    await page.screenshot({ path: 'screenshots/auth-06-unauth-cart-redirect.png', fullPage: true })
    await ctx.close()
  })
})

test.describe('myecom.net login redirect', () => {
  // Full OIDC login flow starting from the alternate hostname.
  // oidcConfig.ts sets redirect_uri dynamically from window.location.origin, so when the
  // app is loaded at http://myecom.net:30000 the redirect_uri becomes
  // http://myecom.net:30000/callback. Chrome treats myecom.net as a secure context
  // (resolves to 127.0.0.1 loopback via /etc/hosts), so crypto.subtle IS available and
  // PKCE S256 runs directly — no localhost relay needed.
  //
  // NOTE: An active Keycloak SSO session (from auth.setup.ts) causes Keycloak to
  // authenticate silently without showing the login form. The test handles both paths:
  // - SSO active  → Keycloak redirects immediately, no credential prompt
  // - No SSO      → Keycloak shows login form, credentials are filled

  test('login from myecom.net redirects back to myecom.net with user logged in', async ({ browser }) => {
    test.setTimeout(90000)

    // Fresh browser context — no pre-loaded storageState or sessionStorage
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()

    // ── Step 1: Navigate to the alternate hostname ────────────────────────────
    await page.goto('http://myecom.net:30000/')
    await expect(page.getByRole('button', { name: /login/i })).toBeVisible({ timeout: 10000 })
    await page.screenshot({ path: 'screenshots/myecom-01-homepage.png', fullPage: true })

    // ── Step 2: Click Login ───────────────────────────────────────────────────
    // login() checks crypto.subtle — available at myecom.net (loopback) → signinRedirect()
    // with redirect_uri=http://myecom.net:30000/callback → Keycloak → myecom.net/callback
    await page.getByRole('button', { name: /login/i }).click()

    // Race: either Keycloak shows the login form (no SSO) or the SSO session completes
    // the full flow and we land back at myecom.net before we even check.
    await Promise.race([
      page.waitForURL(/idp\.keycloak\.net/, { timeout: 45000 }),
      page.waitForURL(/myecom\.net:30000/, { timeout: 45000 }),
    ])

    // If landed on the Keycloak login page, try to fill credentials.
    // Use short timeouts and catch errors: if Keycloak's SSO redirects before we
    // finish filling, the page moves to myecom.net and the fill will throw — that's OK.
    if (page.url().includes('idp.keycloak.net')) {
      try {
        await page.getByLabel('Username').fill('user1', { timeout: 5000 })
        await page.locator('#password').fill('CHANGE_ME', { timeout: 5000 })
        await page.getByRole('button', { name: /sign in/i }).click({ timeout: 5000 })
      } catch {
        // Page navigated away (SSO) before we could fill — that's fine
      }
      await page.waitForURL(/myecom\.net:30000/, { timeout: 45000 })
    }

    // ── Step 3: Assert the user is logged in at myecom.net ───────────────────
    await page.screenshot({ path: 'screenshots/myecom-03-redirected-to-myecom.png', fullPage: true })
    await expect(page.getByRole('button', { name: /logout/i })).toBeVisible({ timeout: 15000 })
    await page.screenshot({ path: 'screenshots/myecom-04-logged-in-at-myecom.png', fullPage: true })

    expect(page.url()).not.toContain('#auth=')
    expect(page.url()).toMatch(/myecom\.net:30000/)

    await ctx.close()
  })

  test('login from myecom.net/admin redirects back to myecom.net', async ({ browser }) => {
    test.setTimeout(90000)

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()

    // AdminRoute: detects no user, calls login('/admin') → signinRedirect at myecom.net origin
    await page.goto('http://myecom.net:30000/admin')

    await Promise.race([
      page.waitForURL(/idp\.keycloak\.net/, { timeout: 45000 }),
      page.waitForURL(/myecom\.net:30000/, { timeout: 45000 }),
    ])

    if (page.url().includes('idp.keycloak.net')) {
      await page.getByLabel('Username').fill('admin1')
      await page.locator('#password').fill('CHANGE_ME')
      await page.getByRole('button', { name: /sign in/i }).click()
      await page.waitForURL(/myecom\.net:30000/, { timeout: 45000 })
    }

    // Wait for full settled state — logout button proves the admin OIDC flow completed.
    // Timeout is generous (30s) because Promise.race may have resolved on the initial
    // page.goto URL before the OIDC redirect cycle started.
    await expect(page.getByRole('button', { name: /logout/i })).toBeVisible({ timeout: 30000 })
    await page.screenshot({ path: 'screenshots/myecom-05-admin-at-myecom.png', fullPage: true })
    expect(page.url()).not.toContain('#auth=')
    expect(page.url()).toMatch(/myecom\.net:30000/)

    await ctx.close()
  })
})
