import {
  balanceOf, bearer, deposit, expect, login, postRaw, register, test, transfer, uniqueUsername, withdraw, PASSWORD,
} from './support/fixtures';

test.describe('access control', () => {
  test('a user can only ever see and move their own money', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    await deposit(request, alice, 100);

    expect(await balanceOf(request, bob)).toBe(0);
    expect(alice.accountNumber).not.toBe(bob.accountNumber);
    const bobHistory = (await (await request.get('/api/transactions', { headers: bob.headers })).json()) as unknown[];
    expect(bobHistory).toHaveLength(0);

    // The API has no "from account" field, so Bob cannot spend Alice's money, whatever he sends.
    expect((await withdraw(request, bob, 1)).status()).toBe(422);
    const spoof = await postRaw(
      request,
      '/api/transfer',
      JSON.stringify({ toAccountNumber: bob.accountNumber, fromAccountNumber: alice.accountNumber, amount: 50 }),
      bob.headers,
    );
    expect(spoof.status()).toBe(400);
    expect(await balanceOf(request, alice)).toBe(100);
  });

  test('actions with one token never change another user', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    await deposit(request, alice, 10);
    await deposit(request, alice, 20);
    expect(await balanceOf(request, alice)).toBe(30);
    expect(await balanceOf(request, bob)).toBe(0);
  });

  test('a token stops working for its user the moment it is revoked, while others are untouched', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    await request.post('/api/logout', { headers: alice.headers, data: {} });
    expect((await request.get('/api/account', { headers: alice.headers })).status()).toBe(401);
    expect((await request.get('/api/account', { headers: bob.headers })).status()).toBe(200);
  });

  test('tokens look random: 12 logins give 12 different values with no shared prefix', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    const tokens: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      tokens.push(await login(request, username));
    }
    expect(new Set(tokens).size).toBe(12);
    const prefixes = new Set(tokens.map((token) => token.slice(0, 6)));
    expect(prefixes.size).toBeGreaterThan(8);
  });
});

test.describe('secrets never leak', () => {
  test('no response across the whole API contains a password or a hash', async ({ request }) => {
    const username = uniqueUsername();
    const bodies: string[] = [];
    bodies.push(await (await register(request, username)).text());
    const loginResponse = await request.post('/api/login', { data: { username, password: PASSWORD } });
    bodies.push(await loginResponse.text());
    const token = ((await loginResponse.json()) as { token: string }).token;
    bodies.push(await (await request.get('/api/account', { headers: bearer(token) })).text());
    bodies.push(await (await request.get('/api/transactions', { headers: bearer(token) })).text());
    bodies.push(await (await request.post('/api/login', { data: { username, password: 'Wrong1234' } })).text());
    bodies.push(await (await register(request, username)).text());
    for (const body of bodies) {
      expect(body).not.toContain(PASSWORD);
      expect(body.toLowerCase()).not.toContain('pbkdf2');
      expect(body.toLowerCase()).not.toContain('salt');
    }
  });
});

test.describe('hostile input', () => {
  test('SQL in a full name is stored as plain text and does not break anything', async ({ request }) => {
    const username = uniqueUsername();
    const nasty = "Robert'); DROP TABLE users;--";
    expect((await register(request, username, PASSWORD, nasty)).status()).toBe(201);
    const token = await login(request, username);
    const account = (await (await request.get('/api/account', { headers: bearer(token) })).json()) as { ownerName: string };
    expect(account.ownerName).toBe(nasty);
    expect((await register(request, uniqueUsername())).status()).toBe(201); // the database is still fine
  });

  test('a script in a full name comes back as harmless JSON text', async ({ request }) => {
    const username = uniqueUsername();
    const payload = '<script>alert(1)</script>';
    await register(request, username, PASSWORD, payload);
    const token = await login(request, username);
    const response = await request.get('/api/account', { headers: bearer(token) });
    expect(response.headers()['content-type']).toContain('application/json');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(((await response.json()) as { ownerName: string }).ownerName).toBe(payload);
  });

  test('unicode and very long full names are handled without a server error', async ({ request }) => {
    for (const fullName of ['José Müller 🙂', 'Ａｄａ', 'x'.repeat(100)]) {
      const response = await register(request, uniqueUsername(), PASSWORD, fullName);
      expect(response.status(), fullName).toBeLessThan(500);
    }
  });

  test('a request body over 10 KB is 413', async ({ request }) => {
    const body = JSON.stringify({ username: 'a'.repeat(20_000), password: PASSWORD });
    expect((await postRaw(request, '/api/login', body)).status()).toBe(413);
  });

  test('the server still answers after a flood of bad requests', async ({ request }) => {
    const bad = ['{', '[', '"', '{"a":', '\u0000', '{"username":"a","password":"b",}', '��'];
    for (const body of bad) {
      const response = await postRaw(request, '/api/login', body);
      expect(response.status(), JSON.stringify(body)).toBe(400);
    }
    expect((await request.get('/api/health')).status()).toBe(200);
  });

  const contentTypes: Array<[string, string | undefined, number]> = [
    ['application/json', 'application/json', 401],
    ['application/json with a charset', 'application/json; charset=utf-8', 401],
    ['APPLICATION/JSON in capitals', 'APPLICATION/JSON', 401],
    ['text/plain', 'text/plain', 415],
    ['a form post', 'application/x-www-form-urlencoded', 415],
    ['xml', 'application/xml', 415],
    ['no declared type', undefined, 415],
  ];
  for (const [label, type, expected] of contentTypes) {
    test(`Content-Type ${label} gives ${expected}`, async ({ request }) => {
      const headers: Record<string, string> = type ? { 'Content-Type': type } : {};
      const response = await request.post('/api/login', {
        headers,
        data: JSON.stringify({ username: uniqueUsername(), password: PASSWORD }),
      });
      // application/json is accepted as far as parsing goes, so an unknown user then fails with 401.
      expect(response.status()).toBe(expected);
    });
  }
});

test.describe('input that could confuse the amount handling', () => {
  test('deposits of 1e2 and 100.0 are the same as 100', async ({ request, newUser }) => {
    const user = await newUser();
    expect(await (await postRaw(request, '/api/deposit', '{"amount":1e2}', user.headers)).text()).toBe('{"balance":100.00}');
    expect(await (await postRaw(request, '/api/deposit', '{"amount":100.0}', user.headers)).text()).toBe('{"balance":200.00}');
  });

  test('a transfer of an amount that is too precise leaves both balances alone', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    await deposit(request, alice, 100);
    expect((await transfer(request, alice, bob.accountNumber, 0.001)).status()).toBe(400);
    expect(await balanceOf(request, alice)).toBe(100);
  });
});
