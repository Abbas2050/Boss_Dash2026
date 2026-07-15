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
  const current = await findByEnvelopeId(envelopeId);
  if (current && String(current.status || "").toLowerCase() === "superseded") {
    // Superseded rows are terminal: a migration marked the older duplicate of
    // an envelope pair this way on purpose, and DocuSign still reports real
    // status for its envelope id. Never let the poller/webhook resurrect it.
    return current;
  }
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
    if (String(row.status || "").toLowerCase() === "superseded") continue;
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
