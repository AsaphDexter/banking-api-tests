import { randomUUID } from 'node:crypto';
import {
  adminHeaders, balanceOf, deposit, expect, postRaw, test, transfer, withdraw, type TestUser,
} from './support/fixtures';

type Req = Parameters<typeof balanceOf>[0];

/** Sends a money request with an Idempotency-Key. */
function withKey(
  request: Req, user: TestUser, path: string, key: string | undefined, data: object,
): ReturnType<Req['post']> {
  const headers: Record<string, string> = { ...user.headers };
  if (key !== undefined) {
    headers['Idempotency-Key'] = key;
  }
  return request.post(path, { headers, data });
}

async function historyLength(request: Req, user: TestUser): Promise<number> {
  return ((await (await request.get('/api/transactions', { headers: user.headers })).json()) as unknown[]).length;
}

test.describe('repeating a request with the same Idempotency-Key', () => {
  test('a repeated deposit returns the identical answer and moves the money once', async ({ request, newUser }) => {
    const user = await newUser();
    const key = randomUUID();
    const first = await withKey(request, user, '/api/deposit', key, { amount: 25.5 });
    const second = await withKey(request, user, '/api/deposit', key, { amount: 25.5 });
    expect(first.status()).toBe(200);
    expect(second.status()).toBe(200);
    expect(first.headers()['idempotent-replayed']).toBe('false');
    expect(second.headers()['idempotent-replayed']).toBe('true');
    expect(await second.text()).toBe(await first.text()); // byte for byte
    expect(await balanceOf(request, user)).toBe(25.5);
    expect(await historyLength(request, user)).toBe(1);
  });

  test('works the same for withdrawals', async ({ request, newUser }) => {
    const user = await newUser();
    await deposit(request, user, 100);
    const key = randomUUID();
    for (let i = 0; i < 4; i += 1) {
      const response = await withKey(request, user, '/api/withdraw', key, { amount: 30 });
      expect(response.status()).toBe(200);
      expect(await response.text()).toBe('{"balance":70.00}');
    }
    expect(await balanceOf(request, user)).toBe(70);
  });

  test('works the same for transfers: neither account is changed twice', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    await deposit(request, alice, 100);
    const key = randomUUID();
    for (let i = 0; i < 4; i += 1) {
      const response = await withKey(request, alice, '/api/transfer', key, { toAccountNumber: bob.accountNumber, amount: 40 });
      expect(response.status()).toBe(200);
      expect(await response.text()).toBe('{"balance":60.00}');
    }
    expect(await balanceOf(request, alice)).toBe(60);
    expect(await balanceOf(request, bob)).toBe(40);
    expect(await historyLength(request, bob)).toBe(1);
  });

  test('the same amount written differently is the same request', async ({ request, newUser }) => {
    const user = await newUser();
    const key = randomUUID();
    const replays: string[] = [];
    for (const raw of ['{"amount":10}', '{"amount":10.00}', '{"amount":1e1}', '{"amount":10.0}']) {
      const response = await postRaw(request, '/api/deposit', raw, { ...user.headers, 'Idempotency-Key': key });
      expect(response.status(), raw).toBe(200);
      replays.push(response.headers()['idempotent-replayed'] ?? 'missing');
    }
    expect(replays).toEqual(['false', 'true', 'true', 'true']);
    expect(await balanceOf(request, user)).toBe(10);
  });

  test('a UUID, a short key and a 64-character key are all accepted', async ({ request, newUser }) => {
    const user = await newUser();
    for (const key of [randomUUID(), 'abcdefgh', 'k'.repeat(64), 'under_score-and-dash-1']) {
      expect((await withKey(request, user, '/api/deposit', key, { amount: 1 })).status(), key).toBe(200);
    }
    expect(await balanceOf(request, user)).toBe(4);
  });
});

