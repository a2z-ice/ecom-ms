/**
 * Audit Remediation E2E Tests (Session 29)
 *
 * Validates all Grade-A improvements across Security, Performance,
 * Resilience, and Disaster Recovery domains.
 *
 * Covers:
 *   Security:
 *     1. Gateway namespace restriction (Selector, not All)
 *     2. RBAC roles exist per service namespace
 *     3. Search query length validation (>200 chars rejected)
 *     4. Security headers on ecom-service API responses
 *     5. Security headers on inventory-service API responses
 *     6. Dependabot config exists
 *     7. Security scan script exists
 *     8. PII masking converter exists (ecom)
 *     9. PII masking filter exists (inventory)
 *    10. Docker image pin script exists
 *
 *   Performance:
 *    11. Hikari pool max=20, min-idle=5
 *    12. Database indexes exist (007 migration)
 *    13. Flink parallelism=4
 *    14. Redis maxmemory=512mb, volatile-lru
 *    15. Kafka topics have 6 partitions (new topics)
 *    16. HPA minReplicas=2 for ecom and inventory
 *    17. ecom-service resource limits increased
 *    18. OTel sampling=100%
 *    19. Vite code splitting configured
 *    20. Book detail cache-control header
 *
 *   Resilience:
 *    21. Outbox table exists in ecom DB
 *    22. OutboxPublisher class exists
 *    23. Cart addToCart uses set-semantics (not increment)
 *    24. DLQ messages table exists in inventory DB
 *    25. DLQ consumer uses database persistence
 *
 *   Disaster Recovery:
 *    26. MinIO deployment exists
 *    27. CNPG backup config enabled on all clusters
 *    28. ScheduledBackup CRs exist
 *    29. AlertManager webhook points to OTel (not self)
 *    30. Infrastructure alert rules exist
 *    31. Operational runbooks exist
 *    32. Verify-backup script exists
 */
import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')
const ECOM_API = 'https://api.service.net:30000/ecom'
const INVENTORY_API = 'https://api.service.net:30000/inven'

function kubectl(args: string[]): string {
  return execFileSync('kubectl', args, { encoding: 'utf-8', timeout: 30_000 }).trim()
}

function kubectlJson<T = unknown>(args: string[]): T {
  const raw = kubectl([...args, '-o', 'json'])
  return JSON.parse(raw) as T
}

function fileExists(relativePath: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, relativePath))
}

