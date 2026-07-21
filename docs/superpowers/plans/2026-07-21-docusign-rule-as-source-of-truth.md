# DocuSign: Rule as Single Source of Truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the FXBO Assistant rule the only decider of who receives a DocuSign document — delete the send poller, and replace the lost safety net with visibility into every inbound webhook.

**Architecture:** Remove `docusign/sync.js` and every surface that exists only to serve it. Add a `docusign_webhook_log` table written on **every** webhook outcome (best-effort, never affecting the response), plus pure helpers that build log entries and summarise webhook health. Surface that health as one line in the Back Office DocuSign card.

**Tech Stack:** Node ESM, Express, mysql2, vitest, React + TypeScript.

**Spec:** `docs/superpowers/specs/2026-07-21-docusign-rule-as-source-of-truth-design.md`

## Global Constraints

- **Only one path may create envelopes** after this change: the FXBO webhook. The reconcile poller (`docusign/reconcile.js`) must be left **completely untouched** — DocuSign has zero Connect configurations, so it is the only mechanism that detects a signature and drives the signed-PDF→CRM upload. Deleting or altering it silently breaks that feature.
- **Existing webhook behaviour must not change**: every guard, HTTP status code and response body stays exactly as it is today. This change only *adds* logging around them.
- **Logging is best-effort**: every log write and prune is wrapped in `try/catch`. A logging failure must never change the HTTP status, the response body, or whether an envelope is sent.
- `outcome` is exactly one of `'sent' | 'skipped' | 'rejected'`.
- `error` carries a reason code for **both** `rejected` and `skipped`; it is `NULL` **only** when `outcome === 'sent'`.
- Retention: keep the most recent **500** rows of `docusign_webhook_log`.
- `payload` is JSON of the received fields, truncated to **2000** characters.
- Staleness threshold: **72 hours**. No webhook ever received ⇒ `stale: true` (absent signal never reads as healthy).
- Rejection counting window: **7 days**.
- The **duplicate guard** and the **webhook payload diagnostics** (`describeWebhookPayload`) stay.
- `npx tsc --noEmit -p tsconfig.json` must stay clean; `npx vitest run` must pass after every task.
- Branch `feat/docusign-webhook-visibility` off `main`. Never push (Abbas pushes).

## Existing code anchors

**`docusign/store.js`** — module-private helpers already exist: `run(sql, params)`, `get(sql, params)` (returns first row or `null`), `all(sql, params)` (returns array). `initDocusignStore()` creates tables at line ~67 and sets `initialized = true` at line ~98. Exports include `findByApplicationId`, `findOutstandingEnvelopeForEmail`, `upsertEnvelopeMap`, `getDocusignPool`.

**`docusign/router.js`** — the FXBO webhook handler is `router.post("/webhooks/fxbo/application-approved", ...)` starting line ~301. Its exit points, in order:

| Line | Exit | Outcome to log | Reason code |
|---|---|---|---|
| 304 | `401 unauthorized_webhook` | `rejected` | `unauthorized_webhook` |
| 343 | `400 applicationId_required` / `applicationId_invalid` (shared block) | `rejected` | the `error` value returned |
| 350 | `400 signer_email_required` | `rejected` | `signer_email_required` |
| 351 | `400 signer_name_required` | `rejected` | `signer_name_required` |
| 355 | `200 idempotent: true` | `skipped` | `already_sent` |
| 367 | `200 skipped: true` (duplicate guard) | `skipped` | `client_has_outstanding_envelope` |
| 398 | `200` success | `sent` | `null` |
| 289 | `500 docusign_send_failed` (catch block) | `rejected` | `docusign_send_failed` |

Also in `router.js`: line 9 imports `getDocusignSyncState, runApprovedApplicationsSync` from `./sync.js`; line 175 is `GET /sync-status`; line 424 is `POST /sync-approved-applications`; line 456 is `POST /run-sync`. `bucketEnvelopes` and the `GET /overview` handler are also here.

**`server.js`** — line 17 imports `startDocusignApprovedSyncScheduler`; line 897 calls it.

