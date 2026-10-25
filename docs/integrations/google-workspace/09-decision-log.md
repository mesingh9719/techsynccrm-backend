# Decision log for owner approval

25 October 2026. **Phase 0 implementation was approved by “proceed implementation” and “continue”; its code and local QA are recorded in [the implementation record](12-phase-0-implementation.md).** The shared facade, per-user Workspace profile, separate-project requirement and local/project revocation boundary were implemented for Phase 0. Exact Cloud project inventory and all external setup remain pending. Other product defaults below remain proposals for their later phases; this record does not authorize provisioning or operating Google accounts.

## First approval set

| ID | Options | Recommended default | Consequence / input needed |
|---|---|---|---|
| G01 | Per-user OAuth / DWD / hybrid | **Per-user OAuth** for all core features; DWD Phase 4 only with enterprise sponsor | Works with consumer Gmail and SME domains; each employee consents. DWD adds super-admin onboarding and security scope. |
| G02 | One merged token/table / separate bespoke stacks / shared facade with profiles | **Shared facade + Gmail compatibility adapter + new Workspace profile** | Reuses security without risking a Gmail rewrite; GmailAccount remains the existing logical EmailAccount. One UI can show multiple physical grants. |
| G03 | Same OAuth project / distinct client IDs only / separate projects | **Separate Workspace project boundary**, preserve existing Gmail/login projects until inventoried | Distinct client IDs alone do not isolate project-wide revoke. More operator setup, but no automatic Gmail reconnection or accidental restricted-scope union. Confirm existing inventory before choosing exact project IDs. |
| G04 | Service off revokes provider / local off and explicit full revoke | **Local off/detach; explicit project-grant removal separately** | Google cannot promise per-service revocation within a combined grant. Preserve legitimate other bindings; label the action accurately. Last-binding departure can queue revoke. |
| G05 | Deny same identity across tenants / allow with revoke coordination | **For new Workspace grants, allow per-user legitimate bindings, tenant-isolated credentials and guarded revoke coordination** | Actual provider revoke can affect all matching project grants. Do not disclose other tenant metadata. More tests/cleanup logic than a global single-workspace prohibition. Existing Gmail mailbox-identity restrictions remain unchanged in Phase 0. |
| G06 | Primary calendar / dedicated calendar / user choice upfront | **Dedicated TechSync calendar first** | Narrower method access and clearer privacy; appears alongside personal calendar. Existing owned-primary mode later with explicit additional scope and linked-ID reconciliation. |
| G07 | Declare narrow Calendar NS from assumption / confirm Console classifications | **Confirm exact Data Access categories; conservatively gate public launch as sensitive** | Official public Calendar guide lacks a per-scope class table. Operator evidence can remove an unnecessary review gate; do not assert unverified classifications. Broad Drive R scopes are excluded. |
| G08 | Export all due tasks / schedule only explicit appointments | **Explicit schedule with start/end/timezone**; for scheduled meetings dueAt means start | Avoids converting deadlines/end-of-day dates into meetings. Normal tasks remain unchanged; duration/guest/reminder policy needs product approval. |
| G09 | Meetings and guests on by default / opt-in | **No guest or Meet by default; each explicitly selected** | Avoids unexpected external invitations. Meet support is a bounded Phase 1B option and depends on Google account/calendar capability. Confirm whether pilot customers need it. |
| G10 | CRM reminders / Calendar reminders / both | **CRM owns staff reminders**, per-item switch to Calendar; never both by default | Preserves current follow-ups. Google invitees may still have independent alerts. |
| G11 | Last-write-wins / field ownership + visible conflicts | **CRM binding/guests authoritative; linked Google time/location/cancellation accepted in two-way mode; conflicting same-field edits need resolution** | More careful state mapping; protects customer changes from silent overwrite. External cancellation cancels the scheduled Task, never the lead. |
| G12 | Link / automatic copy / migrate existing S3 | **Drive link by default; explicit Save to Drive copy; keep S3 original** | Minimal scope/storage impact and no migration. Teammates still need Google access; no automatic sharing or ownership transfer. |
| G13 | Employee folders / tenant shared folder / shared drive | **Employee-owned selected folders, neutral/opaque names** | Simpler initial grant/ownership; departure can orphan access. Shared-drive/tenant ownership deferred until funded and tested. |
| G14 | Public link sharing / explicit recipient sharing / none | **None in core; recipient-specific sharing optional Phase 4** | Avoids accidental disclosure, especially clinic/student documents. Any future share must be explicit and capability-checked. |
| G15 | One general two-way sheet / separate inbound and outbound tabs | **Directional sync, separate managed tabs** | CRM owns outbound columns; source sheet owns allowlisted inbound intake fields. No general cell conflict engine. |
| G16 | Row number/hash / immutable key / Apps Script trigger | **Stable source key**, reviewed setup may add one with permission; 15-minute polling first | Reorders safe; manual key changes need review. Polling costs quota but avoids script installation/secret distribution. Apps Script later only on demonstrated need. |
| G17 | Only admins / managers too / all reps live sync | **Owner/admin inbound** (existing import permission); managers outbound team scope only; reps no bulk exports | Maintains current permission model. Manager-owned recurring exports recheck current scope. Tenant-level export-off applies to Google and should be consistently extended to CSV/XLSX in future implementation. |
| G18 | All features all plans / basic all, automation Growth+ | **Pilot basic scheduling/links/manual export broadly; consider Growth+ automation** | Pricing is not changed by this plan. Confirm plan gates, sync count/row limits and paid support expectations before sale. |
| G19 | Build report scheduler now / depend on M15 / defer scheduled reports | **Small bounded Sheets schedule in Phase 3C or explicit approved M15 dependency** | Current M15 scheduling is incomplete. Avoid describing it as reusable production capability. Decide before 3C. |
| G20 | Redis/BullMQ / existing pg-boss | **Keep pg-boss/Postgres** | No new Redis cost/ops. Consider Redis only after measured limits and a separate paid-infrastructure approval. Actual deployed process manager/capacity remains an operator input. |
| G21 | Retain full provider payloads / minimal data with expiry | **Logs 30d; failed snapshots 7d; minimal audit 180d; state 10m; revocation payload max30d** | Proposed periods need business/legal approval and must fit existing tenant commitments. No unrelated Calendar/Drive content cache; no automatic Google file deletion. |
| G22 | Promote clinical/student document automation / logistics only | **Logistics/minimal event text; no prescriptions/clinical automation in core** | Reduces disclosure risk; confirm legal roles/contracts before handling specialized health/minor workflows or making compliance claims. |
| G23 | Full advanced bundle / demand-led selection | **Defer booking/team view/RRULE/DWD/sharing** | Keeps first delivery useful. Each advanced bundle needs its own scope, quota, privacy and acceptance design. |