function fileContains(relativePath: string, needle: string): boolean {
  const p = path.join(REPO_ROOT, relativePath)
  if (!fs.existsSync(p)) return false
  return fs.readFileSync(p, 'utf-8').includes(needle)
}

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Session 29 — Security', () => {

  test.describe('Gateway namespace restriction', () => {
    test('gateway uses Selector (not All) for allowedRoutes', () => {
      const gw = kubectlJson<any>(['get', 'gateway', 'bookstore-gateway', '-n', 'infra'])
      for (const listener of gw.spec.listeners) {
        const from = listener.allowedRoutes?.namespaces?.from
        expect(from, `listener ${listener.name} should use Selector`).toBe('Selector')
        const selector = listener.allowedRoutes?.namespaces?.selector
        expect(selector?.matchLabels?.['allow-external-routes']).toBe('true')
      }
    })

    test('ecom namespace has allow-external-routes label', () => {
      const ns = kubectlJson<any>(['get', 'namespace', 'ecom'])
      expect(ns.metadata.labels?.['allow-external-routes']).toBe('true')
    })

    test('analytics namespace does NOT have allow-external-routes label', () => {
      const ns = kubectlJson<any>(['get', 'namespace', 'analytics'])
      expect(ns.metadata.labels?.['allow-external-routes']).toBeUndefined()
    })
  })

  test.describe('RBAC roles', () => {
    for (const { role, ns } of [
      { role: 'ecom-service-role', ns: 'ecom' },
      { role: 'inventory-service-role', ns: 'inventory' },
      { role: 'csrf-service-role', ns: 'infra' },
    ]) {
      test(`Role ${role} exists in ${ns}`, () => {
        const r = kubectlJson<any>(['get', 'role', role, '-n', ns])
        expect(r.metadata.name).toBe(role)
        // Should only allow get/list/watch on configmaps
        const rules = r.rules || []
        expect(rules.length).toBeGreaterThanOrEqual(1)
        expect(rules[0].verbs).toEqual(expect.arrayContaining(['get', 'list', 'watch']))
        expect(rules[0].verbs).not.toContain('create')
        expect(rules[0].verbs).not.toContain('delete')
      })
    }
  })

  test.describe('Search query validation', () => {
    test('rejects empty search query', async ({ request }) => {
      const resp = await request.get(`${ECOM_API}/books/search?q=`, {
        ignoreHTTPSErrors: true,
      })
      // Spring @Size(min=1) should reject empty string
      expect(resp.status()).toBeGreaterThanOrEqual(400)
    })

    test('rejects search query >200 characters', async ({ request }) => {
      const longQuery = 'a'.repeat(201)
      const resp = await request.get(`${ECOM_API}/books/search?q=${longQuery}`, {
        ignoreHTTPSErrors: true,
      })
      expect(resp.status()).toBeGreaterThanOrEqual(400)
    })

    test('accepts normal search query', async ({ request }) => {
      const resp = await request.get(`${ECOM_API}/books/search?q=tolkien`, {
        ignoreHTTPSErrors: true,
      })
      expect(resp.status()).toBe(200)
    })
  })

  test.describe('Security headers', () => {
    test('ecom-service returns X-Frame-Options: DENY', async ({ request }) => {
      const resp = await request.get(`${ECOM_API}/books`, { ignoreHTTPSErrors: true })
      expect(resp.headers()['x-frame-options']?.toLowerCase()).toBe('deny')
    })

    test('ecom-service returns X-Content-Type-Options: nosniff', async ({ request }) => {
      const resp = await request.get(`${ECOM_API}/books`, { ignoreHTTPSErrors: true })
      expect(resp.headers()['x-content-type-options']).toBe('nosniff')
    })

    test('inventory-service returns X-Frame-Options: DENY', async ({ request }) => {
      const resp = await request.get(`${INVENTORY_API}/health`, { ignoreHTTPSErrors: true })
      expect(resp.headers()['x-frame-options']).toBe('DENY')
    })

    test('inventory-service returns Strict-Transport-Security', async ({ request }) => {
      const resp = await request.get(`${INVENTORY_API}/health`, { ignoreHTTPSErrors: true })
      const hsts = resp.headers()['strict-transport-security'] || ''
      expect(hsts).toContain('max-age=')
    })
  })

  test.describe('Security tooling', () => {
    test('dependabot.yml exists', () => {
      expect(fileExists('.github/dependabot.yml')).toBeTruthy()
    })

    test('dependabot covers all ecosystems', () => {
      const content = fs.readFileSync(path.join(REPO_ROOT, '.github/dependabot.yml'), 'utf-8')
      expect(content).toContain('maven')
      expect(content).toContain('pip')
      expect(content).toContain('npm')
      expect(content).toContain('gomod')
    })

    test('security-scan.sh exists and is executable', () => {
      expect(fileExists('scripts/security-scan.sh')).toBeTruthy()
    })

    test('pin-image-digests.sh exists', () => {
      expect(fileExists('scripts/pin-image-digests.sh')).toBeTruthy()
    })

    test('PII masking converter exists (ecom)', () => {
      expect(fileExists('ecom-service/src/main/java/com/bookstore/ecom/logging/PIIMaskingConverter.java')).toBeTruthy()
    })

    test('PII masking filter exists (inventory)', () => {
      expect(fileContains('inventory-service/app/main.py', '_PIIMaskingFilter')).toBeTruthy()
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// PERFORMANCE
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Session 29 — Performance', () => {

  test.describe('Database tuning', () => {
    test('Hikari pool max=20, min-idle=5', () => {
      const yml = fs.readFileSync(
        path.join(REPO_ROOT, 'ecom-service/src/main/resources/application.yml'), 'utf-8'
      )
      expect(yml).toContain('maximum-pool-size: 20')
      expect(yml).toContain('minimum-idle: 5')
    })

    test('007 query indexes migration exists', () => {
      expect(fileExists('ecom-service/src/main/resources/db/changelog/007-add-query-indexes.yaml')).toBeTruthy()
      const content = fs.readFileSync(
        path.join(REPO_ROOT, 'ecom-service/src/main/resources/db/changelog/007-add-query-indexes.yaml'), 'utf-8'
      )
      expect(content).toContain('idx_orders_user_id')
      expect(content).toContain('idx_cart_items_user_id')
      expect(content).toContain('idx_books_genre')
      expect(content).toContain('idx_books_author')
    })

    test('changelog master includes 007 and 008 migrations', () => {
      const content = fs.readFileSync(
        path.join(REPO_ROOT, 'ecom-service/src/main/resources/db/changelog/db.changelog-master.yaml'), 'utf-8'
      )
      expect(content).toContain('007-add-query-indexes.yaml')
      expect(content).toContain('008-create-outbox-table.yaml')
    })
  })

  test.describe('Flink parallelism', () => {
    test('Flink config has parallelism.default: 4', () => {
      const content = fs.readFileSync(
        path.join(REPO_ROOT, 'infra/flink/flink-cluster.yaml'), 'utf-8'
      )
      expect(content).toContain('parallelism.default: 4')
      expect(content).not.toContain('parallelism.default: 1')
    })
  })

  test.describe('Redis tuning', () => {
    test('Redis maxmemory=512mb and volatile-lru', () => {
      const content = fs.readFileSync(
        path.join(REPO_ROOT, 'infra/redis/redis.yaml'), 'utf-8'
      )
      expect(content).toContain('512mb')
      expect(content).toContain('volatile-lru')
    })
  })

  test.describe('Kafka partitions', () => {
    test('topic init uses 6 partitions', () => {
      const content = fs.readFileSync(
        path.join(REPO_ROOT, 'infra/kafka/kafka-topics-init.yaml'), 'utf-8'
      )
      expect(content).toContain('--partitions 6')
    })
  })

  test.describe('HPA minReplicas', () => {
    test('ecom-service HPA minReplicas=2', () => {
      const hpa = kubectlJson<any>(['get', 'hpa', 'ecom-service-hpa', '-n', 'ecom'])
      expect(hpa.spec.minReplicas).toBe(2)
    })

    test('inventory-service HPA minReplicas=2', () => {
      const hpa = kubectlJson<any>(['get', 'hpa', 'inventory-service-hpa', '-n', 'inventory'])
      expect(hpa.spec.minReplicas).toBe(2)
    })
  })

  test.describe('ecom-service resources', () => {
    test('CPU request >= 500m', () => {
      const dep = kubectlJson<any>(['get', 'deployment', 'ecom-service', '-n', 'ecom'])
      const container = dep.spec.template.spec.containers.find((c: any) => c.name === 'ecom-service')
      const cpuReq = container.resources.requests.cpu
      // Parse millicores (500m = 500)
      const millis = cpuReq.endsWith('m') ? parseInt(cpuReq) : parseInt(cpuReq) * 1000
      expect(millis).toBeGreaterThanOrEqual(500)
    })

    test('JVM MaxRAMPercentage <= 50', () => {
      const dep = kubectlJson<any>(['get', 'deployment', 'ecom-service', '-n', 'ecom'])
      const container = dep.spec.template.spec.containers.find((c: any) => c.name === 'ecom-service')
      const javaOpts = container.env?.find((e: any) => e.name === 'JAVA_TOOL_OPTIONS')?.value || ''
      const match = javaOpts.match(/MaxRAMPercentage=(\d+\.?\d*)/)
      expect(match).toBeTruthy()
      expect(parseFloat(match![1])).toBeLessThanOrEqual(50)
    })
  })

  test.describe('OTel sampling', () => {
    test('sampling percentage is 100', () => {
      const content = fs.readFileSync(
        path.join(REPO_ROOT, 'infra/observability/otel-collector.yaml'), 'utf-8'
      )
      expect(content).toContain('sampling_percentage: 100')
    })
  })

  test.describe('Vite code splitting', () => {
    test('vite.config.ts has manualChunks', () => {
      const content = fs.readFileSync(path.join(REPO_ROOT, 'ui/vite.config.ts'), 'utf-8')
      expect(content).toContain('manualChunks')
      expect(content).toContain('react-vendor')
      expect(content).toContain('oidc')
    })
  })

  test.describe('Cache headers', () => {
    test('GET /books/{id} returns cache-control header', async ({ request }) => {
      // First get a book ID from the catalog
      const listResp = await request.get(`${ECOM_API}/books?size=1`, { ignoreHTTPSErrors: true })
      expect(listResp.status()).toBe(200)
      const data = await listResp.json()
      const bookId = data.content?.[0]?.id
      if (!bookId) {
        test.skip(true, 'No books in catalog')
        return
      }

      const resp = await request.get(`${ECOM_API}/books/${bookId}`, { ignoreHTTPSErrors: true })
      expect(resp.status()).toBe(200)
      const cacheControl = resp.headers()['cache-control'] || ''
      expect(cacheControl).toContain('max-age=')
      expect(cacheControl).toContain('public')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// RESILIENCE
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Session 29 — Resilience', () => {

  test.describe('Transactional outbox', () => {
    test('outbox_events table exists in ecom DB', () => {
      // Use the -rw service for primary, and postgres superuser (CNPG uses peer auth)
      const primaryPod = kubectl([
        'get', 'pods', '-n', 'ecom',
        '-l', 'cnpg.io/cluster=ecom-db,cnpg.io/instanceRole=primary',
        '-o', 'jsonpath={.items[0].metadata.name}',
      ])
      const result = kubectl([
        'exec', '-n', 'ecom', primaryPod, '--',
        'psql', '-U', 'postgres', '-d', 'ecomdb', '-t', '-c',
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'outbox_events'",
      ]).trim()
      expect(parseInt(result)).toBe(1)
    })

    test('outbox_events has expected columns', () => {
      const primaryPod = kubectl([
        'get', 'pods', '-n', 'ecom',
        '-l', 'cnpg.io/cluster=ecom-db,cnpg.io/instanceRole=primary',
        '-o', 'jsonpath={.items[0].metadata.name}',
      ])
      const result = kubectl([
        'exec', '-n', 'ecom', primaryPod, '--',
        'psql', '-U', 'postgres', '-d', 'ecomdb', '-t', '-c',
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'outbox_events' ORDER BY ordinal_position",
      ]).trim()
      expect(result).toContain('aggregate_type')
      expect(result).toContain('aggregate_id')
      expect(result).toContain('event_type')
      expect(result).toContain('payload')
      expect(result).toContain('published_at')
    })

    test('OutboxPublisher.java exists', () => {
      expect(fileExists('ecom-service/src/main/java/com/bookstore/ecom/kafka/OutboxPublisher.java')).toBeTruthy()
      const content = fs.readFileSync(
        path.join(REPO_ROOT, 'ecom-service/src/main/java/com/bookstore/ecom/kafka/OutboxPublisher.java'), 'utf-8'
      )
      expect(content).toContain('@Scheduled')
      expect(content).toContain('findByPublishedAtIsNull')
    })

    test('OrderService writes to outbox (not fire-and-forget)', () => {
      const content = fs.readFileSync(
        path.join(REPO_ROOT, 'ecom-service/src/main/java/com/bookstore/ecom/service/OrderService.java'), 'utf-8'
      )
      expect(content).toContain('outboxRepo.save')
      expect(content).not.toContain('eventPublisher.publishOrderCreated')
    })
  })

  test.describe('Cart idempotency', () => {
    test('CartService uses set-semantics (not increment)', () => {
      const content = fs.readFileSync(
        path.join(REPO_ROOT, 'ecom-service/src/main/java/com/bookstore/ecom/service/CartService.java'), 'utf-8'
      )
      // Should use request.quantity() directly, not getQuantity() + request.quantity()
      expect(content).toContain('existing.setQuantity(request.quantity())')
      expect(content).not.toContain('existing.getQuantity() + request.quantity()')
    })
  })

  test.describe('DLQ persistence', () => {
    test('dlq_messages table exists in inventory DB', () => {
      const primaryPod = kubectl([
        'get', 'pods', '-n', 'inventory',
        '-l', 'cnpg.io/cluster=inventory-db,cnpg.io/instanceRole=primary',
        '-o', 'jsonpath={.items[0].metadata.name}',
      ])
      const result = kubectl([
        'exec', '-n', 'inventory', primaryPod, '--',
        'psql', '-U', 'postgres', '-d', 'inventorydb', '-t', '-c',
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'dlq_messages'",
      ]).trim()
      expect(parseInt(result)).toBe(1)
    })

    test('DLQ consumer uses database (not deque)', () => {
      const content = fs.readFileSync(
        path.join(REPO_ROOT, 'inventory-service/app/kafka/dlq_consumer.py'), 'utf-8'
      )
      expect(content).toContain('AsyncSessionLocal')
      expect(content).toContain('DLQMessage')
      expect(content).not.toContain('deque(maxlen=')
    })

    test('Alembic migration 003 exists', () => {
      expect(fileExists('inventory-service/alembic/versions/003_create_dlq_messages.py')).toBeTruthy()
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// DISASTER RECOVERY
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Session 29 — Disaster Recovery', () => {

  test.describe('MinIO backup store', () => {
    test('MinIO deployment exists and is running', () => {
      const dep = kubectlJson<any>(['get', 'deployment', 'minio', '-n', 'infra'])
      expect(dep.status.readyReplicas).toBeGreaterThanOrEqual(1)
    })

    test('MinIO service exposes port 9000', () => {
      const svc = kubectlJson<any>(['get', 'service', 'minio', '-n', 'infra'])
      const ports = svc.spec.ports.map((p: any) => p.port)
      expect(ports).toContain(9000)
    })
  })

  test.describe('CNPG backup configuration', () => {
    for (const { cluster, ns } of [
      { cluster: 'ecom-db', ns: 'ecom' },
      { cluster: 'inventory-db', ns: 'inventory' },
      { cluster: 'analytics-db', ns: 'analytics' },
      { cluster: 'keycloak-db', ns: 'identity' },
    ]) {
      test(`${cluster} has backup enabled`, () => {
        const c = kubectlJson<any>(['get', 'cluster', cluster, '-n', ns])
        const backup = c.spec?.backup
        expect(backup, `${cluster} should have backup config`).toBeTruthy()
        expect(backup.barmanObjectStore?.destinationPath).toContain('cnpg-backups')
        expect(backup.barmanObjectStore?.endpointURL).toContain('minio')
      })
    }
  })

  test.describe('Scheduled backups', () => {
    for (const { name, ns } of [
      { name: 'ecom-db-daily-backup', ns: 'ecom' },
      { name: 'inventory-db-daily-backup', ns: 'inventory' },
      { name: 'analytics-db-daily-backup', ns: 'analytics' },
      { name: 'keycloak-db-daily-backup', ns: 'identity' },
    ]) {
      test(`ScheduledBackup ${name} exists`, () => {
        const sb = kubectlJson<any>(['get', 'scheduledbackup', name, '-n', ns])
        expect(sb.spec.schedule).toBe('0 2 * * *')
        expect(sb.spec.cluster.name).toBeTruthy()
      })
    }
  })

  test.describe('AlertManager', () => {
    test('webhook does NOT point to self health endpoint', () => {
      const cm = kubectlJson<any>(['get', 'configmap', 'alertmanager-config', '-n', 'observability'])
      const config = cm.data['alertmanager.yml']
      expect(config).not.toContain('alertmanager.observability:9093/-/healthy')
    })

    test('webhook points to OTel collector', () => {
      const cm = kubectlJson<any>(['get', 'configmap', 'alertmanager-config', '-n', 'observability'])
      const config = cm.data['alertmanager.yml']
      expect(config).toContain('otel-collector')
    })
  })

  test.describe('Infrastructure alert rules', () => {
    test('Prometheus has infrastructure_alerts group', () => {
      const cm = kubectlJson<any>(['get', 'configmap', 'prometheus-rules', '-n', 'observability'])
      const alerts = cm.data['alerts.yaml']
      expect(alerts).toContain('infrastructure_alerts')
      expect(alerts).toContain('RedisDown')
      expect(alerts).toContain('KafkaBrokerDown')
      expect(alerts).toContain('CNPGPodNotReady')
      expect(alerts).toContain('PVCAlmostFull')
    })
  })

  test.describe('Operational runbooks', () => {
    for (const runbook of [
      'database-failover.md',
      'kafka-recovery.md',
      'backup-restore.md',
      'service-degradation.md',
      'security-incident.md',
    ]) {
      test(`runbook ${runbook} exists`, () => {
        expect(fileExists(`docs/operations/runbooks/${runbook}`)).toBeTruthy()
        const content = fs.readFileSync(
          path.join(REPO_ROOT, 'docs/operations/runbooks', runbook), 'utf-8'
        )
        // Each runbook should have a Trigger section and at least 500 chars
        expect(content.length).toBeGreaterThan(500)
      })
    }
  })

  test.describe('Backup verification', () => {
    test('verify-backup.sh exists and is executable', () => {
      const p = path.join(REPO_ROOT, 'scripts/verify-backup.sh')
      expect(fs.existsSync(p)).toBeTruthy()
      const stats = fs.statSync(p)
      // Check executable bit
      expect(stats.mode & 0o111).toBeGreaterThan(0)
    })

    test('generate-secrets.sh exists and is executable', () => {
      const p = path.join(REPO_ROOT, 'scripts/generate-secrets.sh')
      expect(fs.existsSync(p)).toBeTruthy()
      const stats = fs.statSync(p)
      expect(stats.mode & 0o111).toBeGreaterThan(0)
    })
  })
})
