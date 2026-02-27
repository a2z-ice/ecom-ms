import { test, expect } from '@playwright/test';

// Kiali runs on port 32100 (NodePort via kiali-proxy Docker container)
const KIALI_URL = 'http://localhost:32100/kiali';

test.describe('Kiali observability dashboard', () => {
  test('Kiali login page or dashboard loads', async ({ page }) => {
    await page.goto(KIALI_URL, { timeout: 15000 });
    // Kiali may show login page or go directly to graph
    await expect(page).toHaveURL(/kiali/);
    // Page should not be a connection refused error
    await expect(page.locator('body')).not.toContainText('ERR_CONNECTION_REFUSED');
  });

  test('Kiali graph section is accessible', async ({ page }) => {
    await page.goto(`${KIALI_URL}/graph/namespaces`, { timeout: 20000 });
    // Should load without "Prometheus not reachable" banner
    await expect(page.locator('body')).not.toContainText('Prometheus is not reachable');
    await expect(page.locator('body')).not.toContainText('unreachable');
  });

  test('Kiali can reach Prometheus (no error alert)', async ({ page }) => {
    await page.goto(KIALI_URL, { timeout: 15000 });
    // Wait for any initial loading
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    // Check for Prometheus error messages that indicate the alias is broken
    const errorText = page.locator('[class*="alert"], [class*="Alert"], [class*="warning"]');
    const count = await errorText.count();
    for (let i = 0; i < count; i++) {
      const text = await errorText.nth(i).textContent();
      expect(text).not.toMatch(/prometheus.*unreachable|cannot.*connect.*prometheus/i);
    }
  });
});
