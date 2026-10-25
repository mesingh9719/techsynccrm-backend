# Implementation prompt — Phase 4: one explicitly selected advanced feature

This is a selection-gated prompt. It does not authorize the entire advanced backlog. Before running it, the owner must name the chosen bundle and approve its detailed scope, data policy, provider actions and any costs. If no feature is selected, produce a narrow proposal and stop without implementation.

## Context and review

TechSync CRM is Express JavaScript/Prisma 7/Postgres/pg-boss with React 19/TypeScript/Tailwind/TanStack Query, serving Indian SME clinics/coaching. Read Workspace plan `01`–`09`, prior phase code/QA and decision log; preserve existing Gmail/login/CSV/XLSX/Files/current sync behavior and all unrelated staged work. Use synthetic isolated data and mocked providers until actual test-account actions are separately authorized. Recheck current official Google documentation for every new scope, rate/quota/billing change and method; cite checked URLs and mark uncertainty.

## Select one bundle and specify it before coding

- **Public booking:** availability source/working hours/buffers, explicit timezone/DST, expiring opaque booking links, rate/spam controls, guest confirmation, local reservation race handling and cancellation/reschedule identity. Do not reveal customer or private calendar details on public pages or promise atomic conflict prevention across outside writers.
- **Team calendar/shared destinations:** current own/team/all visibility, authorized availability without event-content leakage, Google shared-calendar/shared-drive capabilities, organizer rules and employee departure. Team CRM access never transfers Google credentials or Drive access.
- **Recurring-series editing:** map CRM occurrence semantics vs Google RRULE, exceptions, moved/deleted instances and this/future/all choices. Define bounded expansion and conflict behavior before changing existing recurrence. Never create both an RRULE and duplicated single events for one occurrence.
- **Explicit file sharing:** recipient validation and reader/writer scope, clear confirmation, permission-operation serialization, inherited/shared-drive restrictions, audited reversal limits and no default public links. Reuse selected-file drive.file where supported; request broader grants only after owner approval and verification review.
- **Enterprise DWD:** actual customer Workspace sponsor/super-admin, supported domain and impersonation allowlist, service-account key/workload-identity strategy, least-privilege delegated scopes, audit/retention, emergency disable and enterprise contract. Consumer Gmail remains per-user OAuth. DWD is not a blanket SaaS verification bypass.

## Required incremental implementation contract

Write the selected feature's model/relations/tenant-first indexes, exact API list, background handlers and UI flow in a reviewed sub-design first. Use existing connection/profile/consent/crypto/generation/lease and outbox machinery. Any large existing-table index is online with rollback/recovery; no production migration in development. No cross-tenant IDs, secret DTOs/jobs or new Redis/provider infrastructure without explicit authorization.

Define source-of-truth/loop prevention, deterministic operation identity, provider timeout reconciliation, membership/plan revocation, quotas/backoff/dead-letter and user-visible degraded states. Extend the existing design system and record/Tasks/Files screens with accessible phone support; avoid an unrelated replacement workflow. Add exact privacy/Terms/consent updates only for behavior actually implemented. Public launch stays behind its scope classification, branding and sensitive/restricted/assessment gates; get approved assessor quotes if any new R feature is justified.

## Tests and deliverables

Test unit provider/time/identity/permission contracts, real HTTP/Postgres with mocked Google, concurrency/crash/replay/unknown-write failures, two tenants/all roles, membership/owner departure, privacy retention/deletion and full browser action-to-data flows. Each selected bundle adds focused abuse/race cases: booking spam/reservation, team visibility, RRULE exceptions, sharing recipient/permission races or delegated-domain/impersonation escape. Run full backend regression and frontend behavior/TypeScript/build/lint; separately authorized Google sandbox proves actual API/consent behavior. No real customer invitations, files or production load testing by default.

Deliver small logical commits, migration/rollback and deployment notes, exact env/scope/API requirements, dated QA evidence/limits, support/monitoring playbook and an updated decision record for the approved feature. Stop after its acceptance criteria; do not infer approval for the other bundles, production activation, paid infrastructure or broader scopes.
