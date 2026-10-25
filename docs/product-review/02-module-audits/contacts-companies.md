# Contacts Companies audit

## Purpose and users

Sales/front desk keeps people and organizations; conversion avoids retyping; admins maintain GST/business fields.

## Review discipline and release gate

Apply all six lenses: market expectations; user jobs and complete journeys; data/API architecture; UX states and navigation; component/mobile/accessibility quality; validation/security/QA. “Partial” below includes implementation found but action not executed here. A rendered screen is not proof that every button, edge case, import path or role works. See [QA](../QA.md) for executed boundaries and known failures.

Release requires no open Blocker/High gaps, accurate real data, scoped server actions, clear mobile daily actions, loading/empty/error/confirmation behavior, deterministic tests, and documented migration/rollback.

## Flow map

| User flow | Screens and endpoints | Tables/entities | Status and evidence boundary |
|---|---|---|---|
| Search/filter/create/edit/list/detail | /app/contacts, /app/companies → CRUD | Contact, Company, phone/email lookups | Working desktop/mobile render and API regressions |
| Lead conversion to linked company and contact | POST /leads/:id/convert | ContactCompany, Lead conversion IDs | Working local API/timeline journey |
| Duplicate detection and merge | POST /contacts/merge, /companies/merge | record links, customFields, tags | Working existing regression subset; all merge UI choices Partial |
| Company contacts and contact company chips | GET /companies/:id/contacts and record presentation | ContactCompany | Working new permission tests; restricted names/counts fixed |
| GSTIN, addresses and custom fields | validators + company service | Company, CustomFieldDefinition | Code reviewed and existing validation tests |
| Import/export/bulk assign/tags/delete/restore | transfer routes and CRM bulk routes | Import/ExportJob, soft-delete records | Partial; existing API tests, full storage/browser run pending |
| Contact/company timeline/files/tasks | /timeline, /files, /tasks | ActivityLink, FileLink, Task | Working shared architecture; module-specific UI writes Partial |

## Architecture, data, security and performance

Company model uses many contacts, and contacts can link many companies. Parent visibility does not authorize every related record: PR-014 fixed contact company chips and company contact counts with tenant and ownership predicates. Service-side link validation remains essential because polymorphic/lookup links are not all composite foreign keys. No patient clinical record model is added.

## Product, UX, UI and market findings

PR-014 fixed and verified. Dedupe deliberately exposes limited matching metadata per existing spec; privacy policy decision should be explicit. Check import/export counters and merge linkage across tasks/files/deals before a broad release claim.

Use the existing shared state/loading/error/empty components and permission helpers. Desktop/mobile render observations come from the real local browser run; screenshots alone do not certify contrast, screen readers, keyboard order or touch device behavior. Prioritize the market matrix table stakes over unsupported channel promises. Currency, timestamps, source labels and ownership must match the originating record and active workspace.

## Cross-module consistency and fixes

PR-014 fixed and verified. Dedupe deliberately exposes limited matching metadata per existing spec; privacy policy decision should be explicit. Check import/export counters and merge linkage across tasks/files/deals before a broad release claim.

Master issue statuses are maintained in [gap register](../03-gap-register.md). Avoid independent status claims for a shared defect.

## Evidence and next checks

backend/src/services/{contact,company}.service.js; backend/src/routes/crm.routes.js; frontend/src/features/{contacts,companies}; M07. Current browser/API results: [QA](../QA.md), [evidence](../evidence/). Additional flows marked Partial must still be exercised with role changes, foreign IDs, invalid input, zero-state and mobile interactions before release.
