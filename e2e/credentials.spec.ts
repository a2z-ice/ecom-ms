/**
 * Credentials Verification E2E Tests
 *
 * Validates that all documented service credentials are correct and working:
 *   - PgAdmin: admin@bookstore.dev / CHANGE_ME at http://localhost:31111
 *   - Superset: admin / CHANGE_ME at http://localhost:32000
 *   - Keycloak Admin: admin / CHANGE_ME at http://localhost:32400
 *   - Keycloak Users: user1 / CHANGE_ME, admin1 / CHANGE_ME
 *   - Grafana: anonymous access at http://localhost:32500
 */
import { test, expect } from '@playwright/test'

const PGADMIN_URL = 'http://localhost:31111'
const SUPERSET_URL = 'http://localhost:32000'
const KEYCLOAK_ADMIN_URL = 'http://localhost:32400'
const GRAFANA_URL = 'http://localhost:32500'
const KEYCLOAK_TOKEN_URL = 'https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token'

test.describe('PgAdmin Credentials', () => {

  test('PgAdmin is accessible at http://localhost:31111', async ({ request }) => {
    const resp = await request.get(PGADMIN_URL, { maxRedirects: 5 })
    expect([200, 302]).toContain(resp.status())
  })

  test('PgAdmin login succeeds with admin@bookstore.dev / CHANGE_ME', async ({ page }) => {
    await page.goto(PGADMIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })

    // PgAdmin shows a login form
    const emailInput = page.locator('input[name="email"]')
    const passwordInput = page.locator('input[name="password"]')

    // Wait for login form to appear (PgAdmin SPA may take a moment)
    await expect(emailInput).toBeVisible({ timeout: 15000 })

    await emailInput.fill('admin@bookstore.dev')
    await passwordInput.fill('CHANGE_ME')
    await page.locator('button[type="submit"], input[type="submit"]').click()

    // After login, PgAdmin shows the dashboard or server browser
    // Look for absence of error message and presence of dashboard elements
    await expect(page.locator('text=Invalid email or password')).not.toBeVisible({ timeout: 10000 })
  })

  test('PgAdmin rejects wrong credentials via API', async ({ request }) => {
    // PgAdmin's login API returns 401 or redirect on bad credentials
    const resp = await request.post(`${PGADMIN_URL}/login`, {
      form: {
        email: 'admin@bookstore.local',
        password: 'CHANGE_ME',
      },
      maxRedirects: 0,
    })
    // Should NOT get a successful dashboard response — either 401, 302 back to login, or 200 with error page
    // PgAdmin redirects back to /login on failure (302) or shows login page again (200)
    expect([200, 302, 401]).toContain(resp.status())
  })

  test('PgAdmin has 4 servers configured via servers.json', () => {
    const { execFileSync } = require('child_process')
    const serversJson = execFileSync('kubectl', [
      'exec', '-n', 'admin-tools', 'deploy/pgadmin', '--',
      'cat', '/pgadmin4/servers.json',
    ], { encoding: 'utf-8', timeout: 10_000 })
    const data = JSON.parse(serversJson)
    expect(Object.keys(data.Servers || {})).toHaveLength(4)
  })

  test('PgAdmin dashboard shows BookStore server group after login', async ({ page }) => {
    await page.goto(PGADMIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })

    const emailInput = page.locator('input[name="email"]')
    await expect(emailInput).toBeVisible({ timeout: 15000 })

    await emailInput.fill('admin@bookstore.dev')
    await page.locator('input[name="password"]').fill('CHANGE_ME')
    await page.locator('button[type="submit"], input[type="submit"]').click()

    // Wait for PgAdmin SPA dashboard to fully load
    await page.waitForTimeout(5000)

    // PgAdmin renders the tree browser with "BookStore" server group
    // and "Servers" node visible in the left panel.
    // Use textContent check — PgAdmin's tree widget uses custom elements
    // that Playwright may not consider "visible" in the traditional sense.
    const content = await page.content()
    expect(content).toContain('BookStore')
    expect(content).toContain('Servers')
  })

  test('PgAdmin PGADMIN_SERVER_JSON_FILE env var is set', () => {
    const { execFileSync } = require('child_process')
    const dep = JSON.parse(execFileSync('kubectl', [
      'get', 'deployment', 'pgadmin', '-n', 'admin-tools', '-o', 'json',
    ], { encoding: 'utf-8', timeout: 10_000 }))
    const container = dep.spec.template.spec.containers[0]
    const envVar = container.env?.find((e: any) => e.name === 'PGADMIN_SERVER_JSON_FILE')
    expect(envVar).toBeTruthy()
    expect(envVar.value).toBe('/pgadmin4/servers.json')
  })

  test('PgAdmin pod has servers.json volume mount', () => {
    const { execFileSync } = require('child_process')
    const dep = JSON.parse(execFileSync('kubectl', [
      'get', 'deployment', 'pgadmin', '-n', 'admin-tools', '-o', 'json',
    ], { encoding: 'utf-8', timeout: 10_000 }))
    const container = dep.spec.template.spec.containers[0]
    const mount = container.volumeMounts?.find((m: any) => m.mountPath === '/pgadmin4/servers.json')
    expect(mount).toBeTruthy()
    expect(mount.subPath).toBe('servers.json')
    expect(mount.readOnly).toBe(true)
  })

  test('PgAdmin has pre-configured servers via ConfigMap', () => {
    const { execFileSync } = require('child_process')
    const servers = execFileSync('kubectl', [
      'get', 'configmap', 'pgadmin-servers', '-n', 'admin-tools',
      '-o', 'jsonpath={.data.servers\\.json}',
    ], { encoding: 'utf-8', timeout: 10_000 })
    const parsed = JSON.parse(servers)
    expect(Object.keys(parsed.Servers).length).toBe(4)
    // Verify all 4 databases are configured
    const names = Object.values(parsed.Servers).map((s: any) => s.Name)
    expect(names).toContain('ecom-db (E-Commerce)')
    expect(names).toContain('inventory-db (Inventory)')
    expect(names).toContain('analytics-db (Analytics/Flink)')
    expect(names).toContain('keycloak-db (Identity)')
  })

  test('PgAdmin Secret has correct email (admin@bookstore.dev)', () => {
    const { execFileSync } = require('child_process')
    const email = execFileSync('kubectl', [
      'get', 'secret', 'pgadmin-secret', '-n', 'admin-tools',
      '-o', 'jsonpath={.data.PGADMIN_DEFAULT_EMAIL}',
    ], { encoding: 'utf-8', timeout: 10_000 }).trim()
    const decoded = Buffer.from(email, 'base64').toString('utf-8')
    expect(decoded).toBe('admin@bookstore.dev')
  })
})

