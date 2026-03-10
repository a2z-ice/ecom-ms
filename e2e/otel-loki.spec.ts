/**
 * OpenTelemetry Observability Stack E2E Tests
 *
 * Verifies:
 *   1. Loki labels contain service_name for ecom-service and inventory-service
 *   2. Logs are queryable by service_name, service_namespace, level
 *   3. Application Logs dashboard — structure and data
 *   4. Service Health dashboard — structure and data (HTTP metrics + mesh TCP)
 *   5. Cluster Overview dashboard — structure and data (kube-state-metrics + cAdvisor)
 *   6. Distributed Tracing dashboard — structure and data (Tempo + OTel Collector)
 *   7. OTel Collector health and pipeline metrics
 *   8. Prometheus scrape targets all healthy
 *   9. Grafana UI screenshots
 */
import { test, expect } from '@playwright/test'

const GRAFANA_URL = 'http://localhost:32500'
const GRAFANA_AUTH = 'Basic ' + Buffer.from('admin:CHANGE_ME').toString('base64')

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Query Grafana's Loki datasource proxy. */
async function lokiGet(request: import('@playwright/test').APIRequestContext, path: string) {
  const resp = await request.get(`${GRAFANA_URL}/api/datasources/proxy/uid/loki${path}`, {
    headers: { Authorization: GRAFANA_AUTH },
  })
  expect(resp.ok(), `Loki GET ${path} → ${resp.status()}`).toBeTruthy()
  return resp.json()
}

/** Query Grafana API. */
async function grafanaGet(request: import('@playwright/test').APIRequestContext, path: string) {
  const resp = await request.get(`${GRAFANA_URL}${path}`, {
    headers: { Authorization: GRAFANA_AUTH },
  })
  expect(resp.ok(), `Grafana GET ${path} → ${resp.status()}`).toBeTruthy()
  return resp.json()
}

/** Query Prometheus via Grafana proxy. */
async function promQuery(request: import('@playwright/test').APIRequestContext, query: string) {
  const resp = await request.get(`${GRAFANA_URL}/api/datasources/proxy/uid/prometheus/api/v1/query`, {
    headers: { Authorization: GRAFANA_AUTH },
    params: { query },
  })
  expect(resp.ok(), `Prometheus query failed: ${query}`).toBeTruthy()
  const data = await resp.json()
  return data.data.result
}

/** Login to Grafana. */
async function grafanaLogin(page: import('@playwright/test').Page) {
  await page.goto(`${GRAFANA_URL}/login`)
  await page.getByLabel('Email or username').fill('admin')
  await page.getByTestId('data-testid Password input field').fill('CHANGE_ME')
  await page.getByRole('button', { name: /log in|sign in/i }).click()
  await page.waitForFunction(() => !window.location.pathname.includes('/login'), { timeout: 15000 })
}

