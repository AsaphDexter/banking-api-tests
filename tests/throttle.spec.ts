import { expect, isUp, register, test, uniqueUsername, PASSWORD, adminHeaders } from './support/fixtures';

// Runs against an API instance started with --login-failure-limit 5 (see README).
// The limit is per client address, so every failure from this machine counts. The steps below use up
// the whole allowance, so restart that instance (or wait 5 minutes) before running this spec again.
test.describe.configure({ mode: 'serial' });

test('after 5 failed logins from one client, further logins are refused with 429', async ({ request }) => {
  test.skip(!(await isUp(request)), 'Start the API with --login-failure-limit 5 on API_URL_THROTTLED (default port 8082)');

  const username = uniqueUsername();
  expect((await register(request, username)).status()).toBe(201); // registering is not a login

  const fresh = await request.post('/api/login', { data: { username: uniqueUsername(), password: 'Wrong1234' } });
  expect(fresh.status(), 'this spec needs an instance that has not been used yet; restart it').toBe(401);

  await test.step('failed logins are counted, and a success in between does NOT reset the count', async () => {
    expect((await request.post('/api/login', { data: { username: uniqueUsername(), password: 'Wrong1234' } })).status()).toBe(401); // 2
    expect((await request.post('/api/login', { data: { username, password: PASSWORD } })).status()).toBe(200);
    expect((await request.post('/api/login', { data: { username: uniqueUsername(), password: 'Wrong1234' } })).status()).toBe(401); // 3
    expect((await request.post('/api/login', { data: { username, password: PASSWORD } })).status()).toBe(200);
    expect((await request.post('/api/login', { data: { username, password: 'Wrong5555' } })).status()).toBe(401); // 4
  });

  await test.step('the fifth failure is still answered normally', async () => {
    expect((await request.post('/api/login', { data: { username: uniqueUsername(), password: 'Wrong1234' } })).status()).toBe(401); // 5
  });

  await test.step('the next attempt, even with the correct password, is 429 with a Retry-After', async () => {
    const blocked = await request.post('/api/login', { data: { username, password: PASSWORD } });
    expect(blocked.status()).toBe(429);
    const wait = Number(blocked.headers()['retry-after']);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(300);
    expect(((await blocked.json()) as { error: string }).error).toContain('Too many failed attempts');
  });

  await test.step('other parts of the API keep working, so the throttle only targets guessing', async () => {
    expect((await request.get('/api/health')).status()).toBe(200);
    expect((await register(request, uniqueUsername())).status()).toBe(201);
  });

  await test.step('admin attempts from the blocked client are refused too', async () => {
    const admin = await request.get('/api/admin/audit', { headers: adminHeaders });
    expect([404, 429]).toContain(admin.status()); // 404 if this instance has no admin token, 429 if it does
  });

  await test.step('a blocked login did not log anything in', async () => {
    const stillBlocked = await request.post('/api/login', { data: { username, password: PASSWORD } });
    expect(stillBlocked.status()).toBe(429);
  });
});
