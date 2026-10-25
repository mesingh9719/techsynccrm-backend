# Google requirements and source register

Checked **25 October 2026** against official Google documentation. This is a dated research snapshot; repeat the scope/quotas check in the chosen Cloud project before implementation and each launch. NS = non-sensitive, S = sensitive, R = restricted, **U = exact classification unconfirmed in the public source**. U is a launch gate, not a guessed classification. Scope URIs below use prefix `https://www.googleapis.com/auth/` unless shown otherwise.

## Scope and verification matrix

Drive's guide explicitly groups its scopes by classification. Sheets' guide explicitly labels its scopes. NS still has branding, policy and project configuration obligations; it does not mean unrestricted public launch. R with server access to restricted data entails restricted verification and an annual approved assessment unless an actual exception applies. [Drive scope guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Sheets scope guide](https://developers.google.com/workspace/sheets/api/scopes), [restricted verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

| Scope | Class / evidence | Capability | Proposed use / verification consequence |
|---|---|---|---|
| `drive.file` | NS, explicit | App-created or explicitly selected/opened files | Phase 2 attachment links, selected folder saves and Sheets API operations. No broad-drive R assessment from this scope alone. |
| `drive.appdata` (`drive.appfolder` alias also documented) | NS, explicit | App-private configuration storage | Defer; Postgres already holds tenant configuration. Cannot replace visible customer document folders. |
| `drive.readonly` | R, explicit | Broad file reading/download | Drop from core roadmap; unnecessary for Picker-selected files. Server use would introduce assessment exposure. |
| `drive` | R, explicit | Broad file management | Drop from core roadmap; sharing selected files can use `drive.file`. |
| `drive.metadata.readonly` | R, explicit | Broad metadata reading | Drop. Metadata-only is **not** a verification shortcut. |
| `spreadsheets` | S, explicit | Read/write spreadsheet contents across accessible spreadsheets | Avoid; selected-file use works with `drive.file`. If later required, sensitive review before general public launch. |
| `spreadsheets.readonly` | S, explicit | Read accessible spreadsheets | Avoid; a read-only feature may still use selected-file `drive.file`, whose write capability must be accurately explained. |
| `openid`, `email`, `profile` | Identity scopes | Verify subject and show selected identity | Reuse identity flow; these are not service access. |
| `gmail.send` | S, explicit in Gmail guide | Sending only | Keep existing service consent/version independent. No new mailbox read grant in this plan. |

The existing optional `gmail.readonly` grant is R in the [Gmail scope guide](https://developers.google.com/workspace/gmail/api/auth/scopes). Its separate server-processing/review obligations do not become satisfied by enabling a new Workspace profile.

Calendar's official [scope guide](https://developers.google.com/workspace/calendar/api/auth) enumerates capabilities but **does not label each scope's sensitivity**. Google's [verification guide](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification) identifies Calendar event reading as sensitive and directs developers to Cloud Console Data Access for exact categorization. We could verify method compatibility, but not obtain the project's scope classification evidence. Do not market `calendar.app.created` or free/busy as confirmed verification-free. The following U rows conservatively budget standard sensitive review; none is presented as a verified R scope.

| Calendar scope | Class status | Capability / decision |
|---|---|---|
| `calendar.app.created` | U; sensitive launch gate until Console confirms | Create secondary calendars and manage their events. **Recommended minimum** for dedicated TechSync calendar CRUD and watch. Does not permit primary-calendar availability by itself. |
| `calendar.events.owned` | U; treat as S for rollout | Event CRUD on owned calendars; optional primary-calendar mode later. Wider access than CRM-linked events, so enforce application allowlist. |
| `calendar.events` | U; sensitive gate | Event CRUD across accessible calendars; defer shared/non-owned calendar support. |
| `calendar` | U; sensitive gate | Broad calendar administration and event access; drop from MVP. |
| `calendar.readonly` | S category supported by event-reading example; exact Console entry still required | Broad read-only calendars/events; drop from MVP. |
| `calendar.events.readonly` | S category supported by event-reading example; exact Console entry still required | Broad event reading; unnecessary with the selected write grant. |
| `calendar.events.owned.readonly` | U; sensitive gate | Read owned-calendar events; insufficient for writes. Defer. |
| `calendar.freebusy` | U; sensitive launch gate | Own-calendar availability. **Recommended incremental availability scope** when the user enables conflict checks. |
| `calendar.events.freebusy` | U; sensitive launch gate | Availability on accessible calendars; defer team/shared availability. |
| `calendar.calendarlist.readonly` | U; sensitive gate | List subscribed calendars; request only for optional existing-calendar selection. Not needed when storing a newly created calendar ID. |
| `calendar.calendarlist` | U; sensitive gate | Modify subscriptions; drop. |
| `calendar.calendars.readonly` / `calendar.calendars` | U; sensitive gate | Calendar properties / calendar creation and editing; avoid when `app.created` suffices. |
| `calendar.settings.readonly` | U; sensitive gate | Read Calendar settings; use CRM timezone settings instead. |
| `calendar.acls` / `calendar.acls.readonly` | U; sensitive gate | Calendar-sharing permissions; drop. |
| `calendar.events.public.readonly` | U; confirm if ever used | Public events; not a CRM scheduling need. |
| `calendar.addons.execute`, `calendar.addons.current.event.read`, `calendar.addons.current.event.write` | U; not applicable | Contextual add-on execution/access; this is a web CRM, not a Calendar add-on. |

Before coding the Calendar profile, an operator must enable Calendar API, manually add the exact candidate scopes to **Google Auth Platform → Data Access**, and record the displayed categories plus selected-project/client IDs in the release checklist. If Google classifies the narrow profile NS, remove the S-review gate for that exact profile only. If R appears, pause that scope and revisit design/budget. This verification gap does not block building against mocked APIs or a configured test-user pilot.

### Method compatibility and least privilege

`calendar.app.created` is accepted by [calendars.insert](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert), [events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) and [events.watch](https://developers.google.com/workspace/calendar/api/v3/reference/events/watch). Use the calendar ID returned on creation; do not request calendar-list access just to rediscover it. [freeBusy.query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query) accepts `calendar.freebusy` and `calendar.events.freebusy`; event-write scope alone is not listed for that operation. Availability therefore needs its own incremental grant.

Sheets API accepts `drive.file`, including writes to selected spreadsheets. That grant applies to a **file**, not an individual tab; sheet/range controls are application restrictions. User selection does not automatically grant colleagues Drive access, and selecting a folder does not justify assuming every existing descendant is accessible.

## Picker

Enable Drive API and Picker API. Use a browser API key restricted to the necessary APIs and documented website referrers, the OAuth web client, project **number** as Picker App ID, matching client/App-ID project, `setOAuthToken` and explicit origin. Current sample instructions include the CRM origin **and `https://docs.google.com/*`** because Picker uses an iframe. Configure development origins separately; do not use unrestricted wildcards. [Official web Picker setup](https://developers.google.com/workspace/drive/picker/guides/web-picker-sample).

The browser needs an access token for Picker; mint/use a separate **drive.file-only** online token rather than exposing a union Calendar/Gmail grant. Bind a short-lived selection session to current user/tenant/subject; validate chosen IDs with the server's file-scoped grant after selection. If the isolated token cannot establish authorization in a real same-project spike, stop and fix the grant design; never fall back to shipping the broad union token. Browser API key/client ID/App ID are public configuration; OAuth client secret, wrapping keys and refresh tokens remain server-only.

## Calendar push and incremental state

Calendar watches send bodyless HTTPS notifications with channel ID, optional token, resource ID/state and non-sequential message numbers. There is no Gmail Pub/Sub JWT to validate. Generate a random channel token, store its hash, verify it in constant time, match the resource/channel/generation, dedupe notifications and mark work due. A legitimate notification can arrive before the watch response: persist a pending channel before requesting it, buffer an early authenticated signal and reconcile returned resource ID. Use a publicly trusted HTTPS certificate. [Push guide](https://developers.google.com/workspace/calendar/api/guides/push).

The events-watch method currently documents a default TTL of **604800 seconds**; use the **returned** expiry as authoritative, schedule overlapping replacement channels before expiry and stop old channels. Polling remains a recovery path. Sync tokens are opaque; checkpoint `nextSyncToken` only after all pages are durable. A 410 requires rebaseline of the selected sync state, never deletion of CRM tasks. [Watch method](https://developers.google.com/workspace/calendar/api/v3/reference/events/watch), [incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync).

Do **not** combine `syncToken` with `privateExtendedProperty`, `q`, `timeMin` or `timeMax`. Dedicated-calendar mode can use collection sync and discard unlinked entries; primary-calendar mode should reconcile known linked event IDs rather than import a personal calendar collection. [events.list restrictions](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

Events have one organizer, determined by the main-copy calendar. ACLs and organizer status control changes/invitations; CRM assignment is not ownership transfer. Meet creation uses Calendar conference data (`conferenceDataVersion=1` with a stable create-request ID), with pending/success/failure handling and account/calendar capabilities checked. It does not require adding Meet recording/transcript scopes. [Event ownership](https://developers.google.com/workspace/calendar/api/concepts/events-calendars), [conference creation](https://developers.google.com/workspace/calendar/api/guides/create-events).

## Quotas, batching and costs

These are documented defaults, **not proof of this project's effective quotas**. Measure project, user and method usage independently; cap pilot traffic below defaults and verify Cloud Console before launch.

| API | Current documented quota | Design implication |
|---|---|---|
| Sheets | Separately: 300 read and 300 write requests/min/project; 60 read and 60 write/min/user/project. Recommended request payload <=2 MB; processing timeout 180 seconds. | Batch rows/cells; bounded reads; start around 500 rows/batch and adapt to byte size. Atomic request failure must not advance a checkpoint. |
| Drive, new quota cohort | 1,000,000 quota units/min/project; 325,000/min/user/project; 1 TB project daily egress; 400,000,000 daily quota-unit billing threshold. Examples: get 5, list 100, update 50 units. | Budget **units**, not the old 12,000-request rule. Avoid broad lists and content downloads. Recheck effective cohort and costs. |
| Calendar, new quota cohort | 10,000 requests/min/project; 600/min/user/project; 1,000,000 requests/day billing threshold. Calendar operational/anti-abuse limits also apply. | Serialize mutations per calendar; jitter polling and renewals. Availability checks are not atomic reservations. |

Sources: [Sheets limits](https://developers.google.com/workspace/sheets/api/limits), [Drive limits](https://developers.google.com/workspace/drive/api/guides/limits), [Calendar limits](https://developers.google.com/workspace/calendar/api/guides/quota). Google documents May 1, 2026 cohort changes and future billing with notice; it does **not** justify promising permanently free/unlimited APIs. Existing project quotas may differ. Record current billing thresholds/rates when available; no billable quota increase is approved by this plan. [2026 standardized model](https://developers.google.com/workspace/tools-safety).

Use bounded exponential backoff with full jitter, honor Retry-After, distinguish 403 quota reasons from permission/policy denial, and retry 429/appropriate 5xx. Reconcile an uncertain write before retrying it. `values.append` can duplicate after an ambiguous timeout; Sheets has no universal append idempotency key. Use RAW writes plus formula neutralization for external text. [Calendar errors](https://developers.google.com/workspace/calendar/api/guides/errors), [Sheets input modes](https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueInputOption).

## Policy, verification and rollout facts

- Limited Use restricts API data to disclosed user-facing purposes and imposes transfer/human-access limits. No advertising, sale, general model training or unrelated analytics using Google-derived content; require user-facing notices and current policy review. [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy).
- Homepage, privacy policy, verified domains, accurate branding, working support contact, scope justification and a consent-to-feature demo are review inputs. A published local React route is not proof the public page is crawlable or accepted. [Verification requirements](https://support.google.com/cloud/answer/13464321).
- External apps in Testing generally issue service-scope refresh tokens that expire after seven days. Google currently documents 100 refresh tokens per account/client; repeated consent can evict the oldest. Retain usable credentials appropriately and avoid prompting on every visit. [OAuth token lifecycle](https://developers.google.com/identity/protocols/oauth2).
- An unverified-app cap is currently 100 new users in total when its warning applies; it is not a production customer-growth plan or equivalent to the explicit test-user list. Testing pilots are controlled test use, not general commercial availability. [Unverified apps](https://support.google.com/cloud/answer/7454865).
- Incremental authorization can include older grants. Provider revoke invalidates scopes/tokens across clients **in the project**; separate client IDs inside one project do not isolate revocation. [Web-server OAuth / revocation](https://developers.google.com/identity/protocols/oauth2/web-server).
- Per-user OAuth fits consumer Gmail and independent SME domains. DWD requires a Workspace super-admin authorization and does not serve consumer Gmail. Workspace admins can trust, limit, allow selected Google data or block OAuth clients; verification does not override their policy. [DWD](https://knowledge.workspace.google.com/admin/apps/control-api-access-with-domain-wide-delegation), [app access controls](https://knowledge.workspace.google.com/admin/apps/control-which-apps-access-google-workspace-data).

### Timing and budget assumptions, not Google guarantees

Google's sensitive-verification guide says typically 3–5 business days for review; budget **2–6 elapsed weeks** including preparation/replies, and longer if rejected. Restricted review plus assessment: budget **6–16+ weeks** and annual renewal/remediation. Google provides no universal assessor tariff on the reviewed pages: a provisional **US$5,000–25,000 annual assessment allowance**, plus 10–30 engineering days for preparation/remediation, is a budgeting assumption only, not a verified market price or quote; actual tier/scope/vendor costs can fall outside it. Obtain approved-assessor quotes before any R feature is funded. Core `drive.file` features do not introduce this R assessment requirement by themselves. Calendar S verification does not by itself mean CASA.
