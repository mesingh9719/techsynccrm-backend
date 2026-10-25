# Delivery roadmap

## Release gate

Every module: close Blocker/High issues; table-stakes flows backed by real data; server role/tenant boundaries; mobile daily actions; validation/loading/empty/error/confirmation basics; regression tests and reproducible UI evidence; explicit deployment/rollback instructions. Nearly ready is not a release pass.

## Batch plan (dependencies first)

1. Foundations: capture baseline, correct real-data boundaries, common scoped report filters/history/export. Reuse API envelope, Zod, visibility, money/time, transactional outbox, CSV safety.
2. Batch A — Leads, Contacts/Companies, Pipeline, Tasks: conversion, reference visibility, task completion/reminders, import/dedupe, roles/tenant checks. Retain prior pipeline work.
3. Batch B — Dashboard, Reports, Campaigns: real reporting (PR-001–005), cross-module numerical checks, source/currency/date accuracy. Retain M22 rules and latency changes.
4. Batch C — Templates, Integrations, Settings: verify inherited templates/Gmail; real capture/assignment; honest connector statuses; team/security setup. No new paid services.
5. Batch D — daily mobile journey, onboarding, keyboard/error states, consistency, full regression and documentation.

## Deliberate product boundaries

Provider-dependent WhatsApp inbox/Google Ads/Instagram DMs, billing, clinical scheduling, fee accounting and broad automation need explicit provider/business decisions. Continue all independent work; do not silently label absent capabilities complete. Scheduled reports and targets are specified by M15 and remain work, not optional differentiators.

## Packaging hypothesis (not implemented)

Entry should cover lead capture, follow-ups, conversion, import/export, basic reports and secure team access. Growth can gate assignment automation, multiple pipelines and scheduled summaries. Business can gate forecasting and advanced administration. Meter external messaging separately and show total cost including GST/provider fees. Validate willingness to pay with 5–10 clinics/coaching teams before setting prices.

## Implemented now

- Batch A foundations: scoped related names/counts; exact No source filter; preserved original conversion/task/lead behavior and reran its regressions.
- Batch B: seven real report endpoints, status-event funnel, source drilldowns, server-authorized audited export, response/compliance UI, tenant/currency/IST correctness, online indexes and measured query optimization.
- Batch C: live form/assignment/settings adapters, rollout switches with real error states, Google login schema/link fixes, separate verification of inherited Templates/Gmail work.
- Batch D: real onboarding/import/pipeline actions, derived cache invalidation, unsupported multiplier copy removed, CSV control-character safety, desktop/phone daily journey and evidence package.

These are completed changes, not completion of every module's release gate. No scheduled summary, target editor, missing provider connector, billing flow or manual lead merge was quietly claimed as delivered.

## Prioritized remaining work

Score = severity base (Blocker 100, High 60, Medium 30, Low 10) + impact (1–5) × 5 − effort (S=1, M=2, L=3) × 3. Security evidence wins ties. Scores are prioritization estimates, not business validation or delivery dates.

| Next | Gap | Score | Concrete next deliverable |
|---|---|---:|---|
| 1 | PR-012 exhaustive tenant/role coverage | 76 | Resolve nested routes in inventory; add positive/negative role and foreign-ID cases per in-scope method/action; map UI permission state |
| 2 | PR-011 inherited Templates/Gmail release dependency | 79 | Review/commit user-owned work separately, coordinate additive migrations and provider setup; keep review commits isolated |
| 3 | PR-008 M15 scheduled reports and targets | 76 | Tenant models/API/UI, per-recipient current scope, durable retry/leases, unsubscribe, plan gate, timezone/DST tests and rollback |
| 4 | PR-009 acquisition connectors | 76 | Prioritize website + tested Meta first; choose Google Ads and official WhatsApp/Instagram provider scopes with explicit cost approval |
| 5 | PR-019 manual lead merge | 71 | Resolve D11 conflict policy; preserve timeline/tasks/files/attribution transactionally; undo/recovery, race/tenant tests and UI |
| 6 | PR-010 billing/plan readiness | 76 | Owner-approved pricing/provider and GST treatment, checkout/webhook/idempotency/reconciliation; no paid infrastructure provisioned here |
| 7 | PR-015 remaining accessibility/device QA | 71 | Main daily actions with keyboard/screen reader/contrast/dark mode, physical phone and all role states |
| 8 | PR-022 connector health | 44 | Unified last-sync/error/retry/reconnect view and dead-letter workflows using existing job architecture |
| 9 | PR-023 historical team reporting | 44 | Decide inactive-owner visibility and reconcile historical revenue totals to team rows |
| 10 | PR-017 vertical starter configuration | 44 | Optional clinic/coaching pipeline/field/template pack; Hindi messages before a translated UI |
| 11 | PR-016 audit viewer / PR-020 calendar | 39 | Existing audit data viewer with permissions/pagination; separately scope daily calendar planning |
| 12 | PR-021 template date consistency | 17 | Use workspace locale/timezone through shared formatting in inherited template UI |

Pricing/packaging recommendations remain research hypotheses. A five-seat entry option merits interviews because the current two-seat Starter does not match the stated buyer team. Do not change plan limits or charge customers from this engineering review.
