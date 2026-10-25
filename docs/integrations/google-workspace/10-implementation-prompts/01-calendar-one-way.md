# Implementation prompt — Phase 1B: Calendar scheduling

Run only after Phase 0 passes and the owner approves Phase 1B plus G06–G11 defaults. Obtain the exact Cloud Calendar scope classifications before public rollout; do not assert that narrow scopes are verification-free.

## Product context and review

Implement explicit CRM appointment/follow-up scheduling for Indian SME clinics/coaching. Stack: Express JavaScript/Prisma 7/Postgres/pg-boss; React 19/TypeScript/Tailwind/TanStack Query. Use the Phase 0 shared GoogleConnection/Workspace profile, not a second OAuth implementation. Keep existing Gmail send-only behavior, login, files and spreadsheet transfers intact.

Read the Google Workspace plan's `01`, `02`, `04`–`09` documents, Task model/service/date helpers, permissions, org membership loading, worker/outbox and TaskFormDialog/RecordTasks/MyDay/lead next steps. Inspect current staged work and branch; preserve unrelated changes. Capture baseline tests. Verify Phase 0 contracts and feature gates are actually present. Use isolated synthetic database fixtures and mocked Google by default.

## Scope and data model

Default dedicated TechSync calendar with `calendar.app.created`; optional own free/busy uses separately consented `calendar.freebusy`. Do not request full `calendar`, broad event read, Gmail read, Meet recording/transcript or broad Drive scopes. Classify exact scopes in Cloud Console; public launch waits any required review. Existing-primary mode is deferred unless explicitly included in approval.

Add `GoogleCalendarLink`, `TaskCalendarSchedule` and `CalendarEventLink` with tenant-composite keys, deterministic event operation UUID/provider ID, etag/last common projection, generation/due-state leases and Meet request status. Existing Task dueAt is not a duration/start by default. A new explicitly scheduled meeting uses dueAt=start and stored start/end/timezone metadata; ordinary deadlines/all-day tasks remain unchanged. Adopt approved duration/reminder defaults and date-only intervals. No eager calendar backfill of every task.

## Endpoints, worker and UI

- Own Calendar settings plus task schedule/update/cancel and optional availability routes from architecture; require current task/record action scope, assignee's own connection, tenant flags/plan and service consent. Never accept arbitrary foreign calendar/record IDs.
- Save Task/schedule/outbox atomically. Register IDs-only `google.calendar.write` handlers, minute due-state recovery, bounded backoff and generation-fenced refresh. Provider effects happen outside DB transactions.
- Deterministic Calendar event ID; reconcile timeout/409 before create retry; If-Match patches and visible conflict on 412. Meet uses stable requestId and asynchronous result state. No blind resend of an uncertain invitation.
- Extend existing task/lead scheduling dialog with explicit date/start/duration/timezone, calendar, location, optional guests/Meet and one reminder owner. Minimal neutral title/CRM link; no clinical details or automatic lead attendee. Adding guest/invite is explicit and current-recipient checked. Pending/Delayed/Ready is truthful; CRM save survives provider failure.
- CRM completion retains event history; cancellation/record deletion follows approved future-event policy. Reassignment needs organizer-aware handling and new assignee authorization, not silent provider ownership transfer. Existing recurrence produces individual events only when CRM creates each occurrence. Set no duplicate default staff Calendar reminders.

## Security, edge cases and tests

Cover all five roles/two tenants and manager outside-team requests; denied scope, removed member/downgrade after enqueue, offline worker/Google, crash after provider commit, refresh race, soft-deleted lead, cancelled/restored Task, changed assignee, all-day midnight, per-user/workspace zones, DST gap/overlap, ambiguous local input, guest notification choices and Meet capability failure. Availability is a time-bounded free/busy check, not an atomic external reservation; never display unknown as free. Preserve existing Tasks/Today reminders and Gmail tests.

Tests: unit mapping/time/IDs; real HTTP/Postgres integration with mocked Calendar; full browser schedule/edit/cancel/pending/guest/reconnect at desktop/390 px; frontend tests/TypeScript/build/lint and full backend regression. After separately authorized test-account access, verify exact consent, one real test event, time change/cancel, guest invitation and optional Meet. Do not send to real leads or operate production calendars during automated testing.

Deliver small logical commits, additive/reversible migration notes, API docs, flags/defaults, user/privacy copy matching actual behavior, queue/host setup, observed QA and known limitations. Satisfy Phase 1B acceptance criteria in `06-roadmap.md`; leave two-way push/series/booking/team/DWD for later. Stop for review before the next phase or public enablement.
