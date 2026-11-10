import { request as playwrightRequest, type APIRequestContext, type APIResponse } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  adminHeaders, bearer, deposit, expect, isUp, lockOut, postRaw, register, test, transfer, uniqueUsername,
  PASSWORD, type TestUser,
} from './support/fixtures';
import { contractProblems, loadSpec, operationsOf, type Spec } from './support/openapi';

/**
 * Contract tests: the API publishes an OpenAPI description of itself at /api/openapi.yaml, and these tests
 * check that real answers match it. If the code and the description drift apart, a test fails.
 *
 * 1. the description is a valid OpenAPI 3 document and is complete and consistent
 * 2. every answer the description promises has a scenario here that makes the API give it,
 *    and the real answer is checked against the description (status, content type, body shape, required headers)
 * 3. every documented response has a scenario, and every scenario is documented
 */

let specPromise: Promise<Spec> | undefined;
const specFor = (request: APIRequestContext): Promise<Spec> => {
  specPromise ??= loadSpec(request).then((loaded) => loaded.spec);
  return specPromise;
};

interface Context {
  request: APIRequestContext;
  newUser: () => Promise<TestUser>;
}

interface Scenario {
  method: 'GET' | 'POST';
  path: string;
  status: number;
  name: string;
  /** 'noAdmin' runs against the instance that has no admin token (the 2-second-lockout one). */
  target?: 'noAdmin';
  run: (context: Context) => Promise<APIResponse>;
}

const hugeBody = JSON.stringify({ username: 'a'.repeat(20_000), password: PASSWORD });
const asText = (request: APIRequestContext, path: string, headers: Record<string, string> = {}): Promise<APIResponse> =>
  request.post(path, { headers: { ...headers, 'Content-Type': 'text/plain' }, data: '{}' });

