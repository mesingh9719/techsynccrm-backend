# Email foundation QA — 23 October 2026

All database work used a newly initialized disposable PostgreSQL 16 instance under `/tmp`,
listening on loopback. No production database, Google mailbox, cloud project or real employee
notification was used. Google/provider operations and browser API responses were mocked.

| Check | Result |
| --- | --- |
| Prisma validation and generated client | Passed |
| All 30 repository migrations on an empty local database | Passed |
| Foundation rollback, then migration reapply | Passed |
| Backend build/syntax checks | Passed |
| Default offline backend suite | 275 passed; 110 database-dependent tests skipped |
| Full backend suite with disposable database | 379 passed; 6 baseline failures described below |
| Email-specific unit/environment/integration and legacy Gmail tests | Passed, including new send-only behavior and existing send/reply/sync compatibility |
| Frontend TypeScript/Vite build | Passed; existing ineffective dynamic-import warnings |
| Frontend behavior test files | Both passed |
| Frontend lint | Passed with existing warnings outside the email additions |
| Chrome desktop/mobile interaction checks | Passed |

Database coverage includes encrypted PKCE and tokens, single-use/expired/tampered/browser-bound
state, live originating sessions, consent denial, missing scope/refresh token, actual selected
mailbox address, same-tenant duplicate rejection, cross-tenant reuse, tenant override rejection,
employee/admin authorization, owner/admin disconnect, audit actors, concurrent refresh,
`invalid_grant`, reminder cooldown races, sanitized tenant settings, disabled-tenant connect,
encrypted durable revocation/retry and admin-disconnect races during OAuth exchange. An inherited
Google read grant cannot enable new inbox sync. Worker connection checks detect rejected
send-only refresh grants without reading Gmail.

Browser checks exercise actual React components with mocked HTTP responses: connect consent
failure/success via popup, full-page OAuth return and clean URL, disconnect confirmation,
reconnect warning, banner keyboard dismissal, admin table/search/filter/pagination, reminders,
signature/settings updates, failed-load retry, employee access denial and 390px layouts.
Screenshots were inspected locally at `/tmp/techsync-email-settings-mobile.png` and
`/tmp/techsync-email-team-mobile.png`.

## Baseline failures reproduced independently

The full database suite has five failures in `test/integration/googleAuth.test.js` and one in
`test/integration/m11.test.js`. To distinguish regression from existing schema/service drift,
the Prisma client was regenerated from the **original pre-feature schema**, then those two
suites were run again on disposable PostgreSQL. The same six failures reproduced (34 tests
passed). The final email schema and client were restored afterward.

- Google sign-in: its existing `google_signin` UserTokenType migration is absent from the
  pre-existing Prisma enum. Several ticket flows fail validation. Its existing linking update
  also supplies `googleSubject: null` as a unique filter that the current generated client rejects.
- Notification digest: the existing test expects an “Idle deals” section that is absent for
  its fixture date/current-time conditions.

Those unrelated sign-in/schema and notification changes were not folded into this feature.
Review them before treating the whole application's database suite as release-green.

## Reproduction

From backend, against a disposable database only:

```bash
npm run db:generate
npm run db:validate
npm run build
npm test
TEST_DATABASE_URL='<disposable database URL>' npm test
TEST_DATABASE_URL='<disposable database URL>' npx vitest run \
  test/modules/email-foundation.test.js test/modules/email-environment.test.js \
  test/integration/email-foundation.test.js test/integration/gmail.test.js
```

For local PostgreSQL without TLS, append `sslmode=disable&uselibpqcompat=true` to the test
connection URL so the existing Neon TLS-normalization helper does not force TLS. Never use
this option for hosted production connections. Integration fixtures refuse remote databases
unless `TEST_DATABASE_DISPOSABLE=true` is explicitly set.

From frontend:

```bash
npm run build
npm test
npm run lint
# Start the frontend, then use an already available Playwright installation:
EMAIL_QA_URL=http://127.0.0.1:5199 \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
node test/email-foundation.browser.mjs
```

The browser script defaults to `/usr/bin/google-chrome`; override `CHROME_PATH` when needed.
Playwright was already available in the workspace; no application dependency was added.

## Remaining operator checks

Live Google consent, granted scopes, ID-token verification, production KMS/runtime identity,
real Google revocation and seven-day testing-token expiry require configured test credentials.
They were not simulated as live cloud validation. Follow the complete manual checklist and
deployment/rollback steps in [the implementation notes](email-integration-foundation.md) and
the [Google setup guide](email-integration-google-setup.md).

Refresh health checks use cached access tokens until expiry. External revocation therefore
appears on the next rejected refresh, not instantly. Local admin disconnects invalidate the
generation immediately; connected employee screens poll every 30 seconds and refresh on focus.
Google may revoke the shared user/client grant across multiple customer contexts; affected
owners reconnect separately and CRM tenant data remains isolated.
