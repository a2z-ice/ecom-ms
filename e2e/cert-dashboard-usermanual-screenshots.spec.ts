/**
 * Cert Dashboard — Extra Screenshots for User Manual
 */
import { test, expect } from '@playwright/test'

const DASHBOARD_URL = 'http://localhost:32600'
const DIR = 'screenshots/cert-dashboard'

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

test.describe('User Manual Screenshots', () => {
  test.beforeEach(() => {
    test.skip(!dashboardAvailable(), 'Dashboard not deployed')
  })

  test('Capture extra screenshots', async ({ page }) => {
    test.setTimeout(30000)
    await page.goto(DASHBOARD_URL)
    await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 10000 })
    await page.waitForTimeout(500)

    // Header area
    await page.locator('header').screenshot({ path: `${DIR}/cert-dashboard-um-header.png` })

    // Footer area
    await page.locator('footer').screenshot({ path: `${DIR}/cert-dashboard-um-footer.png` })

    // CA badge close-up (header row of CA card)
    const caHeader = page.locator('#card-cert-manager-bookstore-ca .cert-header')
    await caHeader.screenshot({ path: `${DIR}/cert-dashboard-um-ca-badge.png` })

    // Ready indicator close-up
    const readyBadge = page.locator('#card-infra-bookstore-gateway-cert .cert-ready')
    await readyBadge.screenshot({ path: `${DIR}/cert-dashboard-um-ready-indicator.png` })

    // Details grid of gateway cert
    const details = page.locator('#card-infra-bookstore-gateway-cert .cert-details')
    await details.screenshot({ path: `${DIR}/cert-dashboard-um-details-grid.png` })

    // Renew button close-up
    const renewBtn = page.locator('#card-infra-bookstore-gateway-cert .btn-renew')
    await renewBtn.screenshot({ path: `${DIR}/cert-dashboard-um-renew-button.png` })

    // Full gateway card with everything visible
    const gwCard = page.locator('#card-infra-bookstore-gateway-cert')
    await gwCard.screenshot({ path: `${DIR}/cert-dashboard-um-gateway-card-full.png` })

    // CA card full
    const caCard = page.locator('#card-cert-manager-bookstore-ca')
    await caCard.screenshot({ path: `${DIR}/cert-dashboard-um-ca-card-full.png` })
  })
})
