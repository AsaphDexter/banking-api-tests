// Load test: many customers moving money at once.
//   - setup registers USERS customers, each with INITIAL money
//   - each virtual user repeatedly transfers 1.00 to a random other customer and checks an account
//   - at the end the test adds up every balance: no money may have been created or destroyed
// Run:  k6 run perf/load.js          (USERS=20 by default; API_URL to point elsewhere)
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { createUser, get, post, runId } from './lib.js';

const USERS = Number(__ENV.USERS || 20);
const INITIAL = 1000;
const moneyDrift = new Counter('money_drift');

export const options = {
  setupTimeout: '300s',
  scenarios: {
    customers: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '30s', target: 10 },
        { duration: '5s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:transfer}': ['p(95)<500'],
    'http_req_duration{name:account}': ['p(95)<300'],
    money_drift: ['count==0'], // the sum of all balances must be unchanged
  },
};

export function setup() {
  const id = runId();
  const users = [];
  for (let i = 0; i < USERS; i += 1) {
    const user = createUser(`load${id}${i}`);
    const deposit = post('/api/deposit', { amount: INITIAL }, user.token, 'setup_deposit');
    check(deposit, { 'setup: deposited': (r) => r.status === 200 });
    users.push(user);
  }
  return { users, expectedTotal: USERS * INITIAL };
}

export default function (data) {
  const me = data.users[(__VU - 1) % data.users.length];
  let other = data.users[Math.floor(Math.random() * data.users.length)];
  while (other.accountNumber === me.accountNumber) {
    other = data.users[Math.floor(Math.random() * data.users.length)];
  }

  const transfer = post('/api/transfer', { toAccountNumber: other.accountNumber, amount: 1 }, me.token, 'transfer');
  check(transfer, { 'transfer 200': (r) => r.status === 200 });

  const account = get('/api/account', me.token, 'account');
  check(account, { 'account 200': (r) => r.status === 200 });

  sleep(0.1 + Math.random() * 0.2);
}

export function teardown(data) {
  let total = 0;
  for (const user of data.users) {
    total += get('/api/account', user.token, 'teardown_account').json('balance');
  }
  const drift = Math.abs(total - data.expectedTotal);
  console.log(`total money: ${total.toFixed(2)} (expected ${data.expectedTotal.toFixed(2)}), drift ${drift.toFixed(2)}`);
  moneyDrift.add(Math.round(drift * 100));
}
