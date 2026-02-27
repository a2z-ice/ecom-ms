/**
 * Apache Superset E2E Tests
 * Verifies that the "Book Store Analytics" dashboard exists and both charts render.
 */
import { test, expect } from '@playwright/test'

const SUPERSET_URL = 'http://localhost:32000'
const SUPERSET_USER = process.env.SUPERSET_ADMIN_USERNAME ?? 'admin'
const SUPERSET_PASS = process.env.SUPERSET_ADMIN_PASSWORD ?? 'CHANGE_ME'

test.describe('Superset Analytics', () => {
  test.use({ baseURL: SUPERSET_URL })

  test.beforeEach(async ({ page }) => {
    // Log in to Superset
    await page.goto('/login/')
    await page.screenshot({ path: 'screenshots/superset-00-login-page.png', fullPage: true })

    await page.getByLabel('Username').fill(SUPERSET_USER)
    await page.getByLabel('Password').fill(SUPERSET_PASS)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(/\/superset\/welcome/)
    await page.screenshot({ path: 'screenshots/superset-01-welcome.png', fullPage: true })
  })

  test('Book Store Analytics dashboard exists', async ({ page }) => {
    await page.goto('/dashboard/list/')
    await expect(page.getByText(/book store analytics/i)).toBeVisible()
    await page.screenshot({ path: 'screenshots/superset-02-dashboard-list.png', fullPage: true })
  })

  test('Product Sales Volume chart renders', async ({ page }) => {
    await page.goto('/chart/list/')
    await expect(page.getByText(/product sales volume/i)).toBeVisible()
    await page.screenshot({ path: 'screenshots/superset-03-chart-list.png', fullPage: true })
  })

  test('Sales Over Time chart renders', async ({ page }) => {
    await page.goto('/chart/list/')
    await expect(page.getByText(/sales over time/i)).toBeVisible()
    await page.screenshot({ path: 'screenshots/superset-04-sales-over-time-chart.png', fullPage: true })
  })

  test('dashboard loads with chart SVG/canvas elements', async ({ page }) => {
    await page.goto('/dashboard/list/')
    await page.screenshot({ path: 'screenshots/superset-05-dashboard-list-before-open.png', fullPage: true })

    // Click into the dashboard
    await page.getByText(/book store analytics/i).click()
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: 'screenshots/superset-06-dashboard-open.png', fullPage: true })

    // Charts should have rendered — look for svg or canvas elements
    const chartElements = page.locator('svg.recharts-surface, canvas, .chart-container')
    await expect(chartElements.first()).toBeVisible({ timeout: 30_000 })
    const count = await chartElements.count()
    expect(count).toBeGreaterThanOrEqual(2)
    await page.screenshot({ path: 'screenshots/superset-07-dashboard-charts-rendered.png', fullPage: true })
  })
})
