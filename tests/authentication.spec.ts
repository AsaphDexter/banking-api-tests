import {
  bearer, createUser, expect, login, postRaw, register, test, uniqueUsername, PASSWORD,
} from './support/fixtures';

test.describe('login', () => {
  test('returns a bearer token with its lifetime', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    const response = await request.post('/api/login', { data: { username, password: PASSWORD } });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { token: string; tokenType: string; expiresInSeconds: number };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits, URL-safe Base64
    expect(body.tokenType).toBe('Bearer');
    expect(body.expiresInSeconds).toBe(1800);
    expect(JSON.stringify(body)).not.toContain(PASSWORD);
  });

  test('username is not case-sensitive but the password is', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    const upper = await request.post('/api/login', { data: { username: username.toUpperCase(), password: PASSWORD } });
    expect(upper.status()).toBe(200);
    const wrongCase = await request.post('/api/login', { data: { username, password: PASSWORD.toLowerCase() } });
    expect(wrongCase.status()).toBe(401);
  });

  test('a wrong password and an unknown user give identical 401 responses', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    const wrongPassword = await request.post('/api/login', { data: { username, password: 'Wrong1234' } });
    const unknownUser = await request.post('/api/login', { data: { username: uniqueUsername(), password: 'Wrong1234' } });
    expect(wrongPassword.status()).toBe(401);
    expect(unknownUser.status()).toBe(401);
    expect(await wrongPassword.text()).toBe(await unknownUser.text());
  });

  test('every login gets a different token and both stay valid', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    const tokens = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      tokens.add(await login(request, username));
    }
    expect(tokens.size).toBe(6);
    for (const token of tokens) {
      expect((await request.get('/api/account', { headers: bearer(token) })).status()).toBe(200);
    }
  });

  const badBodies: Array<[string, string]> = [
    ['missing password', '{"username":"someone"}'],
    ['missing username', '{"password":"Passw0rd1"}'],
    ['empty object', '{}'],
    ['null password', '{"username":"someone","password":null}'],
    ['numeric password', '{"username":"someone","password":12345678}'],
    ['extra field', '{"username":"someone","password":"Passw0rd1","admin":true}'],
    ['not JSON', 'username=someone&password=Passw0rd1'],
  ];
  for (const [label, body] of badBodies) {
    test(`rejects a login with ${label}`, async ({ request }) => {
      const response = await postRaw(request, '/api/login', body);
      expect(response.status()).toBe(400);
    });
  }

  test('SQL-injection style credentials simply fail to log in', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    for (const attempt of [`${username}' OR '1'='1`, `${username}'--`, "' OR 1=1 --", `${username}" OR ""="`]) {
      const response = await request.post('/api/login', { data: { username: attempt, password: "x' OR '1'='1" } });
      expect(response.status()).toBe(401);
    }
    expect((await request.post('/api/login', { data: { username, password: PASSWORD } })).status()).toBe(200);
  });
});

test.describe('account lockout', () => {
  test('three wrong passwords lock the account, even for the correct password afterwards', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    const statuses: number[] = [];
    for (const password of ['Wrong1111', 'Wrong2222', 'Wrong3333', PASSWORD]) {
      statuses.push((await request.post('/api/login', { data: { username, password } })).status());
    }
    expect(statuses).toEqual([401, 401, 423, 423]);
  });

  test('the locked response explains itself', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    for (const password of ['Wrong1111', 'Wrong2222', 'Wrong3333']) {
      await request.post('/api/login', { data: { username, password } });
    }
    const response = await request.post('/api/login', { data: { username, password: PASSWORD } });
    expect(((await response.json()) as { error: string }).error.toLowerCase()).toContain('locked');
  });

  test('a successful login resets the failure counter', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    const attempts: Array<[string, number]> = [
      ['Wrong1111', 401], ['Wrong2222', 401], [PASSWORD, 200], ['Wrong3333', 401], ['Wrong4444', 401], [PASSWORD, 200],
    ];
    for (const [password, expected] of attempts) {
      const response = await request.post('/api/login', { data: { username, password } });
      expect(response.status(), password).toBe(expected);
    }
  });

  test('locking one user does not affect another', async ({ request }) => {
    const victim = uniqueUsername();
    const bystander = uniqueUsername();
    await register(request, victim);
    await register(request, bystander);
    for (const password of ['Wrong1111', 'Wrong2222', 'Wrong3333']) {
      await request.post('/api/login', { data: { username: victim, password } });
    }
    expect((await request.post('/api/login', { data: { username: bystander, password: PASSWORD } })).status()).toBe(200);
  });

  test('an already-issued token keeps working after its owner gets locked', async ({ request }) => {
    const user = await createUser(request);
    for (const password of ['Wrong1111', 'Wrong2222', 'Wrong3333']) {
      await request.post('/api/login', { data: { username: user.username, password } });
    }
    expect((await request.get('/api/account', { headers: user.headers })).status()).toBe(200);
  });

  test('FINDING: anyone can lock any account and the API has no way to unlock it', async ({ request }) => {
    test.info().annotations.push({
      type: 'finding',
      description: 'Lockout is permanent and needs only the victim username, so it can be abused to deny service. '
        + 'Suggested fix: time-based lockout and per-client throttling.',
    });
    const victim = uniqueUsername();
    await register(request, victim);
    for (const password of ['Wrong1111', 'Wrong2222', 'Wrong3333']) {
      await request.post('/api/login', { data: { username: victim, password } });
    }
    for (let i = 0; i < 3; i += 1) {
      const response = await request.post('/api/login', { data: { username: victim, password: PASSWORD } });
      expect(response.status()).toBe(423);
    }
  });

  test('FINDING: the locked response reveals that a username exists', async ({ request }) => {
    test.info().annotations.push({
      type: 'finding',
      description: 'A locked existing user answers 423 while an unknown user answers 401, so lockout state leaks account existence.',
    });
    const victim = uniqueUsername();
    await register(request, victim);
    for (const password of ['Wrong1111', 'Wrong2222', 'Wrong3333']) {
      await request.post('/api/login', { data: { username: victim, password } });
    }
    const existing = await request.post('/api/login', { data: { username: victim, password: 'Wrong4444' } });
    const unknown = await request.post('/api/login', { data: { username: uniqueUsername(), password: 'Wrong4444' } });
    expect(existing.status()).toBe(423);
    expect(unknown.status()).toBe(401);
  });
});

