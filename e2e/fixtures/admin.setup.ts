/**
 * Admin auth setup — logs in as admin1 via Keycloak PKCE flow,
 * saves browser storage state + sessionStorage so admin tests reuse the session.
 *
 * admin1 has both 'customer' and 'admin' Keycloak realm roles.
 */
import { test as setup, expect } from '@playwright/test'
import * as fs from 'fs'

const KEYCLOAK_URL = 'http://idp.keycloak.net:30000/realms/bookstore'
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? 'admin1'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'CHANGE_ME'

setup('authenticate as admin1', async ({ page }) => {
  await page.goto('http://localhost:30000/')

  await page.getByRole('button', { name: 'Login', exact: true }).click()

  await page.waitForURL(`${KEYCLOAK_URL}/protocol/openid-connect/**`)

  await page.getByLabel('Username').fill(ADMIN_USERNAME)
  await page.locator('#password').fill(ADMIN_PASSWORD)

  await page.getByRole('button', { name: /sign in/i }).click()

  await page.waitForURL('http://localhost:30000/**')
  await expect(page.getByRole('button', { name: /logout/i })).toBeVisible()

  // Verify Admin link visible in navbar (admin role present)
  await expect(page.getByRole('link', { name: /admin/i })).toBeVisible()

  await page.screenshot({ path: 'screenshots/admin-setup-logged-in.png', fullPage: true })

  // Save storage state (cookies)
  await page.context().storageState({ path: 'fixtures/admin1.json' })

  // Save sessionStorage (OIDC tokens)
  const sessionData = await page.evaluate(() => {
    const data: Record<string, string> = {}
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (key) data[key] = sessionStorage.getItem(key) ?? ''
    }
    return data
  })
  fs.writeFileSync('fixtures/admin1-session.json', JSON.stringify(sessionData, null, 2))
})
