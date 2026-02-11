// fetch_and_store_clients.ts
// Fetch all clients from /rest/users and store in SQLite DB

import { fetchUsers } from './src/lib/api';
import db from './db.js';

async function main() {
  // Fetch all users (clients)
  let users = [];
  try {
    users = await fetchUsers({});
  } catch (err) {
    console.error('Failed to fetch users:', err);
    process.exit(1);
  }

  for (const user of users) {
    const name = user.firstName;
    const crm_id = user.id;
    // Try to get entity from custom fields (if present)
    let entity = null;
    if ((user as any).customFields && (user as any).customFields.entity) {
      entity = (user as any).customFields.entity;
    }
    // Insert entity if not exists
    if (entity) {
      db.run(
        `INSERT OR IGNORE INTO entity (name) VALUES (?)`,
        [entity],
        function (err) {
          if (err) return console.error('Entity insert failed:', err.message);
        }
      );
    }
    // Get entity_id
    db.get(
      `SELECT id FROM entity WHERE name = ?`,
      [entity],
      function (err, row) {
        if (err) return console.error('Entity lookup failed:', err.message);
        const entity_id = row ? row.id : null;
        // Insert client
        db.run(
          `INSERT OR IGNORE INTO client (name, crm_id, entity_id) VALUES (?, ?, ?)`,
          [name, crm_id, entity_id],
          function (err) {
            if (err) return console.error('Client insert failed:', err.message);
            console.log(`Inserted client: ${name}, CRM_ID: ${crm_id}, ENTITY: ${entity}`);
          }
        );
      }
    );
  }
}

main();
