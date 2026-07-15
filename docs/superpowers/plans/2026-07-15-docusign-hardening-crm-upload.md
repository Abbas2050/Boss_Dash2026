# DocuSign Hardening + Signed-Doc → CRM Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop duplicate DocuSign envelopes, make envelope completion actually detected, upload the signed PDF into the client's FXBO record, and close the public read endpoints.

**Architecture:** Small focused modules under `docusign/` (Node ESM). A pure `normalizeApplicationId` fixes idempotency; a one-time migration cleans existing rows; a reconciliation poller + raw-body-verified Connect webhook both funnel into one shared `onEnvelopeStatus()` hook; that hook triggers the CRM upload. Read endpoints get auth.

**Tech Stack:** Node ESM, Express, mysql2, node-cron, vitest. External: DocuSign REST (JWT via `docusign/client.js`), FXBO CRM REST (`portal.skylinkscapital.com`, Bearer `VITE_API_TOKEN`).

**Spec:** `docs/superpowers/specs/2026-07-15-docusign-hardening-crm-upload-design.md`

## Global Constraints

- **FXBO document type:** config id **73** ("SCA Agreement"), read from env `DOCUSIGN_CRM_DOC_CONFIG_ID`. If unset → **skip upload with a warning**, never file under another type.
- **Uploaded document status:** `"approved"`. No `expiresAt` (config 73 has `hasExpiration:false`).
- **FXBO file field shape (exact):** `data: { file: [ { file: "<base64string>", name: "<string>" } ] }`.
- **FXBO create endpoint:** `POST {CRM_BASE}/rest/documents/new?version=<VITE_API_VERSION>` with `Authorization: Bearer <VITE_API_TOKEN>`; body requires `user` (int).
- **DocuSign combined PDF:** `GET {baseUri}/restapi/v2.1/accounts/{accountId}/envelopes/{envelopeId}/documents/combined`.
- **Upload idempotency:** never upload when `crm_upload_status === 'uploaded'`.
- `superseded` envelopes are excluded from every overview bucket.
- Existing behavior must not regress: the FXBO webhook, the 5-min approved-applications sync, and the Back Office panel keep working.
- Never print secret values (`VITE_API_TOKEN`, `DOCUSIGN_PRIVATE_KEY`, `BREVO_API_KEY`) to logs or test output.
- Branch `feat/docusign-hardening` off `main`. Never push (the user pushes).

## Key existing code (do not re-derive)

- `docusign/store.js` — exports `initDocusignStore`, `findByApplicationId`, `findByEnvelopeId`, `upsertEnvelopeMap`, `markEnvelopeStatus(envelopeId, status, lastError)`, `markCrmUploadStatus(envelopeId, crmUploadStatus, lastError)` (currently **never called**), `listEnvelopeMaps(limit)`. Table `docusign_envelope_map` has UNIQUE `application_id`, and columns `crm_upload_status` (default `'pending'`), `last_error`, `raw_payload`.
- `docusign/client.js` — `getDocusignAccessToken()`, `resolveApiBase(token) -> { baseUri, accountId }`, `createEnvelopeFromTemplate(input)`.
- `docusign/crm.js` — `getCrmBaseUrl()`, `authHeaders()`, `versionQuery()`, `fetchCrmUserById(userId)`, `fetchCrmApplicationApplicantById(applicationId) -> { userId, email, fullName, ... }`, `fetchCrmApplicationsByType(type, query)`. (`getCrmBaseUrl`/`authHeaders`/`versionQuery` are module-private — export them in Task 8.)
- `docusign/router.js` — mounted at `/api/docusign` (`server.js:810`). Has `verifyConnectSignature(req)` (broken: hashes `JSON.stringify(req.body)`), `POST /webhooks/fxbo/application-approved`, `POST /webhooks/connect`, `POST /sync-approved-applications`, `GET /overview`, `GET /health`, `GET /sync-status`, `GET /applications/:applicationId`, `GET /envelopes/:envelopeId`.
- `docusign/sync.js` — `processApprovedApplications(options)` loops CRM apps; `runApprovedApplicationsSync(options, trigger)`; `startDocusignApprovedSyncScheduler()`. Called at `server.js:882`.
- `server.js` — `app.use(express.json({ limit: '1mb' }))` at **line 172**; `app.use("/api/docusign", docusignRouter)` at **line 810**; schedulers start ~line 882. `authRequired`/`canManageUsers` already imported at line 22.
- `auth/router.js` — `canManageUsers(payload)` at line 270 reads `payload.access` (array) + `payload.role`; `export { authRequired, canManageUsers }` near line 520.

---

## Task 0: Branch

- [ ] **Step 1: Create the branch**

```bash
git checkout main && git checkout -b feat/docusign-hardening
```
Expected: `Switched to a new branch 'feat/docusign-hardening'`

---

## Task 1: `normalizeApplicationId` (pure)

**Files:** Create `docusign/appId.js`; Test `docusign/appId.test.js`.

**Interfaces:**
- Produces: `normalizeApplicationId(raw) -> string` (digits only, `""` when none).

- [ ] **Step 1: Write the failing test** — `docusign/appId.test.js`:

```js
import { describe, expect, it } from "vitest";
import { normalizeApplicationId } from "./appId.js";

describe("normalizeApplicationId", () => {
  it("passes through a plain numeric id", () => {
    expect(normalizeApplicationId("3892")).toBe("3892");
  });
  it("extracts the id from an FXBO HTML anchor", () => {
    expect(
      normalizeApplicationId('<a href="https://portal.skylinkscapital.com/crm/applications/3892/view/">3892</a>')
    ).toBe("3892");
  });
  it("returns empty for the spreadsheet header row", () => {
    expect(normalizeApplicationId("Application ID + Link")).toBe("");
  });
  it("returns empty for null/undefined/blank", () => {
    expect(normalizeApplicationId(null)).toBe("");
    expect(normalizeApplicationId(undefined)).toBe("");
    expect(normalizeApplicationId("   ")).toBe("");
  });
  it("trims whitespace around a numeric id", () => {
    expect(normalizeApplicationId("  3525\n")).toBe("3525");
  });
  it("accepts a number input", () => {
    expect(normalizeApplicationId(3525)).toBe("3525");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing)

Run: `npx vitest run docusign/appId.test.js`

- [ ] **Step 3: Create `docusign/appId.js`**

```js
/**
 * FXBO sends applicationId inconsistently: sometimes "3892", sometimes a full
 * HTML anchor like '<a href="...">3892</a>', and once a literal header row.
 * The raw string was used as the idempotency key, so the same application was
 * stored twice and the client received two envelopes. Always normalize first.
 */
