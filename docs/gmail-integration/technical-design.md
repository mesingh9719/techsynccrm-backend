# Gmail technical design

23 October 2026. Scope A and the recommended defaults in [the PRD](prd.md) were approved. The design below records those decisions; [implementation notes](implementation.md) identify exact shipped behavior and limits. Follow
[repository architecture](../02-architecture-and-conventions.md); retain JavaScript ESM on the
backend and strict React/TypeScript on the frontend.

## Existing-system findings

| Existing code | Consequence for Gmail |
|---|---|
| `backend/src/middlewares/auth.js`, `middlewares/org.js`, `lib/visibility.js` | Bearer session → active membership/workspace context; reuse own/team/all record access on requests and rebuild it in jobs. Membership/2FA/seat/plan changes must stop background access too. |
| `config/permissions.js`, `config/plans.js` | Fixed owner/admin/manager/rep/viewer roles; Growth+ already has `emailSync`. Add narrowly defined email permissions rather than equating record read with authority to send. |
| `prisma/schema.prisma`: LeadEmail/ContactEmail | Existing tenant/email indexes avoid JSON scans and name/domain guessing. Duplicate addresses across records are possible. |
| `services/activity.service.js`, `routes/activity.routes.js` | Email is currently a manually logged activity; timeline visibility derives from linked records. Existing edit/delete rules must explicitly protect provider-owned email entries. |
| `services/lead.service.js:recordLeadActivity` | Existing outbound activity sets first response and New → Contacted; lastActivityAt advances monotonically. Inbound must not count as the rep's first response. Frozen statuses require conversion-aware linking. |
| `jobs/queue.js`, `jobs/schedules.js`, `worker.js`, domain outbox | pg-boss and a separate worker already exist. Reuse them; no BullMQ/Redis migration. |
| `email/mailer.js` | Transactional SMTP has a console fallback that logs content and a direct-send fallback. Gmail must have a separate worker adapter with neither behavior. |
| `integrations/facebook/connection.js` | Reuse the single-use, expiring, browser-bound OAuth state pattern; Gmail is per member, not one workspace-wide Facebook connection. |
| `lib/crypto.js`, `lib/logger.js`, `lib/requestUrl.js` | AES-GCM exists with one environment key; it is not a KMS/envelope system. New provider failures must be normalized before generic job/error logging. Extend redaction for Gmail callbacks/body/refresh_token rather than relying on the present list. |
| `frontend/.../leads/detail/useCommunication.ts`, `activities/Timeline.tsx` | Email opens `mailto:` and manual logging today. Add real compose/send and thread cards while retaining explicit manual logging. |
| `frontend/src/data/integrations.json`, `data/pricing.json` | Marketing already advertises Gmail as Available and broader Outlook/tracking. This is not evidence of implementation; correct the Gmail availability/feature copy with the approved release. |

Only source code was inspected. No `.env` secrets, production DB, employee mailbox or cloud
account was inspected. The earlier M19 schema is a roadmap sketch, not a current database model.

## Google scopes and public-launch requirements

| Authorization string | Proposed purpose | Classification / boundary |
|---|---|---|
| `openid` and `email` (OIDC scope values) | Stable Google subject and verified mailbox identity | Basic identity; omit profile/name/photo access. Validate issuer, audience, expiry and nonce. |
| `https://www.googleapis.com/auth/gmail.send` | Send explicit user-composed messages | Sensitive; smallest Gmail sending scope. |
| `https://www.googleapis.com/auth/gmail.readonly` | Read matched messages, history and watch | Restricted; required for two-way body access. |

