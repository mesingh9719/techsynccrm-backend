# Implementation prompt — Phase 0: shared foundation

Executed for the owner's approved Phase 0 on 25 October 2026. See [implementation](../12-phase-0-implementation.md) and [QA](../13-phase-0-qa.md). Keep this prompt as scope/acceptance history; do not run later-phase prompts automatically. External Console setup and a live-account pilot remain pending.

## Context and objective

TechSync CRM serves Indian SME clinics/coaching teams. Active backend is Express JavaScript ES modules, Prisma 7/Postgres on Neon, `pg` and pg-boss; frontend is React 19/TypeScript/Tailwind 4/TanStack Query. Preserve these choices. Build one connection facade/admin experience for Google services, with a legacy Gmail adapter and a new Workspace grant profile. Do not turn Google sign-in into service consent or broaden Gmail send-only scopes.

Read `docs/integrations/google-workspace/{01-current-state,02-google-requirements,04-architecture,05-ux-flows,06-roadmap,07-compliance-and-verification,08-test-and-qa-plan,09-decision-log}.md`. Review actual working-tree changes before coding; Gmail/Templates files may be user-owned and staged. Work on a feature branch and keep unrelated staging/commits untouched.

## Existing-system review and boundaries

Inspect `backend/src/integrations/gmail/{connection,provider,vault,jobs,access,hooks,maintenance}.js`, `src/email-integration/*`, scope constants, both Gmail callback routes, Google sign-in service, Prisma Gmail/consent/audit/revocation models, org/permissions middleware, queue/schedules/worker and frontend email/team/settings. Establish focused and full test baseline. Confirm approved Cloud project profile boundaries without exposing credentials. Existing EmailAccount is logically GmailAccount; do not create a duplicate email subsystem.

## Implement incrementally

1. Add parameterized connection/provider/crypto interfaces and a read-compatible Gmail adapter. Legacy credential envelope/AAD and callbacks remain unchanged. New Workspace grants get new envelope context/version; no copying encrypted strings to different IDs.
2. Design additive `GoogleConnection`, `GoogleServiceConsent`, `GoogleOAuthState`, tenant Workspace settings, sanitized sync logs and safe durable revocation records as specified in architecture. Tenant-composite FKs/unique identities, due-state indexes, generation/refresh leases; revocation must not be lost on tenant deletion. Use local/synthetic/schema-only migration validation; do not run production migration.
3. Implement `/api/google/connections/me`, OAuth start/callback, per-service local toggles/detach, explicit project-grant revoke, admin connection/log/settings routes. Keep old `/api/email/*` and Gmail response contracts. Start accepts an allowlisted feature and exact approved scope profile, never arbitrary caller scopes. Default new flags off.
4. OAuth uses original live CRM session, state/browser binding, PKCE, nonce, subject/client/audience checks, partial grants, feature consent version and safe return routes. A same-grant reconnect may retain an existing refresh token if Google omits one; a new grant requires offline credentials. Add the regression that current Gmail code/docs disagree about.
5. Preserve encrypted secret storage, redact codes/state/tokens/cell/event content from logs and DTOs. Refresh is serialized with a generation fence. Reuse member disable/deletion hooks. Service off is local; project revoke warns about all affected services and safely marks known bindings without leaking another tenant's identity. Separate client IDs in one project are not revoke isolation.
6. Reuse Settings/Integrations and Team & Email components for per-service status and owner/admin metadata, with meaningful disabled/reconnect/partial/error states, mobile flow and focus restoration. No employee private content in admin views.

## Scope, security and edge cases

Only the approved Phase 0 facade/OAuth/admin foundation. No Calendar event operations, Drive/Sheets content writes, new Gmail read scope, paid infrastructure or Redis. New auth actions compose with requireOrg, current membership/role/plan, tenant switches and user consent. Google login stays identity-only. Test wrong subject/client, expired/replayed state, revoked session, role/tenant switch during consent, cancelled/partial permission, missing refresh token, concurrent refresh/disconnect, unavailable keyring/KMS and cross-workspace revoke behavior.

## Tests and deliverables

Use Vitest with mocked Google/KMS; disposable explicit `TEST_DATABASE_URL`; frontend behavior/build and Playwright settings/admin flows. Preserve all existing Gmail/email/sign-in tests. Verify no secrets in API/audit/queue events and no provider call after membership/generation changes. Add migrations/rollback notes, API contracts, flags/env placeholders with no secret values, operator project/key inventory checklist and dated QA evidence. Do not change public privacy behavior descriptions ahead of implementation; prepare reviewable legal updates consistent with actual features. Report exact checks, remaining live-account requirements and risks. Deliver in small logical commits, with a reviewable diff and no production/provider actions without their separate authorization. Stop at Phase 0 acceptance criteria; do not run the next phase automatically.