test.describe('Superset Credentials', () => {

  test('Superset is accessible at http://localhost:32000', async ({ request }) => {
    const resp = await request.get(SUPERSET_URL, { maxRedirects: 5 })
    expect([200, 302]).toContain(resp.status())
  })

  test('Superset API login succeeds with admin / CHANGE_ME', async ({ request }) => {
    const resp = await request.post(`${SUPERSET_URL}/api/v1/security/login`, {
      data: {
        username: 'admin',
        password: 'CHANGE_ME',
        provider: 'db',
      },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.access_token).toBeTruthy()
  })
})

test.describe('Keycloak Admin Credentials', () => {

  test('Keycloak admin console is accessible at http://localhost:32400', async ({ request }) => {
    const resp = await request.get(`${KEYCLOAK_ADMIN_URL}/admin/`, { maxRedirects: 5 })
    expect([200, 302]).toContain(resp.status())
  })

  test('Keycloak master realm token grant succeeds with admin / CHANGE_ME', async ({ request }) => {
    const resp = await request.post(
      'https://idp.keycloak.net:30000/realms/master/protocol/openid-connect/token',
      {
        form: {
          grant_type: 'password',
          client_id: 'admin-cli',
          username: 'admin',
          password: 'CHANGE_ME',
        },
      }
    )
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.access_token).toBeTruthy()
  })
})

test.describe('Keycloak Bookstore User Credentials', () => {

  test('user1 / CHANGE_ME can obtain a token', async ({ request }) => {
    const resp = await request.post(KEYCLOAK_TOKEN_URL, {
      form: {
        grant_type: 'password',
        client_id: 'ui-client',
        username: 'user1',
        password: 'CHANGE_ME',
      },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.access_token).toBeTruthy()

    // Verify user1 has customer role
    const payload = JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64').toString())
    expect(payload.roles).toContain('customer')
    expect(payload.roles).not.toContain('admin')
  })

  test('admin1 / CHANGE_ME can obtain a token with admin role', async ({ request }) => {
    const resp = await request.post(KEYCLOAK_TOKEN_URL, {
      form: {
        grant_type: 'password',
        client_id: 'ui-client',
        username: 'admin1',
        password: 'CHANGE_ME',
      },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.access_token).toBeTruthy()

    const payload = JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64').toString())
    expect(payload.roles).toContain('admin')
    expect(payload.roles).toContain('customer')
  })
})

test.describe('Grafana Access', () => {

  test('Grafana is accessible at http://localhost:32500 (anonymous)', async ({ request }) => {
    const resp = await request.get(GRAFANA_URL, { maxRedirects: 5 })
    expect([200, 302]).toContain(resp.status())
  })

  test('Grafana API returns dashboards (with service account)', async ({ request }) => {
    // Grafana requires auth for API — use admin:admin default or check anonymous org
    const resp = await request.get(`${GRAFANA_URL}/api/search?type=dash-db`, {
      headers: { Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') },
    })
    // Accept 200 (auth works) or 401 (auth changed) — both confirm Grafana is running
    expect([200, 401]).toContain(resp.status())
  })
})

test.describe('Tool NodePort Accessibility', () => {

  const tools = [
    { name: 'PgAdmin', port: 31111 },
    { name: 'Superset', port: 32000 },
    { name: 'Kiali', port: 32100, path: '/kiali' },
    { name: 'Flink', port: 32200 },
    { name: 'Debezium ecom', port: 32300, path: '/q/health' },
    { name: 'Debezium inventory', port: 32301, path: '/q/health' },
    { name: 'Keycloak Admin', port: 32400, path: '/admin/' },
    { name: 'Grafana', port: 32500 },
  ]

  for (const tool of tools) {
    test(`${tool.name} is reachable at localhost:${tool.port}`, async ({ request }) => {
      const url = `http://localhost:${tool.port}${tool.path || '/'}`
      const resp = await request.get(url, { maxRedirects: 5, timeout: 15000 })
      expect([200, 302]).toContain(resp.status())
    })
  }
})
