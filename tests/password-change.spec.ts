import {
  bearer, createUser, expect, login, test, uniqueUsername, register, PASSWORD,
} from './support/fixtures';

const NEW_PASSWORD = 'N3wPassword';

test.describe('change password', () => {
  test('replaces the password: the old one stops working and the new one works', async ({ request, newUser }) => {
    const user = await newUser();
    const response = await request.post('/api/password', {
      headers: user.headers,
      data: { oldPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(response.status()).toBe(204);
    expect(await response.text()).toBe('');
    expect((await request.post('/api/login', { data: { username: user.username, password: PASSWORD } })).status()).toBe(401);
    expect((await request.post('/api/login', { data: { username: user.username, password: NEW_PASSWORD } })).status()).toBe(200);
  });

  test('ends every other session of the user but keeps the one that changed it', async ({ request, newUser }) => {
    const user = await newUser();
    const otherDevice = await login(request, user.username);
    const thirdDevice = await login(request, user.username);

    await request.post('/api/password', { headers: user.headers, data: { oldPassword: PASSWORD, newPassword: NEW_PASSWORD } });

    expect((await request.get('/api/account', { headers: user.headers })).status()).toBe(200);
    expect((await request.get('/api/account', { headers: bearer(otherDevice) })).status()).toBe(401);
    expect((await request.get('/api/account', { headers: bearer(thirdDevice) })).status()).toBe(401);
  });

  test('never touches another user\'s sessions or password', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    await request.post('/api/password', { headers: alice.headers, data: { oldPassword: PASSWORD, newPassword: NEW_PASSWORD } });
    expect((await request.get('/api/account', { headers: bob.headers })).status()).toBe(200);
    expect((await request.post('/api/login', { data: { username: bob.username, password: PASSWORD } })).status()).toBe(200);
  });

  test('keeps the balance and history', async ({ request, newUser }) => {
    const user = await newUser();
    await request.post('/api/deposit', { headers: user.headers, data: { amount: 42.5 } });
    await request.post('/api/password', { headers: user.headers, data: { oldPassword: PASSWORD, newPassword: NEW_PASSWORD } });
    const account = (await (await request.get('/api/account', { headers: user.headers })).json()) as { balance: number };
    expect(account.balance).toBe(42.5);
  });

  test('a wrong current password is 403 and changes nothing', async ({ request, newUser }) => {
    const user = await newUser();
    const response = await request.post('/api/password', {
      headers: user.headers,
      data: { oldPassword: 'Wrong1111', newPassword: NEW_PASSWORD },
    });
    expect(response.status()).toBe(403);
    expect((await request.post('/api/login', { data: { username: user.username, password: PASSWORD } })).status()).toBe(200);
    expect((await request.post('/api/login', { data: { username: user.username, password: NEW_PASSWORD } })).status()).toBe(401);
  });

  test('guessing the current password with a stolen token locks the account after three tries', async ({ request, newUser }) => {
    const user = await newUser();
    const statuses: number[] = [];
    for (const guess of ['Wrong1111', 'Wrong2222', 'Wrong3333', PASSWORD]) {
      const response = await request.post('/api/password', {
        headers: user.headers,
        data: { oldPassword: guess, newPassword: NEW_PASSWORD },
      });
      statuses.push(response.status());
    }
    expect(statuses).toEqual([403, 403, 423, 423]); // even the right password is refused once locked
    expect((await request.post('/api/login', { data: { username: user.username, password: PASSWORD } })).status()).toBe(423);
  });

  const weak: Array<[string, string]> = [
    ['shorter than 8 characters', 'Abc1234'],
    ['letters only', 'onlyletters'],
    ['digits only', '12345678'],
    ['identical to the current password', PASSWORD],
  ];
  for (const [label, newPassword] of weak) {
    test(`a new password that is ${label} is 400 and the old one still works`, async ({ request, newUser }) => {
      const user = await newUser();
      const response = await request.post('/api/password', {
        headers: user.headers,
        data: { oldPassword: PASSWORD, newPassword },
      });
      expect(response.status()).toBe(400);
      expect((await request.post('/api/login', { data: { username: user.username, password: PASSWORD } })).status()).toBe(200);
    });
  }

  test('a new password equal to the username is 400', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    const token = await login(request, username);
    const response = await request.post('/api/password', {
      headers: bearer(token),
      data: { oldPassword: PASSWORD, newPassword: username },
    });
    expect(response.status()).toBe(400);
  });

  const badBodies: Array<[string, object]> = [
    ['no new password', { oldPassword: PASSWORD }],
    ['no old password', { newPassword: NEW_PASSWORD }],
    ['empty values', { oldPassword: '', newPassword: '' }],
    ['numbers instead of text', { oldPassword: 12345678, newPassword: 87654321 }],
    ['an extra field', { oldPassword: PASSWORD, newPassword: NEW_PASSWORD, username: 'someone-else' }],
  ];
  for (const [label, data] of badBodies) {
    test(`a request with ${label} is 400`, async ({ request, newUser }) => {
      const user = await newUser();
      const response = await request.post('/api/password', { headers: user.headers, data });
      expect(response.status()).toBe(400);
    });
  }

  test('there is no way to change someone else\'s password: the endpoint only acts on the token owner', async ({ request, newUser }) => {
    const alice = await newUser();
    const bob = await newUser();
    const response = await request.post('/api/password', {
      headers: bob.headers,
      data: { oldPassword: PASSWORD, newPassword: NEW_PASSWORD, username: alice.username },
    });
    expect(response.status()).toBe(400); // the extra field is refused, never obeyed
    expect((await request.post('/api/login', { data: { username: alice.username, password: PASSWORD } })).status()).toBe(200);
  });

  test('a password can be changed more than once', async ({ request }) => {
    const user = await createUser(request);
    const sequence = [PASSWORD, NEW_PASSWORD, 'An0therOne99', 'Fin4lChoice77'];
    let token = user.token;
    for (let i = 0; i < sequence.length - 1; i += 1) {
      const response = await request.post('/api/password', {
        headers: bearer(token),
        data: { oldPassword: sequence[i], newPassword: sequence[i + 1] },
      });
      expect(response.status(), `change ${i + 1}`).toBe(204);
      token = await login(request, user.username, sequence[i + 1]);
    }
    expect((await request.post('/api/login', { data: { username: user.username, password: 'Fin4lChoice77' } })).status()).toBe(200);
  });
});
