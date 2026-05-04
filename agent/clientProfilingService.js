import mysql from "mysql2/promise";

const PORTAL_TRANSACTIONS_URL = process.env.VITE_API_URL || "https://portal.skylinkscapital.com/rest/transactions";
const PORTAL_VERSION = process.env.VITE_API_VERSION || "";
const PORTAL_TOKEN = process.env.VITE_API_TOKEN || "";
const PORTAL_USERS_URL = PORTAL_TRANSACTIONS_URL.replace("/transactions", "/users");
const PORTAL_TRADES_URL = PORTAL_TRANSACTIONS_URL.replace("/transactions", "/trades");
const PORTAL_ACCOUNTS_URL = PORTAL_TRANSACTIONS_URL.replace("/transactions", "/accounts");
const MT5_WEB_API_BASE_URL = String(
  process.env.MT5_WEB_API_BASE_URL ||
  process.env.BACKEND_API_BASE_URL ||
  process.env.VITE_BACKEND_BASE_URL ||
  "https://api.skylinkscapital.com",
).replace(/\/+$/, "");
const MT5_WEB_API_TOKEN = process.env.MT5_WEB_API_TOKEN || "";
const EXTERNAL_FETCH_TIMEOUT_MS = Math.max(5000, Number(process.env.CP_EXTERNAL_FETCH_TIMEOUT_MS || 30000) || 30000);
const MT5_DEAL_MAX_PAGES = Math.max(1, Number(process.env.CP_MT5_DEAL_MAX_PAGES || 80) || 80);
const USERS_FETCH_MAX_PAGES = Math.max(1, Number(process.env.CP_USERS_FETCH_MAX_PAGES || 200) || 200);
const CP_MT5_LOGIN_TIMEOUT_MS = Math.max(5000, Number(process.env.CP_MT5_LOGIN_TIMEOUT_MS || 15000) || 15000);
const CP_TRADE_FETCH_STAGE_TIMEOUT_MS = Math.max(8000, Number(process.env.CP_TRADE_FETCH_STAGE_TIMEOUT_MS || 45000) || 45000);

const PROFILE_DB_HOST = process.env.LP_EQUITY_DB_HOST || process.env.AUTH_DB_HOST || process.env.DB_HOST;
const PROFILE_DB_PORT = Number(process.env.LP_EQUITY_DB_PORT || process.env.AUTH_DB_PORT || process.env.DB_PORT || 3306);
const PROFILE_DB_NAME = process.env.LP_EQUITY_DB_NAME || process.env.AUTH_DB_NAME || process.env.DB_NAME;
const PROFILE_DB_USER = process.env.LP_EQUITY_DB_USER || process.env.AUTH_DB_USER || process.env.DB_USER;
const PROFILE_DB_PASSWORD = process.env.LP_EQUITY_DB_PASSWORD || process.env.AUTH_DB_PASSWORD || process.env.DB_PASSWORD;

let pool = null;
let initPromise = null;
let activeRunPromise = null;
const cancelledRunIds = new Set();
let recommendationTableName = null;
const STALE_RUN_MINUTES = Math.max(5, Number(process.env.CP_STALE_RUN_MINUTES || 20) || 20);
const CP_CLIENT_PIPELINE_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.CP_CLIENT_PIPELINE_TIMEOUT_MS || 180_000) || 180_000,
);

function computeRfm(profile) {
  const recencyDays = toNumber(profile?.recencyDays);
  const frequency = toNumber(profile?.tradeCount);
  const monetary = toNumber(profile?.netPnl);

  const recencyScore = recencyDays <= 7 ? 5 : recencyDays <= 14 ? 4 : recencyDays <= 30 ? 3 : recencyDays <= 60 ? 2 : 1;
  const frequencyScore = frequency >= 300 ? 5 : frequency >= 150 ? 4 : frequency >= 70 ? 3 : frequency >= 20 ? 2 : 1;
  const monetaryScore = monetary >= 25000 ? 5 : monetary >= 10000 ? 4 : monetary >= 1000 ? 3 : monetary >= -5000 ? 2 : 1;
  const total = recencyScore + frequencyScore + monetaryScore;
  const segment = total >= 13 ? "high" : total >= 9 ? "mid" : "low";

  return { recencyScore, frequencyScore, monetaryScore, total, segment };
}

function classifyCluster(profile) {
  // K-Means style behavioral segmentation by feature bands.
  const tradeCount = toNumber(profile?.tradeCount);
  const tradedAmount = toNumber(profile?.totalVolumeLots) * 100000;
  const realizedPnl = toNumber(profile?.netPnl);
  const avgRoi = toNumber(profile?.avgRoiPct);
  const vintageYears = toNumber(profile?.vintageYears);
  const medianHoldingDays = toNumber(profile?.medianHoldingDays);

  if (tradeCount >= 220 && medianHoldingDays <= 0.15 && realizedPnl > 0 && avgRoi > 1.5) return "HighFrequency_HighYield";
  if (tradeCount >= 150 && realizedPnl < 0 && avgRoi < 0) return "HighFrequency_HighRisk_Loss";
  if (tradeCount >= 50 && medianHoldingDays >= 1.0 && avgRoi > 0 && vintageYears >= 1) return "Conservative_SteadyGrowth";
  if (tradeCount < 30 && medianHoldingDays >= 2.0 && realizedPnl <= 0) return "Cautious_LowActivity_Novice";
  if (tradedAmount > 5_000_000 && medianHoldingDays <= 0.25) return "Potential_Toxic_Flow";
  return "Conservative_LowYield";
}

function buildDecision(profile) {
  const tradeCount = toNumber(profile?.tradeCount);
  const winRate = toNumber(profile?.winRate);
  const avgHoldMinutes = toNumber(profile?.avgHoldMinutes);
  const netPnl = toNumber(profile?.netPnl);
  const daysCovered = toNumber(profile?.daysCovered);
  const lastTradeAt = profile?.lastTradeAt ? new Date(profile.lastTradeAt) : null;
  const recencyDays = lastTradeAt && !Number.isNaN(lastTradeAt.getTime())
    ? Math.floor((Date.now() - lastTradeAt.getTime()) / (24 * 60 * 60 * 1000))
    : 9999;

  const flags = [];
  if (recencyDays > 30) flags.push("churn_alert");
  if (tradeCount >= 250 && avgHoldMinutes <= 20 && netPnl > 0) flags.push("toxic_flow_alert");
  if (tradeCount >= 100 && netPnl < -5000) flags.push("b_book_candidate");
  if ((winRate < 0.25 && tradeCount >= 50) || toNumber(profile?.marginRiskScore) >= 70) flags.push("leverage_risk_alert");
  if (daysCovered < 14 && tradeCount >= 80) flags.push("compliance_flag");
  if (toNumber(profile?.bonusAbuseScore) >= 70) flags.push("bonus_abuse_alert");

  let route = "Monitor";
  if (flags.includes("b_book_candidate")) route = "B-Book";
  else if (tradeCount >= 80 && winRate >= 0.5 && netPnl > 0 && avgHoldMinutes >= 120) route = "A-Book";

  return {
    route,
    recencyDays,
    flags,
  };
}

function hasDbConfig() {
  return Boolean(PROFILE_DB_HOST && PROFILE_DB_NAME && PROFILE_DB_USER && PROFILE_DB_PASSWORD);
}

function toIsoDate(input) {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function toDateTime(input) {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Max years of trade history to fetch. Caps huge datasets (e.g. 400k trades from 2015).
// Configurable via env CP_TRADE_WINDOW_YEARS (default: 3).
const CP_TRADE_WINDOW_YEARS = Math.max(1, Number(process.env.CP_TRADE_WINDOW_YEARS || 3) || 3);

function clampStartDate(registrationDate) {
  const regIso = toIsoDate(registrationDate) || "2000-01-01";
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - CP_TRADE_WINDOW_YEARS);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  // Use the later of: registration date OR (today - N years)
  return regIso > cutoffIso ? regIso : cutoffIso;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs),
    ),
  ]);
}

// Format YYYY-MM-DD → DD-MM-YYYY (format used by /Deal/GetDealsByLogin)
function formatDDMMYYYY(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = String(d.getUTCFullYear());
  return `${day}-${month}-${year}`;
}

function buildPortalUrl(url) {
  if (!PORTAL_VERSION) return url;
  const hasQuery = url.includes("?");
  return `${url}${hasQuery ? "&" : "?"}version=${encodeURIComponent(PORTAL_VERSION)}`;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("fetch_timeout")), EXTERNAL_FETCH_TIMEOUT_MS);
  const merged = { ...options, signal: controller.signal };
  let resp;
  try {
    resp = await fetch(url, merged);
  } finally {
    clearTimeout(timeout);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}${text ? `: ${text}` : ""}`);
  }
  return resp.json();
}

async function fetchText(url, options = {}) {
  const resp = await fetch(url, options);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}${text ? `: ${text}` : ""}`);
  }
  return resp.text();
}

