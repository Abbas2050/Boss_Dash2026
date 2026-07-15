# DocuSign Pipeline Hardening + Signed-Doc → CRM Upload

**Date:** 2026-07-15
**Status:** Approved design (pre-implementation)
**Module:** `docusign/` (Node ESM) + Back Office panel (`src/components/dashboard/BackOfficeDepartment.tsx`)

## Summary

The DocuSign integration is live but broken in three ways, confirmed against production on 2026-07-15:

- **Duplicate envelopes reach real clients.** Application `3892` has two `sent` envelopes to `smitdatta2000@gmail.com` — one stored as `3892`, one as `<a href="https://portal.skylinkscapital.com/crm/applications/3892/view/">3892</a>`. The raw HTML string never equals `3892`, so the idempotency check misses and a second envelope is sent. 6 of 9 visible rows store the ID as raw HTML.
- **Completion is never detected.** Production shows `sent 12 / pending 11 / completed 1`, and the single "completed" is a test row (`APP-TEST-001`). `latestUpdatedAt` is stuck at 2026-06-24. Envelopes stay `sent` forever.
- **Read endpoints are public.** `/api/docusign/overview` returns client names + emails with no authentication.

This project fixes those and adds the requested feature: **when an envelope completes, upload the signed PDF to that client's record in the FXBO CRM.**

**Ordering is dependency-driven, not preference:** the new feature triggers on completion, which does not currently work. Phase 2 is a hard prerequisite for Phase 3. Phase 1 protects Phase 3 (duplicates would cause duplicate uploads).

## Decisions (from brainstorming)

- **Signed PDF destination:** upload into the client's FXBO record (reverses an earlier "just mark completed" decision).
- **Document type:** new dedicated FXBO type — **config id 73, "SCA Agreement"** (verified live: `hasExpiration:false`, `requiredForVerification:true`, single `file` field).
- **Uploaded document status:** `approved` (already signed via DocuSign; no manual review).
- **Cleanup migration over existing live rows:** in scope.

## Verified external contracts

**FXBO CRM** (`portal.skylinkscapital.com`, Bearer `VITE_API_TOKEN`, `?version=<VITE_API_VERSION>`):
- `POST /rest/documents` — **list** documents (FXBO uses POST to query).
- `POST /rest/documents/new` — **create** document. Body schema `DocumentCreateRequest`: `user` (required, int), `config` (int), `status` (`pending|approved|declined|expired|deleted`), `description`, `idNumber`, `isUploadedByClient`, `expiresAt`, `data` (object; shape depends on config).
- `GET /rest/documents/configs` — list document types.
- Config **73** `data` shape: `file` is typed `[{ "file": "base64string", "name": "string" }]` ("for file type always send array of objects").

**DocuSign:** `GET {baseUri}/restapi/v2.1/accounts/{accountId}/envelopes/{envelopeId}/documents/combined` → combined signed PDF (uses the existing JWT client in `docusign/client.js`).

## Phase 1 — Stop duplicate sends

- New pure helper `normalizeApplicationId(raw)` in `docusign/appId.js`: strip HTML tags and whitespace, then extract the first digit-run. `<a href=…>3892</a>` → `"3892"`; `"3892"` → `"3892"`; `"Application ID + Link"` → `""`.
- Applied in `docusign/router.js` (FXBO webhook) and `docusign/sync.js` **before** `findByApplicationId`, so both id forms collapse to one record.
- Empty result → webhook responds `400 {error:"applicationId_invalid"}`; the sync path skips the row and counts it in the summary. Garbage is never stored.
- **One-time cleanup migration** (`docusign/migrateAppIds.js`, run once at startup, guarded by a marker so it cannot run twice):
  - For each row whose `application_id` is not already a clean digit-run: compute the normalized id.
  - If no digits → delete the row (junk, e.g. the `"Application ID + Link"` header row).
  - If the normalized id collides with an existing row → keep the row with the newest `updated_at`; set the other's `status` to `superseded` (retained for audit, excluded from pending/completed buckets).
  - Otherwise → update `application_id` in place.
  - Logs a summary: `{ scanned, normalized, deleted, superseded }`.

## Phase 2 — Make completion real (prerequisite for Phase 3)

- **Raw-body HMAC** for `POST /webhooks/connect`: capture raw bytes via an `express.json({ verify })` hook scoped to that route, and compute the HMAC over those exact bytes. The current code hashes `JSON.stringify(req.body)`, which cannot match DocuSign's signature — meaning enabling `DOCUSIGN_CONNECT_HMAC_SECRET` today would reject valid callbacks, and leaving it unset (current state, `connectHmacEnabled:false`) leaves the endpoint unauthenticated.
- **Reconciliation poller** (`docusign/reconcile.js`), started from `server.js` alongside the existing schedulers:
  - `GET {baseUri}/restapi/v2.1/accounts/{accountId}/envelopes?from_date=<cursor>` (DocuSign listStatusChanges) → for each envelope known to our store, `markEnvelopeStatus(envelopeId, status)`.
  - Cursor persisted as `storage/docusign_reconcile_state.json` (`{ lastFromDate }`), initialised to 30 days ago on first run; advanced to the run start time on success only.
  - Env: `DOCUSIGN_RECONCILE_ENABLED` (default `"true"`), `DOCUSIGN_RECONCILE_INTERVAL_SECONDS` (default `300`, min `60`).
- **Single completion hook:** both the Connect webhook and the poller call one shared `onEnvelopeStatus(envelopeId, status)` so Phase 3 fires identically from either path.
- **Surface attention statuses:** `/overview` gains a `needsAttention` bucket + counts for `declined`, `voided`, `expired` (today they fall through both buckets and are invisible). `superseded` is excluded from all buckets.