export function normalizeApplicationId(raw) {
  const text = String(raw ?? "").replace(/<[^>]*>/g, " ").trim();
  if (!text) return "";
  const match = text.match(/\d+/);
  return match ? match[0] : "";
}
```

- [ ] **Step 4: Run it — expect PASS (6 tests)**

Run: `npx vitest run docusign/appId.test.js`

- [ ] **Step 5: Commit**

```bash
git add docusign/appId.js docusign/appId.test.js
git commit -m "feat(docusign): pure normalizeApplicationId helper"
```

---

## Task 2: Use the normalized id on both send paths

**Files:** Modify `docusign/router.js`, `docusign/sync.js`.

**Interfaces:**
- Consumes: `normalizeApplicationId` (Task 1).

- [ ] **Step 1: Import in `docusign/router.js`** — add near the other imports:

```js
import { normalizeApplicationId } from "./appId.js";
```

- [ ] **Step 2: Normalize in the FXBO webhook** — in `POST /webhooks/fxbo/application-approved`, replace:

```js
    const applicationId = String(p.applicationId || p.id || "").trim();
```
with:
```js
    const rawApplicationId = String(p.applicationId || p.id || "").trim();
    const applicationId = normalizeApplicationId(rawApplicationId);
```
Then replace the existing guard:
```js
    if (!applicationId) return res.status(400).json({ ok: false, error: "applicationId_required" });
```
with:
```js
    if (!rawApplicationId) return res.status(400).json({ ok: false, error: "applicationId_required" });
    if (!applicationId) {
      return res.status(400).json({ ok: false, error: "applicationId_invalid", received: rawApplicationId.slice(0, 120) });
    }
```
(The normalized id now flows into `findByApplicationId`, `createEnvelopeFromTemplate`, and `upsertEnvelopeMap` unchanged — so `3892` and the HTML form collapse to one record.)

- [ ] **Step 3: Normalize in `docusign/sync.js`** — add the import:

```js
import { normalizeApplicationId } from "./appId.js";
```
In `processApprovedApplications`, replace:
```js
    const applicationId = String(app?.id || "").trim();
```
with:
```js
    const applicationId = normalizeApplicationId(app?.id);
```
and add a counter. Change the summary initialiser to include `skippedInvalidId: 0` (add the key next to `skippedMissingUser: 0`), and replace:
```js
    if (!applicationId) continue;
```
with:
```js
    if (!applicationId) {
      summary.skippedInvalidId += 1;
      continue;
    }
```

- [ ] **Step 4: Verify nothing else reads the raw id**

Run: `grep -n "applicationId" docusign/router.js docusign/sync.js | grep -v normalizeApplicationId | head -20`
Expected: every use downstream of the guards is the normalized `applicationId`. `rawApplicationId` is used only for the guard + error echo.

- [ ] **Step 5: Boot check**

Run: `node -e "import('./docusign/router.js').then(()=>console.log('router loads')).catch(e=>{console.error(e.message);process.exit(1)})"`
Expected: `router loads`

- [ ] **Step 6: Commit**

```bash
git add docusign/router.js docusign/sync.js
git commit -m "fix(docusign): normalize applicationId before idempotency check (stops duplicate envelopes)"
```

---

## Task 3: One-time cleanup migration for existing rows

**Files:** Create `docusign/migrateAppIds.js`, Test `docusign/migrateAppIds.test.js`; Modify `server.js`.

**Interfaces:**
- Consumes: `normalizeApplicationId` (Task 1); `store.js` internals via a passed-in db handle.
- Produces: `decideRowActions(rows) -> { updates: [{id, applicationId}], deletes: [id], supersedes: [id], summary }`, and `runAppIdMigration(pool)`.

Production currently has rows like `application_id = '<a href="...">3892</a>'` alongside `'3892'` (same client, two envelopes), plus a junk row `'Application ID + Link'`.

- [ ] **Step 1: Write the failing test** — `docusign/migrateAppIds.test.js`:

```js
import { describe, expect, it } from "vitest";
import { decideRowActions } from "./migrateAppIds.js";

const row = (id, applicationId, updatedAt) => ({ id, application_id: applicationId, updated_at: updatedAt });

