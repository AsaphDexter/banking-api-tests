// Smoke test: one pass through the whole API with one user. Fails if anything is wrong.
// Run:  k6 run perf/smoke.js            (API_URL=http://host:port to point somewhere else)
import { check, group } from 'k6';
import { createUser, get, post, runId } from './lib.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<2000'],
  },
};

export default function () {
  const id = runId();
  const alice = createUser(`smokea${id}`);
  const bob = createUser(`smokeb${id}`);

  group('money', () => {
    const deposit = post('/api/deposit', { amount: 100 }, alice.token, 'deposit');
    check(deposit, { 'deposit 200': (r) => r.status === 200, 'balance 100': (r) => r.json('balance') === 100 });

    const withdraw = post('/api/withdraw', { amount: 10 }, alice.token, 'withdraw');
    check(withdraw, { 'withdraw 200': (r) => r.status === 200, 'balance 90': (r) => r.json('balance') === 90 });

    const transfer = post('/api/transfer', { toAccountNumber: bob.accountNumber, amount: 40 }, alice.token, 'transfer');
    check(transfer, { 'transfer 200': (r) => r.status === 200, 'balance 50': (r) => r.json('balance') === 50 });
  });

  group('reads', () => {
    const account = get('/api/account', bob.token, 'account');
    check(account, { 'account 200': (r) => r.status === 200, 'bob has 40': (r) => r.json('balance') === 40 });
    const history = get('/api/transactions', alice.token, 'transactions');
    check(history, { 'history 200': (r) => r.status === 200, 'three entries': (r) => r.json().length === 3 });
  });
}
