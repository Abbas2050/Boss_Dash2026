// fetch_and_store_mt5_accounts.cjs
// Fetch all MT5 accounts from /rest/accounts and store in SQLite DB (plain JS, CommonJS)

const axios = require('axios');
const db = require('./db.cjs');
require('dotenv').config();

const API_URL = process.env.VITE_API_URL?.replace('/transactions', '/accounts') || 'http://localhost:8080/rest/accounts?version=1.0.0';
const API_VERSION = process.env.VITE_API_VERSION || '1.0.0';
const API_TOKEN = process.env.VITE_API_TOKEN || '';

async function fetchAccounts() {
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
    console.error('Failed to fetch accounts:', err.response?.data || err.message);
    return [];
  }
}

async function main() {
  const accounts = await fetchAccounts();
  for (const acc of accounts) {
    const client_crm_id = acc.userId;
    const account_id = acc.login;
    const group_name = acc.groupName;
    const account_type = acc.accountTypeId;
    // Insert group if not exists
    db.run(
      `INSERT OR IGNORE INTO mt5_group (name, path) VALUES (?, ?)`,
      [group_name, group_name],
      function (err) {
        if (err) return console.error('Group insert failed:', err.message);
      }
    );
    // Get group_id
    db.all(
      `SELECT id FROM mt5_group WHERE name = ?`,
      [group_name],
      function (err, rows) {
        if (err) return console.error('Group lookup failed:', err.message);
        const group_id = rows && rows[0] ? rows[0].id : null;
        // Get client_id from crm_id
        db.all(
          `SELECT id FROM client WHERE crm_id = ?`,
          [client_crm_id],
          function (err, clientRows) {
            if (err) return console.error('Client lookup failed:', err.message);
            const client_id = clientRows && clientRows[0] ? clientRows[0].id : null;
            // Insert mt5_account
            db.run(
              `INSERT OR IGNORE INTO mt5_account (account_id, account_type, client_id, group_id) VALUES (?, ?, ?, ?)`,
              [account_id, account_type, client_id, group_id],
              function (err) {
                if (err) return console.error('MT5 Account insert failed:', err.message);
                console.log(`Inserted MT5 Account: ${account_id}, Type: ${account_type}, Client CRM_ID: ${client_crm_id}, Group: ${group_name}`);
              }
            );
          }
        );
      }
    );
  }
}

main();
