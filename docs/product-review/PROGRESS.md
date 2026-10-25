# Product review progress

Checkpoint: **25 October 2026, Excel import/export follow-up complete**. Verified core implementation batch complete. **Overall ten-module program remains in progress; do not call the product market-ready.** Read this file and the gap register before continuing.

## Workspace and preservation

- Active repositories: backend/ and frontend/, both on `review/market-readiness-20261025`, branched from fix/campaigns-pipeline-completion. Root .git is an empty read-only placeholder; root docs are mirrored to backend/docs/product-review for version control. Older techsync-crm-v2 is reference only.
- User-owned Gmail/Templates work existed before this task and is now staged. It remains uncommitted and unmodified except for our isolated Google enum/report-route additions in shared files. Temporary indexes kept review commits separate. Do not reset, stash, commit, remove or overwrite that inherited work.
- Original baselines: backend 349cca6, frontend 2dcea3e. Current review commits are listed in COMMITS.md. New final docs commit is listed by git log after that manifest.

## Implemented and verified

- PR-001–005: real scoped Reports backend/client; seven aggregate endpoints; retained-event cohort funnel; source none/exact owner/date/junk-excluding drilldowns; audited server-authorized export; response/compliance UI; online tenant-first report indexes.
- PR-014: contact company names and company contact counts now enforce related-record tenant/ownership visibility in list/detail.
- PR-018: Google token enum restored to match already-applied SQL migration; identity link uses atomic conditional updateMany rather than invalid nullable unique selector.
- PR-006: capture/assignment/settings use real API; existing rollout flags return unavailable errors when off, never samples/local saves. Old preview data retained without automatic publishing/upload. Historical preview tests moved to test-only fixtures.
- PR-017/024/025/027: real onboarding/import/pipeline actions, originating-tenant report/dashboard invalidation after committed CRM writes, factual next-step copy, CSV formula control-character protection.
- PR-013/026: original digest assertions retained, fixture anchored to its fixed evaluation clock; separate deterministic idle/recent-touch test; shared-database files serialized while preserving in-test concurrency coverage.

## Final verification

- Full backend: **450 passed, zero failed, two optional browser cases skipped**, 47 files. Both optional inherited cases passed separately in a **38-test Templates/Gmail run**, using real template/email HTTP/Postgres with mocked mail/provider and simulated auth shell.
- Frontend: all three test files pass, TypeScript/build pass; lint exits 0 with existing unrelated warnings. New tests cover live API filters/errors, cache write notifications, rollout stops and CSV control characters.
- Real full-app browser: ten modules plus companies desktop/phone render without page errors/overflow; report filters/CSV, quick tasks and call/note/conversion timeline pass. Public website capture/assignment/UTM/repeat dedupe/foreign ID/closed form regression passes.
- Real phone-sized salesperson UI: note, call log, qualification confirmation, normalized WhatsApp URL (no message sent), add/complete follow-up pass. Physical-device/provider delivery not tested.
- 100k leads /20k deals /20k tasks /30k activities /20k events: all seven measured local HTTP p95s <500ms; funnel 985.7→162.3ms, compliance 581.3→50.4ms. Revenue plan uses new index. No claim of production/cold/concurrent latency.
- New index migration applied, down/up/repeated application pass and both indexes valid. No data backfill/update migration.

## Local environment

- New Postgres cluster: /tmp/techsync-product-review-pg, port 55441, socket /tmp. Databases techsync_product_review (tests), techsync_product_browser (UI), techsync_product_performance (benchmark), all synthetic.
- Local API: http://127.0.0.1:5061 via scripts/product-review-qa.js serve. Frontend: http://127.0.0.1:5181 proxying only that API. Only import/export queue handlers were started via the guarded QA harness, with disposable localhost S3 HTTP storage on port 5062. No provider/mail handlers ran. Runtime processes were left available for review.
- Test URL requires `uselibpqcompat=true&sslmode=disable` on localhost because the existing pg wrapper otherwise pins strict TLS. See QA.md commands. Do not point these commands at application databases.
- Migration/test targets explicitly used localhost; the existing Prisma CLI config can load .env for client generation, which is schema-only. No production queries, migrations, messages, deployment or paid provisioning occurred.

## Excel follow-up (PR-028)

- Continued existing XLSX/CSV transfer implementation. Added permission-checked native Excel templates containing only active workspace custom fields, authenticated binary downloads with token refresh, typed amounts/dates with Excel precision protection, frozen/filterable headers and actionable malformed-workbook errors.
- All four entities pass actual HTTP multipart upload → preview → worker → XLSX export checks. Manager team visibility, tenant isolation, formula safety and template access are covered. Existing CSV behavior is preserved.
- Real Chrome/local API/PostgreSQL/pg-boss/AWS client: all four templates download at phone width; filled lead workbook imports through the complete UI and exports from the filtered list. Six browser checks pass, no page/API errors or overflow. Uses disposable S3 HTTP subset, not external storage. Fresh signup and 50k-row browser tests remain open.
- Frontend tests/build/lint pass (existing unrelated lint/build warnings); full backend 450 passed, two optional skipped. Expanded manager XLSX regression also passes separately. No migration or new dependency.
- Code commits: backend `6a4925d`, frontend `038f645`; inherited staged Gmail/Templates patches preserved. Reproduction: [Excel guide](../import-spreadsheet-editor.md); browser evidence: [results](evidence/excel-transfer-browser-results.json).

## Remaining work / resume here

1. Finish the per-endpoint/action/role/tenant matrix (PR-012): 280 route declarations inventoried including nested/public/staff/out-of-scope paths. Do not infer exhaustive isolation from selected tests.
2. Coordinate separate review/commit of inherited Templates/Gmail work (PR-011), without absorbing it into our commits. Actual sandbox provider OAuth, delivery and reply sync remain pending.
3. Implement M15 scheduled reports/targets with current-recipient scope, durable retries, timezone scheduling, opt-out and existing plan gates (PR-008). Basic core reports are already real; do not rebuild them.
4. Resolve manual lead merge policy D11 then implement preserved links/history/recovery (PR-019).
5. Missing Google Ads/Instagram DM/generic webhook/official WhatsApp inbox (PR-009), billing provider/pricing (PR-010), audit viewer/calendar/unified health and historical inactive-owner totals are open. No new paid provider was chosen.
6. Run full fresh-signup→storage-backed import/worker journey; remaining merge/bulk/recycle/settings UI paths and accessibility/physical-phone matrix.

The ten audits, research, scorecard, roadmap, decisions, QA and deployment/demo guidance are populated. Flow statuses explicitly distinguish executed checks from code inspection and unfinished work. No blocking approval was requested because independent authorized work was available. The program should continue from these specific gaps.
