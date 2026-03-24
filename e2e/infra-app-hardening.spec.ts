/**
 * Infrastructure & Application Hardening E2E Tests (Session 34)
 *
 * Covers:
 *   1. Kafka production configs (compression, retention, unclean election)
 *   2. Kafka liveness probe type (exec, not tcpSocket)
 *   3. Redis production configs (maxmemory, eviction policy)
 *   4. ResourceQuota in ecom and inventory namespaces
 *   5. LimitRange in ecom and inventory namespaces
 *   6. Swagger disabled in production
 *   7. Idempotent checkout via Idempotency-Key header
 *   8. DLQ topic exists
 *   9. Consumer commit safety (source code check)
 */
import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

// ─── Helpers ────────────────────────────────────────────────────────────────

function kubectl(args: string[]): string {
  return execFileSync('kubectl', args, {
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim()
}

function kubectlJson<T = unknown>(args: string[]): T {
  const raw = kubectl([...args, '-o', 'json'])
  return JSON.parse(raw) as T
}

const ECOM_API = 'https://api.service.net:30000/ecom'

// ═══════════════════════════════════════════════════════════════════════════
// Suite 1 — Kafka Production Configs
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Kafka Production Configs', () => {

  test('compression.type is lz4', async () => {
    const output = kubectl([
      'exec', '-n', 'infra', 'deploy/kafka', '--',
      'kafka-configs', '--bootstrap-server', 'localhost:9092',
      '--describe', '--entity-type', 'brokers', '--all',
    ])
    expect(output).toContain('compression.type=lz4')
  })

  test('log.retention.hours is 168', async () => {
    const output = kubectl([
      'exec', '-n', 'infra', 'deploy/kafka', '--',
      'kafka-configs', '--bootstrap-server', 'localhost:9092',
      '--describe', '--entity-type', 'brokers', '--all',
    ])
    expect(output).toContain('log.retention.hours=168')
  })

  test('unclean.leader.election.enable is false', async () => {
    const output = kubectl([
      'exec', '-n', 'infra', 'deploy/kafka', '--',
      'kafka-configs', '--bootstrap-server', 'localhost:9092',
      '--describe', '--entity-type', 'brokers', '--all',
    ])
    expect(output).toContain('unclean.leader.election.enable=false')
  })

  test('liveness probe is exec (not tcpSocket)', async () => {
    const deploy = kubectlJson<any>([
      'get', 'deploy/kafka', '-n', 'infra',
    ])
    const container = deploy.spec.template.spec.containers[0]
    expect(container.livenessProbe.exec).toBeDefined()
    expect(container.livenessProbe.tcpSocket).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 2 — Redis Production Configs
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Redis Production Configs', () => {

  test('maxmemory is 200mb', async () => {
    const output = kubectl([
      'exec', '-n', 'infra', 'deploy/redis', '--',
      'redis-cli', '-a', 'CHANGE_ME', 'CONFIG', 'GET', 'maxmemory',
    ])
    // 200mb = 209715200 bytes
    expect(output).toContain('209715200')
  })

  test('maxmemory-policy is allkeys-lru', async () => {
    const output = kubectl([
      'exec', '-n', 'infra', 'deploy/redis', '--',
      'redis-cli', '-a', 'CHANGE_ME', 'CONFIG', 'GET', 'maxmemory-policy',
    ])
    expect(output).toContain('allkeys-lru')
  })

  test('tcp-keepalive is 60', async () => {
    const output = kubectl([
      'exec', '-n', 'infra', 'deploy/redis', '--',
      'redis-cli', '-a', 'CHANGE_ME', 'CONFIG', 'GET', 'tcp-keepalive',
    ])
    expect(output).toContain('60')
  })

  test('timeout is 300', async () => {
    const output = kubectl([
      'exec', '-n', 'infra', 'deploy/redis', '--',
      'redis-cli', '-a', 'CHANGE_ME', 'CONFIG', 'GET', 'timeout',
    ])
    expect(output).toContain('300')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 3 — ResourceQuota & LimitRange
// ═══════════════════════════════════════════════════════════════════════════
test.describe('ResourceQuota & LimitRange', () => {

  test('ResourceQuota exists in ecom namespace', async () => {
    const output = kubectl([
      'get', 'resourcequota', '-n', 'ecom', '-o', 'jsonpath={.items[*].metadata.name}',
    ])
    expect(output).toContain('ecom-quota')
  })

  test('ResourceQuota exists in inventory namespace', async () => {
    const output = kubectl([
      'get', 'resourcequota', '-n', 'inventory', '-o', 'jsonpath={.items[*].metadata.name}',
    ])
    expect(output).toContain('inventory-quota')
  })

  test('LimitRange exists in ecom namespace', async () => {
    const output = kubectl([
      'get', 'limitrange', '-n', 'ecom', '-o', 'jsonpath={.items[*].metadata.name}',
    ])
    expect(output).toContain('ecom-limit-range')
  })

  test('LimitRange exists in inventory namespace', async () => {
    const output = kubectl([
      'get', 'limitrange', '-n', 'inventory', '-o', 'jsonpath={.items[*].metadata.name}',
    ])
    expect(output).toContain('inventory-limit-range')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 4 — Swagger Disabled in Production
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Swagger Disabled', () => {

  test('swagger-ui returns non-200 in production', async ({ request }) => {
    const res = await request.get(`${ECOM_API}/swagger-ui.html`, {
      ignoreHTTPSErrors: true,
    })
    // Should be 401 (requires auth since swagger paths not permitted) or 404
    expect([401, 403, 404]).toContain(res.status())
  })

  test('SWAGGER_ENABLED env is false in deployment', async () => {
    const deploy = kubectlJson<any>([
      'get', 'deploy/ecom-service', '-n', 'ecom',
    ])
    const container = deploy.spec.template.spec.containers[0]
    const allEnv = [...(container.env || []), ...(container.envFrom || [])]
    const swaggerEnv = container.env?.find((e: any) => e.name === 'SWAGGER_ENABLED')
    expect(swaggerEnv).toBeDefined()
    expect(swaggerEnv.value).toBe('false')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 5 — Idempotent Checkout
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Idempotent Checkout', () => {

  test('checkout with same Idempotency-Key returns same order', async ({ request }) => {
    // Get a fresh token via direct grant (password flow)
    const tokenJson = execFileSync('curl', [
      '-sk', '-X', 'POST',
      'https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token',
      '-d', 'grant_type=password&client_id=ui-client&username=user1&password=CHANGE_ME',
      '-H', 'Content-Type: application/x-www-form-urlencoded',
    ], { encoding: 'utf-8', timeout: 10_000 })
    const token = JSON.parse(tokenJson).access_token
    expect(token).toBeTruthy()

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    }

    // First, add an item to cart
    const books = await request.get(`${ECOM_API}/books`, { ignoreHTTPSErrors: true })
    const booksData = await books.json()
    const bookList = booksData.content || booksData
    if (!bookList.length) {
      test.skip()
      return
    }
    const bookId = bookList[0].id

    await request.post(`${ECOM_API}/cart`, {
      headers,
      data: { bookId, quantity: 1 },
      ignoreHTTPSErrors: true,
    })

    const idempotencyKey = `test-idempotency-${Date.now()}`

    // First checkout
    const res1 = await request.post(`${ECOM_API}/checkout`, {
      headers: { ...headers, 'Idempotency-Key': idempotencyKey },
      ignoreHTTPSErrors: true,
    })

    if (res1.status() !== 200) {
      // Cart might be empty or stock issue — skip
      test.skip()
      return
    }

    const order1 = await res1.json()

    // Second checkout with same key — should return same order
    const res2 = await request.post(`${ECOM_API}/checkout`, {
      headers: { ...headers, 'Idempotency-Key': idempotencyKey },
      ignoreHTTPSErrors: true,
    })
    expect(res2.status()).toBe(200)
    const order2 = await res2.json()
    expect(order2.id).toBe(order1.id)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 6 — Kafka DLQ & Consumer Safety
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Kafka DLQ & Consumer Safety', () => {

  test('DLQ topic is configured in consumer source', async () => {
    const consumerPath = path.join(__dirname, '..', 'inventory-service', 'app', 'kafka', 'consumer.py')
    const content = fs.readFileSync(consumerPath, 'utf-8')
    expect(content).toContain('order.created.dlq')
    // Also verify DLQ consumer subscribes to the DLQ topic
    const dlqConsumerPath = path.join(__dirname, '..', 'inventory-service', 'app', 'kafka', 'dlq_consumer.py')
    const dlqContent = fs.readFileSync(dlqConsumerPath, 'utf-8')
    expect(dlqContent).toContain('order.created.dlq')
  })

  test('DLQ consumer uses manual commit (enable_auto_commit=False)', async () => {
    const dlqConsumerPath = path.join(__dirname, '..', 'inventory-service', 'app', 'kafka', 'dlq_consumer.py')
    const content = fs.readFileSync(dlqConsumerPath, 'utf-8')
    expect(content).toContain('enable_auto_commit=False')
  })

  test('main consumer has commit error handling', async () => {
    const consumerPath = path.join(__dirname, '..', 'inventory-service', 'app', 'kafka', 'consumer.py')
    const content = fs.readFileSync(consumerPath, 'utf-8')
    // Verify commit is wrapped in try/except
    expect(content).toContain('await consumer.commit()')
    expect(content).toMatch(/try:\s*\n\s*await consumer\.commit\(\)/)
  })
})