async function postPortal(url, body) {
  if (!PORTAL_TOKEN) throw new Error("VITE_API_TOKEN is not configured");
  return fetchJson(buildPortalUrl(url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${PORTAL_TOKEN}`,
    },
    body: JSON.stringify(body || {}),
  });
}

async function ensureDbInitialized() {
  if (pool) return pool;
  if (initPromise) return initPromise;
  if (!hasDbConfig()) throw new Error("client_profile_db_not_configured");

  initPromise = (async () => {
    pool = mysql.createPool({
      host: PROFILE_DB_HOST,
      port: PROFILE_DB_PORT,
      database: PROFILE_DB_NAME,
      user: PROFILE_DB_USER,
      password: PROFILE_DB_PASSWORD,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    // Safety for older schema versions: these columns help explain window coverage.
    await pool.query(`
      ALTER TABLE client_profile_snapshot
      ADD COLUMN IF NOT EXISTS window_mode VARCHAR(20) NOT NULL DEFAULT 'since_start',
      ADD COLUMN IF NOT EXISTS days_covered INT UNSIGNED NOT NULL DEFAULT 0
    `).catch(() => undefined);

    await pool.query(`
      ALTER TABLE client_profile_current
      ADD COLUMN IF NOT EXISTS window_mode VARCHAR(20) NOT NULL DEFAULT 'since_start',
      ADD COLUMN IF NOT EXISTS days_covered INT UNSIGNED NOT NULL DEFAULT 0
    `).catch(() => undefined);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS client_profile_action_audit_log (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        action_key VARCHAR(64) NOT NULL,
        client_id BIGINT UNSIGNED NULL,
        login BIGINT UNSIGNED NULL,
        recommended_book VARCHAR(20) NULL,
        confidence_pct DECIMAL(5,2) NULL,
        actor_user_id VARCHAR(128) NOT NULL,
        actor_email VARCHAR(255) NULL,
        actor_role VARCHAR(64) NULL,
        confirmation_note VARCHAR(255) NULL,
        action_payload_json JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_action_created (action_key, created_at),
        KEY idx_client_created (client_id, created_at),
        KEY idx_login_created (login, created_at)
      )
    `).catch(() => undefined);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS client_profile_run_step_log (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        run_id BIGINT UNSIGNED NOT NULL,
        step_key VARCHAR(64) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'info',
        client_id BIGINT UNSIGNED NULL,
        login BIGINT UNSIGNED NULL,
        page_offset INT NULL,
        page_size INT NULL,
        processed INT NULL,
        failed INT NULL,
        details_json JSON NULL,
        message VARCHAR(1000) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_run_created (run_id, created_at),
        KEY idx_run_step (run_id, step_key)
      )
    `).catch(() => undefined);

    // On server startup: close any runs still marked "running" from a previous server process.
    // Since activeRunPromise is null at startup, those runs can't be genuinely running.
    // However, only close if no step activity in the last 3 minutes to avoid killing a run
    // that was active very recently (e.g. server hot-reloaded during active processing).
    await pool.query(`
      UPDATE client_profile_run_log
      SET status = 'failed',
          error_message = 'Auto-closed: server restarted while run was in progress',
          finished_at = NOW()
      WHERE status = 'running'
        AND NOT EXISTS (
          SELECT 1
          FROM client_profile_run_step_log s
          WHERE s.run_id = client_profile_run_log.id
            AND s.created_at >= DATE_SUB(NOW(), INTERVAL 3 MINUTE)
        )
    `).catch(() => undefined);

    return pool;
  })();

  return initPromise;
}

async function closeStaleRunningRuns(conn) {
  // Close runs that have been "running" beyond the stale threshold and have no recent step activity.
  await conn.query(
    `
      UPDATE client_profile_run_log
      SET status = 'failed',
          error_message = COALESCE(NULLIF(error_message, ''), CONCAT('Auto-closed stale run after ', ?, ' minutes without completion')),
          finished_at = NOW()
      WHERE status = 'running'
        AND started_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
        AND NOT EXISTS (
          SELECT 1
          FROM client_profile_run_step_log s
          WHERE s.run_id = client_profile_run_log.id
            AND s.created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
        )
    `,
    [STALE_RUN_MINUTES, STALE_RUN_MINUTES, STALE_RUN_MINUTES],
  ).catch(() => undefined);
}

async function resolveRecommendationTable(conn) {
  if (recommendationTableName) return recommendationTableName;
  const canonical = "client_profile_recommendation_history";
  const [rows] = await conn.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name = ?
      LIMIT 1
    `,
    [canonical],
  ).catch(() => [[]]);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Required table is missing: ${canonical}`);
  }
  recommendationTableName = canonical;
  return recommendationTableName;
}

async function fetchAllUsers() {
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  let pages = 0;
  const signatures = new Set();

  for (;;) {
    pages += 1;
    if (pages > USERS_FETCH_MAX_PAGES) break;
    const payload = { segment: { limit: PAGE, offset } };
    const page = await postPortal(PORTAL_USERS_URL, payload).catch(() => []);
    const rows = Array.isArray(page) ? page : [];
    const sig = rows.length ? `${rows[0]?.id || "x"}:${rows[rows.length - 1]?.id || "y"}:${rows.length}` : `empty:${offset}`;
    if (signatures.has(sig)) break;
    signatures.add(sig);
    all.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  return all;
}

async function fetchUsersBatch(offset, limit) {
  const payload = {
    segment: {
      limit: Math.max(1, Number(limit) || 200),
      offset: Math.max(0, Number(offset) || 0),
    },
  };
  const rows = await postPortal(PORTAL_USERS_URL, payload).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

async function fetchAccountsByUserId(userId) {
  const rows = await postPortal(PORTAL_ACCOUNTS_URL, { userId, segment: { limit: 1000, offset: 0 } }).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

async function fetchTradesForUserSince(userId, fromDate, toDate) {
  const begin = `${fromDate} 00:00:00`;
  const end = `${toDate} 23:59:59`;
  const basePayload = {
    openDate: { begin, end },
    closeDate: { begin, end },
  };

  // Some deployments support segment on /rest/trades, some don't.
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  let paginationSupported = true;

  for (;;) {
    const payload = paginationSupported
      ? { ...basePayload, fromUserId: userId, segment: { limit: PAGE, offset } }
      : { ...basePayload, fromUserId: userId };

    const page = await postPortal(PORTAL_TRADES_URL, payload).catch((error) => {
      if (paginationSupported) return { __segment_error: error };
      throw error;
    });

    if (page && page.__segment_error) {
      paginationSupported = false;
      offset = 0;
      all.length = 0;
      continue;
    }

    const rows = Array.isArray(page) ? page : [];
    all.push(...rows);

    if (!paginationSupported) break;
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  return all;
}

function normalizeMt5Deal(deal) {
  const ts = Number(deal?.Time || deal?.time || 0);
  const isoTime = ts > 0 ? new Date(ts * 1000).toISOString() : null;
  const volumeExt = Number(deal?.VolumeExt ?? deal?.volumeExt ?? 0);
  const volumeRaw = Number(deal?.Volume ?? deal?.volume ?? 0);
  const lots = volumeExt > 0 ? volumeExt / 100000000 : volumeRaw > 0 ? volumeRaw / 10000 : 0;
  return {
    source: "mt5",
    login: Number(deal?.Login ?? deal?.login ?? 0) || null,
    symbol: String(deal?.Symbol ?? deal?.symbol ?? "UNKNOWN"),
    openDate: isoTime,
    closeDate: isoTime,
    volume: lots,
    lots,
    pl: toNumber(deal?.Profit ?? deal?.profit),
    swap: toNumber(deal?.Storage ?? deal?.swap),
    commission: toNumber(deal?.Commission ?? deal?.commission),
    ticketType: String(deal?.Action ?? deal?.action ?? ""),
    entry: String(deal?.Entry ?? deal?.entry ?? ""),
    raw: deal,
  };
}

// Normalize /Deal/GetDealsByLogin DealModel response (same format as dealing page)
function normalizeDealModelTrade(deal, loginHint = null) {
  const lots = toNumber(deal?.lots ?? deal?.Lots ?? 0);
  // DealModel stores time as Unix seconds
  const timeRaw = deal?.time ?? deal?.Time ?? deal?.openTime ?? deal?.OpenTime ?? null;
  const ts = Number(timeRaw || 0);
  const isoTime = ts > 0 ? new Date(ts * 1000).toISOString() : null;
  return {
    source: "deal_api",
    login: Number(deal?.login ?? deal?.Login ?? loginHint ?? 0) || null,
    symbol: String(deal?.symbol ?? deal?.Symbol ?? "UNKNOWN"),
    openDate: isoTime,
    closeDate: isoTime,
    volume: lots,
    lots,
    pl: toNumber(deal?.profit ?? deal?.Profit ?? deal?.value ?? deal?.Value ?? 0),
    swap: toNumber(deal?.storage ?? deal?.Storage ?? deal?.swap ?? deal?.Swap ?? 0),
    commission: toNumber(deal?.commission ?? deal?.Commission ?? 0),
    ticketType: String(deal?.action ?? deal?.Action ?? ""),
    entry: String(deal?.entry ?? deal?.Entry ?? ""),
    raw: deal,
  };
}

function normalizeHistoryDeal(deal, loginHint = null) {
  const openTs = Number(deal?.openTime ?? deal?.OpenTime ?? deal?.time ?? deal?.Time ?? 0);
  const closeTs = Number(deal?.closeTime ?? deal?.CloseTime ?? deal?.time ?? deal?.Time ?? 0);
  const openIso = openTs > 0 ? new Date(openTs * 1000).toISOString() : null;
  const closeIso = closeTs > 0 ? new Date(closeTs * 1000).toISOString() : openIso;
  const volumeExt = Number(deal?.volumeExt ?? deal?.VolumeExt ?? 0);
  const volumeRaw = Number(deal?.volume ?? deal?.Volume ?? 0);
  const lots = volumeExt > 0 ? volumeExt / 100000000 : volumeRaw > 0 ? volumeRaw / 10000 : 0;
  return {
    source: "history",
    login: Number(deal?.login ?? deal?.Login ?? loginHint ?? 0) || null,
    symbol: String(deal?.symbol ?? deal?.Symbol ?? "UNKNOWN"),
    openDate: openIso,
    closeDate: closeIso,
    volume: lots,
    lots,
    pl: toNumber(deal?.profit ?? deal?.Profit ?? deal?.pl),
    swap: toNumber(deal?.swap ?? deal?.Storage),
    commission: toNumber(deal?.commission ?? deal?.Commission),
    ticketType: String(deal?.action ?? deal?.Action ?? ""),
    entry: String(deal?.entry ?? deal?.Entry ?? ""),
    raw: deal,
  };
}

async function fetchHistoryDealsByLogins(logins, fromDate, toDate) {
  const uniqueLogins = [...new Set((Array.isArray(logins) ? logins : []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
  if (!uniqueLogins.length) return [];
  const fromTs = Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000);
  const toTs = Math.floor(new Date(`${toDate}T23:59:59Z`).getTime() / 1000);
  const settled = await Promise.allSettled(
    uniqueLogins.map((login) =>
      withTimeout(
        fetchBackendJson(`/History/deals?login=${encodeURIComponent(String(login))}&from=${encodeURIComponent(String(fromTs))}&to=${encodeURIComponent(String(toTs))}`),
        CP_TRADE_FETCH_STAGE_TIMEOUT_MS,
        `History deals login ${login}`,
      ),
    ),
  );
  const all = [];
  for (let i = 0; i < settled.length; i += 1) {
    const row = settled[i];
    if (row.status !== "fulfilled") continue;
    const payload = row.value;
    const deals = Array.isArray(payload?.deals) ? payload.deals : Array.isArray(payload?.rows) ? payload.rows : Array.isArray(payload) ? payload : [];
    all.push(...deals.map((d) => normalizeHistoryDeal(d, uniqueLogins[i])));
  }
  return all;
}

// ── Primary trade source: GET /Deal/GetDealsByLogin (same endpoint as dealing page) ────────────
async function fetchDealsByLoginFromDealEndpoint(login, fromDate, toDate) {
  const numericLogin = Number(login);
  if (!Number.isFinite(numericLogin) || numericLogin <= 0) return [];
  const fromStr = formatDDMMYYYY(fromDate);
  const toStr = formatDDMMYYYY(toDate);
  if (!fromStr || !toStr) return [];

  const url = new URL(`${MT5_WEB_API_BASE_URL}/Deal/GetDealsByLogin`);
  url.searchParams.set("login", String(numericLogin));
  url.searchParams.set("from", fromStr);
  url.searchParams.set("to", toStr);

  const response = await fetchJson(url.toString(), {
    method: "GET",
    headers: { accept: "text/plain", Accept: "application/json" },
  }).catch((err) => { throw new Error(`Deal/GetDealsByLogin login=${numericLogin}: ${err?.message || err}`); });

  const deals = Array.isArray(response) ? response : [];
  return deals.map((d) => normalizeDealModelTrade(d, numericLogin));
}

// ── Batch trade source: POST /Deal/GetDealsByLogins (multiple logins at once) ───────────────────
async function fetchDealsByLoginsFromBatchEndpoint(logins, fromDate, toDate) {
  if (!logins.length) return [];
  const fromStr = formatDDMMYYYY(fromDate);
  const toStr = formatDDMMYYYY(toDate);
  if (!fromStr || !toStr) return [];

  const url = new URL(`${MT5_WEB_API_BASE_URL}/Deal/GetDealsByLogins`);
  url.searchParams.set("from", fromStr);
  url.searchParams.set("to", toStr);

  const response = await fetchJson(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(logins),
  }).catch((err) => { throw new Error(`Deal/GetDealsByLogins batch: ${err?.message || err}`); });

  const deals = Array.isArray(response) ? response : [];
  return deals.map((d) => normalizeDealModelTrade(d, null));
}

async function fetchBackendJson(path) {
  const url = `${MT5_WEB_API_BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
  return fetchJson(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });
}

