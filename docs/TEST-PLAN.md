# Test plan and risk register

System under test: the REST API of [BasicBankingApplication](https://github.com/AsaphDexter/BasicBankingApplication)
(Java, JDK HTTP server, JSON, bearer tokens). Tests run from outside, over HTTP, exactly as a client would.

## Scope

In scope: every endpoint (`health`, `register`, `login`, `logout`, `account`, `transactions`, `deposit`,
`withdraw`, `transfer`), status codes and error bodies, authentication and sessions, account lockout, money
handling and rounding, strict request validation, user isolation, hostile input, concurrency, and load.

Out of scope: the browser, the console app, the database internals (covered by the unit tests in the app repo),
HTTPS, and anything that needs the real production environment.

## Approach

| Layer | Tool | What it answers |
|---|---|---|
| Functional and negative API tests | Playwright (`tests/*.spec.ts`) | Does each endpoint do exactly what the contract says, and refuse everything else? |
| Security-minded tests | Playwright (`security.spec.ts`, parts of `authentication.spec.ts`) | Can one user reach another's money? Does hostile input or a bad token do harm? Do responses leak secrets? |
| Concurrency tests | Playwright (`concurrency.spec.ts`) | Can simultaneous requests overdraw an account, double-spend or create money? |
| Smoke test | k6 (`perf/smoke.js`) | Is the whole API alive and consistent after a deploy? |
| Load test | k6 (`perf/load.js`) | Under load, are latencies acceptable and is total money conserved exactly? |
| Capacity probe | k6 (`perf/login-throughput.js`) | What is the sign-in ceiling? |

Tests never share data: every test registers its own users with unique names, so the suite runs in parallel
and can be re-run against the same server.

## Risk register and where each risk is tested

| # | Risk | Tests |
|---|---|---|
| R1 | Money is created, lost or rounded wrongly | `account-and-money` (0.10 + 0.20 = 0.30, two decimals, limits), `transfers` (conservation chain), `concurrency`, `perf/load.js` (money drift) |
| R2 | An account can be overdrawn or double-spent | `account-and-money` (422), `transfers` (422), `concurrency` (racing withdrawals, double spend) |
| R3 | One user reaches another user's data or money | `security` (access control), `transfers`, `authentication` |
| R4 | Authentication can be bypassed or tokens outlive logout | `authentication` (tokens and logout), `security` (token randomness, token only in header) |
| R5 | Passwords can be guessed by brute force | `authentication` (lockout: 3 failures, counter reset, isolation) |
| R6 | Secrets (passwords, hashes) appear in responses | `registration`, `authentication`, `security` (secrets never leak) |
| R7 | Malformed or hostile input crashes the server or is misread | `registration`, `account-and-money`, `transfers`, `security` (SQL, script, oversized body, wrong types, huge numbers) |
| R8 | Wrong status codes mislead clients | every spec; `health-and-protocol` (404, 405 with `Allow`, 415, 413) |
| R9 | The API becomes slow or unfair under load | `perf/load.js` thresholds, `perf/login-throughput.js` |
| R10 | Errors expose internals | `health-and-protocol` (only `{error}` bodies, no stack traces) |

## Findings so far

These are observations about the system under test, not test failures. Tests marked FINDING in
`authentication.spec.ts` lock in the current behaviour and show up as annotations in the HTML report.

1. **Lockout can be abused for denial of service.** Three wrong passwords lock a user permanently and the
   API has no way to unlock. Anyone who knows a username can lock that user out. Suggested fix: time-based
   lockout plus per-client throttling.
2. **Lockout state reveals that a username exists.** A locked user answers 423, an unknown user answers 401.
3. **Sign-in has a hard ceiling of about 6 per second** (measured on a single-core machine, 4 concurrent users,
   average 668 ms, p95 1.08 s). Password hashing is deliberate, but the bank also runs one login at a time under
   one lock, so extra cores do not help. Suggested fix: hash outside the lock, and rate-limit sign-in.
4. **Account numbers are sequential 10-digit numbers and an unknown recipient answers 404**, so a signed-in user
   can enumerate other accounts. Not tested as a finding because the behaviour is intended, but worth a decision.
5. **Sessions live only in memory**: restarting the server signs everyone out, and expired sessions are only
   cleared when a new one is created.
6. **Plain HTTP, no rate limiting** (documented limitations of the app).

## What the tests are worth: breaking the API on purpose

To check the tests would notice real bugs, the API was changed on purpose and the suite re-run:

| Deliberate bug | Result |
|---|---|
| Overdraft check removed | Caught: 6 tests failed |
| Logout no longer revokes the token | Caught: 4 tests failed |
| Lockout after 5 failures instead of 3 | Caught: 4 tests failed |
| Locking removed from deposit / withdraw / transfer | Caught in 1 of 4 runs on a single-core machine |

The last row is the honest limit of black-box concurrency testing: a missing lock is a race, so it only shows up
some of the time. The test uses several rounds of 150 simultaneous requests to make it likely, and more CPU
cores make it more likely still, but a clean run is not proof. The deterministic protection for this risk is the
unit tests and code review in the app repo.

## Open questions

- After a burst of 400 simultaneous requests from one client, the next request got a connection reset. Not
  diagnosed yet: it could be the test client reusing a closed connection or a limit in the server.
  A good next step is to repeat it with k6.