const scenarios: Scenario[] = [
  // ---- service
  { method: 'GET', path: '/api/health', status: 200, name: 'the service is up', run: ({ request }) => request.get('/api/health') },
  { method: 'GET', path: '/api/openapi.yaml', status: 200, name: 'the description itself', run: ({ request }) => request.get('/api/openapi.yaml') },

  // ---- register
  { method: 'POST', path: '/api/register', status: 201, name: 'a new account', run: ({ request }) => register(request) },
  { method: 'POST', path: '/api/register', status: 400, name: 'a weak password', run: ({ request }) => register(request, uniqueUsername(), 'weak') },
  {
    method: 'POST', path: '/api/register', status: 409, name: 'a taken username',
    run: async ({ request }) => {
      const username = uniqueUsername();
      await register(request, username);
      return register(request, username);
    },
  },
  { method: 'POST', path: '/api/register', status: 413, name: 'a body over 10 KB', run: ({ request }) => postRaw(request, '/api/register', hugeBody) },
  { method: 'POST', path: '/api/register', status: 415, name: 'not JSON', run: ({ request }) => asText(request, '/api/register') },

  // ---- login
  {
    method: 'POST', path: '/api/login', status: 200, name: 'correct credentials',
    run: async ({ request, newUser }) => {
      const user = await newUser();
      return request.post('/api/login', { data: { username: user.username, password: PASSWORD } });
    },
  },
  { method: 'POST', path: '/api/login', status: 400, name: 'an empty body', run: ({ request }) => request.post('/api/login', { data: {} }) },
  {
    method: 'POST', path: '/api/login', status: 401, name: 'an unknown user',
    run: ({ request }) => request.post('/api/login', { data: { username: uniqueUsername(), password: PASSWORD } }),
  },
  { method: 'POST', path: '/api/login', status: 413, name: 'a body over 10 KB', run: ({ request }) => postRaw(request, '/api/login', hugeBody) },
  { method: 'POST', path: '/api/login', status: 415, name: 'not JSON', run: ({ request }) => asText(request, '/api/login') },
  {
    method: 'POST', path: '/api/login', status: 423, name: 'a locked account (Retry-After required)',
    run: async ({ request }) => {
      const username = uniqueUsername();
      await register(request, username);
      await lockOut(request, username);
      return request.post('/api/login', { data: { username, password: PASSWORD } });
    },
  },

  // ---- logout, account, transactions
  {
    method: 'POST', path: '/api/logout', status: 204, name: 'ends the session',
    run: async ({ request, newUser }) => request.post('/api/logout', { headers: (await newUser()).headers, data: {} }),
  },
  { method: 'POST', path: '/api/logout', status: 401, name: 'no token', run: ({ request }) => request.post('/api/logout', { data: {} }) },
  {
    method: 'GET', path: '/api/account', status: 200, name: 'my account',
    run: async ({ request, newUser }) => request.get('/api/account', { headers: (await newUser()).headers }),
  },
  { method: 'GET', path: '/api/account', status: 401, name: 'no token', run: ({ request }) => request.get('/api/account') },
  {
    method: 'GET', path: '/api/transactions', status: 200, name: 'a history with deposits and transfers',
    run: async ({ request, newUser }) => {
      const alice = await newUser();
      const bob = await newUser();
      await deposit(request, alice, 25.5);
      await transfer(request, alice, bob.accountNumber, 10);
      return request.get('/api/transactions', { headers: alice.headers });
    },
  },
  { method: 'GET', path: '/api/transactions', status: 401, name: 'no token', run: ({ request }) => request.get('/api/transactions') },

  // ---- change password
  {
    method: 'POST', path: '/api/password', status: 204, name: 'a changed password',
    run: async ({ request, newUser }) => request.post('/api/password', {
      headers: (await newUser()).headers, data: { oldPassword: PASSWORD, newPassword: 'N3wPassword' },
    }),
  },
  {
    method: 'POST', path: '/api/password', status: 400, name: 'a weak new password',
    run: async ({ request, newUser }) => request.post('/api/password', {
      headers: (await newUser()).headers, data: { oldPassword: PASSWORD, newPassword: 'weak' },
    }),
  },
  { method: 'POST', path: '/api/password', status: 401, name: 'no token', run: ({ request }) => request.post('/api/password', { data: { oldPassword: PASSWORD, newPassword: 'N3wPassword' } }) },
  {
    method: 'POST', path: '/api/password', status: 403, name: 'a wrong current password',
    run: async ({ request, newUser }) => request.post('/api/password', {
      headers: (await newUser()).headers, data: { oldPassword: 'Wrong1111', newPassword: 'N3wPassword' },
    }),
  },
  {
    method: 'POST', path: '/api/password', status: 413, name: 'a body over 10 KB',
    run: async ({ request, newUser }) => postRaw(request, '/api/password', hugeBody, (await newUser()).headers),
  },
  {
    method: 'POST', path: '/api/password', status: 415, name: 'not JSON',
    run: async ({ request, newUser }) => asText(request, '/api/password', (await newUser()).headers),
  },
  {
    method: 'POST', path: '/api/password', status: 423, name: 'a locked account (Retry-After required)',
    run: async ({ request, newUser }) => {
      const user = await newUser();
      let last: APIResponse | undefined;
      for (const guess of ['Wrong1111', 'Wrong2222', 'Wrong3333']) {
        last = await request.post('/api/password', { headers: user.headers, data: { oldPassword: guess, newPassword: 'N3wPassword' } });
      }
      return last as APIResponse;
    },
  },

  // ---- deposit
  {
    method: 'POST', path: '/api/deposit', status: 200, name: 'a deposit with an idempotency key (Idempotent-Replayed: false)',
    run: async ({ request, newUser }) => request.post('/api/deposit', {
      headers: { ...(await newUser()).headers, 'Idempotency-Key': randomUUID() }, data: { amount: 10 },
    }),
  },
  {
    method: 'POST', path: '/api/deposit', status: 200, name: 'a repeated deposit (Idempotent-Replayed: true)',
    run: async ({ request, newUser }) => {
      const headers = { ...(await newUser()).headers, 'Idempotency-Key': randomUUID() };
      await request.post('/api/deposit', { headers, data: { amount: 10 } });
      return request.post('/api/deposit', { headers, data: { amount: 10 } });
    },
  },
  {
    method: 'POST', path: '/api/deposit', status: 400, name: 'a negative amount',
    run: async ({ request, newUser }) => deposit(request, await newUser(), -5),
  },
  { method: 'POST', path: '/api/deposit', status: 401, name: 'no token', run: ({ request }) => request.post('/api/deposit', { data: { amount: 5 } }) },
  {
    method: 'POST', path: '/api/deposit', status: 413, name: 'a body over 10 KB',
    run: async ({ request, newUser }) => postRaw(request, '/api/deposit', hugeBody, (await newUser()).headers),
  },
  {
    method: 'POST', path: '/api/deposit', status: 415, name: 'not JSON',
    run: async ({ request, newUser }) => asText(request, '/api/deposit', (await newUser()).headers),
  },
  {
    method: 'POST', path: '/api/deposit', status: 422, name: 'an idempotency key reused for another amount',
    run: async ({ request, newUser }) => {
      const headers = { ...(await newUser()).headers, 'Idempotency-Key': randomUUID() };
      await request.post('/api/deposit', { headers, data: { amount: 10 } });
      return request.post('/api/deposit', { headers, data: { amount: 11 } });
    },
  },

  // ---- withdraw
  {
    method: 'POST', path: '/api/withdraw', status: 200, name: 'a withdrawal',
    run: async ({ request, newUser }) => {
      const user = await newUser();
      await deposit(request, user, 50);
      return request.post('/api/withdraw', { headers: user.headers, data: { amount: 20 } });
    },
  },
  {
    method: 'POST', path: '/api/withdraw', status: 400, name: 'zero',
    run: async ({ request, newUser }) => request.post('/api/withdraw', { headers: (await newUser()).headers, data: { amount: 0 } }),
  },
  { method: 'POST', path: '/api/withdraw', status: 401, name: 'no token', run: ({ request }) => request.post('/api/withdraw', { data: { amount: 5 } }) },
  {
    method: 'POST', path: '/api/withdraw', status: 413, name: 'a body over 10 KB',
    run: async ({ request, newUser }) => postRaw(request, '/api/withdraw', hugeBody, (await newUser()).headers),
  },
  {
    method: 'POST', path: '/api/withdraw', status: 415, name: 'not JSON',
    run: async ({ request, newUser }) => asText(request, '/api/withdraw', (await newUser()).headers),
  },
  {
    method: 'POST', path: '/api/withdraw', status: 422, name: 'more than the balance',
    run: async ({ request, newUser }) => request.post('/api/withdraw', { headers: (await newUser()).headers, data: { amount: 5 } }),
  },

  // ---- transfer
  {
    method: 'POST', path: '/api/transfer', status: 200, name: 'a transfer',
    run: async ({ request, newUser }) => {
      const alice = await newUser();
      const bob = await newUser();
      await deposit(request, alice, 50);
      return transfer(request, alice, bob.accountNumber, 20);
    },
  },
  {
    method: 'POST', path: '/api/transfer', status: 400, name: 'a transfer to yourself',
    run: async ({ request, newUser }) => {
      const alice = await newUser();
      await deposit(request, alice, 50);
      return transfer(request, alice, alice.accountNumber, 5);
    },
  },
  { method: 'POST', path: '/api/transfer', status: 401, name: 'no token', run: ({ request }) => request.post('/api/transfer', { data: { toAccountNumber: '1000000001', amount: 5 } }) },
  {
    method: 'POST', path: '/api/transfer', status: 404, name: 'an unknown recipient',
    run: async ({ request, newUser }) => {
      const alice = await newUser();
      await deposit(request, alice, 50);
      return transfer(request, alice, '9999999999', 5);
    },
  },
  {
    method: 'POST', path: '/api/transfer', status: 413, name: 'a body over 10 KB',
    run: async ({ request, newUser }) => postRaw(request, '/api/transfer', hugeBody, (await newUser()).headers),
  },
  {
    method: 'POST', path: '/api/transfer', status: 415, name: 'not JSON',
    run: async ({ request, newUser }) => asText(request, '/api/transfer', (await newUser()).headers),
  },
  {
    method: 'POST', path: '/api/transfer', status: 422, name: 'more than the balance',
    run: async ({ request, newUser }) => {
      const alice = await newUser();
      const bob = await newUser();
      return transfer(request, alice, bob.accountNumber, 5);
    },
  },

  // ---- admin: unlock
  {
    method: 'POST', path: '/api/admin/unlock', status: 204, name: 'a user unlocked',
    run: async ({ request, newUser }) => request.post('/api/admin/unlock', { headers: adminHeaders, data: { username: (await newUser()).username } }),
  },
  { method: 'POST', path: '/api/admin/unlock', status: 400, name: 'no username', run: ({ request }) => request.post('/api/admin/unlock', { headers: adminHeaders, data: {} }) },
  { method: 'POST', path: '/api/admin/unlock', status: 401, name: 'no admin token', run: ({ request }) => request.post('/api/admin/unlock', { data: { username: 'someone' } }) },
  {
    method: 'POST', path: '/api/admin/unlock', status: 404, name: 'an unknown user',
    run: ({ request }) => request.post('/api/admin/unlock', { headers: adminHeaders, data: { username: uniqueUsername() } }),
  },
  { method: 'POST', path: '/api/admin/unlock', status: 413, name: 'a body over 10 KB', run: ({ request }) => postRaw(request, '/api/admin/unlock', hugeBody, adminHeaders) },
  { method: 'POST', path: '/api/admin/unlock', status: 415, name: 'not JSON', run: ({ request }) => asText(request, '/api/admin/unlock', adminHeaders) },

  // ---- admin: audit
  {
    method: 'GET', path: '/api/admin/audit', status: 200, name: 'events for a user who did several things',
    run: async ({ request, newUser }) => {
      const user = await newUser();
      await deposit(request, user, 5);
      await request.post('/api/login', { data: { username: user.username, password: 'Wrong1111' } });
      return request.get(`/api/admin/audit?username=${user.username}`, { headers: adminHeaders });
    },
  },
  { method: 'GET', path: '/api/admin/audit', status: 400, name: 'a limit of 0', run: ({ request }) => request.get('/api/admin/audit?limit=0', { headers: adminHeaders }) },
  { method: 'GET', path: '/api/admin/audit', status: 401, name: 'no admin token', run: ({ request }) => request.get('/api/admin/audit') },
  {
    method: 'GET', path: '/api/admin/audit', status: 404, name: 'an instance with the admin API switched off', target: 'noAdmin',
    run: ({ request }) => request.get('/api/admin/audit', { headers: adminHeaders }),
  },
];

