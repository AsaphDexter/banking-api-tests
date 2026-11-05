# Banking API tests

[![API tests](https://github.com/AsaphDexter/banking-api-tests/actions/workflows/api-tests.yml/badge.svg)](https://github.com/AsaphDexter/banking-api-tests/actions/workflows/api-tests.yml)

Automated tests for the REST API of [BasicBankingApplication](https://github.com/AsaphDexter/BasicBankingApplication):
about 215 API tests in TypeScript with Playwright, four k6 performance scripts, and a GitHub Actions workflow
that builds the banking API, starts three instances of it, runs everything against them and publishes the reports.

The tests are written the way a QA engineer would approach a payments API: contract and negative cases first,
then security, then concurrency, then load. See [docs/TEST-PLAN.md](docs/TEST-PLAN.md) for the risk register,
the findings and an experiment that breaks the API on purpose to check the tests notice.

## What is covered

| Area | File | Examples |
|---|---|---|
| Protocol | `health-and-protocol.spec.ts` | 404 / 405 with `Allow`, JSON and security headers, no stack traces, no CORS |
| Registration | `registration.spec.ts` | username and password rules and boundaries, duplicates, wrong types, mass assignment |
| Login, lockout, tokens | `authentication.spec.ts` | 401 vs 423 with `Retry-After`, counter reset, token format, logout revocation, bad headers |
| Lock expiry | `short-lockout.spec.ts` | a 2-second lock really ends, the count starts over |
| Login throttling | `throttle.spec.ts` | 5 failed logins per client then 429; a success does not reset the count |
| Change password | `password-change.spec.ts` | other sessions ended, wrong old password counts towards the lockout, weak passwords refused |
| Admin and audit log | `admin-and-audit.spec.ts` | admin token required, unlock, audit entries, no secrets, log-forging text sanitised |
| Deposits, withdrawals, history | `account-and-money.spec.ts` | exact decimals, limits, 422 overdraft, `1e999999999`, history order |
| Transfers | `transfers.spec.ts` | both sides recorded, 404 / 400 / 422 cases, money conservation |
| Security | `security.spec.ts` | user isolation, secrets never leak, SQL and script input, content types |
| Concurrency | `concurrency.spec.ts` | racing withdrawals, double spend, opposite transfers |
| End to end | `user-journey.spec.ts` | a customer from sign-up to sign-out |
| Performance | `perf/*.js` | smoke, load with a money-conservation check, sign-ins versus ordinary requests, login throughput |

## Run it

You need Node 20+ and the banking API running. Three instances are used, because some behaviour needs special
settings. Start them from the banking app project (run `BankingApiApp` three times, for example as three IntelliJ
run configurations, each with these program arguments):

| Port | Program arguments | Used for |
|---|---|---|
| 8080 | `--memory --port 8080 --admin-token playwright-admin-token-123456 --login-failure-limit 100000` | almost all tests |
| 8081 | `--memory --port 8081 --lockout-seconds 2 --login-failure-limit 100000` | lock expiry |
| 8082 | `--memory --port 8082 --login-failure-limit 5 --admin-token playwright-admin-token-123456` | throttling (restart it before each run) |

```bash
npm install
npx playwright test                      # everything
npx playwright test --project=api        # only the main instance (the other two specs are skipped if 8081/8082 are down)
npx playwright show-report               # open the HTML report
```

Change addresses or the admin token with `API_URL`, `API_URL_SHORT_LOCKOUT`, `API_URL_THROTTLED` and `ADMIN_TOKEN`
(PowerShell: `$env:API_URL="http://localhost:9090"; npx playwright test`).

Performance tests need [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) (on Windows: `winget install k6`):

```bash
npm run perf:smoke      # one pass through the API, fails on any error
npm run perf:load       # 10 virtual customers moving money for 45 seconds, then checks the money adds up
npm run perf:isolation  # does signing in slow everyone else down? (see the results in the test plan)
npm run perf:login      # how many sign-ins per second the API can sustain
```

## Continuous integration

`.github/workflows/api-tests.yml` runs on every push and pull request:

1. checks out these tests and the banking API repository
2. builds the API with Maven and starts the three instances in demo mode
3. type-checks the tests and runs the Playwright suite
4. runs the k6 smoke, load and isolation tests (the load test fails if any money is created or destroyed; the isolation test fails if sign-ins make ordinary requests slow)
5. uploads the Playwright HTML report, JUnit XML, k6 summaries and the API logs as a downloadable artifact

If the banking repository is private, add a token to the checkout step.

## Layout

```
tests/                 Playwright specs
tests/support/         shared helpers and fixtures (create a user, call the API)
perf/                  k6 scripts
docs/TEST-PLAN.md      scope, approach, risk register, findings
.github/workflows/     CI pipeline
```

## Notes

- Every test creates its own users with unique names, so tests run in parallel and the suite can be re-run
  against the same server without cleaning up.
- Retries are off on purpose: a flaky API test is a bug to fix, not something to retry away.
- Concurrency tests are probabilistic by nature; read the note in the test plan before trusting a green run.
