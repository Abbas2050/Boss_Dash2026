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
  "Tickets",
  "CP",
  // The Sales department page. Necessary but not sufficient on its own: the nav
  // item also wants a crmManagerId on the record, or the Super Admin role --
  // see canAccessDepartmentItem in src/lib/permissions.ts. Without this entry
  // sanitizeAccess would strip the chip on every save and the page would be
  // unreachable with no error shown.
  "Sales",
]);

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const loginAttempts = new Map();

// Per-IP cap, alongside the per-email cap above. The per-email cap bounds
// guesses against one address; it does nothing to bound an attacker who
// sprays many different addresses from a single IP (account enumeration /
// credential stuffing), since each address gets its own fresh budget. This
// closes that gap by also counting failures per IP, independent of which
// email they were aimed at.
//
// Threshold: 40 failures per IP per 15-minute window. Chosen so a shared
// office NAT IP (~10 people) is never blocked by ordinary use -- a morning
// login rush plus everyone re-authenticating after a network blip could
// plausibly produce a handful of mistyped-password failures per person
// (say, up to 3-4 each), which lands well under 40. An attacker spraying
// many addresses from one IP, by contrast, is capped at 40 total guesses
// across every address in the window -- far too few to make enumeration or
// credential stuffing practical, and much tighter than the effectively
// unlimited total the per-email-only cap allowed.
const LOGIN_IP_MAX_ATTEMPTS = 40;
const loginIpAttempts = new Map();

/**
 * Columns added to `users` after its first version, for tables that already
 * exist. Exported so a test can assert the list without a database.
 */
export const USERS_ADDED_COLUMNS = [
  ["crm_manager_id", "ALTER TABLE users ADD COLUMN crm_manager_id INT NULL"],
];

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

/**
 * The FXBO manager id that makes this user a salesperson, as a POSITIVE INTEGER
 * or nothing.
 *
 * Three answers, and the difference between the last two matters:
 *   { ok: true, value: undefined }  the key was absent -- leave the stored value alone,
 *                                   so a client that does not know about the field
 *                                   cannot blank it by omission.
 *   { ok: true, value: null }       explicitly cleared (null or "").
 *   { ok: true, value: 28 }         a usable id.
 *   { ok: false }                   present and unusable -> the caller answers 400.
 *
 * `"28"` is accepted and stored as 28. The whole hazard in this field is a
 * string that looks right and matches nothing: the commission join compares it
 * against FXBO's `managerId`, and `28 === "28"` is false, so a salesperson
 * whose id was stored as text would be shown an empty book and told they had
 * earned nothing, with no error anywhere. Coercing here, and again on both
 * sides of the join in sales/commissionCore.js, is the only arrangement that
 * cannot fail quietly.
 *
 * Genuine rubbish ("abc", 0, -5, 2.5) is rejected rather than silently nulled,
 * so an admin's typo surfaces at save time instead of as a 403 the salesperson
 * has to report.
 */
export function parseCrmManagerId(raw) {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  // Only a number or a string can be a manager id. Without this guard an empty
  // array stringifies to "" and would read as a deliberate clear, and `true`
  // would read as 1 -- a real manager id.
  if (typeof raw !== "number" && typeof raw !== "string") return { ok: false };
  if (String(raw).trim() === "") return { ok: true, value: null };
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0) return { ok: false };
  return { ok: true, value: n };
}

function sanitizeRole(role) {
  const candidate = String(role || "").trim();
  if (!ALLOWED_ROLES.has(candidate)) return "Analyst";
  return candidate;
}

function getAttemptKey(req, email) {
  return `${String(req.ip || "unknown").trim()}|${String(email || "").trim().toLowerCase()}`;
}

function getIpKey(req) {
  return String(req.ip || "unknown").trim();
}

// `now` is injectable (defaults to Date.now) purely so tests can exercise
// window expiry deterministically without a real 15-minute sleep; every
// production call site uses the default.
function isRateLimited(req, email, now = Date.now()) {
  const key = getAttemptKey(req, email);
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (now - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

// Mirrors isRateLimited, but keyed on IP alone so it also catches an
// attacker who never reuses the same email twice.
function isIpRateLimited(req, now = Date.now()) {
  const key = getIpKey(req);
  const entry = loginIpAttempts.get(key);
  if (!entry) return false;
  if (now - entry.first > LOGIN_WINDOW_MS) {
    loginIpAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_IP_MAX_ATTEMPTS;
}

function noteFailedLoginForEmail(req, email, now) {
  const key = getAttemptKey(req, email);
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, first: now });
    return;
  }
  loginAttempts.set(key, { ...entry, count: entry.count + 1 });
}

function noteFailedLoginForIp(req, now) {
  const key = getIpKey(req);
  const entry = loginIpAttempts.get(key);
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
    loginIpAttempts.set(key, { count: 1, first: now });
    return;
  }
  loginIpAttempts.set(key, { ...entry, count: entry.count + 1 });
}

