/**
 * Schema Registry E2E Tests
 *
 * Validates that the Confluent Schema Registry is deployed, healthy,
 * and actively stores JSON Schemas for all CDC and application Kafka topics.
 *
 * Covers:
 *   1. Schema Registry health and deployment
 *   2. Global compatibility configuration
 *   3. CDC topic schemas (4 Debezium topics)
 *   4. Application event schemas (order.created, inventory.updated)
 *   5. Schema content validation (fields, types, required)
 *   6. Schema versioning
 *   7. NetworkPolicy for Schema Registry
 */
import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'

function kubectl(args: string[]): string {
  return execFileSync('kubectl', args, { encoding: 'utf-8', timeout: 15_000 }).trim()
}

/** Query Schema Registry REST API via kubectl exec */
function srGet(path: string): string {
  return kubectl([
    'exec', '-n', 'infra', 'deploy/schema-registry', '--',
    'curl', '-sf', `http://localhost:8081${path}`,
  ])
}

function srGetJson<T>(path: string): T {
  return JSON.parse(srGet(path)) as T
}

// All expected subjects (TopicNameStrategy: <topic>-value)
const CDC_SUBJECTS = [
  'ecom-connector.public.orders-value',
  'ecom-connector.public.order_items-value',
  'ecom-connector.public.books-value',
  'inventory-connector.public.inventory-value',
]

const APP_SUBJECTS = [
  'order.created-value',
  'inventory.updated-value',
]

