import {
  balanceOf, deposit, expect, postRaw, test, transfer, type TestUser,
} from './support/fixtures';

interface HistoryEntry {
  type: string;
  amount: number;
  counterparty?: string;
  balanceAfter: number;
}

async function historyOf(request: Parameters<typeof balanceOf>[0], user: TestUser): Promise<HistoryEntry[]> {
  return (await (await request.get('/api/transactions', { headers: user.headers })).json()) as HistoryEntry[];
}

test.describe('transfers', () => {
  test('moves money from the caller to another user and returns the new balance', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    await deposit(request, alice, 100);

    const response = await transfer(request, alice, bob.accountNumber, 40.25);
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe('{"balance":59.75}');
    expect(await balanceOf(request, alice)).toBe(59.75);
    expect(await balanceOf(request, bob)).toBe(40.25);
  });

  test('both sides see the transfer in their history with the other account', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    await deposit(request, alice, 100);
    await transfer(request, alice, bob.accountNumber, 30);

    const aliceLast = (await historyOf(request, alice)).at(-1);
    expect(aliceLast).toMatchObject({ type: 'TRANSFER_OUT', amount: 30, counterparty: bob.accountNumber, balanceAfter: 70 });
    const bobHistory = await historyOf(request, bob);
    expect(bobHistory).toHaveLength(1);
    expect(bobHistory[0]).toMatchObject({ type: 'TRANSFER_IN', amount: 30, counterparty: alice.accountNumber, balanceAfter: 30 });
  });

  test('the whole balance can be transferred', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    await deposit(request, alice, 25);
    expect((await transfer(request, alice, bob.accountNumber, 25)).status()).toBe(200);
    expect(await balanceOf(request, alice)).toBe(0);
    expect(await balanceOf(request, bob)).toBe(25);
  });

  test('more than the balance is 422 and neither account changes', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    await deposit(request, alice, 10);
    const response = await transfer(request, alice, bob.accountNumber, 10.01);
    expect(response.status()).toBe(422);
    expect(await balanceOf(request, alice)).toBe(10);
    expect(await balanceOf(request, bob)).toBe(0);
    expect(await historyOf(request, alice)).toHaveLength(1);
    expect(await historyOf(request, bob)).toHaveLength(0);
  });

  test('an unknown recipient is 404 and nothing changes', async ({ request, newUser }) => {
    const alice = await newUser();
    await deposit(request, alice, 50);
    const response = await transfer(request, alice, '9999999999', 5);
    expect(response.status()).toBe(404);
    expect(((await response.json()) as { error: string }).error).toContain('9999999999');
    expect(await balanceOf(request, alice)).toBe(50);
  });

  test('transferring to your own account is 400', async ({ request, newUser }) => {
    const alice = await newUser();
    await deposit(request, alice, 50);
    expect((await transfer(request, alice, alice.accountNumber, 5)).status()).toBe(400);
    expect(await balanceOf(request, alice)).toBe(50);
    expect(await historyOf(request, alice)).toHaveLength(1);
  });

  const invalidAmounts: Array<[string, string]> = [
    ['zero', '0'], ['negative', '-1'], ['three decimals', '1.005'], ['above the maximum', '2000000000'],
    ['a huge exponent', '1e999999999'], ['text', '"5"'], ['null', 'null'],
  ];
  for (const [label, amount] of invalidAmounts) {
    test(`rejects a transfer amount that is ${label}`, async ({ request, newUser }) => {
      const alice = await newUser();
      const bob = await newUser();
      await deposit(request, alice, 100);
      const body = `{"toAccountNumber":"${bob.accountNumber}","amount":${amount}}`;
      expect((await postRaw(request, '/api/transfer', body, alice.headers)).status()).toBe(400);
      expect(await balanceOf(request, alice)).toBe(100);
      expect(await balanceOf(request, bob)).toBe(0);
    });
  }

  const invalidRecipients: Array<[string, string]> = [
    ['missing', '{"amount":5}'],
    ['blank', '{"toAccountNumber":"   ","amount":5}'],
    ['a number instead of text', '{"toAccountNumber":1000000001,"amount":5}'],
    ['null', '{"toAccountNumber":null,"amount":5}'],
    ['an unexpected extra field', '{"toAccountNumber":"1","amount":5,"fromAccountNumber":"2"}'],
  ];
  for (const [label, body] of invalidRecipients) {
    test(`rejects a transfer whose recipient is ${label}`, async ({ request, newUser }) => {
      const alice = await newUser();
      await deposit(request, alice, 100);
      const response = await postRaw(request, '/api/transfer', body, alice.headers);
      expect(response.status()).toBe(400);
      expect(await balanceOf(request, alice)).toBe(100);
    });
  }

  test('a recipient written like SQL is just an unknown account', async ({ request, newUser }) => {
    const alice = await newUser();
    await deposit(request, alice, 100);
    const response = await transfer(request, alice, "1' OR '1'='1", 5);
    expect(response.status()).toBe(404);
    expect(await balanceOf(request, alice)).toBe(100);
  });

  test('a long chain of transfers never creates or destroys money', async ({ request, newUser }) => {
    const users = [await newUser(), await newUser(), await newUser()];
    const [first] = users;
    if (!first) throw new Error('no users');
    await deposit(request, first, 300);
    const moves: Array<[number, number, number]> = [
      [0, 1, 120.1], [1, 2, 20.05], [2, 0, 5], [0, 2, 99.99], [2, 1, 0.01], [1, 0, 50],
    ];
    for (const [from, to, amount] of moves) {
      const source = users[from];
      const target = users[to];
      if (!source || !target) throw new Error('bad index');
      const response = await transfer(request, source, target.accountNumber, amount);
      expect([200, 422]).toContain(response.status());
    }
    let total = 0;
    for (const user of users) {
      total += Math.round((await balanceOf(request, user)) * 100);
      expect(await balanceOf(request, user)).toBeGreaterThanOrEqual(0);
    }
    expect(total).toBe(30000);
  });
});
