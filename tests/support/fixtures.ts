import { test as base, expect, type APIRequestContext, type APIResponse } from '@playwright/test';

export { expect };

/** A password that satisfies the API's rules (8+ characters, a letter and a number). */
export const PASSWORD = 'Passw0rd1';

export interface TestUser {
  username: string;
  password: string;
  accountNumber: string;
  token: string;
  headers: { Authorization: string };
}

let counter = 0;

/**
 * A username that is valid (3-20 letters/numbers/underscores) and unique across runs and workers,
 * so tests never collide with each other or with earlier runs against the same server.
 */
export function uniqueUsername(prefix = 'u'): string {
  counter += 1;
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `${prefix.slice(0, 3)}${random}${stamp}${counter}`.slice(0, 20);
}

export const bearer = (token: string): { Authorization: string } => ({ Authorization: `Bearer ${token}` });

export function register(
  request: APIRequestContext,
  username: string = uniqueUsername(),
  password: string = PASSWORD,
  fullName?: string,
): Promise<APIResponse> {
  return request.post('/api/register', {
    data: { username, fullName: fullName ?? `Test ${username}`, password },
  });
}

export async function login(
  request: APIRequestContext,
  username: string,
  password: string = PASSWORD,
): Promise<string> {
  const response = await request.post('/api/login', { data: { username, password } });
  expect(response.status(), `login for ${username}`).toBe(200);
  const body = (await response.json()) as { token: string };
  return body.token;
}

/** Registers a new user and logs them in. */
export async function createUser(request: APIRequestContext): Promise<TestUser> {
  const username = uniqueUsername();
  const registered = await register(request, username);
  expect(registered.status(), `register ${username}`).toBe(201);
  const { accountNumber } = (await registered.json()) as { accountNumber: string };
  const token = await login(request, username);
  return { username, password: PASSWORD, accountNumber, token, headers: bearer(token) };
}

export async function balanceOf(request: APIRequestContext, user: TestUser): Promise<number> {
  const response = await request.get('/api/account', { headers: user.headers });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { balance: number }).balance;
}

export function deposit(request: APIRequestContext, user: TestUser, amount: number): Promise<APIResponse> {
  return request.post('/api/deposit', { headers: user.headers, data: { amount } });
}

export function withdraw(request: APIRequestContext, user: TestUser, amount: number): Promise<APIResponse> {
  return request.post('/api/withdraw', { headers: user.headers, data: { amount } });
}

export function transfer(
  request: APIRequestContext,
  from: TestUser,
  toAccountNumber: string,
  amount: number,
): Promise<APIResponse> {
  return request.post('/api/transfer', { headers: from.headers, data: { toAccountNumber, amount } });
}

/** Sends a hand-written body, for cases JSON.stringify cannot produce (malformed JSON, 1e999999999 ...). */
export function postRaw(
  request: APIRequestContext,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<APIResponse> {
  return request.post(path, { data: body, headers: { 'Content-Type': 'application/json', ...headers } });
}

interface Fixtures {
  /** Creates a fresh registered and logged-in user for the test. */
  newUser: () => Promise<TestUser>;
}

export const test = base.extend<Fixtures>({
  newUser: async ({ request }, use) => {
    await use(() => createUser(request));
  },
});
