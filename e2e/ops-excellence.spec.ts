/**
 * Operational Excellence E2E Tests (Session 35)
 *
 * Covers:
 *   1. Backup/restore scripts exist and are executable
 *   2. Documentation files exist with required sections
 *   3. API error format verification
 */
import { test, expect } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

const REPO_ROOT = path.join(__dirname, '..')
const ECOM_API = 'https://api.service.net:30000/ecom'

// ═══════════════════════════════════════════════════════════════════════════
// Suite 1 — Scripts
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Operational Scripts', () => {

  test('backup.sh exists and is executable', async () => {
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'backup.sh')
    expect(fs.existsSync(scriptPath)).toBe(true)
    const stats = fs.statSync(scriptPath)
    // Check executable bit (owner execute = 0o100)
    expect(stats.mode & 0o100).toBeTruthy()
  })

  test('restore.sh exists and is executable', async () => {
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'restore.sh')
    expect(fs.existsSync(scriptPath)).toBe(true)
    const stats = fs.statSync(scriptPath)
    expect(stats.mode & 0o100).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 2 — Documentation
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Documentation', () => {

  test('CONTRIBUTING.md exists with required sections', async () => {
    const filePath = path.join(REPO_ROOT, 'CONTRIBUTING.md')
    expect(fs.existsSync(filePath)).toBe(true)
    const content = fs.readFileSync(filePath, 'utf-8')
    expect(content).toContain('Prerequisites')
    expect(content).toContain('Quick Start')
    expect(content).toContain('Project Structure')
    expect(content).toContain('Development Workflow')
    expect(content).toContain('Code Conventions')
    expect(content).toContain('Testing Requirements')
    expect(content).toContain('Debugging Tips')
    expect(content).toContain('Session Planning Convention')
  })

  test('performance-baseline.md exists', async () => {
    const filePath = path.join(REPO_ROOT, 'docs', 'guides', 'performance-baseline.md')
    expect(fs.existsSync(filePath)).toBe(true)
    const content = fs.readFileSync(filePath, 'utf-8')
    expect(content).toContain('p50')
    expect(content).toContain('p95')
    expect(content).toContain('p99')
    expect(content).toContain('Capacity Planning')
  })

  test('api-error-reference.md exists', async () => {
    const filePath = path.join(REPO_ROOT, 'docs', 'guides', 'api-error-reference.md')
    expect(fs.existsSync(filePath)).toBe(true)
    const content = fs.readFileSync(filePath, 'utf-8')
    expect(content).toContain('Idempotency-Key')
    expect(content).toContain('Problem Detail')
    expect(content).toContain('401')
    expect(content).toContain('409')
    expect(content).toContain('429')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 3 — API Error Format
// ═══════════════════════════════════════════════════════════════════════════
test.describe('API Error Format', () => {

  test('ecom-service returns ProblemDetail for invalid book ID', async ({ request }) => {
    const res = await request.get(
      `${ECOM_API}/books/00000000-0000-0000-0000-000000000000`,
      { ignoreHTTPSErrors: true },
    )
    expect(res.status()).toBe(404)
    const body = await res.json()
    // RFC 7807 ProblemDetail fields
    expect(body).toHaveProperty('status', 404)
    expect(body).toHaveProperty('detail')
  })

  test('inventory-service returns structured error for unknown book', async ({ request }) => {
    const res = await request.get(
      'https://api.service.net:30000/inven/stock/00000000-0000-0000-0000-000000000000',
      { ignoreHTTPSErrors: true },
    )
    expect(res.status()).toBe(404)
    const body = await res.json()
    expect(body).toHaveProperty('detail')
  })

  test('ecom-service checkout without auth returns 401', async ({ request }) => {
    const res = await request.post(`${ECOM_API}/checkout`, {
      ignoreHTTPSErrors: true,
    })
    expect(res.status()).toBe(401)
  })
})
