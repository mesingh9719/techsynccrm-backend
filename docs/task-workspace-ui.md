# Tasks and lead Follow-ups UI

Updated 26 October 2026. Frontend-only follow-up to the task/Calendar/Sheets work; no database migration, API changes or Google Console setup is required.

## Behavior

The Tasks page now has selectable Today/Overdue/Upcoming/Completed count cards, workspace date/time-zone context, title search, assignee filtering, saved browser views and a refresh control. Counts follow the current search and assignee filters. Today includes tasks due earlier today; Upcoming includes undated tasks. Rows separate the title, high priority, due time, reminder, task type, record navigation and owner. The action menu labels editing/rescheduling explicitly.

Quick add accepts a due shortcut or no due date. It assigns the task to the current member and sets a 15-minute reminder only for dated tasks. After saving, incompatible search/assignee filters are cleared and the due-date view is selected so the new task can be seen. A shortcut that has expired while the page was open asks the user to choose a new time rather than silently scheduling a different date. Inputs are disabled while saving.

The lead Follow-ups card uses compact rows with owner information below the task details, a next-due/overdue summary and exact dates on the quick follow-up options. Dates and confirmation messages use the workspace time zone. Custom date/repeat opens the existing linked task form. Successful shortcuts show an inline confirmation as well as a toast. Read-only roles retain readable task information without mutation controls.

Call/meeting completion retains the dialog and notes when the API fails. A successful retry completes/logs the task, and completed tasks can be reopened. The completion dialog validates call durations, preserves unsaved input on dismissal and prevents dismissal while saving.

## Verification

All six frontend test files passed. TypeScript and production build passed. Lint has no errors and ten existing warnings; no new warnings in these components. All six browser stories passed with no JavaScript page errors against the real local API/Postgres and synthetic QA fixtures:

1. Views, title search, owner/team filters and desktop/mobile layouts.
2. Invalid duration, completion failure retaining notes, successful retry/logging and reopen.
3. Rescheduling to the Upcoming view with the expected stored instant.
4. Quick add under incompatible filters, current-user assignment and undated tasks without reminders.
5. Lead shortcut date/reminder/link, narrow card layout and custom scheduling.
6. Read-only viewer controls.

Run the guarded local Google QA API on 5063 and frontend on 5182 as documented in the Google integration QA instructions, then run `node test/tasks-workspace.browser.mjs` from the frontend. The task browser script creates synthetic records and removes its own fixtures afterward. No real Google resources or emails are created.

See [browser results](product-review/evidence/task-workspace-browser-results.json), [Tasks desktop](product-review/evidence/screenshots/task-workspace-tasks-desktop.png), [Tasks mobile](product-review/evidence/screenshots/task-workspace-tasks-mobile.png) and [lead Follow-ups](product-review/evidence/screenshots/task-workspace-lead-followups-desktop.png).
