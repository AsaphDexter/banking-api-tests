// Small helpers shared by the k6 scripts.
import http from 'k6/http';
import { check, fail } from 'k6';

export const BASE_URL = __ENV.API_URL || 'http://localhost:8080';
export const PASSWORD = 'Passw0rd1';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** A short random id so repeated runs never collide on usernames. */
export function runId() {
  return Math.random().toString(36).slice(2, 7);
}

export function post(path, body, token, name) {
  const headers = Object.assign({}, JSON_HEADERS);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), { headers, tags: { name: name || path } });
}

export function get(path, token, name) {
  return http.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { name: name || path },
  });
}

/** Registers a user, logs in and returns { username, accountNumber, token }. Fails the run if setup breaks. */
export function createUser(username) {
  const registered = post('/api/register', { username, fullName: `Load ${username}`, password: PASSWORD }, null, 'setup_register');
  if (!check(registered, { 'setup: registered': (r) => r.status === 201 })) {
    fail(`could not register ${username}: ${registered.status} ${registered.body}`);
  }
  const accountNumber = registered.json('accountNumber');
  const login = post('/api/login', { username, password: PASSWORD }, null, 'setup_login');
  if (!check(login, { 'setup: logged in': (r) => r.status === 200 })) {
    fail(`could not log in ${username}: ${login.status} ${login.body}`);
  }
  return { username, accountNumber, token: login.json('token') };
}