test.describe('a key used for a different request', () => {
  test('a different amount is 422 and nothing changes', async ({ request, newUser }) => {
    const user = await newUser();
    const key = randomUUID();
    await withKey(request, user, '/api/deposit', key, { amount: 10 });
    const reuse = await withKey(request, user, '/api/deposit', key, { amount: 11 });
    expect(reuse.status()).toBe(422);
    expect(((await reuse.json()) as { error: string }).error).toContain('different request');
    expect(await balanceOf(request, user)).toBe(10);
  });

  test('a different endpoint is 422', async ({ request, newUser }) => {
    const user = await newUser();
    await deposit(request, user, 50);
    const key = randomUUID();
    await withKey(request, user, '/api/deposit', key, { amount: 10 });
    expect((await withKey(request, user, '/api/withdraw', key, { amount: 10 })).status()).toBe(422);
    expect(await balanceOf(request, user)).toBe(60);
  });

  test('a different recipient is 422 and the second recipient gets nothing', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    const carol = await newUser();
    await deposit(request, alice, 100);
    const key = randomUUID();
    expect((await withKey(request, alice, '/api/transfer', key, { toAccountNumber: bob.accountNumber, amount: 5 })).status()).toBe(200);
    expect((await withKey(request, alice, '/api/transfer', key, { toAccountNumber: carol.accountNumber, amount: 5 })).status()).toBe(422);
    expect(await balanceOf(request, carol)).toBe(0);
  });

  test('keys belong to the user: two users can use the same key independently', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    const key = randomUUID();
    const first = await withKey(request, alice, '/api/deposit', key, { amount: 10 });
    const second = await withKey(request, bob, '/api/deposit', key, { amount: 20 });
    expect(first.headers()['idempotent-replayed']).toBe('false');
    expect(second.headers()['idempotent-replayed']).toBe('false');
    expect(await balanceOf(request, bob)).toBe(20);
  });

  test('one user cannot learn about or replay another user\'s key', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    const key = randomUUID();
    await withKey(request, alice, '/api/deposit', key, { amount: 10 });
    const bobsUse = await withKey(request, bob, '/api/deposit', key, { amount: 10 });
    expect(bobsUse.headers()['idempotent-replayed']).toBe('false'); // not Alice's stored answer
    expect(await balanceOf(request, bob)).toBe(10);
  });
});

test.describe('failures do not use up a key', () => {
  test('an overdraft (422) can be retried with the same key once the money is there', async ({ request, newUser }) => {
    const user = await newUser();
    const key = randomUUID();
    expect((await withKey(request, user, '/api/withdraw', key, { amount: 50 })).status()).toBe(422);
    await deposit(request, user, 100);
    const retry = await withKey(request, user, '/api/withdraw', key, { amount: 50 });
    expect(retry.status()).toBe(200);
    expect(retry.headers()['idempotent-replayed']).toBe('false'); // it really ran this time
    expect(await balanceOf(request, user)).toBe(50);
  });

  test('a rejected body (400) can be corrected and sent again with the same key', async ({ request, newUser }) => {
    const user = await newUser();
    const key = randomUUID();
    expect((await withKey(request, user, '/api/deposit', key, { amount: -5 })).status()).toBe(400);
    expect((await postRaw(request, '/api/deposit', '{broken', { ...user.headers, 'Idempotency-Key': key })).status()).toBe(400);
    expect((await withKey(request, user, '/api/deposit', key, { amount: 5 })).status()).toBe(200);
    expect(await balanceOf(request, user)).toBe(5);
  });

  test('an unknown recipient (404) does not use up the key', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    await deposit(request, alice, 50);
    const key = randomUUID();
    expect((await withKey(request, alice, '/api/transfer', key, { toAccountNumber: '9999999999', amount: 5 })).status()).toBe(404);
    expect((await withKey(request, alice, '/api/transfer', key, { toAccountNumber: bob.accountNumber, amount: 5 })).status()).toBe(200);
  });

  test('a request without a valid token is refused before its key is looked at', async ({ request }) => {
    const response = await request.post('/api/deposit', {
      headers: { Authorization: 'Bearer garbage', 'Idempotency-Key': randomUUID() }, data: { amount: 5 },
    });
    expect(response.status()).toBe(401);
  });
});

