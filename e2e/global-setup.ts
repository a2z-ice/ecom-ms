import * as fs from 'fs'
import { execFileSync } from 'child_process'

/** Resolve CNPG primary pod name for kubectl exec */
function getCnpgPrimaryPod(namespace: string, cluster: string): string {
  try {
    return execFileSync('kubectl', [
      'get', 'pod', '-n', namespace,
      '-l', `cnpg.io/cluster=${cluster},cnpg.io/instanceRole=primary`,
      '-o', 'jsonpath={.items[0].metadata.name}',
    ], { encoding: 'utf-8', timeout: 10_000 }).trim()
  } catch {
    return ''
  }
}

/**
 * Global setup: runs once before all test projects.
 *
 * Resets database state so every test run starts fresh:
 *   1. Inventory: quantity=50, reserved=0 for all books
 *   2. Cart: delete all cart items from ecom-db
 *   3. Screenshots directory creation
 */
export default function globalSetup() {
  if (!fs.existsSync('screenshots')) {
    fs.mkdirSync('screenshots', { recursive: true })
  }

  console.log('[global-setup] Resetting database state for clean test run...')

  // Resolve CNPG primary pods
  const inventoryPod = getCnpgPrimaryPod('inventory', 'inventory-db') || 'deploy/inventory-db'
  const ecomPod = getCnpgPrimaryPod('ecom', 'ecom-db') || 'deploy/ecom-db'

  // Reset inventory stock to 50 units, 0 reserved for all books
  try {
    execFileSync('kubectl', [
      'exec', '-n', 'inventory', inventoryPod, '--',
      'psql', '-U', 'postgres', '-d', 'inventorydb',
      '-c', 'UPDATE inventory SET quantity = 50, reserved = 0;',
    ], { encoding: 'utf-8', timeout: 15_000 })
    console.log('[global-setup] ✓ Inventory reset (quantity=50, reserved=0)')
  } catch (e) {
    console.warn('[global-setup] ⚠ Failed to reset inventory:', (e as Error).message)
  }

  // Clear all cart items from ecom-db
  try {
    execFileSync('kubectl', [
      'exec', '-n', 'ecom', ecomPod, '--',
      'psql', '-U', 'postgres', '-d', 'ecomdb',
      '-c', 'DELETE FROM cart_items;',
    ], { encoding: 'utf-8', timeout: 15_000 })
    console.log('[global-setup] ✓ Cart items cleared')
  } catch (e) {
    console.warn('[global-setup] ⚠ Failed to clear cart items:', (e as Error).message)
  }

  console.log('[global-setup] Database reset complete.')

  // ── Flink CDC Pipeline Health Check ──────────────────────────────────
  // If Flink streaming jobs are missing (e.g., after Docker restart),
  // auto-resubmit them by deleting the old Job and re-applying.
  ensureFlinkJobsRunning()
}

function ensureFlinkJobsRunning() {
  const FLINK_URL = 'http://localhost:32200'
  const REQUIRED_JOBS = 4

  try {
    // Check how many Flink jobs are RUNNING
    const jobsResp = execFileSync('curl', ['-sf', '--max-time', '5', `${FLINK_URL}/jobs`], {
      encoding: 'utf-8',
      timeout: 10_000,
    })
    const jobs = JSON.parse(jobsResp)
    const running = (jobs.jobs || []).filter((j: any) => j.status === 'RUNNING')

    if (running.length >= REQUIRED_JOBS) {
      console.log(`[global-setup] ✓ Flink CDC pipeline healthy (${running.length}/${REQUIRED_JOBS} jobs RUNNING)`)
      return
    }

    console.log(`[global-setup] ⚠ Only ${running.length}/${REQUIRED_JOBS} Flink jobs RUNNING — resubmitting pipeline...`)
  } catch {
    console.log('[global-setup] ⚠ Flink unreachable — attempting pipeline resubmission...')
  }

  // Delete old Job (if exists) and re-apply
  try {
    execFileSync('kubectl', ['delete', 'job', 'flink-sql-runner', '-n', 'analytics', '--ignore-not-found'], {
      encoding: 'utf-8',
      timeout: 30_000,
    })
    execFileSync('kubectl', ['apply', '-f', 'infra/flink/flink-sql-runner.yaml'], {
      encoding: 'utf-8',
      timeout: 15_000,
    })
    console.log('[global-setup] Flink SQL runner job resubmitted. Waiting for completion...')

    // Wait up to 90 seconds for the Job to complete
    execFileSync('kubectl', [
      'wait', '--for=condition=complete', 'job/flink-sql-runner', '-n', 'analytics', '--timeout=90s',
    ], { encoding: 'utf-8', timeout: 100_000 })

    // Verify jobs are running
    const verifyResp = execFileSync('curl', ['-sf', '--max-time', '5', 'http://localhost:32200/jobs'], {
      encoding: 'utf-8',
      timeout: 10_000,
    })
    const verifyJobs = JSON.parse(verifyResp)
    const nowRunning = (verifyJobs.jobs || []).filter((j: any) => j.status === 'RUNNING')
    console.log(`[global-setup] ✓ Flink pipeline resubmitted (${nowRunning.length}/${REQUIRED_JOBS} jobs RUNNING)`)

    // Wait for initial CDC data to flow through (Debezium snapshot → Kafka → Flink → analytics DB)
    console.log('[global-setup] Waiting for CDC data to propagate to analytics DB...')
    waitForAnalyticsData()
  } catch (e) {
    console.warn('[global-setup] ⚠ Flink pipeline resubmission failed:', (e as Error).message)
    console.warn('[global-setup]   CDC-dependent tests may fail. Run: kubectl delete job flink-sql-runner -n analytics && kubectl apply -f infra/flink/flink-sql-runner.yaml')
  }
}

/** Poll analytics DB until dim_books has data (Flink CDC snapshot complete). */
function waitForAnalyticsData() {
  const analyticsPod = getCnpgPrimaryPod('analytics', 'analytics-db') || 'deploy/analytics-db'
  const maxAttempts = 12 // 12 * 5s = 60s
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = execFileSync('kubectl', [
        'exec', '-n', 'analytics', analyticsPod, '--',
        'psql', '-U', 'postgres', '-d', 'analyticsdb', '-t', '-c',
        'SELECT count(*) FROM dim_books;',
      ], { encoding: 'utf-8', timeout: 10_000 }).trim()
      const count = parseInt(result, 10)
      if (count > 0) {
        console.log(`[global-setup] ✓ Analytics data available (${count} books in dim_books)`)
        return
      }
    } catch { /* ignore */ }
    if (i < maxAttempts - 1) {
      console.log(`[global-setup]   Waiting for analytics data... (${i + 1}/${maxAttempts})`)
      execFileSync('sleep', ['5'])
    }
  }
  console.warn('[global-setup] ⚠ Analytics data not yet available — CDC/Superset tests may be affected')
}
