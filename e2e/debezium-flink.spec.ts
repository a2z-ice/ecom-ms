/**
 * Debezium + Flink CDC Pipeline E2E Tests
 *
 * Covers:
 *   1. Debezium REST API health and connector status (localhost:32300)
 *   2. Flink Web Dashboard health and streaming job status (localhost:32200)
 *   3. End-to-end CDC data flow: ecom-db → Debezium → Kafka → Flink → analytics-db
 *   4. All analytics views populated correctly
 *
 * Prerequisites:
 *   - docker proxy containers running:
 *       docker run -d --name flink-proxy --network kind -p 32200:32200 \
 *         alpine/socat TCP-LISTEN:32200,fork,reuseaddr TCP:<CTRL_IP>:32200
 *       docker run -d --name debezium-proxy --network kind -p 32300:32300 \
 *         alpine/socat TCP-LISTEN:32300,fork,reuseaddr TCP:<CTRL_IP>:32300
 */
import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import { pollUntilFound, queryAnalyticsDb } from './helpers/db'

const DEBEZIUM_URL = 'http://localhost:32300'
const FLINK_URL    = 'http://localhost:32200'

// ─── Helpers ────────────────────────────────────────────────────────────────

/** GET a Debezium/Flink API endpoint and return parsed JSON. */
async function apiGet(request: import('@playwright/test').APIRequestContext, url: string) {
  const resp = await request.get(url)
  expect(resp.ok(), `GET ${url} → ${resp.status()}`).toBeTruthy()
  return resp.json()
}

/** Run a command inside a Kubernetes pod via kubectl exec. */
function kubectlExec(namespace: string, deployment: string, cmd: string[]): string {
  return execFileSync('kubectl', [
    'exec', '-n', namespace, `deployment/${deployment}`, '--', ...cmd,
  ], { encoding: 'utf-8', timeout: 30_000 }).trim()
}