describe("decideRowActions", () => {
  it("leaves already-clean rows alone", () => {
    const r = decideRowActions([row(1, "3525", "2026-06-01")]);
    expect(r.updates).toEqual([]);
    expect(r.deletes).toEqual([]);
    expect(r.supersedes).toEqual([]);
  });

  it("normalizes an HTML row when there is no conflict", () => {
    const r = decideRowActions([row(2, '<a href="x">3891</a>', "2026-06-01")]);
    expect(r.updates).toEqual([{ id: 2, applicationId: "3891" }]);
  });

  it("deletes junk rows with no digits", () => {
    const r = decideRowActions([row(3, "Application ID + Link", "2026-06-01")]);
    expect(r.deletes).toEqual([3]);
    expect(r.updates).toEqual([]);
  });

  it("on collision keeps the newest row and supersedes the older", () => {
    const rows = [
      row(10, "3892", "2026-06-24T14:20:58Z"),
      row(11, '<a href="x">3892</a>', "2026-06-24T10:19:19Z"),
    ];
    const r = decideRowActions(rows);
    expect(r.supersedes).toEqual([11]);
    expect(r.updates).toEqual([]);
    expect(r.deletes).toEqual([]);
  });

  it("on collision where the HTML row is newer, supersedes the older plain row and normalizes the winner", () => {
    const rows = [
      row(20, "3900", "2026-06-01T00:00:00Z"),
      row(21, '<a href="x">3900</a>', "2026-07-01T00:00:00Z"),
    ];
    const r = decideRowActions(rows);
    expect(r.supersedes).toEqual([20]);
    expect(r.updates).toEqual([{ id: 21, applicationId: "3900" }]);
  });

  it("reports a summary", () => {
    const r = decideRowActions([
      row(1, "3525", "2026-06-01"),
      row(2, '<a href="x">3891</a>', "2026-06-01"),
      row(3, "Application ID + Link", "2026-06-01"),
    ]);
    expect(r.summary).toEqual({ scanned: 3, normalized: 1, deleted: 1, superseded: 0 });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing)

Run: `npx vitest run docusign/migrateAppIds.test.js`

- [ ] **Step 3: Create `docusign/migrateAppIds.js`**

```js
import { normalizeApplicationId } from "./appId.js";

const isClean = (v) => /^\d+$/.test(String(v ?? ""));
const ts = (v) => {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : 0;
};

/**
 * Pure decision function: given the current rows, decide what to change.
 * - no digits            -> delete (junk, e.g. a spreadsheet header row)
 * - normalizes to an id already held by another row -> keep the newest,
 *   mark the loser 'superseded' (kept for audit, excluded from buckets)
 * - otherwise            -> update application_id in place
 */
export function decideRowActions(rows) {
  const updates = [];
  const deletes = [];
  const supersedes = [];

  const byNorm = new Map();
  for (const r of rows) {
    const norm = normalizeApplicationId(r.application_id);
    if (!norm) {
      deletes.push(r.id);
      continue;
    }
    const list = byNorm.get(norm) || [];
    list.push(r);
    byNorm.set(norm, list);
  }

  for (const [norm, list] of byNorm) {
    if (list.length === 1) {
      const only = list[0];
      if (!isClean(only.application_id)) updates.push({ id: only.id, applicationId: norm });
      continue;
    }
    const sorted = [...list].sort((a, b) => ts(b.updated_at) - ts(a.updated_at));
    const winner = sorted[0];
    for (const loser of sorted.slice(1)) supersedes.push(loser.id);
    if (!isClean(winner.application_id)) updates.push({ id: winner.id, applicationId: norm });
  }

  return {
    updates,
    deletes,
    supersedes,
    summary: {
      scanned: rows.length,
      normalized: updates.length,
      deleted: deletes.length,
      superseded: supersedes.length,
    },
  };
}

/**
 * Applies decideRowActions once. Guarded by a marker row so it cannot run twice.
 * Supersede happens before update so the UNIQUE(application_id) index never collides.
 */
export async function runAppIdMigration(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS docusign_migrations (
      name VARCHAR(190) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (name)
    )
  `);
  const [done] = await pool.query(`SELECT name FROM docusign_migrations WHERE name = ?`, ["normalize_application_ids_v1"]);
  if (Array.isArray(done) && done.length) return { skipped: true, reason: "already_applied" };

  const [rows] = await pool.query(`SELECT id, application_id, updated_at FROM docusign_envelope_map`);
  const plan = decideRowActions(Array.isArray(rows) ? rows : []);
  console.log("[docusign-migrate] plan:", JSON.stringify(plan.summary));

  for (const id of plan.supersedes) {
    await pool.query(`UPDATE docusign_envelope_map SET status = 'superseded', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
  }
  for (const id of plan.deletes) {
    await pool.query(`DELETE FROM docusign_envelope_map WHERE id = ?`, [id]);
  }
  for (const u of plan.updates) {
    await pool.query(`UPDATE docusign_envelope_map SET application_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [u.applicationId, u.id]);
  }

  await pool.query(`INSERT INTO docusign_migrations (name) VALUES (?)`, ["normalize_application_ids_v1"]);
  console.log("[docusign-migrate] applied:", JSON.stringify(plan.summary));
  return { skipped: false, ...plan.summary };
}
```

- [ ] **Step 4: Run it — expect PASS (6 tests)**

Run: `npx vitest run docusign/migrateAppIds.test.js`

- [ ] **Step 5: Export the pool from `docusign/store.js`**

Add at the end of `docusign/store.js`:

```js
export async function getDocusignPool() {
  await initDocusignStore();
  return pool;
}
```

- [ ] **Step 6: Run the migration once at startup** — in `server.js`, add the import next to the other docusign imports (line ~17):

```js
import { runAppIdMigration } from "./docusign/migrateAppIds.js";
import { getDocusignPool } from "./docusign/store.js";
```
and inside the `server.listen` callback, immediately **before** `startDocusignApprovedSyncScheduler();` (line ~882):

```js
  getDocusignPool()
    .then((pool) => runAppIdMigration(pool))
    .then((r) => console.log("[docusign-migrate]", JSON.stringify(r)))
    .catch((e) => console.error("[docusign-migrate] failed:", e?.message || String(e)));
```

- [ ] **Step 7: Verify on a live restart**

Run: `npm run local:restart` then `grep -E "docusign-migrate" .local-backend.log | tail -3`
Expected: a `plan:`/`applied:` line with counts (or `already_applied` on the second restart). Backend UP.
Then confirm the duplicate is gone: `curl -s http://localhost:3001/api/docusign/overview | grep -c '<a href' ` → expected `0`.

- [ ] **Step 8: Commit**

```bash
git add docusign/migrateAppIds.js docusign/migrateAppIds.test.js docusign/store.js server.js
git commit -m "fix(docusign): one-time migration normalizing application ids + superseding duplicates"
```

---

## Task 4: Raw-body HMAC for the Connect webhook

**Files:** Modify `server.js`, `docusign/router.js`; Test `docusign/connectSignature.test.js`.

**Interfaces:**
- Produces: `verifyConnectSignatureRaw(rawBody, headerSig, secret) -> { ok, reason }` exported from `docusign/router.js`.

The current check hashes `JSON.stringify(req.body)`, which can never match DocuSign's signature over the raw bytes. Production has `connectHmacEnabled:false`, so the endpoint is unauthenticated today.

- [ ] **Step 1: Write the failing test** — `docusign/connectSignature.test.js`:

```js
import crypto from "crypto";
import { describe, expect, it } from "vitest";
import { verifyConnectSignatureRaw } from "./router.js";

const SECRET = "test-secret";
const sign = (raw) => crypto.createHmac("sha256", SECRET).update(raw).digest("base64");

describe("verifyConnectSignatureRaw", () => {
  it("passes when the signature matches the raw bytes", () => {
    const raw = Buffer.from('{"data":{"envelopeId":"abc"},"spacing": 1}');
    expect(verifyConnectSignatureRaw(raw, sign(raw), SECRET).ok).toBe(true);
  });
  it("fails when the body was altered", () => {
    const raw = Buffer.from('{"data":{"envelopeId":"abc"}}');
    const other = Buffer.from('{"data":{"envelopeId":"evil"}}');
    expect(verifyConnectSignatureRaw(other, sign(raw), SECRET).ok).toBe(false);
  });
  it("fails when the signature header is missing", () => {
    const raw = Buffer.from("{}");
    const r = verifyConnectSignatureRaw(raw, "", SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing_signature_header");
  });
  it("passes through when no secret is configured (documented gap)", () => {
    const raw = Buffer.from("{}");
    const r = verifyConnectSignatureRaw(raw, "", "");
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("hmac_not_configured");
  });
  it("fails when raw body was not captured but a secret is set", () => {
    const r = verifyConnectSignatureRaw(undefined, "sig", SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("raw_body_unavailable");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (export missing)

Run: `npx vitest run docusign/connectSignature.test.js`

- [ ] **Step 3: Capture the raw body in `server.js`** — replace line 172:

```js
app.use(express.json({ limit: '1mb' }));
```
with:
```js
app.use(express.json({
  limit: '1mb',
  // DocuSign Connect signs the RAW request bytes; keep them for that route only.
  verify: (req, _res, buf) => {
    if (String(req.originalUrl || '').startsWith('/api/docusign/webhooks/connect')) {
      req.rawBody = Buffer.from(buf);
    }
  },
}));
```

- [ ] **Step 4: Replace the broken check in `docusign/router.js`** — replace the whole `verifyConnectSignature` function with:

```js
export function verifyConnectSignatureRaw(rawBody, headerSig, secret) {
  if (!secret) return { ok: true, reason: "hmac_not_configured" };
  const sig = String(headerSig || "").trim();
  if (!sig) return { ok: false, reason: "missing_signature_header" };
  if (!rawBody || !rawBody.length) return { ok: false, reason: "raw_body_unavailable" };
  const computed = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(computed);
  const b = Buffer.from(sig);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, reason: ok ? "ok" : "signature_mismatch" };
}

