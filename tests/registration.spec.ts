import { expect, test, uniqueUsername, register, postRaw, PASSWORD } from './support/fixtures';

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_';

function randomName(length: number): string {
  let name = '';
  for (let i = 0; i < length; i += 1) {
    name += LETTERS[Math.floor(Math.random() * LETTERS.length)];
  }
  return name;
}

test.describe('registration', () => {
  test('creates an account and returns the account number, never secrets', async ({ request }) => {
    const username = uniqueUsername();
    const response = await register(request, username, PASSWORD, 'Ada Lovelace');
    expect(response.status()).toBe(201);
    const body = (await response.json()) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(['accountNumber', 'fullName', 'username']);
    expect(body['username']).toBe(username);
    expect(body['fullName']).toBe('Ada Lovelace');
    expect(body['accountNumber']).toMatch(/^\d{10}$/);
    const text = JSON.stringify(body);
    expect(text).not.toContain(PASSWORD);
    expect(text.toLowerCase()).not.toContain('pbkdf2');
  });

  test('usernames are stored in lower case and names are trimmed', async ({ request }) => {
    const username = uniqueUsername('Abc');
    const response = await register(request, username.toUpperCase(), PASSWORD, '  Ada Lovelace  ');
    expect(response.status()).toBe(201);
    const body = (await response.json()) as Record<string, string>;
    expect(body['username']).toBe(username.toLowerCase());
    expect(body['fullName']).toBe('Ada Lovelace');
  });

  test('every user gets a different account number', async ({ request }) => {
    const first = (await (await register(request)).json()) as { accountNumber: string };
    const second = (await (await register(request)).json()) as { accountNumber: string };
    expect(first.accountNumber).not.toBe(second.accountNumber);
  });

  test('a taken username is 409, whatever the letter case', async ({ request }) => {
    const username = uniqueUsername();
    expect((await register(request, username)).status()).toBe(201);
    expect((await register(request, username)).status()).toBe(409);
    expect((await register(request, username.toUpperCase())).status()).toBe(409);
  });

  test('usernames of exactly 3 and 20 characters are accepted', async ({ request }) => {
    for (const length of [3, 20]) {
      let status = 0;
      for (let attempt = 0; attempt < 5 && status !== 201; attempt += 1) {
        status = (await register(request, randomName(length))).status(); // retry only if the random name was taken
      }
      expect(status, `length ${length}`).toBe(201);
    }
  });

  const badUsernames: Array<[string, string]> = [
    ['too short (2)', 'ab'],
    ['too long (21)', 'a'.repeat(21)],
    ['contains a space', 'has space'],
    ['contains a dash', 'dash-name'],
    ['contains punctuation', 'bad!name'],
    ['contains non-ASCII letters', 'ünïcode'],
    ['looks like SQL', "x'; DROP TABLE users;--"],
    ['empty', ''],
    ['only spaces', '   '],
  ];
  for (const [label, username] of badUsernames) {
    test(`rejects a username that is ${label}`, async ({ request }) => {
      const response = await register(request, username);
      expect(response.status()).toBe(400);
    });
  }

  const badPasswords: Array<[string, string]> = [
    ['shorter than 8 characters', 'Abc1234'],
    ['letters only', 'onlyletters'],
    ['digits only', '12345678'],
    ['empty', ''],
  ];
  for (const [label, password] of badPasswords) {
    test(`rejects a password that is ${label}`, async ({ request }) => {
      const response = await register(request, uniqueUsername(), password);
      expect(response.status()).toBe(400);
    });
  }

  test('rejects a password identical to the username', async ({ request }) => {
    const username = uniqueUsername();
    const response = await register(request, username, username);
    expect(response.status()).toBe(400);
  });

  test('accepts a password of exactly 8 characters', async ({ request }) => {
    expect((await register(request, uniqueUsername(), 'abcdefg1')).status()).toBe(201);
  });

  for (const field of ['username', 'fullName', 'password']) {
    test(`rejects a request without ${field}`, async ({ request }) => {
      const data: Record<string, string> = { username: uniqueUsername(), fullName: 'Test User', password: PASSWORD };
      delete data[field];
      const response = await request.post('/api/register', { data });
      expect(response.status()).toBe(400);
    });
  }

  test('rejects a blank full name', async ({ request }) => {
    const response = await request.post('/api/register', {
      data: { username: uniqueUsername(), fullName: '   ', password: PASSWORD },
    });
    expect(response.status()).toBe(400);
  });

  test('rejects unexpected fields instead of ignoring them (no mass assignment)', async ({ request }) => {
    const response = await request.post('/api/register', {
      data: { username: uniqueUsername(), fullName: 'Test User', password: PASSWORD, role: 'admin', balance: 1000000 },
    });
    expect(response.status()).toBe(400);
  });

  const wrongTypes: Array<[string, unknown]> = [
    ['username as a number', { username: 12345, fullName: 'A B', password: PASSWORD }],
    ['password as a number', { username: 'typeuser1', fullName: 'A B', password: 12345678 }],
    ['fullName as a list', { username: 'typeuser2', fullName: ['A', 'B'], password: PASSWORD }],
    ['password as an object', { username: 'typeuser3', fullName: 'A B', password: { value: PASSWORD } }],
    ['password as true', { username: 'typeuser4', fullName: 'A B', password: true }],
  ];
  for (const [label, data] of wrongTypes) {
    test(`rejects ${label}`, async ({ request }) => {
      const response = await request.post('/api/register', { data: data as object });
      expect(response.status()).toBe(400);
    });
  }

  const notAnObject = ['[]', '"text"', 'null', '42', '', '{broken', '{"username":"a"} {"x":1}'];
  for (const body of notAnObject) {
    test(`rejects the body ${JSON.stringify(body)}`, async ({ request }) => {
      const response = await postRaw(request, '/api/register', body);
      expect(response.status()).toBe(400);
    });
  }

  test('a rejected registration does not reserve the username', async ({ request }) => {
    const username = uniqueUsername();
    expect((await register(request, username, 'short1')).status()).toBe(400);
    expect((await register(request, username, PASSWORD)).status()).toBe(201);
  });
});
