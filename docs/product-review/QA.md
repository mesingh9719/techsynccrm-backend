# QA results and reproduction

Executed 25 October 2026 (Asia/Kolkata). **Verified core changes; full program still in progress.** A passing regression suite does not close the unimplemented features or every flow marked Partial in the audits.

## Baseline and final results

| Check | Baseline before changes | Final observed result |
|---|---|---|
| Backend offline | 286 passed, 144 skipped | Database suite used for final verification; no tests disabled |
| Backend real local DB | 422 passed, six failed, two skipped | **450 passed, zero failed, two optional browser cases skipped** in full normal suite, 47 files |
| Optional inherited Templates/Gmail browser cases | Not part of initial baseline | **38 passed** in their two integration files with Playwright enabled, including both formerly skipped browser cases; Google/mail provider mocked |
| Frontend automated tests | Three files passed | **Three files passed**, including added live adapters, scoped cache invalidation, rollout and CSV control-character checks |
| Frontend TypeScript/build | Passed, two dynamic-import warnings | Passed; existing router/queryClient dynamic-import warnings remain |
| Frontend lint | Not captured separately before changes | Exit 0; existing warnings in unrelated drawer/effect/chart code retained in evidence |
| New report/related visibility integration checks | Absent | 14 focused cases passed, including deterministic digest boundary; all included in full suite |
| Online report index migration | Absent | Applied locally; down/up/repeated apply pass; both pg_index.indisvalid=true |
| Desktop/phone module rendering | Historical sales evidence only | All ten module screens plus companies at 1440×1000 and 390×844; no page errors or document overflow |
| Real daily phone workflow | Not rerun | Sales rep note, call log, stage confirmation, WhatsApp URL and task add/complete pass against local API/DB |
| Public website acquisition | Historical test available | Existing real form capture test passes on new fixtures: mapping, assignment, UTM, repeat dedupe, invalid input 400, foreign form 404, closed form 410 |

The six initial DB failures were five real Google authentication defects and one inconsistent test clock. Google failed because the Prisma token enum omitted a value already in the migrations and an extended unique update attempted a null unique field. Both production-code causes were fixed and the existing 11 auth tests pass. The digest fixture created deal dates from real Date.now but evaluated a fixed 19 October day. Its dates are now anchored to that declared clock; all original assertions remain. A separate deterministic seven-day/recent-touch regression also passes.

One intermediate parallel full run additionally timed out the existing concurrent-index migration test. It passed when files were serialized. Vitest now serializes files only when TEST_DATABASE_URL is present; assertions and explicit race/concurrent-write tests within files are unchanged. Final default `npm test` with the local URL passes. No passing status was obtained by excluding a failing test.

## Executed browser boundaries

The main review browser uses real cookie login, authenticated HTTP, local Postgres and the real UI. It does not intercept API responses. Synthetic records are created only on a localhost database guarded by exact name.

- Lead Detail renders with retained guided design.
- Dashboard, Leads, Campaigns, Pipeline, Tasks, Contacts, Companies, Templates, Integrations, Reports and Settings render at desktop and phone widths.
- Reports use real data, preserve owner/date/junk exclusion on source links, download an authorized CSV, and render response/compliance summaries.
- Task quick-add writes a real row. Call-task completion, note and contact/company/deal conversion persist and display on the lead timeline.
- Separate phone salesperson run saves a note and call, confirms qualification, opens a normalized +91 WhatsApp URL, dismisses logging without sending, and adds/completes a follow-up.
- Final onboarding/filter spot-check uses real add/import/stage actions and visible No source choices.
- Basic structural scan on the main screens found one main, one h1 and no unnamed icon buttons in the captured states. This is **not** an automated WCAG, contrast or screen-reader audit.

Optional inherited template browser tests use a simulated auth/app shell with actual template/email HTTP and database operations; mail/Google transport is mocked. Their boundary differs from the full-app review browser. They cover template editing, invalid variables, rename/preview, archive/restore, pagination, viewer restrictions and variable composition. Their successful provider-accepted logs are fixture responses, not real Gmail messages.

