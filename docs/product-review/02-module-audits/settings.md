# Settings audit

## Purpose and users

Owner/admin configures workspace and team; everyone manages profile, availability, sessions, security and notifications.

## Review discipline and release gate

Apply all six lenses: market expectations; user jobs and complete journeys; data/API architecture; UX states and navigation; component/mobile/accessibility quality; validation/security/QA. “Partial” below includes implementation found but action not executed here. A rendered screen is not proof that every button, edge case, import path or role works. See [QA](../QA.md) for executed boundaries and known failures.

Release requires no open Blocker/High gaps, accurate real data, scoped server actions, clear mobile daily actions, loading/empty/error/confirmation behavior, deterministic tests, and documented migration/rollback.

## Flow map

| User flow | Screens and endpoints | Tables/entities | Status and evidence boundary |
|---|---|---|---|
| Profile/workspace/locale/timezone/brand | /app/settings/profile, workspace → users/org API | User, Organization, File | Working rendered workspace; full save variants Partial |
| Invite/accept/role/deactivate/reassign/teams | /members, /invitations, /teams | Membership, Invitation, TeamMember | Existing regression tests; outbound invitation mail mocked |
| Security/password/session/2FA | account/auth routes, SecuritySettings | User, RefreshToken, RecoveryCode | Existing tests; Google schema/link fixes verified |
| Custom fields/tags/sources/pipelines | CRM/catalogue/config routes | CustomFieldDefinition, Tag, LeadSource, PipelineStage | Working code/API tests; all UI validations Partial |
| Notifications/hours/availability/assignment | notification/capture APIs | NotificationPreference, WorkingHours, OutOfOffice | Live settings boundary fixed; reminder delivery Partial |
| Excel/CSV import and export | /exports, /imports, /imports/template | ImportJob, ExportJob, File | PR-028: four-entity XLSX HTTP lifecycle plus full lead browser import/export with local storage/queue verified |
| Recycle bin/delete workspace | record restore routes, /organizations/current DELETE | Soft-delete records, Organization | Partial; destructive production actions never exercised |
| Plan/billing | /settings/plan live limits; billing ComingSoon | Organization.plan, OrganizationUsage, PlanChange | Partial; self-service paid billing Missing |
| Audit viewer/API keys | No tenant audit-log viewer/developer platform routes found | AuditLog exists | Missing UI/platform capability |

## Architecture, data, security and performance

Owner/admin/manager/rep/viewer are the actual roles, not a generic admin-only switch. Backend reloads membership each request; org caches on the frontend do not replace permission enforcement. Current plan flags promise scheduledReports although that feature is absent; packaging must not sell an unimplemented entitlement. Enterprise auditLogUi is advertised in config but no tenant viewer was found. Organization deletion has existing owner permission and validation; no destructive data change performed here.

## Product, UX, UI and market findings

PR-010 billing requires business/provider decision. PR-016 tenant audit viewer remains absent. PR-018 Google login fixed. PR-017 onboarding now leads to real enquiry/import/pipeline actions. Advanced custom roles/SSO are out-of-scope roadmap capabilities, not delivered.

Use the existing shared state/loading/error/empty components and permission helpers. Desktop/mobile render observations come from the real local browser run; screenshots alone do not certify contrast, screen readers, keyboard order or touch device behavior. Prioritize the market matrix table stakes over unsupported channel promises. Currency, timestamps, source labels and ownership must match the originating record and active workspace.

## Cross-module consistency and fixes

PR-010 billing requires business/provider decision. PR-016 tenant audit viewer remains absent. PR-018 Google login fixed. PR-017 onboarding now leads to real enquiry/import/pipeline actions. Advanced custom roles/SSO are out-of-scope roadmap capabilities, not delivered.

Master issue statuses are maintained in [gap register](../03-gap-register.md). Avoid independent status claims for a shared defect.

## Evidence and next checks

backend/src/{config/permissions,middlewares/org,services/organization.service,routes/organization.routes}.js; frontend/src/app/pages; M04/M05/M06/M21. Current browser/API results: [QA](../QA.md), [evidence](../evidence/). Additional flows marked Partial must still be exercised with role changes, foreign IDs, invalid input, zero-state and mobile interactions before release.

PR-028 Excel completion adds tenant-scoped templates, authenticated binary downloads, typed spreadsheet exports and clearer corrupt-workbook errors. See [Excel guide](../../import-spreadsheet-editor.md) and [QA evidence](../QA.md). External storage, fresh signup, 50k-row UI and the remaining settings paths still need release QA.
