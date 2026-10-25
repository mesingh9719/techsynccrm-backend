# Implementation prompt — Phase 3: directional Sheets automation

Run only after the owner approves Phase 3/G15–G21, Phase 2 manual export/Picker and Phase 0 connection boundaries pass, and a report-scheduling dependency choice is recorded. This prompt does not authorize general two-way cell editing, Apps Script installation or changing existing plan prices.

## Context and review

TechSync is a tenant-scoped SME CRM using Express JavaScript/Prisma 7/Postgres/pg-boss plus React 19/TypeScript/Tailwind/TanStack Query. Read Workspace plan `01`–`09`; review actual Phase 0/2 implementation, current scopes, files/storage, importCore/generated backend sync script, ImportJob preview/revision/worker/dedupe/undo, transfer/report services, outbox and membership/permissions. M15 report scheduling is not assumed complete. Preserve user-owned staged Gmail/Templates work and current Excel/CSV behavior; establish synthetic DB/provider-mocked baseline.

## Scope, schema and invariants

Use selected-file **drive.file**, not broad Sheets/Drive or Gmail scopes. Implement SheetSync, SheetRowMap, SheetImportRun/snapshot references and bounded report-schedule state using architecture's tenant-composite constraints, generation/lease/due indexes and stable operation keys. Outbound and inbound are distinct directions/tabs; reject simultaneous known writers to a managed destination, including cross-workspace connection attempts without disclosing another tenant. Numeric sheetId is durable; row index is only a location hint.

Inbound requires an immutable unique source ID. Reviewed setup may add a reserved ID column only with explicit permission; otherwise require a source-provided stable key. Never substitute row number or content hash as identity. Changed/duplicated/blank source IDs require review or row errors. Idempotency covers stable source identities and retries; do not claim arbitrary copied/key-edited customer rows can never become new intake.

## Incremental implementation

1. Owner/admin creates inbound sync under current records.import permission; manager may create outbound only within current records.export.team authority. Reps/viewers cannot bulk export by using a sync endpoint. Enforce tenant feature/export switches and approved plan limits on every run.
2. Reuse six-step mapping/options/full preview and revision confirmations. Read selected Sheets ranges with explicit value/date rendering and locale handling; do not accidentally treat Google date serials as Excel dates. Normalize bounded immutable snapshots through the existing import service/core, custom-field/source/owner/plan/dedupe checks. Snapshot/error files have approved expiry and file visibility. Source-row deletion never deletes CRM records; updates touch only reviewed intake fields.
3. Register IDs-only inbound 15-minute jittered polling and outbound outbox-coalescing handlers. Durable due scans recover queue/worker failure; per-sync leases, current permissions and generation fences apply. Record/status checkpoints commit with the CRM import effects; repeats find the same source key. Optional status writeback is explicitly selected and restricted to named CRM-status columns.
4. Outbound owns a dedicated tab and reserved opaque row key/version fields. Resolve current key-to-position before writes, detect structural drift/duplicate keys and pause rather than overwrite random user cells. CRM owns managed columns; user annotations stay separate. RAW safe-text writes, byte-bounded batches, fair per-user/project quota budgets and no blind append retry after timeout. Lost response triggers reconciliation by stable row keys.
5. Scope/filter/record deletion changes remove app-owned destination rows when still authorized, and pause when destination access is lost. Explain that Google revisions/other copies cannot be recalled. Departure pauses the sync; new owner must connect/select/validate independently.
6. For Phase 3C implement only the approved scheduler choice: a bounded daily/weekly Sheets schedule or a separately authorized M15 dependency. Compute UTC nextRunAt from saved IANA timezone and dedupe by schedule/local-period. Recheck current report/record permissions and owner membership each run; do not reuse stale recipient/export scope.
7. Provide list/detail/setup/preview/start/pause/retry/log APIs and shared-component wizard/health/error UI with last success/next run/counts, failed row references and mapping-drift review. Keep manual export and CSV/XLSX usable if Google is down.

## Tests and delivery

Test real HTTP/Postgres/queue with mocked Google for two tenants/five roles; cross-tenant destination conflict, initial/updated stable row, row move/insert/delete/duplicate key, renamed tab, changed header/locale/date, malformed money/phone/custom fields, duplicate strategies, plan limit race, snapshot revision, worker restart and failure after provider/CRM success. Check scope loss mid-chunk, expired tokens/admin block, quotas/429/Retry-After/5xx, uncertain append, two workers, duplicate schedule/local-day DST, owner departure and immutable error/log retention. No provider payloads or keys in logs.

Run unit/contract/focused integration/full backend, frontend behavior/build/lint and complete browser inbound/outbound/report flows at desktop/phone. Test 1k/5k pilot and bounded 50k intake against a fake provider; no Google load test. Separately authorized test-account smoke must confirm actual Drive-file grants, row identity/reordering and schedule behavior. Document operational limits, retention/deletion and external-copy caveats, metrics, setup/rollback and exact evidence. Deliver reviewable logical commits and stop for phase review; no Apps Script trigger, general same-cell two-way mode, Redis or paid quota increase.
