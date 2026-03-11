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
}
