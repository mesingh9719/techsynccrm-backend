# Test and release QA plan

Proposed coverage, 25 October 2026. Nothing in this file is a claim that new Google Workspace features have passed. The 450-test backend baseline and preceding Excel browser run are historical evidence only. Do not run existing `.env` application databases as test targets.

## Environments and fixtures

Use local disposable PostgreSQL or an explicitly isolated synthetic/schema-only Neon branch with existing Prisma migrations. Keep `TEST_DATABASE_URL`/direct migration targets explicit. Provider/KMS/clock mocks are default in CI; deny accidental outbound Google/storage/mail traffic. Reuse Vitest real-HTTP tests, current staged Gmail fixtures carefully, frontend Node behavioral tests and existing Playwright scripts. Avoid screenshot-only assertions: verify UI → authenticated API → persisted state → worker → provider call/result → visible state.

Create two tenants; owner/admin/manager/rep/viewer; managed and unmanaged reps; one user legitimately in both tenants; same Google identity across workspace bindings; a removed/suspended member; disabled tenant flags; wrong plan; all-day/timed/recurring tasks; linked/unrelated records and files; old/new grants with partial scopes; one selected spreadsheet with multiple tabs and external edits. Synthetic emails only. Provider fake records requests without exposing credentials and can return timeout-after-commit or delayed/reordered callbacks.

## Unit and contract checks

| Boundary | Cases / pass criterion |
|---|---|
| Scope profiles | First-use requests exact minimal delta; arbitrary client-requested scopes rejected; historical union scopes do not enable a service; sign-in stays identity-only; Gmail send-only stays send-only. |
| OAuth | Missing/expired/replayed state; wrong browser/session/tenant; session revoked mid-flow; nonce/audience/subject mismatch; partial grant; consent cancelled; wrong account; old token retained only for same subject/client/grant; new grant without offline token fails clearly. |
| Encryption | Wrong tenant/account/purpose/version/AAD fails; key rotation reads old and writes new version; unavailable KMS fails closed; no plaintext or secrets in DTOs/logs/events/jobs. |
| Refresh and leases | Concurrent workers refresh once; expired lease recovery; token rotation; generation change mid-refresh; invalid_grant/admin block; disconnect prevents late writeback. |
| Time | IST/UTC; Asia/Kolkata midnight; America/New_York spring gap and autumn ambiguous time; Europe/London DST; browser zone differs; user/workspace timezone changes; event end after start; all-day exclusive end and original workspace date retained. |
| Task semantics | Ordinary deadlines not auto-exported; schedule explicitly sets start/duration; existing reminder rules preserved; one CRM recurrence occurrence → one provider event, not an RRULE plus duplicated occurrence. |
| Projection | Only allowlisted fields; private/clinical text omitted by default; valid deterministic provider event IDs; stable Meet request IDs; reserved key/formula/HTML/URL/header injection blocked. |
| Sheets transforms | Existing INR/lakh/crore and exact-minor logic, Excel/ISO/DMY choices, E.164 phone warnings, leading zeros, custom fields, archived/unknown fields; RAW text and formula neutralization with leading controls. |
| Row identity | Insert/sort/move/delete, duplicate/blank source keys, renamed sheet/numeric sheetId, duplicate managed keys, schema/header changes, customer key edits. Never infer identity solely from row number/hash. |
| Provider contracts | Correct method-required scopes; `drive.file` selected-file access; no use of privateExtendedProperty/time windows with syncToken; if-match etags; exact request/response schemas. |

## Real HTTP/database integration and crash tests