## Phase 3 — Signed PDF → CRM (the feature)

Triggered by `onEnvelopeStatus` when status becomes `completed` (from webhook or poller).

1. **Guard/idempotency:** skip if the row's `crm_upload_status` is already `uploaded`. Skip (log) if `DOCUSIGN_CRM_DOC_CONFIG_ID` is unset — never file under a wrong type.
2. **Resolve CRM user id:** new `crm_user_id` column on `docusign_envelope_map`, captured at send time (the FXBO webhook payload and the sync path both already resolve `userId`). For pre-existing rows where it is null, fall back to `fetchCrmApplicationApplicantById(application_id)` → `userId`. If still unresolved → `crm_upload_status='failed'`, `last_error='crm_user_unresolved'`, retried next cycle.
3. **Download** the combined signed PDF from DocuSign (45s timeout).
4. **Upload** to FXBO:
   ```
   POST /rest/documents/new?version=<VITE_API_VERSION>
   Authorization: Bearer <VITE_API_TOKEN>
   {
     "user": <crm_user_id>,
     "config": <DOCUSIGN_CRM_DOC_CONFIG_ID>,     // 73 = "SCA Agreement"
     "status": "approved",
     "isUploadedByClient": false,
     "description": "DocuSign signed agreement (envelope <envelopeId>, application <applicationId>)",
     "data": { "file": [ { "file": "<base64 pdf>", "name": "signed-agreement-<applicationId>.pdf" } ] }
   }
   ```
   No `expiresAt` (config 73 has `hasExpiration:false`).
5. **Record outcome** via the existing (currently dead) `markCrmUploadStatus`: `uploaded` on success; `failed` + `last_error` otherwise. The Back Office panel's existing "CRM Upload" label becomes meaningful.
6. **Retry:** failures are retried on subsequent reconcile ticks (the status stays `completed`, `crm_upload_status` stays `failed`), so a transient CRM outage self-heals. No duplicate upload is possible because success flips the guard in step 1.

## Phase 4 — Security + operability

- `authRequired` + Back Office access on `/overview`, `/sync-status`, `/applications/:id`, `/envelopes/:id`. Reuses `authRequired` + a new exported `hasAccessPermission(payload, "Backoffice")` from `auth/router.js`. Inbound webhooks keep their own bearer/HMAC auth (unchanged). The panel's fetch starts sending the auth header.
- **"Run sync now"** button in the Back Office DocuSign panel → `POST /api/docusign/run-sync` (`authRequired` + Back Office access) → `runApprovedApplicationsSync()`; shows the returned summary inline. Mirrors the Slippage test-send button.

## Data flow

Approved application (FXBO webhook or 5-min sync) → **normalize id** → idempotent create → envelope stored (with `crm_user_id`).
Client signs → Connect webhook (raw-body HMAC verified) **or** reconcile poller → `onEnvelopeStatus(…, "completed")` → download signed PDF → upload to FXBO config 73 as `approved` → `crm_upload_status='uploaded'`.
Panel reads the gated `/overview` (30s poll) and shows sent/pending/completed/needsAttention + CRM upload state.

## Error handling

- Invalid/garbage application id → `400`, nothing stored.
- Config id unset → skip upload with a warning (fail-safe, never mis-file).
- DocuSign download / FXBO upload failure → `crm_upload_status='failed'` + `last_error`; retried next tick; poller continues.
- Reconcile failure → logged, cursor **not** advanced (so nothing is skipped), retried next tick.
- Cleanup migration runs once, is guarded, and logs exactly what it changed.

## Testing

- **Unit (vitest, pure):** `normalizeApplicationId` (HTML anchor / plain / no-digits / empty / whitespace); raw-body HMAC verify (matching + mismatching bytes); overview status bucketing (pending/completed/needsAttention/superseded excluded); CRM upload **payload builder** — asserts `user`, `config`, `status:"approved"`, and `data.file[0] == { file: <base64>, name: "signed-agreement-<id>.pdf" }`.
- **Migration:** unit-test the decide-function (normalize / delete / supersede) against fixture rows; dry-run log before the real run.
- **Live:** boot check (both schedulers register, no errors); one controlled end-to-end envelope to a test client to confirm the document lands on config 73 as `approved`.

## New / changed files

- New: `docusign/appId.js`, `docusign/migrateAppIds.js`, `docusign/reconcile.js`, `docusign/crmUpload.js`, plus their tests.
- Edit: `docusign/router.js` (normalize + raw-body HMAC + shared status hook + gated reads + run-sync route), `docusign/sync.js` (normalize + capture `crm_user_id`), `docusign/store.js` (`crm_user_id` column, `superseded` handling), `docusign/client.js` (download combined PDF), `docusign/crm.js` (create-document call), `server.js` (start reconciler, mount route), `auth/router.js` (export `hasAccessPermission`), `src/components/dashboard/BackOfficeDepartment.tsx` (auth header, needsAttention, Run-sync button), `src/lib/docusignApi.ts` (types + auth).
- Env: `DOCUSIGN_CRM_DOC_CONFIG_ID=73`, `DOCUSIGN_RECONCILE_ENABLED`, `DOCUSIGN_RECONCILE_INTERVAL_SECONDS`, and (operator action) `DOCUSIGN_CONNECT_HMAC_SECRET` once the raw-body fix ships.

## Out of scope

- Resend / void / remind envelope actions from the panel.
- Sumsub ↔ CRM entity sync (separate, parked).
- Backfilling signed PDFs for envelopes that completed before this ships (the reconcile poller will pick up any still marked `sent` that DocuSign reports `completed` within the cursor window; anything older is a manual one-off).
- Changing which template/role DocuSign uses.
