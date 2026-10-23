# Implemented Gmail MVP and verification

23 October 2026. Full two-way option A and recommended defaults were approved. The user confirmed Google Cloud is not configured and requested local implementation plus setup instructions. Both repositories use branch `feat/gmail-integration`; no production deployment, production migration, Cloud provisioning or real-mail operation was performed.

## Implemented

- Nine additive Prisma models, tenant-composite foreign keys, worker/tenant indexes, partial active-mailbox uniqueness, retention/deletion states, and a forward cleanup migration. Applied successfully only to disposable localhost PostgreSQL 16. Organization hard deletion was exercised by integration-fixture cleanup with retained Gmail rows present.
- Per-employee OAuth with one-use state, original CRM session, browser-cookie binding, PKCE, nonce, verified Google identity and required-scope checks. A reconnect retains an existing refresh token when Google omits a replacement. Mailbox identity cannot be connected concurrently elsewhere. Tokens/content use per-mailbox KMS-wrapped AES-256-GCM keys with tenant/account/purpose AAD. Revocation remains available when rollout flags are off.
- IDs-only pg-boss send/sync/maintenance jobs. A durable database due scan recovers enqueue failures. Refresh and sync leases serialize access. Membership, plan, account generation, current record visibility, recipient, suppression and files are rechecked by workers.
- Lead/contact composer with current-recipient selection, formatting, signature, personal/team templates, missing-field checks and existing CRM attachments (three files, 10 MiB total; PDFs, common images, text, DOCX, XLSX). MIME has stable Message-ID/date and threading headers. There is no system SMTP or console fallback for employee Gmail.
- Idempotent send requests and immutable retry payloads; queued/sending/accepted/failed/unknown states. Gmail acceptance is displayed separately from delivery. Unknown sends are reconciled against Gmail Sent by exact Message-ID and never blindly retried. Reconnection does not send a draft automatically.
- Matching lead replies, tenant-scoped deduplication across mailbox copies, one provider activity per canonical message, expanded timeline threads, reply composition, and conversion/merge record links. Provider activity content cannot be edited/deleted through manual activity endpoints. The timeline's existing manual flow is labelled **Log email**.
- Address-filtered Gmail discovery, header gate before full content, opaque history-watermark handling, authenticated push due markers, daily watch renewal and polling fallback. Sync uses bounded pages, byte/MIME limits, retry backoff and durable scan cursors. Optional initial import is at most 30 days / 500 observed matching copies; durable copy counts preserve the cap across crashes. Exclusions, ambiguity, hidden/internal records, spam/trash/drafts and unrelated candidates are skipped. A history gap is visible and triggers bounded recovery rather than pretending full coverage.
- Conservative hard-bounce recognition: search only known outbound message tokens, require a correlated structured Google DSN and authentication result, then mark bounced and suppress the exact tenant recipient. Subject wording alone never marks a bounce. Uncertain/unsupported reports remain unclassified.
- Growth+ gating; personal connection status, last sync, reconnect, exclusions, signature, sync request, disconnect and separate history deletion; paginated admin connection controls and personal/shared template management. Viewer users can read permitted shared history and cannot send or connect.
- Departure, account deletion and seat-removal hooks disable credentials and queued sends atomically. Cleanup removes expired content/provider activities in batches; explicit deletion erases the data key after the mailbox's content has been cleared. Generic activity/audit/outbox rows store IDs/status, not mail content. Callback URLs and upstream failure details are sanitized in logs.
- Gmail privacy copy and accurate marketing scope: Gmail pilot capabilities only, Outlook coming later, no open-tracking claim.

## Local verification evidence

All Google, KMS and Pub/Sub provider calls in automated tests are synthetic. The real database tests use only `techsync_gmail_test` on localhost:55432. Fixtures create their own tenants/users and clean them up. Nothing uses a customer's Gmail or sends real mail.

| Boundary | Evidence |
|---|---|
| Schema → database | Both Gmail migrations applied to disposable PostgreSQL 16; generated Prisma client and backend build pass. |
| HTTP → services → database | Gmail integration suite exercises OAuth browser/session/state, denial/scopes/reconnect/identity binding, encrypted credentials, sends, ownership/viewer/tenant isolation, exact-recipient validation, idempotency, reply matching, duplicate-address rejection, unknown reconciliation, refresh rejection, templates, authenticated push persistence, history gaps, quota backoff, durable initial-import cap recovery, cursor reads, conversion links, two-mailbox canonical deduplication, structured bounces and departure/retention cleanup. |
| Provider/content boundaries | Unit tests cover HTML/pixels/header injection, MIME/threading, attachment metadata, merge fields, encryption AAD, tenant fingerprints, structured DSNs, repeated metadata headers, byte bounds, provider errors, refresh and identity/push claim validation. |
| Browser → request → rendered state | `frontend/test/gmail.browser.mjs`: 15 synthetic scenarios; disabled setup, explicit sharing consent, blocked popup, prefilled To, missing merge fields, rich text, stable-key/payload retry, truthful acceptance, expanded thread/reply recipient, mobile composer, admin controls, sync request, template save, viewer history without Reply. |
| Existing lead experience | `frontend/test/lead-detail.browser.mjs`: 19 scenarios pass, including desktop/mobile, permissions, frozen leads, qualification, communication and task pagination. |
| Frontend strict/build/behavior | Strict TypeScript/Vite build and 25 behavior tests pass. Lint reports only the nine existing warnings outside the Gmail files; no Gmail warnings/errors. |

