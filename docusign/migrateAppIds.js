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
