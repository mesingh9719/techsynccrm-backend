# Tasks, Calendar and Sheets workspace improvements

Implemented 26 October 2026. Uses the existing Google connection and dedicated CRM calendar. No new Google API scopes, OAuth clients, environment settings or database migrations are required for this follow-up. Restart the API and worker after updating application code; reload the frontend. No production deployment or real Google account actions were performed by this verification.

## Task creation and Google scheduling

The task dialog now has a live summary, grouped details/schedule/reminders/owner sections and persistent mobile actions. A new task can link to a lead, contact, company or deal; record-page tasks keep their existing fixed link. Removing the due date also removes reminder and recurrence settings. Successful saves clear the shared unsaved-change guard.

For a new Meeting task, **Schedule in Google Calendar** carries its title, date, CRM notes and linked record into the Google meeting form. Google meetings create a task assigned to the current member, with the existing 15-minute reminder. Other task settings are configured separately in Tasks. The form explicitly explains that behavior. Custom titles survive linking another record. CRM notes are saved on the task and visible in the CRM agenda; they are not copied into the Google event description.

## Calendar

Each day has a separate **+** create control, and **Go to date** jumps to any date. Selecting a day filters its agenda; creating from its + opens the form on that date. Mobile date-selection and creation hit areas do not overlap. New events may be unlinked or associated with a lead, contact, company or deal.

The overview counts monthly events, confirmed events and operations needing attention. The agenda shows actual sync state, full date/time and duration, display time zone, linked record name/navigation, location, guest list, Meet status/joining link and the linked task's current reminder setting. A confirmation panel distinguishes saved-in-CRM from confirmed-in-Google. Guest invitations remain explicit and start empty. CRM notes can be expanded in the agenda.

Record references use the linked Task's existing entity type/ID; legacy leadId requests remain accepted. API validation rejects incomplete or ambiguous references. Record names are loaded in bounded batches with tenant and role filters; inaccessible records and their events are hidden. Workers recheck visibility before provider access and cancel events when linked contacts/companies are removed. Existing event ownership and credential boundaries remain unchanged.

## Google Sheets

The library has a new creation panel, spreadsheet cards, ready/error badges and title, content-type and status filters. Search/filtering runs on the server and applies to both results and pagination totals, within the current account's existing visibility boundary.

The editor has a document heading, save/refresh toolbar, selected-cell address/value bar, sticky column/row headers and visible save state. Enter/Shift+Enter move vertically without saving. Paging resets the selected-cell indicator. Existing changed-cell limits, stale-edit rejection and unsaved-navigation protection remain in place.

## Validation and evidence

- Full backend suite: **528 passed**, two optional skipped, across 50 test files. Focused Google content integration suite: **42 passed**.
- Frontend: all six test files, TypeScript/production build and lint passed; ten existing lint warnings, no new warnings in these components.
- Full local browser story: **11 scenarios passed**, no JavaScript page errors. Includes contact-date creation/confirmation, task/company scheduling with CRM notes, linked-task refresh, create/edit/cancel, disabled API recovery, sheet persistence/conflicts/search/filtering, exports, mobile layouts and viewer restrictions.
- Focused UI checks: custom title preservation, nested draft dismissal, keyboard cell movement, scrolling headers, selected-cell paging and separate mobile calendar hit areas passed.
- Google OAuth/content calls use synthetic provider responses against a guarded disposable local Postgres database. A real-account smoke test remains an operator step.

Run the guarded backend QA harness and frontend as described in [Calendar/Sheets setup](14-calendar-meet-sheets.md). For the disabled-API case add `--disabled-drive-once`, then run `QA_DISABLED_DRIVE_ONCE=true node test/google-content.browser.mjs` in the frontend. Run `node test/google-workspace-polish.browser.mjs` afterward for the targeted UI checks.

See [browser results](evidence/workspace-browser-results.json), [focused checks](evidence/workspace-polish-checks.txt), [task desktop](evidence/screenshots/workspace-task-form-desktop.png), [task mobile](evidence/screenshots/workspace-task-form-mobile.png), [calendar](evidence/screenshots/workspace-calendar-contact-desktop.png), [Sheets library](evidence/screenshots/workspace-sheets-library-desktop.png) and [Sheets editor](evidence/screenshots/workspace-sheets-desktop.png).
