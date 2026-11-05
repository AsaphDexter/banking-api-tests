// Exploratory test: how many logins per second can the API sustain?
// Login is deliberately slow (password hashing) and the bank runs one login at a time,
// so this shows the ceiling rather than passing or failing on a tight limit.
// Run:  k6 run perf/login-throughput.js
import { check } from 'k6';
import { createUser, post, runId, PASSWORD } from './lib.js';

export const options = {
  vus: 4,
  duration: '20s',
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:login}': ['p(95)<5000'],
  },
};

export function setup() {
  return createUser(`logn${runId()}`);
}

export default function (user) {
  const response = post('/api/login', { username: user.username, password: PASSWORD }, null, 'login');
  check(response, { 'login 200': (r) => r.status === 200 });
}