function toBackendIsoTimestamp(dateLike, endOfDay = false) {
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  if (endOfDay) d.setUTCHours(23, 59, 59, 999);
  else d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function computeDealEvidenceStats(rawDeals) {
  const deals = Array.isArray(rawDeals) ? rawDeals : [];
  let winners = 0;
  let losers = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let holdMinutesTotal = 0;
  let holdSamples = 0;
  for (const row of deals) {
    const pnl = toNumber(row?.profit ?? row?.Profit ?? row?.pl ?? row?.PL);
    if (pnl > 0) {
      winners += 1;
      grossProfit += pnl;
    } else if (pnl < 0) {
      losers += 1;
      grossLoss += Math.abs(pnl);
    }
    const openTs = toNumber(row?.openTime ?? row?.OpenTime ?? row?.Time ?? row?.time);
    const closeTs = toNumber(row?.closeTime ?? row?.CloseTime ?? row?.Time ?? row?.time);
    if (openTs > 0 && closeTs > 0 && closeTs >= openTs) {
      holdMinutesTotal += (closeTs - openTs) / 60;
      holdSamples += 1;
    }
  }
  const total = winners + losers;
  return {
    dealsCount: deals.length,
    winners,
    losers,
    winRatePct: total > 0 ? (winners / total) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 9.99 : 0),
    avgHoldMinutes: holdSamples > 0 ? holdMinutesTotal / holdSamples : 0,
  };
}

async function fetchDealingEvidence({ login, fromDate, toDate }) {
  const fromTs = toBackendIsoTimestamp(`${fromDate}T00:00:00Z`, false);
  const toTs = toBackendIsoTimestamp(`${toDate}T23:59:59Z`, true);
  if (!fromTs || !toTs) return null;

  const historyDealsPath = `/History/deals?login=${encodeURIComponent(String(login))}&from=${encodeURIComponent(String(fromTs))}&to=${encodeURIComponent(String(toTs))}`;
  const historyAggregatePath = `/History/aggregate?from=${encodeURIComponent(String(fromTs))}&to=${encodeURIComponent(String(toTs))}`;
  const metricsPath = "/Metrics/dashboard";

  const [dealsRes, aggregateRes, metricsRes] = await Promise.allSettled([
    fetchBackendJson(historyDealsPath),
    fetchBackendJson(historyAggregatePath),
    fetchBackendJson(metricsPath),
  ]);

  const dealsPayload = dealsRes.status === "fulfilled" ? dealsRes.value : null;
  const aggregatePayload = aggregateRes.status === "fulfilled" ? aggregateRes.value : null;
  const metricsPayload = metricsRes.status === "fulfilled" ? metricsRes.value : null;

  const dealsRows = Array.isArray(dealsPayload?.deals)
    ? dealsPayload.deals
    : Array.isArray(dealsPayload)
      ? dealsPayload
      : [];
  const aggregateItems = Array.isArray(aggregatePayload?.items)
    ? aggregatePayload.items
    : Array.isArray(aggregatePayload)
      ? aggregatePayload
      : [];
  const metricsItems = Array.isArray(metricsPayload?.items)
    ? metricsPayload.items
    : Array.isArray(metricsPayload)
      ? metricsPayload
      : [];

  const loginNum = Number(login);
  const aggRow = aggregateItems.find((x) => Number(x?.login) === loginNum) || null;
  const metricRow = metricsItems.find((x) => Number(x?.login) === loginNum) || null;
  const dealStats = computeDealEvidenceStats(dealsRows);

  return {
    source: "dealing_endpoints",
    paths: {
      historyDeals: historyDealsPath,
      historyAggregate: historyAggregatePath,
      metrics: metricsPath,
    },
    status: {
      historyDeals: dealsRes.status === "fulfilled" ? "ok" : "error",
      historyAggregate: aggregateRes.status === "fulfilled" ? "ok" : "error",
      metrics: metricsRes.status === "fulfilled" ? "ok" : "error",
    },
    dealStats,
    aggregate: aggRow
      ? {
          tradeCount: toNumber(aggRow?.tradeCount),
          totalLots: toNumber(aggRow?.totalLots),
          netPL: toNumber(aggRow?.netPL),
          grossProfit: toNumber(aggRow?.grossProfit),
          totalCommission: toNumber(aggRow?.totalCommission),
          totalSwap: toNumber(aggRow?.totalSwap),
          ntpPercent: toNumber(aggRow?.ntpPercent),
        }
      : null,
    accountHealth: metricRow
      ? {
          equity: toNumber(metricRow?.equity),
          realEquity: toNumber(metricRow?.realEquity ?? metricRow?.real_equity),
          balance: toNumber(metricRow?.balance),
          margin: toNumber(metricRow?.margin),
          freeMargin: toNumber(metricRow?.freeMargin ?? metricRow?.free_margin),
          marginLevel: toNumber(metricRow?.marginLevel ?? metricRow?.margin_level),
        }
      : null,
  };
}

/**
 * Fetch trades for a client with a 4-step fallback chain:
 *  1. POST /Deal/GetDealsByLogins  (batch, same base URL as dealing page - fastest)
 *  2. GET  /Deal/GetDealsByLogin   per-login if batch fails or returns empty
 *  3. GET  /History/deals          UNIX timestamp based fallback
 *  4. POST Portal /rest/trades     last resort
 *
 * All steps are logged with details so stuck/failing steps are visible.
 */
async function fetchTradesForClientWithMt5Fallback({ userId, logins, fromDate, toDate }) {
  const uniqueLogins = [...new Set(
    (Array.isArray(logins) ? logins : []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0),
  )];

  const stepLog = [];
  const note = (step, result, extra = {}) => stepLog.push({ step, result, ...extra });

  // NOTE: POST /Deal/GetDealsByLogins returns HTTP 405 on this API — skipped.
  note("Deal/GetDealsByLogins", "skipped", { reason: "endpoint_returns_405" });

  // ── STEP 1: Per-login GET /Deal/GetDealsByLogin ───────────────────────────
  if (uniqueLogins.length > 0) {
    const perLoginResults = await Promise.allSettled(
      uniqueLogins.map((login) =>
        withTimeout(
          fetchDealsByLoginFromDealEndpoint(login, fromDate, toDate),
          CP_MT5_LOGIN_TIMEOUT_MS,
          `Deal/GetDealsByLogin login ${login}`,
        ),
      ),
    );
    const perLoginDeals = perLoginResults
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value || []);
    const perLoginErrors = perLoginResults
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason?.message || String(r.reason));
    note("Deal/GetDealsByLogin", perLoginDeals.length > 0 ? "ok" : "empty", {
      attempted: uniqueLogins.length,
      fulfilled: perLoginResults.filter((r) => r.status === "fulfilled").length,
      failed: perLoginResults.filter((r) => r.status === "rejected").length,
      dealsFetched: perLoginDeals.length,
      errors: perLoginErrors.slice(0, 3),
    });
    if (perLoginDeals.length > 0) {
      return {
        source: "deal_api_per_login",
        trades: perLoginDeals,
        diagnostics: { steps: stepLog, endpoint: "/Deal/GetDealsByLogin", dealsFetched: perLoginDeals.length, fallbackUsed: false },
      };
    }
  } else {
    note("Deal/GetDealsByLogin", "skipped", { reason: "no_logins" });
  }

  // ── STEP 3: GET /History/deals (UNIX timestamp) ───────────────────────────
  try {
    const historyTrades = await withTimeout(
      fetchHistoryDealsByLogins(uniqueLogins, fromDate, toDate),
      CP_TRADE_FETCH_STAGE_TIMEOUT_MS * 2,
      "History/deals fallback",
    );
    note("History/deals", Array.isArray(historyTrades) && historyTrades.length > 0 ? "ok" : "empty", {
      dealsFetched: Array.isArray(historyTrades) ? historyTrades.length : 0,
    });
    if (Array.isArray(historyTrades) && historyTrades.length > 0) {
      return {
        source: "history",
        trades: historyTrades,
        diagnostics: { steps: stepLog, endpoint: "/History/deals", dealsFetched: historyTrades.length, fallbackUsed: true, fallbackReason: "deal_api_empty" },
      };
    }
  } catch (histErr) {
    note("History/deals", "error", { error: histErr?.message || String(histErr) });
  }

  // ── STEP 4: Portal REST /rest/trades (last resort) ────────────────────────
  try {
    const restTrades = await withTimeout(
      fetchTradesForUserSince(userId, fromDate, toDate),
      CP_TRADE_FETCH_STAGE_TIMEOUT_MS,
      "Portal REST trades",
    );
    const restCount = Array.isArray(restTrades) ? restTrades.length : 0;
    note("Portal/rest/trades", restCount > 0 ? "ok" : "empty", { dealsFetched: restCount });
    return {
      source: "rest",
      trades: restTrades,
      diagnostics: { steps: stepLog, endpoint: "/rest/trades", dealsFetched: restCount, fallbackUsed: true, fallbackReason: "all_mt5_and_history_failed" },
    };
  } catch (restErr) {
    note("Portal/rest/trades", "error", { error: restErr?.message || String(restErr) });
    return {
      source: "rest",
      trades: [],
      diagnostics: { steps: stepLog, dealsFetched: 0, fallbackUsed: true, fallbackReason: "all_sources_failed", fatalError: restErr?.message || String(restErr) },
    };
  }
}

