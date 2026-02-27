import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,   // Run sequentially to avoid auth state conflicts
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  globalSetup: './global-setup.ts',
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
    ['junit', { outputFile: 'playwright-report/results.xml' }],
  ],

  use: {
    baseURL: 'http://localhost:30000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },

  projects: [
    // Auth setup — runs first, saves state to file
    {
      name: 'auth-setup',
      testMatch: /fixtures\/auth\.setup\.ts/,
    },
    // All other tests — depend on auth setup
    {
      name: 'tests',
      testMatch: /(?<!setup)\.spec\.ts/,
      dependencies: ['auth-setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'fixtures/user1.json',
      },
    },
  ],
})
