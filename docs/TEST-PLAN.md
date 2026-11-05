# Test plan and risk register

System under test: the REST API of [BasicBankingApplication](https://github.com/AsaphDexter/BasicBankingApplication)
(Java, JDK HTTP server, JSON, bearer tokens, H2 database). Tests run from outside, over HTTP, exactly as a client would.

## Scope

In scope: every endpoint (`health`, `register`, `login`, `logout`, `account`, `transactions`, `deposit`, `withdraw`,
`transfer`, `password`, `admin/unlock`, `admin/audit`), status codes and error bodies, authentication and sessions,
account lockout and its expiry, login throttling, money handling and rounding, strict request validation, user
isolation, hostile input, the audit log, concurrency, and load.

Out of scope: the browser, the console app, database internals (covered by unit tests in the app repo), HTTPS, and
anything that needs a production environment.

## Approach

| Layer | Tool | What it answers |
|---|---|---|
| Functional and negative API tests | Playwright (`tests/*.spec.ts`) | Does each endpoint do exactly what the contract says, and refuse everything else? |
| Security-minded tests | `security`, `authentication`, `password-change`, `admin-and-audit`, `throttle` specs | Can one user reach another's money? Can passwords be guessed? Does hostile input or a bad token do harm? Do responses or logs leak secrets? |
| Timing-dependent behaviour | `short-lockout` spec on a 2-second-lockout instance | Does a lock really end, and does the count really start over? |
| Concurrency tests | `concurrency` spec | Can simultaneous requests overdraw an account, double-spend or create money? |
| Smoke test | k6 `perf/smoke.js` | Is the whole API alive and consistent after a deploy? |
| Load test | k6 `perf/load.js` | Under load, are latencies acceptable and is total money conserved exactly? |
| Isolation test | k6 `perf/login-isolation.js` | Does one customer's slow sign-in slow everyone else down? |
| Capacity probe | k6 `perf/login-throughput.js` | What is the sign-in ceiling? |

Three instances of the API run side by side because some behaviour needs special settings: the main instance
(admin token set, throttle raised so the suite's deliberate failures do not trip it), one with a 2-second lockout,
and one allowing only 5 failed logins per client. Tests never share data: every test registers its own users with
unique names, so the suite runs in parallel and can be re-run against the same server. (The throttle spec uses up
its instance's allowance, so that instance must be restarted between runs.)

## Risk register and where each risk is tested

| # | Risk | Tests |
|---|---|---|
| R1 | Money is created, lost or rounded wrongly | `account-and-money`, `transfers` (conservation), `concurrency`, `perf/load.js` (money drift) |
| R2 | An account can be overdrawn or double-spent | `account-and-money`, `transfers`, `concurrency` (racing withdrawals, double spend) |
| R3 | One user reaches another user's data or money | `security` (access control), `transfers`, `password-change` (acts only on the token owner) |
| R4 | Authentication bypassed, or tokens outlive logout or a password change | `authentication`, `password-change` (other sessions ended), `security` |
| R5 | Passwords can be guessed by brute force | `authentication` (lockout), `short-lockout`, `throttle`, `password-change` (guessing via a stolen token) |
| R6 | Secrets (passwords, hashes, tokens) appear in responses or logs | `registration`, `authentication`, `security`, `admin-and-audit` |
| R7 | Malformed or hostile input crashes the server or is misread | `registration`, `account-and-money`, `transfers`, `security` |
| R8 | Wrong status codes mislead clients | every spec; `health-and-protocol` (404, 405 with `Allow`, 413, 415) |
| R9 | The API becomes slow or unfair under load | `perf/load.js`, `perf/login-isolation.js`, `perf/login-throughput.js` |
| R10 | Errors expose internals | `health-and-protocol` (only `{error}` bodies, no stack traces) |
| R11 | An attacker can lock real users out for good | `authentication` (Retry-After), `short-lockout` (lock ends), `admin-and-audit` (admin unlock) |
| R12 | Admin functions reachable without the admin token | `admin-and-audit` (missing, wrong and user tokens), `throttle` |
| R13 | Security events not traceable, or the log itself can be abused | `admin-and-audit` (events, no secrets, log-forging text sanitised) |

## Findings and how they were resolved

Stage 3 of the app had three weaknesses, found by these tests, and Stage 4 fixed them. The tests that documented
each weakness now guard its fix.

| # | Finding in Stage 3 | Fix in Stage 4 | Evidence |
|---|---|---|---|
| 1 | Three wrong passwords locked a user **permanently** and nothing could unlock them, so anyone who knew a username could lock that user out | Locks last 15 minutes and say how long (`Retry-After`); an admin endpoint can unlock early; failed attempts per client are throttled (429) | `short-lockout`, `admin-and-audit`, `throttle`, `authentication` |
| 2 | Sign-in held the bank's global lock while hashing the password, so one sign-in made **every other request wait** | Hashing runs outside the lock | k6 isolation test, below; deterministic unit test in the app repo |
| 3 | No record of who did what | Audit log of registrations, logins, failures, locks, unlocks, password changes and transfers | `admin-and-audit` |

### Measured: does signing in slow everyone else down?

`perf/login-isolation.js`: 4 virtual users sign in continuously for 20 seconds while another customer makes
10 ordinary requests per second. Single-core machine.

| | Stage 3 (hashing inside the lock) | Stage 4 (hashing outside the lock) |
|---|---|---|
| Ordinary request, 95th percentile | **1.33 s** | **14.5 ms** (about 90 times faster) |
| Total throughput | about 15 requests/s | about 15 requests/s |

Sign-in speed itself did not change on this machine: hashing is CPU-bound and there is one core, so about
6 sign-ins per second is the ceiling here. What changed is that sign-ins no longer block anyone else, and on a
multi-core machine sign-ins can now run in parallel too.

## Still open

1. **Lockout state reveals that a username exists**: a locked existing user answers 423 while an unknown user
   answers 401 (tested as a FINDING in `authentication.spec.ts`).
2. **A lock is now temporary, but an attacker can still re-lock a known username every 15 minutes.** The per-client
   throttle slows this, but one client address can be many attackers behind one NAT, and an attacker can use many
   addresses. A stronger design delays attempts progressively instead of locking.
3. **The throttle trusts the connection address.** Behind a reverse proxy every request would look like one client;
   the proxy's forwarded-address header would need to be read, and only from a trusted proxy.
4. **Account numbers are sequential 10-digit numbers and an unknown recipient answers 404**, so a signed-in user can
   enumerate accounts.
5. **Sessions live only in memory** (a restart signs everyone out) and there is **no audit-log retention policy**
   (the log grows without limit, and blocked login attempts add rows).
6. **The admin token is one static secret** shared by all admins: no per-admin accounts, rotation or audit of who
   used it.
7. **Plain HTTP and no rate limit beyond login throttling.**

## What the tests are worth: breaking the API on purpose

Each deliberate bug below was introduced into the API, the relevant specs were re-run, and the result recorded.

| Deliberate bug | Result |
|---|---|
| Overdraft check removed | Caught: 6 tests failed |
| Logout no longer revokes the token | Caught: 4 tests failed |
| Lockout after 5 failures instead of 3 | Caught: 4 tests failed |
| Lock never ends (set 10 years ahead) | Caught: 3 tests failed |
| Password change leaves other sessions alive | Caught: 1 test failed |
| Wrong current password not counted as a failed login | Caught: 1 test failed |
| Audit log keeps control characters (log forging) | Caught: 1 test failed |
| Locking removed from deposit / withdraw / transfer | Caught in 1 of 4 runs on a single core |
| Password hashing moved back inside the lock (app repo unit test) | Caught every time: 2 tests failed |

The locking row is the honest limit of black-box concurrency testing: a missing lock is a race, so it only shows
up some of the time. The Playwright test uses several rounds of 150 simultaneous requests to make it likely, and
more CPU cores make it more likely still, but a clean run is not proof. That is why the lock-contention risk is
also covered by a deterministic unit test in the app repo, which pauses a sign-in mid-hash and proves other
requests still run.

## Open questions

- After a burst of 400 simultaneous requests from one client, the next request got a connection reset. Not
  diagnosed: it could be the test client reusing a closed connection or a limit in the server. A good next step is
  to repeat it with k6.