function verifyConnectSignature(req) {
  return verifyConnectSignatureRaw(
    req.rawBody,
    req.headers["x-docusign-signature-1"],
    process.env.DOCUSIGN_CONNECT_HMAC_SECRET || ""
  );
}
```
(`crypto` is already imported at the top of the file. The `POST /webhooks/connect` handler keeps calling `verifyConnectSignature(req)` unchanged.)

- [ ] **Step 5: Run it — expect PASS (5 tests)**

Run: `npx vitest run docusign/connectSignature.test.js`

- [ ] **Step 6: Commit**

```bash
git add server.js docusign/router.js docusign/connectSignature.test.js
git commit -m "fix(docusign): verify Connect webhook HMAC over raw request bytes"
```

---

## Task 5: Store — `crm_user_id` column, `superseded`, and capture the user id

**Files:** Modify `docusign/store.js`, `docusign/router.js`, `docusign/sync.js`.

**Interfaces:**
- Produces: `upsertEnvelopeMap` accepts `crmUserId`; rows carry `crm_user_id`.

- [ ] **Step 1: Add the column in `docusign/store.js`** — inside `initDocusignStore`, after the `CREATE TABLE` and before `initialized = true`, add a backward-compatible migration:

```js
  const [colRows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'docusign_envelope_map' AND COLUMN_NAME = 'crm_user_id'`
  );
  if (Number(colRows?.[0]?.cnt || 0) === 0) {
    await run(`ALTER TABLE docusign_envelope_map ADD COLUMN crm_user_id BIGINT NULL`);
  }
```

- [ ] **Step 2: Persist it in `upsertEnvelopeMap`** — add `crmUserId` to the destructured input, add `crm_user_id` to the INSERT column list and `?` placeholders, add `crm_user_id = VALUES(crm_user_id)` to the ON DUPLICATE KEY UPDATE list, and pass `crmUserId == null ? null : Number(crmUserId)` in the params array (in the matching position).

- [ ] **Step 3: Pass the user id from the FXBO webhook** — in `docusign/router.js`, in the `upsertEnvelopeMap({...})` call inside `POST /webhooks/fxbo/application-approved`, add:

```js
      crmUserId: userId,
```
(`userId` is already resolved above in that handler.)

- [ ] **Step 4: Pass the user id from the sync path** — in `docusign/sync.js`, in the `upsertEnvelopeMap({...})` call inside `processApprovedApplications`, add:

```js
        crmUserId: userId,
```
(`userId` is already resolved above in that loop.)

- [ ] **Step 5: Verify the column exists after a restart**

Run: `npm run local:restart` then `curl -s http://localhost:3001/api/docusign/health`
Expected: `{"ok":true,"service":"docusign-integration"}` (init ran without error).

- [ ] **Step 6: Commit**

```bash
git add docusign/store.js docusign/router.js docusign/sync.js
git commit -m "feat(docusign): persist crm_user_id on envelope records"
```

---

## Task 6: DocuSign client — download combined PDF + list status changes

**Files:** Modify `docusign/client.js`.

**Interfaces:**
- Produces: `downloadCombinedDocument(envelopeId) -> Buffer`; `listStatusChanges(fromDateIso) -> Array<{ envelopeId, status, statusChangedDateTime }>`.

- [ ] **Step 1: Add both functions to `docusign/client.js`** (append at the end):

```js
export async function downloadCombinedDocument(envelopeId) {
  const id = String(envelopeId || "").trim();
  if (!id) throw new Error("envelopeId is required");
  const accessToken = await getDocusignAccessToken();
  const { baseUri, accountId } = await resolveApiBase(accessToken);
  const resp = await fetch(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${id}/documents/combined`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/pdf" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`DocuSign document download failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

export async function listStatusChanges(fromDateIso) {
  const accessToken = await getDocusignAccessToken();
  const { baseUri, accountId } = await resolveApiBase(accessToken);
  const params = new URLSearchParams({ from_date: String(fromDateIso) });
  const resp = await fetch(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`DocuSign listStatusChanges failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const json = await resp.json();
  const envelopes = Array.isArray(json?.envelopes) ? json.envelopes : [];
  return envelopes.map((e) => ({
    envelopeId: String(e?.envelopeId || ""),
    status: String(e?.status || "").toLowerCase(),
    statusChangedDateTime: String(e?.statusChangedDateTime || ""),
  })).filter((e) => e.envelopeId);
}
```

- [ ] **Step 2: Module loads**

Run: `node -e "import('./docusign/client.js').then(m=>console.log(Object.keys(m).join(',')))"`
Expected: includes `downloadCombinedDocument` and `listStatusChanges`.

- [ ] **Step 3: Commit**

```bash
git add docusign/client.js
git commit -m "feat(docusign): client helpers to download combined PDF and list status changes"
```

---

## Task 7: CRM upload module (payload builder + orchestration)

**Files:** Create `docusign/crmUpload.js`, Test `docusign/crmUpload.test.js`; Modify `docusign/crm.js`.

**Interfaces:**
- Consumes: `downloadCombinedDocument` (Task 6); `findByEnvelopeId`, `markCrmUploadStatus` (store); `fetchCrmApplicationApplicantById` (crm.js).
- Produces: `buildDocumentPayload({ crmUserId, configId, applicationId, envelopeId, pdfBase64 }) -> object`; `uploadSignedDocument(envelopeId) -> { ok, reason? }`.

- [ ] **Step 1: Export the CRM primitives from `docusign/crm.js`** — change these three declarations to named exports (bodies unchanged):

```js
export function getCrmBaseUrl() {
export function authHeaders() {
export function versionQuery() {
```
Then append the create call:

```js
export async function createCrmDocument(payload) {
  const endpoint = `${getCrmBaseUrl()}/documents/new?${versionQuery()}`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`CRM documents/new failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  return resp.json();
}
```

- [ ] **Step 2: Write the failing test** — `docusign/crmUpload.test.js`:

```js
import { describe, expect, it } from "vitest";
import { buildDocumentPayload } from "./crmUpload.js";

describe("buildDocumentPayload", () => {
  const base = {
    crmUserId: 10002,
    configId: 73,
    applicationId: "3892",
    envelopeId: "env-abc",
    pdfBase64: "JVBERi0xLjQK",
  };

  it("builds the exact FXBO payload shape", () => {
    expect(buildDocumentPayload(base)).toEqual({
      user: 10002,
      config: 73,
      status: "approved",
      isUploadedByClient: false,
      description: "DocuSign signed agreement (envelope env-abc, application 3892)",
      data: { file: [{ file: "JVBERi0xLjQK", name: "signed-agreement-3892.pdf" }] },
    });
  });

  it("coerces user and config to numbers", () => {
    const p = buildDocumentPayload({ ...base, crmUserId: "10002", configId: "73" });
    expect(p.user).toBe(10002);
    expect(p.config).toBe(73);
  });

  it("never includes expiresAt (config 73 has no expiration)", () => {
    expect(buildDocumentPayload(base)).not.toHaveProperty("expiresAt");
  });
});
```

- [ ] **Step 3: Run it — expect FAIL** (module missing)

Run: `npx vitest run docusign/crmUpload.test.js`

- [ ] **Step 4: Create `docusign/crmUpload.js`**

```js
import { downloadCombinedDocument } from "./client.js";
import { createCrmDocument, fetchCrmApplicationApplicantById } from "./crm.js";
import { findByEnvelopeId, markCrmUploadStatus } from "./store.js";

/**
 * FXBO config 73 = "SCA Agreement"; its only data field is `file`, typed
 * [{ file: "base64string", name: "string" }]. hasExpiration is false, so we
 * never send expiresAt.
 */
export function buildDocumentPayload({ crmUserId, configId, applicationId, envelopeId, pdfBase64 }) {
  return {
    user: Number(crmUserId),
    config: Number(configId),
    status: "approved",
    isUploadedByClient: false,
    description: `DocuSign signed agreement (envelope ${envelopeId}, application ${applicationId})`,
    data: { file: [{ file: pdfBase64, name: `signed-agreement-${applicationId}.pdf` }] },
  };
}

export async function uploadSignedDocument(envelopeId) {
  const configId = String(process.env.DOCUSIGN_CRM_DOC_CONFIG_ID || "").trim();
  if (!configId) {
    console.warn("[docusign-crm-upload] DOCUSIGN_CRM_DOC_CONFIG_ID not set — skipping upload.");
    return { ok: false, reason: "config_id_not_set" };
  }

  const row = await findByEnvelopeId(envelopeId);
  if (!row) return { ok: false, reason: "envelope_not_found" };
  if (String(row.crm_upload_status || "").toLowerCase() === "uploaded") {
    return { ok: true, reason: "already_uploaded" };
  }

  try {
    let crmUserId = row.crm_user_id ? Number(row.crm_user_id) : null;
    if (!crmUserId) {
      const applicant = await fetchCrmApplicationApplicantById(row.application_id).catch(() => null);
      crmUserId = applicant?.userId ? Number(applicant.userId) : null;
    }
    if (!crmUserId) {
      await markCrmUploadStatus(envelopeId, "failed", "crm_user_unresolved");
      return { ok: false, reason: "crm_user_unresolved" };
    }

    const pdf = await downloadCombinedDocument(envelopeId);
    const payload = buildDocumentPayload({
      crmUserId,
      configId,
      applicationId: row.application_id,
      envelopeId,
      pdfBase64: pdf.toString("base64"),
    });
    await createCrmDocument(payload);
    await markCrmUploadStatus(envelopeId, "uploaded", null);
    console.log(`[docusign-crm-upload] uploaded envelope=${envelopeId} application=${row.application_id} user=${crmUserId}`);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markCrmUploadStatus(envelopeId, "failed", message.slice(0, 500)).catch(() => undefined);
    console.error(`[docusign-crm-upload] failed envelope=${envelopeId}: ${message}`);
    return { ok: false, reason: "upload_failed", message };
  }
}
```

- [ ] **Step 5: Run it — expect PASS (3 tests)**

Run: `npx vitest run docusign/crmUpload.test.js`

- [ ] **Step 6: Commit**

```bash
git add docusign/crmUpload.js docusign/crmUpload.test.js docusign/crm.js
git commit -m "feat(docusign): upload signed PDF into FXBO document config (idempotent)"
```

---

## Task 8: Shared completion hook + reconciliation poller

**Files:** Create `docusign/reconcile.js`; Modify `docusign/router.js`, `server.js`.

**Interfaces:**
- Consumes: `listStatusChanges` (Task 6), `uploadSignedDocument` (Task 7), `markEnvelopeStatus`/`findByEnvelopeId` (store).
- Produces: `onEnvelopeStatus(envelopeId, status) -> record|null`; `startDocusignReconcileScheduler()`.

- [ ] **Step 1: Create `docusign/reconcile.js`**

```js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { listStatusChanges } from "./client.js";
import { uploadSignedDocument } from "./crmUpload.js";
import { findByEnvelopeId, initDocusignStore, markEnvelopeStatus } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "../storage/docusign_reconcile_state.json");

function readCursor() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (raw?.lastFromDate) return String(raw.lastFromDate);
  } catch { /* first run */ }
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
}

