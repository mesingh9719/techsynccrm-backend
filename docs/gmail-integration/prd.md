# Gmail MVP PRD — approved scope A

23 October 2026. **No implementation authorized yet.** See [market evidence](market-review.md)
and [technical proposal](technical-design.md). This document narrows the broader M19 roadmap.

## Outcome and priority

A rep can send a commercial email from a lead and see its reply there, while another authorized
rep can understand the conversation without asking for mailbox access. Build for email-active
clinics/coaching admissions teams first. Keep WhatsApp/call follow-up ahead of broader email
automation for the general audience. Pilot demand and unit economics before public expansion.

## MVP

| Feature / user story | Priority | Company value and acceptance |
|---|---|---|
| As a rep, connect my Gmail from the first Email action | MVP | One entry button starts Google account selection/consent; no passwords copied. Connection is scoped to this member/workspace. Consent explains team visibility before authorization. |
| As a rep, compose a real email from the lead | MVP | To is a selected lead email; verified From, subject, simple rich-text toolbar, preview and per-mailbox signature. A worker sends through Gmail and it appears in Sent. No arbitrary From or bulk recipients. |
| As a rep, attach a brochure already stored in CRM | MVP | Up to three authorized existing files, combined raw size at most 10 MiB; reused storage checks. Incoming attachment download is next. |
| As a teammate, see sent messages and replies together | MVP | Threaded timeline cards with sender, time, direction and Reply; queued/failed/uncertain states are explicit. Automatic logging happens only after provider acceptance or verified inbound sync. |
| As a rep, receive lead replies without manual logging | MVP | Push plus polling fallback; known lead addresses only, conservative matching and no automatic lead/contact creation. Incoming activity advances last activity; accepted outbound can move New → Contacted using existing rules. |
| As a rep, reuse a template and signature | MVP | Personal/shared templates with allowlisted merge fields; preview expanded values, fallback for missing data; unresolved fields block Send. Signature is managed in TechSync, avoiding Gmail settings scopes. |
| As a rep, know whether email is working | MVP | Connected, syncing, delayed, paused, reconnect required, disconnected and pending connection states; last successful sync and useful retry action. Draft survives provider failure within the open composer. |
| As an admin, oversee and stop access | MVP | Owner/admin sees member, mailbox and connection health and can disconnect. No token access, impersonation, or broader email-content access than record permissions. |
| As an employee, understand and control sharing | MVP | Explicit consent to share matched work correspondence with current record readers; exclude addresses/domains before enabling sync. Disconnect stops future access; separate delete-imported-history action. |
| As an admin, retain authorized commercial history after departure | MVP | Membership deactivation stops queued work and destroys credentials; already-shared history follows approved retention policy and current record visibility. |

## User experience

Lead header Email and email templates open one composer drawer. If disconnected, show the
privacy explanation and Connect Gmail in that drawer, then return to the same lead after OAuth.
Never auto-send an existing draft after reconnect. Keep manual “Log email” available and clearly
separate from Send so existing records/workflows remain usable.

Composer: From (read-only), To (lead email selector), subject, compact formatting toolbar,
template selector, body, signature preview, optional existing-file picker and one Send button.
Send immediately shows Queued, then Sent to Gmail/Failed/Check Gmail before retrying. A success
response from Gmail is not a delivery receipt. Keyboard focus, dialog return, screen-reader
status updates, reduced motion and narrow/mobile layouts reuse existing components.

Timeline shows compact email thread summaries; expanding loads only authorized CRM-stored
messages, with Reply and Open in Gmail where available. Remote images are blocked by default;
tracking pixels and executable HTML never run. Settings has My Gmail for employees and a
connection-health table for owner/admin. Admin controls do not create a shared inbox.

## Roadmap

