# Reproduce locally

Use a new disposable PostgreSQL cluster/database. Scripts never load `.env`, accept remote DB hosts or reset an existing populated DB. Do not point a local proxy at a remote API. The UI tests mutate only synthetic fixtures. Existing pending Gmail/template changes were present in both baseline and final working-tree checks and were not included in these commits.

## Setup

This run used PostgreSQL 16 at `127.0.0.1:55439`, user `perf`, database `techsync_campaign_pipeline`. Provision that empty local database using the local tools available to you; if it already contains QA data, use a separate disposable cluster/port with the same guarded database name. Neither helper deletes it.

From `backend/`:

```bash
export QA_DATABASE_URL='postgresql://perf@127.0.0.1:55439/techsync_campaign_pipeline?sslmode=disable&uselibpqcompat=true'
DATABASE_URL="$QA_DATABASE_URL" DATABASE_URL_UNPOOLED="$QA_DATABASE_URL" npm run db:migrate
npm run db:generate
QA_DATABASE_URL="$QA_DATABASE_URL" node scripts/campaign-pipeline-qa.js seed
QA_DATABASE_URL="$QA_DATABASE_URL" node scripts/campaign-pipeline-qa.js serve
```

The server uses `127.0.0.1:5057`, no worker or external provider operation, and dummy signing/storage credentials. It creates two synthetic workspaces and ten verified/onboarded users. Fixture IDs live in `/tmp/techsync-campaign-pipeline-fixture.json`. Login `qa-0-owner@example.test` / `FixturePassword123!`; other roles use `qa-0-admin`, `qa-0-manager`, `qa-0-sales_rep`, `qa-0-viewer` at `example.test`. Tenant 1 has matching role accounts.

From `frontend/` in a second terminal:

```bash
VITE_API_BASE_URL=/api VITE_API_PROXY_TARGET=http://127.0.0.1:5057 \
VITE_CRM_CAPTURE_API=true VITE_CRM_ASSIGNMENT_API=true \
npm run dev -- --host 127.0.0.1 --port 5177 --strictPort
```

These capture switches apply only to this QA process. Production switches are unchanged. The API and client dependencies already installed in this workspace were reused; no library was added.

## Tests

From `backend/`:

```bash
TEST_DATABASE_URL="$QA_DATABASE_URL" npm test
env -u TEST_DATABASE_URL npm test
```

Focused paths: `test/integration/campaign-completion.test.js`, `pipeline-completion.test.js`, `sales-migrations.test.js`, existing `campaigns.test.js`, `performance.test.js`, `latency.test.js`, `test/modules/campaign-meta.test.js` and `m08-m10.test.js`. Full DB expectations: 422 passed, six known baseline failures, two skipped; offline 286 passed and 144 skipped. The known failures are five Google Auth cases and the notification digest's “Idle deals” section. Do not weaken those tests to obtain a green summary.

From `frontend/`:

```bash
npm test
npm run lint
npm run build
node test/campaign-pipeline.browser.mjs
node test/campaign-capture.browser.mjs
```

Run **build before the browser tests**: sitemap/build output can reload an active Vite page. Chrome and a Playwright module must already be available. Defaults in this environment were `/usr/bin/google-chrome` and `/home/butcher/.cache/ms-playwright-go/1.57.0/package/index.mjs`; set `CHROME_BIN` and `PLAYWRIGHT_MODULE` to existing installations elsewhere. No automatic dependency installation occurs.

Main browser output: `/tmp/campaign-pipeline-browser/`, with screenshots and JSON assertions. It uses actual API authentication, draws/injects only a specific 503 move failure, produces a real stale 409 with a second write, and retries with retained note. Drag uses the visible column header as target because the middle of a tall column may be offscreen. The notification stream-ticket endpoint has its existing 30/minute rate limit: rapid hard navigations may produce 429s; these are recorded, and other unexpected HTTP failures fail the script.

Run the main browser script **before volume seeding**: its original fixture contains 85 live deals including 75 in the first stage. It cleans up previous unfinished `Browser conversion ...` fixture deals; it is not a general database-reset script. The capture script can also run after volume seeding; it creates/closes/removes its own form/rule, preserves its synthetic captured lead, and checks deleted-campaign attribution display. Public form fill waits over the existing 2-second anti-bot threshold.

## Volume and SQL plan

After UI verification, from `backend/`:

```bash
QA_DATABASE_URL="$QA_DATABASE_URL" node scripts/campaign-pipeline-volume.js --seed
```

This idempotently adds 50k leads, 10k deals and 100 campaigns per QA tenant, analyzes the relevant tables, measures requests and saves `/tmp/campaign-pipeline-volume/{results,filter-plan}.json`. It records one warmup plus 30 sequential and 30 concurrent samples per endpoint; concurrency is 10. Rerun without `--seed` for another measurement. Every run adds 30 synthetic lead-write measurement records. Do not run other benchmarks/full test suites concurrently if comparing timings.

The plan is representative tenant/campaign/source SQL, not a capture of private query logs. The integration suite separately verifies board query budgets and all 1,105 cursor records; deletion of their stage must move every record successfully. Actual migration test uses a unique local temporary schema, tests rollback/reapply on synthetic rows and removes only that schema.

## Artifacts and release

[Report](REPORT.md) gives final flow statuses, measured limits, migration order, optional legacy-FK audit and forward rollback SQL. [Files](FILES.md) lists task-owned changes. Backend evidence lives beside this file; UI results and desktop/mobile screenshots live in `frontend/docs/campaign-pipeline-completion/evidence/`.

No deployment or push was performed. Stop the local API/Vite processes when done; keep or remove the disposable cluster only through your usual local QA cleanup process. Application rollback does not require deleting any lead/deal/campaign rows.
