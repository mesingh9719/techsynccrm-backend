# Backend API performance audit — 22 October 2026

Implemented on backend branch `perf/api-audit-20261022`, starting at `50eebc5`. All database operations used disposable local PostgreSQL 16.15 databases. The configured Neon database, credentials, frontend, and the separate `techsync-crm-v2` copy were not modified. No dependencies were added.

## Findings and implemented changes

Ranked by measured work avoided and relevance to initial dashboard load:

1. **Lead tab aggregation read heap rows unnecessarily.** The baseline status aggregation took 7.559 ms and hit 623 shared blocks, using a bitmap heap scan and filtering 1,250 deleted rows. The concurrent partial index `leads_live_status_idx (organization_id, status) WHERE deleted_at IS NULL` changed it to an index-only scan: 2.866 ms, 29 shared blocks, zero heap fetches. The dashboard's `limit=1&counts=true` request improved from 19.53 to 6.18 ms p50 (68.4%). Existing tenant, owner, source, created-date, live-created, trigram and JSON indexes already exist; no speculative search or sort indexes were added.
2. **Board presentation repeated relation lookups for each stage.** Each nonempty column loaded owners, tags, contacts, companies, lost reasons and sources separately. Hydrating all visible cards once reduced SQL statements from 72 to 37 on the six-stage fixture. Sorting, the first 50 cards per stage, look-ahead, recent-closed scope, per-deal rounding, aggregate totals and all response fields remain intact. A focused 100-request follow-up measured p50 42.74 → 34.83 ms (18.5%) and p95 54.98 → 46.74 ms (15.0%).
3. **Lead lists repeated filter resolution and exact counts.** With both `count=true` and `counts=true`, the original path resolved tag IDs/custom-field definitions twice and separately counted data already available in the status aggregation. Filter resolution now runs once per request. The exact total comes from the groups, respecting the selected statuses; `count=true` alone retains its existing count query. On the large tag/custom-field fixture, statements decreased 14 → 11 and p50 205.90 → 150.13 ms (27.1%). Without those filters, combined-count lists improved 15.55 → 8.27 ms (46.8%).

Each optimization has a separate commit. Duplicate filter resolution alone reduced statements 14 → 12 but provided no convincing tail-latency gain; its intermediate p95 was worse. Reusing the grouped total then reduced statements 12 → 11 and intermediate p50 199.10 → 150.55 ms. The intermediate measurements are retained rather than attributing the entire gain to one change.

## Structure, auth and frontend audit

`src/app.js` applies request IDs/logging, Helmet, CORS, compression, body parsers, cookies and rate limits, then mounts `src/routes/index.js`. Route modules call controllers, which delegate business logic to services. Prisma uses one process-wide client and the pg adapter, with the pooled Neon application URL. Migrations use the unpooled URL. The pool defaults to 10 connections, 10-second connection acquisition, 30-second idle timeout; interactive transactions default to 10-second max wait and 15-second execution timeout. Effective production overrides, regions, compute size, traffic and network RTT were not inspected.

JWT signature/algorithm/issuer/audience/expiry verification already makes **zero DB calls**. Workspace middleware subsequently reads membership, user verification/deletion/2FA and organization state on every request (three SQL statements with the current Prisma relation strategy). Managers require a fresh team lookup; seat selection may require a senior-admin lookup. Services add own/team/all visibility and organization filters. These checks, session rotation, lockout, password hashing and immediate revocation were preserved. A TTL cache would change the freshness guarantee and was not introduced.

Unchanged credential paths were measured separately on local fixture credentials: POST `/api/auth/login` p50/p95 **292.77/320.24 ms**, 6 statements, 1,899 JSON bytes; POST `/api/auth/refresh` **6.90/8.43 ms**, 8 statements, 1,899 bytes. There is no before/after claim for these paths. One sampled login had 3.99 ms summed query time. The source and timing indicate password comparison at bcrypt cost 12 dominates login; lowering its security cost was not considered an optimization. External mail delivery and 2FA-provider latency were not benchmarked.

