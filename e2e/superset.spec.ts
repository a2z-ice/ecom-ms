/**
 * Apache Superset E2E Tests
 *
 * Verifies all 3 dashboards and 14 charts created by the bootstrap script.
 *
 * Dashboards:
 *   1. "Book Store Analytics"      — Product Sales Volume, Sales Over Time,
 *                                    Revenue by Author, Top Books by Revenue,
 *                                    Book Price Distribution
 *   2. "Sales & Revenue Analytics" — Total Revenue KPI, Total Orders KPI,
 *                                    Average Order Value KPI,
 *                                    Order Status Distribution,
 *                                    Avg Order Value Over Time
 *   3. "Inventory Analytics"       — Inventory Health Table, Stock vs Reserved,
 *                                    Inventory Turnover Rate, Revenue by Genre
 */
import { test, expect } from '@playwright/test'

const SUPERSET_URL  = 'http://localhost:32000'
const SUPERSET_USER = process.env.SUPERSET_ADMIN_USERNAME ?? 'admin'
const SUPERSET_PASS = process.env.SUPERSET_ADMIN_PASSWORD ?? 'CHANGE_ME'

// All expected chart names (16 total — 14 original + 2 new inventory pie charts)
const ALL_CHARTS = [
  'Product Sales Volume',
  'Sales Over Time',
  'Revenue by Author',
  'Top Books by Revenue',
  'Book Price Distribution',
  'Total Revenue KPI',
  'Total Orders KPI',
  'Average Order Value KPI',
  'Order Status Distribution',
  'Avg Order Value Over Time',
  'Inventory Health Table',
  'Stock vs Reserved',
  'Inventory Turnover Rate',
  'Revenue by Genre',
  'Stock Status Distribution',
  'Revenue Share by Genre',
]

// All expected dashboard names (3 total)
const ALL_DASHBOARDS = [
  'Book Store Analytics',
  'Sales & Revenue Analytics',
  'Inventory Analytics',
]

// All expected dataset/view names (10 total)
const ALL_DATASETS = [
  'vw_product_sales_volume',
  'vw_sales_over_time',
  'vw_revenue_by_author',
  'vw_revenue_by_genre',
  'vw_order_status_distribution',
  'vw_inventory_health',
  'vw_avg_order_value',
  'vw_top_books_by_revenue',
  'vw_inventory_turnover',
  'vw_book_price_distribution',
]

