# Backend

TechSync uses Express 5, Prisma ORM 7.10.1 with the pg adapter, Neon Postgres and a separate
pg-boss worker. Use Node >=22.18 to compile the generated Prisma client during install/build.
The application and CLI dependencies now use ORM 7; the previous Prisma 8 RC conflict was removed.
The npm scripts use `@prisma/prisma7` and `prisma7.config.ts`, which loads `.env` and uses
`DATABASE_URL_UNPOOLED` for migrations. Preserve `.env`; copy `.env.example` only for a new setup.

For Vercel, `vercel.json` runs `npm run build` and explicitly includes
`src/generated/prisma/**/*.js` in the Express function. `npm run db:generate` generates
Prisma's TypeScript and compiles it to JavaScript with Node's built-in type stripping.
The application and the generated client both import `.js` files, so deployment does not
depend on preserving TypeScript filenames. The generated files are ignored by Git and must
be created during deployment. The build imports the compiled client without opening a
database connection to catch missing runtime files before release. Use `npm run db:generate`
rather than calling `prisma7 generate` directly so the JavaScript files are refreshed too.

## Setup and release

From `backend/`, for a new checkout or another environment:

```bash
npm ci
npm run db:status
npm run db:migrate
npm run db:generate
npm run db:check
```

Run the API and worker in separate processes using your existing process manager:

```bash
npm start
npm run worker
```

Development equivalents are `npm run dev` and `npm run dev:worker`. The worker registers
outbox subscribers, queue handlers and cron schedules. `EMAIL_DELIVERY=direct` only changes
email delivery; reminders, imports, cleanup and other background work still require a worker.
Rebuild/release the frontend separately from `frontend/` when deploying UI changes.

Interactive Prisma transactions use a 15-second execution budget and wait up to 10 seconds
to acquire a transaction connection. Configure `DB_TRANSACTION_TIMEOUT_MS` and
`DB_TRANSACTION_MAX_WAIT_MS` in milliseconds to override these defaults; restart the API and
worker after changing them. The execution budget includes all queries and row-lock waits in
the transaction. Keep external calls and password hashing outside ordinary write transactions.
Audit entries remain in the same transaction as their changes so a failed write rolls back both.

The configured application database was inspected on 20 October 2026: all 16 migrations are
present; the read-only column/history inspection reported 598 expected columns and no problems.
The API/worker were not restarted and the frontend was not rebuilt after final audit edits.
See [the audit](../docs/04-product-architecture-module-audit.md) for actual executed operations
and the user's instruction to stop tests/builds/lint/browser checks on subsequent edits.

## Migration history and reminder repair

The deployed M10 SQL had been edited locally after application. Its byte-exact original is
restored, retaining `reminder_job_id`. `20261020001000_task_reminder_scan` adds the application's
nullable `remind_at`/`reminder_sent_at` fields and scan index without resetting tasks. Three more
forward migrations add attachments, transfers and integrity guards.

Never edit already-applied SQL, rewrite migration checksums or reset application data to resolve
this drift. Use `npm run db:migrate:dev -- --name <change>` only against a development database.
`npm run db:check` reads expected column/nullability and migration checksum/status metadata; it
does not compare all index/default/constraint semantics. `npm run db:check -- --preflight` also
reports legacy files without assignable organizations and multiple active workspace owners.
Pending migrations still appear as problems until applied. The attachment migration deliberately
fails on unassignable files instead of silently assigning them across tenants.

## Files and data transfers

Configure the existing `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_REGION` and `STORAGE_BUCKET` values. The bucket remains private. Browser POST uploads require
bucket CORS allowing your frontend origin; live CORS/provider roundtrips were not checked here.
Small uploads pass through the API; larger uploads use a 15-minute bounded pending-key policy.
Completion validates actual bytes and publishes them to a fresh private key. Standard maximum
is 25 MB (`MAX_UPLOAD_MB`); MP4 maximum is 50 MB. HTML/SVG and mismatched signatures are rejected.
This signature policy is not an antivirus integration.

Attachment panels are on lead/contact/company/deal detail pages. Storage use includes pending
reservations and soft-deleted bytes until physical cleanup. `files.maintenance` runs hourly for
thumbnails, expired exports, pending/orphan uploads and eligible deletions. Import source files
are retained while referenced by import history. Cleanup is application-managed.

Import actions on the four entity lists open the CSV/XLSX wizard; Settings → Data holds import
and export history. Imports allow up to 25 MB/50,000 rows, validate preview rows and recheck
permissions/limits during durable row transactions. Cancellation stops between rows; retry
resumes remaining rows. Undo within seven days removes only unchanged records created by that
import and preserves updates/lookup data. Exports honor list scope/filters, audit row counts,
protect formula cells and expire in seven days. Exports above 5,000 rows run in the worker;
50,000 is the export cap. `transfers.recover` runs every minute. See audit limits for mapping,
duplicate policy and unmeasured throughput.

## Notifications

Restart both API and worker after schema/client updates. Configure SMTP using existing mail
settings for delivery. The API uses `DATABASE_URL_UNPOOLED` for its dedicated Postgres LISTEN
connection; a transaction-pooler URL cannot substitute. The frontend polls every 60 seconds
if SSE is unavailable. Preferences are under Settings → Notifications. Import row events
suppress per-record notifications; completion/failure and export completion use the outbox.
Real SMTP delivery remains unverified.

## Optional verification commands

These are instructions for a future verification pass, not commands executed after the user's
no-tests instruction. `npm run db:validate` validates the schema; `npm run build` generates the
client and checks backend syntax. Frontend lint/build run from `frontend/`.

Normal `npm test` runs offline tests and skips opt-in database integration tests. To run the
integration suite, migrate a dedicated disposable database first and then use:

```bash
TEST_DATABASE_URL='postgresql://USER:PASSWORD@localhost:5432/techsync_test' npm run test:integration
```

Never point tests at the application database. Tests create/delete fixtures and exercise
global queue/retention scans. Remote test databases require `TEST_DATABASE_DISPOSABLE=true`.
SMTP, storage and queue enqueue are mocked; HTTP/Prisma transactions and Postgres LISTEN/NOTIFY
use the real test database. The last earlier runs passed 120 offline and 43 integration tests;
later changes have not been rerun. Browser flows and real storage/SMTP delivery remain pending.

## Facebook Pages and Lead Ads

Settings → Facebook Lead Ads now connects Pages, maps forms, browses campaigns and captures leads
through signed webhooks and the worker. See [Facebook setup](../docs/06-facebook-integration.md).
The additive Facebook migration is applied to the configured database (18 migrations now present, including SDK/deletion support),
and the client is generated. Your App ID is configured locally. Enter the private App Secret in
`backend/.env` and use the documented HTTPS tunnel setup for local development before connecting.
No live connection, tests, builds, lint or browser checks were run for this connector.

Facebook SDK login now checks browser status on the integration settings page and validates a
session-bound challenge, signed response and app/user token server-side. The public data deletion
callback returns Meta's confirmation/status contract, revokes credentials and queues bounded
cleanup through `facebook.delete` / `facebook.privacy_recover`. See
[SDK, deletion scope and operator recovery](../docs/07-facebook-sdk-data-deletion.md).
Enable JavaScript SDK login and register the HTTPS frontend domain in Meta, then register
`/api/integrations/facebook/data-deletion` as the Data Deletion Request URL. Privacy jobs require
the worker even if Facebook credentials are disabled; restart API and worker after deployment.
