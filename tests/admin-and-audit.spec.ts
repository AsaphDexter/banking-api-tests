import {
  ADMIN_TOKEN, adminHeaders, bearer, expect, lockOut, postRaw, register, test, uniqueUsername, PASSWORD,
} from './support/fixtures';

interface AuditEntry {
  timestamp: string;
  type: string;
  username?: string;
  detail?: string;
}

test.describe('admin access', () => {
  test('the admin endpoints refuse a missing or wrong admin token', async ({ request }) => {
    const unlock = '/api/admin/unlock';
    expect((await request.post(unlock, { data: { username: 'someone' } })).status()).toBe(401);
    expect((await request.post(unlock, { headers: { 'X-Admin-Token': 'wrong-wrong-wrong-1' }, data: { username: 'someone' } })).status()).toBe(401);
    expect((await request.get('/api/admin/audit')).status()).toBe(401);
    expect((await request.get('/api/admin/audit', { headers: { 'X-Admin-Token': ADMIN_TOKEN + 'x' } })).status()).toBe(401);
    expect((await request.get('/api/admin/audit', { headers: { 'X-Admin-Token': '' } })).status()).toBe(401);
  });

  test('a normal user token is not an admin token', async ({ request, newUser }) => {
    const user = await newUser();
    expect((await request.get('/api/admin/audit', { headers: { 'X-Admin-Token': user.token } })).status()).toBe(401);
    expect((await request.get('/api/admin/audit', { headers: user.headers })).status()).toBe(401);
  });

  test('the admin token does not work as a login token', async ({ request }) => {
    expect((await request.get('/api/account', { headers: bearer(ADMIN_TOKEN) })).status()).toBe(401);
  });
});

test.describe('admin unlock', () => {
  test('unlocks a locked user so they can log in straight away', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    await lockOut(request, username);
    expect((await request.post('/api/login', { data: { username, password: PASSWORD } })).status()).toBe(423);

    const unlock = await request.post('/api/admin/unlock', { headers: adminHeaders, data: { username } });
    expect(unlock.status()).toBe(204);
    expect((await request.post('/api/login', { data: { username, password: PASSWORD } })).status()).toBe(200);
  });

  test('unlocking resets the failure count too, so the user gets a full set of attempts', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    await lockOut(request, username);
    await request.post('/api/admin/unlock', { headers: adminHeaders, data: { username } });
    expect((await request.post('/api/login', { data: { username, password: 'Wrong1111' } })).status()).toBe(401);
    expect((await request.post('/api/login', { data: { username, password: 'Wrong2222' } })).status()).toBe(401);
    expect((await request.post('/api/login', { data: { username, password: PASSWORD } })).status()).toBe(200);
  });

  test('unlocking someone who is not locked is harmless', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    expect((await request.post('/api/admin/unlock', { headers: adminHeaders, data: { username } })).status()).toBe(204);
    expect((await request.post('/api/login', { data: { username, password: PASSWORD } })).status()).toBe(200);
  });

  test('username matching ignores case', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    await lockOut(request, username);
    const unlock = await request.post('/api/admin/unlock', { headers: adminHeaders, data: { username: username.toUpperCase() } });
    expect(unlock.status()).toBe(204);
  });

  test('an unknown user is 404, and bad requests are 400', async ({ request }) => {
    expect((await request.post('/api/admin/unlock', { headers: adminHeaders, data: { username: uniqueUsername() } })).status()).toBe(404);
    expect((await request.post('/api/admin/unlock', { headers: adminHeaders, data: {} })).status()).toBe(400);
    expect((await request.post('/api/admin/unlock', { headers: adminHeaders, data: { username: 'x', extra: 1 } })).status()).toBe(400);
    expect((await postRaw(request, '/api/admin/unlock', '{broken', adminHeaders)).status()).toBe(400);
  });

  test('unlocking one user leaves another locked user locked', async ({ request }) => {
    const first = uniqueUsername();
    const second = uniqueUsername();
    await register(request, first);
    await register(request, second);
    await lockOut(request, first);
    await lockOut(request, second);
    await request.post('/api/admin/unlock', { headers: adminHeaders, data: { username: first } });
    expect((await request.post('/api/login', { data: { username: first, password: PASSWORD } })).status()).toBe(200);
    expect((await request.post('/api/login', { data: { username: second, password: PASSWORD } })).status()).toBe(423);
  });
});

