# Diagnosis recorded before optimization

Current baseline: backend 09238a6 plus the user's pre-existing local changes; branch perf/auth-dashboard-leads-latency. Earlier performance fixes are already present and are not credited to this investigation. All new measurements use PostgreSQL 16.15 on localhost:55439, database techsync_perf, containing exclusively generated data: 5 tenants, 100 users, 125,000 leads, 15,000 deals, 375,000 activities/links and 375,000 tasks. No configured remote database was contacted.

30 HTTP samples per endpoint at concurrency 1 and 10, after three warmups. Raw samples and nearest-rank percentiles are in before-samples.json and before-metrics.json. Baseline EXPLAIN ANALYZE BUFFERS plans are in before-plans.json.gz. Locking SELECTs are excluded; plans run in a read-only transaction. Startup measurements use separate fresh Node processes and a warm local database; these do not measure a suspended hosted database.

| Endpoint | Baseline p50 / p95 ms, serial | Queries | Diagnosis / evidence |
|---|---:|---:|---|
| POST /leads | 47.57 / 56.78 | 24 | Scoring's activity-link relation omits organization_id. Parallel sequential scan removes 125,000 rows per worker across 3 workers. Inbound plan 18.922 ms / 4,279 shared buffers; touch count 16.247 ms / 4,263 buffers. Existing index begins with organization_id and cannot efficiently serve this predicate. |
| PATCH /leads/:id | 43.66 / 48.54 | 21 | Calls the same scoring queries. Concurrent benchmark uses independent records; same-record conflicts remain 409 by design. |
| GET /leads?limit=1&counts=true&createdFrom=2026-10-15&createdTo=2026-10-22 | 6.63 / 8.06 | 10 | Dashboard date cohort: bitmap heap scan over 9,576 leads, 250 heap blocks / 301 total shared hits, 2.924 ms SQL. Existing date index does not cover status. |
| GET /leads?limit=50&count=true&counts=true&status=new&tag=...&cf.segment=retail | 134.96 / 146.08 | 11 | Materializes 25,000 tag IDs in Node and rebinds them into 164 KB SQL with 25,004 parameters. Slow count plan 17.346 ms; remaining client/driver/transfer work is substantial. A broad SQL/filter rewrite would need separate compatibility work. |
| POST /auth/login | 281.33 / 288.72 | 6 | bcrypt comparison at cost 12 dominates warm CPU time; do not weaken hashing. Auth module also computes a dummy hash synchronously during import, which is unnecessary repeated cold-process work. Cold samples collected before changing it. |
| GET /auth/me | 2.69 / 4.44 | 3 | Fresh user, membership and workspace checks. JWT verification itself is local. No cache proposed because immediate revocation is part of the current contract. |
| GET /deals/board | 31.18 / 38.23 | 37 | Already batches visible cards; 533,945 JSON bytes. Included as a dashboard control. |

The diagnostic plan capture happens after temporary benchmark write fixtures are removed, so empty scoring lookups remain representative of new leads. No EXPLAIN is run on mutations. Query duration sums overlap and cannot be subtracted from wall time to infer CPU. The requested auth timing was added to the existing opt-in metrics before both versions were measured. Baseline offline suite: 284 passed / 130 skipped; with instrumentation tests: 285 passed / 130 skipped.
