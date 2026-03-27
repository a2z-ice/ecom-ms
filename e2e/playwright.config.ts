import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,   // Run sequentially to avoid auth state conflicts
  forbidOnly: !!process.env.CI,
  retries: 1,   // 1 retry handles cold-start flakes on fresh cluster deploys
  workers: 1,
  globalSetup: './global-setup.ts',
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
    ['junit', { outputFile: 'playwright-report/results.xml' }],
  ],

  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: 'https://localhost:30000',
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  },

  projects: [
    // Auth setup — runs first, saves state to file
    {
      name: 'auth-setup',
      testMatch: /fixtures\/auth\.setup\.ts/,
    },
    // Admin auth setup — runs after auth-setup, saves admin1 state
    {
      name: 'admin-setup',
      testMatch: /fixtures\/admin\.setup\.ts/,
      dependencies: ['auth-setup'],
    },
    // All non-admin tests — depend on auth setup
    {
      name: 'tests',
      testMatch: /(?<!admin)(?<!setup)\.spec\.ts/,
      dependencies: ['auth-setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'fixtures/user1.json',
      },
    },
    // Admin tests — depend on admin auth setup
    {
      name: 'admin-tests',
      testMatch: /admin\.spec\.ts/,
      dependencies: ['admin-setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'fixtures/admin1.json',
      },
    },
  ],
})
