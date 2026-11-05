import {
  balanceOf, deposit, expect, test, transfer, withdraw, type TestUser,
} from './support/fixtures';

type Req = Parameters<typeof balanceOf>[0];

async function historyLength(request: Req, user: TestUser): Promise<number> {
  const response = await request.get('/api/transactions', { headers: user.headers });
  return ((await response.json()) as unknown[]).length;
}

test.describe('many requests at the same time', () => {
  test('30 parallel deposits are all counted exactly once', async ({ request, newUser }) => {
    const user = await newUser();
    const responses = await Promise.all(Array.from({ length: 30 }, () => deposit(request, user, 1)));
    expect(responses.map((response) => response.status())).toEqual(Array(30).fill(200));
    expect(await balanceOf(request, user)).toBe(30);
    expect(await historyLength(request, user)).toBe(30);
  });

  test('racing withdrawals can never overdraw: exactly the affordable ones succeed', async ({ request, newUser }) => {
    // A missing lock is a race, so it only shows up some of the time. Several rounds with many
    // simultaneous requests make it very likely to be caught.
    for (let round = 1; round <= 4; round += 1) {
      const user = await newUser();
      await deposit(request, user, 50);
      const responses = await Promise.all(Array.from({ length: 150 }, () => withdraw(request, user, 1)));
      const statuses = responses.map((response) => response.status());
      expect(statuses.filter((status) => status === 200), `round ${round}`).toHaveLength(50);
      expect(statuses.filter((status) => status === 422), `round ${round}`).toHaveLength(100);
      expect(await balanceOf(request, user), `round ${round}`).toBe(0);
      expect(await historyLength(request, user), `round ${round}`).toBe(51);
    }
  });

  test('double spend: two simultaneous transfers of the whole balance, only one wins', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    const carol = await newUser();
    await deposit(request, alice, 100);
    const [toBob, toCarol] = await Promise.all([
      transfer(request, alice, bob.accountNumber, 100),
      transfer(request, alice, carol.accountNumber, 100),
    ]);
    expect([toBob.status(), toCarol.status()].sort()).toEqual([200, 422]);
    expect(await balanceOf(request, alice)).toBe(0);
    expect((await balanceOf(request, bob)) + (await balanceOf(request, carol))).toBe(100);
  });

  test('transfers in opposite directions at the same time keep the total constant', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    await deposit(request, alice, 100);
    await deposit(request, bob, 100);
    const calls: Array<Promise<{ status(): number }>> = [];
    for (let i = 0; i < 20; i += 1) {
      calls.push(transfer(request, alice, bob.accountNumber, 7));
      calls.push(transfer(request, bob, alice.accountNumber, 3));
    }
    const statuses = (await Promise.all(calls)).map((response) => response.status());
    expect(statuses.every((status) => status === 200 || status === 422)).toBe(true);

    const aliceBalance = await balanceOf(request, alice);
    const bobBalance = await balanceOf(request, bob);
    expect(aliceBalance).toBeGreaterThanOrEqual(0);
    expect(bobBalance).toBeGreaterThanOrEqual(0);
    expect(Math.round((aliceBalance + bobBalance) * 100)).toBe(20000);
  });

  test('parallel logins for one user all succeed and give distinct tokens', async ({ request, newUser }) => {
    const user = await newUser();
    const responses = await Promise.all(Array.from({ length: 8 }, () =>
      request.post('/api/login', { data: { username: user.username, password: user.password } })));
    expect(responses.map((response) => response.status())).toEqual(Array(8).fill(200));
    const tokens = await Promise.all(responses.map(async (response) => ((await response.json()) as { token: string }).token));
    expect(new Set(tokens).size).toBe(8);
  });
});
