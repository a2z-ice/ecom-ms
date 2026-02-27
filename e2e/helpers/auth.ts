/**
 * Auth helpers for Playwright e2e tests.
 *
 * Because tokens are stored in memory (InMemoryWebStorage), they are lost
 * on every page navigation. Tests that need an authenticated user must call
 * ensureAuthenticated(), which triggers the OIDC redirect flow using the
 * Keycloak session cookies stored in the browser context's storageState.
 *
 * The top-level navigation to Keycloak sends the SameSite=Lax cookies, so
 * Keycloak sees the active session and auto-redirects back without showing
 * the login form. This is the only approach that works over HTTP.
 */
import { type Page } from '@playwright/test'

const BASE_URL = 'http://localhost:30000'

export async function ensureAuthenticated(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/`)

  // If not already authenticated, trigger OIDC redirect
  const loginBtn = page.getByRole('button', { name: /^login$/i })
  const isLoggedOut = await loginBtn.isVisible({ timeout: 3000 }).catch(() => false)

  if (isLoggedOut) {
    await loginBtn.click()
    // Keycloak sees the session cookie (top-level nav → SameSite=Lax allowed)
    // and auto-redirects to callback without showing the login form.
    await page.waitForURL(/localhost:30000\/(?!callback)/, { timeout: 20000 })
  }

  // Confirm we're authenticated
  await page.getByRole('button', { name: /logout/i }).waitFor({ timeout: 10000 })
}