test.describe('tokens and logout', () => {
  const protectedCalls: Array<[string, string, object]> = [
    ['GET', '/api/account', {}],
    ['GET', '/api/transactions', {}],
    ['POST', '/api/deposit', { amount: 10 }],
    ['POST', '/api/withdraw', { amount: 10 }],
    ['POST', '/api/transfer', { toAccountNumber: '1000000001', amount: 10 }],
    ['POST', '/api/logout', {}],
  ];

  for (const [method, path, data] of protectedCalls) {
    test(`${method} ${path} without a token is 401 with a Bearer challenge`, async ({ request }) => {
      const response = await request.fetch(path, { method, data: method === 'POST' ? data : undefined });
      expect(response.status()).toBe(401);
      expect(response.headers()['www-authenticate']).toBe('Bearer');
    });
  }

  const badAuthHeaders: Array<[string, string]> = [
    ['a random token', 'Bearer not-a-real-token'],
    ['an empty token', 'Bearer '],
    ['no token after the scheme', 'Bearer'],
    ['the Basic scheme', 'Basic YWxpY2U6UGFzc3cwcmQx'],
    ['a very long token', `Bearer ${'A'.repeat(5000)}`],
    ['SQL in the token', "Bearer ' OR '1'='1"],
  ];
  for (const [label, header] of badAuthHeaders) {
    test(`rejects ${label}`, async ({ request }) => {
      const response = await request.get('/api/account', { headers: { Authorization: header } });
      expect(response.status()).toBe(401);
    });
  }

  test('the token is only accepted in the Authorization header', async ({ request, newUser }) => {
    const user = await newUser();
    const inQuery = await request.get(`/api/account?token=${user.token}`);
    const inCookie = await request.get('/api/account', { headers: { Cookie: `token=${user.token}` } });
    expect(inQuery.status()).toBe(401);
    expect(inCookie.status()).toBe(401);
  });

  test('the Bearer scheme name is case-insensitive', async ({ request, newUser }) => {
    const user = await newUser();
    const response = await request.get('/api/account', { headers: { Authorization: `bearer ${user.token}` } });
    expect(response.status()).toBe(200);
  });

  test('authentication is checked before the request body', async ({ request }) => {
    const response = await postRaw(request, '/api/deposit', '{broken json', bearer('garbage'));
    expect(response.status()).toBe(401);
  });

  test('logout revokes the token immediately', async ({ request, newUser }) => {
    const user = await newUser();
    expect((await request.get('/api/account', { headers: user.headers })).status()).toBe(200);
    const logout = await request.post('/api/logout', { headers: user.headers, data: {} });
    expect(logout.status()).toBe(204);
    expect(await logout.text()).toBe('');
    expect((await request.get('/api/account', { headers: user.headers })).status()).toBe(401);
    expect((await request.post('/api/logout', { headers: user.headers, data: {} })).status()).toBe(401);
  });

  test('logging out one session leaves the user\'s other sessions alone', async ({ request, newUser }) => {
    const user = await newUser();
    const secondToken = await login(request, user.username);
    await request.post('/api/logout', { headers: user.headers, data: {} });
    expect((await request.get('/api/account', { headers: user.headers })).status()).toBe(401);
    expect((await request.get('/api/account', { headers: bearer(secondToken) })).status()).toBe(200);
  });
});
