import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mysql from "mysql2/promise";

const router = express.Router();

const AUTH_DB_HOST = process.env.AUTH_DB_HOST;
const AUTH_DB_PORT = Number(process.env.AUTH_DB_PORT || 3306);
const AUTH_DB_NAME = process.env.AUTH_DB_NAME;
const AUTH_DB_USER = process.env.AUTH_DB_USER;
const AUTH_DB_PASSWORD = process.env.AUTH_DB_PASSWORD;
const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET;

const SEED_NAME = process.env.AUTH_SEED_NAME || "Abbas";
const SEED_EMAIL = process.env.AUTH_SEED_EMAIL || "abbas@skylinks.capital";
const SEED_PASSWORD = process.env.AUTH_SEED_PASSWORD || "admin123";
const JWT_EXPIRES_IN = process.env.AUTH_JWT_EXPIRES_IN || "30d";

let pool = null;
let initPromise = null;

function hasDbConfig() {
  return Boolean(AUTH_DB_HOST && AUTH_DB_NAME && AUTH_DB_USER && AUTH_DB_PASSWORD);
}

function normalizeAccess(value) {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toAuthUser(row) {
  return {
    id: String(row.id),
    name: String(row.name || ""),
    email: String(row.email || ""),
    role: String(row.role || "User"),
    access: normalizeAccess(row.access_json),
    status: row.status === "suspended" ? "suspended" : "active",
  };
}

async function ensureInitialized() {
  if (!hasDbConfig()) {
    throw new Error("Auth DB env vars are missing.");
  }
  if (!AUTH_JWT_SECRET) {
    throw new Error("AUTH_JWT_SECRET is missing.");
  }
  if (pool) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    pool = mysql.createPool({
      host: AUTH_DB_HOST,
      port: AUTH_DB_PORT,
      database: AUTH_DB_NAME,
      user: AUTH_DB_USER,
      password: AUTH_DB_PASSWORD,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        email VARCHAR(190) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'User',
        status ENUM('active','suspended') NOT NULL DEFAULT 'active',
        access_json JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    const [existing] = await pool.query("SELECT id FROM users WHERE email = ? LIMIT 1", [SEED_EMAIL]);
    if (!existing.length) {
      const hash = await bcrypt.hash(SEED_PASSWORD, 10);
      const access = JSON.stringify(["Dealing", "Accounts", "Settings", "Backoffice", "HR", "Marketing", "Alerts"]);
      await pool.query(
        "INSERT INTO users (name, email, password_hash, role, status, access_json) VALUES (?, ?, ?, 'Super Admin', 'active', ?)",
        [SEED_NAME, SEED_EMAIL, hash, access]
      );
    }
  })();

  return initPromise;
}

function signUserToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      access: user.access,
      status: user.status,
      name: user.name,
    },
    AUTH_JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

async function authRequired(req, res, next) {
  const raw = req.headers.authorization || "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
  if (!token) return res.status(401).json({ error: "missing_token" });

  try {
    await ensureInitialized();

    const payload = jwt.verify(token, AUTH_JWT_SECRET);
    const [rows] = await pool.query(
      "SELECT id, name, email, role, status, access_json FROM users WHERE id=? LIMIT 1",
      [payload.sub]
    );

    if (!rows.length) return res.status(401).json({ error: "user_not_found" });

    const user = toAuthUser(rows[0]);
    if (user.status !== "active") return res.status(403).json({ error: "user_suspended" });

    // Always authorize based on latest DB role/access, not stale JWT claims.
    req.auth = {
      ...payload,
      sub: user.id,
      email: user.email,
      role: user.role,
      access: user.access,
      status: user.status,
      name: user.name,
    };

    next();
  } catch (error) {
    if (error?.name === "TokenExpiredError") {
      return res.status(401).json({ error: "expired_token" });
    }
    return res.status(401).json({ error: "invalid_token" });
  }
}

function hasSettingsAccess(payload) {
  const access = Array.isArray(payload?.access) ? payload.access : [];
  const role = String(payload?.role || "").trim().toLowerCase();
  return role === "super admin" || access.includes("Settings");
}

