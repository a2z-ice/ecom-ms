/**
 * Auth setup — logs in as user1 via Keycloak PKCE flow,
 * saves browser storage state + sessionStorage so subsequent tests reuse the session.
 *
 * Tokens are stored in sessionStorage (never localStorage). Playwright's
 * built-in storageState does not capture sessionStorage, so we save it
 * separately to fixtures/user1-session.json for injection via addInitScript.
 *
 * The storage state files are gitignored (contain session tokens).
 */
import { test as setup, expect } from '@playwright/test'
import * as fs from 'fs'

const KEYCLOAK_URL = 'http://idp.keycloak.net:30000/realms/bookstore'
const USER1_USERNAME = process.env.USER1_USERNAME ?? 'user1'
const USER1_PASSWORD = process.env.USER1_PASSWORD ?? 'CHANGE_ME'

setup('authenticate as user1', async ({ page }) => {
  // ── Step 1: Navigate to UI ───────────────────────────────────────────────
  await page.goto('http://localhost:30000/')
  await page.screenshot({ path: 'screenshots/auth-setup-01-homepage.png', fullPage: true })

  // ── Step 2: Click login → Keycloak redirects ─────────────────────────────
  await page.getByRole('button', { name: 'Login', exact: true }).click()

  // ── Step 3: Keycloak login form ──────────────────────────────────────────
  await page.waitForURL(`${KEYCLOAK_URL}/protocol/openid-connect/**`)
  await page.screenshot({ path: 'screenshots/auth-setup-02-keycloak-login.png', fullPage: true })

  await page.getByLabel('Username').fill(USER1_USERNAME)
  await page.locator('#password').fill(USER1_PASSWORD)
  await page.screenshot({ path: 'screenshots/auth-setup-03-credentials-filled.png', fullPage: true })

  // ── Step 4: Sign in ───────────────────────────────────────────────────────
  await page.getByRole('button', { name: /sign in/i }).click()

  // Should be back on the UI with Logout button visible
  await page.waitForURL('http://localhost:30000/**')
  await expect(page.getByRole('button', { name: /logout/i })).toBeVisible()
  await page.screenshot({ path: 'screenshots/auth-setup-04-logged-in.png', fullPage: true })

  // Verify tokens are NOT in localStorage
  const localStorageKeys = await page.evaluate(() => Object.keys(localStorage))
  expect(localStorageKeys.filter(k => k.toLowerCase().includes('token'))).toHaveLength(0)

  // Save Keycloak cookies to user1.json (for SSO session restoration)
  await page.context().storageState({ path: 'fixtures/user1.json' })

  // Save sessionStorage (contains OIDC tokens) separately for addInitScript injection
  const sessionData = await page.evaluate(() => {
    const data: Record<string, string> = {}
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (key) data[key] = sessionStorage.getItem(key) ?? ''
    }
    return data
  })
  fs.writeFileSync('fixtures/user1-session.json', JSON.stringify(sessionData, null, 2))
})
