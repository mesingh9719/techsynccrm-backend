# Tasks Follow Ups audit

## Purpose and users

Sales/front desk works today and overdue; managers reassign; owner checks compliance.

## Review discipline and release gate

Apply all six lenses: market expectations; user jobs and complete journeys; data/API architecture; UX states and navigation; component/mobile/accessibility quality; validation/security/QA. “Partial” below includes implementation found but action not executed here. A rendered screen is not proof that every button, edge case, import path or role works. See [QA](../QA.md) for executed boundaries and known failures.

Release requires no open Blocker/High gaps, accurate real data, scoped server actions, clear mobile daily actions, loading/empty/error/confirmation behavior, deterministic tests, and documented migration/rollback.

## Flow map

| User flow | Screens and endpoints | Tables/entities | Status and evidence boundary |
|---|---|---|---|
| Today/overdue/upcoming/completed list and quick add | /app/tasks → GET/POST /tasks | Task | Working UI quick-add persists to local DB |
| Create/edit due time/all day/priority/type/record | TaskFormDialog → /tasks | Task, Lead/Contact/Company/Deal | Working existing DB time validation; phone editing Partial |
| Complete with call/message log and next occurrence | POST /tasks/:id/complete | Task, Activity, Lead status | Working local API and concurrency tests |
| Snooze/reschedule/cancel/reopen/delete/bulk | PATCH/actions /tasks | Task reminders and events | Working existing regression suite; UI variants Partial |
| Reminder/in-app/email/digest delivery | worker tasks.reminders/overdue_scan, notifications | Notification, NotificationEmailBatch | Partial; deterministic digest regression pass, old clock fixture corrected with assertions retained |
| Calendar/invite download | activity/task helper paths | ICS | Partial; no full calendar UI found |
| Response/compliance summary | /reports/first-response, /reports/follow-ups | Lead, Task | Working new scoped aggregate tests |

## Architecture, data, security and performance

Due timestamps UTC; all-day due is workspace end of day; recurring tasks retain timezone and spawn once under concurrent completion. Follow-up types include todo/call/meeting/follow_up/email/whatsapp; site_visit is activity vocabulary, not task type. Current overdue backlog and period due-cohort on-time completion are labelled separately. No push or WhatsApp reminder delivery is claimed.

## Product, UX, UI and market findings

PR-013 old m11 fixture uses Date.now-relative deal data against fixed 19 October evaluation: baseline failure retained as evidence; fixture corrected to the declared clock and original assertions now pass; deterministic threshold test added. PR-020 no full calendar page; avoid claiming calendar parity. Reminder worker delivery and actual phone/email handoff pending.

Use the existing shared state/loading/error/empty components and permission helpers. Desktop/mobile render observations come from the real local browser run; screenshots alone do not certify contrast, screen readers, keyboard order or touch device behavior. Prioritize the market matrix table stakes over unsupported channel promises. Currency, timestamps, source labels and ownership must match the originating record and active workspace.

## Cross-module consistency and fixes

PR-013 old m11 fixture uses Date.now-relative deal data against fixed 19 October evaluation: baseline failure retained as evidence; fixture corrected to the declared clock and original assertions now pass; deterministic threshold test added. PR-020 no full calendar page; avoid claiming calendar parity. Reminder worker delivery and actual phone/email handoff pending.

Master issue statuses are maintained in [gap register](../03-gap-register.md). Avoid independent status claims for a shared defect.

## Evidence and next checks

backend/src/services/{task,notificationDelivery,notificationAccess}.service.js; backend/test/integration/{product,m11,product-review}.test.js; frontend/src/features/tasks. Current browser/API results: [QA](../QA.md), [evidence](../evidence/). Additional flows marked Partial must still be exercised with role changes, foreign IDs, invalid input, zero-state and mobile interactions before release.