| Feature / user story | Priority | Why |
|---|---|---|
| As a rep, get a reminder when a lead has not replied | Next | Improves follow-up with the existing tasks system; establish trustworthy reply detection first. |
| As a rep, send later and cancel before sending | Next | Convenience after queue/send ambiguity is proven reliable. |
| As a rep, open relevant incoming attachments safely | Next | Requires bounded downloads, file validation, permissions and retention. |
| As an Outlook user, connect Microsoft 365 | Next | Expands addressable teams using the provider boundary, without delaying Gmail validation. |
| As a manager, run consent-aware follow-up sequences | Next, Business | Paid productivity upgrade; needs reply-stop logic, limits and suppression. |
| As a team, assign conversations in a shared inbox | Later, Business | Valuable for generic admissions/sales addresses; a separate visibility/delegation product. |
| As a manager, inspect approximate opens/clicks | Later | Lower confidence than replies; privacy/client behavior makes tracking approximate. |
| As a non-Google user, connect SMTP/IMAP | Later | More credential/configuration support, polling and security work. |
| As a rep, request AI draft suggestions | Later | Requires a separate data-use/provider/consent decision; synced Gmail data is not used for AI in MVP. |

## Packaging and limits proposed for the pilot

Include one mailbox per active paid member in existing Growth+ `emailSync`. Keep Starter's
manual email logging/external client flow. Keep historic CRM email read access after a downgrade;
pause new send/sync. No new billing add-on or price change in this implementation. Bound queues,
sync pages, body size and attached bytes; these are operational limits, not a bulk email service.

Pilot limits: Gmail/Google Workspace primary address only; one mailbox cannot connect to multiple
members/workspaces; no aliases, shared mailboxes, CC/BCC or arbitrary recipients. Match exact
normalized CRM addresses, never guess from names/domains. Ambiguous duplicate-lead matches are
ignored unless already bound through an explicit CRM send. Existing lead conversion must retain
history on the authorized linked contact. These are intentional boundaries to validate in pilot.

## Success criteria — proposed targets, not measured performance

- No cross-tenant/unauthorized content exposure or duplicate timeline activity under replay tests.
- A healthy worker acknowledges queued send within 2 seconds at p95; queued UI never claims delivery.
- Push reply capture p95 under 60 seconds; polling fallback normally under 10 minutes. These are pilot targets, not a customer SLA.
- Connection completed in roughly two minutes without Google administrator intervention; record failures separately.
- At least three pilot teams use the feature weekly and demonstrate saved handover/follow-up work after four weeks.

## Approved decisions

| Decision | Recommended proposal | Alternative / consequence |
|---|---|---|
| Scope and Google cost | **A: full two-way MVP**, development with test users; fund restricted-scope verification/annual assessment before public launch | **B: send-only pilot** with sensitive `gmail.send`; no inbound sync or automatic Gmail history. Does not meet the full MVP. |
| Privacy | Work mailbox only; explicit team-sharing consent; matched messages visible to current record readers, including viewers | Owner-only email plus explicit sharing needs extra visibility UI and changes the team-history outcome. Google cannot technically scope OAuth to individual lead addresses. |
| Matching access boundary | Address-filtered retrieval; unrelated mailbox change IDs may traverse history/watch, but unrelated headers/bodies are never fetched | If even opaque change IDs are prohibited, choose address-filtered polling without mailbox-wide history/watch; see technical design. |
| Retention | Start syncing at connection; optional matched-only import up to 30 days/500 messages. Retain shared email content 365 days, then purge; deletion action removes content within proposed 24 hours | Different retention/lookback requires a product choice. Backup expiry is unknown and must be documented before launch. These are approved application limits; backup expiry remains a launch task. |
| Managed services | Reuse pg-boss; add Google Pub/Sub and KMS envelope encryption in the Gmail Cloud project | Polling-only removes Pub/Sub initially but delays replies. KMS must still meet the required token-security design. |
| Packaging/boundaries | Growth+ inclusion and limits above; attachments from existing CRM files, primary address only | More mailboxes, aliases, private email, shared inbox or inbound file ingestion expand scope. |

Approval record: the user selected **A** and later requested completion of local implementation and setup instructions because Google Cloud is not yet configured. Scope A and the recommended defaults above are approved. Live Google testing and public release remain pending setup/verification. See [implementation notes](implementation.md).
