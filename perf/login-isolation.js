// Does signing in slow everyone else down?
// 4 virtual users sign in continuously (each sign-in is slow on purpose: password hashing)
// while another customer makes 10 ordinary requests per second.
// If hashing holds a global lock, the ordinary requests queue behind the sign-ins and their latency explodes.
// Run:  k6 run perf/login-isolation.js
import { check } from 'k6';
import { createUser, get, post, runId, PASSWORD } from './lib.js';

export const options = {
  scenarios: {
    signins: { executor: 'constant-vus', vus: 4, duration: '20s', exec: 'signIn' },
    ordinary: {
      executor: 'constant-arrival-rate', rate: 10, timeUnit: '1s', duration: '20s',
      preAllocatedVUs: 10, maxVUs: 40, exec: 'ordinaryRequest',
    },
  },
  thresholds: {
    'http_req_duration{name:account}': ['p(95)<500'], // ordinary requests stay snappy during sign-ins
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const id = runId();
  return { signer: createUser(`iso${id}a`), customer: createUser(`iso${id}b`) };
}

export function signIn(data) {
  const response = post('/api/login', { username: data.signer.username, password: PASSWORD }, null, 'login');
  check(response, { 'login 200': (r) => r.status === 200 });
}

export function ordinaryRequest(data) {
  const response = get('/api/account', data.customer.token, 'account');
  check(response, { 'account 200': (r) => r.status === 200 });
}
