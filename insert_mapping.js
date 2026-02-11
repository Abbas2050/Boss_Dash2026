// insert_mapping.js
// Script to insert a mapping into SQLite

import db from './db.js';

export function insertMapping(name, crm_id, mt5account_id) {
  db.run(
    `INSERT OR IGNORE INTO account_mapping (name, crm_id, mt5account_id) VALUES (?, ?, ?)`,
    [name, crm_id, mt5account_id],
    function (err) {
      if (err) {
        return console.error('Insert failed:', err.message);
      }
      console.log(`Inserted mapping: ${name}, CRM_ID: ${crm_id}, MT5ACCOUNT_ID: ${mt5account_id}`);
    }
  );
}

// Example usage:
// insertMapping('John Doe', 'CRM123', 'MT5001');
