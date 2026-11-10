import { request } from '@playwright/test';

/**
 * Runs once before all tests. It checks that the main API instance is running with the settings the suite needs,
 * and stops with one clear message if not, instead of hundreds of confusing failures.
 * Set SKIP_PREFLIGHT=1 to skip it (for example when running only the throttle project).
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.SKIP_PREFLIGHT) {
    return;
  }
  const baseURL = process.env.API_URL ?? 'http://localhost:8080';
  const adminToken = process.env.ADMIN_TOKEN ?? 'playwright-admin-token-123456';
  const fix = `\n\nStart the main API instance with these program arguments, then run the tests again:\n`
    + `  --memory --port 8080 --admin-token ${adminToken} --login-failure-limit 100000\n`
    + `(see "Run it" in README.md). Restart it if it has been running for a while, because failed logins are remembered for 5 minutes.\n`;

  const context = await request.newContext({ baseURL });
  try {
    let health;
    try {
      health = await context.get('/api/health');
    } catch {
      throw new Error(`Cannot reach the API at ${baseURL}. Is it running?${fix}`);
    }
    if (!health.ok()) {
      throw new Error(`The API at ${baseURL} answered ${health.status()} to /api/health.${fix}`);
    }
    const spec = await context.get('/api/openapi.yaml');
    if (spec.status() === 404) {
      throw new Error(`The API at ${baseURL} has no /api/openapi.yaml, so it is an older build. Restart it from the latest BasicBankingApplication code.${fix}`);
    }
    const audit = await context.get('/api/admin/audit?limit=1', { headers: { 'X-Admin-Token': adminToken } });
    if (audit.status() === 404) {
      throw new Error(`The admin endpoints are switched off on ${baseURL}: it was started without --admin-token.${fix}`);
    }
    if (audit.status() === 401) {
      throw new Error(`The API at ${baseURL} has a different admin token from the one the tests use. Set ADMIN_TOKEN to match, or restart the API with the token above.${fix}`);
    }
    if (audit.status() === 429) {
      throw new Error(`The API at ${baseURL} is already refusing this machine (429 Too Many Failed Attempts): its login limit is too low or has been used up.${fix}`);
    }
    if (audit.status() !== 200) {
      throw new Error(`Unexpected answer ${audit.status()} from the admin audit endpoint on ${baseURL}.${fix}`);
    }
  } finally {
    await context.dispose();
  }
}
