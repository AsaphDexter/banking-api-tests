import { defineConfig } from '@playwright/test';

/**
 * API tests only: no browser is needed.
 * The API address comes from API_URL (default http://localhost:8080).
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0, // a flaky API test is a bug to fix, not something to retry away
  workers: process.env.CI ? 4 : undefined,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],
  use: {
    baseURL: process.env.API_URL ?? 'http://localhost:8080',
  },
});
