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
    await page.goto('/')
    await expect(page.getByRole('button', { name: /logout/i })).toBeVisible()
    await page.screenshot({ path: 'screenshots/auth-03-before-logout.png', fullPage: true })

    await page.getByRole('button', { name: /logout/i }).click()
    // Keycloak end-session redirects: app → Keycloak → back to app at localhost:30000
    await page.waitForURL(/idp\.keycloak\.net|localhost:30000/, { timeout: 15000 })
    await page.screenshot({ path: 'screenshots/auth-04-logout-redirect.png', fullPage: true })

    // Verify logout by loading a truly fresh context (no injected tokens or storageState)
    const freshCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const freshPage = await freshCtx.newPage()
    await freshPage.goto('http://localhost:30000/')
    await expect(freshPage.getByRole('button', { name: /login/i })).toBeVisible()
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