function writeCursor(iso) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastFromDate: iso }, null, 2));
}

/**
 * Single place a status change lands, whether it came from the Connect webhook
 * or the poller. Completion triggers the CRM upload exactly once.
 */
export async function onEnvelopeStatus(envelopeId, status) {
  const next = String(status || "unknown").toLowerCase();
  const updated = await markEnvelopeStatus(envelopeId, next);
  if (next === "completed") {
    await uploadSignedDocument(envelopeId).catch((e) =>
      console.error("[docusign-reconcile] upload threw:", e?.message || String(e))
    );
  }
  return updated;
}

export async function runReconcileOnce() {
  await initDocusignStore();
  const from = readCursor();
  const startedAt = new Date().toISOString();
  const changes = await listStatusChanges(from);

  let matched = 0;
  let updated = 0;
  for (const change of changes) {
    const row = await findByEnvelopeId(change.envelopeId);
    if (!row) continue;
    matched += 1;
    if (String(row.status || "").toLowerCase() === change.status) continue;
    await onEnvelopeStatus(change.envelopeId, change.status);
    updated += 1;
  }

  // Only advance on success, so a failure never skips a window.
  writeCursor(startedAt);
  const summary = { from, fetched: changes.length, matched, updated };
  console.log("[docusign-reconcile]", JSON.stringify(summary));
  return summary;
}

