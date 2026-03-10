/**
 * Cert Dashboard — Screenshot Capture
 *
 * Takes screenshots of all cert-dashboard operator views:
 * full page, cert cards, progress bars, renew modal, SSE streaming, API endpoints.
 */
import { test, expect } from '@playwright/test'

const DASHBOARD_URL = 'http://localhost:32600'
const SCREENSHOTS = 'screenshots/cert-dashboard'

function dashboardAvailable(): boolean {
  try {
    const { execFileSync } = require('child_process')
    const pods = execFileSync('kubectl', [
      'get', 'pods', '-n', 'cert-dashboard',
      '-l', 'app=cert-dashboard',
      '--field-selector=status.phase=Running',
      '-o', 'jsonpath={.items[*].metadata.name}',
    ], { encoding: 'utf-8', timeout: 30_000 }).trim()
    return pods.length > 0
  } catch {
    return false
  }
}

test.describe('Cert Dashboard Screenshots', () => {
  test.beforeEach(() => {
    test.skip(!dashboardAvailable(), 'Dashboard not deployed')
  })

  test('Capture all dashboard screenshots', async ({ page, context }) => {
    test.setTimeout(120000)

    // 1. Full page dashboard
    await page.goto(DASHBOARD_URL)
    await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 10000 })
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${SCREENSHOTS}/cert-dashboard-01-full-page.png`, fullPage: true })

    // 2. CA certificate card (use ID selector to avoid matching gateway card which contains "bookstore-ca-issuer")
    const caCard = page.locator('#card-cert-manager-bookstore-ca')
    await caCard.screenshot({ path: `${SCREENSHOTS}/cert-dashboard-02-ca-cert-card.png` })

    // 3. Gateway certificate card
    const gwCard = page.locator('#card-infra-bookstore-gateway-cert')
    await gwCard.screenshot({ path: `${SCREENSHOTS}/cert-dashboard-03-gateway-cert-card.png` })

    // 4. Progress bar (green)
    const progressSection = gwCard.locator('.progress-section')
    await progressSection.screenshot({ path: `${SCREENSHOTS}/cert-dashboard-04-progress-bar-green.png` })

    // 5. Click Renew → Modal appears
    await gwCard.locator('.btn-renew').click()
    await expect(page.locator('#renew-modal')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/cert-dashboard-05-renew-modal.png` })

    // 6. Modal close-up
    await page.locator('dialog').screenshot({ path: `${SCREENSHOTS}/cert-dashboard-06-modal-closeup.png` })

    // 7. Confirm renewal → SSE starts
    await page.locator('#modal-confirm').click()
    await expect(page.locator('#renew-modal')).not.toBeVisible()
    const ssePanel = gwCard.locator('.sse-panel')
    await expect(ssePanel).toHaveClass(/active/, { timeout: 5000 })
    await page.waitForTimeout(1000)
    await page.screenshot({ path: `${SCREENSHOTS}/cert-dashboard-07-sse-in-progress.png`, fullPage: true })

    // 8. Wait for renewal complete
    await expect(ssePanel.locator('.phase-ready').first()).toBeVisible({ timeout: 60000 })
    await page.waitForTimeout(500)
    await ssePanel.screenshot({ path: `${SCREENSHOTS}/cert-dashboard-08-sse-complete.png` })

    // 9. Full page after renewal (with SSE panel visible)
    await page.screenshot({ path: `${SCREENSHOTS}/cert-dashboard-09-after-renewal.png`, fullPage: true })

    // 10. Wait for auto-refresh and capture refreshed state
    await page.waitForTimeout(12000)
    await page.screenshot({ path: `${SCREENSHOTS}/cert-dashboard-10-refreshed-after-renewal.png`, fullPage: true })

    // 11. Health endpoint
    const healthPage = await context.newPage()
    await healthPage.goto(`${DASHBOARD_URL}/healthz`)
    await healthPage.screenshot({ path: `${SCREENSHOTS}/cert-dashboard-11-healthz.png` })
    await healthPage.close()

    // 12. API certs endpoint
    const apiPage = await context.newPage()
    await apiPage.goto(`${DASHBOARD_URL}/api/certs`)
    await apiPage.screenshot({ path: `${SCREENSHOTS}/cert-dashboard-12-api-certs.png` })
    await apiPage.close()
  })
})
