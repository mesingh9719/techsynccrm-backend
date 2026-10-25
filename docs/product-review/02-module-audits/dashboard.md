# Dashboard audit

## Purpose and users

Owner/manager daily overview; sales rep prioritizes own leads and follow-ups.

## Review discipline and release gate

Apply all six lenses: market expectations; user jobs and complete journeys; data/API architecture; UX states and navigation; component/mobile/accessibility quality; validation/security/QA. “Partial” below includes implementation found but action not executed here. A rendered screen is not proof that every button, edge case, import path or role works. See [QA](../QA.md) for executed boundaries and known failures.

Release requires no open Blocker/High gaps, accurate real data, scoped server actions, clear mobile daily actions, loading/empty/error/confirmation behavior, deterministic tests, and documented migration/rollback.

## Flow map

| User flow | Screens and endpoints | Tables/entities | Status and evidence boundary |
|---|---|---|---|
| Open dashboard, change period/owner/source | /app → listLeads, getBoard, taskSummary, campaigns, report widgets | Lead, Deal, Task, Campaign | Working for render/filters; exact individual drilldowns Partial |
| Customize KPI/widget visibility and persist layout | DashboardCustomize → localStorage scoped by org/user | Browser preference only | Code reviewed; full preferences QA pending |
| Needs attention → lead detail → next action | new lead list → /app/leads/:id | Lead, Activity, Task | Working page navigation; guided edits inherited |
| Revenue/source charts → reports/source list | /reports/revenue-series, /reports/leads-by-source | Deal, Lead, LeadSource | Working real API; no samples |
| Setup checklist → source/team/import/pipeline | SetupChecklist/useSetupProgress → forms/members/checklist | Organization, WebForm, ImportJob | Partial; live API boundary fixed |

## Architecture, data, security and performance

KPI lead totals subtract junk and use period cohorts. Current-state funnel labels must stay distinct from history-based report funnel. Pipeline and campaign cards are all-time snapshots and should not imply period-filtered values. Existing lazy query enablement and aggregate counts preserve prior latency work. No standalone dashboard API; isolation must be proven through constituent endpoints.

## Product, UX, UI and market findings

PR-007: remaining current-status funnel versus cohort-history distinction. PR-015: full keyboard/contrast and physical-device checks pending. PR-017: sample onboarding replaced with real actions and server checklist facts.

Use the existing shared state/loading/error/empty components and permission helpers. Desktop/mobile render observations come from the real local browser run; screenshots alone do not certify contrast, screen readers, keyboard order or touch device behavior. Prioritize the market matrix table stakes over unsupported channel promises. Currency, timestamps, source labels and ownership must match the originating record and active workspace.

## Cross-module consistency and fixes

PR-007: remaining current-status funnel versus cohort-history distinction. PR-015: full keyboard/contrast and physical-device checks pending. PR-017: sample onboarding replaced with real actions and server checklist facts.

Master issue statuses are maintained in [gap register](../03-gap-register.md). Avoid independent status claims for a shared defect.

## Evidence and next checks

frontend/src/features/dashboard/{DashboardPage,DashboardKpis,DashboardReportWidget,LeadFunnelView}.tsx; test/campaign-pipeline.test.mjs; backend/test/integration/performance.test.js. Current browser/API results: [QA](../QA.md), [evidence](../evidence/). Additional flows marked Partial must still be exercised with role changes, foreign IDs, invalid input, zero-state and mobile interactions before release.