export function startDocusignReconcileScheduler() {
  const enabled = String(process.env.DOCUSIGN_RECONCILE_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
    console.log("[docusign-reconcile] disabled by DOCUSIGN_RECONCILE_ENABLED=false");
    return null;
  }
  const intervalSeconds = Math.max(60, Number(process.env.DOCUSIGN_RECONCILE_INTERVAL_SECONDS || 300) || 300);
  const timer = setInterval(() => {
    runReconcileOnce().catch((e) => console.error("[docusign-reconcile] failed:", e?.message || String(e)));
  }, intervalSeconds * 1000);
  console.log(`[docusign-reconcile] scheduler started (interval=${intervalSeconds}s)`);
  return { stop: () => clearInterval(timer), intervalSeconds };
}
```

- [ ] **Step 2: Route the Connect webhook through the same hook** — in `docusign/router.js`, add the import:

```js
import { onEnvelopeStatus } from "./reconcile.js";
```
In `POST /webhooks/connect`, replace:
```js
    const updated = await markEnvelopeStatus(envelopeId, status);
```
with:
```js
    const updated = await onEnvelopeStatus(envelopeId, status);
```
(Leave the `markEnvelopeStatus` import in place — it is still used by the store/other paths.)

- [ ] **Step 3: Start the scheduler in `server.js`** — add the import next to the other docusign imports:

```js
import { startDocusignReconcileScheduler } from "./docusign/reconcile.js";
```
and call it right after `startDocusignApprovedSyncScheduler();`:

```js
  startDocusignReconcileScheduler();
```

- [ ] **Step 4: Verify boot + one reconcile pass**

Run: `npm run local:restart` then `grep -E "docusign-reconcile" .local-backend.log | tail -3`
Expected: `scheduler started (interval=300s)`, and no crash. Backend UP (`curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/health` → `200`).

- [ ] **Step 5: Commit**

```bash
git add docusign/reconcile.js docusign/router.js server.js
git commit -m "feat(docusign): reconciliation poller + shared completion hook triggering CRM upload"
```

---

## Task 9: Overview — needsAttention buckets, exclude superseded, gate reads

**Files:** Modify `docusign/router.js`, `auth/router.js`, `src/lib/docusignApi.ts`, `src/components/dashboard/BackOfficeDepartment.tsx`; Test `docusign/overviewBuckets.test.js`.

**Interfaces:**
- Produces: `bucketEnvelopes(rows) -> { pending, completed, needsAttention }` exported from `docusign/router.js`; `hasAccessPermission(payload, key)` exported from `auth/router.js`.

- [ ] **Step 1: Write the failing test** — `docusign/overviewBuckets.test.js`:

```js
import { describe, expect, it } from "vitest";
import { bucketEnvelopes } from "./router.js";

const row = (status) => ({ status, application_id: "1", applicant_email: "a@b.c" });