/** Answers that need an instance with a login limit; throttle.spec.ts checks those 429 answers against the spec. */
const COVERED_IN_THROTTLE_SPEC = ['POST /api/login 429', 'POST /api/password 429', 'POST /api/admin/unlock 429', 'GET /api/admin/audit 429'];

test.describe('the OpenAPI description', () => {
  test('is served, valid OpenAPI 3, and loads without broken references', async ({ request }) => {
    const spec = await specFor(request); // loadSpec throws if the document is not valid
    expect(spec.openapi).toMatch(/^3\.0\./);
    expect(Object.keys(spec.paths).length).toBeGreaterThanOrEqual(13);
  });

  test('every operation has a unique operationId and a summary', async ({ request }) => {
    const spec = await specFor(request);
    const ids = operationsOf(spec).map(({ operation }) => operation.operationId);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { method, path, operation } of operationsOf(spec)) {
      expect(operation.summary, `${method} ${path}`).toBeTruthy();
    }
  });

  test('every secured operation documents a 401 and every operation with a body documents 400, 413 and 415', async ({ request }) => {
    const spec = await specFor(request);
    for (const { method, path, operation } of operationsOf(spec)) {
      const codes = Object.keys(operation.responses);
      if (operation.security && operation.security.length > 0) {
        expect(codes, `${method} ${path}`).toContain('401');
      }
      if ((operation as { requestBody?: unknown }).requestBody) {
        for (const code of ['400', '413', '415']) {
          expect(codes, `${method} ${path}`).toContain(code);
        }
      }
    }
  });

  test('every documented response has a scenario below, and every scenario is documented', async ({ request }) => {
    const spec = await specFor(request);
    const documented = new Set<string>();
    for (const { method, path, operation } of operationsOf(spec)) {
      for (const status of Object.keys(operation.responses)) {
        documented.add(`${method} ${path} ${status}`);
      }
    }
    const throttled = [...documented].filter((entry) => entry.endsWith(' 429')).sort();
    expect(throttled, 'the 429 answers in the spec must be exactly the ones throttle.spec.ts checks').toEqual([...COVERED_IN_THROTTLE_SPEC].sort());

    const covered = new Set(scenarios.map((scenario) => `${scenario.method} ${scenario.path} ${scenario.status}`));
    const needed = [...documented].filter((entry) => !entry.endsWith(' 429'));
    expect(needed.filter((entry) => !covered.has(entry)), 'documented but never exercised').toEqual([]);
    expect([...covered].filter((entry) => !documented.has(entry)), 'exercised but not documented').toEqual([]);
  });
});