test.describe('the header itself', () => {
  const badKeys: Array<[string, string]> = [
    ['too short (7)', 'abcdefg'],
    ['too long (65)', 'k'.repeat(65)],
    ['containing a space', 'has a space here'],
    ['containing punctuation', 'bad!characters#1'],
    ['only spaces', '        '],
  ];
  for (const [label, key] of badKeys) {
    test(`a key that is ${label} is 400 and nothing moves`, async ({ request, newUser }) => {
      const user = await newUser();
      expect((await withKey(request, user, '/api/deposit', key, { amount: 5 })).status()).toBe(400);
      expect(await balanceOf(request, user)).toBe(0);
    });
  }

  test('requests without a key behave exactly as before', async ({ request, newUser }) => {
    const user = await newUser();
    const first = await withKey(request, user, '/api/deposit', undefined, { amount: 5 });
    const second = await withKey(request, user, '/api/deposit', undefined, { amount: 5 });
    expect(first.headers()['idempotent-replayed']).toBeUndefined();
    expect(second.headers()['idempotent-replayed']).toBeUndefined();
    expect(await balanceOf(request, user)).toBe(10); // both counted
  });

  test('the key is only meaningful on money endpoints and does not break the others', async ({ request, newUser }) => {
    const user = await newUser();
    const response = await request.get('/api/account', { headers: { ...user.headers, 'Idempotency-Key': randomUUID() } });
    expect(response.status()).toBe(200);
  });
});

test.describe('retries under pressure', () => {
  test('20 identical requests at the same moment: one runs, 19 get its answer', async ({ request, newUser }) => {
    const user = await newUser();
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 20 }, () => withKey(request, user, '/api/deposit', key, { amount: 3 })));
    expect(responses.map((response) => response.status())).toEqual(Array(20).fill(200));
    const flags = responses.map((response) => response.headers()['idempotent-replayed']);
    expect(flags.filter((flag) => flag === 'false')).toHaveLength(1);
    expect(flags.filter((flag) => flag === 'true')).toHaveLength(19);
    expect(new Set(await Promise.all(responses.map((response) => response.text()))).size).toBe(1);
    expect(await balanceOf(request, user)).toBe(3);
    expect(await historyLength(request, user)).toBe(1);
  });

  test('20 parallel transfers of the whole balance with ONE key move the money once', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    await deposit(request, alice, 100);
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 20 }, () =>
      withKey(request, alice, '/api/transfer', key, { toAccountNumber: bob.accountNumber, amount: 100 })));
    expect(responses.every((response) => response.status() === 200)).toBe(true);
    expect(await balanceOf(request, alice)).toBe(0);
    expect(await balanceOf(request, bob)).toBe(100);
  });

  test('20 parallel transfers of the whole balance with DIFFERENT keys: exactly one succeeds (a key is not a free pass)', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    await deposit(request, alice, 100);
    const responses = await Promise.all(Array.from({ length: 20 }, () =>
      withKey(request, alice, '/api/transfer', randomUUID(), { toAccountNumber: bob.accountNumber, amount: 100 })));
    const statuses = responses.map((response) => response.status());
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 422)).toHaveLength(19);
    expect(await balanceOf(request, bob)).toBe(100);
  });

  test('a retry long after the first request still gets the stored answer, even after other activity', async ({ request, newUser }) => {
    const user = await newUser();
    const key = randomUUID();
    const first = await withKey(request, user, '/api/deposit', key, { amount: 10 });
    await deposit(request, user, 5);
    await withdraw(request, user, 3);
    const retry = await withKey(request, user, '/api/deposit', key, { amount: 10 });
    expect(await retry.text()).toBe(await first.text()); // the ORIGINAL balance, not today's
    expect(await balanceOf(request, user)).toBe(12);
  });
});

test.describe('the audit trail', () => {
  test('a replay is recorded, without moving money', async ({ request, newUser }) => {
    const user = await newUser();
    const key = randomUUID();
    await withKey(request, user, '/api/deposit', key, { amount: 10 });
    await withKey(request, user, '/api/deposit', key, { amount: 10 });
    const audit = (await (await request.get(`/api/admin/audit?username=${user.username}`, { headers: adminHeaders })).json()) as Array<{ type: string; detail?: string }>;
    const replays = audit.filter((entry) => entry.type === 'REQUEST_REPLAYED');
    expect(replays).toHaveLength(1);
    expect(replays[0]?.detail).toContain(key);
    expect(audit.filter((entry) => entry.type === 'TRANSFER')).toHaveLength(0);
  });
});

// transfer() is imported for symmetry with the other specs; reference it so the import is used.
void transfer;
