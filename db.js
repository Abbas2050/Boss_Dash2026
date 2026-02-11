// db.js
// SQLite setup for CRM/MT5 structure with entity support (ES module)

import sqlite3 from 'sqlite3';
const db = new sqlite3.Database('./crm_mt5.db');

db.serialize(() => {
  // Entities
  db.run(`CREATE TABLE IF NOT EXISTS entity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  )`);

  // Clients
  db.run(`CREATE TABLE IF NOT EXISTS client (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    crm_id TEXT NOT NULL UNIQUE,
    entity_id INTEGER NOT NULL,
    FOREIGN KEY (entity_id) REFERENCES entity(id)
  )`);

  // Groups
  db.run(`CREATE TABLE IF NOT EXISTS mt5_group (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL
  )`);

  // MT5 Accounts
  db.run(`CREATE TABLE IF NOT EXISTS mt5_account (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL UNIQUE,
    account_type TEXT NOT NULL,
    client_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    FOREIGN KEY (client_id) REFERENCES client(id),
    FOREIGN KEY (group_id) REFERENCES mt5_group(id)
  )`);

  // Symbols
  db.run(`CREATE TABLE IF NOT EXISTS symbol (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    group_id INTEGER NOT NULL,
    FOREIGN KEY (group_id) REFERENCES mt5_group(id)
  )`);
});

export default db;