async function verifyClientPersistence(conn, clientId) {
  const verify = async (table, where = "client_id = ?") => {
    const [rows] = await conn.query(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`, [clientId]).catch(() => [[{ c: 0 }]]);
    return Number(rows?.[0]?.c || 0);
  };
  const currentCount = await verify("client_profile_current");
  const snapshotCount = await verify("client_profile_snapshot");
  const scoresCount = await verify("client_profile_scores");
  const alertsCount = await verify("client_profile_alert_event");
  const tradeFactsCount = await verify("client_trade_fact_daily");
  const recCount = await verify("client_profile_recommendation_history");
  return {
    clientProfileCurrentRows: currentCount,
    clientProfileSnapshotRows: snapshotCount,
    clientProfileScoresRows: scoresCount,
    clientProfileAlertEventRows: alertsCount,
    clientTradeFactDailyRows: tradeFactsCount,
    clientProfileRecommendationHistoryRows: recCount,
  };
}

function calculateProfileMetrics(client, trades, snapshotDate) {
  const registrationDate = toIsoDate(client?.registrationDate) || snapshotDate;
  const tradeRows = Array.isArray(trades) ? trades : [];

  let firstTrade = null;
  let lastTrade = null;
  let winTrades = 0;
  let closedTrades = 0;
  let holdMinutesSum = 0;
  let holdMinutesCount = 0;
  const holdDays = [];

  let totalVolumeLots = 0;
  let netPnl = 0;
  let totalSwap = 0;
  let totalCommission = 0;

  for (const trade of tradeRows) {
    const open = new Date(trade?.openDate || trade?.openTime || trade?.time || "");
    const close = new Date(trade?.closeDate || trade?.closeTime || "");
    const openValid = !Number.isNaN(open.getTime());
    const closeValid = !Number.isNaN(close.getTime());

    if (openValid) {
      if (!firstTrade || open.getTime() < firstTrade.getTime()) firstTrade = open;
      if (!lastTrade || open.getTime() > lastTrade.getTime()) lastTrade = open;
    }
    if (closeValid) {
      if (!lastTrade || close.getTime() > lastTrade.getTime()) lastTrade = close;
    }

    const pl = toNumber(trade?.pl ?? trade?.profit ?? trade?.netPnl);
    const swap = toNumber(trade?.swap);
    const commission = Math.abs(toNumber(trade?.commission));
    const volumeLots = toNumber(trade?.volume ?? trade?.lots);

    netPnl += pl;
    totalSwap += swap;
    totalCommission += commission;
    totalVolumeLots += volumeLots;

    if (pl > 0) winTrades += 1;

    if (openValid && closeValid) {
      const minutes = (close.getTime() - open.getTime()) / 60000;
      if (Number.isFinite(minutes) && minutes >= 0) {
        closedTrades += 1;
        holdMinutesSum += minutes;
        holdMinutesCount += 1;
        holdDays.push(minutes / (60 * 24));
      }
    }
  }

  const firstTradeDate = firstTrade ? toIsoDate(firstTrade.toISOString()) : null;
  const effectiveFrom = firstTradeDate || registrationDate || snapshotDate;
  const fromTs = Date.parse(`${effectiveFrom}T00:00:00Z`);
  const toTs = Date.parse(`${snapshotDate}T23:59:59Z`);
  const daysCovered = Number.isFinite(fromTs) && Number.isFinite(toTs) && toTs >= fromTs
    ? Math.floor((toTs - fromTs) / (24 * 60 * 60 * 1000)) + 1
    : 0;
  const avgHoldMinutes = holdMinutesCount > 0 ? holdMinutesSum / holdMinutesCount : 0;
  const recencyDays = lastTrade ? Math.floor((Date.now() - lastTrade.getTime()) / (24 * 60 * 60 * 1000)) : 9999;
  const medianHoldingDays = holdDays.length
    ? [...holdDays].sort((a, b) => a - b)[Math.floor(holdDays.length / 2)]
    : 0;
  const accountVintageYears = Math.max(0, daysCovered / 365);
  const avgRoiPct = totalCommission > 0 ? (netPnl / totalCommission) * 100 : 0;
  const marginRiskScore = Math.max(0, Math.min(100, Math.round((winTrades / Math.max(1, tradeRows.length) < 0.25 ? 60 : 20) + (tradeRows.length > 200 ? 20 : 0) + (avgHoldMinutes <= 20 ? 20 : 0))));
  const bonusAbuseScore = Math.max(0, Math.min(100, Math.round((tradeRows.length > 180 ? 30 : 0) + (avgHoldMinutes <= 15 ? 30 : 0) + (netPnl > 0 && totalCommission < Math.abs(netPnl) * 0.02 ? 40 : 0))));

  return {
    clientId: Number(client?.id) || 0,
    snapshotDate,
    windowFrom: effectiveFrom,
    windowTo: snapshotDate,
    windowMode: firstTradeDate ? "since_first_trade" : "since_registration",
    daysCovered,
    tradeCount: tradeRows.length,
    winRate: tradeRows.length > 0 ? winTrades / tradeRows.length : 0,
    avgHoldMinutes,
    totalVolumeLots,
    netPnl,
    totalSwap,
    totalCommission,
    firstTradeAt: firstTrade ? toDateTime(firstTrade.toISOString()) : null,
    lastTradeAt: lastTrade ? toDateTime(lastTrade.toISOString()) : null,
    recencyDays,
    medianHoldingDays,
    vintageYears: accountVintageYears,
    avgRoiPct,
    marginRiskScore,
    bonusAbuseScore,
  };
}

async function insertRunLog(conn, runType, snapshotDate) {
  const [result] = await conn.query(
    `
      INSERT INTO client_profile_run_log
        (run_type, window_from, window_to, started_at, status, clients_processed, clients_failed)
      VALUES (?, ?, ?, NOW(), 'running', 0, 0)
    `,
    [runType, snapshotDate, snapshotDate],
  );
  return Number(result.insertId);
}

async function updateRunLog(conn, runId, status, processed, failed, errorMessage = null) {
  await conn.query(
    `
      UPDATE client_profile_run_log
      SET status = ?, clients_processed = ?, clients_failed = ?, error_message = ?, finished_at = NOW()
      WHERE id = ?
    `,
    [status, processed, failed, errorMessage, runId],
  );
}

async function updateRunProgress(conn, runId, processed, failed) {
  await conn.query(
    `
      UPDATE client_profile_run_log
      SET clients_processed = ?, clients_failed = ?
      WHERE id = ?
    `,
    [processed, failed, runId],
  );
}

async function insertRunStepLog(conn, payload = {}) {
  const details = payload.details && typeof payload.details === "object" ? payload.details : null;
  await conn.query(
    `
      INSERT INTO client_profile_run_step_log
      (
        run_id, step_key, status, client_id, login, page_offset, page_size,
        processed, failed, details_json, message
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      Number(payload.runId) || 0,
      String(payload.stepKey || "unknown").slice(0, 64),
      String(payload.status || "info").slice(0, 20),
      Number(payload.clientId) || null,
      Number(payload.login) || null,
      Number.isFinite(Number(payload.pageOffset)) ? Number(payload.pageOffset) : null,
      Number.isFinite(Number(payload.pageSize)) ? Number(payload.pageSize) : null,
      Number.isFinite(Number(payload.processed)) ? Number(payload.processed) : null,
      Number.isFinite(Number(payload.failed)) ? Number(payload.failed) : null,
      details ? JSON.stringify(details) : null,
      payload.message ? String(payload.message).slice(0, 1000) : null,
    ],
  ).catch(() => undefined);
}

async function safeUpdateRunProgress(conn, runId, processed, failed) {
  try {
    await updateRunProgress(conn, runId, processed, failed);
  } catch (error) {
    // One retry for transient DB lock/write hiccups.
    try {
      await updateRunProgress(conn, runId, processed, failed);
      return;
    } catch (retryError) {
      await insertRunStepLog(conn, {
        runId,
        stepKey: "progress_update_failed",
        status: "error",
        processed,
        failed,
        message: retryError?.message || error?.message || String(retryError || error),
      });
    }
  }
}

async function upsertClientProfile(conn, profile) {
  await conn.query(
    `
      INSERT INTO client_profile_snapshot
      (
        client_id, snapshot_date, window_from, window_to,
        trade_count, win_rate, avg_hold_minutes, total_volume_lots,
        net_pnl, total_swap, total_commission, first_trade_at, last_trade_at, window_mode, days_covered
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        window_from = VALUES(window_from),
        window_to = VALUES(window_to),
        trade_count = VALUES(trade_count),
        win_rate = VALUES(win_rate),
        avg_hold_minutes = VALUES(avg_hold_minutes),
        total_volume_lots = VALUES(total_volume_lots),
        net_pnl = VALUES(net_pnl),
        total_swap = VALUES(total_swap),
        total_commission = VALUES(total_commission),
        first_trade_at = VALUES(first_trade_at),
        last_trade_at = VALUES(last_trade_at),
        window_mode = VALUES(window_mode),
        days_covered = VALUES(days_covered),
        updated_at = CURRENT_TIMESTAMP
    `,
    [
      profile.clientId,
      profile.snapshotDate,
      profile.windowFrom,
      profile.windowTo,
      profile.tradeCount,
      profile.winRate,
      profile.avgHoldMinutes,
      profile.totalVolumeLots,
      profile.netPnl,
      profile.totalSwap,
      profile.totalCommission,
      profile.firstTradeAt,
      profile.lastTradeAt,
      profile.windowMode,
      profile.daysCovered,
    ],
  );

  await conn.query(
    `
      INSERT INTO client_profile_current
      (
        client_id, last_snapshot_date, window_from, window_to,
        trade_count, win_rate, avg_hold_minutes, total_volume_lots,
        net_pnl, total_swap, total_commission, first_trade_at, last_trade_at, window_mode, days_covered
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        last_snapshot_date = VALUES(last_snapshot_date),
        window_from = VALUES(window_from),
        window_to = VALUES(window_to),
        trade_count = VALUES(trade_count),
        win_rate = VALUES(win_rate),
        avg_hold_minutes = VALUES(avg_hold_minutes),
        total_volume_lots = VALUES(total_volume_lots),
        net_pnl = VALUES(net_pnl),
        total_swap = VALUES(total_swap),
        total_commission = VALUES(total_commission),
        first_trade_at = VALUES(first_trade_at),
        last_trade_at = VALUES(last_trade_at),
        window_mode = VALUES(window_mode),
        days_covered = VALUES(days_covered),
        updated_at = CURRENT_TIMESTAMP
    `,
    [
      profile.clientId,
      profile.snapshotDate,
      profile.windowFrom,
      profile.windowTo,
      profile.tradeCount,
      profile.winRate,
      profile.avgHoldMinutes,
      profile.totalVolumeLots,
      profile.netPnl,
      profile.totalSwap,
      profile.totalCommission,
      profile.firstTradeAt,
      profile.lastTradeAt,
      profile.windowMode,
      profile.daysCovered,
    ],
  );
}

async function upsertClientTradeFactDaily(conn, profile, trades) {
  const byDate = new Map();
  for (const trade of Array.isArray(trades) ? trades : []) {
    const closeDate = toIsoDate(trade?.closeDate || trade?.openDate || null);
    if (!closeDate) continue;
    const row = byDate.get(closeDate) || {
      factDate: closeDate,
      tradeCount: 0,
      winTradeCount: 0,
      lossTradeCount: 0,
      totalVolumeLots: 0,
      netPnl: 0,
      grossProfit: 0,
      grossLoss: 0,
      totalSwap: 0,
      totalCommission: 0,
      holdMinutesSum: 0,
      holdCount: 0,
      holdMinutesMin: Number.POSITIVE_INFINITY,
      holdMinutesMax: 0,
      buyTradeCount: 0,
      sellTradeCount: 0,
      symbols: new Set(),
    };
    const pnl = toNumber(trade?.pl ?? trade?.profit);
    const volume = toNumber(trade?.volume ?? trade?.lots);
    const swap = toNumber(trade?.swap);
    const commission = Math.abs(toNumber(trade?.commission));
    const side = String(trade?.ticketType || trade?.side || "").toUpperCase();
    row.tradeCount += 1;
    if (pnl > 0) row.winTradeCount += 1;
    if (pnl < 0) row.lossTradeCount += 1;
    row.totalVolumeLots += volume;
    row.netPnl += pnl;
    if (pnl > 0) row.grossProfit += pnl;
    if (pnl < 0) row.grossLoss += Math.abs(pnl);
    row.totalSwap += swap;
    row.totalCommission += commission;
    if (side.includes("BUY")) row.buyTradeCount += 1;
    if (side.includes("SELL")) row.sellTradeCount += 1;
    row.symbols.add(String(trade?.symbol || "UNKNOWN").toUpperCase());
    const open = new Date(trade?.openDate || "");
    const close = new Date(trade?.closeDate || "");
    if (!Number.isNaN(open.getTime()) && !Number.isNaN(close.getTime()) && close >= open) {
      const hold = (close.getTime() - open.getTime()) / 60000;
      row.holdMinutesSum += hold;
      row.holdCount += 1;
      row.holdMinutesMin = Math.min(row.holdMinutesMin, hold);
      row.holdMinutesMax = Math.max(row.holdMinutesMax, hold);
    }
    byDate.set(closeDate, row);
  }

  for (const row of byDate.values()) {
    const avgHold = row.holdCount > 0 ? row.holdMinutesSum / row.holdCount : 0;
    const minHold = Number.isFinite(row.holdMinutesMin) ? row.holdMinutesMin : 0;
    await conn.query(
      `
        INSERT INTO client_trade_fact_daily
        (
          fact_date, client_id, login, trade_count, win_trade_count, loss_trade_count,
          total_volume_lots, total_notional_usd, net_pnl, gross_profit, gross_loss,
          total_swap, total_commission, avg_hold_minutes, median_hold_minutes,
          min_hold_minutes, max_hold_minutes, buy_trade_count, sell_trade_count,
          symbol_count, top_symbol, source
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          trade_count = VALUES(trade_count),
          win_trade_count = VALUES(win_trade_count),
          loss_trade_count = VALUES(loss_trade_count),
          total_volume_lots = VALUES(total_volume_lots),
          total_notional_usd = VALUES(total_notional_usd),
          net_pnl = VALUES(net_pnl),
          gross_profit = VALUES(gross_profit),
          gross_loss = VALUES(gross_loss),
          total_swap = VALUES(total_swap),
          total_commission = VALUES(total_commission),
          avg_hold_minutes = VALUES(avg_hold_minutes),
          median_hold_minutes = VALUES(median_hold_minutes),
          min_hold_minutes = VALUES(min_hold_minutes),
          max_hold_minutes = VALUES(max_hold_minutes),
          buy_trade_count = VALUES(buy_trade_count),
          sell_trade_count = VALUES(sell_trade_count),
          symbol_count = VALUES(symbol_count),
          top_symbol = VALUES(top_symbol),
          source = VALUES(source),
          updated_at = CURRENT_TIMESTAMP
      `,
      [
        row.factDate,
        profile.clientId,
        null,
        row.tradeCount,
        row.winTradeCount,
        row.lossTradeCount,
        row.totalVolumeLots,
        row.totalVolumeLots * 100000,
        row.netPnl,
        row.grossProfit,
        row.grossLoss,
        row.totalSwap,
        row.totalCommission,
        avgHold,
        avgHold,
        minHold,
        row.holdMinutesMax || 0,
        row.buyTradeCount,
        row.sellTradeCount,
        row.symbols.size,
        row.symbols.values().next().value || null,
        "cp",
      ],
    ).catch(() => undefined);
  }
}

async function upsertClientProfileScores(conn, profile, cluster, decision) {
  const rfm = computeRfm(profile);
  await conn.query(
    `
      INSERT INTO client_profile_scores
      (
        client_id, login, snapshot_date, rfm_recency_score, rfm_frequency_score, rfm_monetary_score,
        rfm_total_score, rfm_segment, cluster_label, cluster_distance,
        risk_score, revenue_score, churn_score, compliance_score, confidence_pct,
        rule_flags_json, feature_payload_json, model_version
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        rfm_recency_score = VALUES(rfm_recency_score),
        rfm_frequency_score = VALUES(rfm_frequency_score),
        rfm_monetary_score = VALUES(rfm_monetary_score),
        rfm_total_score = VALUES(rfm_total_score),
        rfm_segment = VALUES(rfm_segment),
        cluster_label = VALUES(cluster_label),
        risk_score = VALUES(risk_score),
        revenue_score = VALUES(revenue_score),
        churn_score = VALUES(churn_score),
        compliance_score = VALUES(compliance_score),
        confidence_pct = VALUES(confidence_pct),
        rule_flags_json = VALUES(rule_flags_json),
        feature_payload_json = VALUES(feature_payload_json),
        model_version = VALUES(model_version),
        updated_at = CURRENT_TIMESTAMP
    `,
    [
      profile.clientId,
      null,
      profile.snapshotDate,
      rfm.recencyScore,
      rfm.frequencyScore,
      rfm.monetaryScore,
      rfm.total,
      rfm.segment,
      cluster,
      null,
      Math.round(profile.marginRiskScore || 0),
      Math.round(Math.max(0, Math.min(100, (profile.netPnl > 0 ? 60 : 20) + (profile.tradeCount > 100 ? 20 : 0) + (rfm.monetaryScore * 4)))),
      Math.round(Math.max(0, Math.min(100, (decision.recencyDays > 30 ? 65 : 20) + (profile.tradeCount < 20 ? 20 : 0) + (rfm.recencyScore <= 2 ? 15 : 0)))),
      Math.round(Math.max(0, Math.min(100, (decision.flags.includes("compliance_flag") ? 60 : 20) + (decision.flags.includes("bonus_abuse_alert") ? 25 : 0) + (decision.flags.includes("toxic_flow_alert") ? 15 : 0)))),
      Math.round(Math.max(55, Math.min(98, (profile.tradeCount >= 200 ? 40 : profile.tradeCount >= 80 ? 30 : 15) + (profile.daysCovered >= 60 ? 35 : profile.daysCovered >= 30 ? 25 : 10) + 20))),
      JSON.stringify(decision.flags || []),
      JSON.stringify({
        tradeCount: profile.tradeCount,
        winRate: profile.winRate,
        avgHoldMinutes: profile.avgHoldMinutes,
        totalVolumeLots: profile.totalVolumeLots,
        netPnl: profile.netPnl,
        daysCovered: profile.daysCovered,
      }),
      "rules-v2-mt5-first",
    ],
  ).catch(() => undefined);
}

function mapFlagSeverity(flag) {
  if (flag === "compliance_flag") return "critical";
  if (flag === "toxic_flow_alert" || flag === "bonus_abuse_alert" || flag === "leverage_risk_alert") return "urgent";
  if (flag === "churn_alert" || flag === "b_book_candidate") return "monitor";
  return "normal";
}

async function insertAlertEvents(conn, profile, decision) {
  for (const flag of decision.flags || []) {
    await conn.query(
      `
        INSERT INTO client_profile_alert_event
        (
          event_time, client_id, login, alert_type, severity, status,
          title, details, source, dedupe_key
        )
        VALUES (NOW(), ?, ?, ?, ?, 'open', ?, ?, 'cp-engine', ?)
      `,
      [
        profile.clientId,
        null,
        flag,
        mapFlagSeverity(flag),
        `CP Alert: ${flag}`,
        `Auto-detected by CP run on ${profile.snapshotDate}.`,
        `${profile.clientId}:${profile.snapshotDate}:${flag}`,
      ],
    ).catch(() => undefined);
  }
}

async function insertRecommendationHistory(conn, profile, decision, confidencePct, actorType = "system", actor = {}) {
  const table = await resolveRecommendationTable(conn);
  await conn.query(
    `
      INSERT INTO ${table}
      (
        recommendation_time, client_id, login, recommended_book, confidence_pct,
        reason_summary, reason_bullets_json, triggered_flags_json, scores_json,
        model_version, decision_hash, actor_type, actor_user_id, actor_email
      )
      VALUES (NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      profile.clientId,
      null,
      decision.route,
      confidencePct,
      `Recommended ${decision.route} based on CP model and active flags.`,
      JSON.stringify(decision.flags || []),
      JSON.stringify(decision.flags || []),
      JSON.stringify({
        risk: Math.round(profile.marginRiskScore || 0),
        churn: Math.max(0, Math.min(100, (decision.recencyDays > 30 ? 65 : 20) + (profile.tradeCount < 20 ? 20 : 0))),
      }),
      "rules-v2-mt5-first",
      `${profile.clientId}:${profile.snapshotDate}:${decision.route}`,
      actorType,
      actor.userId || null,
      actor.email || null,
    ],
  ).catch(() => undefined);
}

async function upsertAnalysisCache(conn, params) {
  const key = `client:${params.clientId}:login:${params.login}:from:${params.windowFrom}:to:${params.windowTo}`;
  await conn.query(
    `
      INSERT INTO client_profile_analysis_cache
      (cache_key, client_id, login, window_from, window_to, report_json, source_summary_json, is_valid, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, DATE_ADD(NOW(), INTERVAL 6 HOUR))
      ON DUPLICATE KEY UPDATE
        report_json = VALUES(report_json),
        source_summary_json = VALUES(source_summary_json),
        is_valid = 1,
        expires_at = VALUES(expires_at),
        updated_at = CURRENT_TIMESTAMP
    `,
    [
      key,
      params.clientId,
      params.login,
      params.windowFrom,
      params.windowTo,
      JSON.stringify(params.report || {}),
      JSON.stringify(params.sourceSummary || {}),
    ],
  ).catch(() => undefined);
}

async function readAnalysisCache(conn, params) {
  const key = `client:${params.clientId}:login:${params.login}:from:${params.windowFrom}:to:${params.windowTo}`;
  const [rows] = await conn.query(
    `
      SELECT report_json
      FROM client_profile_analysis_cache
      WHERE cache_key = ?
        AND is_valid = 1
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    `,
    [key],
  ).catch(() => [[]]);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.report_json) return null;
  try {
    return typeof row.report_json === "string" ? JSON.parse(row.report_json) : row.report_json;
  } catch {
    return null;
  }
}

async function insertRunError(conn, runId, clientId, message) {
  await conn.query(
    `
      INSERT INTO client_profile_run_error (run_id, client_id, error_code, error_message, created_at)
      VALUES (?, ?, 'profile_compute_failed', ?, NOW())
    `,
    [runId, clientId, String(message || "Unknown error").slice(0, 64000)],
  ).catch(() => undefined);
}

export async function runClientProfilingJob(options = {}) {
  if (activeRunPromise) return activeRunPromise;

  activeRunPromise = (async () => {
    const db = await ensureDbInitialized();
    const conn = await db.getConnection();

    const snapshotDate = options.snapshotDate && toIsoDate(options.snapshotDate) ? toIsoDate(options.snapshotDate) : todayIso();
    const runType = String(options.runType || "manual").slice(0, 20);
    const dryRun = Boolean(options.dryRun);

    let runId = 0;
    let processed = 0;
    let failed = 0;

    try {
      await closeStaleRunningRuns(conn);
      runId = await insertRunLog(conn, runType, snapshotDate);
      cancelledRunIds.delete(runId);
      const maxClients = Number(options.maxClients);
      const batchSize = Math.max(20, Math.min(1000, Number(options.batchSize) || 200));
      const clientPipelineTimeoutMs = Math.max(
        30_000,
        Number(options.clientTimeoutMs) || CP_CLIENT_PIPELINE_TIMEOUT_MS,
      );
      const targetClientIds = Array.isArray(options.clientIds) && options.clientIds.length
        ? new Set(options.clientIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))
        : null;
      let offset = 0;
      let keepPaging = true;
      let emptyPages = 0;
      await insertRunStepLog(conn, {
        runId,
        stepKey: "run_started",
        status: "ok",
        processed,
        failed,
        details: {
          runType,
          snapshotDate,
          dryRun,
          batchSize,
          clientPipelineTimeoutMs,
          maxClients: Number.isFinite(maxClients) && maxClients > 0 ? maxClients : null,
          targetedClients: targetClientIds ? targetClientIds.size : null,
          backendBaseUrl: MT5_WEB_API_BASE_URL,
          portalUsersUrl: PORTAL_USERS_URL,
          portalTokenConfigured: Boolean(PORTAL_TOKEN),
          tradeFetchPrimaryEndpoint: `${MT5_WEB_API_BASE_URL}/Deal/GetDealsByLogins`,
        },
        message: "Client profiling run started.",
      });

      while (keepPaging) {
        if (cancelledRunIds.has(runId)) {
          await insertRunStepLog(conn, {
            runId,
            stepKey: "run_cancelled",
            status: "warn",
            processed,
            failed,
            message: "Run was cancelled by user request.",
          });
          await updateRunLog(conn, runId, "cancelled", processed, failed, "Cancelled from CP UI");
          return {
            ok: true,
            runId,
            status: "cancelled",
            snapshotDate,
            processed,
            failed,
            dryRun,
          };
        }
        await insertRunStepLog(conn, {
          runId,
          stepKey: "fetch_users_page_started",
          status: "info",
          pageOffset: offset,
          pageSize: batchSize,
          processed,
          failed,
          message: `Fetching users page at offset ${offset}.`,
        });
        let users = [];
        let userFetchError = null;
        try {
          users = await fetchUsersBatch(offset, batchSize);
        } catch (ufErr) {
          userFetchError = ufErr?.message || String(ufErr);
        }
        await insertRunStepLog(conn, {
          runId,
          stepKey: "fetch_users_page_completed",
          status: userFetchError ? "error" : (Array.isArray(users) && users.length > 0 ? "ok" : "warn"),
          pageOffset: offset,
          pageSize: batchSize,
          processed,
          failed,
          details: { usersFetched: Array.isArray(users) ? users.length : 0, error: userFetchError, portalUrl: PORTAL_USERS_URL },
          message: userFetchError
            ? `CRITICAL: Failed to fetch users at offset ${offset}: ${userFetchError}. Portal URL: ${PORTAL_USERS_URL}`
            : `Fetched ${Array.isArray(users) ? users.length : 0} users at offset ${offset}.`,
        });
        if (userFetchError) {
          // If we can't fetch users, the whole run is broken — fail fast.
          await updateRunLog(conn, runId, "failed", processed, failed, `User fetch failed at offset ${offset}: ${userFetchError}`);
          throw new Error(`User fetch failed at offset ${offset}: ${userFetchError}`);
        }
        if (!users.length) {
          emptyPages += 1;
          if (emptyPages >= 1) break;
        } else {
          emptyPages = 0;
        }

        for (const user of users) {
          if (cancelledRunIds.has(runId)) {
            await insertRunStepLog(conn, {
              runId,
              stepKey: "run_cancelled",
              status: "warn",
              processed,
              failed,
              message: "Run was cancelled by user request.",
            });
            await updateRunLog(conn, runId, "cancelled", processed, failed, "Cancelled from CP UI");
            return {
              ok: true,
              runId,
              status: "cancelled",
              snapshotDate,
              processed,
              failed,
              dryRun,
            };
          }
          if (Number.isFinite(maxClients) && maxClients > 0 && (processed + failed) >= maxClients) {
            keepPaging = false;
            break;
          }

          const clientId = Number(user?.id);
          if (targetClientIds && !targetClientIds.has(clientId)) {
            continue;
          }
          if (!Number.isFinite(clientId) || clientId <= 0) continue;

          try {
            await insertRunStepLog(conn, {
              runId,
              stepKey: "client_started",
              status: "info",
              clientId,
              pageOffset: offset,
              pageSize: batchSize,
              processed,
              failed,
              message: `Started client ${clientId}.`,
            });

            const clientFlowPromise = (async () => {
              const startDate = clampStartDate(user?.registrationDate);
              let accounts = [];
              let accountFetchError = null;
              try {
                accounts = await fetchAccountsByUserId(clientId);
              } catch (accErr) {
                accountFetchError = accErr?.message || String(accErr);
              }
              const logins = accounts.map((a) => Number(a?.login)).filter((x) => Number.isFinite(x) && x > 0);
              await insertRunStepLog(conn, {
                runId,
                stepKey: "accounts_fetched",
                status: accountFetchError ? "error" : (accounts.length === 0 ? "warn" : "ok"),
                clientId,
                login: logins[0] || null,
                pageOffset: offset,
                pageSize: batchSize,
                processed,
                failed,
                details: { accountCount: accounts.length, loginCount: logins.length, error: accountFetchError },
                message: accountFetchError
                  ? `Account fetch error for client ${clientId}: ${accountFetchError}`
                  : accounts.length === 0
                    ? `WARNING: No MT5 accounts found for client ${clientId}. Trades will be fetched by userId only.`
                    : `Fetched ${accounts.length} accounts (${logins.length} logins) for client ${clientId}.`,
              });

              const tradeFetch = await fetchTradesForClientWithMt5Fallback({
                userId: clientId,
                logins,
                fromDate: startDate,
                toDate: snapshotDate,
              });
              const trades = tradeFetch.trades;
              const tradeCount = Array.isArray(trades) ? trades.length : 0;
              await insertRunStepLog(conn, {
                runId,
                stepKey: "trades_fetched",
                status: tradeCount === 0 ? "warn" : "ok",
                clientId,
                login: logins[0] || null,
                pageOffset: offset,
                pageSize: batchSize,
                processed,
                failed,
                details: {
                  tradeSource: tradeFetch.source,
                  tradesFetched: tradeCount,
                  fetchDiagnostics: tradeFetch.diagnostics || null,
                },
                message: tradeCount === 0
                  ? `WARNING: 0 trades fetched for client ${clientId} (source: ${String(tradeFetch.source || "unknown")}). Steps: ${JSON.stringify((tradeFetch.diagnostics?.steps || []).map((s) => `${s.step}=${s.result}`))}`
                  : `Fetched ${tradeCount} trades from ${String(tradeFetch.source || "unknown")}.`,
              });

              const profile = calculateProfileMetrics(user, trades, snapshotDate);
              const cluster = classifyCluster(profile);
              const decision = buildDecision(profile);
              const confidencePct = Math.round(Math.max(55, Math.min(98, (profile.tradeCount >= 200 ? 40 : profile.tradeCount >= 80 ? 30 : 15) + (profile.daysCovered >= 60 ? 35 : profile.daysCovered >= 30 ? 25 : 10) + 20)));
              if (!dryRun) {
                await upsertClientProfile(conn, profile);
                await upsertClientTradeFactDaily(conn, profile, trades);
                await upsertClientProfileScores(conn, profile, cluster, decision);
                await insertAlertEvents(conn, profile, decision);
                await insertRecommendationHistory(conn, profile, decision, confidencePct, "system");
              }
              await insertRunStepLog(conn, {
                runId,
                stepKey: "client_persisted",
                status: "ok",
                clientId,
                login: logins[0] || null,
                pageOffset: offset,
                pageSize: batchSize,
                processed: processed + 1,
                failed,
                details: {
                  dryRun,
                  route: decision.route,
                  tradeCount: profile.tradeCount,
                },
                message: `Client ${clientId} persisted successfully.`,
              });
              return { accounts, logins, trades, tradeFetch };
            })();

            const timedFlow = Promise.race([
              clientFlowPromise,
              new Promise((_, reject) => {
                setTimeout(() => {
                  reject(new Error(`Client pipeline timed out after ${Math.round(clientPipelineTimeoutMs / 1000)}s`));
                }, clientPipelineTimeoutMs);
              }),
            ]);

            const flowResult = await timedFlow;
            processed += 1;
            await safeUpdateRunProgress(conn, runId, processed, failed);
            if (processed % 25 === 0) {
              await insertRunStepLog(conn, {
                runId,
                stepKey: "client_processed",
                status: "ok",
                clientId,
                login: flowResult.logins?.[0] || null,
                pageOffset: offset,
                pageSize: batchSize,
                processed,
                failed,
                details: {
                  tradeSource: flowResult.tradeFetch.source,
                  tradesFetched: Array.isArray(flowResult.trades) ? flowResult.trades.length : 0,
                  accountsFetched: flowResult.accounts.length,
                },
                message: `Processed ${processed} clients so far.`,
              });
            }
            if ((processed + failed) % 10 === 0) {
              await safeUpdateRunProgress(conn, runId, processed, failed);
            }
          } catch (error) {
            failed += 1;
            await insertRunError(conn, runId, clientId, error?.message || String(error));
            await safeUpdateRunProgress(conn, runId, processed, failed);
            await insertRunStepLog(conn, {
              runId,
              stepKey: "client_failed",
              status: "error",
              clientId,
              pageOffset: offset,
              pageSize: batchSize,
              processed,
              failed,
              message: error?.message || String(error),
            });
            if ((processed + failed) % 10 === 0) {
              await safeUpdateRunProgress(conn, runId, processed, failed);
            }
          }
        }

        if (!keepPaging) break;
        if (users.length < batchSize) break;
        offset += batchSize;
      }

      await updateRunLog(conn, runId, failed > 0 ? "partial" : "success", processed, failed, null);
      await insertRunStepLog(conn, {
        runId,
        stepKey: "run_finished",
        status: failed > 0 ? "warn" : "ok",
        processed,
        failed,
        details: { status: failed > 0 ? "partial" : "success" },
        message: `Run finished with status ${failed > 0 ? "partial" : "success"}.`,
      });
      return {
        ok: true,
        runId,
        status: failed > 0 ? "partial" : "success",
        snapshotDate,
        processed,
        failed,
        dryRun,
      };
    } catch (error) {
      if (runId) {
        await updateRunLog(conn, runId, "failed", processed, failed, error?.message || String(error));
        await insertRunStepLog(conn, {
          runId,
          stepKey: "run_failed",
          status: "error",
          processed,
          failed,
          message: error?.message || String(error),
        });
      }
      throw error;
    } finally {
      if (runId) cancelledRunIds.delete(runId);
      conn.release();
      activeRunPromise = null;
    }
  })();

  return activeRunPromise;
}

export async function listClientProfileRunStepLogs(runId, limit = 100) {
  const db = await ensureDbInitialized();
  const rowLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
  const [rows] = await db.query(
    `
      SELECT *
      FROM client_profile_run_step_log
      WHERE run_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `,
    [Number(runId), rowLimit],
  );
  return rows;
}

export async function listCurrentClientProfiles({ clientId, limit = 100 } = {}) {
  const db = await ensureDbInitialized();
  const rowLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
  if (Number.isFinite(Number(clientId)) && Number(clientId) > 0) {
    const [rows] = await db.query(
      `SELECT * FROM client_profile_current WHERE client_id = ? LIMIT 1`,
      [Number(clientId)],
    );
    return rows;
  }
  const [rows] = await db.query(
    `
      SELECT *
      FROM client_profile_current
      ORDER BY updated_at DESC
      LIMIT ?
    `,
    [rowLimit],
  );
  return rows;
}

export async function listClientProfileRuns(limit = 50) {
  const db = await ensureDbInitialized();
  const conn = await db.getConnection();
  await closeStaleRunningRuns(conn);
  conn.release();
  const rowLimit = Math.max(1, Math.min(500, Number(limit) || 50));
  const [rows] = await db.query(
    `
      SELECT *
      FROM client_profile_run_log
      ORDER BY started_at DESC
      LIMIT ?
    `,
    [rowLimit],
  );
  const runRows = Array.isArray(rows) ? rows : [];
  for (const row of runRows) {
    const status = String(row?.status || "").toLowerCase();
    if (status !== "running") continue;
    const runId = Number(row?.id || 0);
    if (!runId) continue;
    const [stepAgg] = await db.query(
      `
        SELECT
          COALESCE(SUM(CASE WHEN step_key = 'client_persisted' THEN 1 ELSE 0 END), 0) AS processed_count,
          COALESCE(SUM(CASE WHEN step_key = 'client_failed' THEN 1 ELSE 0 END), 0) AS failed_count
        FROM client_profile_run_step_log
        WHERE run_id = ?
      `,
      [runId],
    ).catch(() => [[{ processed_count: 0, failed_count: 0 }]]);
    const agg = Array.isArray(stepAgg) ? stepAgg[0] : null;
    const processedCount = Number(agg?.processed_count || 0);
    const failedCount = Number(agg?.failed_count || 0);
    const rowProcessed = Number(row?.clients_processed || 0);
    const rowFailed = Number(row?.clients_failed || 0);
    if (processedCount > rowProcessed || failedCount > rowFailed) {
      row.clients_processed = Math.max(rowProcessed, processedCount);
      row.clients_failed = Math.max(rowFailed, failedCount);
    }
  }
  return runRows;
}

export async function closeLatestRunningClientProfileRun(manualReason = "Manually closed stuck run from CP UI") {
  const db = await ensureDbInitialized();
  const conn = await db.getConnection();
  try {
    const [rows] = await conn.query(
      `
        SELECT id, status, started_at
        FROM client_profile_run_log
        WHERE status = 'running'
        ORDER BY started_at DESC
        LIMIT 1
      `,
    );
    const run = Array.isArray(rows) ? rows[0] : null;
    if (!run?.id) {
      return { ok: true, closed: false, message: "No running run found." };
    }
    cancelledRunIds.add(Number(run.id));
    await conn.query(
      `
        UPDATE client_profile_run_log
        SET status = 'cancelled',
            error_message = ?,
            finished_at = NOW()
        WHERE id = ?
      `,
      [String(manualReason || "Manually closed stuck run from CP UI").slice(0, 2000), Number(run.id)],
    );
    return { ok: true, closed: true, runId: Number(run.id) };
  } finally {
    conn.release();
  }
}

export async function getClientProfileRunErrors(runId, limit = 200) {
  const db = await ensureDbInitialized();
  const rowLimit = Math.max(1, Math.min(2000, Number(limit) || 200));
  const [rows] = await db.query(
    `
      SELECT *
      FROM client_profile_run_error
      WHERE run_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `,
    [Number(runId), rowLimit],
  );
  return rows;
}

export async function getClientProfileDashboardSummary() {
  const db = await ensureDbInitialized();
  const [rows] = await db.query(`SELECT * FROM client_profile_current`);
  const items = Array.isArray(rows) ? rows : [];

  const enriched = items.map((row) => {
    const normalized = {
      clientId: Number(row.client_id || 0),
      tradeCount: toNumber(row.trade_count),
      winRate: toNumber(row.win_rate),
      avgHoldMinutes: toNumber(row.avg_hold_minutes),
      totalVolumeLots: toNumber(row.total_volume_lots),
      netPnl: toNumber(row.net_pnl),
      totalSwap: toNumber(row.total_swap),
      totalCommission: toNumber(row.total_commission),
      firstTradeAt: row.first_trade_at,
      lastTradeAt: row.last_trade_at,
      daysCovered: toNumber(row.days_covered),
      updatedAt: row.updated_at,
    };
    normalized.recencyDays = normalized.lastTradeAt ? Math.floor((Date.now() - new Date(normalized.lastTradeAt).getTime()) / (24 * 60 * 60 * 1000)) : 9999;
    normalized.vintageYears = normalized.daysCovered / 365;
    normalized.avgRoiPct = normalized.totalCommission > 0 ? (normalized.netPnl / normalized.totalCommission) * 100 : 0;
    normalized.medianHoldingDays = Math.max(0, normalized.avgHoldMinutes / (60 * 24));
    normalized.marginRiskScore = Math.max(0, Math.min(100, Math.round((normalized.winRate < 0.25 ? 60 : 20) + (normalized.tradeCount > 200 ? 20 : 0) + (normalized.avgHoldMinutes <= 20 ? 20 : 0))));
    normalized.bonusAbuseScore = Math.max(0, Math.min(100, Math.round((normalized.tradeCount > 180 ? 30 : 0) + (normalized.avgHoldMinutes <= 15 ? 30 : 0) + (normalized.netPnl > 0 && normalized.totalCommission < Math.abs(normalized.netPnl) * 0.02 ? 40 : 0))));
    normalized.rfm = computeRfm(normalized);
    const cluster = classifyCluster(normalized);
    const decision = buildDecision(normalized);
    return { ...normalized, cluster, decision };
  });

  const clusterCounts = enriched.reduce((acc, item) => {
    acc[item.cluster] = (acc[item.cluster] || 0) + 1;
    return acc;
  }, {});

  const routeCounts = enriched.reduce((acc, item) => {
    const key = item.decision.route;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const topRevenue = [...enriched]
    .sort((a, b) => b.netPnl - a.netPnl)
    .slice(0, 10)
    .map((item) => ({
      clientId: item.clientId,
      netPnl: item.netPnl,
      tradeCount: item.tradeCount,
      winRate: item.winRate,
      cluster: item.cluster,
      suggestedRoute: item.decision.route,
    }));

  const topRisk = [...enriched]
    .filter((item) => item.decision.flags.includes("toxic_flow_alert") || item.decision.flags.includes("b_book_candidate"))
    .sort((a, b) => (b.marginRiskScore + b.bonusAbuseScore) - (a.marginRiskScore + a.bonusAbuseScore))
    .slice(0, 10)
    .map((item) => ({
      clientId: item.clientId,
      tradeCount: item.tradeCount,
      avgHoldMinutes: item.avgHoldMinutes,
      netPnl: item.netPnl,
      flags: item.decision.flags,
      cluster: item.cluster,
      riskScore: item.marginRiskScore,
    }));

  const churnWatchlist = enriched
    .filter((item) => item.tradeCount <= 20 || item.decision.recencyDays > 30)
    .sort((a, b) => b.decision.recencyDays - a.decision.recencyDays)
    .slice(0, 25)
    .map((item) => ({
      clientId: item.clientId,
      recencyDays: item.decision.recencyDays,
      tradeCount: item.tradeCount,
      netPnl: item.netPnl,
      lastTradeAt: item.lastTradeAt,
    }));

  const activeAlerts = enriched.filter((item) => item.decision.flags.length > 0).length;

  return {
    asOf: new Date().toISOString(),
    totals: {
      totalClients: enriched.length,
      routeABook: routeCounts["A-Book"] || 0,
      routeBBook: routeCounts["B-Book"] || 0,
      routeMonitor: routeCounts["Monitor"] || 0,
      triggerChurnAlert: enriched.filter((item) => item.decision.flags.includes("churn_alert")).length,
      leverageRiskAlerts: enriched.filter((item) => item.decision.flags.includes("leverage_risk_alert")).length,
      flagCompliance: enriched.filter((item) => item.decision.flags.includes("compliance_flag")).length,
      toxicFlowAlerts: enriched.filter((item) => item.decision.flags.includes("toxic_flow_alert")).length,
      bonusAbuseAlerts: enriched.filter((item) => item.decision.flags.includes("bonus_abuse_alert")).length,
      activeAlerts,
    },
    segmentedByCluster: clusterCounts,
    topRevenue,
    topRisk,
    churnWatchlist,
  };
}

export async function analyzeClientByAccountLogin(login) {
  const numericLogin = Number(login);
  if (!Number.isFinite(numericLogin) || numericLogin <= 0) throw new Error("valid login is required");

  const accounts = await postPortal(PORTAL_ACCOUNTS_URL, { login: numericLogin, segment: { limit: 5, offset: 0 } });
  const account = (Array.isArray(accounts) ? accounts : []).find((row) => Number(row?.login) === numericLogin);
  if (!account) throw new Error(`account login ${numericLogin} not found`);

  const clientId = Number(account?.userId);
  if (!Number.isFinite(clientId) || clientId <= 0) throw new Error("account is missing linked client userId");

  const users = await postPortal(PORTAL_USERS_URL, { segment: { limit: 1000, offset: 0 } }).catch(() => []);
  const user = (Array.isArray(users) ? users : []).find((row) => Number(row?.id) === clientId) || null;
  const startDate = clampStartDate(user?.registrationDate);
  const endDate = todayIso();
  const db = await ensureDbInitialized();
  const conn = await db.getConnection();
  try {
    const cached = await readAnalysisCache(conn, {
      clientId,
      login: numericLogin,
      windowFrom: startDate,
      windowTo: endDate,
    });
    if (cached) return cached;
    const allClientAccounts = await fetchAccountsByUserId(clientId);
    const logins = allClientAccounts.map((a) => Number(a?.login)).filter((x) => Number.isFinite(x) && x > 0);
    const tradeFetch = await fetchTradesForClientWithMt5Fallback({
      userId: clientId,
      logins,
      fromDate: startDate,
      toDate: endDate,
    });
    const trades = tradeFetch.trades;
    const profile = calculateProfileMetrics(user || { id: clientId, registrationDate: startDate }, trades, endDate);
    const dealingEvidence = await fetchDealingEvidence({
      login: numericLogin,
      fromDate: startDate,
      toDate: endDate,
    }).catch(() => null);
    const transactions = await postPortal(PORTAL_TRANSACTIONS_URL, { fromUserId: clientId }).catch(() => []);
    const deposits = (Array.isArray(transactions) ? transactions : []).filter((t) => String(t?.type || "").toLowerCase().includes("deposit"));
    const withdrawals = (Array.isArray(transactions) ? transactions : []).filter((t) => String(t?.type || "").toLowerCase().includes("withdraw"));
    profile.rfm = computeRfm(profile);
    const cluster = classifyCluster(profile);
    const decision = buildDecision(profile);
    const writeChecks = {
      upsertClientProfile: { ok: false, error: null },
      upsertClientTradeFactDaily: { ok: false, error: null },
      upsertClientProfileScores: { ok: false, error: null },
      insertAlertEvents: { ok: false, error: null },
      insertRecommendationHistory: { ok: false, error: null },
      upsertAnalysisCache: { ok: false, error: null },
    };
    // Persist per-client analysis so CP tables are populated even outside full batch runs.
    try {
      await upsertClientProfile(conn, profile);
      writeChecks.upsertClientProfile.ok = true;
    } catch (e) {
      writeChecks.upsertClientProfile.error = e?.message || String(e);
    }
    try {
      await upsertClientTradeFactDaily(conn, profile, trades);
      writeChecks.upsertClientTradeFactDaily.ok = true;
    } catch (e) {
      writeChecks.upsertClientTradeFactDaily.error = e?.message || String(e);
    }
    try {
      await upsertClientProfileScores(conn, profile, cluster, decision);
      writeChecks.upsertClientProfileScores.ok = true;
    } catch (e) {
      writeChecks.upsertClientProfileScores.error = e?.message || String(e);
    }
    try {
      await insertAlertEvents(conn, profile, decision);
      writeChecks.insertAlertEvents.ok = true;
    } catch (e) {
      writeChecks.insertAlertEvents.error = e?.message || String(e);
    }

  const symbolMap = new Map();
  for (const trade of trades) {
    const symbol = String(trade?.symbol || "UNKNOWN").toUpperCase();
    const side = String(trade?.ticketType || trade?.side || "").toUpperCase();
    const pl = toNumber(trade?.pl ?? trade?.profit);
    const volume = toNumber(trade?.volume ?? trade?.lots);
    const row = symbolMap.get(symbol) || { symbol, trades: 0, lots: 0, pnl: 0, buys: 0, sells: 0 };
    row.trades += 1;
    row.lots += volume;
    row.pnl += pl;
    if (side.includes("BUY")) row.buys += 1;
    if (side.includes("SELL")) row.sells += 1;
    symbolMap.set(symbol, row);
  }

  const topSymbols = [...symbolMap.values()].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, 10);

  const brokerNotes = [];
  if (decision.route === "B-Book") brokerNotes.push("Client appears loss-making or high-risk; internalization (B-Book) likely improves broker profitability.");
  if (decision.route === "A-Book") brokerNotes.push("Client shows stronger quality flow; A-Book routing can reduce principal risk and build LP trust.");
  if (decision.flags.includes("toxic_flow_alert")) brokerNotes.push("Possible toxic/scalping pattern detected (high frequency + short hold + positive PnL).");
  if (decision.flags.includes("churn_alert")) brokerNotes.push("Churn risk: client activity dropped; assign retention campaign and account manager touchpoint.");
  if (decision.flags.includes("leverage_risk_alert")) brokerNotes.push("Very low win-rate or aggressive pattern; leverage reduction can limit rapid balance depletion.");
  if (decision.flags.includes("compliance_flag")) brokerNotes.push("Compliance review advised due to unusual new-account behavior.");
  if (decision.flags.includes("bonus_abuse_alert")) brokerNotes.push("Potential bonus abuse pattern: high churn-like trade frequency with limited commission footprint.");

  const financialSnapshot = {
    balance: toNumber(account?.balance),
    equity: toNumber(account?.equity),
    credit: toNumber(account?.credit),
    margin: toNumber(account?.margin),
    freeMargin: toNumber(account?.freeMargin),
    depositsTotal: deposits.reduce((sum, tx) => sum + Math.abs(toNumber(tx?.processedAmount)), 0),
    withdrawalsTotal: withdrawals.reduce((sum, tx) => sum + Math.abs(toNumber(tx?.processedAmount)), 0),
    netFunding: deposits.reduce((sum, tx) => sum + Math.abs(toNumber(tx?.processedAmount)), 0) - withdrawals.reduce((sum, tx) => sum + Math.abs(toNumber(tx?.processedAmount)), 0),
  };

    const evidenceProfitFactor = toNumber(dealingEvidence?.dealStats?.profitFactor);
    const evidenceWinRatePct = toNumber(dealingEvidence?.dealStats?.winRatePct);
    const evidenceMarginLevel = toNumber(dealingEvidence?.accountHealth?.marginLevel);
    const riskScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          profile.marginRiskScore * 0.45 +
          (decision.flags.includes("toxic_flow_alert") ? 25 : 0) +
          (decision.flags.includes("compliance_flag") ? 20 : 0) +
          (evidenceMarginLevel > 0 && evidenceMarginLevel < 130 ? 10 : 0),
        ),
      ),
    );
    const revenueScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          (profile.netPnl > 0 ? 55 : 20) +
          (profile.tradeCount > 100 ? 20 : 0) +
          (profile.rfm.monetaryScore * 4) +
          (evidenceProfitFactor > 1.2 ? 5 : 0),
        ),
      ),
    );
    const churnScore = Math.max(0, Math.min(100, Math.round((decision.recencyDays > 30 ? 65 : 20) + (profile.tradeCount < 20 ? 20 : 0) + (profile.rfm.recencyScore <= 2 ? 15 : 0))));
    const complianceScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          (decision.flags.includes("compliance_flag") ? 60 : 20) +
          (decision.flags.includes("bonus_abuse_alert") ? 25 : 0) +
          (decision.flags.includes("toxic_flow_alert") ? 15 : 0) +
          (evidenceWinRatePct > 0 && evidenceWinRatePct < 20 ? 5 : 0),
        ),
      ),
    );
  const confidencePct = Math.max(55, Math.min(98, Math.round((profile.tradeCount >= 200 ? 40 : profile.tradeCount >= 80 ? 30 : 15) + (profile.daysCovered >= 60 ? 35 : profile.daysCovered >= 30 ? 25 : 10) + 20)));

  const timeline = [
    { at: user?.registrationDate || null, event: "Client registered" },
    { at: profile.firstTradeAt || null, event: "First trade detected" },
    { at: profile.lastTradeAt || null, event: "Last trade activity" },
    { at: deposits[0]?.processedAt || null, event: "First funding movement" },
  ].filter((row) => row.at);

    const report = {
      asOf: new Date().toISOString(),
      client: {
        clientId,
        login: numericLogin,
        firstName: user?.firstName || null,
        lastName: user?.lastName || null,
        email: user?.email || null,
        country: user?.country || null,
        registrationDate: user?.registrationDate || null,
      },
      profile: {
        ...profile,
        cluster,
        decision,
      },
      financialSnapshot,
      scores: {
        riskScore,
        revenueScore,
        churnScore,
        complianceScore,
      },
      confidencePct,
      explanation: `Client classified as ${cluster}. Recommended ${decision.route} because of trade count ${profile.tradeCount}, win-rate ${(profile.winRate * 100).toFixed(2)}%, avg hold ${profile.avgHoldMinutes.toFixed(1)}m, and net PnL ${profile.netPnl.toFixed(2)}.`,
      alerts: decision.flags,
      timeline,
      topSymbols,
      dealingEvidence,
      recommendations: {
        route: decision.route,
        actions: decision.flags,
        brokerNotes,
      },
      mt5AccountSummary: {
        login: Number(account?.login) || numericLogin,
        group: account?.group || account?.groupName || null,
        serverId: account?.serverId || null,
        tradingStatus: account?.tradingStatus || null,
        tradeHistorySource: tradeFetch.source,
        accountCount: allClientAccounts.length,
      },
      crmProfile: {
        managerId: user?.managerId ?? null,
        country: user?.country || null,
        city: user?.city || null,
        language: user?.language || null,
        status: user?.status || null,
      },
    };
    try {
      await insertRecommendationHistory(conn, profile, decision, confidencePct, "manual");
      writeChecks.insertRecommendationHistory.ok = true;
    } catch (e) {
      writeChecks.insertRecommendationHistory.error = e?.message || String(e);
    }
    try {
      await upsertAnalysisCache(conn, {
        clientId,
        login: numericLogin,
        windowFrom: startDate,
        windowTo: endDate,
        report,
        sourceSummary: { tradeSource: tradeFetch.source, tradeRows: trades.length },
      });
      writeChecks.upsertAnalysisCache.ok = true;
    } catch (e) {
      writeChecks.upsertAnalysisCache.error = e?.message || String(e);
    }
    const dbVerify = await verifyClientPersistence(conn, clientId);
    report.diagnostics = {
      fetchChecks: {
        tradeHistorySource: tradeFetch.source,
        mt5BaseUrl: MT5_WEB_API_BASE_URL,
        mt5TokenConfigured: Boolean(MT5_WEB_API_TOKEN),
        portalTokenConfigured: Boolean(PORTAL_TOKEN),
        tradeFetchDiagnostics: tradeFetch.diagnostics || null,
      },
      writeChecks,
      dbVerify,
    };
    await upsertAnalysisCache(conn, {
      clientId,
      login: numericLogin,
      windowFrom: startDate,
      windowTo: endDate,
      report,
      sourceSummary: { tradeSource: tradeFetch.source, tradeRows: trades.length },
    }).catch(() => undefined);
    return report;
  } finally {
    conn.release();
  }
}

export async function createClientProfileActionAuditLog(input) {
  const db = await ensureDbInitialized();
  const actionKey = String(input?.actionKey || "").trim();
  if (!actionKey) throw new Error("actionKey is required");
  const [result] = await db.query(
    `
      INSERT INTO client_profile_action_audit_log
      (
        action_key, client_id, login, recommended_book, confidence_pct,
        actor_user_id, actor_email, actor_role, confirmation_note, action_payload_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      actionKey,
      Number(input?.clientId) || null,
      Number(input?.login) || null,
      input?.recommendedBook || null,
      Number.isFinite(Number(input?.confidencePct)) ? Number(input.confidencePct) : null,
      String(input?.actorUserId || ""),
      input?.actorEmail || null,
      input?.actorRole || null,
      input?.confirmationNote || null,
      JSON.stringify(input?.payload || {}),
    ],
  );
  return { id: Number(result.insertId) };
}

export async function listClientProfileActionAuditLogs(limit = 100) {
  const db = await ensureDbInitialized();
  const rowLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
  try {
    const [rows] = await db.query(
      `
        SELECT *
        FROM client_profile_action_audit_log
        ORDER BY created_at DESC
        LIMIT ?
      `,
      [rowLimit],
    );
    return rows;
  } catch (error) {
    const msg = String(error?.message || "").toLowerCase();
    const code = String(error?.code || "");
    // Soft-fail for schema drift / first-run environments.
    if (code === "ER_NO_SUCH_TABLE" || msg.includes("client_profile_action_audit_log")) {
      return [];
    }
    throw error;
  }
}
