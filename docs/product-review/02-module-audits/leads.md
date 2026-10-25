# Leads audit

## Purpose and users

Front desk/sales rep handles each enquiry; managers assign and monitor; owners oversee conversion.

## Review discipline and release gate

Apply all six lenses: market expectations; user jobs and complete journeys; data/API architecture; UX states and navigation; component/mobile/accessibility quality; validation/security/QA. “Partial” below includes implementation found but action not executed here. A rendered screen is not proof that every button, edge case, import path or role works. See [QA](../QA.md) for executed boundaries and known failures.

Release requires no open Blocker/High gaps, accurate real data, scoped server actions, clear mobile daily actions, loading/empty/error/confirmation behavior, deterministic tests, and documented migration/rollback.

## Flow map

| User flow | Screens and endpoints | Tables/entities | Status and evidence boundary |
|---|---|---|---|
| List/search/filter/sort/saved views/columns | /app/leads → GET /leads, /saved-views, /tags, /custom-fields | Lead, SavedView, RecordTag | Working list render; all combinations Partial |
| Create and duplicate warning | LeadFormDrawer → POST /leads, /check-duplicates | Lead, LeadEmail, LeadPhone | Working API and existing regression suite |
| Bulk assign/status/tag/delete + recycle/restore | POST /leads/bulk; DELETE /leads/:id; POST restore | Lead, DomainEvent, AuditLog | Code reviewed; API suite covers selected paths |
| Import map/validate/preview/start/undo; export | /app/import → /imports; /exports | ImportJob, ImportRecord, ExportJob, File | Partial; existing DB tests pass, storage browser path pending |
| Detail profile/requirements/qualification/next best step | GET/PATCH /leads/:id, If-Match | Lead.qualification, customFields | Working detail render; guided redesign retained |
| Call/WhatsApp, note, follow-up and timeline | /activities; /tasks; /timeline; deep links | Activity, ActivityLink, Task | Working local API writes/timeline; provider handoff pending |
| Status/lost/junk/reopen/claim | POST status/claim/assign | Lead, LostReason, DomainEvent | Code reviewed + existing tests |
| Convert contact/company/deal atomically | POST /leads/:id/convert | Contact, Company, Deal, Lead | Working local API; UI conversion variants Partial |
| Gmail compose and reply timeline | /emails, /integrations/gmail | EmailMessage, EmailThread | Inherited tests; real Gmail pending |
| Lead merge | No /leads/merge route found | Lead duplicate capture merge exists | Missing manual lead merge; avoid confusing capture dedupe with user merge |

## Architecture, data, security and performance

Lead status is distinct from pipeline deal stage. Phone raw/E.164, original UTM versus latest source, lost and junk reasons, conversion references and soft deletion are substantive existing strengths. Scoring breakdown and source defaults are shared. Source “none” filtering now matches report drilldowns; junk exclusion is explicit in report links. Legacy UI may still show restricted duplicate names by deliberate M07 policy; not silently changed.

## Product, UX, UI and market findings

PR-005 source none/owner/excluding-junk drilldowns fixed. PR-019 manual lead merge missing; confirm merge semantics and implementation still required. Assignment by source/round-robin exists; broad automation remains a different module. Speed-to-lead alert scan code exists; delivery not proven against external services.

Use the existing shared state/loading/error/empty components and permission helpers. Desktop/mobile render observations come from the real local browser run; screenshots alone do not certify contrast, screen readers, keyboard order or touch device behavior. Prioritize the market matrix table stakes over unsupported channel promises. Currency, timestamps, source labels and ownership must match the originating record and active workspace.

## Cross-module consistency and fixes

PR-005 source none/owner/excluding-junk drilldowns fixed. PR-019 manual lead merge missing; confirm merge semantics and implementation still required. Assignment by source/round-robin exists; broad automation remains a different module. Speed-to-lead alert scan code exists; delivery not proven against external services.

Master issue statuses are maintained in [gap register](../03-gap-register.md). Avoid independent status claims for a shared defect.

## Evidence and next checks

backend/src/{routes/lead.routes,services/lead.service,validators/lead.validators}.js; frontend/src/features/leads; backend/test/integration/{product,leadQualification,campaign-completion}.test.js. Current browser/API results: [QA](../QA.md), [evidence](../evidence/). Additional flows marked Partial must still be exercised with role changes, foreign IDs, invalid input, zero-state and mobile interactions before release.
