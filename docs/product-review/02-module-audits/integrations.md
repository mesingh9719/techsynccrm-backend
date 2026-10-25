# Integrations audit

## Purpose and users

Admin connects capture; employees connect their own Gmail; owner needs reliable health and setup guidance.

## Review discipline and release gate

Apply all six lenses: market expectations; user jobs and complete journeys; data/API architecture; UX states and navigation; component/mobile/accessibility quality; validation/security/QA. “Partial” below includes implementation found but action not executed here. A rendered screen is not proof that every button, edge case, import path or role works. See [QA](../QA.md) for executed boundaries and known failures.

Release requires no open Blocker/High gaps, accurate real data, scoped server actions, clear mobile daily actions, loading/empty/error/confirmation behavior, deterministic tests, and documented migration/rollback.

## Flow map

| User flow | Screens and endpoints | Tables/entities | Status and evidence boundary |
|---|---|---|---|
| Website form create/map/publish/embed/public submit | /forms, /public/forms/:key | WebForm, WebFormSubmission, Lead | Partial end-to-end; live boundary fixed, provider-independent path exists |
| Assignment rules/hours/out of office/test | /assignment-rules, /working-hours, /users/me/out-of-office | AssignmentRule, WorkingHours, OutOfOffice | Working API boundary; existing rule tests; cross-device UI save pending |
| Facebook OAuth/Page/forms/mapping/sync/retry/disconnect | /integrations/facebook, /webhooks/in/facebook | FacebookConnection/Page/Form/LeadDelivery | Partial; local signature/idempotency tests pass; live Meta pending |
| Gmail connect/status/send/sync/reconnect/disconnect | /integrations/gmail, /emails, /webhooks/gmail | GmailAccount, OAuthState, EmailMessage/Thread/SyncState | Partial; extensive inherited mocked-provider tests; actual OAuth/mail pending |
| Google Ads/Instagram DM/generic webhook | Integration cards and guides | No complete corresponding active connector | Missing; guide is not connection |
| Integration health/error and last sync | IntegrationsPage provider status + capture history | provider lastError/lastSyncedAt/deliveries | Partial; not unified across absent connectors |

## Architecture, data, security and performance

Public ingestion must verify signatures/secrets, dedupe delivery IDs and retry durably. Existing Meta worker/recovery provides this architecture; inspect each provider instead of assuming all connectors equivalent. Gmail secrets are encrypted, OAuth state bound and mailbox scope separate from login. No real external provider action was run. Browser capture previews were retired; obsolete local drafts are not automatically migrated into live sources.

## Product, UX, UI and market findings

PR-006 fixed real API persistence boundary. PR-009 missing connectors remain blockers to advertising those channels. PR-022 no universal health/dead-letter view. Live OAuth/webhook delivery needs a sandbox provider account and independent approval for actual messages.

Use the existing shared state/loading/error/empty components and permission helpers. Desktop/mobile render observations come from the real local browser run; screenshots alone do not certify contrast, screen readers, keyboard order or touch device behavior. Prioritize the market matrix table stakes over unsupported channel promises. Currency, timestamps, source labels and ownership must match the originating record and active workspace.

## Cross-module consistency and fixes

PR-006 fixed real API persistence boundary. PR-009 missing connectors remain blockers to advertising those channels. PR-022 no universal health/dead-letter view. Live OAuth/webhook delivery needs a sandbox provider account and independent approval for actual messages.

Master issue statuses are maintained in [gap register](../03-gap-register.md). Avoid independent status claims for a shared defect.

## Evidence and next checks

backend/src/integrations/{facebook,gmail}; backend/src/email-integration; frontend/src/features/{capture,facebook,email,integrations}; docs/gmail-integration. Current browser/API results: [QA](../QA.md), [evidence](../evidence/). Additional flows marked Partial must still be exercised with role changes, foreign IDs, invalid input, zero-state and mobile interactions before release.
