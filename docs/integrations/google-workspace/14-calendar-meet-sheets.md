# Calendar, Google Meet and Google Sheets

Implemented 25 October 2026 following the owner's request to use these tools from the sidebar and leads. This extends the Phase 0 connection foundation. Reuse the same Google account, Cloud project and existing web OAuth client. No Google Console settings or real Google resources were changed during implementation.

## User flows

**Calendar & Meet** in the sidebar opens a month calendar and meeting agenda. Set up the dedicated **TechSync CRM** secondary calendar once per connected account/workspace. Create, reschedule or cancel a meeting; optionally select a readable lead and request a Google Meet conference. Meetings create CRM Tasks atomically, assigned to their creator, with a 15-minute CRM reminder. Times are entered and displayed in the device's time zone and stored as absolute instants plus the IANA zone. Guest addresses start empty. Google invitations require the user's explicit guest list and confirmation. Confirmed guest changes/cancellation send Google updates.

**Google Sheets** in the sidebar lists the current member's app-created spreadsheets. Create a blank spreadsheet, edit the **CRM Data** tab in the CRM, save changed cells or open Google Sheets. The editor supports columns A–J and rows 1–5001, 50 rows per page, with up to 200 changed cells per save. It preserves other tabs and existing formulas in unedited cells. New values are written with `RAW`, so formula-like text, phone numbers and identifiers remain text. The editor shows formulas rather than calculating them locally. Refresh, paging and navigation protect unsaved edits.

**Leads** have a Calendar, Meet & Sheets panel with Schedule, Google Meet, Notes sheet and (where permitted) Export lead. It also shows the current member's lead-linked meetings and spreadsheets. The lead list's Import/export menu includes **Export current view to Google Sheets**, preserving its filters. Export-capable roles choose from ten supported fields; each export is an explicit snapshot of up to 5,000 readable/exportable leads. Google Sheets edits never update CRM leads. Managers' exports use the existing team export scope, excluding unrelated/unassigned leads. Tenant Google exports must be enabled separately; creating a blank notes sheet does not require export permission.

## Google API contract

