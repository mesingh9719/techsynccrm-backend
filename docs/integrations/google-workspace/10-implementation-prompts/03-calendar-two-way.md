# Implementation prompt — Phase 1C: linked-event two-way Calendar

Run only after the owner approves Phase 1C/conflict rules and Phase 1B scheduling is verified. The manual Drive/Sheets release may proceed independently; do not merge its scope with Calendar unnecessarily.

## Context and review

TechSync serves Indian SME clinics/coaching. Use existing Express JavaScript, Prisma 7/Postgres/pg-boss and React 19/TypeScript/Tailwind/TanStack Query. Read Workspace plan `02`, `04`–`09`, current Phase 0/1B code, outbox/worker/queues, Task lifecycle/time helpers, provider public-route handling and legacy Gmail push pattern. Calendar notifications are **not** Gmail Pub/Sub JWTs. Preserve staged user work and existing callbacks; establish full baseline on disposable synthetic data.

## Scope and models

Use the approved dedicated-calendar grant (`calendar.app.created`); confirm actual classification/verification gate. Existing-primary support requires separately approved existing-calendar scope and linked-ID read mode. Never use broad whole-calendar ingestion as a shortcut.

Extend/add GoogleWatchChannel, replay receipts, GoogleCalendarLink cursor/lease/renew fields and CalendarEventLink last-common state/etag/conflict/tombstone. Tenant-composite FKs and due indexes; channel IDs globally unique, random token hash/generation. Preserve task identities and mappings on rebaseline. No full personal-event cache, raw event descriptions or Google payload logs.

## Implement incrementally

1. Persist pending watch before provider request; verify early authenticated sync before the response without accepting unknown channels as trusted. Store returned resource/expiry, schedule overlapping replacement with new channel ID and stop the old channel. Respect returned expiry rather than a fixed seven-day assumption.
2. Add public HTTPS `/api/webhooks/google/calendar`, isolated from bearer-login middleware. Verify channel/token in constant time, expected resource/state/generation/expiry, bound input sizes and replay receipt. Message numbers are non-sequential; duplicate/reordered deliveries must not lose updates. Persist due state then 204; no synchronous data sync in the request.
3. Register bounded `.pull`/`.renew`/maintenance handlers and durable scans in pg-boss. Dedicated mode consumes initial/delta pages, discards unlinked events immediately and stores only the final-page sync token after durable processing. Do not combine syncToken with privateExtendedProperty/q/timeMin/timeMax. Primary mode reconciles known linked IDs. 410 resets only sync state; polling fallback catches lost pushes.
4. Apply approved field ownership: CRM record binding/organizer/approved guests authoritative; Google linked-event time/location/cancellation may update an authorized scheduled Task. Use existing Task services/system events and recheck current assignee/record access. Same-field divergence since last common version is a conflict; non-overlap merges, repeated identical projection does not loop.
5. External deletion creates a tombstone and cancels the scheduled Task in two-way mode, never a lead. Pending provider/CRM changes, completed tasks, deleted records, reassignment and revoked grants follow the architecture. No automatic recurrence-series conversion or task completion from RSVP.
6. Add Settings direction/health, record timeline source labels, conflict-resolution endpoint/dialog, informational RSVP and last-sync/retry/pause states. Keep one-way mode available and truthful while push routing is unavailable.

## Tests, security and completion

Unit/provider tests plus real HTTP/Postgres workers with mocked Google: early sync, forged token/channel/resource, expired/revoked generation, duplicate/nonsequential/reordered messages, watch overlap/stop failure, missed notifications, paginated failure/restart, 410, 412, concurrent edit/cancel and two worker leases. Prove no unrelated event becomes a CRM task and no private event content enters logs. Test tenant A channel/payload under B endpoints, removed member/role/plan after enqueue, same-identity grant revoke, all-day/timezone/DST changes, reassignment and crash after provider/CRM commit. Frontend behavior/TypeScript/build/lint, full backend regression and browser change/cancel/conflict/reconnect/phone flows.

After separate explicit authorization, a controlled Google account must receive a real watch through the actual HTTPS callback, external edit/cancel, renewed channel and polling recovery. Local simulated push is not live verification. Document host/proxy/certificate/worker health requirements, metrics/lag/quota, migrations/rollback and exact test evidence. Use small logical commits and flags off by default; stop at Phase 1C acceptance criteria for review. Do not add public booking, team views, DWD, broad scopes or paid infrastructure.