Targeted backend Gmail run: **29 tests** (12 content/provider unit tests + 17 HTTP/database tests). Broader offline backend run before the final added cases: 165 passed with the same two pre-existing spreadsheet failures at `test/modules/spreadsheets.test.js:33` and `:65`. Broader integration run: 83 passed with the same pre-existing M11 Idle deals digest failure at `test/integration/m11.test.js:274`. These failures were also reproduced before Gmail work; they are not described as passing.

Browser screenshots are produced locally at `/tmp/gmail-composer-mobile.png` and `/tmp/gmail-settings-desktop.png`; lead regression screenshots at `/tmp/lead-v2-desktop.png` and `/tmp/lead-v2-mobile.png`. Browser API fixtures and HTTP/database tests validate separate boundaries; a live Google end-to-end result is **not claimed**.

## Repeat the checks

From backend, use a disposable database with migrations applied:

```bash
TEST_DATABASE_URL='YOUR_DISPOSABLE_DATABASE_URL' npx vitest run \
  test/modules/gmail.test.js test/modules/gmail-provider.test.js test/integration/gmail.test.js
npm run build
```

From frontend:

```bash
npm test
npm run lint
npm run build
# Start the local Vite server separately; browser tests allow localhost only.
PLAYWRIGHT_MODULE=/path/to/installed/playwright/index.mjs node test/gmail.browser.mjs
PLAYWRIGHT_MODULE=/path/to/installed/playwright/index.mjs node test/lead-detail.browser.mjs
```

No Playwright dependency was added to the shipped application. The scripts accept an existing installation through `PLAYWRIGHT_MODULE` and optional `CHROME_EXECUTABLE` / `LEAD_QA_URL`.

## Remaining limits and release tasks

- **Live Google validation remains pending:** actual OAuth consent/Workspace policies, ADC/KMS IAM, watch creation/renewal, signed Pub/Sub delivery, Gmail Sent/reply threading, attachments, refresh expiry, quota behavior and delivery reports. Complete [setup](setup.md), then test with dedicated consenting accounts.
- Google restricted-scope verification/security assessment, infrastructure costs, annual assessment ownership, operational alerting, backup retention/restore deletion replay, actual sync lag and willingness to pay remain release work. Existing privacy content is a template and still needs an infrastructure/policy review before publication.
- Initial discovery covers unambiguous open lead addresses. Existing CRM-initiated/converted contact conversations remain eligible through their explicit thread links. This is not a general contact inbox or historical full-mailbox search. New lead addresses are picked up in subsequent sync windows; adding a lead does not automatically import old mail outside the selected connection window. A known lead's personal email can still match; work-mailbox consent/exclusions are necessary.
- Only the connected primary Gmail identity is supported. Aliases, delegated/shared mailboxes, CC/BCC composition, and multiple active workspaces for the same Google identity are deferred. Recipients must remain on the current CRM record; imported mail does not silently replace CRM addresses.
- Inbound attachment names/types/sizes only; file bytes remain in Gmail. Huge messages are skipped after bounded retrieval. Remote images/pixels are removed. Templates show up to 100 recent accessible entries; admin connections and message threads have cursors.
- Drafts are in React memory within the open record/composer. They survive popup reconnect and send failures; navigation/reload discards them. No mailbox content or credentials are stored in browser localStorage.
- Deletion uses bounded worker batches and minimal tombstones; completion depends on a healthy worker and must be monitored. KMS outage/disabled old key versions prevents reading retained encrypted content. Copied/exported provider/recipient messages and backups require separate policy handling.
- DSN coverage is intentionally narrow; acceptance never guarantees delivery, and unsupported or ambiguous bounces are not inferred. Suppression review/removal currently needs an operator; a review UI is recommended next.
- No measured production performance or latency SLA. Gmail queries, history traversal and contact-address scans are bounded per job; a large tenant may need several continuation jobs. Current timeline refresh is 60 seconds for lead/contact pages and expanded conversations refresh every 30 seconds; this is not a live shared inbox.
- Deferred roadmap: suppression review UI and stronger operational dashboards first, then scheduled send/reminders if pilot demand supports them. Tracking, sequences, shared inbox, Outlook, generic SMTP/IMAP and AI drafts remain outside this MVP.
