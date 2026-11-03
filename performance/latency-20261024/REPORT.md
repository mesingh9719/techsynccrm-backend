# Auth, dashboard and leads latency investigation

Branch: `perf/auth-dashboard-leads-latency`. The active backend repository is `backend/`; the parent directory has no usable Git history. The separate frontend repository and `techsync-crm-v2` copy were inspected only as needed and were not edited. All existing user changes in Gmail, templates, custom fields, routes and schema were preserved and excluded from these commits. No remote database, deployment or production data was used.

**Result:** two retained application fixes. Final local lead-create p50/p95 improves **47.57/56.78 → 11.43/14.04 ms** (76.0% p50); update **43.66/48.54 → 8.95/11.30 ms** (79.5%). With 10 concurrent requests, create improves **248.58/463.82 → 62.89/97.76 ms**, update **133.74/155.36 → 45.99/52.15 ms**. Fresh-process app import through first `/auth/me` response improves **1303.16/1343.75 → 1013.48/1083.77 ms** (22.2% p50). These are synthetic localhost measurements, not production estimates.

**Root causes and decisions, ranked by measured cost**

1. Auth cold startup synchronously computed a bcrypt dummy hash every time the auth service was imported. Replace it with a valid precomputed cost-12 dummy hash. Unknown-user password comparisons still perform bcrypt, reject generically, and cannot authenticate with the known dummy password. Warm login remains about 281–283 ms because cost-12 password verification intentionally remains unchanged. Removing repeated dummy-hash construction saves about 290 ms on local cold startup; it does not make warm password checking cheaper.
2. Broad lead tags remain the largest avoidable measured read cost: 135–142 ms p50. The service materializes 25,000 UUIDs in Node, then binds them into roughly 164 KB SQL with 25,004 parameters. One SQL aggregation itself takes 17.346 ms. This combines DB execution with ORM query construction, parameter encoding/transfer and JS materialization. No unsupported CPU subtraction is inferred from overlapping query durations. A database-side semi-join needs a separately validated replacement for polymorphic tag filtering across all existing predicates; it was not rushed into this change.
3. Lead writes ran two scoring queries whose activity-link relation omitted `organizationId`. With 375,000 links, Postgres scanned all tenants' links: 125,000 rows removed per worker, three workers, 4,263+ shared-buffer hits. The inbound query took 18.922 ms and touch count 16.247 ms. Adding the tenant predicate lets the existing `(organization_id, entity_type, entity_id, occurred_at)` index serve both queries: 0.063/0.048 ms and three buffer hits each in the step verification. This also makes tenant scoping explicit on the relation. Statement counts remain unchanged; work per statement is much smaller.
4. Dashboard date-cohort counts read 250 lead heap blocks because the existing date index does not cover status. A candidate covering index changed the count plan from a bitmap heap scan (301 shared hits, 2.924 ms) to an index-only scan (85 hits, 2.195 ms), but did not produce consistent concurrent p95 improvement. It was removed from the disposable DB and from deployment migrations. Serial A/B repeats improved 7.03–7.63 → 6.24–6.35 ms p50; concurrency-10 p95 was 39.87–44.55 without versus 44.68–58.22 with. The experiment SQL and all results are retained as rejected evidence. No dashboard-cache staleness was introduced.

The diagnosis was saved in [DIAGNOSIS.md](DIAGNOSIS.md) before changing application query or hashing behavior. The older audit in [../REPORT.md](../REPORT.md) describes improvements already present at task start; none is credited as new work here.

**System and request map**

The actual backend is Express 5 **JavaScript ESM**, Prisma 7.10.1 generated from TypeScript, `@prisma/adapter-pg`, and `pg` 8.23.1. The frontend is React/TypeScript. `src/server.js` imports `src/app.js`, starts the HTTP server and separately starts notification/queue producers. The benchmark mounts `app.js` only, so real SMTP, queue workers and provider integrations are not part of the measurement.

