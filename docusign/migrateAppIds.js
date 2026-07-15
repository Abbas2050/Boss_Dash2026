import { normalizeApplicationId } from "./appId.js";

const isClean = (v) => /^\d+$/.test(String(v ?? ""));
const hasHtmlTag = (v) => /<[^>]+>/.test(String(v ?? ""));
const hasAnyDigit = (v) => /\d/.test(String(v ?? ""));
const ts = (v) => {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : 0;
};

/**
 * Pure decision function: given the current rows, decide what to change.
 *
 * Classification of each row by its raw application_id:
 *  1. Already a clean digit-run (/^\d+$/)        -> keep as-is, but still
 *     participate in collision grouping (may be the duplicate partner of an
 *     HTML row).
 *  2. Contains an HTML tag (the FXBO anchor bug)  -> normalize via
 *     normalizeApplicationId. Empty result -> delete. Otherwise participate
 *     in collision grouping and update to the normalized id (unless already
 *     clean).
 *  3. No HTML and no digits at all                -> delete (junk, e.g. a
 *     spreadsheet header row).
 *  4. No HTML but has digits, not a pure digit-run -> leave completely
 *     alone: opaque ids like "APP-TEST-001" must never be mangled by
 *     extracting a substring of digits, and must not enter collision
 *     grouping.
 */
export function decideRowActions(rows) {
  const updates = [];
  const deletes = [];
  const supersedes = [];

  const byNorm = new Map();
  for (const r of rows) {
    const raw = r.application_id;

    if (isClean(raw)) {
      // Rule 1: clean digit-run, keep as-is but still group for collisions.
      const norm = String(raw ?? "");
      const list = byNorm.get(norm) || [];
      list.push(r);
      byNorm.set(norm, list);
      continue;
    }

    if (hasHtmlTag(raw)) {
      // Rule 2: HTML-wrapped id, normalize.
      const norm = normalizeApplicationId(raw);
      if (!norm) {
        deletes.push(r.id);
        continue;
      }
      const list = byNorm.get(norm) || [];
      list.push(r);
      byNorm.set(norm, list);
      continue;
    }

    if (!hasAnyDigit(raw)) {
      // Rule 3: no HTML, no digits at all -> junk.
      deletes.push(r.id);
      continue;
    }

    // Rule 4: no HTML, has digits, not a pure digit-run -> opaque id, leave alone.
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
    // Free the application_id too: leaving it unchanged means the winner's
    // UPDATE below can collide with uq_docusign_application_id if the loser
    // held the clean numeric id the winner is being normalized to.
    await pool.query(
      `UPDATE docusign_envelope_map SET status = 'superseded', application_id = CONCAT('superseded:', id, ':', application_id), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id]
    );
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