- Calendar scheduling uses `calendar.app.created`. The app stores its created calendar ID and only reconciles its marked event IDs. It does not list the primary calendar or import unrelated events. Scheduled Meet links use Calendar `events.insert` with `conferenceDataVersion=1`, `hangoutsMeet`, and a stable conference request ID. Enabling Meet REST API is harmless but is not sufficient: this flow requires **Google Calendar API**. No Meet recordings/transcripts or separate Meet-space scope is requested. [Google event insertion](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [Calendar creation](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert).
- Sheets uses the existing `drive.file` permission. **Google Drive API** creates/reconciles a spreadsheet file with an operation marker; **Google Sheets API** manages the dedicated tab and values. Both APIs must be enabled even if the separate Drive feature preference is off. No browser API key or Picker is required. [Drive file creation](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create), [Sheets scopes](https://developers.google.com/workspace/sheets/api/scopes).
- Service consent is versioned as `2026-10-25-workspace-tools-v2`. Members with older preferences review and enable Calendar/Sheets again in Google connections. The underlying scopes remain narrow; existing Gmail/sign-in callbacks are preserved.

## Durability and authorization

Additive migration `20261025180000_google_calendar_sheets` creates tenant-bound calendar links, meeting operations and spreadsheet operations. Composite foreign keys prevent cross-tenant relationships. Database constraints enforce state, time, revision and row bounds. Credentials remain solely in the existing encrypted connection store; browser DTOs contain no tokens, Google subject, wrapped keys or provider payloads.

The API creates operations, then queues IDs only. The worker runs `google.calendar.sync`, `google.sheets.create` and minute-based `google.content.maintain` recovery. It rechecks active membership, scope, tenant settings, service consent, connection generation and source-record visibility before provider requests. A reconnect pauses old-generation work until explicit retry. Another Google subject/project cannot take over earlier resources. Each member uses their own credential; workspace admins cannot edit a teammate's private Google content through this API.

Meetings use deterministic Google event IDs and conference request IDs. Workers use renewable database leases; edits/cancellation are fenced while sync is active. Google event patches/deletion verify the operation marker and use `If-Match`. Detected external edits or deletion become conflicts instead of silently overwriting or recreating an event. Linked Task title/time changes are reconciled; cancelling, deleting or reassigning a Task cancels its Google event. Task completion preserves meeting history. This is CRM-to-Google scheduling, not full two-way calendar synchronization.

If Calendar creation has an uncertain outcome, no automatic second calendar is created. Find the **TechSync CRM** calendar's ID in Google Calendar settings and use **Recover a calendar**. Recovery verifies the workspace-specific calendar marker.

Spreadsheet jobs reconcile the Drive operation marker after an uncertain insertion. If no result can be found, the operation remains **unknown**; retries check for the existing file instead of creating another. Tab insertion uses a stable numeric tab ID and reconciles lost responses. Export retries clear only the pending export's managed tab before writing a fresh snapshot, so shrinking source results cannot leave stale trailing rows. Other tabs are untouched. Only ready spreadsheets are editable in the CRM.

Cell saves compare the previously viewed values with Google's current cells before writing changed cells. This rejects already-visible concurrent edits, and a lease serializes saves made through the CRM. Google Sheets values writes have no atomic compare-and-swap with external editors, so simultaneous edits in Google's own UI can still race between comparison and write. Use Google Sheets itself for collaborative editing requiring Google's live coauthoring behavior. Retrying after an uncertain cell-write response may produce a conflict; refresh to inspect the actual saved values.

Turning a service off stops future access. Disconnect erases the workspace credential according to the shared-project rules; it does not delete Google calendars, invitations or files. Soft-deleted leads are hidden and their meetings are cancelled when permitted by the connection. At the lead's final purge boundary, local meeting/sheet links are erased. External files remain copies controlled by their Google owner. An integration cannot guarantee external deletion after its credential or permission has been removed.

## Run and verify

1. Follow [Console setup](11-google-cloud-console-setup.md), including Calendar, Drive and Sheets API enablement in the existing project.
2. Apply both foundation and content migrations using the normal reviewed migration process: `npm run db:migrate`, then `npm run db:generate`. Restart API **and worker**. This implementation applied migrations only to disposable local test databases.
3. Enable the global Calendar/Sheets flags and tenant preferences. Enable Google exports only for workspaces that should copy lead data.
4. Members review Calendar/Sheets preferences in Google connections, then use the new sidebar pages and lead panel.
5. Perform a designated real-account pilot: secondary calendar setup, guest-free Meet creation, approved invitation/update/cancellation, a notes sheet, lead export and cell edit. Verify Google account policy supports Meet, API enablement, refresh credentials and worker runtime. Real-account behavior remains an operator smoke test.

Integration tests: `TEST_DATABASE_URL=<disposable-local-db> npx vitest run test/integration/google-content.test.js`. Browser QA: run `scripts/google-workspace-qa.js --reset-fixtures --shared-project` against the guarded disposable browser database, serve frontend on 5182 proxied to 5063, then `node test/google-content.browser.mjs`. Google network methods are mocked only by these test harnesses; production has no fixture bypass.

Roll back application code by disabling the Google service flags and preserving populated mapping tables/credentials for reconciliation. The SQL rollback is deliberately limited to empty local test tables; never drop live resource mappings as an automatic rollback.

Local verification: **515 backend tests passed**, two optional skipped; all 33 new content integration cases passed. Frontend tests/build passed, with zero lint errors and ten existing warnings. All seven browser scenarios passed with no page errors, including loaded mobile Calendar/Sheets views. See [check results](evidence/content-checks.txt) and [browser results](evidence/content-browser-results.json). These use synthetic Google responses, not a real-account API pilot.

## Remaining roadmap

Primary/existing calendar import, availability lookup, two-way sync, recurring meetings, a shared team calendar, arbitrary existing spreadsheet selection/import, Sheets-to-CRM automation, Drive attachment browsing, recordings/transcripts and booking pages remain future work. The current pages intentionally operate on resources created through this CRM.