## Operator evidence required before launch, not before planning

- Cloud project/client inventory, classification screenshots for the exact Calendar candidates, publishing/verification state and effective quota/billing cohort. No secrets should be pasted into planning docs.
- Confirm actual API/worker hosting, process manager, HTTPS/proxy/header behavior, callback public routing, key management owner, support/privacy contact and canonical homepage/legal URLs.
- Identify consenting controlled test Google accounts/workspaces and authorize any later real test invitations/file writes explicitly. This planning task gives no such authorization.
- Confirm pilot appointment duration, personal vs shared Google ownership, Meet priority, acceptable polling delay, clinical/student data boundaries and commercial entitlements.

## Top five risks and mitigations

1. **Scope/review uncertainty:** prevent broad scopes, record Console evidence and decouple non-sensitive Drive/Sheets from Calendar/Gmail release gates.
2. **Credential/revoke blast radius:** preserve legacy Gmail adapter, isolate projects where practical, separate local disable from full provider revoke and fence all workers.
3. **Sync duplication/conflicts:** deterministic events/operations, stable row keys, field ownership, tombstones and reconciliation before retry; do not equate an at-least-once queue with exactly-once provider effects.
4. **Data sharing/departure:** external copies outlive CRM permissions, per-user Drive ownership persists and organizer rules limit transfers; show notices, pause work on membership loss and require new-owner authorization.
5. **Delivery/operations cost:** a functioning independent worker/HTTPS route and current quota/billing controls are required; stage releases and fund only the chosen advanced features. Assessor/time estimates are not quotes or guarantees.

## Approval boundary

Suggested first approval is **Phase 0 only**, accepting G01–G05/G20 architectural defaults while confirming Cloud inventory. The Calendar/Drive/Sheets prompts remain gated by their dependencies and additional decisions. Alternatively approve 0+1B with G06–G11 as stated. Approval of planning documents is not permission to create paid infrastructure, run production migrations, share clinical records or send invitations to real leads.
