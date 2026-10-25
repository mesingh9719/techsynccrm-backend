# User experience and screen plan

Proposed flows, 25 October 2026. Reuse the existing `Button`, Form fields, Dialog/ConfirmDialog, FormDrawer, Toast, EmptyState/ErrorState/ListSkeleton, scoped query keys and import DataGrid. These are wireframe descriptions, not new UI code. Keep existing Gmail and S3 file actions accessible throughout rollout.

## 1. Connect Google: one place, clear service consent

Settings → Google and a Google card under Integrations point to the same per-user view. Existing Gmail settings/team-email routes remain valid entry points.

```text
Google connections                    [Connect Google]
Work account: asha@clinic.example
Calendar    Not connected              [Set up]
Drive       Ready                      [Manage]
Sheets      Ready for selected files   [Export a list]
Gmail       Send-only connected        [Email settings]

Only features you turn on use Google access.
Your admin may turn off a feature for this workspace.
```

Do not imply Gmail connection is mandatory to use Calendar. First-use Set up explains what the action reads/writes and links the current privacy policy. Calendar dedicated mode says it creates a TechSync calendar and reads/updates CRM-linked events there. Drive/Sheets says access is to files selected for the app or created by it; `drive.file` can write even for an attach-only feature. Availability is a second opt-in disclosure of free/busy access. Existing mail read permission is neither requested nor displayed as newly enabled by another service.

Connect opens the Google account/consent flow in response to a click, with a same-tab mobile fallback if a popup is blocked. On return show actual selected account and capabilities; missing/denied scopes keep only that feature off. No success toast until the server commits the grant. Preserve the user's unsent draft or wizard settings across consent. Account mismatch says “You selected a different Google account” and requires an explicit switch, with a preview of the current workspace's syncs that will pause.

“Turn off Calendar” means local usage stops; describe that existing Google permissions may remain. “Disconnect Google Workspace” detaches this workspace. A separate “Remove Google access” action explains project-wide effects, requires recent authentication and explicit confirmation, and offers a Google Account permissions link. Gmail and Workspace can be separate grant profiles even when their status is shown together. Do not expose another tenant's connection list in this warning.

## 2. Calendar setup and everyday scheduling

Default: create a dedicated `TechSync CRM` calendar with neutral naming; do not offer the full calendar browser without additional permission. Advanced existing-primary selection is a later consent choice. Display timezone, one-way/two-way mode, included task types, reminder owner and last sync. Turning on free/busy explicitly explains that busy intervals—not private meeting descriptions—are used.

```text
Schedule follow-up
Lead: Asha Sharma                    [Open CRM record]
Date       12 Nov 2026
Time       10:30                     Time zone: Asia/Kolkata
Duration   30 minutes
Calendar   TechSync CRM
Guests     None                      [+ Add guest]
Location   Clinic front desk
[ ] Add Google Meet
Reminder   TechSync only
                                  [Cancel] [Save and schedule]
```

This extends TaskFormDialog / RecordTasks and lead next-step scheduling. Scheduling is explicit: a task deadline by itself is not an appointment. A first-time Schedule action explains how due time relates to meeting start. Start/end must be valid; all-day is a date range with exclusive end. Guests are not pre-added silently. Adding a lead's email requires current recipient validation and clear copy that Google will send an invitation; saving a phone follow-up without guests sends no invitation. A blocked guest/domain/calendar capability yields an inline error, not a silent guestless success.

After save: task immediately appears in Tasks/Today with “Calendar pending.” When synchronized, show Open in Calendar and optional Join Meet. Meet may show “Creating meeting link”; failure leaves the CRM appointment intact with Retry link creation. No recording/transcript or attendance-tracking promise.

Task reschedule updates the same event; cancellation confirmation says whether guests receive notice. Complete retains event history. Reassign shows the organizer/connection consequences and pauses until handled; do not surprise the lead with two invitations. Deleting a lead explains cancellation of its future linked events without implying that Google documents are deleted.

Staff reminder selector has one owner: TechSync or Google Calendar. Explain that invitees may have their own alerts. Today view follows the existing workspace-date rules until the explicit per-user scheduling view is implemented; always label the chosen timezone and show an alternative zone when useful. Existing all-day dates must remain the same date when displayed elsewhere.

Two-way update produces a system timeline item such as “Meeting rescheduled in Google Calendar,” scoped to permitted record readers. External cancellation cancels only the scheduled CRM task in two-way mode. A conflict panel shows the local and Google time/location plus last common time, with “Keep CRM,” “Use Google,” and “Choose another time.” No background last-write-wins overwrite. RSVP accepted/declined is informational. Recurring CRM occurrences are labelled as individual linked events; full series editing is unavailable until implemented.

Availability UI shows busy/free/unknown and last checked time. On save, refresh; if busy show another-time choices or an explicit authorized override. Never present unavailable Google as “Free,” nor describe free/busy as an atomic reservation system. Working hours/buffers use workspace settings by default; Phase 4 booking needs dedicated booking settings.

## 3. Sheets export

In each existing DataTools menu add “Export to Google Sheets” alongside CSV and Excel. Reports and Campaigns expose equivalent actions only where the backend supports the exact dataset; a report row is not a raw-record dump. Export permission is visible server-side even if a caller bypasses the menu.

