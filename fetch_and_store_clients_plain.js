// fetch_and_store_clients_plain.js
// Fetch all clients from /rest/users and store in SQLite DB (plain JS)

const axios = require('axios');
const db = require('./db');
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
    if (user.customFields && user.customFields.entity) {
      entity = user.customFields.entity;
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