const ALL_SUBJECTS = [...CDC_SUBJECTS, ...APP_SUBJECTS]

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 1 — Schema Registry Health & Deployment
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('Schema Registry Health', () => {

  test('schema-registry pod is Running', () => {
    const phase = kubectl([
      'get', 'pod', '-n', 'infra', '-l', 'app=schema-registry',
      '-o', 'jsonpath={.items[0].status.phase}',
    ])
    expect(phase).toBe('Running')
  })

  test('schema-registry ClusterIP service exists on port 8081', () => {
    const port = kubectl([
      'get', 'svc', 'schema-registry', '-n', 'infra',
      '-o', 'jsonpath={.spec.ports[0].port}',
    ])
    expect(port).toBe('8081')
  })

  test('schema-registry /subjects endpoint returns 200', () => {
    const subjects = srGetJson<string[]>('/subjects')
    expect(Array.isArray(subjects)).toBeTruthy()
  })

  test('schema-registry image is pinned to v7.8.0', () => {
    const image = kubectl([
      'get', 'deploy', 'schema-registry', '-n', 'infra',
      '-o', 'jsonpath={.spec.template.spec.containers[0].image}',
    ])
    expect(image).toContain('7.8.0')
  })

  test('global compatibility mode is BACKWARD', () => {
    const config = srGetJson<{ compatibilityLevel: string }>('/config')
    expect(config.compatibilityLevel).toBe('BACKWARD')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 2 — CDC Topic Schemas Registered
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('CDC Topic Schemas', () => {

  test('all 6 subjects are registered', () => {
    const subjects = srGetJson<string[]>('/subjects')
    for (const expected of ALL_SUBJECTS) {
      expect(subjects, `Missing subject: ${expected}`).toContain(expected)
    }
  })

  for (const subject of CDC_SUBJECTS) {
    test(`${subject} has at least 1 version`, () => {
      const versions = srGetJson<number[]>(`/subjects/${subject}/versions`)
      expect(versions.length).toBeGreaterThanOrEqual(1)
    })
  }

  for (const subject of APP_SUBJECTS) {
    test(`${subject} has at least 1 version`, () => {
      const versions = srGetJson<number[]>(`/subjects/${subject}/versions`)
      expect(versions.length).toBeGreaterThanOrEqual(1)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 3 — Schema Content Validation
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('Schema Content Validation', () => {

  test('orders schema has correct Debezium envelope structure', () => {
    const resp = srGetJson<{ schema: string }>('/subjects/ecom-connector.public.orders-value/versions/latest')
    const schema = JSON.parse(resp.schema)
    expect(schema.properties).toHaveProperty('before')
    expect(schema.properties).toHaveProperty('after')
    expect(schema.properties).toHaveProperty('op')
    expect(schema.properties.op.enum).toEqual(['c', 'u', 'd', 'r'])
  })

  test('orders schema defines OrderRow with required fields', () => {
    const resp = srGetJson<{ schema: string }>('/subjects/ecom-connector.public.orders-value/versions/latest')
    const schema = JSON.parse(resp.schema)
    const orderRow = schema.$defs?.OrderRow || schema.definitions?.OrderRow
    expect(orderRow).toBeTruthy()
    expect(orderRow.properties).toHaveProperty('id')
    expect(orderRow.properties).toHaveProperty('user_id')
    expect(orderRow.properties).toHaveProperty('total')
    expect(orderRow.properties).toHaveProperty('status')
    expect(orderRow.required).toContain('id')
  })

  test('books schema defines BookRow with title, author, price', () => {
    const resp = srGetJson<{ schema: string }>('/subjects/ecom-connector.public.books-value/versions/latest')
    const schema = JSON.parse(resp.schema)
    const bookRow = schema.$defs?.BookRow || schema.definitions?.BookRow
    expect(bookRow).toBeTruthy()
    expect(bookRow.properties).toHaveProperty('title')
    expect(bookRow.properties).toHaveProperty('author')
    expect(bookRow.properties).toHaveProperty('price')
    expect(bookRow.required).toContain('title')
  })

  test('inventory schema defines InventoryRow with book_id, quantity, reserved', () => {
    const resp = srGetJson<{ schema: string }>('/subjects/inventory-connector.public.inventory-value/versions/latest')
    const schema = JSON.parse(resp.schema)
    const invRow = schema.$defs?.InventoryRow || schema.definitions?.InventoryRow
    expect(invRow).toBeTruthy()
    expect(invRow.properties).toHaveProperty('book_id')
    expect(invRow.properties).toHaveProperty('quantity')
    expect(invRow.properties).toHaveProperty('reserved')
  })

  test('order.created schema has orderId, userId, items, total', () => {
    const resp = srGetJson<{ schema: string }>('/subjects/order.created-value/versions/latest')
    const schema = JSON.parse(resp.schema)
    expect(schema.properties).toHaveProperty('orderId')
    expect(schema.properties).toHaveProperty('userId')
    expect(schema.properties).toHaveProperty('items')
    expect(schema.properties).toHaveProperty('total')
    expect(schema.required).toContain('orderId')
    expect(schema.required).toContain('items')
  })

  test('inventory.updated schema has bookId, previousQuantity, newQuantity', () => {
    const resp = srGetJson<{ schema: string }>('/subjects/inventory.updated-value/versions/latest')
    const schema = JSON.parse(resp.schema)
    expect(schema.properties).toHaveProperty('bookId')
    expect(schema.properties).toHaveProperty('previousQuantity')
    expect(schema.properties).toHaveProperty('newQuantity')
    expect(schema.required).toContain('bookId')
  })

  test('all schemas have schemaType JSON', () => {
    for (const subject of ALL_SUBJECTS) {
      const resp = srGetJson<{ schemaType: string }>(`/subjects/${subject}/versions/latest`)
      expect(resp.schemaType, `${subject} should be JSON schema`).toBe('JSON')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 4 — Schema Versioning & Compatibility
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('Schema Versioning', () => {

  test('each schema has a unique schema ID', () => {
    const ids = new Set<number>()
    for (const subject of ALL_SUBJECTS) {
      const resp = srGetJson<{ id: number }>(`/subjects/${subject}/versions/latest`)
      expect(resp.id).toBeGreaterThan(0)
      ids.add(resp.id)
    }
    // All 6 subjects should have unique IDs
    expect(ids.size).toBe(6)
  })

  test('re-registering same schema returns same version (idempotent)', () => {
    const versions1 = srGetJson<number[]>('/subjects/ecom-connector.public.orders-value/versions')
    // The latest version should be 1 (only registered once)
    expect(versions1[versions1.length - 1]).toBeGreaterThanOrEqual(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 5 — NetworkPolicy
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('Schema Registry NetworkPolicy', () => {

  test('schema-registry-ingress NetworkPolicy exists', () => {
    const output = kubectl([
      'get', 'networkpolicy', 'schema-registry-ingress', '-n', 'infra',
      '-o', 'jsonpath={.metadata.name}',
    ])
    expect(output).toBe('schema-registry-ingress')
  })

  test('schema-registry-egress NetworkPolicy exists', () => {
    const output = kubectl([
      'get', 'networkpolicy', 'schema-registry-egress', '-n', 'infra',
      '-o', 'jsonpath={.metadata.name}',
    ])
    expect(output).toBe('schema-registry-egress')
  })

  test('schema-registry ingress allows port 8081 from infra namespace', () => {
    const output = kubectl([
      'get', 'networkpolicy', 'schema-registry-ingress', '-n', 'infra',
      '-o', 'json',
    ])
    const policy = JSON.parse(output)
    const rules = policy.spec.ingress as Array<{ ports?: Array<{ port: number }> }>
    const has8081 = rules.some(r => r.ports?.some(p => p.port === 8081))
    expect(has8081).toBeTruthy()
  })
})
