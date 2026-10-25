# Pipeline audit

## Purpose and users

Sales rep advances deals; manager reviews stale work/forecast; admin configures process.

## Review discipline and release gate

Apply all six lenses: market expectations; user jobs and complete journeys; data/API architecture; UX states and navigation; component/mobile/accessibility quality; validation/security/QA. “Partial” below includes implementation found but action not executed here. A rendered screen is not proof that every button, edge case, import path or role works. See [QA](../QA.md) for executed boundaries and known failures.

Release requires no open Blocker/High gaps, accurate real data, scoped server actions, clear mobile daily actions, loading/empty/error/confirmation behavior, deterministic tests, and documented migration/rollback.

## Flow map

| User flow | Screens and endpoints | Tables/entities | Status and evidence boundary |
|---|---|---|---|
| Board/list/filter/load more and deal detail | /app/deals → /deals/board, /deals | Deal, Pipeline, PipelineStage | Working browser render; prior real drag tests retained |
| Create/move/required fields/won/lost/reopen | /deals CRUD and move | DealStageHistory, LostReason | Working existing API tests; all UI variants Partial |
| Stage history/time in stage/stale highlight | /deals/:id/history, rotting scan | DealStageHistory, Activity | Working existing tests; remote notification delivery pending |
| Configure/default/reorder/delete stages/pipelines | /app/settings/pipelines → /pipelines | Pipeline, PipelineStage | Working earlier concurrency/removal tests |
| Forecast and workspace currency | /deals/forecast | Deal value/probability/expectedCloseDate | Working existing tests; committed forecast category Missing |
| Move by keyboard and phone | PipelineBoard and move dialogs | Deal | Partial; viewport render passed, full keyboard/drag rerun pending |

## Architecture, data, security and performance

Deal stage type drives status. Won/lost timestamps and reopening affect report revenue by design; this is not historical financial accounting. Existing rules guard the last open stage and concurrent deletes; do not weaken them. Weighted amounts use integer half-even behavior. Business forecasting should not imply multi-currency conversion.

## Product, UX, UI and market findings

PR-015 keyboard/mobile interactions beyond layout pending. WIP/card-density options and commit forecast are candidates, not implemented. No high-severity new pipeline defect reproduced.

Use the existing shared state/loading/error/empty components and permission helpers. Desktop/mobile render observations come from the real local browser run; screenshots alone do not certify contrast, screen readers, keyboard order or touch device behavior. Prioritize the market matrix table stakes over unsupported channel promises. Currency, timestamps, source labels and ownership must match the originating record and active workspace.

## Cross-module consistency and fixes

PR-015 keyboard/mobile interactions beyond layout pending. WIP/card-density options and commit forecast are candidates, not implemented. No high-severity new pipeline defect reproduced.

Master issue statuses are maintained in [gap register](../03-gap-register.md). Avoid independent status claims for a shared defect.

## Evidence and next checks

backend/src/services/{pipeline,deal}.service.js; backend/test/integration/pipeline-completion.test.js; frontend/src/features/deals and pipelines; M09. Current browser/API results: [QA](../QA.md), [evidence](../evidence/). Additional flows marked Partial must still be exercised with role changes, foreign IDs, invalid input, zero-state and mobile interactions before release.
