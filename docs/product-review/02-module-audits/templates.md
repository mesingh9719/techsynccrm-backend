# Templates audit

## Purpose and users

Salespeople reuse personal wording; admins maintain shared messaging; clinic/coaching owners need useful starters.

## Review discipline and release gate

Apply all six lenses: market expectations; user jobs and complete journeys; data/API architecture; UX states and navigation; component/mobile/accessibility quality; validation/security/QA. “Partial” below includes implementation found but action not executed here. A rendered screen is not proof that every button, edge case, import path or role works. See [QA](../QA.md) for executed boundaries and known failures.

Release requires no open Blocker/High gaps, accurate real data, scoped server actions, clear mobile daily actions, loading/empty/error/confirmation behavior, deterministic tests, and documented migration/rollback.

## Flow map

| User flow | Screens and endpoints | Tables/entities | Status and evidence boundary |
|---|---|---|---|
| List/search/filter channel/category/personal/shared/archive | /app/templates → /templates | EmailTemplate | Working real API list/render; inherited implementation |
| Create/edit/duplicate/archive/restore | /templates POST/PATCH | EmailTemplate, AuditLog | Working inherited integration tests; optional inherited editor browser checks pass (mixed shell fixture / real template API) |
| Variables/required inputs/CRM fields/fallback/preview | /templates/render and rendering service | custom field definitions, record context | Working inherited validation/render tests; retained user edits |
| Use from lead/contact communication | PrepareMessageDialog/EmailComposer | EmailMessage or manual log | Partial; provider send excluded |
| Clinic/coaching starter gallery | content.ts starters → editor → save | User chooses saved template | Code reviewed; no database demo records inserted |
| Versioning and WhatsApp approval | updatedAt concurrency/archive; no external approval lifecycle | Template/provider | Partial; safe editing present, provider approval Missing |

## Architecture, data, security and performance

Inherited uncommitted library/variable changes are not authored by this review. Their migrations were applied only on the local test databases. Supported runtime channels are email/whatsapp/sms; call script/note is not the same supported channel. Preparing a WhatsApp text does not mean an approved Business API template was sent. Unknown/missing variables should fail or use explicitly configured fallback, never silently invent contact details.

## Product, UX, UI and market findings

PR-011 release dependency: inherited migrations and code need their own commit/review. Generic version history and WhatsApp approval are not implemented. Dates in library cards use browser locale/timezone rather than workspace (PR-021).

Use the existing shared state/loading/error/empty components and permission helpers. Desktop/mobile render observations come from the real local browser run; screenshots alone do not certify contrast, screen readers, keyboard order or touch device behavior. Prioritize the market matrix table stakes over unsupported channel promises. Currency, timestamps, source labels and ownership must match the originating record and active workspace.

## Cross-module consistency and fixes

PR-011 release dependency: inherited migrations and code need their own commit/review. Generic version history and WhatsApp approval are not implemented. Dates in library cards use browser locale/timezone rather than workspace (PR-021).

Master issue statuses are maintained in [gap register](../03-gap-register.md). Avoid independent status claims for a shared defect.

## Evidence and next checks

frontend/src/features/templates; backend/src/services/{template,templateRendering}.service.js; backend/test/integration/templates.test.js; docs/template-variables.md. Current browser/API results: [QA](../QA.md), [evidence](../evidence/). Additional flows marked Partial must still be exercised with role changes, foreign IDs, invalid input, zero-state and mobile interactions before release.