The frontend restores a refresh-cookie session once using a shared promise, then enables workspace queries. TanStack Query already deduplicates equal keys, defaults to 30-second freshness and clears data on signout. The dashboard requests current/previous lead cohorts with `counts=true&limit=1`, attention leads, a deal board, task summary and optional campaigns/team data. `useOrg` shares the organization query key. These distinct requests are intentional; they multiply the cost of fresh middleware and aggregations. No live browser/network trace was captured, so duplicate HTTP calls beyond this source review are unproven. Reports are feature-gated; there is no separate implemented dashboard-stats API to rewrite here.

The [220-route inventory](endpoints.md) includes method, path, source and risk rating. Unknown endpoints have not been load-tested. Additional static findings: task view counts use several queries; forecast loads scoped open deals and aggregates in JavaScript; notification unread counts scan access-checked pages; board grouping includes value/probability to preserve per-deal money rounding. Imports, exports and Facebook capture already use durable worker paths. Facebook Graph calls already have a 15-second timeout. Existing compression excludes SSE. None of these mechanisms was replaced without a measured baseline.

## Measurements

Fixture: **100,000 leads**, **12,000 deals**, four tenants, five roles per tenant, six stages per pipeline, tags, a custom field, contact/company/source/reason relations, deleted leads and older closed deals. Leads have distinct timestamps. The large tag matches 25,000 IDs per tenant. This tests a deliberately broad tag, not a calibrated copy of customer distributions. Tasks, notifications and forecast dates are sparse, so their timings are controls rather than realistic volume benchmarks.

Express HTTP requests ran over localhost with identity encoding: three warmups and 30 serial samples per endpoint; nearest-rank p50/p95. Payload size means uncompressed JSON bytes, identical before/after. Measurements include JWT/membership middleware, Prisma and JSON serialization. Query counts come from actual Prisma SQL events. Both versions use the same opt-in instrumentation. Pool size is 10. Plans used `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` in a read-only transaction against the local fixture. Cold starts and internet/TLS/region latency are excluded. These are reproducible local measurements, **not production estimates**.

| Method and endpoint (prefix `/api`) | Before p50 / p95 ms | After p50 / p95 ms | p50 gain | SQL statements | JSON bytes (both) | Endpoint checks |
|---|---:|---:|---:|---:|---:|---|
| GET `/auth/me` | 4.56 / 12.89 | 3.91 / 6.25 | +14.2% | 3 → 3 | 1,411 | Exact parity |
| GET `/organizations/current` | 9.20 / 20.32 | 6.06 / 7.36 | +34.1% | 10 → 10 | 2,211 | Exact parity |
| GET `/organizations/current/checklist` | 6.96 / 15.92 | 5.80 / 9.19 | +16.7% | 9 → 9 | 866 | Exact parity |
| GET `/leads?limit=1&counts=true` | 19.53 / 41.76 | 6.18 / 7.70 | +68.4% | 10 → 10 | 1,609 | Exact parity |
| GET `/leads?limit=50&count=true&counts=true` | 15.55 / 18.26 | 8.27 / 10.70 | +46.8% | 11 → 10 | 63,889 | Exact parity |
| GET `/leads?limit=50&count=true&counts=true&status=new&tag=<fixture>&cf.segment=retail` | 205.90 / 267.49 | 150.13 / 183.10 | +27.1% | 14 → 11 | 58,781 | Exact parity |
| GET `/leads?limit=50&q=Synthetic%20lead%202` | 8.56 / 19.08 | 7.05 / 10.62 | +17.7% | 9 → 9 | 63,971 | Exact parity |
| GET `/deals/board` | 40.23 / 51.01 | 36.18 / 57.17 | +10.1% | 72 → 37 | 533,345 | Exact parity |
| GET `/deals/forecast` | 12.71 / 21.89 | 14.10 / 25.70 | -10.9% | 6 → 6 | 219 | Exact parity |
| GET `/tasks/summary` | 2.60 / 3.85 | 3.37 / 4.75 | -29.7% | 6 → 6 | 58 | Exact parity |