**Frontend** — `src/lib/docusignApi.ts:52` `runDocusignSyncNow()`; `src/components/dashboard/BackOfficeDepartment.tsx` line 37 (import), 256–257 (`docusignSyncing`, `docusignSyncMsg` state), 2546/2554/2557/2559 (the Run-sync button).

---

## Task 1: Pure webhook-log helpers

**Files:** Create `docusign/webhookLog.js`, `docusign/webhookLog.test.js`.

**Interfaces:**
- Produces: `buildWebhookLogEntry(input) -> entry`, `summariseWebhookHealth(rows, now) -> summary`, `WEBHOOK_STALE_HOURS`, `WEBHOOK_REJECTION_WINDOW_DAYS`, `WEBHOOK_LOG_RETENTION`, `WEBHOOK_PAYLOAD_MAX_CHARS`.

- [ ] **Step 1: Write the failing test** — `docusign/webhookLog.test.js`:

```js
import { describe, expect, it } from "vitest";
import { buildWebhookLogEntry, summariseWebhookHealth } from "./webhookLog.js";

describe("buildWebhookLogEntry", () => {
  it("builds a sent entry with a null error", () => {
    const e = buildWebhookLogEntry({
      outcome: "sent",
      httpStatus: 200,
      applicationId: "3963",
      applicantEmail: "A@B.com",
      envelopeId: "env-1",
      payload: { applicationId: "3963" },
    });
    expect(e.outcome).toBe("sent");
    expect(e.httpStatus).toBe(200);
    expect(e.error).toBeNull();
    expect(e.applicationId).toBe("3963");
    expect(e.applicantEmail).toBe("a@b.com");
    expect(e.envelopeId).toBe("env-1");
    expect(JSON.parse(e.payload)).toEqual({ applicationId: "3963" });
  });

  it("records the reason code for a rejected entry", () => {
    const e = buildWebhookLogEntry({
      outcome: "rejected",
      httpStatus: 400,
      error: "applicationId_invalid",
      applicationId: "Application ID + Link",
      payload: {},
    });
    expect(e.outcome).toBe("rejected");
    expect(e.error).toBe("applicationId_invalid");
    // the raw, unusable id is still recorded so it can be diagnosed later
    expect(e.applicationId).toBe("Application ID + Link");
    expect(e.envelopeId).toBeNull();
  });

  it("records the reason code for a skipped entry", () => {
    const e = buildWebhookLogEntry({
      outcome: "skipped",
      httpStatus: 200,
      error: "client_has_outstanding_envelope",
      applicationId: "3963",
      payload: {},
    });
    expect(e.outcome).toBe("skipped");
    expect(e.error).toBe("client_has_outstanding_envelope");
  });

  it("truncates the payload to 2000 characters", () => {
    const e = buildWebhookLogEntry({
      outcome: "rejected",
      httpStatus: 400,
      error: "x",
      payload: { big: "y".repeat(5000) },
    });
    expect(e.payload.length).toBe(2000);
  });

  it("tolerates a payload that cannot be serialised", () => {
    const circular = {};
    circular.self = circular;
    const e = buildWebhookLogEntry({ outcome: "rejected", httpStatus: 400, error: "x", payload: circular });
    expect(typeof e.payload).toBe("string");
  });

  it("nulls missing optional fields and truncates over-long ids", () => {
    const e = buildWebhookLogEntry({ outcome: "rejected", httpStatus: 401, error: "unauthorized_webhook" });
    expect(e.applicationId).toBeNull();
    expect(e.applicantEmail).toBeNull();
    expect(e.envelopeId).toBeNull();
    const long = buildWebhookLogEntry({ outcome: "sent", httpStatus: 200, applicationId: "z".repeat(400) });
    expect(long.applicationId.length).toBe(255);
  });
});

describe("summariseWebhookHealth", () => {
  const now = new Date("2026-07-21T18:00:00Z");
  const row = (iso, outcome = "sent", error = null) => ({ received_at: iso, outcome, error });

  it("reports stale with no rows at all", () => {
    const s = summariseWebhookHealth([], now);
    expect(s.lastReceivedAt).toBeNull();
    expect(s.stale).toBe(true);
    expect(s.rejected7d).toBe(0);
  });

  it("is healthy when the last webhook was 2 hours ago", () => {
    const s = summariseWebhookHealth([row("2026-07-21T16:00:00Z")], now);
    expect(s.stale).toBe(false);
    expect(Math.round(s.ageHours)).toBe(2);
    expect(s.lastOutcome).toBe("sent");
  });

  it("is stale at 73 hours and healthy at 71", () => {
    expect(summariseWebhookHealth([row("2026-07-18T17:00:00Z")], now).stale).toBe(true);
    expect(summariseWebhookHealth([row("2026-07-18T19:00:00Z")], now).stale).toBe(false);
  });

  it("counts rejections inside the 7-day window only", () => {
    const s = summariseWebhookHealth(
      [
        row("2026-07-21T17:00:00Z", "rejected", "applicationId_invalid"),
        row("2026-07-20T10:00:00Z", "rejected", "signer_email_required"),
        row("2026-07-01T10:00:00Z", "rejected", "applicationId_invalid"), // outside window
        row("2026-07-20T09:00:00Z", "sent"),
      ],
      now
    );
    expect(s.rejected7d).toBe(2);
  });

  it("uses the newest row regardless of input order", () => {
    const s = summariseWebhookHealth(
      [row("2026-07-19T10:00:00Z", "rejected", "x"), row("2026-07-21T17:00:00Z", "sent")],
      now
    );
    expect(s.lastOutcome).toBe("sent");
  });

  it("ignores rows with an unparseable timestamp", () => {
    const s = summariseWebhookHealth([row("not-a-date"), row("2026-07-21T17:00:00Z")], now);
    expect(s.lastOutcome).toBe("sent");
    expect(s.stale).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing)

Run: `npx vitest run docusign/webhookLog.test.js`

- [ ] **Step 3: Create `docusign/webhookLog.js`**

```js
export const WEBHOOK_STALE_HOURS = 72;
export const WEBHOOK_REJECTION_WINDOW_DAYS = 7;
export const WEBHOOK_LOG_RETENTION = 500;
export const WEBHOOK_PAYLOAD_MAX_CHARS = 2000;