// A failed login counts against both caps: the address it was aimed at, and
// the IP it came from. A success counts against neither -- proving you know
// a password is not evidence of an attack, even if you needed a few tries
// to type it correctly.
function noteFailedLogin(req, email, now = Date.now()) {
  noteFailedLoginForEmail(req, email, now);
  noteFailedLoginForIp(req, now);
}

// Only the per-email entry is cleared on success. The per-IP counter is
// deliberately left alone: if it were cleared too, an attacker spraying
// many addresses from one IP could reset their own budget the moment any
// one guess (e.g. their own throwaway account) happened to succeed.
function clearFailedLogin(req, email) {
  loginAttempts.delete(getAttemptKey(req, email));
}

// Test-only: the two maps are process-lifetime singletons so unit tests
// need a way to start each case from a clean slate without reaching for
// module-reset hacks.
function resetLoginRateLimitState() {
  loginAttempts.clear();
  loginIpAttempts.clear();
}

function toAuthUser(row) {
  // ABSENT, not null and not zero, when the user is not a salesperson -- which
  // is most of them. `crmManagerId: null` would serialise into every session
  // payload and every user list as a field that looks set-but-empty, and
  // `crmManagerId: 0` would be a manager id. The commission route's scope check
  // reads "is there an id here", so the honest value for "no" is no key.
  const crmManagerId = parseCrmManagerId(row.crm_manager_id);
  return {
    id: String(row.id),
    name: String(row.name || ""),
    email: String(row.email || ""),
    role: String(row.role || "User"),
    access: normalizeAccess(row.access_json),
    status: row.status === "suspended" ? "suspended" : "active",
    ...(crmManagerId.ok && typeof crmManagerId.value === "number" ? { crmManagerId: crmManagerId.value } : {}),
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
        -- The FXBO manager id this user is a salesperson for. NULL for almost
        -- everyone. INT, not VARCHAR: the commission join compares it to
        -- FXBO's numeric managerId, and a text column would invite a value
        -- that looks right and matches nothing.
        crm_manager_id INT NULL,
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

    // `users` is already deployed, so CREATE TABLE IF NOT EXISTS above will not
    // add the column to the live table -- this will. Guarded on
    // information_schema rather than `ADD COLUMN IF NOT EXISTS`, which MySQL 8
    // does not accept (it is MariaDB syntax, and this host is MySQL); same
    // pattern as crmSignup/store.js and docusign/store.js.
    //
    // Failing to add it is fatal, not ignorable: every SELECT below names the
    // column, so a half-migrated table would make login itself throw rather
    // than quietly lose a field.
    for (const [column, statement] of USERS_ADDED_COLUMNS) {
      const [found] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = ?`,
        [column]
      );
      if (Number(found?.[0]?.cnt || 0) === 0) await pool.query(statement);
    }

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
      "SELECT id, name, email, role, status, access_json, crm_manager_id, token_version FROM users WHERE id=? LIMIT 1",
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
      // From the DATABASE ROW, and set after the `...payload` spread so a token
      // minted before the field existed -- or carrying a stale copy of it --
      // cannot win. `signUserToken` deliberately does not put crmManagerId in
      // the JWT at all: a token lives eight hours, and this field decides whose
      // commission a caller can read, so there must be exactly one source for
      // it and it must be the one an admin can change. The key is absent, not
      // null, when the user is not a salesperson (see toAuthUser) -- so this
      // assignment is `undefined` for them, which overwrites any stale claim.
      crmManagerId: user.crmManagerId,
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

function hasAccessPermission(payload, key) {
  const access = Array.isArray(payload?.access) ? payload.access : [];
  const role = String(payload?.role || "").trim().toLowerCase();
  if (role === "super admin") return true;
  if (access.includes(key)) return true;
  return access.some((a) => String(a).split(":")[0] === key);
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
    // Check the IP-wide cap first: it is the broader signal (a spray attack
    // trips it while barely denting any single email's budget), so it is
    // the more useful label when both caps happen to be tripped at once.
    const ipLimited = isIpRateLimited(req);
    const emailLimited = isRateLimited(req, email);
    if (ipLimited || emailLimited) {
      await logAuthEvent(null, "auth.login.rate_limited", null, {
        email,
        ip: req.ip,
        // Lets an operator tell "one address under attack" (email) apart
        // from "many addresses tried from one place" (ip) in the audit log.
        scope: ipLimited ? "ip" : "email",
      });
      return res.status(429).json({ error: "too_many_attempts", message: "Too many login attempts. Please try again later." });
    }

    const [rows] = await pool.query(
      "SELECT id, name, email, password_hash, role, status, access_json, crm_manager_id, token_version FROM users WHERE LOWER(email)=? LIMIT 1",
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
      "SELECT id, name, email, role, status, access_json, crm_manager_id FROM users WHERE id=? LIMIT 1",
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
    const [rows] = await pool.query("SELECT id, name, email, role, status, access_json, crm_manager_id, created_at, updated_at FROM users ORDER BY id DESC");
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
    const crmManagerId = parseCrmManagerId(req.body?.crmManagerId);
    if (!crmManagerId.ok) return res.status(400).json({ error: "invalid_crm_manager_id" });
    if (!name || !email || !password) return res.status(400).json({ error: "name_email_password_required" });
    if (String(req.auth?.role || "") !== "Super Admin" && role === "Super Admin") {
      return res.status(403).json({ error: "forbidden_super_admin_assignment" });
    }

    const [exists] = await pool.query("SELECT id FROM users WHERE LOWER(email)=? LIMIT 1", [email]);
    if (exists.length) return res.status(409).json({ error: "email_exists" });

    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
      "INSERT INTO users (name, email, password_hash, role, status, access_json, crm_manager_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      // `?? null`: an absent key means "not a salesperson" on a create, which is
      // the overwhelming majority. Only on an UPDATE does absent mean "leave
      // alone" -- there is a stored value there to leave.
      [name, email, hash, role, status, JSON.stringify(access), crmManagerId.value ?? null]
    );

    const [rows] = await pool.query("SELECT id, name, email, role, status, access_json, crm_manager_id FROM users WHERE id=? LIMIT 1", [result.insertId]);
    await logAuthEvent(Number(req.auth.sub), "auth.user.created", Number(result.insertId), {
      role,
      status,
      accessCount: access.length,
      // The id itself, not the person's name or email: it is the key that
      // decides whose commission this account can read, so a change to it
      // should be reconstructible from the audit log alone.
      crmManagerId: crmManagerId.value ?? null,
    });
    return res.status(201).json({ user: toAuthUser(rows[0]) });
  } catch (error) {
    return res.status(500).json({ error: "create_user_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

async function handleUpdateUser(req, res) {
  try {
    await ensureInitialized();
    if (!canManageUsers(req.auth)) return res.status(403).json({ error: "forbidden" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "invalid_id" });

    const [existingRows] = await pool.query(
      "SELECT id, name, email, role, status, access_json, crm_manager_id FROM users WHERE id=? LIMIT 1",
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
    const parsedCrmManagerId = parseCrmManagerId(req.body?.crmManagerId);
    if (!parsedCrmManagerId.ok) return res.status(400).json({ error: "invalid_crm_manager_id" });
    // Absent key -> keep what is stored. A client that predates the field, or
    // any other partial save, must not be able to revoke a salesperson's view
    // of their own commission by simply not mentioning it.
    const crmManagerId =
      parsedCrmManagerId.value === undefined ? (existing.crm_manager_id ?? null) : parsedCrmManagerId.value;

    if (String(req.auth?.role || "") !== "Super Admin" && role === "Super Admin") {
      return res.status(403).json({ error: "forbidden_super_admin_assignment" });
    }

    const [emailOwner] = await pool.query("SELECT id FROM users WHERE LOWER(email)=? AND id<>? LIMIT 1", [email, id]);
    if (emailOwner.length) return res.status(409).json({ error: "email_exists" });

    if (password) {
      const hash = await bcrypt.hash(password, 12);
      await pool.query(
        "UPDATE users SET name=?, email=?, role=?, status=?, access_json=?, crm_manager_id=?, password_hash=?, token_version=token_version+1 WHERE id=?",
        [name, email, role, status, JSON.stringify(access), crmManagerId, hash, id]
      );
    } else {
      await pool.query("UPDATE users SET name=?, email=?, role=?, status=?, access_json=?, crm_manager_id=? WHERE id=?", [
        name,
        email,
        role,
        status,
        JSON.stringify(access),
        crmManagerId,
        id,
      ]);
    }

    const [rows] = await pool.query("SELECT id, name, email, role, status, access_json, crm_manager_id FROM users WHERE id=? LIMIT 1", [id]);
    await logAuthEvent(Number(req.auth.sub), "auth.user.updated", id, {
      role,
      status,
      accessCount: access.length,
      passwordChanged: Boolean(password),
      // Recorded on every update, not only when it changes: this is the field
      // that decides whose commission the account can read.
      crmManagerId,
    });
    return res.json({ user: toAuthUser(rows[0]) });
  } catch (error) {
    return res.status(500).json({ error: "update_user_failed", message: error instanceof Error ? error.message : String(error) });
  }
}

router.put("/users/:id", authRequired, handleUpdateUser);

// Fallback for environments where upstream blocks PUT (e.g., restrictive IIS/WAF rules)
router.post("/users/:id/update", authRequired, handleUpdateUser);

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

export {
  authRequired,
  canManageUsers,
  hasAccessPermission,
  // Exported for auth/crmManagerId.test.js, which pins that a user who is not a
  // salesperson carries no crmManagerId key at all rather than a null.
  toAuthUser,
  isRateLimited,
  isIpRateLimited,
  noteFailedLogin,
  clearFailedLogin,
  resetLoginRateLimitState,
  LOGIN_WINDOW_MS,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_IP_MAX_ATTEMPTS,
};
export default router;