For proposed full MVP request identity + send + readonly. For a separately approved send-only
pilot request identity + send. Omit `gmail.modify`, `gmail.compose`, `gmail.metadata`, settings
scopes, calendar/contacts scopes and `https://mail.google.com/`. Gmail metadata is also restricted
and cannot supply bodies; `messages.list` does not allow its search `q` with that scope.
[Google's scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes),
[messages.list scope/search rules](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list),
[OIDC identity validation](https://developers.google.com/identity/openid-connect/openid-connect)

External multi-tenant SaaS does not become an internal app because customers use Workspace.
Plan brand verification, domain ownership, public homepage/privacy/deletion pages, scope
justifications, a complete consent/use demo and restricted-scope review. Server access to
restricted data requires a Google-approved assessment under CASA, renewed at least every
12 months; assessment tier, price and exceptions must be confirmed for this app. Google says
review can take several weeks; a changed brand review typically takes 2–3 business days.
[Official restricted verification requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

**Planning estimates, not Google commitments:** 1–2 engineering weeks for policy/data-flow,
access/deletion evidence and a verification demo; 4–8+ calendar weeks allowance for external
review/assessment/remediation, potentially longer. Obtain assessor quotes before committing
a public-launch date or assessment budget; no universal dollar cost is established here.
Budget the recurring renewal and security work, not just initial implementation.

Develop against a separate External/Testing project with explicitly authorized test users.
Google limits Testing to 100 listed users; Gmail test authorizations/refresh tokens expire
after seven days. A pilot must disclose this and is not a way to bypass production review.
[Testing audience rules](https://support.google.com/cloud/answer/15549945),
[refresh-token expiry](https://developers.google.com/identity/protocols/oauth2)

| Alternative | Tradeoff |
|---|---|
| Send-only Gmail API | Avoids restricted inbox scope for this feature, but still sensitive verification. Replies remain in Gmail; cannot advertise two-way sync. |
| SMTP/IMAP with OAuth | Gmail's full-mail protocol scope is restricted; not an assessment shortcut. [Google restricted-scope list](https://support.google.com/cloud/answer/13464325) |
| App-password SMTP | Manual credential setup, 2-Step Verification and account-policy limitations; Google discourages it. No inbound without further access. [Google app-password guidance](https://support.google.com/accounts/answer/185833) |
| Dedicated sending provider | Can send branded transactional mail, but is not the user's Gmail identity/Sent folder/reply-history experience. Keep existing system SMTP separate. |

## OAuth and token security

Proposed flow: authenticated POST start checks active member, plan and `email.connect`;
creates random hashed state bound to member, organization, current CRM session, browser secret,
intended scope and allowlisted return location. Expire after ten minutes. Use a secure HttpOnly
SameSite=Lax callback cookie. Request offline access and consent on initial connect/reconnect;
use the supported server authorization-code flow with S256 PKCE and a short-lived encrypted
server-side verifier. Verify OIDC nonce/claims and granted
scopes, and check membership/session again at callback. The public callback trusts the claimed
server state, never an organization/user passed by the browser. Atomically consume state to
reject replay; denial, missing code, wrong cookie/session and stale state are distinct errors.
Redirect only to an allowlisted same-origin route with a safe result code, never credentials.
[Google server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server),
[Google auth client PKCE support](https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/oauth2client.ts)

Use the maintained `google-auth-library` for OAuth/OIDC and Pub/Sub JWT verification; native
fetch for the small Gmail REST surface. This is a justified auth dependency, not another
application framework. Validate account email/sub, reject an identity already attached to
another workspace/member without revealing where. A changed Google identity requires explicit
replacement, not overwriting a connection during reconnect. Do not erase an existing valid
refresh token if Google's reconnect response omits one; a first connection without a usable
refresh token remains incomplete. [Google auth library](https://github.com/googleapis/google-auth-library-nodejs)

**Proposed KMS envelope encryption:** random 256-bit data key per connection, AES-256-GCM
credentials with unique nonce and AAD including organization/account/key-version/purpose;
wrap the data key using Cloud KMS and store ciphertext, wrapped key and key version. Only API/
worker service identities can unwrap, under least privilege. Access tokens remain in bounded
memory; refresh tokens are encrypted before persistence. Never place either token in jobs,
logs, browser storage or API responses. Keep this isolated from existing 2FA/Facebook keys.
Add key-version rotation/rewrap and recovery tests before launch.
[Envelope encryption](https://docs.cloud.google.com/kms/docs/envelope-encryption)

Serialize refresh per connection with a short DB lease; do not keep database transactions open
over Google/KMS calls. On invalid_grant or lost scopes, mark reconnect-required and notify once.
Back off transient refresh failures. Disconnect/deactivation immediately makes credentials
unusable to new work and cancels queued sends; workers recheck a credential generation just
before provider calls and before persistence. A provider request already in flight may finish;
the UI/audit must not promise recall. Revocation/stop-watch is best effort, local disable is
immediate. Explicit full Google-grant revoke may affect all tokens under that grant, so the
one-workspace-per-mailbox MVP boundary prevents hidden cross-workspace disruption.

## Privacy, matching and incremental synchronization

Gmail provides mailbox-wide read authorization, **not per-lead authorization**. Application
filtering limits retrieval; it does not narrow the scope displayed by Google. A known lead
address can also exchange personal mail, so address matching alone cannot infer commercial
purpose. The proposed default requires a work mailbox and explicit team-sharing consent,
with address/domain exclusions applied before retrieval. Owner-only/private sharing is a
different approval choice. CRM support/admin tooling must not expose message contents.
Google's limited-use and human-access rules apply to storage, sharing and processing; no
advertising use, generalized AI training or AI draft processing is included.
[Workspace data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)

**Do not implement “download inbox, then filter.”** Use the following bounded procedure:

1. Reconstruct current member/workspace context. Build a deduplicated allowlist from exact
   LeadEmail indexes for eligible visible records, excluding deleted/frozen/junk/lost records,
   internal member/mailbox addresses and explicitly excluded addresses/domains. Known converted
   thread bindings may continue on the linked visible contact; no general contact-mail import.
2. Capture a history baseline, then run address-filtered `messages.list` queries on Google's
   server in bounded batches, with numeric UTC timestamp boundaries, `-in:spam -in:trash` and
   draft exclusion. First connection starts now; optional backfill is at most 30 days/500 matched
   messages. New lead/address changes trigger bounded matching from that record's eligible time.
3. Fetch minimal headers only for returned candidate message IDs. Verify exact parsed addresses,
   direction and unique record match; reject spoofed-only Reply-To/display-name matches. Do not
   strip Gmail dots or plus suffixes or match an entire customer domain. For new ambiguous
   matches, ignore without creating a lead, task, activity or content-bearing unmatched inbox.
   An established explicit CRM send binding wins only while participants and record access
   still validate. Never attach one email blindly to every duplicate lead.
4. Only then fetch full content for the accepted message ID. Never fetch entire Gmail threads
   merely because one message matches: other thread messages can involve unrelated people.
   Store bounded, sanitized content and safe attachment metadata, not unrelated bodies. Check
   again before commit if permissions, exclusion policy or connection generation changed.
5. `history.list(startHistoryId)` supplies incremental **opaque IDs**, not correspondent search.
   Walk all history pages with a field mask, collecting only relevant change IDs; intersect
   them with the address-filtered candidate queries before any header/body fetch. Unknown IDs
   are discarded, not logged/persisted. Mailbox-wide change IDs are a disclosed residual of
   history/watch, not permission to inspect unrelated subjects/headers/bodies.
6. Upsert messages and activity links transactionally with unique provider keys. Save durable
   per-run work/progress; advance the authoritative history cursor only after every page and
   eligible message has been processed. Replay after a crash is safe. Store provider history
   IDs as strings and compare numerically with BigInt, never JS Number or lexicographic order.
7. On history 404, perform **bounded matched-only reconciliation**, establish a new baseline,
   then catch up across the reconciliation window. Do not follow Google's general full-mailbox
   sync example. Surface any older unrepairable coverage gap rather than claiming complete
   history. Periodic bounded reconciliation also catches delayed Gmail search indexing.

This is an explicit compromise for approval: unrelated opaque change IDs can traverse the
worker, but unrelated email content/headers must not be fetched. If “do not read unrelated
emails” also prohibits those IDs, use address-filtered polling without mailbox-wide history/
watch, or restrict the product to explicitly initiated conversations. Do not silently claim
both strict zero-metadata access and general history-based inbox discovery.

References: [history.list has history/label filters, no address query](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list),
[Gmail query/date behavior](https://developers.google.com/workspace/gmail/api/guides/filtering),
[history expiry and recovery](https://developers.google.com/workspace/gmail/api/guides/sync).

**Push and polling:** authenticated Pub/Sub push receives mailbox address/history ID, verifies
Google signature/issuer/audience/expiry and configured service-account identity, records a
durable dirty marker and acknowledges after durable enqueue. It never trusts an org ID from
payload or logs the envelope. Grant only topic publish to Gmail's system service account.
Deduplicate notifications; one active sync lease per mailbox. Watch renews daily and follows
the returned expiry (Google requires renewal within seven days). Poll every five minutes when
push is quiet/failed; repeated pushes coalesce. Gmail notifications are hints and may be lost.
[Gmail push/watch](https://developers.google.com/workspace/gmail/api/guides/push),
[authenticated push validation](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions)

## Sending, threading and failure semantics

POST send checks active membership/plan, own connected mailbox, email.send, record visibility,
approved recipient, suppression and attachment permissions. Persist an immutable composition
snapshot plus idempotency key and queue/outbox marker in one transaction; return 202. Jobs
contain IDs only. Worker claims a lease, revalidates authority, constructs MIME and sends with
Gmail `messages.send`. Nodemailer's existing MailComposer supports multipart text/html and
attachments; disable URL/file-path content resolution and load bytes only from authorized
storage. Reject CR/LF header injection, unsafe HTML, executable attachments and oversize bodies.
Use a maintained HTML allowlist sanitizer for both outgoing and incoming rich text; the existing
note tag-stripper is not an email HTML sanitizer. This small security dependency is justified;
no new UI framework or general rich document editor is required for the limited toolbar.
Proposed app limits: 100 KB body, 200 KB rendered body with signature, three files/10 MiB raw.
[MIME sending](https://developers.google.com/workspace/gmail/api/guides/sending),
[existing Nodemailer MailComposer](https://nodemailer.com/extras/mailcomposer)

Send as the verified primary account only. Reply uses that account's Gmail threadId plus the
stored RFC Message-ID in In-Reply-To/References and matching subject. Gmail thread IDs are
mailbox scoped; do not reuse another employee's thread ID. Server validates the referenced
message/record relationship; client cannot supply arbitrary threading headers.
[Gmail threading requirements](https://developers.google.com/workspace/gmail/api/guides/threads)

State machine: queued → sending → provider_accepted (UI “Sent to Gmail”), failed, cancelled or
unknown. Never label provider acceptance “delivered.” If transport times out after request bytes
may have reached Gmail, exactly-once external send cannot be guaranteed by a DB transaction
or queue singleton. Persist a stable RFC Message-ID; reconcile Sent with an exact known-message
query before considering a resend. If unresolved, show “Check Gmail before retrying” and require
explicit user action; never blindly retry an ambiguous send. A DB failure after provider
acceptance must retry persistence/reconciliation rather than re-send. Safe pre-send/quota
failures use jittered exponential backoff and Retry-After. Disable generic automatic HTTP/queue
retries for unsafe send attempts.

Accepted sent messages and inbound messages each produce one immutable provider-linked email
activity and domain event transactionally. Keep subject/body in the protected message store;
generic activity/audit/outbox rows contain references/status, not email bodies. Existing activity
update/delete endpoints must reject edits to provider-owned entries except authorized redaction.
The timeline adds optional email references without changing its existing items or pagination.
An expanded thread loads messages through a new authorized endpoint. Conversion/merge hooks
relink history without changing frozen lead status or creating duplicate entries.

Known delivery-status notifications may mark a sent message bounced only when their references
identify an already tracked outbound message. Any candidate search must be bounded by an exact
known outbound message token; do not scan all mailer-daemon mail. Validate correlation before
storing a DSN. Where Gmail cannot locate a correlated DSN under these access limits, delivery
remains unknown. Ignore uncertain DSNs and show acceptance without guaranteed delivery status.
Permanent confirmed bounces suppress that recipient until reviewed; transient failures do not
silently create/reopen leads.

## Queue, quotas and proposed models

Reuse pg-boss with gmail.send, gmail.sync, gmail.watch-renew, gmail.reconcile and gmail.cleanup
handlers. Queue payloads are `{organizationId, accountId, messageId?/runId?, generation}` only;
all are revalidated, never trusted as authorization. Use durable outbox/recovery for enqueue
failure, not the existing SMTP direct/console fallback. Per-account leases, small request
concurrency, bounded pages and jitter prevent simultaneous refresh/sync and retry storms.

Google's current quota page says projects created from 1 May 2026 use updated quotas: 6,000
units/user/project/minute, 1,200,000/project/minute, with method-specific costs (full message
get: 60; send: 100). Older projects may retain previous quotas. Check the actual project and
current Cloud console. It also lists an 80-million-unit daily billing threshold with future
billing details pending; do not hard-code a timeless “free Gmail API” cost assumption. Respect
user sending limits, which are separate from API units.
[Current quotas](https://developers.google.com/workspace/gmail/api/reference/quota),
[rate limits and retry rules](https://developers.google.com/workspace/gmail/api/guides/handle-errors)

Proposed Prisma models are outlined below; no schema/migration has been written. Use UUIDs
consistent with this repo, timestamptz timestamps, bounded text/JSON validation and **non-null
organizationId on every tenant table**. All child relations include organizationId in composite
foreign keys, not merely a globally unique parent UUID. Index referencing sides and tenant-first
read/cleanup paths; avoid redundant indexes already covered by unique keys.

| Model | Principal fields and constraints |
|---|---|
| GmailAccount | org/user/membership identity, Google sub + normalized mailbox, granted scopes, status, consent/policy version, encrypted refresh token, wrapped data key/version, credential generation, signature, last safe error. Unique(org,user), unique(org,id); enforce globally unique active Google subject for the approved single-workspace rule with a partial unique index. Index(org,status). |
| GmailOAuthState | org/user/session binding, stateHash, browserHash, nonce, encrypted PKCE verifier, scope/return target and expiry. Unique stateHash, index(org,user), expiry cleanup index; one-use state consumption. No returned code/token stored. |
| EmailThread | org/id, logical record binding, subject reference, lastMessageAt. Index(org,entityType,entityId,lastMessageAt,id). No access by thread ID alone. |
| EmailMessage | org/thread, direction/status, actor, encrypted content envelope, content key reference, stable outbound Message-ID, provider acceptance time, idempotency key/request hash, safe error code, expiry. Unique(org,id), unique(org,actor,idempotencyKey) for sends; index(org,thread,occurredAt,id), index(org,status,nextAttemptAt), index(org,expiresAt). |
| EmailMailboxCopy | org/account/message/thread binding, Gmail message ID, mailbox-specific Gmail thread ID, observed time. Unique(org,account,gmailMessageId), index(org,account,gmailThreadId). Prevents event/retry duplicate ingestion. |
| EmailMessageRecord | org/message, lead/contact binding and unique activity reference. Composite FK to message/activity; unique(org,message,entityType,entityId), index(org,entityType,entityId,message). Enables conversion/merge and protected provenance. |
| EmailTemplate | org/owner, personal/shared visibility, name, subject/body, allowlisted merge fields and version. Index(org,visibility,owner,updatedAt,id). Shared writes require template-management authority; render only on authorized records. |
| GmailSyncState | org/account unique, historyId text, watch expiry, last successful sync, reconciliation window/progress, lease owner/expiry, nextAttemptAt, safe error and generation. Index(org,nextAttemptAt); global scheduler uses a bounded due-time index and rechecks tenants. |
| EmailSuppression | org, normalized recipient key, reason/source, created/cleared time. Unique(org,recipientKey); block confirmed hard bounces and known opt-outs. Include address/domain sync exclusions in validated account policy. |

For copies arriving in multiple employee mailboxes, deduplicate canonical messages using a
tenant-scoped SHA-256 fingerprint of RFC Message-ID, normalized sender/recipients, timestamp and content
digest. Never trust RFC Message-ID alone; no cross-tenant deduplication. Each copy retains its own
provider IDs so any reply uses the correct mailbox. Identical canonical messages reuse activity
links; stitch thread bindings only with verified shared message/reply references, never subject
similarity. Acceptance tests must cover multiple mailboxes and missing/spoofed Message-IDs.

Tenant ownership is enforced by services and composite constraints; introducing RLS just for
this module is not part of this proposal. Migration is additive, without rewriting old rows.
Record-link rows use nullable leadId/contactId with an exactly-one CHECK and composite tenant
foreign keys; add the required organization/id unique targets on existing referenced tables.
Link the existing activity through its organization/id pair as well. Membership/user deletion
must disable the account and clear credentials without cascading away retained shared history.
Code rollback leaves new tables disabled and preserves data until approved retention/deletion;
schema removal is a separate destructive migration, not an automatic down-migration.

## Proposed additive APIs

Use existing `{success,data}` / `{success:false,error:{code,message}}` envelopes. UUID params,
body limits, tenant-keyed query caches and cursor pagination follow repository conventions.

| Endpoint | Request / response and authority |
|---|---|
| POST /api/integrations/gmail/oauth/start | `{returnTo, mode}` → `{url,expiresAt}`; server allowlists mode/scopes/return path; active member + connect permission + plan. |
| GET /api/integrations/gmail/callback | Google code/state or denial; browser cookie/state/session validation; redirect with safe status only. |
| GET /api/integrations/gmail/me | `{account:null\|{id,email,status,lastSyncedAt,capabilities,safeError}}`; own status, no credentials. |
| GET /api/integrations/gmail/accounts | `{items,nextCursor}`; owner/admin status metadata only. |
| DELETE /api/integrations/gmail/accounts/:id | Disconnect, invalidate credentials/work and queue revocation; own or owner/admin. No implicit history deletion. |
| PATCH /api/integrations/gmail/me | `{signature,excludedAddresses,excludedDomains}`; validated own policy/settings, consent-sensitive changes explicit. |
| POST /api/integrations/gmail/me/sync | Rate-limited manual resync → 202 `{queued:true}`; own active account. Optional bounded initial-import choice is explicit. |
| POST /api/emails/send | `{leadId,to,subject,bodyHtml,bodyText,templateId?,replyToMessageId?,attachmentFileIds:[]}` plus Idempotency-Key → 202 `{message:{id,status:"queued",threadId}}`; sender/account inferred from session. Identical retries return same message; changed payload with same key is 409. |
| GET /api/leads/:id/email-threads | `{items,nextCursor}` with safe summary/status; current record readers. Equivalent linked-contact route required to preserve converted history. |
| GET /api/email-threads/:id/messages | `{items,nextCursor}`; resolve authorized record linkage before returning/decrypting anything. |
| GET /api/emails/:id | Status/authorized message detail, for queued composer and failure recovery. |
| GET/POST /api/email-templates; PATCH/DELETE /:id | Personal/shared templates; owner visibility and separate shared-write permissions. No arbitrary template expressions. |
| POST /api/integrations/gmail/accounts/:id/delete-history | Explicit own/admin action; 202 deletion request ID, requires confirmed policy/authorization; purge message/activity copies and encryption material as appropriate. |
| POST /api/webhooks/gmail | Public route with authenticated Pub/Sub validation, body size bound, durable enqueue; 204 only after receipt persisted. |

Proposed safe error codes: GMAIL_NOT_CONFIGURED (503), GMAIL_NOT_CONNECTED (409),
GMAIL_OAUTH_CANCELLED (400), GMAIL_OAUTH_EXPIRED (400), GMAIL_OAUTH_INVALID (400),
GMAIL_SCOPES_MISSING (409), GMAIL_RECONNECT_REQUIRED (409), GMAIL_ACCOUNT_UNAVAILABLE (409),
GMAIL_RATE_LIMITED (429 + Retry-After), EMAIL_RECIPIENT_INVALID (422), EMAIL_SUPPRESSED (409),
EMAIL_ATTACHMENT_TOO_LARGE (413), EMAIL_TEMPLATE_FIELD_MISSING (422),
EMAIL_IDEMPOTENCY_CONFLICT (409), EMAIL_SEND_UNKNOWN (409). Keep AUTH_REQUIRED,
FEATURE_NOT_IN_PLAN, FORBIDDEN and concealed cross-tenant NOT_FOUND semantics. Async failures
appear on message/account status; never return raw Google response bodies or token-bearing URLs.

## Visibility, retention, instrumentation and implementation sequence

Send/connect permitted to owner/admin/manager/rep, never viewer; send uses own mailbox and
requires current record access. Owner/admin alone manage others' connection metadata. Under
the proposed shared mode, every current record reader (including viewer) can read shared
history. A mailbox owner losing record access cannot use old message/thread IDs to regain it.
Check search, exports, notifications and related-record links too; do not put email content
into existing generic exports/digest emails or broad audit logs.

Retention proposal: credentials removed on disconnect/departure; shared message content expires
365 days after occurrence, optional import max 30 days/500 matched messages; explicit deletion
processed within proposed 24 hours. Disable import/sync while deletion is pending so data is
not immediately reintroduced. Purge bodies, previews, attachment metadata, activity links and
canonical copies consistently; preserve only minimal non-content audit counts where policy
permits. Backup expiry and recipient/provider copies must be explained separately; recovery
must reapply deletion tombstones. Final retention/backup commitments require approval.

Log/measure queue lag, accepted/failed/unknown send counts, sync lag/duration, watch expiry,
refresh failure categories, quota/backoff and skipped ambiguous counts. Operational logs use
job/account/tenant IDs and sanitized categories only, never addresses, subject, body, MIME,
tokens, request bodies or upstream error dumps. Bound metric cardinality. Health alerts must
distinguish worker outage, Google outage, quota delay and reconnect-required.

Implementation branches are `feat/gmail-integration` in backend and frontend. Reviewable stages: additive models/migration; OAuth/KMS; queued send + timeline; matched sync;
templates/signature; employee/admin settings; instrumentation/cleanup and hardening. Use local
disposable database tests, then explicitly authorized test mailboxes. Proposed engineering
effort is **6–10 engineer-weeks** plus external review/assessment time; it is an estimate,
not a delivery commitment. No credentials, Cloud project configuration, customer contact or
production migrations were performed in this implementation pass.