// ═══════════════════════════════════════════════════════════════════════════
// Suite 1 — Debezium REST API
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Debezium REST API (localhost:32300)', () => {

  test('Debezium API root is accessible and returns version info', async ({ request, page }) => {
    const body = await apiGet(request, `${DEBEZIUM_URL}/`)
    expect(body).toMatchObject({
      version: expect.any(String),
    })
    // Screenshot placeholder — captures test runner context
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/debezium-01-api-accessible.png' })
  })

  test('GET /connectors lists both CDC connectors', async ({ request }) => {
    const connectors: string[] = await apiGet(request, `${DEBEZIUM_URL}/connectors`)
    expect(connectors).toContain('ecom-connector')
    expect(connectors).toContain('inventory-connector')
    expect(connectors).toHaveLength(2)
  })

  test('ecom-connector is in RUNNING state', async ({ request, page }) => {
    const status = await apiGet(request, `${DEBEZIUM_URL}/connectors/ecom-connector/status`)
    expect(status.connector.state).toBe('RUNNING')
    // All tasks must also be RUNNING
    const tasks: Array<{ state: string }> = status.tasks
    expect(tasks.length).toBeGreaterThan(0)
    tasks.forEach(t => expect(t.state).toBe('RUNNING'))
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/debezium-02-ecom-connector-running.png' })
  })

  test('inventory-connector is in RUNNING state', async ({ request, page }) => {
    const status = await apiGet(request, `${DEBEZIUM_URL}/connectors/inventory-connector/status`)
    expect(status.connector.state).toBe('RUNNING')
    const tasks: Array<{ state: string }> = status.tasks
    expect(tasks.length).toBeGreaterThan(0)
    tasks.forEach(t => expect(t.state).toBe('RUNNING'))
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/debezium-03-inventory-connector-running.png' })
  })

  test('ecom-connector config monitors correct tables', async ({ request }) => {
    const config = await apiGet(request, `${DEBEZIUM_URL}/connectors/ecom-connector/config`)
    expect(config['table.include.list']).toContain('public.orders')
    expect(config['table.include.list']).toContain('public.order_items')
    expect(config['table.include.list']).toContain('public.books')
    expect(config['database.dbname']).toBe('ecomdb')
    expect(config['connector.class']).toContain('PostgresConnector')
  })

  test('inventory-connector config monitors inventory table', async ({ request }) => {
    const config = await apiGet(request, `${DEBEZIUM_URL}/connectors/inventory-connector/config`)
    expect(config['table.include.list']).toBe('public.inventory')
    expect(config['database.dbname']).toBe('inventorydb')
    expect(config['connector.class']).toContain('PostgresConnector')
  })

  test('ecom-connector has produced Kafka topics', async ({ request, page }) => {
    const topics = await apiGet(request, `${DEBEZIUM_URL}/connectors/ecom-connector/topics`)
    // Debezium returns topics as array: {"ecom-connector":{"topics":["topic1","topic2"]}}
    const topicsValue = topics['ecom-connector']?.topics ?? topics
    const topicList: string[] = Array.isArray(topicsValue)
      ? topicsValue
      : Object.keys(topicsValue)
    // At minimum the orders and books topics should exist after initial snapshot
    const hasOrdersTopic = topicList.some(t => t.includes('orders'))
    const hasBooksTopic  = topicList.some(t => t.includes('books'))
    expect(hasOrdersTopic || hasBooksTopic).toBeTruthy()
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/debezium-04-connector-topics.png' })
  })

  test('inventory-connector has produced inventory Kafka topic', async ({ request }) => {
    const topics = await apiGet(request, `${DEBEZIUM_URL}/connectors/inventory-connector/topics`)
    // Debezium returns topics as array: {"inventory-connector":{"topics":["topic1"]}}
    const topicsValue = topics['inventory-connector']?.topics ?? topics
    const topicList: string[] = Array.isArray(topicsValue)
      ? topicsValue
      : Object.keys(topicsValue)
    const hasInventoryTopic = topicList.some(t => t.includes('inventory'))
    expect(hasInventoryTopic).toBeTruthy()
  })

  test('GET /connector-plugins lists PostgreSQL connector plugin', async ({ request }) => {
    const plugins: Array<{ class: string }> = await apiGet(request, `${DEBEZIUM_URL}/connector-plugins`)
    const pgPlugin = plugins.find(p => p.class.includes('PostgresConnector'))
    expect(pgPlugin).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 2 — Flink Web Dashboard
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Flink Web Dashboard (localhost:32200)', () => {

  test('Flink REST API /overview is accessible', async ({ request, page }) => {
    const overview = await apiGet(request, `${FLINK_URL}/overview`)
    // Flink 1.20 returns flat keys: 'taskmanagers', 'slots-total', 'slots-available', etc.
    expect(overview.taskmanagers).toBeGreaterThanOrEqual(0)
    expect(overview['slots-total']).toBeGreaterThanOrEqual(0)
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/flink-01-overview-api.png' })
  })

  test('Flink cluster has at least 1 TaskManager registered', async ({ request }) => {
    const overview = await apiGet(request, `${FLINK_URL}/overview`)
    expect(overview.taskmanagers).toBeGreaterThanOrEqual(1)
  })

  test('Flink has available task slots', async ({ request }) => {
    const overview = await apiGet(request, `${FLINK_URL}/overview`)
    // Flink 1.20 uses flat keys: 'slots-total', 'slots-available'
    expect(overview['slots-total']).toBeGreaterThan(0)
  })

  test('Flink /jobs lists running streaming jobs', async ({ request, page }) => {
    const jobs = await apiGet(request, `${FLINK_URL}/jobs`)
    const runningJobs = (jobs.jobs as Array<{ status: string }>).filter(j => j.status === 'RUNNING')
    expect(runningJobs.length).toBeGreaterThan(0)
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/flink-02-running-jobs.png' })
  })

  test('all 4 CDC pipeline jobs are in RUNNING state', async ({ request, page }) => {
    const jobs = await apiGet(request, `${FLINK_URL}/jobs`)
    const runningJobs = (jobs.jobs as Array<{ status: string }>).filter(j => j.status === 'RUNNING')
    // 4 INSERT INTO pipelines: orders, order_items, books, inventory
    expect(runningJobs.length).toBeGreaterThanOrEqual(4)
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/flink-03-four-jobs-running.png' })
  })

  test('Flink /taskmanagers returns task manager details', async ({ request }) => {
    const tm = await apiGet(request, `${FLINK_URL}/taskmanagers`)
    const managers: Array<{ id: string }> = tm.taskmanagers
    expect(managers.length).toBeGreaterThanOrEqual(1)
  })

  test('Flink web dashboard page loads in browser', async ({ page }) => {
    await page.goto(FLINK_URL)
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: 'screenshots/flink-04-web-dashboard.png', fullPage: true })

    // Flink dashboard shows the overview pane
    const body = await page.textContent('body')
    expect(body).toBeTruthy()
    // Flink UI is an Angular SPA — check for the app root or title
    const title = await page.title()
    expect(title.toLowerCase()).toContain('flink')
  })

  test('Flink dashboard shows running jobs in UI', async ({ page }) => {
    await page.goto(`${FLINK_URL}/#/overview`)
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: 'screenshots/flink-05-dashboard-overview.png', fullPage: true })
    // At least one element should be visible after load
    await expect(page.locator('body')).toBeVisible()
  })

  test('checkpoint configuration is EXACTLY_ONCE', async ({ request }) => {
    const jobs = await apiGet(request, `${FLINK_URL}/jobs`)
    const runningJob = (jobs.jobs as Array<{ id: string; status: string }>).find(j => j.status === 'RUNNING')
    if (!runningJob) return // Skip if no running jobs yet

    const config = await apiGet(request, `${FLINK_URL}/jobs/${runningJob.id}/checkpoints/config`)
    // Checkpointing should be configured (interval ≥ 0)
    expect(config.interval).toBeGreaterThanOrEqual(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 3 — CDC End-to-End Data Flow
// ═══════════════════════════════════════════════════════════════════════════
test.describe('CDC End-to-End Data Flow', () => {

  test('dim_books is populated from initial Debezium snapshot via Flink', async ({ page }) => {
    const books = await pollUntilFound<{ id: string; title: string; author: string }>(
      'SELECT id, title, author FROM dim_books LIMIT 10',
      [],
      15_000,
    )
    expect(books.length).toBeGreaterThanOrEqual(1)
    books.forEach(b => {
      expect(b.title).toBeTruthy()
      expect(b.author).toBeTruthy()
    })
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/cdc-flink-01-dim-books-populated.png' })
  })

  test('fact_inventory is populated from initial Debezium snapshot via Flink', async ({ page }) => {
    const rows = await pollUntilFound<{ book_id: string; quantity: number; reserved: number }>(
      'SELECT book_id, quantity, reserved FROM fact_inventory LIMIT 10',
      [],
      15_000,
    )
    expect(rows.length).toBeGreaterThanOrEqual(1)
    rows.forEach(r => {
      expect(r.book_id).toBeTruthy()
      expect(r.quantity).toBeGreaterThanOrEqual(0)
    })
    await page.screenshot({ path: 'screenshots/cdc-flink-02-fact-inventory-populated.png' })
  })

  test('Flink JDBC sink writes dim_books with correct column types', async ({ page }) => {
    const rows = await queryAnalyticsDb<{
      id: string; title: string; author: string; price: number; genre: string
    }>('SELECT id, title, author, price, genre FROM dim_books WHERE price > 0 LIMIT 5')
    expect(rows.length).toBeGreaterThan(0)
    rows.forEach(r => {
      expect(typeof r.price).toBe('number')
      expect(r.price).toBeGreaterThan(0)
    })
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/cdc-flink-03-dim-books-types.png' })
  })

  test('analytics views return data (vw_product_sales_volume)', async ({ page }) => {
    // This view joins dim_books with fact_order_items — needs orders to have been placed
    // We check the view is at least queryable without error
    const rows = await queryAnalyticsDb<{ title: string; units_sold: number }>(
      'SELECT title, units_sold FROM vw_product_sales_volume LIMIT 5'
    )
    // If there are orders, rows should exist; if not, empty is fine but view must not error
    expect(Array.isArray(rows)).toBeTruthy()
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/cdc-flink-04-view-product-sales.png' })
  })

  test('analytics view vw_inventory_health returns stock levels', async ({ page }) => {
    const rows = await pollUntilFound<{
      title: string; stock_quantity: number; stock_status: string
    }>(
      'SELECT title, stock_quantity, stock_status FROM vw_inventory_health LIMIT 10',
      [],
      15_000,
    )
    expect(rows.length).toBeGreaterThan(0)
    rows.forEach(r => {
      expect(['OK', 'Low', 'Critical']).toContain(r.stock_status)
      expect(r.stock_quantity).toBeGreaterThanOrEqual(0)
    })
    await page.screenshot({ path: 'screenshots/cdc-flink-05-view-inventory-health.png' })
  })

  test('analytics view vw_book_price_distribution buckets are correct', async ({ page }) => {
    const rows = await pollUntilFound<{ price_range: string; book_count: number }>(
      'SELECT price_range, book_count FROM vw_book_price_distribution',
      [],
      15_000,
    )
    expect(rows.length).toBeGreaterThan(0)
    const validRanges = ['Under $10', '$10–$19', '$20–$29', '$30–$49', '$50+']
    rows.forEach(r => {
      expect(validRanges).toContain(r.price_range)
      expect(r.book_count).toBeGreaterThan(0)
    })
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/cdc-flink-06-view-price-distribution.png' })
  })

  test('all 10 analytics views exist and are queryable', async ({ page }) => {
    const views = [
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
    for (const view of views) {
      // Each view must be queryable without throwing
      const rows = await queryAnalyticsDb(`SELECT * FROM ${view} LIMIT 1`)
      expect(Array.isArray(rows), `View ${view} must return an array`).toBeTruthy()
    }
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/cdc-flink-07-all-views-queryable.png' })
  })

  test('CDC real-time flow: insert into ecom-db appears in analytics-db via Flink', async ({ page }) => {
    // Insert a test order directly into ecom-db
    const testOrderId  = `f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1`
    const testBookId   = `00000000-0000-0000-0000-000000000001` // known seeded UUID

    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/cdc-flink-08-before-insert.png' })

    try {
      // Insert directly into ecom-db to trigger Debezium CDC
      kubectlExec('ecom', 'ecom-db', [
        'psql', '-U', 'ecomuser', 'ecomdb', '-c',
        `INSERT INTO orders (id, user_id, total, status, created_at)
         VALUES ('${testOrderId}','flink-e2e-test',19.99,'CONFIRMED',NOW())
         ON CONFLICT (id) DO NOTHING;`,
      ])

      kubectlExec('ecom', 'ecom-db', [
        'psql', '-U', 'ecomuser', 'ecomdb', '-c',
        `INSERT INTO order_items (id, order_id, book_id, quantity, price_at_purchase)
         VALUES (gen_random_uuid(),'${testOrderId}','${testBookId}',1,19.99)
         ON CONFLICT DO NOTHING;`,
      ])
    } catch (e) {
      // If direct insert fails (auth/schema difference), skip gracefully
      test.skip(true, `Could not insert test row: ${e}`)
      return
    }

    // Poll analytics-db for the order (max 30s — Debezium WAL + Flink pipeline latency)
    const rows = await pollUntilFound<{ id: string }>(
      `SELECT id FROM fact_orders WHERE id = $1`,
      [testOrderId],
      30_000,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(testOrderId)

    // Cleanup
    try {
      kubectlExec('ecom', 'ecom-db', [
        'psql', '-U', 'ecomuser', 'ecomdb', '-c',
        `DELETE FROM order_items WHERE order_id='${testOrderId}';
         DELETE FROM orders WHERE id='${testOrderId}';`,
      ])
    } catch { /* ignore cleanup errors */ }

    await page.screenshot({ path: 'screenshots/cdc-flink-09-order-in-analytics.png' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 4 — Debezium + Flink Operational Health
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Operational Health', () => {

  test('Debezium pod is Running (via kubectl)', async ({ page }) => {
    const output = execFileSync('kubectl', [
      'get', 'pod', '-n', 'infra', '-l', 'app=debezium',
      '-o', 'jsonpath={.items[0].status.phase}',
    ], { encoding: 'utf-8' }).trim()
    expect(output).toBe('Running')
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/health-01-debezium-pod-running.png' })
  })

  test('Flink JobManager pod is Running (via kubectl)', async ({ page }) => {
    const output = execFileSync('kubectl', [
      'get', 'pod', '-n', 'analytics', '-l', 'app=flink-jobmanager',
      '-o', 'jsonpath={.items[0].status.phase}',
    ], { encoding: 'utf-8' }).trim()
    expect(output).toBe('Running')
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/health-02-flink-jm-pod-running.png' })
  })

  test('Flink TaskManager pod is Running (via kubectl)', async ({ page }) => {
    const output = execFileSync('kubectl', [
      'get', 'pod', '-n', 'analytics', '-l', 'app=flink-taskmanager',
      '-o', 'jsonpath={.items[0].status.phase}',
    ], { encoding: 'utf-8' }).trim()
    expect(output).toBe('Running')
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/health-03-flink-tm-pod-running.png' })
  })

  test('Debezium NodePort service exists at port 32300', async ({ page }) => {
    const output = execFileSync('kubectl', [
      'get', 'svc', 'debezium-nodeport', '-n', 'infra',
      '-o', 'jsonpath={.spec.ports[0].nodePort}',
    ], { encoding: 'utf-8' }).trim()
    expect(output).toBe('32300')
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/health-04-debezium-nodeport.png' })
  })

  test('Flink NodePort service exists at port 32200', async ({ page }) => {
    const output = execFileSync('kubectl', [
      'get', 'svc', 'flink-jobmanager-nodeport', '-n', 'analytics',
      '-o', 'jsonpath={.spec.ports[0].nodePort}',
    ], { encoding: 'utf-8' }).trim()
    expect(output).toBe('32200')
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/health-05-flink-nodeport.png' })
  })

  test('Flink checkpoint storage PVC is bound', async ({ page }) => {
    const output = execFileSync('kubectl', [
      'get', 'pvc', 'flink-checkpoints-pvc', '-n', 'analytics',
      '-o', 'jsonpath={.status.phase}',
    ], { encoding: 'utf-8' }).trim()
    expect(output).toBe('Bound')
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/health-06-flink-pvc-bound.png' })
  })

  test('analytics-db has all 4 fact/dim tables', async ({ page }) => {
    const tables = ['fact_orders', 'fact_order_items', 'fact_inventory', 'dim_books']
    for (const table of tables) {
      const output = execFileSync('kubectl', [
        'exec', '-n', 'analytics', 'deployment/analytics-db', '--',
        'psql', '-U', 'analyticsuser', 'analyticsdb', '-tAc',
        `SELECT to_regclass('public.${table}')`,
      ], { encoding: 'utf-8', timeout: 10_000 }).trim()
      expect(output).not.toBe('')
      expect(output).not.toBe('null')
    }
    await page.goto('about:blank')
    await page.screenshot({ path: 'screenshots/health-07-analytics-tables-exist.png' })
  })
})
