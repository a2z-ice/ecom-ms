/**
 * Cert Dashboard Operator E2E Tests
 *
 * Tests the cert-dashboard operator deployment, CRD, dashboard UI,
 * certificate display, progress bars, renewal flow with SSE, and API endpoints.
 */
import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'

const DASHBOARD_URL = 'http://localhost:32600'

// ─── Helpers ────────────────────────────────────────────────────────────────

function kubectl(args: string[]): string {
  return execFileSync('kubectl', args, {
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim()
}

function kubectlJsonpath(resource: string, namespace: string, jsonpath: string): string {
  const nsArgs = namespace ? ['-n', namespace] : []
  return kubectl(['get', resource, ...nsArgs, '-o', `jsonpath=${jsonpath}`])
}

/** Get a short-lived ServiceAccount token for the dashboard. */
function getDashboardToken(): string {
  return kubectl([
    'create', 'token', 'bookstore-certs',
    '-n', 'cert-dashboard',
    '--duration=10m',
  ])
}

/** Check if cert-dashboard is deployed and accessible. */
function dashboardAvailable(): boolean {
  try {
    const pods = kubectl([
      'get', 'pods', '-n', 'cert-dashboard',
      '-l', 'app=cert-dashboard',
      '--field-selector=status.phase=Running',
      '-o', 'jsonpath={.items[*].metadata.name}',
    ])
    return pods.length > 0
  } catch {
    return false
  }
}

function operatorAvailable(): boolean {
  try {
    const ready = kubectl([
      'get', 'deploy', 'cert-dashboard-operator', '-n', 'cert-dashboard',
      '-o', 'jsonpath={.status.readyReplicas}',
    ])
    return parseInt(ready, 10) > 0
  } catch {
    return false
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Suite 1 — Operator & CRD
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Operator & CRD', () => {
  test('CertDashboard CRD is registered', () => {
    const output = kubectl(['get', 'crd', 'certdashboards.certs.bookstore.io', '-o', 'jsonpath={.metadata.name}'])
    expect(output).toBe('certdashboards.certs.bookstore.io')
  })

  test('Operator pod is running', () => {
    test.skip(!operatorAvailable(), 'Operator not deployed — run scripts/cert-dashboard-up.sh')
    const pods = kubectl([
      'get', 'pods', '-n', 'cert-dashboard',
      '-l', 'app=cert-dashboard-operator',
      '--field-selector=status.phase=Running',
      '-o', 'jsonpath={.items[*].metadata.name}',
    ])
    expect(pods).toContain('cert-dashboard-operator')
  })

  test('CertDashboard CR exists and is ready', () => {
    test.skip(!operatorAvailable(), 'Operator not deployed')
    const ready = kubectlJsonpath('certdashboard/bookstore-certs', 'cert-dashboard', '{.status.ready}')
    expect(ready).toBe('true')
  })

  test('Dashboard deployment is running', () => {
    test.skip(!dashboardAvailable(), 'Dashboard not deployed')
    const replicas = kubectl([
      'get', 'deploy', 'bookstore-certs', '-n', 'cert-dashboard',
      '-o', 'jsonpath={.status.readyReplicas}',
    ])
    expect(parseInt(replicas, 10)).toBeGreaterThan(0)
  })

  test('Dashboard service has NodePort 32600', () => {
    test.skip(!dashboardAvailable(), 'Dashboard not deployed')
    const nodePort = kubectl([
      'get', 'svc', 'bookstore-certs', '-n', 'cert-dashboard',
      '-o', 'jsonpath={.spec.ports[0].nodePort}',
    ])
    expect(nodePort).toBe('32600')
  })

  test('OLM is installed', () => {
    try {
      const pods = kubectl([
        'get', 'pods', '-n', 'olm',
        '-l', 'app=olm-operator',
        '--field-selector=status.phase=Running',
        '-o', 'jsonpath={.items[*].metadata.name}',
      ])
      expect(pods).toContain('olm-operator')
    } catch {
      test.skip(true, 'OLM not installed')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 2 — Dashboard API
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Dashboard API', () => {
  test.beforeEach(() => {
    test.skip(!dashboardAvailable(), 'Dashboard not deployed')
  })

  test('Health endpoint returns ok', async ({ request }) => {
    const res = await request.get(`${DASHBOARD_URL}/healthz`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
  })

  test('GET /api/certs returns JSON array', async ({ request }) => {
    const res = await request.get(`${DASHBOARD_URL}/api/certs`)
    expect(res.status()).toBe(200)
    const certs = await res.json()
    expect(Array.isArray(certs)).toBe(true)
    expect(certs.length).toBeGreaterThan(0)
  })

  test('Certificates include bookstore-gateway-cert', async ({ request }) => {
    const res = await request.get(`${DASHBOARD_URL}/api/certs`)
    const certs = await res.json()
    const gateway = certs.find((c: any) => c.name === 'bookstore-gateway-cert')
    expect(gateway).toBeTruthy()
    expect(gateway.namespace).toBe('infra')
    expect(gateway.ready).toBe(true)
  })

  test('Certificates include bookstore-ca', async ({ request }) => {
    const res = await request.get(`${DASHBOARD_URL}/api/certs`)
    const certs = await res.json()
    const ca = certs.find((c: any) => c.name === 'bookstore-ca')
    expect(ca).toBeTruthy()
    expect(ca.namespace).toBe('cert-manager')
    expect(ca.isCA).toBe(true)
  })

  test('Certificate has correct fields', async ({ request }) => {
    const res = await request.get(`${DASHBOARD_URL}/api/certs`)
    const certs = await res.json()
    const gateway = certs.find((c: any) => c.name === 'bookstore-gateway-cert')

    expect(gateway.issuer).toBe('bookstore-ca-issuer')
    expect(gateway.issuerKind).toBe('ClusterIssuer')
    expect(gateway.dnsNames).toContain('myecom.net')
    expect(gateway.dnsNames).toContain('api.service.net')
    expect(gateway.dnsNames).toContain('idp.keycloak.net')
    expect(gateway.dnsNames).toContain('localhost')
    expect(gateway.ipAddresses).toContain('127.0.0.1')
    expect(gateway.serialNumber).toBeTruthy()
    expect(gateway.algorithm).toContain('ECDSA')
    expect(gateway.daysRemaining).toBeGreaterThan(0)
    expect(gateway.duration).toBe('720h')
    expect(gateway.renewBefore).toBe('168h')
  })

  test('Certificate status is green for fresh cert', async ({ request }) => {
    const res = await request.get(`${DASHBOARD_URL}/api/certs`)
    const certs = await res.json()
    const gateway = certs.find((c: any) => c.name === 'bookstore-gateway-cert')
    // Fresh cert should have >10 days remaining = green
    expect(gateway.daysRemaining).toBeGreaterThan(10)
    expect(gateway.status).toBe('green')
  })

  test('POST /api/renew returns 401 without token', async ({ request }) => {
    const res = await request.post(`${DASHBOARD_URL}/api/renew`, {
      data: { name: 'bookstore-gateway-cert', namespace: 'infra' },
    })
    expect(res.status()).toBe(401)
  })

  test('POST /api/renew returns streamId with valid token', async ({ request }) => {
    const token = getDashboardToken()
    const res = await request.post(`${DASHBOARD_URL}/api/renew`, {
      data: { name: 'bookstore-gateway-cert', namespace: 'infra' },
      headers: { 'Authorization': `Bearer ${token}` },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.streamId).toBeTruthy()
    expect(body.streamId.length).toBeGreaterThan(10) // UUID format
  })

  test('POST /api/renew rejects invalid request', async ({ request }) => {
    const token = getDashboardToken()
    const res = await request.post(`${DASHBOARD_URL}/api/renew`, {
      data: { name: '', namespace: '' },
      headers: { 'Authorization': `Bearer ${token}` },
    })
    // Rate limit may kick in (429) or bad request (400)
    expect([400, 429]).toContain(res.status())
  })

  test('GET /api/sse/{streamId} returns event-stream', async ({ request }) => {
    const token = getDashboardToken()
    // First trigger a renewal to get a stream ID
    const renewRes = await request.post(`${DASHBOARD_URL}/api/renew`, {
      data: { name: 'bookstore-gateway-cert', namespace: 'infra' },
      headers: { 'Authorization': `Bearer ${token}` },
    })
    // May be 429 if rate limited from previous test
    if (renewRes.status() === 429) {
      test.skip(true, 'Rate limited — skipping SSE test')
      return
    }
    const { streamId } = await renewRes.json()

    const sseRes = await request.get(`${DASHBOARD_URL}/api/sse/${streamId}`)
    expect(sseRes.status()).toBe(200)
    expect(sseRes.headers()['content-type']).toContain('text/event-stream')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 3 — Dashboard UI
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Dashboard UI', () => {
  test.beforeEach(() => {
    test.skip(!dashboardAvailable(), 'Dashboard not deployed')
  })

  test('Dashboard loads at localhost:32600', async ({ page }) => {
    await page.goto(DASHBOARD_URL)
    await expect(page).toHaveTitle(/Certificate Dashboard/)
  })

  test('Shows certificate cards', async ({ page }) => {
    await page.goto(DASHBOARD_URL)
    await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 10000 })
    const cards = page.locator('.cert-card')
    expect(await cards.count()).toBeGreaterThanOrEqual(2)
  })

  test('Certificate card shows name and namespace', async ({ page }) => {
    await page.goto(DASHBOARD_URL)
    await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 10000 })
    await expect(page.locator('.cert-title').first()).toBeVisible()
    await expect(page.locator('.cert-namespace').first()).toBeVisible()
  })

  test('Gateway cert shows correct DNS names', async ({ page }) => {
    await page.goto(DASHBOARD_URL)
    await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 10000 })
    const pageText = await page.textContent('body')
    expect(pageText).toContain('myecom.net')
    expect(pageText).toContain('api.service.net')
    expect(pageText).toContain('idp.keycloak.net')
  })

  test('Progress bar is visible and green', async ({ page }) => {
    await page.goto(DASHBOARD_URL)
    await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 10000 })
    const progressFill = page.locator('.progress-fill').first()
    await expect(progressFill).toBeVisible()
    await expect(progressFill).toHaveClass(/green/)
  })

  test('Days remaining is displayed', async ({ page }) => {
    await page.goto(DASHBOARD_URL)
    await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 10000 })
    const daysText = page.locator('.progress-days').first()
    await expect(daysText).toBeVisible()
    const text = await daysText.textContent()
    expect(text).toMatch(/\d+ days remaining/)
  })

  test('Renew button exists for each cert', async ({ page }) => {
    await page.goto(DASHBOARD_URL)
    await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 10000 })
    const buttons = page.locator('.btn-renew')
    expect(await buttons.count()).toBeGreaterThanOrEqual(1)
  })

  test('Renew button opens confirmation modal with token field', async ({ page }) => {
    await page.goto(DASHBOARD_URL)
    await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 10000 })
    await page.locator('.btn-renew').first().click()
    await expect(page.locator('#renew-modal')).toBeVisible()
    await expect(page.locator('.modal-warning')).toBeVisible()

    // Token section elements
    await expect(page.locator('.token-section')).toBeVisible()
    await expect(page.locator('#modal-token')).toBeVisible()
    await expect(page.locator('#token-cmd')).toContainText('kubectl create token')
    await expect(page.locator('#copy-cmd')).toBeVisible()
    await expect(page.locator('#toggle-token')).toHaveText('Show')

    // Token input is password-masked by default
    await expect(page.locator('#modal-token')).toHaveAttribute('type', 'password')
  })

  test('Token field Show/Hide toggle works', async ({ page }) => {
    await page.goto(DASHBOARD_URL)
    await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 10000 })
    await page.locator('.btn-renew').first().click()
    await expect(page.locator('#renew-modal')).toBeVisible()

    // Default: password masked
    await expect(page.locator('#modal-token')).toHaveAttribute('type', 'password')
    await expect(page.locator('#toggle-token')).toHaveText('Show')

    // Click Show → reveals text
    await page.locator('#toggle-token').click()
    await expect(page.locator('#modal-token')).toHaveAttribute('type', 'text')
    await expect(page.locator('#toggle-token')).toHaveText('Hide')

    // Click Hide → masks again
    await page.locator('#toggle-token').click()
    await expect(page.locator('#modal-token')).toHaveAttribute('type', 'password')
    await expect(page.locator('#toggle-token')).toHaveText('Show')
  })

  test('Confirm without token shows validation error', async ({ page }) => {
    await page.goto(DASHBOARD_URL)
    await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 10000 })
    await page.locator('.btn-renew').first().click()
    await expect(page.locator('#renew-modal')).toBeVisible()

    // Click confirm without entering a token
    await page.locator('#modal-confirm').click()

    // Modal should still be visible (not dismissed)
    await expect(page.locator('#renew-modal')).toBeVisible()

    // Error message should appear
    await expect(page.locator('#token-error')).toBeVisible()
    await expect(page.locator('#modal-token')).toHaveClass(/invalid/)
  })

  test('Token error clears when user types', async ({ page }) => {
    await page.goto(DASHBOARD_URL)
    await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 10000 })
    await page.locator('.btn-renew').first().click()
    await expect(page.locator('#renew-modal')).toBeVisible()

    // Trigger error
    await page.locator('#modal-confirm').click()
    await expect(page.locator('#token-error')).toBeVisible()

    // Type something → error clears
    await page.locator('#modal-token').fill('some-token')
    await expect(page.locator('#token-error')).toBeHidden()
    await expect(page.locator('#modal-token')).not.toHaveClass(/invalid/)
  })

  test('Cancel dismisses modal and clears token', async ({ page }) => {
    await page.goto(DASHBOARD_URL)
    await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 10000 })
    await page.locator('.btn-renew').first().click()
    await expect(page.locator('#renew-modal')).toBeVisible()

    // Type a token then cancel
    await page.locator('#modal-token').fill('some-token-value')
    await page.locator('#modal-cancel').click()
    await expect(page.locator('#renew-modal')).not.toBeVisible()

    // Reopen — token field should be empty
    await page.locator('.btn-renew').first().click()
    await expect(page.locator('#renew-modal')).toBeVisible()
    await expect(page.locator('#modal-token')).toHaveValue('')
  })

  test('Shows CA badge for CA certificates', async ({ page }) => {
    await page.goto(DASHBOARD_URL)
    await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 10000 })
    const caBadges = page.locator('.cert-ca-badge')
    // bookstore-ca should have a CA badge
    expect(await caBadges.count()).toBeGreaterThanOrEqual(1)
  })

  test('Shows Ready status indicator', async ({ page }) => {
    await page.goto(DASHBOARD_URL)
    await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 10000 })
    const readyBadge = page.locator('.cert-ready.is-ready').first()
    await expect(readyBadge).toBeVisible()
    await expect(readyBadge).toContainText('Ready')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 4 — Renewal Flow (modifies cluster state — run last)
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Renewal Flow', () => {
  test.beforeEach(() => {
    test.skip(!dashboardAvailable(), 'Dashboard not deployed')
  })

  test('Confirm triggers renewal with token and SSE streaming', async ({ page }) => {
    test.setTimeout(120000) // Renewal can take up to 60s + rate limit wait

    // Get a real Kubernetes ServiceAccount token
    const token = getDashboardToken()
    expect(token.length).toBeGreaterThan(50)

    // Wait for rate limit to clear from previous API tests
    await page.waitForTimeout(12000)

    await page.goto(DASHBOARD_URL)
    await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 10000 })

    // Record current revision before renewal
    const revBefore = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.status.revision}'
    )

    // Click renew on gateway cert
    const gatewayCard = page.locator('.cert-card', { hasText: 'bookstore-gateway-cert' })
    await gatewayCard.locator('.btn-renew').click()
    await expect(page.locator('#renew-modal')).toBeVisible()

    // Handle any alert dialog (rate limit or error) — dismiss it so test can proceed
    let alertFired = false
    page.on('dialog', async (dialog) => {
      alertFired = true
      await dialog.dismiss()
    })

    // Paste the token into the masked input
    await page.locator('#modal-token').fill(token)

    // Confirm
    await page.locator('#modal-confirm').click()
    await expect(page.locator('#renew-modal')).not.toBeVisible()

    // If an alert fired (rate limit), the renewal failed — skip the rest
    await page.waitForTimeout(1000)
    if (alertFired) {
      test.skip(true, 'Rate limited — renewal was rejected')
      return
    }

    // Wait for SSE panel to appear and show messages
    const ssePanel = gatewayCard.locator('.sse-panel')
    await expect(ssePanel).toHaveClass(/active/, { timeout: 10000 })

    // Wait for "deleting-secret" phase
    await expect(ssePanel.locator('.phase-deleting-secret')).toBeVisible({ timeout: 10000 })

    // Wait for "waiting-issuing" phase
    await expect(ssePanel.locator('.phase-waiting-issuing')).toBeVisible({ timeout: 15000 })

    // Wait for completion (use .first() since both "ready" status + "complete" event have phase-ready class)
    await expect(ssePanel.locator('.phase-ready').first()).toBeVisible({ timeout: 60000 })

    // Verify revision incremented
    // Wait a moment for cert-manager to update
    await page.waitForTimeout(3000)
    const revAfter = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.status.revision}'
    )
    expect(parseInt(revAfter, 10)).toBeGreaterThan(parseInt(revBefore, 10))
  })

  test('HTTPS still works after renewal', async ({ request }) => {
    // Verify the gateway cert renewal didn't break HTTPS
    const res = await request.get('https://api.service.net:30000/ecom/books', {
      ignoreHTTPSErrors: true,
    })
    expect(res.status()).toBe(200)
  })
})
