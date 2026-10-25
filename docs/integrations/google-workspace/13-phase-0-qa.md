# Phase 0 QA — 25 October 2026

All data was synthetic in disposable local Postgres 16 databases on port 55441. Google token exchange, identity, refresh and revocation network methods were mocked. No production/provider account, real email, Calendar event, Google file or paid resource was used.

## Results

| Check | Result |
|---|---|
| Pre-change backend baseline | 450 passed, 2 optional skipped |
| Final backend suite | 474 passed, 2 optional skipped, 49 test files |
| Backend build | Prisma generation, generated client import and syntax check of 239 JS files passed |
| Frontend Node tests | All 3 files passed |
| Frontend production build | TypeScript and Vite passed; two existing ineffective dynamic-import warnings |
| Frontend lint | Passed, no errors; 10 warnings in pre-existing files outside the Google changes |
| Migration | Additive migration applied to disposable test/browser databases; temporary schema validation and guarded rollback passed |
| Chrome browser | All six complete journeys passed at desktop and 390px mobile widths; no browser exceptions or horizontal overflow |

The final suite adds 24 Google foundation cases to the baseline. It covers real HTTP routes and database state with only Google network calls mocked: PKCE/offline/incremental authorization, identity audience/nonce/verified-email checks, browser binding, replay/expiry, revoked CRM session, cancellation, partial/broad scope denial, missing and retained refresh credentials, stale OAuth generations, changed client/subject, role changes, own/admin/tenant boundaries, no secret DTOs, per-service consent, tenant switch-off, refresh leases/cache authorization/disconnect races, invalid grant, coordinated cross-workspace revocation, recent login/confirmation, departure maintenance, encrypted outbox retries with rollout off, tenant-composite constraints and outbox survival after hard deletion. Legacy Gmail/email/sign-in regressions pass unchanged.

The migration rollback was checked inside a transaction and temporary schema: apply DDL, insert a fixture credential, assert rollback refuses, remove fixture, assert empty rollback succeeds, then roll back the entire schema. No migration history or application data was modified by that check. [Migration result](evidence/migration-check.txt).

## Browser evidence

`frontend/test/google-workspace.browser.mjs` drives the actual React app, API, authentication and database. The QA server replaces only Google network methods. The browser intercepts Google's authorization navigation and returns a fixture code through the real callback; it does not stub the application's API responses.

1. New workspace preferences start off.
2. Owner enables service setup; member reviews/acknowledges Calendar permission, completes PKCE callback and sees the persisted binding.
3. Sheets uses an already granted selected-file scope only after its own explicit service acknowledgement; Drive remains off.
4. Mobile service-off, full project-removal warning/confirmation and workspace detach work.
5. Team metadata and sanitized activity reflect persisted actions.
6. Viewer cannot connect services or open team administration.

[Machine-readable browser result](evidence/browser-results.json), [personal mobile](evidence/screenshots/personal-mobile.png), [team desktop](evidence/screenshots/team-desktop.png), [team mobile](evidence/screenshots/team-mobile.png), [project-removal mobile](evidence/screenshots/project-revocation-mobile.png).

React review checked unconditional hooks, lazy page imports, query keys scoped by organization/user, mutation invalidation, independent parallel queries, permission-gated admin fetching, labeled controls, disabled/pending/error states and reusable dialog focus behavior. The browser run caught a controlled-checkbox save-feedback issue; the UI now shows the pending value while saving and restores the server value on failure. A mobile layout review moved service actions below the text on narrow screens.

## Reproduce locally

Use a disposable database; never point these commands at production. The existing `scripts/product-review-qa.js seed` supplies the synthetic two-tenant fixture in an empty `techsync_product_browser` database. Apply all migrations there using explicit `DATABASE_URL` and `DATABASE_URL_UNPOOLED` overrides. The QA scripts do not load `.env`.

```bash
# backend: run tests against a disposable local test database
TEST_DATABASE_URL='postgresql://butcher@127.0.0.1:55441/techsync_product_review?uselibpqcompat=true&sslmode=disable' npm test

# backend: start the isolated browser API; reset affects Google tables of known fixtures only
QA_DATABASE_URL='postgresql://butcher@127.0.0.1:55441/techsync_product_browser?uselibpqcompat=true&sslmode=disable' node scripts/google-workspace-qa.js --reset-fixtures

# frontend, a separate terminal
VITE_API_PROXY_TARGET=http://127.0.0.1:5063 npm run dev -- --host 127.0.0.1 --port 5182 --strictPort

# frontend, another terminal; override PLAYWRIGHT_MODULE if your Playwright installation differs
node test/google-workspace.browser.mjs
```

Tests expect `/usr/bin/google-chrome`; the script documents its overridable Playwright module path. Browser artifacts go to `/tmp/google-workspace-browser` by default. Repeat a journey after restarting the QA API with `--reset-fixtures`, so an earlier fixture revocation does not intentionally block reconnect.

## Pending live acceptance

Actual Google consent/identity certificates/token lifetime, actual KMS IAM, APIs/quotas, test-user/admin policy, production TLS/cookie/proxy behavior and asynchronous provider revocation need the [operator Console setup](11-google-cloud-console-setup.md) and an authorized real-account smoke test. Calendar Data Access categorization and any required verification remain launch gates. Content sync, Picker, export and two-way automation have no acceptance claim in this phase.
