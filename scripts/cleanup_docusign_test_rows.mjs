import sqlite3 from "sqlite3";

const db = new (sqlite3.verbose().Database)("./crm_mt5.db");
const sql = "DELETE FROM docusign_envelope_map WHERE application_id LIKE 'TEST-DS-%'";

db.run(sql, function onRun(err) {
  if (err) {
    console.error(`cleanup_failed: ${err.message}`);
    process.exitCode = 1;
  } else {
    console.log(`deleted_rows=${this.changes}`);
  }

  db.close((closeErr) => {
    if (closeErr) {
      console.error(`close_failed: ${closeErr.message}`);
      process.exitCode = 1;
    }
  });
});
