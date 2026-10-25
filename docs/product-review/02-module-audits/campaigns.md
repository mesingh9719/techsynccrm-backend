# Campaigns audit

## Purpose and users

Owner/marketer measures acquisition; sales rep sees attributable leads within permissions.

## Review discipline and release gate

Apply all six lenses: market expectations; user jobs and complete journeys; data/API architecture; UX states and navigation; component/mobile/accessibility quality; validation/security/QA. “Partial” below includes implementation found but action not executed here. A rendered screen is not proof that every button, edge case, import path or role works. See [QA](../QA.md) for executed boundaries and known failures.

Release requires no open Blocker/High gaps, accurate real data, scoped server actions, clear mobile daily actions, loading/empty/error/confirmation behavior, deterministic tests, and documented migration/rollback.

## Flow map

| User flow | Screens and endpoints | Tables/entities | Status and evidence boundary |
|---|---|---|---|
| List/create/edit/copy/archive/delete | /app/campaigns → /campaigns CRUD and status | Campaign | Working rendered workspace; prior completion suite rerun |
| Enforce lifecycle transitions including M22 | /campaigns/:id/status and PATCH | Campaign.status | Working existing transition matrix tests |
| Associate/remove lead campaign preserving first touch | lead PATCH; campaign detail lead list | Lead.campaignId, utm, sourceDetail | Working existing DB regression; no rewrite |
| Metrics and budget/CPL/revenue | campaign service aggregate queries | Lead, Deal, Campaign spend | Working existing tests; external ad-spend sync Missing |
| Public form with campaign UTM + assignment | /public/forms/:key/submit | WebFormSubmission, Lead, AssignmentRule | Existing real-capture test; to rerun with review fixtures |
| Attribution after campaign deletion | retained campaign relation/label | Campaign soft delete, Lead | Working prior test paths |

## Architecture, data, security and performance

M22 status rules and prior performance/UI fixes are authoritative and retained. Manual actualSpendMinor is not ad-platform spend sync. Campaign ROI needs matching attribution/currency/period definitions; do not equate lead qualification with won revenue. Pagination exists but some pickers load all pages, a known scale opportunity.

## Product, UX, UI and market findings

PR-009 external Google Ads/Meta spend sync not implemented or live verified. PR-007 dashboard campaign panel all-time labels require careful demo. Further lifecycle redesign is unnecessary.

Use the existing shared state/loading/error/empty components and permission helpers. Desktop/mobile render observations come from the real local browser run; screenshots alone do not certify contrast, screen readers, keyboard order or touch device behavior. Prioritize the market matrix table stakes over unsupported channel promises. Currency, timestamps, source labels and ownership must match the originating record and active workspace.

## Cross-module consistency and fixes

PR-009 external Google Ads/Meta spend sync not implemented or live verified. PR-007 dashboard campaign panel all-time labels require careful demo. Further lifecycle redesign is unnecessary.

Master issue statuses are maintained in [gap register](../03-gap-register.md). Avoid independent status claims for a shared defect.

## Evidence and next checks

docs/modules/M22-campaigns.md; backend/docs/campaign-pipeline-completion; backend/src/services/campaign.service.js; frontend/src/features/campaigns. Current browser/API results: [QA](../QA.md), [evidence](../evidence/). Additional flows marked Partial must still be exercised with role changes, foreign IDs, invalid input, zero-state and mobile interactions before release.