test.describe('audit log', () => {
  async function auditFor(request: Parameters<typeof lockOut>[0], username: string, limit = 50): Promise<AuditEntry[]> {
    const response = await request.get(`/api/admin/audit?username=${encodeURIComponent(username)}&limit=${limit}`, {
      headers: adminHeaders,
    });
    expect(response.status()).toBe(200);
    return (await response.json()) as AuditEntry[];
  }

  test('records the life of an account, newest first', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    await request.post('/api/login', { data: { username, password: PASSWORD } });
    await request.post('/api/login', { data: { username, password: 'Wrong1111' } });
    const types = (await auditFor(request, username)).map((entry) => entry.type);
    expect(types).toEqual(['LOGIN_FAILED', 'LOGIN_SUCCESS', 'REGISTERED']);
  });

  test('records locking, blocked attempts, unlocking and password changes', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    const token = ((await (await request.post('/api/login', { data: { username, password: PASSWORD } })).json()) as { token: string }).token;
    await lockOut(request, username);
    await request.post('/api/login', { data: { username, password: PASSWORD } }); // blocked
    await request.post('/api/admin/unlock', { headers: adminHeaders, data: { username } });
    await request.post('/api/password', { headers: bearer(token), data: { oldPassword: PASSWORD, newPassword: 'N3wPassword' } });

    const types = (await auditFor(request, username)).map((entry) => entry.type).reverse();
    expect(types).toEqual([
      'REGISTERED', 'LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGIN_FAILED', 'LOGIN_FAILED',
      'ACCOUNT_LOCKED', 'LOGIN_BLOCKED', 'ACCOUNT_UNLOCKED', 'PASSWORD_CHANGED',
    ]);
  });

  test('records transfers under the user who made them, with accounts and amount', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    await request.post('/api/deposit', { headers: alice.headers, data: { amount: 100 } });
    await request.post('/api/transfer', { headers: alice.headers, data: { toAccountNumber: bob.accountNumber, amount: 25.5 } });

    const transfers = (await auditFor(request, alice.username)).filter((entry) => entry.type === 'TRANSFER');
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.detail).toContain(alice.accountNumber);
    expect(transfers[0]?.detail).toContain(bob.accountNumber);
    expect(transfers[0]?.detail).toContain('25.50');
    expect((await auditFor(request, bob.username)).filter((entry) => entry.type === 'TRANSFER')).toHaveLength(0);
  });

  test('records failed attempts against unknown users without confirming they exist', async ({ request }) => {
    const ghost = uniqueUsername();
    const response = await request.post('/api/login', { data: { username: ghost, password: PASSWORD } });
    expect(response.status()).toBe(401);
    const entries = await auditFor(request, ghost);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe('LOGIN_FAILED');
    expect(entries[0]?.detail).toContain('unknown user');
  });

  test('entries have ISO timestamps and never contain passwords, hashes or tokens', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    const login = await request.post('/api/login', { data: { username, password: PASSWORD } });
    const token = ((await login.json()) as { token: string }).token;
    await request.post('/api/login', { data: { username, password: 'SecretGuess99' } });
    await request.post('/api/password', { headers: bearer(token), data: { oldPassword: PASSWORD, newPassword: 'N3wPassword' } });

    const response = await request.get(`/api/admin/audit?username=${username}`, { headers: adminHeaders });
    const text = await response.text();
    for (const secret of [PASSWORD, 'SecretGuess99', 'N3wPassword', token]) {
      expect(text).not.toContain(secret);
    }
    expect(text.toLowerCase()).not.toContain('pbkdf2');
    for (const entry of JSON.parse(text) as AuditEntry[]) {
      expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
    }
  });

  test('attacker-supplied text cannot forge log lines (control characters removed, length capped)', async ({ request }) => {
    const base = uniqueUsername();
    const hostile = `${base}\nLOGIN_SUCCESS admin${'x'.repeat(100)}`;
    await request.post('/api/login', { data: { username: hostile, password: PASSWORD } });
    const cleaned = `${base}?login_success admin${'x'.repeat(100)}`.slice(0, 50);
    const entries = await auditFor(request, cleaned);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const entry of entries) {
      expect(entry.username).not.toMatch(/[\r\n]/);
      expect((entry.username ?? '').length).toBeLessThanOrEqual(50);
    }
  });

  test('the limit parameter is validated (whole number from 1 to 200)', async ({ request }) => {
    for (const bad of ['0', '201', '-1', 'abc', '1.5', '']) {
      const response = await request.get(`/api/admin/audit?limit=${bad}`, { headers: adminHeaders });
      expect(response.status(), `limit=${bad}`).toBe(400);
    }
    expect((await request.get('/api/admin/audit?limit=200', { headers: adminHeaders })).status()).toBe(200);
    expect((await request.get('/api/admin/audit?limit=1', { headers: adminHeaders })).status()).toBe(200);
  });

  test('limit really limits, and filtering by an unknown user gives an empty list', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    for (let i = 0; i < 4; i += 1) {
      await request.post('/api/login', { data: { username, password: PASSWORD } });
    }
    expect(await auditFor(request, username, 3)).toHaveLength(3);
    expect(await auditFor(request, uniqueUsername())).toEqual([]);
  });

  test('a bad query string is rejected, not crashed on', async ({ request }) => {
    const response = await request.get('/api/admin/audit?username=%E0%A4%A', { headers: adminHeaders });
    expect(response.status()).toBe(400);
  });
});
