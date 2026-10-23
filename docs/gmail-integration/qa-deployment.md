# Gmail QA and deployment plan

23 October 2026. **Scope A approved and implemented locally.** The local checks below use synthetic providers and disposable PostgreSQL. Google Cloud is not configured, so all live OAuth/KMS/Pub/Sub/delivery checks remain pending. See [setup](setup.md) and [implementation evidence](implementation.md).

Verified locally: **29 Gmail backend tests**, **25 frontend behavior tests**, **15 Gmail browser scenarios**, and **19 existing lead browser scenarios**. Backend/frontend builds pass. Broader suites retain three known baseline failures (two spreadsheet tests, one M11 digest integration test). See the exact boundaries and limitations in [implementation evidence](implementation.md).

## Extended acceptance checklist (unchecked items need explicit additional verification)

- [ ] OAuth: valid code/state/cookie/session/PKCE; denial; missing/malformed code; expired/replayed state; wrong browser; changed workspace/session; deactivated member; unsafe return URL.
- [ ] Identity: issuer/audience/nonce/expiry; verified email; missing granted scopes; wrong account on reconnect; identity already connected elsewhere without existence disclosure.
- [ ] Tokens: required first refresh token; omission on reconnect preserves a valid token; concurrent refresh; invalid_grant/reconnect; transient backoff; key rotation and wrong-AAD/decryption failure.
- [ ] Secrets/logs: no plaintext tokens in DB/jobs/browser/logs; callback query redaction; no raw upstream errors; no body/subject/MIME in audit/outbox or SMTP console fallback.
- [ ] Send: own mailbox; exact lead recipient; plan/role/record scope; member removal; idempotent POST retry; changed payload/key conflict; template/signature and rich-text validation.
- [ ] Send failures: quota/Retry-After; timeout before/after possible acceptance; crash after Gmail acceptance/before DB commit; unknown state never auto-resends; reconnect never auto-sends drafts.
- [ ] Matching: primary/secondary lead emails, plus/dot handling, tenants sharing an address, duplicate leads, hidden/internal/excluded records, unknown sender, spam/trash/draft and spoofed Reply-To.
- [ ] Retrieval: unmatched IDs never reach header/body fetch; candidate headers validated before full fetch; unrelated messages inside a matching thread; bounded pages/bytes/backfill.
- [ ] Sync: replay/reordering; multiple pages; large numeric IDs; crash mid-page; durable cursor; history 404 recovery; delayed indexing; explicit coverage-gap status.
- [ ] Idempotency: one provider message per account and one canonical activity under replay; multiple mailboxes; missing/spoofed RFC IDs; account-specific reply thread IDs.
- [ ] Push: invalid JWT/issuer/audience/service account; stale token; duplicate delivery; unknown/disconnected mailbox; DB/enqueue failure before acknowledgement; retry recovery.
- [ ] Lifecycle: lead conversion/merge, visibility change, user departure, workspace deletion, seat suspension, plan downgrade, disconnect, delete during sync and late jobs/callbacks.
- [ ] Content: CR/LF injection; scripts/events/unsafe links; external pixels; URL-fetch SSRF; huge/recursive MIME; Unicode/plain/HTML-only content; malicious filenames.
- [ ] Files: organization/read permissions, deleted file, three-file/10 MiB aggregate limit; no arbitrary local paths or remote URLs; no inbound file-byte ingestion.
- [ ] Read privacy: guessed thread/message IDs, linked records, viewer restrictions, generic export/search/digest content leakage.
- [ ] Retention: content/previews/activities/copies expire together; disconnect differs from deletion; deletion tombstones survive backup restore and prevent immediate reimport.

Reuse frontend behavior tests and backend Vitest/HTTP tests with disposable local PostgreSQL
and fake Gmail/KMS/Pub/Sub adapters. Never test against the application DB. Run strict TS/build,
relevant lint, backend schema/syntax checks, browser flows and explicitly authorized Google
test-user checks after implementation. No test should email a real lead.

## Manual pilot checklist

- [ ] Connect from lead Email; correct mailbox/sharing explanation; return to the same lead; cancellation and admin-policy rejection are clear.
- [ ] Compose with prefilled To, formatting/template/signature and existing files; inspect actual Gmail Sent. Reconnect retains the open draft and requires explicit Send.
- [ ] Test recipient replies; thread/direction/time and Reply are correct; unrelated fixture mail is never imported.
- [ ] Another authorized employee sees shared history but cannot send as someone else; viewer/record visibility restrictions hold.
- [ ] Empty email, duplicate address, lost/junk/converted/deleted lead and incoming attachment metadata have useful states.
- [ ] Stop push/worker, expire watch, revoke token, simulate quota delay and disconnect during send; verify honest recovery without duplicate sends.
- [ ] Mobile/tablet/desktop, keyboard-only flow, focus return, screen-reader status and reduced motion.
- [ ] Admin disconnects a departing employee; future access stops and retained history follows policy.
- [ ] Synthetic deletion and backup-restore exercise proves cleanup before customer deletion periods are promised.

