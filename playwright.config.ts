import { defineConfig } from '@playwright/test';

/**
 * API tests only: no browser is needed.
 *
 * Three instances of the banking API are used because some behaviour can only be tested
 * with special settings:
 *   api            API_URL                    normal settings, admin token set, per-client login limit raised
 *   short-lockout  API_URL_SHORT_LOCKOUT      accounts lock for only 2 seconds, so expiry can be tested
 *   throttle       API_URL_THROTTLED          login limit of 5 failures per client
 * If the last two are not running, their specs are skipped and everything else still runs.
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
  projects: [
    {
      name: 'api',
      testIgnore: ['**/short-lockout.spec.ts', '**/throttle.spec.ts'],
      use: { baseURL: process.env.API_URL ?? 'http://localhost:8080' },
    },
    {
      name: 'short-lockout',
      testMatch: '**/short-lockout.spec.ts',
      use: { baseURL: process.env.API_URL_SHORT_LOCKOUT ?? 'http://localhost:8081' },
    },
    {
      name: 'throttle',
      testMatch: '**/throttle.spec.ts',
      use: { baseURL: process.env.API_URL_THROTTLED ?? 'http://localhost:8082' },
    },
  ],
});