Middleware order: request ID → Pino HTTP logging → Helmet → optional request metrics → CORS → compression (excluding SSE) → JSON/urlencoded parsing → cookies → API rate limiter → route modules → not-found/error handler. Controllers delegate to services; Prisma errors and `ApiError` are mapped by the existing error handler. Existing outbox rows are written transactionally; no notifications or critical side effects were moved to an unreliable after-response task.

| Flow | Routes and queries |
|---|---|
| Auth | `POST /auth/signup`, `/login`, `/login/2fa`, `/refresh`, `/logout`, `/logout-all`; `GET /auth/me`; organization switching and account-security routes remain intact. Login reads user/lockout state, compares bcrypt, checks recent sign-ins, issues refresh token, resolves active membership/organization, audits sign-in. Refresh rotates tokens transactionally and rechecks current user/membership. Me reads user and active membership/organization; avatar URLs can additionally access file metadata/storage for legacy files. |
| Workspace authorization | `requireAuth` verifies JWT algorithm/signature/issuer/audience/expiry locally; `loadOrgContext` queries current membership, user verification/deletion/2FA and organization state in parallel. Managers get a fresh team lookup; seat selection may add a senior-admin lookup. `permit()` checks an in-memory role permission definition. Own/team/all visibility is included in service filters. No cross-request permission cache exists. |
| Dashboard | There is no dedicated implemented dashboard-stats endpoint to rewrite. Current/previous cohorts and funnel use `GET /leads?limit=1&counts=true` with date/source/owner filters. Attention uses new leads, ascending creation date, limit 5. Pipeline uses `/deals/board`; tasks use `/tasks/summary`; optional campaigns, team and report widgets have separate feature/visibility gates. Lead counts already use Prisma `groupBy` and independent list/count work runs in parallel. Board presentation is already batched. |
| Lead reads | `GET /leads` resolves visibility, search/lookups, tags, dates and typed custom fields; queries a cursor page, optional exact total/status groups; batches owners and tags. It already has cursor pagination and optional totals. `GET /leads/:id` loads the scoped selected lead and bounded owner/source/tag data; it does not inline all activities/tasks. Timeline is a separate paginated API; notes are `Activity(type=note)`, not a separate Note model. |
| Lead writes | `POST /leads`, `PATCH /leads/:id`, delete/restore/status/claim/assign/conversion, duplicate check and `/bulk`. Existing validation, duplicate handling, optimistic locking, plan-limit row locks, scoring and transactional events remain. Bulk assign/tag/delete already use batched writes; status transitions intentionally run validated per-record transactions. |

[../endpoints.md](../endpoints.md) retains the existing detailed route inventory. Schema review confirmed Organization is the tenant, Membership/TeamMember provide RBAC, RefreshToken/UserToken have token-hash and user/session indexes, leads have tenant/status/date/owner/source plus trigram/JSON indexes, and Activity/ActivityLink/Task have tenant-first access indexes. The scoring failure was a missing predicate, not a missing activity index.

Source review of frontend startup: `initAuth()` shares one refresh-cookie restoration promise. Authenticated workspace queries then become enabled; `useOrg` shares the current-organization query key. TanStack Query has 30-second freshness and one transient-error retry, with focus refetch enabled; tasks/campaigns use 60 seconds. Dashboard cohort, attention, board and task queries are distinct, largely parallel calls rather than a single serial request chain. Organization-dependent timezone/data can change query keys after settings load; this is a possible refetch source, not a measured duplicate-HTTP finding. No browser trace was captured and no frontend behavior or API was changed.