// ═══════════════════════════════════════════════════════════════════════════
// Suite 1 — Loki Labels and Log Data
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Loki Log Labels', () => {

  test('Loki has service_name label', async ({ request }) => {
    const data = await lokiGet(request, '/loki/api/v1/labels')
    expect(data.data).toContain('service_name')
  })

  test('service_name includes ecom-service', async ({ request }) => {
    const data = await lokiGet(request, '/loki/api/v1/label/service_name/values')
    expect(data.data).toContain('ecom-service')
  })

  test('service_name includes inventory-service', async ({ request }) => {
    const data = await lokiGet(request, '/loki/api/v1/label/service_name/values')
    expect(data.data).toContain('inventory-service')
  })

  test('service_namespace label has ecom and inventory', async ({ request }) => {
    const data = await lokiGet(request, '/loki/api/v1/label/service_namespace/values')
    expect(data.data).toContain('ecom')
    expect(data.data).toContain('inventory')
  })

  test('level label has INFO', async ({ request }) => {
    const data = await lokiGet(request, '/loki/api/v1/label/level/values')
    expect(data.data).toContain('INFO')
  })

  test('deployment_environment label has production', async ({ request }) => {
    const data = await lokiGet(request, '/loki/api/v1/label/deployment_environment/values')
    expect(data.data).toContain('production')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 2 — Log Queries via Loki API
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Loki Log Queries', () => {

  test('ecom-service logs are queryable', async ({ request }) => {
    await request.get('https://api.service.net:30000/ecom/books')
    await new Promise(r => setTimeout(r, 5000))

    const resp = await request.get(
      `${GRAFANA_URL}/api/datasources/proxy/uid/loki/loki/api/v1/query_range`, {
        headers: { Authorization: GRAFANA_AUTH },
        params: {
          query: '{service_name="ecom-service"}',
          limit: '5',
          start: String(Math.floor((Date.now() - 86400_000) * 1_000_000)),
          end: String(Math.floor(Date.now() * 1_000_000)),
        },
      })
    expect(resp.ok()).toBeTruthy()
    const data = await resp.json()
    expect(data.data.result.length).toBeGreaterThan(0)
  })

  test('inventory-service logs are queryable', async ({ request }) => {
    await request.get('https://api.service.net:30000/inven/stock/00000000-0000-0000-0000-000000000001')
    await new Promise(r => setTimeout(r, 5000))

    const resp = await request.get(
      `${GRAFANA_URL}/api/datasources/proxy/uid/loki/loki/api/v1/query_range`, {
        headers: { Authorization: GRAFANA_AUTH },
        params: {
          query: '{service_name="inventory-service"}',
          limit: '5',
          start: String(Math.floor((Date.now() - 86400_000) * 1_000_000)),
          end: String(Math.floor(Date.now() * 1_000_000)),
        },
      })
    expect(resp.ok()).toBeTruthy()
    const data = await resp.json()
    expect(data.data.result.length).toBeGreaterThan(0)
  })

  test('logs can be filtered by level=INFO', async ({ request }) => {
    const resp = await request.get(
      `${GRAFANA_URL}/api/datasources/proxy/uid/loki/loki/api/v1/query_range`, {
        headers: { Authorization: GRAFANA_AUTH },
        params: {
          query: '{service_name="ecom-service", level="INFO"}',
          limit: '3',
          start: String(Math.floor((Date.now() - 86400_000) * 1_000_000)),
          end: String(Math.floor(Date.now() * 1_000_000)),
        },
      })
    expect(resp.ok()).toBeTruthy()
    const data = await resp.json()
    expect(data.data.result.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 3 — Application Logs Dashboard
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Application Logs Dashboard', () => {

  test('dashboard exists with correct title', async ({ request }) => {
    const data = await grafanaGet(request, '/api/dashboards/uid/application-logs')
    expect(data.dashboard.title).toBe('Application Logs')
  })

  test('dashboard has 5 panels', async ({ request }) => {
    const data = await grafanaGet(request, '/api/dashboards/uid/application-logs')
    expect(data.dashboard.panels.length).toBe(5)
  })

  test('dashboard has expected panel titles', async ({ request }) => {
    const data = await grafanaGet(request, '/api/dashboards/uid/application-logs')
    const titles = data.dashboard.panels.map((p: { title: string }) => p.title)
    expect(titles).toContain('ecom-service Logs')
    expect(titles).toContain('inventory-service Logs')
    expect(titles).toContain('Log Volume by Service')
    expect(titles).toContain('Error Logs by Service')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 4 — Service Health Dashboard
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Service Health Dashboard', () => {

  test('dashboard exists with correct title', async ({ request }) => {
    const data = await grafanaGet(request, '/api/dashboards/uid/service-health')
    expect(data.dashboard.title).toBe('Service Health')
  })

  test('dashboard has 7 panels', async ({ request }) => {
    const data = await grafanaGet(request, '/api/dashboards/uid/service-health')
    expect(data.dashboard.panels.length).toBe(7)
  })

  test('dashboard has expected panel titles', async ({ request }) => {
    const data = await grafanaGet(request, '/api/dashboards/uid/service-health')
    const titles = data.dashboard.panels.map((p: { title: string }) => p.title)
    expect(titles).toContain('Request Rate (ecom-service)')
    expect(titles).toContain('Error Rate (5xx)')
    expect(titles).toContain('Service Up Status')
    expect(titles).toContain('Mesh TCP Connections (ztunnel)')
    expect(titles).toContain('Mesh TCP Throughput (ztunnel)')
  })

  test('ecom-service HTTP request metrics exist', async ({ request }) => {
    const result = await promQuery(request, 'http_server_requests_seconds_count{job="ecom-service"}')
    expect(result.length).toBeGreaterThan(0)
  })

  test('service up metrics show all services healthy', async ({ request }) => {
    const result = await promQuery(request, 'up{job=~"ecom-service|inventory-service|otel-collector"}')
    expect(result.length).toBeGreaterThanOrEqual(3)
    for (const r of result) {
      expect(r.value[1]).toBe('1')
    }
  })

  test('istio TCP metrics exist from ztunnel', async ({ request }) => {
    const result = await promQuery(request, 'istio_tcp_connections_opened_total')
    expect(result.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 5 — Cluster Overview Dashboard
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Cluster Overview Dashboard', () => {

  test('dashboard exists with correct title', async ({ request }) => {
    const data = await grafanaGet(request, '/api/dashboards/uid/cluster-overview')
    expect(data.dashboard.title).toBe('Cluster Overview')
  })

  test('dashboard has 5 panels', async ({ request }) => {
    const data = await grafanaGet(request, '/api/dashboards/uid/cluster-overview')
    expect(data.dashboard.panels.length).toBe(5)
  })

  test('dashboard has expected panel titles', async ({ request }) => {
    const data = await grafanaGet(request, '/api/dashboards/uid/cluster-overview')
    const titles = data.dashboard.panels.map((p: { title: string }) => p.title)
    expect(titles).toContain('Pods by Phase')
    expect(titles).toContain('Pod Restart Count (Top 10)')
    expect(titles).toContain('Running Pods by Namespace')
    expect(titles).toContain('CPU Usage by Container')
    expect(titles).toContain('Memory Usage by Container')
  })

  test('kube_pod_status_phase metrics exist', async ({ request }) => {
    const result = await promQuery(request, 'sum(kube_pod_status_phase{phase="Running"}) by (namespace)')
    expect(result.length).toBeGreaterThan(0)
  })

  test('running pods count is > 20', async ({ request }) => {
    const result = await promQuery(request, 'sum(kube_pod_status_phase{phase="Running"})')
    expect(result.length).toBe(1)
    expect(Number(result[0].value[1])).toBeGreaterThan(20)
  })

  test('container CPU metrics exist', async ({ request }) => {
    const result = await promQuery(request, 'sum(rate(container_cpu_usage_seconds_total{container!=""}[5m])) by (namespace)')
    expect(result.length).toBeGreaterThan(0)
  })

  test('container memory metrics exist', async ({ request }) => {
    const result = await promQuery(request, 'container_memory_working_set_bytes{container="ecom-service"}')
    expect(result.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 6 — Distributed Tracing Dashboard
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Distributed Tracing Dashboard', () => {

  test('dashboard exists with correct title', async ({ request }) => {
    const data = await grafanaGet(request, '/api/dashboards/uid/distributed-tracing')
    expect(data.dashboard.title).toBe('Distributed Tracing')
  })

  test('dashboard has 5 panels', async ({ request }) => {
    const data = await grafanaGet(request, '/api/dashboards/uid/distributed-tracing')
    expect(data.dashboard.panels.length).toBe(5)
  })

  test('dashboard has expected panel titles', async ({ request }) => {
    const data = await grafanaGet(request, '/api/dashboards/uid/distributed-tracing')
    const titles = data.dashboard.panels.map((p: { title: string }) => p.title)
    expect(titles).toContain('Recent Traces')
    expect(titles).toContain('OTel Spans Received (rate/5m)')
    expect(titles).toContain('OTel Collector Health')
    expect(titles).toContain('OTel Spans Dropped')
    expect(titles).toContain('Service Node Graph')
  })

  test('OTel Collector is up', async ({ request }) => {
    const result = await promQuery(request, 'up{job="otel-collector"}')
    expect(result.length).toBe(1)
    expect(result[0].value[1]).toBe('1')
  })

  test('OTel Collector receives spans', async ({ request }) => {
    // Generate traffic to produce spans
    await request.get('https://api.service.net:30000/ecom/books')
    await new Promise(r => setTimeout(r, 3000))

    const result = await promQuery(request, 'otelcol_receiver_accepted_spans')
    expect(result.length).toBeGreaterThan(0)
  })

  test('OTel Collector receives log records', async ({ request }) => {
    const result = await promQuery(request, 'otelcol_receiver_accepted_log_records')
    expect(result.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 7 — Prometheus Scrape Targets
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Prometheus Scrape Targets', () => {

  test('all scrape targets are healthy', async ({ request }) => {
    const resp = await request.get(`${GRAFANA_URL}/api/datasources/proxy/uid/prometheus/api/v1/targets`, {
      headers: { Authorization: GRAFANA_AUTH },
    })
    expect(resp.ok()).toBeTruthy()
    const data = await resp.json()
    const targets = data.data.activeTargets
    const unhealthy = targets.filter((t: { health: string }) => t.health !== 'up')
    expect(unhealthy.length, `Unhealthy targets: ${unhealthy.map((t: { scrapeUrl: string }) => t.scrapeUrl).join(', ')}`).toBe(0)
  })

  test('has expected number of scrape targets (11+)', async ({ request }) => {
    const resp = await request.get(`${GRAFANA_URL}/api/datasources/proxy/uid/prometheus/api/v1/targets`, {
      headers: { Authorization: GRAFANA_AUTH },
    })
    const data = await resp.json()
    expect(data.data.activeTargets.length).toBeGreaterThanOrEqual(11)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 8 — Grafana Datasources
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Grafana Datasources', () => {

  test('Prometheus datasource has uid "prometheus"', async ({ request }) => {
    const data = await grafanaGet(request, '/api/datasources/uid/prometheus')
    expect(data.type).toBe('prometheus')
  })

  test('Loki datasource has uid "loki"', async ({ request }) => {
    const data = await grafanaGet(request, '/api/datasources/uid/loki')
    expect(data.type).toBe('loki')
  })

  test('Tempo datasource has uid "tempo"', async ({ request }) => {
    const data = await grafanaGet(request, '/api/datasources/uid/tempo')
    expect(data.type).toBe('tempo')
  })

  test('all 4 dashboards exist', async ({ request }) => {
    const resp = await request.get(`${GRAFANA_URL}/api/search?type=dash-db`, {
      headers: { Authorization: GRAFANA_AUTH },
    })
    const data = await resp.json()
    const uids = data.map((d: { uid: string }) => d.uid)
    expect(uids).toContain('application-logs')
    expect(uids).toContain('service-health')
    expect(uids).toContain('cluster-overview')
    expect(uids).toContain('distributed-tracing')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 9 — Grafana UI Screenshots (visual verification)
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Grafana Dashboard UI', () => {

  test('Application Logs dashboard renders', async ({ page }) => {
    await grafanaLogin(page)
    await page.goto(`${GRAFANA_URL}/d/application-logs/application-logs?orgId=1&from=now-1h&to=now`)
    await page.waitForLoadState('networkidle', { timeout: 15000 })
    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'screenshots/otel-01-application-logs-dashboard.png', fullPage: true })
  })

  test('Service Health dashboard renders', async ({ page }) => {
    await grafanaLogin(page)
    await page.goto(`${GRAFANA_URL}/d/service-health/service-health?orgId=1&from=now-1h&to=now`)
    await page.waitForLoadState('networkidle', { timeout: 15000 })
    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'screenshots/otel-02-service-health-dashboard.png', fullPage: true })
  })

  test('Cluster Overview dashboard renders', async ({ page }) => {
    await grafanaLogin(page)
    await page.goto(`${GRAFANA_URL}/d/cluster-overview/cluster-overview?orgId=1&from=now-1h&to=now`)
    await page.waitForLoadState('networkidle', { timeout: 15000 })
    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'screenshots/otel-03-cluster-overview-dashboard.png', fullPage: true })
  })

  test('Distributed Tracing dashboard renders', async ({ page }) => {
    await grafanaLogin(page)
    await page.goto(`${GRAFANA_URL}/d/distributed-tracing/distributed-tracing?orgId=1&from=now-1h&to=now`)
    await page.waitForLoadState('networkidle', { timeout: 15000 })
    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'screenshots/otel-04-distributed-tracing-dashboard.png', fullPage: true })
  })

  test('Loki Explore shows service labels', async ({ page }) => {
    await grafanaLogin(page)
    await page.goto(`${GRAFANA_URL}/explore?orgId=1&left=%7B%22datasource%22:%22loki%22,%22queries%22:%5B%7B%22refId%22:%22A%22,%22expr%22:%22%7Bservice_name%3D~%5C%22.%2B%5C%22%7D%22%7D%5D%7D`)
    await page.waitForLoadState('networkidle', { timeout: 15000 })
    await page.screenshot({ path: 'screenshots/otel-05-loki-explore-all-services.png', fullPage: true })
  })
})
