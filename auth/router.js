import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
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
const SEED_PASSWORD = process.env.AUTH_SEED_PASSWORD || "";
const JWT_EXPIRES_IN = process.env.AUTH_JWT_EXPIRES_IN || "8h";
const MANAGE_USERS_PERMISSION = "Auth:ManageUsers";

const ALLOWED_ROLES = new Set(["Super Admin", "Manager", "Analyst", "Support"]);
const ALLOWED_ACCESS_ROOTS = new Set([
  "Dashboard",
  "Dealing",
  "Accounts",
  "Backoffice",
  "Marketing",
  "HR",
  "Settings",
  "Alerts",
  "LiveAgent",
  "Notifications",
  "Auth",
]);

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const loginAttempts = new Map();

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

function parseJsonObject(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function sanitizeAccess(access) {
  return normalizeAccess(access)
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item) => {
      const [root] = item.split(":");
      return ALLOWED_ACCESS_ROOTS.has(root);
    })
    .filter((item, index, arr) => arr.indexOf(item) === index);
}

function sanitizeRole(role) {
  const candidate = String(role || "").trim();
  if (!ALLOWED_ROLES.has(candidate)) return "Analyst";
  return candidate;
}

function getAttemptKey(req, email) {
  return `${String(req.ip || "unknown").trim()}|${String(email || "").trim().toLowerCase()}`;
}

function isRateLimited(req, email) {
  const key = getAttemptKey(req, email);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (now - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function noteFailedLogin(req, email) {
  const key = getAttemptKey(req, email);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, first: now });
    return;
  }
  loginAttempts.set(key, { ...entry, count: entry.count + 1 });
}

