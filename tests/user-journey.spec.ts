import { expect, test, register, uniqueUsername, bearer, PASSWORD } from './support/fixtures';

test('a customer from sign-up to sign-out', async ({ request }) => {
  const aliceName = uniqueUsername();
  const bobName = uniqueUsername();
  let aliceToken = '';
  let bobAccount = '';

  await test.step('two customers register', async () => {
    const alice = await register(request, aliceName, PASSWORD, 'Alice Doe');
    const bob = await register(request, bobName, PASSWORD, 'Bob Roe');
    expect(alice.status()).toBe(201);
    expect(bob.status()).toBe(201);
    bobAccount = ((await bob.json()) as { accountNumber: string }).accountNumber;
  });

  await test.step('Alice logs in and starts with an empty account', async () => {
    const login = await request.post('/api/login', { data: { username: aliceName, password: PASSWORD } });
    expect(login.status()).toBe(200);
    aliceToken = ((await login.json()) as { token: string }).token;
    const account = await request.get('/api/account', { headers: bearer(aliceToken) });
    expect(((await account.json()) as { balance: number }).balance).toBe(0);
  });

  await test.step('Alice deposits, withdraws and is stopped from overdrawing', async () => {
    const headers = bearer(aliceToken);
    expect((await request.post('/api/deposit', { headers, data: { amount: 250.75 } })).status()).toBe(200);
    expect((await request.post('/api/withdraw', { headers, data: { amount: 20 } })).status()).toBe(200);
    expect((await request.post('/api/withdraw', { headers, data: { amount: 999 } })).status()).toBe(422);
  });

  await test.step('Alice sends Bob 50 and her balance drops', async () => {
    const response = await request.post('/api/transfer', {
      headers: bearer(aliceToken),
      data: { toAccountNumber: bobAccount, amount: 50 },
    });
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe('{"balance":180.75}');
  });

  await test.step('Bob logs in and sees exactly that money and that one transfer', async () => {
    const login = await request.post('/api/login', { data: { username: bobName, password: PASSWORD } });
    const bobToken = ((await login.json()) as { token: string }).token;
    const account = (await (await request.get('/api/account', { headers: bearer(bobToken) })).json()) as { balance: number };
    expect(account.balance).toBe(50);
    const history = (await (await request.get('/api/transactions', { headers: bearer(bobToken) })).json()) as Array<{ type: string }>;
    expect(history.map((entry) => entry.type)).toEqual(['TRANSFER_IN']);
  });

  await test.step('Alice logs out and her token is dead', async () => {
    expect((await request.post('/api/logout', { headers: bearer(aliceToken), data: {} })).status()).toBe(204);
    expect((await request.get('/api/account', { headers: bearer(aliceToken) })).status()).toBe(401);
  });
});