## Implemented configuration names

| Name | Purpose |
|---|---|
| GMAIL_ENABLED, GMAIL_SYNC_ENABLED | Off-by-default server rollout controls. |
| GOOGLE_GMAIL_CLIENT_ID, GOOGLE_GMAIL_CLIENT_SECRET | Environment-specific OAuth web client; secret manager injection, never frontend/VITE variables. |
| GOOGLE_GMAIL_REDIRECT_URI | Exact HTTPS callback; separate allowed local-development redirect. |
| GMAIL_PUBSUB_TOPIC | Same-project Gmail watch topic. |
| GMAIL_PUBSUB_AUDIENCE, GMAIL_PUBSUB_SERVICE_ACCOUNT | Expected signed push identity and audience. |
| GMAIL_KMS_KEY_NAME | KMS key configuration; prefer workload identity/short-lived runtime credentials. |
| GMAIL_POLL_SECONDS | Poll 300 seconds; optional import maximum 30 days/500 messages; server-enforced bounds. |
| GMAIL_MESSAGE_RETENTION_DAYS | Approved default 365; configurable shorter, server-capped at 365. |

Retain existing DB/direct worker connection, application origins and private file storage.
Names are present in backend `.env.example`; the initial 0/30-day and 500-message limits are enforced in code, not environment variables. never put secret values in docs,
tickets, shell output or frontend bundles.

## Google Cloud and release checklist

1. [x] Scope A, privacy, retention, managed services and Growth packaging approved. Still assign an operational owner and obtain assessor quotes.
2. [ ] Create separate testing/production projects. Enable Gmail API, Pub/Sub and KMS as needed; configure least-privilege runtime identities, secrets and key recovery/rotation.
3. [ ] Configure External consent, owned domains, support contacts, public homepage/privacy/deletion pages and exactly the approved scopes. Add consenting test users and explain seven-day testing expiry.
4. [ ] Register exact callback URI and validate TLS/cookies/return destinations and Workspace administrator restrictions with authorized test accounts.
5. [ ] Create topic and authenticated HTTPS push subscription. Grant topic publisher to `gmail-api-push@system.gserviceaccount.com`; configure audience/push identity and required token-creator/act-as roles. Reject invalid JWTs; acknowledge only durable receipt.
6. [ ] Validate KMS access, AAD isolation, rotation, outage behavior and backup procedures without printing secrets.
7. [ ] Apply additive migrations with flags off using the intended direct URL, then generate Prisma client. Do not edit applied SQL/reset data.
8. [ ] Deploy compatible API and worker, register queues/schedules/recovery, then frontend. Keep existing manual logging working and provider-owned entries protected.
9. [ ] Enable capped test-user pilot. Verify actual Sent/reply flow, unknown-send reconciliation and cleanup; measure queue/sync lag, quota costs and reconnect support burden.
10. [ ] Complete applicable Google verification, CASA assessment and remediation before public release; document approved scopes and annual review date. Testing/internal exceptions are not public multi-tenant launch approval.
11. [ ] Approve final retention/deletion/backup copy, suppression, incident runbook and data-access policy. Correct marketing to shipped Gmail capabilities; do not claim Outlook/tracking/sequences in this MVP.
12. [ ] Roll out gradually; monitor daily watch renewal, polling/reconciliation, worker health and support alerts. Assign annual assessment ownership.

Official setup references: [OAuth production policy](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance),
[Gmail push](https://developers.google.com/workspace/gmail/api/guides/push),
[authenticated push](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions),
[verification requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

## Rollback and residual risks

Disable new connect/send/sync, cancel unattempted sends and stop/expire watches; preserve
accepted/unknown send records for reconciliation. Never resend because a release rolled back.
Restore compatible API/frontend while retaining additive tables/history and safe rendering or
redaction of provider email references. Credential revocation and user deletion must keep
working. Dropping tables/history needs a separate explicit destructive-data decision.

Remaining unverified: live OAuth, project quotas/billing, assessor price/timing, delivery/DSN
coverage, aliases, administrator restrictions, large-tenant costs, cloud identities, backup
expiry and customers' willingness to pay. No real Google operations or Gmail performance checks were executed in this local implementation pass.