const trunc = (value, max) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
};

/**
 * Shape one inbound-webhook log row.
 * `error` is a reason code for BOTH rejected and skipped outcomes, and is null
 * only for a successful send.
 */
export function buildWebhookLogEntry({ outcome, httpStatus, error, applicationId, applicantEmail, envelopeId, payload } = {}) {
  let serialised = "";
  try {
    serialised = JSON.stringify(payload ?? {});
  } catch {
    serialised = '{"unserialisable":true}';
  }
  const email = trunc(applicantEmail, 255);
  return {
    outcome: String(outcome || "rejected"),
    httpStatus: Number(httpStatus) || 0,
    error: outcome === "sent" ? null : (trunc(error, 100) ?? null),
    applicationId: trunc(applicationId, 255),
    applicantEmail: email ? email.toLowerCase() : null,
    envelopeId: trunc(envelopeId, 255),
    payload: String(serialised).slice(0, WEBHOOK_PAYLOAD_MAX_CHARS),
  };
}

/**
 * Health of the inbound webhook, derived from recent log rows.
 * An absent signal is reported as stale — never as healthy.
 */
export function summariseWebhookHealth(rows, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const parsed = (Array.isArray(rows) ? rows : [])
    .map((r) => ({ ...r, ts: Date.parse(String(r?.received_at ?? "")) }))
    .filter((r) => Number.isFinite(r.ts))
    .sort((a, b) => b.ts - a.ts);

  if (!parsed.length) {
    return { lastReceivedAt: null, lastOutcome: null, ageHours: null, stale: true, rejected7d: 0 };
  }

  const newest = parsed[0];
  const ageHours = (nowMs - newest.ts) / 3_600_000;
  const windowStart = nowMs - WEBHOOK_REJECTION_WINDOW_DAYS * 24 * 3_600_000;

  return {
    lastReceivedAt: new Date(newest.ts).toISOString(),
    lastOutcome: String(newest.outcome || ""),
    ageHours,
    stale: ageHours > WEBHOOK_STALE_HOURS,
    rejected7d: parsed.filter((r) => r.ts >= windowStart && String(r.outcome) === "rejected").length,
  };
}
```

- [ ] **Step 4: Run it — expect PASS (13 tests)**

Run: `npx vitest run docusign/webhookLog.test.js`

- [ ] **Step 5: Commit**

```bash
git add docusign/webhookLog.js docusign/webhookLog.test.js
git commit -m "feat(docusign): pure webhook log entry + health summary helpers"
```

---

## Task 2: Store — the `docusign_webhook_log` table

**Files:** Modify `docusign/store.js`.

**Interfaces:**
- Consumes: `buildWebhookLogEntry` output shape (Task 1).
- Produces: `recordWebhookCall(entry) -> void`, `listWebhookLog(limit = 50) -> rows` (each row has `received_at`, `outcome`, `error`, `application_id`, `applicant_email`, `envelope_id`).

- [ ] **Step 1: Create the table** — in `docusign/store.js`, inside `initDocusignStore()`, after the existing `CREATE TABLE`/`CREATE INDEX` statements and **before** `initialized = true;`, add:

```js
  await run(`
    CREATE TABLE IF NOT EXISTS docusign_webhook_log (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      outcome VARCHAR(20) NOT NULL,
      http_status SMALLINT NOT NULL DEFAULT 0,
      error VARCHAR(100) NULL,
      application_id VARCHAR(255) NULL,
      applicant_email VARCHAR(255) NULL,
      envelope_id VARCHAR(255) NULL,
      payload TEXT NULL,
      PRIMARY KEY (id),
      INDEX idx_docusign_webhook_log_received_at (received_at)
    )
  `);
