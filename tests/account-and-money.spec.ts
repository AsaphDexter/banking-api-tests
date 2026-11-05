import {
  balanceOf, deposit, expect, postRaw, test, withdraw, type TestUser,
} from './support/fixtures';

interface HistoryEntry {
  type: string;
  amount: number;
  counterparty?: string;
  balanceAfter: number;
  timestamp: string;
}

test.describe('account', () => {
  test('a new account has a zero balance and no transactions', async ({ request, newUser }) => {
    const user = await newUser();
    const account = await request.get('/api/account', { headers: user.headers });
    expect(account.status()).toBe(200);
    expect(await account.json()).toEqual({
      accountNumber: user.accountNumber,
      ownerName: `Test ${user.username}`,
      balance: 0,
    });
    const history = await request.get('/api/transactions', { headers: user.headers });
    expect(history.status()).toBe(200);
    expect(await history.json()).toEqual([]);
  });
});

test.describe('deposits and withdrawals', () => {
  test('deposit returns the new balance with exactly two decimals', async ({ request, newUser }) => {
    const user = await newUser();
    const response = await deposit(request, user, 100.5);
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe('{"balance":100.50}');
  });

  test('withdrawal reduces the balance', async ({ request, newUser }) => {
    const user = await newUser();
    await deposit(request, user, 100);
    const response = await withdraw(request, user, 40.25);
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe('{"balance":59.75}');
    expect(await balanceOf(request, user)).toBe(59.75);
  });

  test('decimal amounts add up exactly (0.10 + 0.20 is 0.30)', async ({ request, newUser }) => {
    const user = await newUser();
    await deposit(request, user, 0.1);
    const response = await deposit(request, user, 0.2);
    expect(await response.text()).toBe('{"balance":0.30}');
  });

  test('the smallest amount, 0.01, is accepted', async ({ request, newUser }) => {
    const user = await newUser();
    expect(await (await deposit(request, user, 0.01)).text()).toBe('{"balance":0.01}');
  });

  test('withdrawing the whole balance leaves exactly zero', async ({ request, newUser }) => {
    const user = await newUser();
    await deposit(request, user, 25.4);
    const response = await withdraw(request, user, 25.4);
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe('{"balance":0.00}');
  });

  test('the largest single amount, 1,000,000,000, is accepted and one cent more is not', async ({ request, newUser }) => {
    const user = await newUser();
    const ok = await postRaw(request, '/api/deposit', '{"amount":1000000000}', user.headers);
    expect(ok.status()).toBe(200);
    expect(await ok.text()).toBe('{"balance":1000000000.00}');
    const tooMuch = await postRaw(request, '/api/deposit', '{"amount":1000000000.01}', user.headers);
    expect(tooMuch.status()).toBe(400);
  });

  test('withdrawing more than the balance is 422 and changes nothing', async ({ request, newUser }) => {
    const user = await newUser();
    await deposit(request, user, 50);
    const response = await withdraw(request, user, 50.01);
    expect(response.status()).toBe(422);
    expect(((await response.json()) as { error: string }).error).toContain('Insufficient funds');
    expect(await balanceOf(request, user)).toBe(50);
    const history = (await (await request.get('/api/transactions', { headers: user.headers })).json()) as HistoryEntry[];
    expect(history).toHaveLength(1);
  });

  test('withdrawing from an empty account is 422', async ({ request, newUser }) => {
    const user = await newUser();
    expect((await withdraw(request, user, 1)).status()).toBe(422);
  });

  const invalidAmountBodies: Array<[string, string]> = [
    ['zero', '{"amount":0}'],
    ['negative zero', '{"amount":-0.00}'],
    ['negative', '{"amount":-5}'],
    ['three decimals', '{"amount":1.001}'],
    ['above the maximum', '{"amount":2000000000}'],
    ['a huge exponent (1e999999999)', '{"amount":1e999999999}'],
    ['a tiny exponent (1e-999999999)', '{"amount":1e-999999999}'],
    ['a number written as text', '{"amount":"100"}'],
    ['null', '{"amount":null}'],
    ['true', '{"amount":true}'],
    ['a list', '{"amount":[1]}'],
    ['an object', '{"amount":{"value":1}}'],
    ['missing', '{}'],
    ['an unknown extra field', '{"amount":5,"currency":"USD"}'],
    ['trailing content after the JSON', '{"amount":5} {"amount":5}'],
  ];
  for (const [label, body] of invalidAmountBodies) {
    test(`deposit and withdraw reject an amount that is ${label}`, async ({ request, newUser }) => {
      const user = await newUser();
      await deposit(request, user, 10);
      for (const path of ['/api/deposit', '/api/withdraw']) {
        const response = await postRaw(request, path, body, user.headers);
        expect(response.status(), path).toBe(400);
      }
      expect(await balanceOf(request, user)).toBe(10);
    });
  }

  test('an invalid amount is rejected quickly instead of exhausting the server', async ({ request, newUser }) => {
    const user = await newUser();
    const started = Date.now();
    await postRaw(request, '/api/deposit', '{"amount":1e999999999}', user.headers);
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await request.get('/api/health')).status()).toBe(200);
  });
});

test.describe('transaction history', () => {
  async function historyOf(request: Parameters<typeof balanceOf>[0], user: TestUser): Promise<HistoryEntry[]> {
    const response = await request.get('/api/transactions', { headers: user.headers });
    expect(response.status()).toBe(200);
    return (await response.json()) as HistoryEntry[];
  }

  test('lists successful operations oldest first with the balance after each', async ({ request, newUser }) => {
    const user = await newUser();
    await deposit(request, user, 100);
    await withdraw(request, user, 30);
    await withdraw(request, user, 500); // rejected, must not appear
    await deposit(request, user, 5);

    const history = await historyOf(request, user);
    expect(history.map((entry) => entry.type)).toEqual(['DEPOSIT', 'WITHDRAWAL', 'DEPOSIT']);
    expect(history.map((entry) => entry.amount)).toEqual([100, 30, 5]);
    expect(history.map((entry) => entry.balanceAfter)).toEqual([100, 70, 75]);
    expect(history.every((entry) => entry.counterparty === undefined)).toBe(true);
  });

  test('timestamps are valid and never go backwards', async ({ request, newUser }) => {
    const user = await newUser();
    for (const amount of [1, 2, 3, 4]) {
      await deposit(request, user, amount);
    }
    const times = (await historyOf(request, user)).map((entry) => Date.parse(entry.timestamp));
    expect(times.every((time) => !Number.isNaN(time))).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  test('balanceAfter of the last entry equals the current balance', async ({ request, newUser }) => {
    const user = await newUser();
    await deposit(request, user, 12.34);
    await withdraw(request, user, 2.34);
    const history = await historyOf(request, user);
    expect(history[history.length - 1]?.balanceAfter).toBe(await balanceOf(request, user));
  });
});
