# Import spreadsheet editor: release and manual verification

The six-step wizard now uses a reusable virtualized `DataGrid` for source data and transformed Review data. It is read-only by default. The source file is immutable; edits, deleted source row IDs, and added rows are an overlay saved with an optimistic draft revision.

## Release requirements

The frontend and backend remain independently deployable. The canonical pure overlay/validation implementation is `frontend/src/lib/importCore.ts`. `backend/src/lib/importCore.js` is its committed generated runtime; regenerate it with `npm run import:sync` from `backend/` after changing the canonical source. This command emits JavaScript without tests or type checking. Both source grid and server analysis use this implementation; CRM lookups and permissions stay server-side.

Install the updated lockfiles with `npm ci` in frontend and backend. The additive migration is `backend/prisma/migrations/20261020007000_import_draft_edits/migration.sql`. It adds `edits`, `revision`, `has_header`, and `analysis` to `import_jobs`; it does not replace source files or delete records.

Apply the normal reviewed release migration from `backend/`:

```
npm run db:migrate
npm run db:generate
```

Restart API and worker together. The worker registers the new `import.preview` queue. Files over 1,000 selected rows need a running worker for complete analysis. Recovery requeues interrupted previews, and obsolete private preview artifacts are discarded. Do not start the new API against an unmigrated database.

The implementation session generated the Prisma client and bundled the frontend without TypeScript checks. It did not run automated tests, browser tests, or type checks, and did not apply the migration to the configured database. Apply migrations through the release workflow for the intended environment.

## Data and API behavior

- `GET /api/imports/:id/dataset?offset=0&limit=1000`: raw source window, stable source coordinates, unique column keys, original header labels, cell issues, layout, overlay and revision. All windows are reachable; virtualization applies to both rows and columns. Source caches retain only the current mounted window.
- `PATCH /api/imports/:id`: existing settings plus optional `revision`, `hasHeader`, and `editBatch`. Batches contain cell replacements/resets, added rows, deleted row flags, or explicit reset. Frontend saves bounded batches below the 1 MB request limit. Draft changes invalidate cached analysis. A revision conflict fails rather than overwriting another tab.
- Layout changes require confirmation in the UI before edits and undo history are cleared. Header/introductory cells are read-only. With header mode off, the selected row is the first data row and synthetic unique column names are used.
- `POST /api/imports/:id/preview`: initiates complete analysis, synchronously for <=1,000 selected rows and through the worker for larger imports. `GET` on the same endpoint polls or pages/filter-searches results. Counts include all selected effective rows, not a 100-row sample. Empty rows and removed rows do not import; appended nonempty rows do.
- `GET /api/imports/:id/attention-data`: authenticated JSON for the browser's formula-safe CSV download. `/attention` also serves a CSV through the authenticated API.
- `POST /api/imports/:id/start`: accepts `{ revision, acceptSkippedRows }`. Pending edits are saved before analysis; the revision sent at Start identifies that edited draft. An empty-body legacy request remains supported. An edited or incomplete reviewed revision cannot start. Invalid rows require confirmation and are reported as failed/skipped records without creating CRM data. Worker writes still recheck permissions, duplicates, record slots, and row validation.
- Source paging, Review, worker retries, and error downloads apply the same saved overlay and source row order. Once processing starts, the draft is frozen.

## Manual checklist

Use `docs/fixtures/import-preview.csv` as a starting point. The file includes notes above the header, UTF-8 text, a duplicate, an invalid email, a phone warning, and an invalid budget. Mapping suggestions should find the header on row 3. Map Notes to Requirement if needed.

1. Upload and verify source row numbers, detected header, original values, sticky headers/gutter, both scroll directions, and clear read-only mode. Type/double-click while editing is off: values must stay unchanged.
2. Turn Edit data on. Verify the banner, single-cell edit, Enter/Tab movement, Escape cancellation, arrow navigation, Shift-click/Shift-arrow range selection, copy and Excel/Sheets multiline range paste. Oversized/out-of-window pastes must report a reason instead of partially applying.
3. Correct the email and budget. Check edit markers and original-value tooltips. Turn editing off: edits remain. Go Back/Next: edits remain. Return to Sheet & header and verify mapping samples use the edited values.
4. Select rows by the number gutter, delete a row, add and populate a row, select a range and Fill down, undo/redo, reset a cell, and confirm reset-all. Undoing reset must restore the prior overlay. Empty appended rows must not create records.
5. Change sheet/header with edits: cancel preserves everything; confirm clears edits and history. Toggle header mode off and ensure row 1 is treated as data. In a multi-sheet XLSX, verify automatic and manual sheet selection.
6. Preview every duplicate strategy. Review must show normalized values, intended create/update/skip actions, and real errors/warnings. With fill-empty-only updates, only applicable changes should be shown. Open a selected row's explanations without relying on hover. Test All, Ready, Needs attention, Duplicates, Edited by you, search, and attention CSV.
7. Click Fix on an invalid cell: source window opens, that cell is selected, and editing is on. Correct it and re-preview: counts and markers change. A missing mapped required field should lead back to mapping.
8. Start with errors: confirm the skipped-row prompt. Start without errors: no unnecessary prompt. Inspect the request revision, then confirm created CRM values reflect edits and removed rows are absent. Download errors and verify edited source values. Cancel/retry a background import and confirm edits are retained.
9. Open the same draft in another tab; save there and attempt to save the older revision. It must show a conflict, not silently overwrite.
10. Try 24,500 rows, 50+ columns, internal blank rows, duplicate headers, long text, UTF-8, and mobile/light/dark mode. Source navigation reaches every window; full Review counts cover the entire selected row limit. Import progress stays separate from analysis progress.
11. Try Excel merged cells and formulas with/without cached values. Merged child cells stay empty with an explanation. Cached formula values are used without executing a formula. Missing cached values can be corrected in the editor. Check numeric phone warnings: irreversibly lost leading zeros are never invented.

