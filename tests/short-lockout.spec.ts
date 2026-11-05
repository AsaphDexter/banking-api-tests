import { expect, isUp, lockOut, register, test, uniqueUsername, PASSWORD } from './support/fixtures';

// Runs against an API instance started with --lockout-seconds 2 (see README), so a lock can be seen ending.
test.describe('lock expiry (2-second lockout instance)', () => {
  test.beforeEach(async ({ request }) => {
    test.skip(!(await isUp(request)), 'Start the API with --lockout-seconds 2 on API_URL_SHORT_LOCKOUT (default port 8081)');
  });

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  test('a lock ends by itself and the user can log in again', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    await lockOut(request, username);

    const blocked = await request.post('/api/login', { data: { username, password: PASSWORD } });
    expect(blocked.status()).toBe(423);
    expect(Number(blocked.headers()['retry-after'])).toBeLessThanOrEqual(2);

    await wait(2600);
    expect((await request.post('/api/login', { data: { username, password: PASSWORD } })).status()).toBe(200);
  });

  test('after the lock ends the user has a full set of attempts again', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    await lockOut(request, username);
    await wait(2600);
    // two wrong guesses do not lock again, because the count started over
    expect((await request.post('/api/login', { data: { username, password: 'Wrong1111' } })).status()).toBe(401);
    expect((await request.post('/api/login', { data: { username, password: 'Wrong2222' } })).status()).toBe(401);
    expect((await request.post('/api/login', { data: { username, password: PASSWORD } })).status()).toBe(200);
  });

  test('locking again needs a whole new run of three failures', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    await lockOut(request, username);
    await wait(2600);
    await lockOut(request, username);
    expect((await request.post('/api/login', { data: { username, password: PASSWORD } })).status()).toBe(423);
  });

  test('hammering a locked account does not extend the lock', async ({ request }) => {
    const username = uniqueUsername();
    await register(request, username);
    await lockOut(request, username);
    for (let i = 0; i < 5; i += 1) {
      expect((await request.post('/api/login', { data: { username, password: 'Wrong9999' } })).status()).toBe(423);
    }
    await wait(2600);
    expect((await request.post('/api/login', { data: { username, password: PASSWORD } })).status()).toBe(200);
  });
});
