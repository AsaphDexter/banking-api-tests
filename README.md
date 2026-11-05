# Banking API tests

[![API tests](https://github.com/AsaphDexter/banking-api-tests/actions/workflows/api-tests.yml/badge.svg)](https://github.com/AsaphDexter/banking-api-tests/actions/workflows/api-tests.yml)

Automated tests for the REST API of [BasicBankingApplication](https://github.com/AsaphDexter/BasicBankingApplication):
about 170 API tests in TypeScript with Playwright, three k6 performance scripts, and a GitHub Actions workflow
that builds the banking API, starts it, runs everything against it and publishes the reports.

The tests are written the way a QA engineer would approach a payments API: contract and negative cases first,
then security, then concurrency, then load. See [docs/TEST-PLAN.md](docs/TEST-PLAN.md) for the risk register,
the findings and an experiment that breaks the API on purpose to check the tests notice.

## What is covered

| Area | File | Examples |
|---|---|---|
| Protocol | `health-and-protocol.spec.ts` | 404 / 405 with `Allow`, JSON and security headers, no stack traces, no CORS |
| Registration | `registration.spec.ts` | username and password rules and boundaries, duplicates, wrong types, mass assignment |
| Login, lockout, tokens | `authentication.spec.ts` | 401 vs 423, counter reset, token format, logout revocation, bad headers |
| Deposits, withdrawals, history | `account-and-money.spec.ts` | exact decimals, limits, 422 overdraft, `1e999999999`, history order |
| Transfers | `transfers.spec.ts` | both sides recorded, 404 / 400 / 422 cases, money conservation |
| Security | `security.spec.ts` | user isolation, secrets never leak, SQL and script input, content types |
| Concurrency | `concurrency.spec.ts` | racing withdrawals, double spend, opposite transfers |
| End to end | `user-journey.spec.ts` | a customer from sign-up to sign-out |
| Performance | `perf/*.js` | smoke, load with a money-conservation check, login throughput |

## Run it

You need Node 20+, and the banking API running. Start it from the banking app project (`BankingApiApp` with the
program argument `--memory`), then:

```bash
npm install
npx playwright test            # all API tests (no browser needed)
npx playwright show-report     # open the HTML report
```

Point it at another address with `API_URL`, for example `API_URL=http://localhost:9090 npx playwright test`
(PowerShell: `$env:API_URL="http://localhost:9090"; npx playwright test`).

Performance tests need [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) (on Windows: `winget install k6`):

```bash
npm run perf:smoke      # one pass through the API, fails on any error
npm run perf:load       # 10 virtual customers moving money for 45 seconds, then checks the money adds up
npm run perf:login      # how many sign-ins per second the API can sustain
```

## Continuous integration

`.github/workflows/api-tests.yml` runs on every push and pull request:

1. checks out these tests and the banking API repository
2. builds the API with Maven and starts it in demo mode
3. type-checks the tests and runs the Playwright suite
4. runs the k6 smoke and load tests (the load test fails if any money is created or destroyed)
5. uploads the Playwright HTML report, JUnit XML, k6 summaries and the API log as a downloadable artifact

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
