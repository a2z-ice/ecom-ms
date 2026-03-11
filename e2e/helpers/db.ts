/**
 * Direct database query helpers for E2E test assertions.
 * Used for CDC pipeline tests — polls analytics DB directly via kubectl exec.
 * Avoids the need for a NodePort service on analytics-db.
 */
import { execFileSync } from 'child_process'

const ANALYTICS_NAMESPACE = 'analytics'
const ANALYTICS_DB_USER = process.env.ANALYTICS_DB_USER ?? 'postgres'
const ANALYTICS_DB_NAME = process.env.ANALYTICS_DB_NAME ?? 'analyticsdb'

/**
 * Resolve the CNPG primary pod name for a given cluster.
 * Falls back to `deployment/<cluster>` for backward compatibility.
 */
export function getCnpgPrimaryPod(namespace: string, cluster: string): string {
  try {
    return execFileSync('kubectl', [
      'get', 'pod', '-n', namespace,
      '-l', `cnpg.io/cluster=${cluster},cnpg.io/instanceRole=primary`,
      '-o', 'jsonpath={.items[0].metadata.name}',
    ], { encoding: 'utf-8', timeout: 10_000 }).trim()
  } catch {
    // Fallback for non-CNPG environments
    return ''
  }
}

/**
 * Runs a SQL query inside the analytics-db pod via kubectl exec.
 * Parameters are substituted by replacing $1, $2, ... with quoted values.
 * Safe for read-only queries with trusted inputs (UUIDs from test context).
 */
export async function queryAnalyticsDb<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  // Replace positional params $1, $2, ... with quoted string values
  let query = sql
  params.forEach((param, i) => {
    const escaped = String(param).replace(/'/g, "''")
    query = query.replace(new RegExp(`\\$${i + 1}`, 'g'), `'${escaped}'`)
  })

  // Wrap in json_agg so psql returns a single JSON array
  const jsonQuery = `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${query}) t`

  try {
    // Resolve CNPG primary pod for analytics-db
    const primaryPod = getCnpgPrimaryPod(ANALYTICS_NAMESPACE, 'analytics-db')
    const podTarget = primaryPod ? primaryPod : 'deployment/analytics-db'

    // Use execFileSync (no shell) so SQL with parens/quotes is passed directly
    const output = execFileSync('kubectl', [
      'exec', '-n', ANALYTICS_NAMESPACE,
      podTarget, '--',
      'psql', '-U', ANALYTICS_DB_USER, ANALYTICS_DB_NAME,
      '-t', '-A', '-c', jsonQuery,
    ], { encoding: 'utf-8', timeout: 15_000 }).trim()
    return JSON.parse(output) as T[]
  } catch {
    return []
  }
}

/**
 * Polls a query until it returns at least one row or maxWaitMs is exceeded.
 * Uses 1-second intervals — never a fixed sleep.
 */
export async function pollUntilFound<T>(
  sql: string,
  params: unknown[],
  maxWaitMs = 30_000,
): Promise<T[]> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    const rows = await queryAnalyticsDb<T>(sql, params)
    if (rows.length > 0) return rows
    await new Promise(r => setTimeout(r, 1_000))
  }
  throw new Error(`pollUntilFound timed out after ${maxWaitMs}ms. SQL: ${sql}`)
}
