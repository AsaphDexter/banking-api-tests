import { expect, test, uniqueUsername, postRaw, PASSWORD } from './support/fixtures';

test.describe('health and HTTP protocol behaviour', () => {
  test('health endpoint reports UP', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: 'UP' });
  });

  test('responses are JSON with security headers, including error responses', async ({ request }) => {
    for (const path of ['/api/health', '/api/does-not-exist']) {
      const response = await request.get(path);
      expect(response.headers()['content-type']).toContain('application/json');
      expect(response.headers()['x-content-type-options']).toBe('nosniff');
      expect(response.headers()['cache-control']).toBe('no-store');
    }
  });

  for (const path of ['/', '/api', '/api/', '/api/admin', '/api/account/', '/api/ACCOUNT', '/admin', '/api/health/extra']) {
    test(`unknown path ${path} returns a JSON 404`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(404);
      expect(Object.keys((await response.json()) as object)).toEqual(['error']);
    });
  }

  const postOnly = [
    '/api/register', '/api/login', '/api/logout', '/api/deposit', '/api/withdraw', '/api/transfer',
    '/api/password', '/api/admin/unlock',
  ];
  const getOnly = ['/api/health', '/api/account', '/api/transactions', '/api/admin/audit'];

  for (const path of postOnly) {
    test(`GET ${path} is 405 and says POST is allowed`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(405);
      expect(response.headers()['allow']).toBe('POST');
    });
  }

  for (const path of getOnly) {
    test(`POST ${path} is 405 and says GET is allowed`, async ({ request }) => {
      const response = await request.post(path, { data: {} });
      expect(response.status()).toBe(405);
      expect(response.headers()['allow']).toBe('GET');
    });
  }

  for (const method of ['PUT', 'DELETE', 'PATCH'] as const) {
    test(`${method} is not supported on a protected endpoint`, async ({ request }) => {
      const response = await request.fetch('/api/account', { method });
      expect(response.status()).toBe(405);
    });
  }

  test('error responses contain only an error message, never internals', async ({ request }) => {
    const responses = [
      await request.get('/api/nothing'),
      await postRaw(request, '/api/login', '{broken json'),
      await request.get('/api/account'),
      await request.post('/api/login', { data: { username: uniqueUsername(), password: PASSWORD } }),
    ];
    for (const response of responses) {
      const text = await response.text();
      expect(Object.keys(JSON.parse(text) as object)).toEqual(['error']);
      expect(text).not.toMatch(/Exception|java\.|basicbankingapp|\bat \w+\./);
    }
  });

  test('cross-origin browser access is not enabled (no CORS headers)', async ({ request }) => {
    const response = await request.get('/api/health', { headers: { Origin: 'https://evil.example' } });
    expect(response.headers()['access-control-allow-origin']).toBeUndefined();
    const preflight = await request.fetch('/api/transfer', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(preflight.status()).toBe(405);
    expect(preflight.headers()['access-control-allow-origin']).toBeUndefined();
  });
});
