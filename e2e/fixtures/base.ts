/**
 * Custom Playwright base fixture that restores OIDC sessionStorage entries
 * before every page navigation.
 *
 * Because OIDC tokens are stored in sessionStorage (cleared on tab close, never
 * in localStorage), we need to inject them via addInitScript so that every
 * page.goto() starts with the correct auth state without re-running the OIDC flow.
 *
 * auth.setup.ts saves sessionStorage entries to fixtures/user1-session.json
 * after the initial login.
 */
import { test as base } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

const SESSION_FILE = path.join(__dirname, 'user1-session.json')

export const test = base.extend<{ authedPage: void }>({
  page: async ({ page }, use) => {
    if (fs.existsSync(SESSION_FILE)) {
      const sessionData: Record<string, string> = JSON.parse(
        fs.readFileSync(SESSION_FILE, 'utf-8'),
      )
      // Inject sessionStorage entries before every navigation in this context
      await page.addInitScript((data: Record<string, string>) => {
        for (const [key, value] of Object.entries(data)) {
          try {
            sessionStorage.setItem(key, value)
          } catch {
            // ignore quota / security errors
          }
        }
      }, sessionData)
    }
    await use(page)
  },
})

export { expect } from '@playwright/test'
