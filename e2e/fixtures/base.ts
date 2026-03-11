/**
 * Custom Playwright base fixture that:
 *   1. Restores OIDC sessionStorage entries before every page navigation
 *   2. Clears the server-side cart before every test (prevents cross-test state pollution)
 *
 * Cart clearing uses direct DB access via kubectl exec to avoid rate limiting.
 *
 * auth.setup.ts saves sessionStorage entries to fixtures/user1-session.json
 * after the initial login.
 */
import { test as base } from '@playwright/test'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const SESSION_FILE = path.join(__dirname, 'user1-session.json')

/** Clear all cart items directly in ecom-db (avoids API rate limits) */
function clearCartViaDb(): void {
  try {
    execFileSync('kubectl', [
      'exec', '-n', 'ecom', 'deploy/ecom-db', '--',
      'psql', '-U', 'ecomuser', '-d', 'ecomdb',
      '-c', 'DELETE FROM cart_items;',
    ], { encoding: 'utf-8', timeout: 10_000 })
  } catch {
    // Best-effort — don't fail the test if kubectl isn't available
  }
}

export const test = base.extend<{ authedPage: void }>({
  page: async ({ page }, use) => {
    // ── 1. Inject OIDC session tokens ──────────────────────────────────────
    if (fs.existsSync(SESSION_FILE)) {
      const sessionData: Record<string, string> = JSON.parse(
        fs.readFileSync(SESSION_FILE, 'utf-8'),
      )
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

    // ── 2. Clear cart via DB (prevents cross-test state pollution) ─────────
    clearCartViaDb()

    await use(page)
  },
})

export { expect } from '@playwright/test'