describe("bucketEnvelopes", () => {
  it("buckets completed statuses", () => {
    const r = bucketEnvelopes([row("completed"), row("signed")]);
    expect(r.completed).toHaveLength(2);
    expect(r.pending).toHaveLength(0);
  });
  it("buckets in-flight statuses as pending", () => {
    const r = bucketEnvelopes([row("sent"), row("created"), row("pending")]);
    expect(r.pending).toHaveLength(3);
  });
  it("surfaces declined/voided/expired as needsAttention", () => {
    const r = bucketEnvelopes([row("declined"), row("voided"), row("expired")]);
    expect(r.needsAttention).toHaveLength(3);
    expect(r.pending).toHaveLength(0);
    expect(r.completed).toHaveLength(0);
  });
  it("excludes superseded rows from every bucket", () => {
    const r = bucketEnvelopes([row("superseded")]);
    expect(r.pending).toHaveLength(0);
    expect(r.completed).toHaveLength(0);
    expect(r.needsAttention).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (export missing)

Run: `npx vitest run docusign/overviewBuckets.test.js`

- [ ] **Step 3: Add `bucketEnvelopes` to `docusign/router.js`** (above the `/overview` handler):

```js
const COMPLETED_STATUSES = new Set(["completed", "signed", "delivered"]);
const PENDING_STATUSES = new Set(["created", "sent", "delivered", "pending"]);
const ATTENTION_STATUSES = new Set(["declined", "voided", "expired"]);

export function bucketEnvelopes(rows) {
  const norm = rows.map((r) => ({ ...r, status: String(r.status || "unknown").toLowerCase() }));
  const live = norm.filter((r) => r.status !== "superseded");
  return {
    completed: live.filter((r) => COMPLETED_STATUSES.has(r.status)),
    pending: live.filter((r) => !COMPLETED_STATUSES.has(r.status) && PENDING_STATUSES.has(r.status)),
    needsAttention: live.filter((r) => ATTENTION_STATUSES.has(r.status)),
  };
}
```
Then in `GET /overview`, replace the inline `completedStatuses`/`pendingStatuses` sets and the `completedRows`/`pendingRows` computation with:

```js
    const { completed: completedRows, pending: pendingRows, needsAttention: attentionRows } = bucketEnvelopes(normalizedRows);
    const sentCount = normalizedRows.filter((r) => r.status !== "superseded").length;
```
Add to the JSON response: inside `summary`, add `needsAttention: attentionRows.length`; and add a top-level:
```js
      needsAttentionClients: attentionRows.slice(0, 8).map((row) => ({
        applicationId: row.application_id,
        name: row.applicant_name || row.applicant_email,
        email: row.applicant_email,
        status: row.status,
        updatedAt: row.updated_at,
      })),
```

- [ ] **Step 4: Run it — expect PASS (4 tests)**

Run: `npx vitest run docusign/overviewBuckets.test.js`

- [ ] **Step 5: Export `hasAccessPermission` from `auth/router.js`** — add next to `canManageUsers` (line ~274):

```js
function hasAccessPermission(payload, key) {
  const access = Array.isArray(payload?.access) ? payload.access : [];
  const role = String(payload?.role || "").trim().toLowerCase();
  if (role === "super admin") return true;
  if (access.includes(key)) return true;
  return access.some((a) => String(a).split(":")[0] === key);
}
```
and extend the existing named export line to:
```js
export { authRequired, canManageUsers, hasAccessPermission };
```

- [ ] **Step 6: Gate the read endpoints** — in `docusign/router.js`, add the import:

```js
import { authRequired, hasAccessPermission } from "../auth/router.js";
```
and a local guard:
```js
function requireBackoffice(req, res, next) {
  if (!hasAccessPermission(req.auth, "Backoffice")) return res.status(403).json({ ok: false, error: "forbidden" });
  return next();
}
```
Apply `authRequired, requireBackoffice` to these four routes only (webhooks keep their own auth):
```js
router.get("/overview", authRequired, requireBackoffice, async (_req, res) => {
router.get("/sync-status", authRequired, requireBackoffice, async (_req, res) => {
router.get("/applications/:applicationId", authRequired, requireBackoffice, async (req, res) => {
router.get("/envelopes/:envelopeId", authRequired, requireBackoffice, async (req, res) => {
```
Leave `GET /health` open.

- [ ] **Step 7: Send the auth header from the frontend** — in `src/lib/docusignApi.ts`, import and use the header, and add the new fields:

```ts
import { authHeaders } from "@/lib/auth";
```
Change the fetch in `fetchDocusignOverview` to:
```ts
  const res = await fetch("/api/docusign/overview", {
    headers: { Accept: "application/json", ...authHeaders() },
  });
```
Extend the types:
```ts
  summary: { sent: number; pending: number; completed: number; needsAttention?: number };
  needsAttentionClients?: DocusignClientItem[];
```

- [ ] **Step 8: Show it in the panel** — in `src/components/dashboard/BackOfficeDepartment.tsx`, in the DocuSign section's stat row, add a tile after the Completed tile:

```tsx
              <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-3">
                <div className="text-[11px] uppercase tracking-wide text-rose-700 dark:text-rose-300">Needs Attention</div>
                <div className="mt-2 font-mono text-2xl font-semibold text-rose-900 dark:text-rose-100">{docusignOverview?.summary.needsAttention ?? 0}</div>
              </div>
```

- [ ] **Step 9: Verify gating + tsc**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npm run local:restart
curl -s -o /dev/null -w "overview unauth: %{http_code}\n" http://localhost:3001/api/docusign/overview
curl -s -o /dev/null -w "health open:    %{http_code}\n" http://localhost:3001/api/docusign/health
```
Expected: tsc clean; overview `401`; health `200`.

- [ ] **Step 10: Commit**

```bash
git add docusign/router.js docusign/overviewBuckets.test.js auth/router.js src/lib/docusignApi.ts src/components/dashboard/BackOfficeDepartment.tsx
git commit -m "feat(docusign): needsAttention bucket + auth-gate the read endpoints"
```

---

## Task 10: "Run sync now" button

**Files:** Modify `docusign/router.js`, `src/lib/docusignApi.ts`, `src/components/dashboard/BackOfficeDepartment.tsx`.

**Interfaces:**
- Produces: `POST /api/docusign/run-sync`; `runDocusignSyncNow(): Promise<any>` in `docusignApi.ts`.

- [ ] **Step 1: Add the route** — in `docusign/router.js`, after the existing `/sync-approved-applications` route:

```js
// Operator-triggered sweep from the Back Office panel (session auth, not the webhook bearer).
router.post("/run-sync", authRequired, requireBackoffice, async (_req, res) => {
  try {
    await initDocusignStore();
    const summary = await runApprovedApplicationsSync({}, "panel_button");
    if (summary?.skipped) return res.status(409).json({ ok: false, error: "sync_already_running", sync: summary.state });
    return res.json({ ok: true, ...summary });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "run_sync_failed", message: error instanceof Error ? error.message : String(error) });
  }
});
```

- [ ] **Step 2: Add the client call** — in `src/lib/docusignApi.ts`:

```ts
export async function runDocusignSyncNow(): Promise<{ ok: boolean; sent?: number; approved?: number; alreadySent?: number; failed?: number; message?: string }> {
  const res = await fetch("/api/docusign/run-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `run-sync ${res.status}`);
  return data;
}
```

- [ ] **Step 3: Add the button** — in `src/components/dashboard/BackOfficeDepartment.tsx`, import `runDocusignSyncNow` alongside `fetchDocusignOverview`, add state near `docusignError`:

```tsx
  const [docusignSyncing, setDocusignSyncing] = useState(false);
  const [docusignSyncMsg, setDocusignSyncMsg] = useState<string | null>(null);
```
and render this next to the Docusign section header status line:
```tsx
              <button
                type="button"
                onClick={async () => {
                  setDocusignSyncing(true);
                  setDocusignSyncMsg(null);
                  try {
                    const r = await runDocusignSyncNow();
                    setDocusignSyncMsg(`Sent ${r.sent ?? 0} · already sent ${r.alreadySent ?? 0} · failed ${r.failed ?? 0}`);
                  } catch (e) {
                    setDocusignSyncMsg(e instanceof Error ? e.message : 'Failed');
                  } finally {
                    setDocusignSyncing(false);
                  }
                }}
                disabled={docusignSyncing}
                className="rounded-md border border-border/60 bg-secondary px-2 py-1 text-[11px] hover:bg-secondary/80 disabled:opacity-50"
              >
                {docusignSyncing ? 'Syncing…' : 'Run sync now'}
              </button>
              {docusignSyncMsg && <span className="text-[11px] text-muted-foreground">{docusignSyncMsg}</span>}
```

- [ ] **Step 4: Verify**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npm run local:restart
curl -s -o /dev/null -w "run-sync unauth: %{http_code}\n" -X POST http://localhost:3001/api/docusign/run-sync
```
Expected: tsc clean; `401`.

- [ ] **Step 5: Commit**

```bash
git add docusign/router.js src/lib/docusignApi.ts src/components/dashboard/BackOfficeDepartment.tsx
git commit -m "feat(docusign): Run sync now button in the Back Office panel"
```

---

## Task 11: Full verification

- [ ] **Step 1: Suite + build**

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run
npm run build
```
Expected: tsc clean; all tests pass (incl. `appId`, `migrateAppIds`, `connectSignature`, `crmUpload`, `overviewBuckets`); build succeeds.

- [ ] **Step 2: Boot + migration + schedulers**

```bash
npm run local:restart
grep -E "docusign-migrate|docusign-reconcile|docusign-sync" .local-backend.log | tail -5
```
Expected: migration applied (or `already_applied`), reconcile scheduler started, sync scheduler started, no errors.

- [ ] **Step 3: Confirm the duplicate/garbage rows are gone**

```bash
curl -s http://localhost:3001/api/docusign/health
```
Expected: `{"ok":true,...}`. (The `/overview` route is now auth-gated; check the panel in the browser instead — Application IDs must render as plain numbers with no `<a href` text, and app `3892` must appear once.)

- [ ] **Step 4: Set the env for the upload**

Add to `.env`: `DOCUSIGN_CRM_DOC_CONFIG_ID=73`, then restart. Without it, uploads are skipped by design (`config_id_not_set`).

- [ ] **Step 5: Manual end-to-end (operator)**

Send one envelope to a test client and sign it. Within one reconcile interval (≤5 min) confirm: the panel flips that row to Completed, the log shows `[docusign-crm-upload] uploaded envelope=…`, and the document appears on that client in FXBO under **"SCA Agreement"** with status **approved**.

---

## Self-review notes (applied)

- **Spec coverage:** normalize+wire (T1–T2) ✓; cleanup migration incl. supersede/delete (T3) ✓; raw-body HMAC (T4) ✓; `crm_user_id` capture + fallback (T5, T7) ✓; download combined PDF + listStatusChanges (T6) ✓; CRM upload w/ exact `data.file[0]` shape, config 73, `approved`, no `expiresAt`, idempotent guard, fail-safe on unset config (T7) ✓; shared `onEnvelopeStatus` + poller + cursor-only-on-success (T8) ✓; needsAttention + exclude superseded + auth gating (T9) ✓; Run-sync button (T10) ✓; tests for every pure unit (T1,3,4,7,9) ✓.
- **Type/name consistency:** `normalizeApplicationId` (T1) used in T2/T3; `upsertEnvelopeMap({crmUserId})` (T5) matches T7's `row.crm_user_id` read; `downloadCombinedDocument`/`listStatusChanges` (T6) consumed in T7/T8; `uploadSignedDocument` (T7) called by `onEnvelopeStatus` (T8); `requireBackoffice` defined in T9 and reused in T10; `authHeaders` imported in `docusignApi.ts` in T9 and reused by T10.
- **Ordering:** T7 defines `uploadSignedDocument` before T8 imports it; T9 defines `requireBackoffice`/`authRequired` import before T10's route uses them; the migration (T3) runs before any reconcile writes.