```

- [ ] **Step 2: Add the writer and reader** — append to `docusign/store.js`:

```js
/**
 * Best-effort: never let a logging failure affect the webhook response.
 * Prunes to the newest WEBHOOK_LOG_RETENTION rows after each insert.
 */
export async function recordWebhookCall(entry) {
  try {
    await run(
      `INSERT INTO docusign_webhook_log
         (outcome, http_status, error, application_id, applicant_email, envelope_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        String(entry?.outcome || "rejected"),
        Number(entry?.httpStatus) || 0,
        entry?.error ?? null,
        entry?.applicationId ?? null,
        entry?.applicantEmail ?? null,
        entry?.envelopeId ?? null,
        entry?.payload ?? null,
      ]
    );
    // Derived table wrapper is required: MySQL cannot use a LIMIT subquery on the
    // same table it is deleting from.
    await run(
      `DELETE FROM docusign_webhook_log
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id FROM docusign_webhook_log ORDER BY id DESC LIMIT ${WEBHOOK_LOG_RETENTION}
          ) AS keep
        )`
    );
  } catch (error) {
    console.error("[docusign-webhook-log] write failed:", error instanceof Error ? error.message : String(error));
  }
}

export async function listWebhookLog(limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  try {
    return await all(
      `SELECT received_at, outcome, http_status, error, application_id, applicant_email, envelope_id
         FROM docusign_webhook_log
        ORDER BY id DESC
        LIMIT ?`,
      [safeLimit]
    );
  } catch (error) {
    console.error("[docusign-webhook-log] read failed:", error instanceof Error ? error.message : String(error));
    return [];
  }
}
```

Add the import at the top of `docusign/store.js`:

```js
import { WEBHOOK_LOG_RETENTION } from "./webhookLog.js";
```

- [ ] **Step 3: Verify the module loads and the table is created**

Run: `node --env-file=.env -e "import('./docusign/store.js').then(async m => { await m.initDocusignStore(); const pool = await m.getDocusignPool(); const [r] = await pool.query('SHOW TABLES LIKE \"docusign_webhook_log\"'); console.log('table exists:', r.length === 1); const rows = await m.listWebhookLog(5); console.log('rows:', rows.length); process.exit(0); })"`

Expected: `table exists: true` and `rows: 0`.

- [ ] **Step 4: Commit**

```bash
git add docusign/store.js
git commit -m "feat(docusign): docusign_webhook_log table with bounded retention"
```

---

## Task 3: Log every webhook outcome

**Files:** Modify `docusign/router.js`.

**Interfaces:**
- Consumes: `buildWebhookLogEntry` (Task 1), `recordWebhookCall` (Task 2).

Every exit point of `router.post("/webhooks/fxbo/application-approved", ...)` must write exactly one log row. Do **not** change any status code or response body.

- [ ] **Step 1: Add imports** to `docusign/router.js`:

```js
import { buildWebhookLogEntry } from "./webhookLog.js";
```
and add `recordWebhookCall` to the existing `./store.js` import list.

- [ ] **Step 2: Add a local helper** just above `router.post("/webhooks/fxbo/application-approved", ...)`:

```js
/**
 * Log one inbound-webhook outcome and return the response, so every exit point
 * is recorded with a single expression. Logging is awaited but never throws —
 * recordWebhookCall swallows its own errors.
 */
async function logAndRespond(res, { status, body, outcome, error, applicationId, applicantEmail, envelopeId, payload }) {
  await recordWebhookCall(
    buildWebhookLogEntry({ outcome, httpStatus: status, error, applicationId, applicantEmail, envelopeId, payload })
  );
  return res.status(status).json(body);
}
```

- [ ] **Step 3: Route each exit point through it.** Replace each `return res...` in that handler as follows (bodies unchanged):

Auth failure (currently line ~304):
```js
      return logAndRespond(res, {
        status: 401,
        body: { ok: false, error: "unauthorized_webhook", reason: authCheck.reason },
        outcome: "rejected",
        error: "unauthorized_webhook",
        payload: Object.assign({}, req.query || {}, req.body || {}),
      });
```

The shared applicationId rejection (currently line ~343) — keep the existing `debug` computation and body, and wrap the return:
```js
      const errorCode = !rawApplicationId ? "applicationId_required" : "applicationId_invalid";
      return logAndRespond(res, {
        status: 400,
        body: { ok: false, error: errorCode, received: rawApplicationId.slice(0, 120), debug },
        outcome: "rejected",
        error: errorCode,
        applicationId: rawApplicationId,
        applicantEmail: signerEmail,
        payload: p,
      });
```

Signer guards (currently lines ~350–351):
```js
    if (!signerEmail) {
      return logAndRespond(res, {
        status: 400,
        body: { ok: false, error: "signer_email_required" },
        outcome: "rejected",
        error: "signer_email_required",
        applicationId,
        payload: p,
      });
    }
    if (!signerName) {
      return logAndRespond(res, {
        status: 400,
        body: { ok: false, error: "signer_name_required" },
        outcome: "rejected",
        error: "signer_name_required",
        applicationId,
        applicantEmail: signerEmail,
        payload: p,
      });
    }
```

Idempotent hit (currently line ~355):
```js
    if (existing?.envelope_id) {
      return logAndRespond(res, {
        status: 200,
        body: { ok: true, idempotent: true, applicationId, envelopeId: existing.envelope_id, status: existing.status },
        outcome: "skipped",
        error: "already_sent",
        applicationId,
        applicantEmail: signerEmail,
        envelopeId: existing.envelope_id,
        payload: p,
      });
    }
```

Duplicate guard (currently line ~367) — keep the existing `console.log`, then:
```js
      return logAndRespond(res, {
        status: 200,
        body: {
          ok: true,
          skipped: true,
          reason: "client_has_outstanding_envelope",
          applicationId,
          existingEnvelopeId: outstanding.envelope_id,
          existingApplicationId: outstanding.application_id,
          status: outstanding.status,
        },
        outcome: "skipped",
        error: "client_has_outstanding_envelope",
        applicationId,
        applicantEmail: signerEmail,
        envelopeId: outstanding.envelope_id,
        payload: p,
      });
```

Success (currently line ~398) — keep the existing body exactly, and wrap:
```js
    return logAndRespond(res, {
      status: 200,
      body: { ok: true, applicationId, envelopeId: created.envelopeId, status: created.status, record: row },
      outcome: "sent",
      applicationId,
      applicantEmail: signerEmail,
      envelopeId: created.envelopeId,
      payload: p,
    });
```

The `catch` block (currently line ~289 region, the handler's own catch) — keep its body and wrap:
```js
    return logAndRespond(res, {
      status: 500,
      body: { ok: false, error: "docusign_send_failed", message: error instanceof Error ? error.message : String(error) },
      outcome: "rejected",
      error: "docusign_send_failed",
      payload: Object.assign({}, req.query || {}, req.body || {}),
    });
```

(In the catch block `p`, `applicationId` and `signerEmail` may be out of scope — use the merged query/body as shown.)

- [ ] **Step 4: Verify every exit is covered**

Run: `grep -c "logAndRespond" docusign/router.js`
Expected: **9** (1 helper definition + 8 call sites).

Run: `node -e "import('./docusign/router.js').then(()=>console.log('router loads'))"`
Expected: `router loads`

- [ ] **Step 5: Commit**

```bash
git add docusign/router.js
git commit -m "feat(docusign): record every inbound webhook outcome"
```

---

## Task 4: Delete the send poller

**Files:** Delete `docusign/sync.js`; modify `server.js`, `docusign/router.js`, `src/lib/docusignApi.ts`, `src/components/dashboard/BackOfficeDepartment.tsx`; rewrite `docusign/duplicateGuard.test.js`.

**Interfaces:**
- Removes: `startDocusignApprovedSyncScheduler`, `runApprovedApplicationsSync`, `processApprovedApplications`, `getDocusignSyncState`, `runDocusignSyncNow`, routes `GET /sync-status`, `POST /sync-approved-applications`, `POST /run-sync`.

⚠️ **Do not touch `docusign/reconcile.js`.** It is a different poller — it detects signatures and drives the CRM upload. Only `sync.js` is being removed.

- [ ] **Step 1: Remove the backend surfaces**

In `server.js`: delete the line `import { startDocusignApprovedSyncScheduler } from "./docusign/sync.js";` and the line `startDocusignApprovedSyncScheduler();`.

In `docusign/router.js`: delete the import `import { getDocusignSyncState, runApprovedApplicationsSync } from "./sync.js";`, and delete the three route handlers in full — `router.get("/sync-status", ...)`, `router.post("/sync-approved-applications", ...)`, and `router.post("/run-sync", ...)`.

- [ ] **Step 2: Delete the module**

```bash
git rm docusign/sync.js
```

- [ ] **Step 3: Remove the frontend surfaces**

In `src/lib/docusignApi.ts`: delete the entire `runDocusignSyncNow()` function.

In `src/components/dashboard/BackOfficeDepartment.tsx`: change the import on line 37 to `import { fetchDocusignOverview, type DocusignOverview } from '@/lib/docusignApi';`; delete the `docusignSyncing` and `docusignSyncMsg` state declarations; delete the "Run sync now" `<button>` element and the `{docusignSyncMsg && ...}` span that follows it.

- [ ] **Step 4: Rewrite the duplicate-guard test**

`docusign/duplicateGuard.test.js` currently imports `processApprovedApplications` from the deleted `./sync.js`. Replace the whole file so the guard stays covered via the pure store predicate:

```js
import { describe, expect, it } from "vitest";
import { isOutstandingStatus } from "./envelopeStatus.js";

/**
 * The duplicate guard blocks a second envelope while the client still has an
 * unsigned one. The send path calls findOutstandingEnvelopeForEmail(), whose SQL
 * filters on exactly these statuses — so this is the contract that matters.
 */
describe("duplicate guard — which statuses block a re-send", () => {
  it("blocks while an envelope is still outstanding", () => {
    expect(isOutstandingStatus("created")).toBe(true);
    expect(isOutstandingStatus("sent")).toBe(true);
    expect(isOutstandingStatus("delivered")).toBe(true);
  });

  it("allows a re-send once the previous envelope is finished", () => {
    expect(isOutstandingStatus("completed")).toBe(false);
    expect(isOutstandingStatus("signed")).toBe(false);
    expect(isOutstandingStatus("expired")).toBe(false);
    expect(isOutstandingStatus("voided")).toBe(false);
    expect(isOutstandingStatus("declined")).toBe(false);
  });

  it("never blocks on a superseded or unknown status", () => {
    expect(isOutstandingStatus("superseded")).toBe(false);
    expect(isOutstandingStatus("")).toBe(false);
    expect(isOutstandingStatus(null)).toBe(false);
    expect(isOutstandingStatus(undefined)).toBe(false);
  });
});
```

- [ ] **Step 5: Verify nothing still references the poller**

Run: `grep -rn "sync\.js\|runApprovedApplicationsSync\|startDocusignApprovedSyncScheduler\|getDocusignSyncState\|processApprovedApplications\|runDocusignSyncNow\|run-sync\|sync-status" --include=*.js --include=*.ts --include=*.tsx docusign src server.js`
Expected: **no matches**.

Run: `npx tsc --noEmit -p tsconfig.json` → clean.
Run: `npx vitest run` → all pass.

- [ ] **Step 6: Verify the app still boots and the reconcile poller still starts**

Run: `npm run local:restart` then `grep -E "docusign-reconcile|docusign-sync" .local-backend.log | tail -3`
Expected: `[docusign-reconcile] scheduler started (interval=300s)` present, and **no** `[docusign-sync]` line. Backend health `200`.

- [ ] **Step 7: Commit**

```bash
git add -A docusign src server.js
git commit -m "refactor(docusign): remove the send poller; the FXBO rule now owns who gets a document"
```

---

## Task 5: Surface webhook health in the panel

**Files:** Modify `docusign/router.js`, `src/lib/docusignApi.ts`, `src/components/dashboard/BackOfficeDepartment.tsx`.

**Interfaces:**
- Consumes: `listWebhookLog` (Task 2), `summariseWebhookHealth` (Task 1).
- Produces: a `webhook` object on the `GET /overview` response.

- [ ] **Step 1: Extend `GET /overview`** — in `docusign/router.js`, add `summariseWebhookHealth` to the `./webhookLog.js` import and `listWebhookLog` to the `./store.js` import. Inside the `/overview` handler, before building the response:

```js
    const webhookRows = await listWebhookLog(100);
    const webhookHealth = summariseWebhookHealth(webhookRows, new Date());
```

and add to the JSON response object:

```js
      webhook: {
        ...webhookHealth,
        recent: webhookRows.slice(0, 5).map((r) => ({
          receivedAt: r.received_at,
          outcome: r.outcome,
          error: r.error,
          applicationId: r.application_id,
        })),
      },
```

- [ ] **Step 2: Extend the frontend type** — in `src/lib/docusignApi.ts`, add to the `DocusignOverview` type:

```ts
  webhook?: {
    lastReceivedAt: string | null;
    lastOutcome: string | null;
    ageHours: number | null;
    stale: boolean;
    rejected7d: number;
    recent?: Array<{ receivedAt: string; outcome: string; error: string | null; applicationId: string | null }>;
  };
```

- [ ] **Step 3: Add the health line to the panel** — in `src/components/dashboard/BackOfficeDepartment.tsx`, immediately after the closing `</div>` of the four-tile KPI grid in the DocuSign section, insert:

```tsx
            {(() => {
              const w = docusignOverview?.webhook;
              if (!w) return null;
              const age = w.ageHours == null
                ? null
                : w.ageHours < 1
                  ? `${Math.max(1, Math.round(w.ageHours * 60))}m`
                  : w.ageHours < 48
                    ? `${Math.round(w.ageHours)}h`
                    : `${Math.round(w.ageHours / 24)}d`;
              return (
                <div className={`mt-3 rounded-lg border px-3 py-2 text-[11px] ${
                  w.stale
                    ? 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
                    : 'border-border/40 bg-background/40 text-muted-foreground'
                }`}>
                  {w.stale
                    ? `⚠ Rule webhook: ${w.lastReceivedAt ? `none in ${age}` : 'never received'} — the FXBO rule may have stopped firing`
                    : `Rule webhook: last received ${age} ago (${w.lastOutcome})`}
                  {w.rejected7d > 0 && ` · ${w.rejected7d} rejected in 7d`}
                </div>
              );
            })()}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit -p tsconfig.json` → clean.
Run: `npm run local:restart`, then confirm the endpoint is still auth-gated:
`curl -s -o /dev/null -w "overview: %{http_code}\n" http://localhost:3001/api/docusign/overview` → `401`.

Then check the payload shape directly against the live database:
`node --env-file=.env -e "import('./docusign/store.js').then(async s => { await s.initDocusignStore(); const rows = await s.listWebhookLog(100); const { summariseWebhookHealth } = await import('./docusign/webhookLog.js'); console.log(JSON.stringify(summariseWebhookHealth(rows, new Date()))); process.exit(0); })"`
Expected on a fresh table: `{"lastReceivedAt":null,"lastOutcome":null,"ageHours":null,"stale":true,"rejected7d":0}` — i.e. it reports **stale**, because no webhook has been recorded yet. That is correct behaviour.

- [ ] **Step 5: Commit**

```bash
git add docusign/router.js src/lib/docusignApi.ts src/components/dashboard/BackOfficeDepartment.tsx
git commit -m "feat(docusign): surface inbound webhook health in the Back Office panel"
```

---

## Task 6: Full verification

- [ ] **Step 1: Suite + build**

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run
npm run build
```
Expected: tsc clean; all tests pass; build succeeds.

- [ ] **Step 2: Boot check**

```bash
npm run local:restart
grep -E "docusign" .local-backend.log | tail -5
```
Expected: `[docusign-reconcile] scheduler started`, no `[docusign-sync]`, no errors, backend `200`.

- [ ] **Step 3: Confirm only one send path remains**

Run: `grep -rn "createEnvelopeFromTemplate" --include=*.js docusign | grep -v test`
Expected: the definition in `docusign/client.js` and exactly **one** call site, in `docusign/router.js`.

- [ ] **Step 4: Manual check in the browser**

Open `http://localhost:8080/departments/backoffice` → section **5. Docusign**. Confirm:
- the **"Run sync now"** button is gone
- a webhook-health line is shown — on a fresh log it reads `⚠ Rule webhook: never received …`, which is correct until the first webhook arrives
- the four KPI tiles and the client lists still render as before

- [ ] **Step 5: Operator follow-up (not code)**

Remove the now-dead env vars from `.env` on both local and production: `DOCUSIGN_AUTO_SYNC_ENABLED`, `DOCUSIGN_AUTO_SYNC_INTERVAL_SECONDS`, `DOCUSIGN_AUTO_SYNC_RUN_ON_START`, `DOCUSIGN_SYNC_LOOKBACK_MINUTES`. Leaving them set is harmless (nothing reads them) but misleading.

---

## Self-review notes (applied)

- **Spec coverage:** delete send poller + all 9 listed call sites (T4) ✓; keep reconcile poller untouched — called out in Global Constraints and T4 Step 1 warning, verified in T6 Step 2 ✓; `docusign_webhook_log` table with the exact schema and 500-row retention (T2) ✓; log on every outcome with `sent`/`skipped`/`rejected` and reason codes for both skipped and rejected (T1, T3) ✓; best-effort logging that cannot alter the response (T2 `recordWebhookCall` try/catch, T3 helper) ✓; `payload` truncated to 2000 chars (T1) ✓; 72h staleness, absent-signal-is-stale, 7-day rejection window (T1) ✓; `webhook` object on `/overview` + panel line (T5) ✓; duplicate guard and `describeWebhookPayload` retained (untouched by all tasks) ✓; duplicate-guard tests rewritten off the deleted module (T4 Step 4) ✓; dead env vars flagged (T6 Step 5) ✓.
- **Type consistency:** `buildWebhookLogEntry` returns `{outcome, httpStatus, error, applicationId, applicantEmail, envelopeId, payload}` (T1) and `recordWebhookCall` consumes exactly those keys (T2); `summariseWebhookHealth` returns `{lastReceivedAt, lastOutcome, ageHours, stale, rejected7d}` (T1), matching the `/overview` payload (T5 Step 1) and the TS type (T5 Step 2) field-for-field. `listWebhookLog` returns snake_case DB columns (`received_at`, `application_id`), which T1's summariser reads as `received_at` and T5 maps to camelCase for the client — consistent.
- **Ordering:** T1 provides the pure helpers before T2's store functions import `WEBHOOK_LOG_RETENTION`; T3 logs via T1+T2; T4 deletes the poller only after logging exists, so no window without either; T5 reads what T2/T3 write.
- **Deliberate choice:** the `DELETE … NOT IN (SELECT … LIMIT)` in T2 uses a derived-table wrapper because MySQL rejects a `LIMIT` subquery against the table being deleted from. Noted inline so it is not "simplified" back into a broken form.