## Accuracy/security checks

- Five roles exercised on report read endpoints; own/team filters enforced server-side. Foreign-source data never appears; forbidden owner filters return 403.
- Export API and service reject rep/viewer; authorized export writes audit. Team export excludes unassigned records under existing records.export semantics.
- Lead KPI, source totals and monthly revenue reconcile on explicit IST boundaries, excluding junk/deleted and non-workspace currency.
- Lost/reopened history retains prior qualified progress. Funnel is a highest-progress cohort view; it does not invent response timestamps. First-response report separately treats absent/invalid response time as unresponded.
- Related company names/contact counts obey both parent and linked-record visibility; foreign parent IDs return 404 even for an owner.
- Shared CSV encoder neutralizes formula prefixes including leading control characters; existing backend spreadsheet encoder remains unchanged.
- Query parameters use Prisma parameterization. Raw SQL aliases are fixed internal literals. No provider secrets, production URLs or application .env contents were added to evidence.
- Existing Meta signature/replay/idempotency and Gmail OAuth/send/sync/error tests ran with synthetic/local or mocked provider boundaries.
- [Role matrix](ROLE-TENANT-MATRIX.md) and the 280-declaration route inventory explicitly record the remaining exhaustive coverage work.

## Performance

Dataset: 100,000 leads, 20,000 deals, 20,000 tasks, 30,000 activities, 20,000 status events. Disposable local Postgres 16; same synthetic dataset before/after. Twenty sequential warm HTTP requests per endpoint include JWT verification and live membership/organization loading. No server response cache. These are local endpoint measurements, not production p95 or concurrent-load guarantees.

| Endpoint | Initial p95 ms | Final p95 ms |
|---|---:|---:|
| KPIs | 39.7 | 42.5 |
| Revenue series | 12.3 | 11.0 |
| Lead sources | 28.3 | 32.6 |
| Funnel | 985.7 | 162.3 |
| Leaderboard | 119.2 | 125.7 |
| First response | 107.9 | 107.1 |
| Follow-ups | 581.3 | 50.4 |

The two slow queries were rewritten as grouped joins. Funnel checks status arrays without expanding events per lead; follow-up compliance joins readable records once. Initial/intermediate/final evidence is retained. EXPLAIN ANALYZE shows an Index Only Scan using deals_report_won_period_idx for the measured won-revenue sum (1.543 ms execution in that recorded plan). High-selectivity full-tenant aggregation can legitimately scan many rows. Remote concurrency, large event histories, Enterprise membership limits and cold hosted-database latency still need staging measurement. Leaderboard rejects more than 500 selected members instead of silently truncating.

## Reproduction

These examples use the disposable server created for this review. Scripts never load application .env and exact-name/localhost guards prevent accidental seeding of another database. If a named database already exists, inspect it; seed scripts require empty data and do not erase it.

