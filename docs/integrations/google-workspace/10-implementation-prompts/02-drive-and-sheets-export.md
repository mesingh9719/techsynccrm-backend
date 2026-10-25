# Implementation prompt — Phase 2: Drive and manual Sheets export

Run only after the owner approves Phase 2 and G12–G18 defaults, Phase 0 is verified, and the narrow Picker-token spike has a reviewable design. Calendar verification need not block development or the independently gated non-sensitive release.

## Context and existing-system review

TechSync is a multi-tenant Indian SME CRM: Express JavaScript/Prisma 7/Postgres/pg-boss and React 19/TypeScript/Tailwind/TanStack Query. Read the Workspace plan documents `01`–`09` and the existing shared connection facade. Preserve Gmail/sign-in routes, user-owned staged changes, S3 Files and CSV/XLSX imports/exports. Use a feature branch and explicit synthetic DB baseline; no production data or real customer files.

Inspect `backend/src/services/{file,transfer,report}.service.js`, `storage/objectStore.js`, `lib/fileSafety.js`, `lib/spreadsheet.js`, visibility/permissions, importCore and jobs; frontend Attachments, DataTools, reports/campaigns and Contact/Company detail pages. Contact/Company currently need an intentional Files section using the shared component; do not assume one is mounted.

## Scope and incremental design

Use **`drive.file` only** for selected/app-created Drive files and Sheets operations. No `drive`, `drive.readonly`, `drive.metadata.readonly`, `spreadsheets` or Gmail/Calendar scope expansion. Enable Drive/Sheets/Picker APIs through an operator checklist, not automatic paid provisioning. Verify same-project App ID/client/key/origin/referrer configuration and a file-only online browser token; never expose the Workspace union access token or any refresh credential.

Implement additive `DriveFileLink`, `DriveSaveOperation`, `SheetExport` and needed sanitized log/selection-session state, with organization-composite references, actor-scoped idempotency and bounded indexes. Keep Drive metadata out of File.storageKey. Backend refetches authoritative metadata/capabilities for selected IDs; clients cannot inject arbitrary URLs/preview HTML. Selection session binds tenant/user/Google subject; Google remains the content access authority.

## API, worker and UI deliverables

1. Picker session + record Drive-link list/attach/unlink endpoints. Require record read/update and attachment permission, current membership/tenant flags. Link by reference only, no sharing/content copy. Preserve local Upload/Preview/Download/Delete/Undo. Add Drive badge, safe metadata, Open in Drive and no-access/stale states to Lead/Contact/Company Files. A teammate's CRM access does not grant Drive content access or use the original employee's token as a proxy.
2. Save-to-Drive endpoint/operation handler copies an existing authorized File to an explicitly selected employee folder. Keep S3 original and existing safety/quota checks. Default opaque folder naming. No public link/shared-drive/ownership transfer in MVP. Attach operation marker and reconcile uncertain create/upload before retry.
3. Sheets export endpoint/history/operation supports authorized lead/contact/company/deal lists plus exact supported report/campaign snapshots. Require existing records.export plus entity read or reports.read as appropriate. Reuse current filters/column projection/report scope; do not bypass manager team visibility or grant reps bulk export. Campaign is not a current transferEntity: implement its bounded, audited visibility-aware projector rather than assuming existing support. Add tenant exports-off enforcement consistently for Google and the approved existing export entry points.
4. New or selected spreadsheet; existing mode defaults to a new app-managed tab. Persist operation/idempotency before creation; prove selected-file authorization and new-file reconciliation after timeout. Do not clear/overwrite user tabs. RAW bounded batch writes, formula-neutralized external text, exact money/identifier handling and header/filter/freeze formatting. Record numeric sheetId and as-of/timezone metadata.
5. Add existing DataTools menu “Export to Google Sheets” with destination/columns/filter confirmation, external-copy notice, progress, Open sheet and safe retry/cancel/error states. Keep CSV/XLSX alternatives. Reuse shared components, scoped query keys and accessible mobile patterns.

## Security, edge cases and tests

Cover two tenants/five roles, manager outside-team scope, removed member/plan/export disable mid-run, unauthorized source File, wrong Google subject/selection session, malicious file URL/resource key, unselected file denied, trashed/moved/permission-revoked file, folder capability failure and Google admin block. No auto-share or remote delete on local unlink/disconnect. No cached private thumbnail leak; icon fallback is acceptable.

Test same/different payload idempotency keys, timeout-after-copy/new-sheet success, changed destination, repeated click/reload, 403 quota vs denial, 429/Retry-After/5xx, byte bounds/large pages, formula injection with whitespace/control prefix, phone/PIN zeros, precision-safe money and empty exports. Queued jobs carry IDs only and recheck current permissions/generation before each chunk/provider action.

Unit + real HTTP/Postgres with mocked Google; browser attach/save/export on three record Files sections and each supported dataset, mobile 390 px, access-denied teammate and Google outage. Full backend regression and frontend tests/build/lint. Separately authorized real test accounts must prove actual Picker `drive.file` selection, server authorization, narrow token, attach/save and Sheets creation without broad scopes. Never claim mocked tests prove Google verification or public storage operation.

Deliver reviewable logical commits, migrations/rollback notes, public/private env placeholder inventory, setup and legal updates matching implemented behavior, observed QA and exact remaining gates. Phase 2's non-sensitive path still requires branding/public policy/Production configuration; no paid quota increase or external sharing is authorized by this prompt. Stop at Phase 2 criteria; do not start live sync automatically.