The inspected env configuration uses a pooled hosted-Postgres application URL and unpooled migration URL in `ap-southeast-1`; secrets/endpoint IDs are not recorded. One Prisma client exists per process, pool max defaults to 10, acquisition timeout 10 seconds, idle timeout 30 seconds. Deployment configuration includes Vercel build/function packaging, but actual deployment region, instance count, CU size, pool overrides and provider RTT are unknown. Retain pooled app traffic and direct migration connections as documented by [Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres); driver-adapter pool settings belong to the underlying driver, as described in [Prisma's connection-pool documentation](https://docs.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections/connection-pool).

**Before and after measurements**

Dataset: [dataset.json](dataset.json): 5 tenants, 100 users, 125,000 leads, 15,000 deals, 375,000 activities, 375,000 activity links, 375,000 tasks. PostgreSQL 16.15, localhost TCP, pool size 10, identity encoding. Each endpoint has 3 warmups, 30 serial samples and 30 samples in waves of 10. p50/p95 use nearest rank. Concurrent first waves can include opening additional pool connections; these are not strictly fully prewarmed pool tests. Write concurrency uses separate update targets to preserve expected same-record 409 conflicts. JSON bytes are representative uncompressed body sizes. Creation IDs/timestamps and tokens are intentionally not compared byte-for-byte; GET payloads and dashboard numbers are compared exactly.

Positive percentages mean faster. Only the lead-write rows and cold startup have an attributed optimization. Variations on unchanged GET handlers/warm login are controls, including negative values; they are not claimed improvements or proof of a new regression. The rejected index is absent in the final dataset and figures.

Serial requests:

| Method / endpoint (prefix `/api`) | Before p50 / p95 ms | Final p50 / p95 ms | Observed p50 change | Queries before → after | JSON bytes before → after | Validation |
|---|---:|---:|---:|---:|---:|---|
| `GET /auth/me` | 2.69 / 4.44 | 3.29 / 6.23 | -22.2% | 3 → 3 | 1,541 → 1,541 | Exact GET parity |
| `POST /auth/login` | 281.33 / 288.72 | 283.46 / 297.87 | -0.8% | 6 → 6 | 2,032 → 2,032 | Scoped regressions pass |
| `GET /leads?limit=1&counts=true` | 5.84 / 8.05 | 5.87 / 8.41 | -0.6% | 10 → 10 | 1,830 → 1,830 | Exact GET parity |
| `GET /leads?limit=1&counts=true&createdFrom=2026-10-15&createdTo=2026-10-22` | 6.63 / 8.06 | 6.62 / 8.29 | +0.1% | 10 → 10 | 1,829 → 1,829 | Exact GET parity |
| `GET /leads?limit=50&count=true&counts=true` | 8.16 / 13.21 | 7.68 / 11.72 | +5.9% | 10 → 10 | 65,105 → 65,105 | Exact GET parity |
| `GET /leads?limit=50&count=true&counts=true&status=new&tag=:tag&cf.segment=retail` | 134.96 / 146.08 | 141.91 / 160.66 | -5.1% | 11 → 11 | 59,731 → 59,731 | Exact GET parity |
| `GET /leads?limit=50&q=Synthetic%20lead%202` | 6.81 / 9.38 | 6.47 / 13.22 | +5.0% | 9 → 9 | 64,989 → 64,989 | Exact GET parity |
| `GET /leads?limit=50&q=%25_%27` | 24.12 / 26.11 | 23.78 / 24.88 | +1.4% | 6 → 6 | 54 → 54 | Exact GET parity |
| `GET /leads/:id` | 3.46 / 4.88 | 3.11 / 4.48 | +10.2% | 9 → 9 | 1,578 → 1,578 | Exact GET parity |
| `GET /deals/board` | 31.18 / 38.23 | 31.74 / 39.84 | -1.8% | 37 → 37 | 533,945 → 533,945 | Exact GET parity |
| `GET /tasks/summary` | 2.25 / 3.90 | 2.70 / 6.68 | -19.8% | 6 → 6 | 58 → 58 | Exact GET parity |
| `POST /leads` | 47.57 / 56.78 | 11.43 / 14.04 | +76.0% | 24 → 24 | 1,403 → 1,403 | Scoped regressions pass |
| `PATCH /leads/:id` | 43.66 / 48.54 | 8.95 / 11.30 | +79.5% | 20–21 → 20–21 | 1,373 → 1,373 | Scoped regressions pass |

Concurrency 10:

| Method / endpoint (prefix `/api`) | Before p50 / p95 ms | Final p50 / p95 ms | Observed p50 change | Queries before → after | JSON bytes before → after | Validation |
|---|---:|---:|---:|---:|---:|---|
| `GET /auth/me` | 16.72 / 25.77 | 18.81 / 27.78 | -12.5% | 3 → 3 | 1,541 → 1,541 | Exact GET parity |
| `POST /auth/login` | 2708.19 / 2715.92 | 2780.21 / 2785.62 | -2.7% | 6 → 6 | 2,032 → 2,032 | Scoped regressions pass |
| `GET /leads?limit=1&counts=true` | 36.57 / 45.44 | 34.36 / 37.41 | +6.1% | 10 → 10 | 1,830 → 1,830 | Exact GET parity |
| `GET /leads?limit=1&counts=true&createdFrom=2026-10-15&createdTo=2026-10-22` | 34.13 / 35.84 | 32.43 / 34.74 | +5.0% | 10 → 10 | 1,829 → 1,829 | Exact GET parity |
| `GET /leads?limit=50&count=true&counts=true` | 55.44 / 63.57 | 54.71 / 59.69 | +1.3% | 10 → 10 | 65,105 → 65,105 | Exact GET parity |
| `GET /leads?limit=50&count=true&counts=true&status=new&tag=:tag&cf.segment=retail` | 990.47 / 1044.51 | 1017.97 / 1087.99 | -2.8% | 11 → 11 | 59,731 → 59,731 | Exact GET parity |
| `GET /leads?limit=50&q=Synthetic%20lead%202` | 49.33 / 53.46 | 45.43 / 51.20 | +7.9% | 9 → 9 | 64,989 → 64,989 | Exact GET parity |
| `GET /leads?limit=50&q=%25_%27` | 42.50 / 44.74 | 41.69 / 48.06 | +1.9% | 6 → 6 | 54 → 54 | Exact GET parity |
| `GET /leads/:id` | 24.70 / 27.16 | 22.69 / 24.46 | +8.1% | 9 → 9 | 1,578 → 1,578 | Exact GET parity |
| `GET /deals/board` | 310.01 / 336.19 | 297.79 / 325.02 | +3.9% | 37 → 37 | 533,945 → 533,945 | Exact GET parity |
| `GET /tasks/summary` | 17.72 / 21.61 | 20.45 / 24.08 | -15.4% | 6 → 6 | 58 → 58 | Exact GET parity |
| `POST /leads` | 248.58 / 463.82 | 62.89 / 97.76 | +74.7% | 24 → 24 | 1,403 → 1,403 | Scoped regressions pass |
| `PATCH /leads/:id` | 133.74 / 155.36 | 45.99 / 52.15 | +65.6% | 20 → 20 | 1,373 → 1,373 | Scoped regressions pass |

Cold app-import-to-first-authenticated-response, 30 separate Node processes: p50/p95 **1303.16/1343.75 → 1013.48/1083.77 ms**, three SQL statements before/after. [before-cold.json](before-cold.json), [final-cold.json](final-cold.json) retain every startup/request sample. This includes dynamic `app.js` import and first HTTP request; OS process launch is excluded. Database/OS caches remain warm. NODE_ENV=test includes development logger/import behavior. Hosted-database suspension, TLS/WAN RTT, serverless provisioning and cold starts of every other endpoint were not measured.

[before-metrics.json](before-metrics.json), [final-metrics.json](final-metrics.json) and their `*-samples.json` files retain endpoint samples. `after-scoring-*` isolates the scoring change; `after-index-*` and `index-on/off-*` describe only the rejected experiment. `before-plans.json.gz`, `after-scoring-plans.json.gz`, `after-index-plans.json.gz`, `final-plans.json.gz` retain EXPLAIN ANALYZE/BUFFERS JSON. Plans use a read-only transaction; mutating and locking statements are excluded.

**Validation**

- Offline suite: **286 passed, 131 skipped**. Skips are database-gated integrations.
- Focused auth/metrics/lead/scoring/dashboard/product regressions: **71 passed** on a second disposable database, isolated from performance fixtures.
- Full database-backed suite: **408 passed, 7 failed, 2 skipped**. Five Google-auth tests fail during OAuth callback/completion, one notification-digest test misses its Idle deals section, and one intermittent Gmail purge test selects a message with null activityId. All seven reproduced on the preserved pre-optimization source. The initial scoring pass had six failures because Gmail passed that run. Existing failures and their tests were not changed or disabled; an entirely green suite/zero-regression certification is unavailable.
- **122 contracts** match field-for-field between the preserved original source and final source, across five roles, tag/custom-field/date/status/deleted/search filters, eight sort directions with subsequent cursors, detail, board aggregates and an empty tenant. The benchmark separately compares its ten GET bodies. Special search includes `%`, `_` and an apostrophe; existing LIKE semantics remain unchanged. Last-page/empty behavior and exact financial totals are covered by existing DB performance tests. Leads has no offset mode, so no invented large-offset change was made.
- Cross-tenant access returns 403 for a token without membership and 404 for a valid foreign-tenant member reading another tenant's lead. Membership deactivation, role changes and token expiry take effect immediately. Concurrent five-tenant checks and concurrency-10 benchmark requests succeeded. Query counts remain bounded and no fields/payload bytes were removed.
- New scoring regression verifies linked rather than primary records, inbound timestamps, connected-call/meeting touch counts, deleted/old/future activity handling, missing leads and foreign-tenant activity exclusion. New auth regression prevents synchronous startup hashing and validates dummy-hash cost and rejection. Metrics regression verifies concurrent attribution, auth timing, off-mode returns/errors and no SQL/parameter logging.
- Node syntax checks for modified application modules and `git diff --check` pass. There is no Prisma schema change/client regeneration to validate for this implementation. Schema migrations from the user's working tree were applied only to disposable local databases as test prerequisites, never to the hosted database.

[validation.json](validation.json) records suite totals and matching SHA-256 hashes of the contract snapshots. Correctness checks run separately from timing runs. End-of-run memory snapshots were inspected, but GC-dependent point samples and short waves do not establish long-running memory stability or production capacity. No soak test, live browser trace, external SMTP/storage/Google/Meta flow, registration email timing or hosted-database cold-start benchmark is claimed.

**Modified files and commits**

| File | Change |
|---|---|
| `src/services/lead.service.js` | Add tenant predicate to both engagement-scoring relation queries, using an existing index. |
| `src/services/auth.service.js` | Precompute the non-secret dummy bcrypt hash; retain cost-12 comparisons. |
| `src/lib/performance.js` | Add auth duration and method/normalized-route finish metrics to existing safe request/query counters. |
| `src/middlewares/auth.js`, `src/middlewares/org.js` | Measure fresh JWT and workspace/RBAC work without caching or changing checks. |
| `test/lib/performance.test.js` | Extend concurrency/privacy tests and cover disabled timing behavior. |
| `test/modules/auth-startup.test.js` | Check startup hashing and unknown-user password defenses. |
| `test/integration/latency.test.js` | Add real-DB scoring, activity-rule and tenant regression. |
| `scripts/seed-perf-data.js` | Dev-only, empty localhost database seed with realistic relation volume. |
| `scripts/latency-audit.js` | Guarded HTTP timing, startup sampling, concurrent writes and GET parity. |
| `scripts/latency-plans.js` | Read-only safe SELECT plan capture into compressed artifacts. |
| `scripts/latency-contracts.js` | Compare original/final role/filter/pagination/detail/dashboard contracts and security boundaries. |
| `performance/latency-20261024/*` | Diagnosis, raw samples/plans, rejected index SQL, validation and report. |

Commits: `a13d56b` baseline/instrumentation, `16fdf2f` scoring (before/after in commit), `dbac766` rejected dashboard experiment, `1642d35` auth startup (before/after in commit). Final evidence/documentation is a separate commit. No user-owned pending changes were included.

**Indexes, deployment and rollback**

No index or migration is shipped. The existing ActivityLink tenant index supplies the write improvement. `rejected-cohort-index.sql` is explicitly an experiment artifact, not a deployment migration; do not apply it on release. The local experimental index was dropped; its temporary Prisma history entry exists only in the disposable benchmark database. No production index build/lock impact, backfill or cache invalidation is required.

Deploy the normal backend build with the application changes; this work needs no migration order or new environment values. Existing unrelated user migrations retain their own release process. `PERFORMANCE_METRICS=true` enables the existing Prisma query events, query count/DB time, safe slow-query warnings (`SLOW_QUERY_MS`, default 250), `Server-Timing` and structured request-finish logs, now with auth duration and normalized route. It remains off by default. Slow-query logging is also opt-in through that flag; SQL, bind values and tokens are not logged by this instrumentation. Header timings end when headers are sent; finish logs include the response lifetime and wire bytes, including compression when used. Sum of overlapping DB durations can exceed wall time. Monitor route p50/p95, counts, auth time, errors and pool pressure with suitable log retention.

Rollback application behavior by reverting `1642d35` and `16fdf2f` (in that order). The baseline instrumentation can be reverted separately or disabled with `PERFORMANCE_METRICS=false`. No schema rollback or cache flush is needed. Restore/disable only this work; preserve unrelated local feature changes. The local PostgreSQL process is stopped after verification; its synthetic files remain under `/tmp/techsync-latency-pg` for inspection.

**Reproduction and next steps (not implemented)**

Use an empty local database named `techsync_perf`. Never load the repository's remote URL into these experiments. Supply both explicit local migration URLs:

```bash
export PERF_DATABASE_URL='postgresql://perf@127.0.0.1:55439/techsync_perf?sslmode=disable&uselibpqcompat=true'
DATABASE_URL="$PERF_DATABASE_URL" DATABASE_URL_UNPOOLED="$PERF_DATABASE_URL" npm run db:migrate
node scripts/seed-perf-data.js
node scripts/latency-audit.js before
node scripts/latency-plans.js before
node scripts/latency-audit.js before cold
```

For a meaningful before/after comparison, first copy the current source (including required local feature files), tests, package/config and generated Prisma client into a separate temporary directory with access to the same installed dependencies. Restore `src/services/lead.service.js` and `src/services/auth.service.js` there from commit `a13d56b`. Run a copied benchmark harness from that directory for the baseline. Use the current source for `final`; both must use the same seeded database. `PERF_SOURCE_ROOT=/tmp/techsync-latency-baseline node scripts/latency-contracts.js before` selects the preserved original source; `node scripts/latency-contracts.js after` checks current source. Helpers refuse nonlocal/database-name mismatches and never load `.env`. Fixture IDs are stored at `/tmp/techsync-performance-fixture.json`. Use `PERF_ONLY` for an exact endpoint and `PERF_SAMPLES=100` for focused repeats. Integration tests use a separate migrated local `TEST_DATABASE_URL`.

Next priorities are a staged, compatibility-tested tag semi-join; colocated staging benchmarks in the configured database region; per-endpoint cold/warm pool and compute measurements; browser waterfall capture; and repair of the seven existing test failures. Account avatar storage calls, broad/short search, board serialization (534 KB), region RTT, pool contention, import graph size and per-record bulk status transitions remain potential limits. Outside scope, forecast still aggregates scoped deals in JS, notification unread/digest visibility can require scans, and task lists can issue several counts. These are source-review findings except the measured dashboard controls.

Redis, a new queue, stale permission claims or a TTL dashboard cache are **not justified by these measurements**. Keep fresh permissions and exact counts. Consider shared infrastructure only if staging measurements still show a repeatable bottleneck after the query work, and obtain the user's approval before adding it.
