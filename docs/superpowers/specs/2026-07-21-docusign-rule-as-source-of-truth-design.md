# DocuSign: the FXBO rule as the single source of truth

**Date:** 2026-07-21
**Status:** Approved design (pre-implementation)
**Module:** `docusign/` + the Back Office DocuSign panel

## Summary

Make the FXBO Assistant rule the **only** decider of who receives a DocuSign document. Our system executes what the rule tells it and reports what happened — it never independently decides.

Concretely: **delete the send poller**, **keep the reconcile poller**, and replace the lost safety net with **visibility** — record every inbound webhook and surface it in the Back Office panel.

## Why

The send poller (`docusign/sync.js`) independently queries FXBO for approved applications of a hardcoded `type = "docusign"` and sends envelopes. That duplicates a decision the FXBO rule already owns, and the hardcoded type is invisible from the CRM.

It is also, today, actively useless and misleading:

- The live flow moved to **Account Acknowledgement** (configs 35/52/53) on 17 July. The poller only looks at `type = "docusign"` (config 48, the legacy form), so it has **not covered the current flow at all**.
- This was discovered when application **3963** (approved 2026-07-21 17:28, config 52) produced no envelope and nothing retried it. The client received no document until it was sent manually.
- Throughout the day it was repeatedly assumed the poller was "covering" webhook failures. It was not. That false safety net is worse than no safety net.

## Root cause of the 2026-07-21 outage (context, no code change)

Renaming config #52 changed the application **`type` string** for newly created applications:

| Application | Created | `type` |
|---|---|---|
| 3959 (cfg 52) | 19 Jul | `Account Acknowledgement` |
| 3963 (cfg 52) | 21 Jul 17:28 | `Account Acknowledgement SCA-MAU` |