test.describe('real answers match the description', () => {
  for (const scenario of scenarios) {
    test(`${scenario.method} ${scenario.path} → ${scenario.status}: ${scenario.name}`, async ({ request, newUser }) => {
      const spec = await specFor(request);
      let target = request;
      let extra: APIRequestContext | undefined;
      if (scenario.target === 'noAdmin') {
        extra = await playwrightRequest.newContext({ baseURL: process.env.API_URL_SHORT_LOCKOUT ?? 'http://localhost:8081' });
        test.skip(!(await isUp(extra)), 'needs the instance without an admin token (API_URL_SHORT_LOCKOUT, port 8081)');
        target = extra;
      }
      try {
        const response = await scenario.run({ request: target, newUser });
        expect(response.status(), 'status').toBe(scenario.status);
        expect(await contractProblems(response, scenario.method, scenario.path, spec)).toEqual([]);
      } finally {
        await extra?.dispose();
      }
    });
  }

  test('an answer the spec does not list is reported as a problem (the checker itself works)', async ({ request }) => {
    const spec = await specFor(request);
    const response = await request.get('/api/health');
    expect(await contractProblems(response, 'GET', '/api/health', spec)).toEqual([]);
    // pretend /api/health promised only a 404: the same real answer must now be reported
    const lying = structuredClone(spec);
    lying.paths['/api/health']!['get']!.responses = { '404': lying.paths['/api/health']!['get']!.responses['200']! };
    expect((await contractProblems(response, 'GET', '/api/health', lying)).join(' ')).toContain('does not list');
    // and a body of the wrong shape is caught
    const wrongShape = structuredClone(spec);
    wrongShape.paths['/api/health']!['get']!.responses['200']!.content!['application/json']!.schema = {
      type: 'object', required: ['status', 'version'], properties: { status: { type: 'string' }, version: { type: 'string' } },
    };
    expect((await contractProblems(response, 'GET', '/api/health', wrongShape)).join(' ')).toContain('version');
  });

  test('a protected endpoint with a valid token is not answered as unauthorised (the 401 scenarios are meaningful)', async ({ request, newUser }) => {
    const user = await newUser();
    expect((await request.get('/api/account', { headers: bearer(user.token) })).status()).toBe(200);
  });
});