```bash
# Backend: local regression database, including required pg driver SSL compatibility setting.
TEST_DATABASE_URL='postgresql://butcher@127.0.0.1:55441/techsync_product_review?uselibpqcompat=true&sslmode=disable' npm test

# Optional inherited browser tests; local frontend must already be running.
TEST_DATABASE_URL='postgresql://butcher@127.0.0.1:55441/techsync_product_review?uselibpqcompat=true&sslmode=disable' \
PLAYWRIGHT_MODULE=/home/butcher/.cache/ms-playwright-go/1.57.0/package/index.mjs \
TEMPLATE_QA_URL=http://127.0.0.1:5181 \
npm test -- test/integration/templates.test.js test/integration/gmail.test.js

# Backend: synthetic browser fixtures. Migrate this separate local database first.
QA_DATABASE_URL='postgresql://butcher@127.0.0.1:55441/techsync_product_browser?uselibpqcompat=true&sslmode=disable' node scripts/product-review-qa.js seed
QA_DATABASE_URL='postgresql://butcher@127.0.0.1:55441/techsync_product_browser?uselibpqcompat=true&sslmode=disable' node scripts/product-review-qa.js serve

# Frontend, separate terminal:
VITE_API_PROXY_TARGET=http://127.0.0.1:5061 npm run dev -- --host 127.0.0.1 --port 5181 --strictPort
node test/product-review.browser.mjs
node test/product-review-mobile.browser.mjs
QA_ORIGIN=http://127.0.0.1:5181 QA_FIXTURE=/tmp/techsync-product-review-fixture.json node test/campaign-capture.browser.mjs
npm test
npm run build
npm run lint

# Backend: a THIRD empty migrated database for synthetic performance seed and measurement.
QA_DATABASE_URL='postgresql://butcher@127.0.0.1:55441/techsync_product_performance?uselibpqcompat=true&sslmode=disable' node scripts/product-review-performance.js
# Remeasure the exact existing benchmark fixture without reseeding:
QA_DATABASE_URL='postgresql://butcher@127.0.0.1:55441/techsync_product_performance?uselibpqcompat=true&sslmode=disable' node scripts/product-review-performance.js --measure
```

The review-local PostgreSQL cluster is /tmp/techsync-product-review-pg, socket /tmp, port 55441. Local API 5061 and Vite 5181 were left available for review. No worker was started against external services. Use your own local OS username if reproducing elsewhere; these example credentials are synthetic local trust authentication, not deployable configuration.

## Remaining release QA checklist

- [x] Existing automated backend suite and frontend tests/build pass.
- [x] Both optional template/Gmail browser cases pass separately.
- [x] Changed-area role/tenant, money/date, history, export and related visibility regressions.
- [x] Real website form acquisition/assignment/dedupe, conversion and report browser boundaries.
- [x] Phone-sized rep daily workflow; desktop/phone overflow and structural label spot checks.
- [x] Realistic synthetic aggregate workload and online-index rollback/replay.
- [ ] Every endpoint/action/role/tenant permutation across all modules individually mapped and executed.
- [ ] Fresh tenant signup → real object-storage upload → import → worker completion in the browser.
- [ ] Real sandbox Meta/Google OAuth, signed provider delivery/reconnect/retry and Gmail reply sync.
- [ ] Reminder/outbox worker delivery, failure recovery and recipient opt-out against staging transport.
- [ ] Full keyboard, screen-reader, contrast, dark-mode and physical-phone device pass.
- [ ] Every merge, bulk action, recycle/restore, custom-field and settings edge path in the UI.
- [ ] Scheduled reports, targets, missing connectors/billing and other open High implementations.


## Excel follow-up — PR-028

Backend: all 47 files pass, **450 tests passed, two optional browser cases skipped**. The 19-case product integration file also passes after adding explicit manager XLSX isolation assertions. Frontend: all three test files pass, TypeScript/build pass, lint exits 0 with existing warnings. New tests check binary download token refresh/errors and workbook types/precision/corruption.

Actual authenticated multipart XLSX uploads, mapping/preview, real worker functions and exports pass for leads, contacts, companies and deals on disposable PostgreSQL. Templates include only active custom fields for the requested entity/workspace; anonymous/viewer access fails. Filtered manager exports exclude an identically named record owned outside the team in CSV and XLSX; formula-looking text stays neutralized.

The new full-app `frontend/test/excel-transfer.browser.mjs` browser script passes six checks: four mobile template downloads, filled lead template upload/mapping/preview/background import and a filtered Excel export/download. The pg-boss worker and actual AWS S3 client ran against localhost synthetic services. There were no API/page errors or document overflow. This closes the existing-tenant Excel journey with a disposable S3 HTTP subset; it does not close fresh signup or external-storage release QA. Results: [JSON](evidence/excel-transfer-browser-results.json). Reproduction and deployment requirements: [Excel guide](../import-spreadsheet-editor.md).