The FXBO rule resolves on that `type` string, so after the rename it no longer matched newly created applications and stopped firing. **Fix is in FXBO** (re-select the Application type in rule #36), not in code. Recorded here because it is the failure this design makes visible.

## Decisions

- **Delete the send poller.** The rule owns "who".
- **Keep the reconcile poller.** It detects signatures and drives the signed-PDF→CRM upload. It does not decide who gets anything. DocuSign has **zero Connect configurations**, so the completion webhook never fires — the reconcile poller is the only mechanism that notices a client signed. Deleting it would silently break the CRM upload.
- **Replace the safety net with visibility**, not with another independent sender.
- Keep the **duplicate guard** (protects against FXBO retries or a rule firing twice) and the **webhook payload diagnostics**.

## Scope

### 1. Remove the send poller

Delete `docusign/sync.js` and every surface that exists only to serve it:

| Location | What goes |
|---|---|
| `server.js:17` | `import { startDocusignApprovedSyncScheduler } from "./docusign/sync.js"` |
| `server.js:897` | `startDocusignApprovedSyncScheduler();` |
| `docusign/router.js:9` | `import { getDocusignSyncState, runApprovedApplicationsSync } from "./sync.js"` |
| `docusign/router.js:175` | `GET /sync-status` handler |
| `docusign/router.js:424` | `POST /sync-approved-applications` handler |
| `docusign/router.js:456` | `POST /run-sync` handler |
| `src/lib/docusignApi.ts:52` | `runDocusignSyncNow()` |
| `BackOfficeDepartment.tsx:37,256,257,2546,2554,2557,2559` | the **"Run sync now"** button, `docusignSyncing`, `docusignSyncMsg` |
| `docusign/duplicateGuard.test.js` | tests importing `processApprovedApplications` — rewritten against the webhook path (see Testing) |

Env vars `DOCUSIGN_AUTO_SYNC_ENABLED`, `DOCUSIGN_AUTO_SYNC_INTERVAL_SECONDS`, `DOCUSIGN_AUTO_SYNC_RUN_ON_START` and `DOCUSIGN_SYNC_LOOKBACK_MINUTES` become dead and should be removed from `.env` (operator action, noted in the plan).

One-off backfills (as done for 3963) remain deliberate scripts, not a standing job.

### 2. Record every inbound webhook

New table `docusign_webhook_log`, created in `initDocusignStore()` alongside the existing tables:

```
id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY
received_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
outcome       VARCHAR(20)  NOT NULL   -- 'sent' | 'skipped' | 'rejected'
http_status   SMALLINT     NOT NULL
error         VARCHAR(100) NULL       -- reason code for BOTH rejected and skipped outcomes:
                                      -- rejected: 'applicationId_invalid', 'signer_email_required', 'unauthorized_webhook', …
                                      -- skipped:  'already_sent', 'client_has_outstanding_envelope'
                                      -- NULL only when outcome='sent'
application_id VARCHAR(255) NULL      -- normalized when available, else raw (truncated)
applicant_email VARCHAR(255) NULL
envelope_id   VARCHAR(255) NULL       -- present when outcome='sent'
payload       TEXT NULL               -- JSON of received fields, truncated to 2000 chars
INDEX idx_docusign_webhook_log_received_at (received_at)
```

Every call to `POST /webhooks/fxbo/application-approved` writes exactly one row, on **all** outcomes:

| Outcome | When |
|---|---|
| `sent` | an envelope was created |
| `skipped` | idempotent hit (application already has an envelope) or the duplicate guard blocked it |
| `rejected` | any 4xx (`applicationId_required`, `applicationId_invalid`, `signer_email_required`, `signer_name_required`, `unauthorized_webhook`) |

Writing is **best-effort**: wrapped in `try/catch` so a logging failure can never affect the send path or the HTTP response.

**Retention:** after each insert, delete rows beyond the most recent 500 (single `DELETE ... WHERE id NOT IN (SELECT ... ORDER BY id DESC LIMIT 500)` equivalent). Bounded storage, no cron needed.

### 3. Surface it in the Back Office panel

`GET /overview` gains a `webhook` object:

```json
"webhook": {
  "lastReceivedAt": "2026-07-21T17:28:57.000Z",
  "lastOutcome": "sent",
  "ageHours": 2.4,
  "stale": false,
  "rejected7d": 3,
  "recent": [ { "receivedAt": "...", "outcome": "rejected", "error": "applicationId_invalid" } ]
}
```

`stale` is `true` when the most recent webhook is older than **72 hours**, or when no webhook has ever been received. 72h is chosen against observed volume (roughly 1–3 approvals per week in the current data), so a normal quiet weekend does not raise a false alarm.

The DocuSign card shows one line beneath the existing tiles:

- healthy → `Rule webhook: last received 2h ago` (muted)
- stale → `⚠ Rule webhook: none in 6 days` (amber/rose)
- with rejections → append `· 3 rejected (7d)`

This single line is what was missing on 2026-07-21: the rule went quiet and nothing showed it.

## Data flow after the change

```
FXBO rule (decides WHO)
   → POST /webhooks/fxbo/application-approved
       → guards: valid application id → not already sent → client has no outstanding envelope
       → createEnvelopeFromTemplate → store envelope
       → log row (sent | skipped | rejected)   [always]

reconcile poller (every 300s)
   → DocuSign listStatusChanges → onEnvelopeStatus
       → on 'completed' → download signed PDF → upload to FXBO document config 73
```

Only one path creates envelopes. The reconcile poller never creates one.

## Error handling

- Webhook logging failures are swallowed (logged to console) and never alter the response.
- Retention pruning failures are swallowed.
- If `docusign_webhook_log` is empty or unreadable, `/overview` reports `lastReceivedAt: null`, `stale: true` — an absent log reads as "no signal", never as "healthy".
- Removing the send poller must not change any existing webhook behaviour: guards, status codes and response bodies stay exactly as they are.

## Testing

- **Unit (vitest), pure:** a `buildWebhookLogEntry({ outcome, httpStatus, error, applicationId, applicantEmail, envelopeId, payload })` helper — asserts field capture, `payload` truncation at 2000 chars, and that a `rejected` entry still records the raw application id it was given.
- **Unit, pure:** `summariseWebhookHealth(rows, now)` — returns `{ lastReceivedAt, lastOutcome, ageHours, stale, rejected7d }`. Cases: empty table → `stale: true`; last received 2h ago → `stale: false`; 73h ago → `stale: true`; rejection counting inside/outside the 7-day window.
- **Unit, mocked store:** the webhook handler writes exactly one log row per call for each of `sent` / `skipped` / `rejected`, and a throwing logger does not change the HTTP status or body.
- **Regression:** the duplicate-guard tests currently exercise `processApprovedApplications` (deleted). Rewrite them against the webhook path so the guard stays covered.
- **Live:** approve one application → a `sent` row appears and the panel timestamp updates; trigger FXBO's **Test webhook** → a `rejected` row appears and the panel rejection count increments.

## New / changed files

- New: `docusign/webhookLog.js` (pure builders + store-backed insert/prune/summary), `docusign/webhookLog.test.js`
- Edit: `docusign/store.js` (table creation, insert/prune/query), `docusign/router.js` (log on every outcome; remove the three sync routes and the sync import), `server.js` (remove the scheduler import and call), `src/lib/docusignApi.ts` (remove `runDocusignSyncNow`, extend the overview type), `src/components/dashboard/BackOfficeDepartment.tsx` (remove the Run-sync button, add the webhook-health line)
- Delete: `docusign/sync.js`
- Rewrite: `docusign/duplicateGuard.test.js`

## Out of scope

- Email/Telegram alerting on staleness — the panel line is the signal for now; alerting can build on the same `webhook` payload later.
- Any change to the reconcile poller, the CRM upload, the duplicate guard, or the Connect webhook.
- Fixing the FXBO rule binding (operator action in FXBO).
- Per-entity DocuSign templates (St Vincent vs Mauritius) — still open, tracked separately.