router.post("/login", async (req, res) => {
  try {
    await ensureInitialized();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ error: "email_password_required" });

    const [rows] = await pool.query(
      "SELECT id, name, email, password_hash, role, status, access_json FROM users WHERE LOWER(email)=? LIMIT 1",
      [email]
    );
    if (!rows.length) return res.status(401).json({ error: "invalid_credentials" });
    const row = rows[0];
    if (row.status !== "active") return res.status(403).json({ error: "user_suspended" });

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: "invalid_credentials" });

    const user = toAuthUser(row);
    const token = signUserToken(user);
    return res.json({ token, user });
  } catch (error) {
    return res.status(500).json({ error: "auth_init_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

router.get("/me", authRequired, async (req, res) => {
  try {
    await ensureInitialized();
    const [rows] = await pool.query(
      "SELECT id, name, email, role, status, access_json FROM users WHERE id=? LIMIT 1",
      [req.auth.sub]
    );
    if (!rows.length) return res.status(404).json({ error: "user_not_found" });
    return res.json({ user: toAuthUser(rows[0]) });
  } catch (error) {
    return res.status(500).json({ error: "me_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

router.get("/users", authRequired, async (req, res) => {
  try {
    await ensureInitialized();
    if (!hasSettingsAccess(req.auth)) return res.status(403).json({ error: "forbidden" });
    const [rows] = await pool.query("SELECT id, name, email, role, status, access_json FROM users ORDER BY id DESC");
    return res.json((rows || []).map(toAuthUser));
  } catch (error) {
    return res.status(500).json({ error: "list_users_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

router.post("/users", authRequired, async (req, res) => {
  try {
    await ensureInitialized();
    if (!hasSettingsAccess(req.auth)) return res.status(403).json({ error: "forbidden" });

    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const role = String(req.body?.role || "Analyst");
    const status = req.body?.status === "suspended" ? "suspended" : "active";
    const access = normalizeAccess(req.body?.access);
    if (!name || !email || !password) return res.status(400).json({ error: "name_email_password_required" });

    const [exists] = await pool.query("SELECT id FROM users WHERE LOWER(email)=? LIMIT 1", [email]);
    if (exists.length) return res.status(409).json({ error: "email_exists" });

    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      "INSERT INTO users (name, email, password_hash, role, status, access_json) VALUES (?, ?, ?, ?, ?, ?)",
      [name, email, hash, role, status, JSON.stringify(access)]
    );

    const [rows] = await pool.query("SELECT id, name, email, role, status, access_json FROM users WHERE id=? LIMIT 1", [result.insertId]);
    return res.status(201).json({ user: toAuthUser(rows[0]) });
  } catch (error) {
    return res.status(500).json({ error: "create_user_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

router.put("/users/:id", authRequired, async (req, res) => {
  try {
    await ensureInitialized();
    if (!hasSettingsAccess(req.auth)) return res.status(403).json({ error: "forbidden" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "invalid_id" });

    const [existingRows] = await pool.query(
      "SELECT id, name, email, role, status, access_json FROM users WHERE id=? LIMIT 1",
      [id]
    );
    if (!existingRows.length) return res.status(404).json({ error: "user_not_found" });
    const existing = existingRows[0];

    const name = String(req.body?.name || existing.name).trim();
    const email = String(req.body?.email || existing.email).trim().toLowerCase();
    const role = String(req.body?.role || existing.role);
    const status = req.body?.status === "suspended" ? "suspended" : "active";
    const access = normalizeAccess(req.body?.access ?? existing.access_json);
    const password = String(req.body?.password || "").trim();

    const [emailOwner] = await pool.query("SELECT id FROM users WHERE LOWER(email)=? AND id<>? LIMIT 1", [email, id]);
    if (emailOwner.length) return res.status(409).json({ error: "email_exists" });

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        "UPDATE users SET name=?, email=?, role=?, status=?, access_json=?, password_hash=? WHERE id=?",
        [name, email, role, status, JSON.stringify(access), hash, id]
      );
    } else {
      await pool.query("UPDATE users SET name=?, email=?, role=?, status=?, access_json=? WHERE id=?", [
        name,
        email,
        role,
        status,
        JSON.stringify(access),
        id,
      ]);
    }

    const [rows] = await pool.query("SELECT id, name, email, role, status, access_json FROM users WHERE id=? LIMIT 1", [id]);
    return res.json({ user: toAuthUser(rows[0]) });
  } catch (error) {
    return res.status(500).json({ error: "update_user_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

router.delete("/users/:id", authRequired, async (req, res) => {
  try {
    await ensureInitialized();
    if (!hasSettingsAccess(req.auth)) return res.status(403).json({ error: "forbidden" });
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "invalid_id" });
    if (String(req.auth.sub) === String(id)) return res.status(400).json({ error: "cannot_delete_self" });

    await pool.query("DELETE FROM users WHERE id=?", [id]);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: "delete_user_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
