/**
 * Search E2E Tests
 * Covers book search by title keyword, author name, and zero-results state.
 */
import { test, expect } from './fixtures/base'

test.describe('Search', () => {

  test('finds books by title keyword', async ({ page }) => {
    await page.goto('/search')
    await page.screenshot({ path: 'screenshots/search-01-empty-search-page.png', fullPage: true })

    await page.getByPlaceholder(/search/i).fill('Python')
    await page.getByRole('button', { name: /search/i }).click()

    await expect(page.getByText(/result/i)).toBeVisible()
    await expect(page.getByText(/Python/i).first()).toBeVisible()
    await page.screenshot({ path: 'screenshots/search-02-results-by-title.png', fullPage: true })
  })

  test('finds books by author name', async ({ page }) => {
    await page.goto('/search')
    await page.getByPlaceholder(/search/i).fill('Martin Kleppmann')
    await page.screenshot({ path: 'screenshots/search-03-author-query-entered.png', fullPage: true })

    await page.getByRole('button', { name: /search/i }).click()
    await expect(page.getByText(/Designing Data/i)).toBeVisible()
    await page.screenshot({ path: 'screenshots/search-04-results-by-author.png', fullPage: true })
  })

  test('shows zero results message for unknown query', async ({ page }) => {
    await page.goto('/search')
    await page.getByPlaceholder(/search/i).fill('xyznotabook9999')
    await page.getByRole('button', { name: /search/i }).click()

    await expect(page.getByText(/0 result/i)).toBeVisible()
    await page.screenshot({ path: 'screenshots/search-05-no-results.png', fullPage: true })
  })
})