The first 30-request board run had a worse p95, despite lower p50 and fewer queries. To investigate, the original handlers from `50eebc5` and optimized handlers were measured again, sequentially on the same fixture with identical instrumentation and 100 samples each. The [original](board-original-100.json) and [optimized](board-optimized-100.json) follow-up artifacts show 42.74/54.98 → 34.83/46.74 ms p50/p95 and 72 → 37 statements. No production p95 guarantee or statistical confidence interval is claimed.

Auth/me, checklist, forecast and task-summary code was not optimized. Apparent gains or regressions in those control timings must not be attributed to the changes. Forecast and task controls were slower in the final pass, demonstrating local scheduling/cache noise. Live-board latency remains dependent on a 533 KB response. No response fields were removed to shrink it.

Prisma query durations include client/driver round trips and can overlap, so their sum is not a disjoint DB component to subtract from request wall time. The header measures time until response headers; the structured finish log measures total response time and bytes. EXPLAIN execution times exclude JSON/network transfer. The broad filtered lead request emits roughly 164–166 KB SQL statements with 25,000+ parameters, while representative DB plans take roughly 3–17 ms; client query construction, parameter transport/decoding and application processing remain material. There is no external-service cost in the measured GET handlers. Public internet overhead remains unmeasured.

Raw metric artifacts: [baseline](baseline-metrics.json), [after](after-metrics.json), [auth](auth-metrics.json). Byte-exact query plans are gzip-compressed in `baseline-plans.json.gz` and `after-plans.json.gz`. UUIDs and predicates in these files belong only to synthetic fixtures. Tokens, passwords and environment files are not stored.

## Validation and limits

- Original offline suite before edits: **155 passed, 2 failed, 61 skipped**. Final: **156 passed, 2 failed, 66 skipped**. The added instrumentation test passes; five added DB tests skip without `TEST_DATABASE_URL`.
- Original integration suite at `50eebc5`: **62 passed, 1 failed**. Final including five new regressions: **67 passed, 1 failed**. A separate original checkout reproduced the identical notification-digest failure.
- Existing failures retained unchanged: spreadsheet formula rejection (`spreadsheets.test.js:33`), duplicate-header rejection (`spreadsheets.test.js:65`), and missing Idle deals digest section (`m11.test.js:274`). A completely green suite/zero-regression certification is therefore unavailable; no new failures were observed.
- Five new real-DB endpoint tests pass: exact board totals and half-even rounding; card order, 50-card cap and look-ahead; own/team/all permissions across all five roles; foreign-tenant reads; combined/separate/omitted totals; duplicate status values; tags/custom fields; deleted/empty/last-page behavior; ascending/descending date/name cursors; immediate membership and role changes; eight concurrent role requests.
- The fixture harness compared all ten measured response bodies field for field. Another **37** role/filter/pagination contracts matched the original implementation. Foreign-tenant details returned 404 and a deactivated membership was rejected on the next request with 403. Sixteen simultaneous board requests across four tenants succeeded; all original/optimized payload sizes matched.
- Prisma schema validation, changed-file Node syntax checks and `git diff --check` pass. Both local databases applied the concurrent migration successfully. Existing pagination is already cursor-based for leads; task offset pagination was not changed. No large task-offset workload was claimed. Real storage, SMTP, Meta, production concurrency/soak testing and browser waterfalls remain outside the evidence collected here.

## Modified files