function clearFailedLogin(req, email) {
  loginAttempts.delete(getAttemptKey(req, email));
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
        token_version INT NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        actor_user_id INT NULL,
        action VARCHAR(80) NOT NULL,
        target_user_id INT NULL,
        metadata_json JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const [existing] = await pool.query("SELECT id FROM users WHERE email = ? LIMIT 1", [SEED_EMAIL]);
    if (!existing.length) {
      const seededPassword = String(SEED_PASSWORD || "").trim();
      if (!seededPassword) {
        throw new Error("AUTH_SEED_PASSWORD must be set to bootstrap the initial admin user.");
      }
      const hash = await bcrypt.hash(seededPassword, 12);
      const access = JSON.stringify(["Dealing", "Accounts", "Settings", "Backoffice", "HR", "Marketing", "Alerts", MANAGE_USERS_PERMISSION]);
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
      tv: Number(user.tokenVersion || 1),
      jti: crypto.randomUUID(),
    },
    AUTH_JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

async function authRequired(req, res, next) {
  const raw = req.headers.authorization || "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
  if (!token) return res.status(401).json({ error: "missing_token" });

  // Separate DB init errors (503) from auth errors (401)
  try {
    await ensureInitialized();
  } catch (initErr) {
    return res.status(503).json({
      error: "auth_service_unavailable",
      message: initErr instanceof Error ? initErr.message : String(initErr),
    });
  }

  try {
    const payload = jwt.verify(token, AUTH_JWT_SECRET);
    const [rows] = await pool.query(
      "SELECT id, name, email, role, status, access_json, token_version FROM users WHERE id=? LIMIT 1",
      [payload.sub]
    );

    if (!rows.length) return res.status(401).json({ error: "user_not_found" });

    const user = toAuthUser(rows[0]);
    if (user.status !== "active") return res.status(403).json({ error: "user_suspended" });
    const tokenVersion = Number(rows[0]?.token_version || 1);
    if (Number(payload?.tv || 1) !== tokenVersion) {
      return res.status(401).json({ error: "revoked_token" });
    }

    // Always authorize based on latest DB role/access, not stale JWT claims.
    req.auth = {
      ...payload,
      sub: user.id,
      email: user.email,
      role: user.role,
      access: user.access,
      status: user.status,
      name: user.name,
      tv: tokenVersion,
    };

    next();
  } catch (error) {
    if (error?.name === "TokenExpiredError") {
      return res.status(401).json({ error: "expired_token" });
    }
    return res.status(401).json({ error: "invalid_token" });
  }
}

function canManageUsers(payload) {
  const access = Array.isArray(payload?.access) ? payload.access : [];
  const role = String(payload?.role || "").trim().toLowerCase();
  return role === "super admin" || access.includes(MANAGE_USERS_PERMISSION);
}

async function logAuthEvent(actorUserId, action, targetUserId, metadata) {
  if (!pool) return;
  try {
    await pool.query(
      "INSERT INTO auth_events (actor_user_id, action, target_user_id, metadata_json) VALUES (?, ?, ?, ?)",
      [actorUserId ?? null, String(action || "unknown"), targetUserId ?? null, JSON.stringify(metadata || {})]
    );
  } catch {
    // Non-blocking audit logging.
  }
}

router.post("/login", async (req, res) => {
  try {
    await ensureInitialized();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ error: "email_password_required" });
    if (isRateLimited(req, email)) {
      await logAuthEvent(null, "auth.login.rate_limited", null, { email, ip: req.ip });
      return res.status(429).json({ error: "too_many_attempts", message: "Too many login attempts. Please try again later." });
    }

    const [rows] = await pool.query(
      "SELECT id, name, email, password_hash, role, status, access_json, token_version FROM users WHERE LOWER(email)=? LIMIT 1",
      [email]
    );
    if (!rows.length) {
      noteFailedLogin(req, email);
      await logAuthEvent(null, "auth.login.failed", null, { email, reason: "invalid_credentials", ip: req.ip });
      return res.status(401).json({ error: "invalid_credentials" });
    }
    const row = rows[0];
    if (row.status !== "active") {
      noteFailedLogin(req, email);
      await logAuthEvent(null, "auth.login.failed", Number(row.id), { email, reason: "user_suspended", ip: req.ip });
      return res.status(403).json({ error: "user_suspended" });
    }

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      noteFailedLogin(req, email);
      await logAuthEvent(null, "auth.login.failed", Number(row.id), { email, reason: "invalid_credentials", ip: req.ip });
      return res.status(401).json({ error: "invalid_credentials" });
    }

    clearFailedLogin(req, email);
    const user = {
      ...toAuthUser(row),
      tokenVersion: Number(row.token_version || 1),
    };
    const token = signUserToken(user);
    await logAuthEvent(Number(user.id), "auth.login.success", Number(user.id), { ip: req.ip });
    return res.json({ token, user: toAuthUser(row) });
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
    if (!canManageUsers(req.auth)) return res.status(403).json({ error: "forbidden" });
    const [rows] = await pool.query("SELECT id, name, email, role, status, access_json, created_at, updated_at FROM users ORDER BY id DESC");
    return res.json((rows || []).map((row) => ({
      ...toAuthUser(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })));
  } catch (error) {
    return res.status(500).json({ error: "list_users_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

router.post("/users", authRequired, async (req, res) => {
  try {
    await ensureInitialized();
    if (!canManageUsers(req.auth)) return res.status(403).json({ error: "forbidden" });

    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const role = sanitizeRole(req.body?.role || "Analyst");
    const status = req.body?.status === "suspended" ? "suspended" : "active";
    const access = sanitizeAccess(req.body?.access);
    if (!name || !email || !password) return res.status(400).json({ error: "name_email_password_required" });
    if (String(req.auth?.role || "") !== "Super Admin" && role === "Super Admin") {
      return res.status(403).json({ error: "forbidden_super_admin_assignment" });
    }

    const [exists] = await pool.query("SELECT id FROM users WHERE LOWER(email)=? LIMIT 1", [email]);
    if (exists.length) return res.status(409).json({ error: "email_exists" });

    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
      "INSERT INTO users (name, email, password_hash, role, status, access_json) VALUES (?, ?, ?, ?, ?, ?)",
      [name, email, hash, role, status, JSON.stringify(access)]
    );

    const [rows] = await pool.query("SELECT id, name, email, role, status, access_json FROM users WHERE id=? LIMIT 1", [result.insertId]);
    await logAuthEvent(Number(req.auth.sub), "auth.user.created", Number(result.insertId), {
      role,
      status,
      accessCount: access.length,
    });
    return res.status(201).json({ user: toAuthUser(rows[0]) });
  } catch (error) {
    return res.status(500).json({ error: "create_user_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

router.put("/users/:id", authRequired, async (req, res) => {
  try {
    await ensureInitialized();
    if (!canManageUsers(req.auth)) return res.status(403).json({ error: "forbidden" });

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
    const role = sanitizeRole(req.body?.role || existing.role);
    const status = req.body?.status === "suspended" ? "suspended" : "active";
    const access = sanitizeAccess(req.body?.access ?? existing.access_json);
    const password = String(req.body?.password || "").trim();

    if (String(req.auth?.role || "") !== "Super Admin" && role === "Super Admin") {
      return res.status(403).json({ error: "forbidden_super_admin_assignment" });
    }

    const [emailOwner] = await pool.query("SELECT id FROM users WHERE LOWER(email)=? AND id<>? LIMIT 1", [email, id]);
    if (emailOwner.length) return res.status(409).json({ error: "email_exists" });

    if (password) {
      const hash = await bcrypt.hash(password, 12);
      await pool.query(
        "UPDATE users SET name=?, email=?, role=?, status=?, access_json=?, password_hash=?, token_version=token_version+1 WHERE id=?",
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
    await logAuthEvent(Number(req.auth.sub), "auth.user.updated", id, {
      role,
      status,
      accessCount: access.length,
      passwordChanged: Boolean(password),
    });
    return res.json({ user: toAuthUser(rows[0]) });
  } catch (error) {
    return res.status(500).json({ error: "update_user_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

router.delete("/users/:id", authRequired, async (req, res) => {
  try {
    await ensureInitialized();
    if (!canManageUsers(req.auth)) return res.status(403).json({ error: "forbidden" });
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "invalid_id" });
    if (String(req.auth.sub) === String(id)) return res.status(400).json({ error: "cannot_delete_self" });

    await pool.query("DELETE FROM users WHERE id=?", [id]);
    await logAuthEvent(Number(req.auth.sub), "auth.user.deleted", id, {});
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: "delete_user_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

router.post("/logout", authRequired, async (req, res) => {
  try {
    await ensureInitialized();
    await pool.query("UPDATE users SET token_version = token_version + 1 WHERE id=?", [req.auth.sub]);
    await logAuthEvent(Number(req.auth.sub), "auth.logout", Number(req.auth.sub), { ip: req.ip });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: "logout_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

router.get("/audit-events", authRequired, async (req, res) => {
  try {
    await ensureInitialized();
    if (!canManageUsers(req.auth)) return res.status(403).json({ error: "forbidden" });
    const limitRaw = Number(req.query?.limit || 100);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;
    const [rows] = await pool.query(
      `SELECT id, actor_user_id, action, target_user_id, metadata_json, created_at
       FROM auth_events
       ORDER BY id DESC
       LIMIT ${limit}`
    );

    return res.json(
      (rows || []).map((row) => ({
        id: Number(row.id),
        actorUserId: row.actor_user_id == null ? null : String(row.actor_user_id),
        action: String(row.action || ""),
        targetUserId: row.target_user_id == null ? null : String(row.target_user_id),
        metadata: parseJsonObject(row.metadata_json, {}),
        createdAt: row.created_at,
      }))
    );
  } catch (error) {
    return res.status(500).json({ error: "audit_events_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
