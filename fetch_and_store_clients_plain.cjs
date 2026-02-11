// fetch_and_store_clients_plain.cjs
// Fetch all clients from /rest/users and store in SQLite DB (plain JS, CommonJS)

const axios = require('axios');
const db = require('./db.cjs');
require('dotenv').config();

const API_URL = process.env.VITE_API_URL?.replace('/transactions', '/users') || 'http://localhost:8080/rest/users?version=1.0.0';
const API_VERSION = process.env.VITE_API_VERSION || '1.0.0';
const API_TOKEN = process.env.VITE_API_TOKEN || '';

async function fetchUsers() {
  const url = `${API_URL}?version=${API_VERSION}`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${API_TOKEN}`,
  };
  try {
    const res = await axios.post(url, {}, { headers });
    return res.data;
  } catch (err) {
    console.error('Failed to fetch users:', err.response?.data || err.message);
    return [];
  }
}

async function main() {
  const users = await fetchUsers();
  for (const user of users) {
    const name = user.firstName;
    const crm_id = user.id;
    let entity = null;
    if (user.customFields && user.customFields.custom_change_me_field) {
      entity = user.customFields.custom_change_me_field;
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
    db.all(
      `SELECT id FROM entity WHERE name = ?`,
      [entity],
      function (err, rows) {
        if (err) return console.error('Entity lookup failed:', err.message);
        const entity_id = rows && rows[0] ? rows[0].id : null;
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