1. **Tenant/role matrix:** every new endpoint/service/worker case exercises tenant A ID under B session; wrong member/owner; manager team vs outside team; removed membership after enqueue; viewer direct requests; export/import denial for reps; tenant exports/service off. Admin metadata must not reveal private content or other tenant bindings. Confirm valid same-tenant operations still succeed.
2. **OAuth compatibility:** both existing Gmail callbacks and foundation routes keep response shape and settings behavior. Shared adapter does not re-encrypt/copy legacy ciphertext accidentally. Concurrent reconnect/disconnect/revoke/departure uses fences and produces sanitized audits.
3. **Project revoke:** local service disable touches no provider revoke; local detach erases only current binding; actual project revoke invalidates/marks all known affected bindings safely and shows no other-tenant identities. Separate-project Gmail remains usable in mocked/sandbox verification. Pending revocation survives operational account/tenant deletion and is erased by its retention cap.
4. **Calendar one-way:** commit task and outbox atomically; queue unavailable then due-scan recovery; two workers claim one operation; provider accepts but response is lost; deterministic create retry finds the same event; Meet pending resolves without duplicate conference; no invitation unless explicitly approved.
5. **Lifecycle:** change task time/type/assignee, complete/cancel/delete/restore, delete/convert linked lead, change ownership/record visibility and disabled plan. Verify unrelated events/files are never changed and cancellation/recreation policies remain visible. Conversion must preserve permitted links using existing hooks, not duplicate scheduling.
6. **Watch:** forged/unknown/expired token, wrong resource/channel, bad body/oversized headers, replay/non-sequential and out-of-order message numbers, early sync before watch response, renewal overlap, stop failure, lost push, worker crash and polling catch-up. Persist authenticated due state before 204; failed durable persistence must not acknowledge success as completed work.
7. **Incremental read:** paginated initial/delta results; only final-page sync token committed; failure between pages resumes; 410 resets selected sync state without deleting tasks/mappings; primary mode reads only linked event IDs. Deleted event tombstones do not become new creates on recovery.
8. **Conflicts:** same-field and independent-field edits, provider 412, organizer/ACL changes, declined attendees and changed Meet capability. No automatic last-clock-wins or RSVP-driven task completion.
9. **Drive:** malicious client metadata/URL/file ID, unsupported mime, trashed file, permission revoked, moved file, shared-drive file unsupported for MVP, source File not visible, uploaded file with existing sniff failure. Local unlink does not delete external content. Save timeout reconciles operation marker before retry; both source access and folder capability are rechecked.
10. **Sheets export:** filter/column custom-field scoping, team-only manager export, one actor idempotency key with same/different payload, new-file response loss, selected file with existing user tabs/formulas, exact money/phone text, large byte-limited batches and partial completed operations. Never clear unrelated ranges.
11. **Continuous sync:** two writers rejected for the same managed destination; outbox replay/coalescing; row reorder recovery; source stable keys + immutable snapshot + existing import transaction/dedupe/plan limits; role revocation mid-chunk; failed row corrected next poll; duplicate run; key copied/changed requires review; deleting source rows never deletes leads. Never promise globally exactly-once intake after arbitrary manual identity changes.
12. **Schedules:** daily/weekly local-time period IDs, DST, restart, skipped/missed runs, duplicate enqueue, removed owner/downgrade, changed report visibility/filters. Any schedule retry uses current authorization and the same delivery-period operation.
13. **Failure budget:** 401 refresh then invalid_grant; 403 permission vs quota/admin block; 404 destination; 409 existing event; 410 delta; 412 conflict; 429 Retry-After; 5xx; slow/unavailable network. Backoff/jitter caps and user/project quota fairness; exhausted/uncertain jobs require reconciliation or explicit retry, not blind replay.
14. **Migration:** additive apply on empty and populated synthetic DB; tenant composite FKs reject cross-org references; uniqueness/active-writer rules hold under races; valid new/online indexes; rollback/replay documented and non-destructive. Audit cleanup/tenant-delete and revocation references tested together.

## Browser journeys and manual Google-account QA

CI browser flows use mocked Google but real local API/Postgres/queue. Separately, after authorization, operate **controlled test accounts** and synthetic data for true Google behavior; fixture tests cannot prove consent scope, Picker authorization, public push routing, Google invitations or Meet capability.

- [ ] Existing Gmail settings/composer, send-only consent, admin panel and Google sign-in work before/after foundation extraction.
- [ ] Settings/Integrations entry points agree; popup blocked/same-tab mobile fallback, denied/partial consent, account switch, reconnect after 7-day Testing expiry and admin-blocked access all produce truthful states.
- [ ] Schedule, change and cancel a test appointment from a lead and Tasks; verify exactly one provider event, correct local/Google times, all-day date, approved invitation behavior and optional Meet. Keep normal follow-up creation usable while Google is offline.
- [ ] Test reminder ownership on staff accounts without claiming control of invitee alerts; verify Today/date-boundary behavior in two browser timezones.
- [ ] Change/cancel linked event in Google; confirm CRM timeline/conflict behavior and that unrelated events are absent. Receive real HTTPS push, renew a channel and deliberately miss one notification to prove polling recovery.
- [ ] Picker uses exact requested scope and account, selected file becomes accessible with server grant, unselected file is denied, restricted browser key works with documented iframe referrers and narrow token is absent from logs/storage. Refuse broad-token fallback.
- [ ] Attach on Lead/Contact/Company, view as a teammate with/without Drive permission, move/delete/revoke file externally and unlink locally. Save local/generated file and verify original remains; repeat button/reload/network-failure retry creates one external copy.
- [ ] Export each supported list/report/campaign dataset with columns/filters; verify manager team boundary, no overwrite of existing tabs, safe formula text and accurate amounts/date/as-of metadata. CSV/Excel continue functioning.
- [ ] Run inbound/outbound managed-sheet flows with real sort/insert/rename/key duplication, failed row and reconnect. Verify the displayed polling delay and pause/retention settings, not a “real-time” claim.
- [ ] Remove member or disable feature while operations are queued. New owner connects independently; provider ownership is not silently transferred. Test local vs project-wide removal explicitly on synthetic grants.
- [ ] Mobile 390 px plus tablet/desktop, keyboard-only mapping/dialogs, screen reader announcements, focus return, contrast, dark mode, touch targets and no document overflow. Physical-device Picker/popup behavior is a distinct check.
- [ ] Consent screen/app name/domain, all public legal/contact links, demo video, monitored support and Google-admin setup instructions are current. Record Calendar scope classifications and effective quotas from Console.

## Load, monitoring and release evidence

Use 5/50-user synthetic workspaces, 1k/5k live pilot rows and 50k maximum intake snapshots. Measure application DB reads, queue age, operation lag, API calls/quota units, payload bytes, memory and checkpoints; do not run load tests against Google. Simulate shared project limits in the provider fake, then a small real-account smoke test. Record assumptions for polling frequency and number of active links before widening limits.

Run backend focused tests then full suite, frontend behavioral tests/TypeScript/build/lint, full browser flows and staged release smoke. Test counts, versions, environment, remaining limitations and screenshots belong in per-phase evidence. “Done” requires code, migrations/rollback notes, API contracts, operator setup, user-facing error handling and passing [roadmap](06-roadmap.md) criteria—not merely a new button or a successful mocked API response. Capture zero raw tokens/customer payloads in published evidence.
