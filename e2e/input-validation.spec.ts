/**
 * Input Validation E2E Tests (Session 31)
 *
 * Validates JWT audience validation and input bounds:
 *   1. JWT audience validation (ecom + inventory)
 *   2. Cart quantity bounded 1-99
 *   3. Reserve quantity bounded 1-99
 *   4. No root initContainers in observability
 */
import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')
const ECOM_API = 'https://api.service.net:30000/ecom'
const INVENTORY_API = 'https://api.service.net:30000/inven'

async function getCsrfToken(request: any, bearerToken: string): Promise<string> {
  const resp = await request.get(`https://api.service.net:30000/csrf/token`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
    ignoreHTTPSErrors: true,
  })
  const body = await resp.json()
  return body.token
}

function kubectl(args: string[]): string {
  return execFileSync('kubectl', args, { encoding: 'utf-8', timeout: 15_000 }).trim()
}

function kubectlJson<T>(args: string[]): T {
  const raw = kubectl([...args, '-o', 'json'])
  return JSON.parse(raw) as T
}

// Load auth token from fixture
function getAuthToken(): string {
  const sessionPath = path.join(__dirname, 'fixtures', 'user1-session.json')
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'))
  // Session fixture is key-value map where value is JSON-encoded OIDC user
  for (const [, val] of Object.entries(session)) {
    try {
      const parsed = typeof val === 'string' ? JSON.parse(val) : val
      if (parsed && typeof parsed === 'object' && 'access_token' in (parsed as any)) {
        return (parsed as any).access_token
      }
    } catch { /* skip */ }
  }
  // Also try origins format (Playwright storage state)
  for (const origin of (session as any).origins || []) {
    for (const item of origin.localStorage || []) {
      try {
        const parsed = JSON.parse(item.value)
        if (parsed.access_token) return parsed.access_token
      } catch { /* skip */ }
    }
  }
  throw new Error('No auth token found in fixture')
}

test.describe('Session 31 — Security: Application Layer', () => {

  test.describe('Cart quantity validation (ecom-service)', () => {
    test('rejects quantity=0', async ({ request }) => {
      let token: string
      try { token = getAuthToken() } catch { test.skip(true, 'No auth fixture') ; return }
      const csrf = await getCsrfToken(request, token)
      const resp = await request.post(`${ECOM_API}/cart`, {
        data: { bookId: '00000000-0000-0000-0000-000000000001', quantity: 0 },
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        ignoreHTTPSErrors: true,
      })
      expect(resp.status()).toBeGreaterThanOrEqual(400)
    })

    test('rejects quantity=-1', async ({ request }) => {
      let token: string
      try { token = getAuthToken() } catch { test.skip(true, 'No auth fixture') ; return }
      const csrf = await getCsrfToken(request, token)
      const resp = await request.post(`${ECOM_API}/cart`, {
        data: { bookId: '00000000-0000-0000-0000-000000000001', quantity: -1 },
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        ignoreHTTPSErrors: true,
      })
      expect(resp.status()).toBeGreaterThanOrEqual(400)
    })

    test('rejects quantity=100', async ({ request }) => {
      let token: string
      try { token = getAuthToken() } catch { test.skip(true, 'No auth fixture') ; return }
      const csrf = await getCsrfToken(request, token)
      const resp = await request.post(`${ECOM_API}/cart`, {
        data: { bookId: '00000000-0000-0000-0000-000000000001', quantity: 100 },
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        ignoreHTTPSErrors: true,
      })
      expect(resp.status()).toBeGreaterThanOrEqual(400)
    })

    test('accepts quantity=1', async ({ request }) => {
      let token: string
      try { token = getAuthToken() } catch { test.skip(true, 'No auth fixture') ; return }
      const csrf = await getCsrfToken(request, token)
      const resp = await request.post(`${ECOM_API}/cart`, {
        data: { bookId: '00000000-0000-0000-0000-000000000001', quantity: 1 },
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        ignoreHTTPSErrors: true,
      })
      // 200 or 404 (book not found) both acceptable — not a validation error
      expect([200, 201, 404]).toContain(resp.status())
    })

    test('accepts quantity=99', async ({ request }) => {
      let token: string
      try { token = getAuthToken() } catch { test.skip(true, 'No auth fixture') ; return }
      const csrf = await getCsrfToken(request, token)
      const resp = await request.post(`${ECOM_API}/cart`, {
        data: { bookId: '00000000-0000-0000-0000-000000000001', quantity: 99 },
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        ignoreHTTPSErrors: true,
      })
      expect([200, 201, 404]).toContain(resp.status())
    })
  })

  test.describe('Reserve quantity validation (inventory-service)', () => {
    test('ReserveRequest schema enforces ge=1 and le=99', () => {
      const schemaFile = path.join(REPO_ROOT, 'inventory-service/app/schemas/inventory.py')
      const content = fs.readFileSync(schemaFile, 'utf-8')
      expect(content).toContain('ge=1')
      expect(content).toContain('le=99')
    })
  })

  test.describe('JWT audience validation', () => {
    test('ecom SecurityConfig includes audience validator', () => {
      const file = path.join(REPO_ROOT, 'ecom-service/src/main/java/com/bookstore/ecom/config/SecurityConfig.java')
      const content = fs.readFileSync(file, 'utf-8')
      expect(content).toContain('JwtClaimValidator')
      expect(content).toContain('JWT_AUDIENCE')
      expect(content).toContain('aud')
    })

    test('inventory auth.py verifies audience', () => {
      const file = path.join(REPO_ROOT, 'inventory-service/app/middleware/auth.py')
      const content = fs.readFileSync(file, 'utf-8')
      // Both decode calls should verify audience
      const decodeMatches = content.match(/verify_aud/g)
      expect(decodeMatches).toBeTruthy()
      // No more verify_aud: False
      expect(content).not.toContain('"verify_aud": False')
    })

    test('inventory config has jwt_audience setting', () => {
      const file = path.join(REPO_ROOT, 'inventory-service/app/config.py')
      const content = fs.readFileSync(file, 'utf-8')
      expect(content).toContain('jwt_audience')
    })
  })

  test.describe('Observability initContainers use minimal capabilities', () => {
    for (const deploy of [
      { name: 'prometheus', ns: 'observability' },
      { name: 'tempo', ns: 'otel' },
      { name: 'loki', ns: 'otel' },
    ]) {
      test(`${deploy.name} fix-permissions initContainer drops ALL capabilities`, () => {
        const dep = kubectlJson<any>(['get', 'deployment', deploy.name, '-n', deploy.ns])
        const initContainers = dep.spec.template.spec.initContainers || []
        const fixPerm = initContainers.find((c: any) => c.name === 'fix-permissions')
        if (fixPerm) {
          const dropped = fixPerm.securityContext?.capabilities?.drop || []
          expect(dropped).toContain('ALL')
        }
      })
    }
  })
})
