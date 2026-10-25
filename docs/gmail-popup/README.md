# Gmail popup completion fix

25 October 2026. A successful Gmail consent could leave the CRM open inside the authorization popup. The frontend return page relied on `window.opener`; Google/browser Cross-Origin-Opener-Policy isolation can remove that reference. Without it, the page followed its normal full-page redirect into the CRM.

The connection now generates a random popup attempt ID. Both Gmail OAuth start interfaces accept an optional UUID-v4 `popupId`; it is included in the server-generated, hashed, browser-bound one-use OAuth state. Only a verified state supplies the attempt ID and workspace to the frontend callback, including verified cancellation/failure. Invalid/tampered state does not reflect the ID. Existing clients without the optional field retain their callback behavior. No scope, callback URL, Google Console or database migration change is needed.

The popup callback publishes a matching completion through opener messaging, same-origin BroadcastChannel and storage events, then closes itself even when its opener is missing. A sessionStorage marker supports older callbacks. A regular full-page callback still navigates back to its allowed return path. If a browser refuses scripted closing, the callback keeps its confirmation/return link instead of automatically loading a CRM page inside a known popup.

The original page accepts only its current attempt/workspace and fresh completion data, rechecks authenticated mailbox state, invalidates its Gmail queries and updates in place. It does not reload or navigate, preserving current page/draft state. Bounded server-state polling remains a fallback and requires a changed account identity/connection timestamp; an already connected mailbox is not sufficient evidence of a fresh reconnect. Cancellation, failure, timeout, user/workspace changes and unmount clean up listeners and attempt state.

## Verification

- Full backend suite: **482 passed, 2 optional skipped**, 49 test files.
- Frontend Node tests: all 4 test files passed, including attempt/workspace/expiry validation and scoped storage cleanup.
- Frontend production build passed. Lint passed with the existing 10 warnings in unrelated files.
- Chrome verified seven flows: normal popup, actual COOP-isolated Google page with no opener, storage-only completion, polling-only recovery, denied consent, cancellation and legacy callback without an attempt query. Each popup closed; the original URL and an in-memory draft marker survived. The isolated callback deliberately cleared its sessionStorage marker to exercise the server-carried attempt ID. [Browser results](evidence/browser-results.json), [original page after completion](evidence/original-page-updated.png).
- Backend HTTP/database tests verify the authenticated attempt/workspace redirect, cancellation, rejected invalid IDs and no ID reflection for tampered state. Google methods are mocked, using synthetic disposable localhost Postgres only.

Browser reproduction: run the frontend on port 5182, then `node test/gmail-popup.browser.mjs`. Override `EMAIL_QA_URL`, `PLAYWRIGHT_MODULE` or `QA_OUTPUT` as needed. All Google/application API responses in that browser harness are synthetic; the backend's real state/session checks are covered separately by integration tests.

After updating a running development session, close the old Google popup, reload the original CRM page once and start a fresh connection. Old already-open authorization attempts may not carry the new attempt identifier.