| File | Purpose |
|---|---|
| `src/services/deal.service.js` | Batch visible board-card presentation across columns. |
| `src/services/lead.service.js` | Resolve filters once and reuse grouped counts for exact totals. |
| `prisma/schema.prisma` | Document the SQL-managed partial index alongside existing indexes. |
| `prisma/migrations/20261022173000_lead_live_status_counts/migration.sql` | Concurrent partial live-status index and rollback command. |
| `src/lib/performance.js` | AsyncLocalStorage request metrics and safe slow-query warnings. |
| `src/db/prisma.js` | Enable query events when explicitly configured. |
| `src/config/env.js` | Validate metrics switch and slow-query threshold. |
| `src/app.js` | Optional middleware and CORS exposure of Server-Timing. |
| `test/lib/performance.test.js` | Offline concurrency attribution and sensitive-log regression. |
| `test/integration/performance.test.js` | Real HTTP/DB correctness, security and query-budget regressions. |
| `scripts/performance-audit.js` | Guarded synthetic seed, benchmark and response-contract comparisons. |
| `scripts/performance-plans.js` | Guarded, read-only query-plan capture. |
| `performance/*`, `README.md` | Measurements, complete route triage, reproduction and release notes. |

## Deployment, monitoring and rollback

No deployment or production migration was performed. Apply existing pending migrations in normal order, then deploy this forward migration through the existing `npm run db:migrate` release step using the direct URL. It contains `CREATE INDEX CONCURRENTLY` and must run outside a surrounding transaction. The application changes work with the old schema, so application/index rollout order is flexible; indexing first gives the measured read benefit immediately. No client regeneration is required for the comment-only Prisma schema edit, though the normal build remains supported.

Concurrent builds avoid blocking ordinary writes but consume IO/CPU and can wait for long transactions. If interrupted, inspect `pg_index.indisvalid` for `leads_live_status_idx` before retrying; do not mark a failed migration applied blindly. Drop an invalid index concurrently and use the normal Prisma failed-migration recovery process before retrying. Existing applied migration SQL was not edited.

Enable `PERFORMANCE_METRICS=true` on the API to emit query events, `Server-Timing` and request-finish performance logs. It defaults off. `SLOW_QUERY_MS` defaults to 250; slow warnings retain duration and request ID, never SQL/parameters. Stream headers are a snapshot at first write, whereas finish logs cover the stream lifetime. DB milliseconds sum overlapping SQL events; they are not CPU time. Logs can be high-volume, so evaluate retention before leaving metrics enabled for all traffic. No cache exists to invalidate. Restart the API when changing these environment variables.

Monitor route-specific p50/p95, statement counts, response bytes, slow-query warnings, errors, pool waits and write throughput before/after rollout. Pay particular attention to broad tag filters, the board, lead status transitions and index write overhead. The measured tenant counts are synthetic and do not establish production capacity.

Rollback application optimizations by reverting `20cc01a`, `122ca36`, and `c491114` in reverse order. Disable metrics independently with `PERFORMANCE_METRICS=false`. The index can safely remain after application rollback. If it must be removed, ship a new forward migration containing `DROP INDEX CONCURRENTLY IF EXISTS "leads_live_status_idx";` outside a transaction, then remove its schema comment. Do not delete/edit already-applied migration history or reset production data.

## Recommendations not implemented

1. Measure the same requests in an explicitly authorized staging environment near the hosted database, including cold and warm compute, realistic unread notifications/tasks, filters, tenant sizes and write traffic. Browser traces should establish the actual initial-load critical path.
2. Replace large polymorphic tag-ID materialization with a tenant-scoped DB-side semi-join only after designing a query path that preserves every existing filter and count contract. The remaining ~150 ms broad tag case is the clearest local bottleneck.
3. Profile board aggregation cardinality at larger deal volumes and uncompressed/compressed transfer cost. Keep per-deal money rounding exact before changing its grouping. The current response contract returns full cards across all columns.
4. Diagnose and repair the three existing test failures in their relevant modules. Add a production-like notification/forecast workload before changing access-sensitive unread scans or JS financial aggregates.
5. Inspect actual pool pressure, function instance count, DB/hosting regions and compute suspension before changing pool sizing or infrastructure. No Redis, permission TTL, stale dashboard cache, new queue or framework/ORM replacement is justified by this audit.