The dialog shows current filters, selected columns, scope (“your team” for a manager), an as-of timestamp and timezone, plus New spreadsheet / Choose existing spreadsheet. Picker restricts selection to spreadsheets. Existing file mode defaults to a **new named TechSync tab**, leaving all existing tabs/formulas intact. Before confirm, disclose that selected data becomes a Google-hosted copy and may be shared by the file owner. Respect tenant exports-off even if CSV previously appeared.

One click creates one operation; keep the idempotency key on retry. Progress is Preparing / Sending / Ready / Delayed / Needs attention with counts and safe errors. Ready offers Open spreadsheet and View export history. Closing the dialog does not cancel a queued export; explicit cancel reports partial results honestly. Failed Google export retains working CSV/XLSX alternatives. A deleted target does not silently recreate a different sheet.

## 4. Directional Sheets automation wizard

Use the existing six-step import pattern rather than inventing a second spreadsheet editor:

1. Choose **Send CRM data to a sheet** or **Bring leads from a sheet**. Explain which side owns fields. Never offer ambiguous “Two-way sync” in core.
2. Choose Google account, selected spreadsheet and tab. Outbound creates/owns a dedicated tab. Inbound reads one selected tab and needs a stable source-ID column; ask permission before adding technical/status columns to the source.
3. Choose authorized filters/columns or map source columns. Reuse importCore transforms, options, dedupe and full preview. Show sample Indian phone/date/money transformations and custom-field mapping.
4. Set duplicate/update policy, owner defaults, polling schedule and timezone. Pilot inbound defaults to 15 minutes; label it “checks about every 15 minutes,” not real-time.
5. Review scope, row estimates/plan capacity, exact first-run effects, field ownership and external-copy disclosure. Invalid rows can be skipped only with the existing reviewed confirmation.
6. Start and display counts, last success, next check, failed row references, Pause and View log. Persist wizard revision and setup history.

Row drift shows “The source ID column changed” / “The sheet structure changed,” with Review mapping rather than blind continuation. Duplicate/blank IDs are row errors. Editing an immutable source key or copying a row as new data can create a new intake identity; explain that retry dedupe does not make arbitrary customer edits globally exactly-once. Source-row deletion does not delete CRM leads. Error downloads contain only authorized values; public sheet URLs never contain a CRM auth token. Logging/status writeback is an opt-in addition to named status columns, not comments across a user's sheet.

## 5. Drive attach and save

Extend the existing Files section with a shared toolbar: **Upload file**, **Attach from Google Drive**. Add the same Files section intentionally to Contact and Company detail, where it is currently absent. Preserve local attachments' Preview/Download/Delete/Undo behavior.

Attach opens Picker search/recent files. Selected file cards show Google Drive badge, authoritative name/type, attached-by, current access-status timestamp and Open in Drive; no CRM download proxy using a coworker's Google token. Confirmation explains: “This adds a link. It does not copy the file or change who can open it.” Local Remove link never deletes the Drive file. If metadata cannot be refreshed, show “Access could not be checked,” not “Deleted.”

For a teammate lacking Drive access, offer Open in Drive and “Ask the file owner for access” with a copyable request; no automatic email is sent. Optional Request access may open Google's own flow if available. CRM does not claim that sharing a record grants file access. Thumbnails are optional and gated; fallback file-type icon is the default when authorization or caching is uncertain.

Save to Drive is a separate action on an authorized local File/generated export. Choose account/folder, confirm file name and “Keep original in TechSync” (fixed for MVP), and show queued/result state. Default folder naming avoids embedding patient/lead names. Scope-limited folder selection does not promise all existing folder contents are readable. No automatic sharing or public link creation. A future Share action must list recipients and reader/writer role, explain consequences and require confirmation.

## 6. Admin panel and departure

Extend the Team & Email administration pattern into a Google services panel, with member search, service/status filters, pagination, last success and needs-reconnect indicators. Owners/admins can turn services/exports off for the tenant, locally disconnect a member, pause/retry eligible jobs and view sanitized audit/sync logs. They cannot open private calendar entries or file contents merely from this screen.

Departure review lists affected current-tenant schedules, live sheets and Drive links. Default pause; show “Choose a new owner,” who must connect/select the destination and pass access checks. Existing Google resource ownership stays with Google until a separate supported transfer occurs. Events with guests require organizer-aware handling. Files remain external; teammates may need their own Google access. No silent token transfer from one employee to another.

## 7. Error, loading, mobile and accessibility states

Use explicit categories: Not configured, Disabled by workspace, Not connected, Permission incomplete, Needs reconnect, Blocked by Google admin, Pending, Delayed by quota, Destination unavailable, Conflict and Ready. Each says whether the CRM save succeeded, what last synchronized and what the next action does. Display safe reason codes under expandable diagnostics; omit tokens, provider bodies and technical schema terminology from ordinary flow copy.

At 390 px, use full-width dialogs/drawers, stacked account/service cards and sticky primary actions that do not cover input or bottom navigation. Picker must work with mobile account switching or offer a same-tab fallback; never ask users to paste OAuth tokens. Keep wide mapping data in the existing virtualized grid with keyboard support and a clear horizontal-scroll container, not document overflow. Announce async status with live regions, associate field errors/labels, restore focus after consent/modal close, support Escape/back without losing edits, and test touch targets, contrast, screen readers and DST ambiguity selection.
