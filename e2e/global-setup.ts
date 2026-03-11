import * as fs from 'fs'
import { execFileSync } from 'child_process'

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

  // Reset inventory stock to 50 units, 0 reserved for all books
  try {
    execFileSync('kubectl', [
      'exec', '-n', 'inventory', 'deploy/inventory-db', '--',
      'psql', '-U', 'inventoryuser', '-d', 'inventorydb',
      '-c', 'UPDATE inventory SET quantity = 50, reserved = 0;',
    ], { encoding: 'utf-8', timeout: 15_000 })
    console.log('[global-setup] ✓ Inventory reset (quantity=50, reserved=0)')
  } catch (e) {
    console.warn('[global-setup] ⚠ Failed to reset inventory:', (e as Error).message)
  }

  // Clear all cart items from ecom-db
  try {
    execFileSync('kubectl', [
      'exec', '-n', 'ecom', 'deploy/ecom-db', '--',
      'psql', '-U', 'ecomuser', '-d', 'ecomdb',
      '-c', 'DELETE FROM cart_items;',
    ], { encoding: 'utf-8', timeout: 15_000 })
    console.log('[global-setup] ✓ Cart items cleared')
  } catch (e) {
    console.warn('[global-setup] ⚠ Failed to clear cart items:', (e as Error).message)
  }

  console.log('[global-setup] Database reset complete.')
}