## Limits and explicit choices

- Source windows: 1,000 rows; rows and columns virtualized. Paste is confined to the currently loaded window plus added rows; add rows first or split a paste that crosses a window boundary.
- Editing: 20,000 changed cells, 5,000 added rows, 50,000 effective data rows, and 8 MB saved overlay. Undo/redo retains 100 operations while the wizard is mounted. Reload restores saved edits but not undo history; unsaved edits trigger a browser unload warning.
- Tags map existing tag names, separated by comma/semicolon. Unknown tags need correction or creation through tag settings. Lead Status remains a system-managed field (new leads start as New); it is displayed, not introduced as a bypass of the CRM status workflow.
- Counts describe the analyzed revision; concurrent CRM changes are rechecked at write time. Find/replace is deferred as the optional later enhancement.

## Preview loading in development

The grid dependencies are explicitly included in Vite's startup optimization. Previously, discovering them through the lazy preview could leave a running tab with stale dependency URLs (`504 Outdated Optimize Dep`), reject the DataGrid import, and replace the whole wizard with the route error page. Both spreadsheet views now use a shared lazy loader with an inline error boundary and Retry preview action; the upload and edit overlay stay in the parent wizard. A development retry requests a fresh module URL so it can resolve the current optimized dependencies.

After changing dependencies, a tab already displaying the old full-page error needs one reload. If stale dependency errors persist, restart the frontend with `npm run dev -- --force` from `frontend/`, then reload. A notification-stream `ECONNREFUSED` on port 5000 is separate: it indicates the API was unavailable at that moment.

## Excel import and export

Open **Import / export** on Leads, Contacts, Companies or Deals. Choose **Import CSV or Excel** to upload an `.xlsx` workbook, choose its sheet/header, map columns, review validation and confirm the import. Legacy `.xls` files must first be saved as `.xlsx`. Limits remain 25 MB, 50,000 data rows and 200 columns.

The first wizard step offers an **Excel template** as well as CSV. `GET /api/imports/template?entityType=lead|contact|company|deal` returns an authenticated workbook with the current workspace's active custom-field headings. The endpoint requires `records.import`, sends private/no-store headers and creates no stored file or job. Columns use text formatting so Excel retains phone prefixes, PIN codes and long identifiers while users fill in the template.

Choose **Export current view as Excel**, then **Download export**, to download the filtered, permission-scoped list. Excel exports have a frozen header, filters and readable column widths. Money and numeric custom fields use numeric cells when they fit Excel's 15 significant digit limit; larger values remain text. Date fields use native Excel dates. Text identifiers retain their values and formula-looking text is neutralized. CSV behavior is retained. Export history remains in Settings → Import & export.

Deploy the API and frontend together; no database migration or dependency installation is added. Imports, large previews and exports above 5,000 records require the existing background worker (`npm run worker` from backend). Production uses the existing private object-storage configuration.

### Executed verification, 25 October 2026

- Real authenticated HTTP multipart uploads, preview, worker execution and XLSX exports for all four entity types against disposable PostgreSQL. Values include Indian rupee amounts and native Excel dates.
- Template permissions, active custom-field scoping, foreign workspace exclusion, filtered exports, manager team visibility and formula neutralization.
- Chrome: all four template downloads at 390 px; downloaded template filled and uploaded through the complete lead wizard; real pg-boss import; persisted money/email; filtered list export downloaded through signed local storage. No API errors, page errors or horizontal overflow in this run.
- Storage in the browser check is a disposable in-memory S3 HTTP subset that exercises the actual AWS client. It is not a production storage test. Fresh signup, external storage and a 50,000-row browser run remain separate release checks.

To reproduce with the existing synthetic fixture database, run these in separate terminals (the harness refuses other database names/hosts and never reads `.env`):

```sh
# backend terminal 1: ephemeral HTTP storage, no real credentials/data
node test/helpers/local-s3.mjs
# backend terminal 2: API with local queue producer
QA_LOCAL_S3=true QA_DATABASE_URL='postgresql://butcher@127.0.0.1:55441/techsync_product_browser?uselibpqcompat=true&sslmode=disable' node scripts/product-review-qa.js serve
# backend terminal 3: only import/export handlers, no provider/mail handlers
QA_LOCAL_S3=true QA_DATABASE_URL='postgresql://butcher@127.0.0.1:55441/techsync_product_browser?uselibpqcompat=true&sslmode=disable' node scripts/product-review-qa.js transfer-worker
# frontend terminal 4
VITE_API_PROXY_TARGET=http://127.0.0.1:5061 npm run dev -- --host 127.0.0.1 --port 5181 --strictPort
# frontend terminal 5, once all services are ready
node test/excel-transfer.browser.mjs
```

The browser script uses the existing local fixture file `/tmp/techsync-product-review-fixture.json`, a Playwright module (override `PLAYWRIGHT_MODULE` if needed) and Chrome at `/usr/bin/google-chrome`. Results and screenshots are written to `/tmp/excel-transfer-browser`. Stop the stub and both QA services after review; restarting the stub discards its objects.
