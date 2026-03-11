/**
 * Admin Playwright base fixture — injects admin1 OIDC sessionStorage tokens
 * before every page navigation in admin tests.
 */
import { test as base } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

const SESSION_FILE = path.join(__dirname, 'admin1-session.json')

export const test = base.extend<{ authedAdminPage: void }>({
  page: async ({ page }, use) => {
    if (fs.existsSync(SESSION_FILE)) {
      const sessionData: Record<string, string> = JSON.parse(
        fs.readFileSync(SESSION_FILE, 'utf-8'),
      )
      await page.addInitScript((data: Record<string, string>) => {
        for (const [key, value] of Object.entries(data)) {
          try {
            sessionStorage.setItem(key, value)
          } catch {
            // ignore
          }
        }
      }, sessionData)
    }
    await use(page)
  },
})

export { expect } from '@playwright/test'
