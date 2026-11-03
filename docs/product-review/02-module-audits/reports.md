# Reports audit

## Purpose and users

Owners trust business outcomes; managers inspect team work; reps see personal progress; export-capable roles share results.

## Review discipline and release gate

Apply all six lenses: market expectations; user jobs and complete journeys; data/API architecture; UX states and navigation; component/mobile/accessibility quality; validation/security/QA. “Partial” below includes implementation found but action not executed here. A rendered screen is not proof that every button, edge case, import path or role works. See [QA](../QA.md) for executed boundaries and known failures.

Release requires no open Blocker/High gaps, accurate real data, scoped server actions, clear mobile daily actions, loading/empty/error/confirmation behavior, deterministic tests, and documented migration/rollback.

## Flow map

| User flow | Screens and endpoints | Tables/entities | Status and evidence boundary |
|---|---|---|---|
| Date/owner/source/compare report load | GET /reports/kpis | Lead, Deal | Working all-role API + browser |
| Revenue monthly series and source performance | /reports/revenue-series, /leads-by-source | Deal, LeadSource | Working aggregate/currency/IST tests; online indexes |
| Creation cohort funnel after loss/regression | /reports/funnel | Lead, retained DomainEvent, Deal | Working new history/visibility tests |
| Team performance | /reports/leaderboard | Membership, Deal, ActivityLink | Working scoped API; source links restrict activities |
| First response and follow-up compliance | /reports/first-response, /follow-ups | Lead, Task and readable linked records | Working new metrics and UI; no-response is null not zero |
| Source drilldown preserves exact cohort | sourceLeadUrl → GET /leads including source none | Lead | Working API/filter-link assertions |
| Authorized export with audit + CSV escaping | GET /reports/:report/export → shared encoder | AuditLog + aggregate data | Working direct API denied for rep/viewer; browser download |
| Monthly targets and emailed summaries | GET/PUT /reports/targets, GET/PUT /reports/schedules/:frequency, reports.scheduled job | SalesTarget, ReportSchedule | Working; targets prorated to the period, summaries built with the recipient's scope; saved views remain browser-local |
| Trend, pipeline by stage, forecast, lost reasons, campaigns, activity | /reports/trend, /pipeline, /forecast, /lost-reasons, /campaigns, /activity (+ exports) | Deal, PipelineStage, LostReason, Campaign, Activity | Working; seeded verification of every metric and role scope; campaign spend ratios are to-date |

## Architecture, data, security and performance

Real reporting replaces generated facts. Revenue uses wonAt, excludes deleted and other currencies; win rate uses won and lost closed in period. Cohort excludes junk. History uses both old/new statuses in retained transactional events; no invented legacy transitions. Monthly aggregation is server-side and custom ranges reconcile with KPI totals. Five-minute persistent cache omitted to avoid role/history staleness without measured need; UI stale time 30 seconds.

## Product, UX, UI and market findings

PR-001–005 fixed core. PR-008 remains scheduled summaries/targets and broader report set. Exports use an authorized/audited JSON dataset endpoint with the shared CSV encoder, not a PDF generator. All report data needs current-role checks on every request. New 100k-lead local HTTP measurements pass the 500ms target; remote/concurrent performance remains unverified.

Use the existing shared state/loading/error/empty components and permission helpers. Desktop/mobile render observations come from the real local browser run; screenshots alone do not certify contrast, screen readers, keyboard order or touch device behavior. Prioritize the market matrix table stakes over unsupported channel promises. Currency, timestamps, source labels and ownership must match the originating record and active workspace.

## Cross-module consistency and fixes

PR-001–005 fixed core. PR-008 remains scheduled summaries/targets and broader report set. Exports use an authorized/audited JSON dataset endpoint with the shared CSV encoder, not a PDF generator. All report data needs current-role checks on every request. New 100k-lead local HTTP measurements pass the 500ms target; remote/concurrent performance remains unverified.

Master issue statuses are maintained in [gap register](../03-gap-register.md). Avoid independent status claims for a shared defect.

## Evidence and next checks

backend/src/services/report.service.js; backend/src/routes/report.routes.js; frontend/src/features/reports; backend/test/integration/product-review.test.js; M15. Current browser/API results: [QA](../QA.md), [evidence](../evidence/). Additional flows marked Partial must still be exercised with role changes, foreign IDs, invalid input, zero-state and mobile interactions before release.