test.describe('Superset Analytics', () => {
  test.use({ baseURL: SUPERSET_URL })

  test.beforeEach(async ({ page }) => {
    await page.goto('/login/')
    await page.screenshot({ path: 'screenshots/superset-00-login-page.png', fullPage: true })
    await page.getByLabel('Username').fill(SUPERSET_USER)
    await page.getByLabel('Password').fill(SUPERSET_PASS)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(/\/superset\/welcome/)
    await page.screenshot({ path: 'screenshots/superset-01-welcome.png', fullPage: true })
  })

  // ── API: verify via Superset REST API (no UI flakiness) ──────────────────

  test('Superset API: all 3 dashboards exist', async ({ page, request }) => {
    // Login via API to get token
    const loginResp = await request.post(`${SUPERSET_URL}/api/v1/security/login`, {
      data: { username: SUPERSET_USER, password: SUPERSET_PASS, provider: 'db', refresh: true },
    })
    expect(loginResp.ok()).toBeTruthy()
    const token = (await loginResp.json()).access_token

    const dashResp = await request.get(`${SUPERSET_URL}/api/v1/dashboard/`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(dashResp.ok()).toBeTruthy()
    const dashboards: string[] = (await dashResp.json()).result.map(
      (d: { dashboard_title: string }) => d.dashboard_title
    )

    for (const name of ALL_DASHBOARDS) {
      expect(dashboards, `Missing dashboard: ${name}`).toContain(name)
    }
    await page.screenshot({ path: 'screenshots/superset-02-api-dashboards.png' })
  })

  test('Superset API: all 16 charts exist', async ({ page, request }) => {
    const loginResp = await request.post(`${SUPERSET_URL}/api/v1/security/login`, {
      data: { username: SUPERSET_USER, password: SUPERSET_PASS, provider: 'db', refresh: true },
    })
    const token = (await loginResp.json()).access_token

    const chartsResp = await request.get(`${SUPERSET_URL}/api/v1/chart/`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(chartsResp.ok()).toBeTruthy()
    const charts: string[] = (await chartsResp.json()).result.map(
      (c: { slice_name: string }) => c.slice_name
    )

    for (const name of ALL_CHARTS) {
      expect(charts, `Missing chart: ${name}`).toContain(name)
    }
    await page.screenshot({ path: 'screenshots/superset-03-api-charts.png' })
  })

  test('Superset API: all 10 datasets exist', async ({ page, request }) => {
    const loginResp = await request.post(`${SUPERSET_URL}/api/v1/security/login`, {
      data: { username: SUPERSET_USER, password: SUPERSET_PASS, provider: 'db', refresh: true },
    })
    const token = (await loginResp.json()).access_token

    const dsResp = await request.get(`${SUPERSET_URL}/api/v1/dataset/`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(dsResp.ok()).toBeTruthy()
    const datasets: string[] = (await dsResp.json()).result.map(
      (d: { table_name: string }) => d.table_name
    )

    for (const name of ALL_DATASETS) {
      expect(datasets, `Missing dataset: ${name}`).toContain(name)
    }
    await page.screenshot({ path: 'screenshots/superset-04-api-datasets.png' })
  })

  // ── UI: Dashboard list page ───────────────────────────────────────────────

  test('UI: dashboard list shows all 3 dashboards', async ({ page }) => {
    await page.goto('/dashboard/list/')
    await page.screenshot({ path: 'screenshots/superset-05-dashboard-list.png', fullPage: true })

    for (const name of ALL_DASHBOARDS) {
      await expect(page.getByText(new RegExp(name.replace(/[()]/g, '\\$&'), 'i')),
        `Dashboard '${name}' not visible in list`).toBeVisible()
    }
    await page.screenshot({ path: 'screenshots/superset-06-all-dashboards-visible.png', fullPage: true })
  })

  // ── UI: Chart list page ───────────────────────────────────────────────────

  test('UI: chart list shows all 16 charts', async ({ page }) => {
    await page.goto('/chart/list/')
    await page.screenshot({ path: 'screenshots/superset-07-chart-list.png', fullPage: true })

    for (const name of ALL_CHARTS) {
      await expect(page.getByText(new RegExp(name.replace(/[()]/g, '\\$&'), 'i')),
        `Chart '${name}' not visible in chart list`).toBeVisible()
    }
    await page.screenshot({ path: 'screenshots/superset-08-all-charts-visible.png', fullPage: true })
  })

  // ── UI: Dashboard 1 — Book Store Analytics ───────────────────────────────

  test('Dashboard: "Book Store Analytics" opens and renders charts', async ({ page }) => {
    await page.goto('/dashboard/list/')
    await page.getByText(/book store analytics/i).first().click()
    await page.waitForLoadState('load')
    await page.screenshot({ path: 'screenshots/superset-09-bookstore-dashboard.png', fullPage: true })

    const charts = page.locator('.chart-container, canvas, svg.recharts-surface')
    await expect(charts.first()).toBeVisible({ timeout: 30_000 })
    const count = await charts.count()
    expect(count, 'Book Store Analytics should have ≥2 chart containers').toBeGreaterThanOrEqual(2)
    await page.screenshot({ path: 'screenshots/superset-10-bookstore-charts-rendered.png', fullPage: true })
  })

  // ── UI: Dashboard 2 — Sales & Revenue Analytics ──────────────────────────

  test('Dashboard: "Sales & Revenue Analytics" exists and opens', async ({ page }) => {
    await page.goto('/dashboard/list/')
    await expect(page.getByText(/sales & revenue analytics/i)).toBeVisible()
    await page.getByText(/sales & revenue analytics/i).first().click()
    await page.waitForLoadState('load')
    await page.screenshot({ path: 'screenshots/superset-11-revenue-dashboard.png', fullPage: true })

    // No error alerts should appear
    const errorAlert = page.locator('[data-test="error-alert"], .ant-notification-notice-error')
    expect(await errorAlert.count()).toBe(0)
    await page.screenshot({ path: 'screenshots/superset-12-revenue-dashboard-no-errors.png', fullPage: true })
  })

  // ── UI: Dashboard 3 — Inventory Analytics ────────────────────────────────

  test('Dashboard: "Inventory Analytics" exists and opens', async ({ page }) => {
    await page.goto('/dashboard/list/')
    await expect(page.getByText(/inventory analytics/i)).toBeVisible()
    await page.getByText(/inventory analytics/i).first().click()
    await page.waitForLoadState('load')
    await page.screenshot({ path: 'screenshots/superset-13-inventory-dashboard.png', fullPage: true })

    const charts = page.locator('.chart-container, canvas, svg')
    await expect(charts.first()).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: 'screenshots/superset-14-inventory-charts.png', fullPage: true })
  })

  // ── UI: All 3 dashboards render without error ─────────────────────────────

  test('All 3 dashboards render without error alerts', async ({ page }) => {
    const dashboards = [
      { name: /book store analytics/i,      screenshot: 'superset-15-dash1-no-error' },
      { name: /sales & revenue analytics/i, screenshot: 'superset-16-dash2-no-error' },
      { name: /inventory analytics/i,       screenshot: 'superset-17-dash3-no-error' },
    ]

    for (const dash of dashboards) {
      await page.goto('/dashboard/list/')
      await page.getByText(dash.name).first().click()
      await page.waitForLoadState('load')
      // Wait for chart containers to appear (Superset may never reach networkidle)
      const visuals = page.locator('.chart-container, canvas, svg')
      await expect(visuals.first()).toBeVisible({ timeout: 30_000 })
      await page.screenshot({ path: `screenshots/${dash.screenshot}.png`, fullPage: true })

      const errorAlerts = page.locator('[data-test="error-alert"], .ant-notification-notice-error')
      const errorCount = await errorAlerts.count()
      expect(errorCount, `Dashboard '${dash.name}' has unexpected error alerts`).toBe(0)
    }
    await page.screenshot({ path: 'screenshots/superset-18-all-dashboards-ok.png', fullPage: true })
  })

  // ── UI: Individual chart spot checks ─────────────────────────────────────

  test('Chart: "Product Sales Volume" bar chart is in chart list', async ({ page }) => {
    await page.goto('/chart/list/')
    await expect(page.getByText(/product sales volume/i)).toBeVisible()
    await page.screenshot({ path: 'screenshots/superset-19-product-sales-chart.png', fullPage: true })
  })

  test('Chart: "Inventory Health Table" is in chart list', async ({ page }) => {
    await page.goto('/chart/list/')
    await expect(page.getByText(/inventory health table/i)).toBeVisible()
    await page.screenshot({ path: 'screenshots/superset-20-inventory-health-chart.png', fullPage: true })
  })

  test('Chart: "Total Revenue KPI" is in chart list', async ({ page }) => {
    await page.goto('/chart/list/')
    await expect(page.getByText(/total revenue kpi/i)).toBeVisible()
    await page.screenshot({ path: 'screenshots/superset-21-revenue-kpi-chart.png', fullPage: true })
  })

  test('Chart: "Revenue by Genre" is in chart list', async ({ page }) => {
    await page.goto('/chart/list/')
    await expect(page.getByText(/revenue by genre/i)).toBeVisible()
    await page.screenshot({ path: 'screenshots/superset-22-revenue-by-genre-chart.png', fullPage: true })
  })

  test('Chart: "Stock Status Distribution" pie chart is in chart list', async ({ page }) => {
    await page.goto('/chart/list/')
    await expect(page.getByText(/stock status distribution/i)).toBeVisible()
    await page.screenshot({ path: 'screenshots/superset-23-stock-status-chart.png', fullPage: true })
  })

  test('Chart: "Revenue Share by Genre" pie chart is in chart list', async ({ page }) => {
    await page.goto('/chart/list/')
    await expect(page.getByText(/revenue share by genre/i)).toBeVisible()
    await page.screenshot({ path: 'screenshots/superset-24-revenue-share-chart.png', fullPage: true })
  })
})
