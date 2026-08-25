// Main Express server for Google Analytics API
import "dotenv/config";
import express from 'express';
import cors from 'cors';
import path from 'path';
import http from 'http';
import mysql from 'mysql2/promise';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import marketingApi from './api.js';
import agentRouter from "./agent/router.js";
import { runClientProfilingJob } from "./agent/clientProfilingService.js";
import authRouter from "./auth/router.js";
import clientProfileRouter from "./clientProfileRouter.js";
import docusignRouter from "./docusign/router.js";
import { runAppIdMigration } from "./docusign/migrateAppIds.js";
import { getDocusignPool } from "./docusign/store.js";
import { startDocusignReconcileScheduler } from "./docusign/reconcile.js";
import oauthRouter from "./oauth/router.js";
import { checkAllBalances } from './wallet/walletMonitor.js';
import { notifyIfTotalChanged } from './wallet/scheduler.js';
import { startHubWatcher } from './alerts/hubWatcher.js';
import { authRequired, canManageUsers } from './auth/router.js';
import { requireSession } from './auth/requireSession.js';
import { readAlarmConfig, writeAlarmConfig } from './alerts/alarmConfig.js';
import { GoogleSheetsClient } from './wallet/pspClients.js';
import {
  loadGoogleSheetsMappingConfig,
  saveGoogleSheetsMappingConfig,
  resetGoogleSheetsMappingConfig,
} from './wallet/googleSheetsMappingConfig.js';
import { startWeeklyDealMatchScheduler, runWeeklyDealMatchEmailReport } from './reports/dealMatchWeeklyReport.js';
import { startWeeklySlippageScheduler, runWeeklySlippageEmailReport } from './reports/slippageWeeklyReport.js';
import { startWeeklyBusinessSummaryScheduler, runWeeklyBusinessSummary } from './reports/weeklyBusinessSummary.js';
import { getChartDir, CHART_ROUTE } from './reports/reportShared.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const REST_PROXY_TARGET = process.env.REST_PROXY_TARGET || 'https://portal.skylinkscapital.com';

// The CRM credential lives here and ONLY here. It used to be read in the
// browser from VITE_API_TOKEN, which Vite compiles into the shipped bundle --
// a build on 2026-08-21 put the value in 13 public files, 35 times over, where
// any logged-in user could read it from devtools. The browser now calls our
// own /rest proxy with no credential and this attaches it upstream.
//
// VITE_-prefixed names are accepted as a fallback so a server that has not had
// its .env updated yet keeps working; drop them once production is migrated.
// .trim() matters: a .env edited on Windows can leave a trailing CR byte on the
// value, which makes the CRM reject the bearer token with a 403 that says
// nothing about whitespace. reports/reportShared.js has always trimmed.
const CRM_API_TOKEN = String(process.env.API_TOKEN || process.env.VITE_API_TOKEN || '').trim();
const CRM_API_VERSION = String(process.env.API_VERSION || process.env.VITE_API_VERSION || '1.0.0').trim();
if (!CRM_API_TOKEN) {
  console.error(
    '[CRM proxy] API_TOKEN is not set. Every /rest request will be refused with 503 ' +
      'crm_token_not_configured. Set API_TOKEN (no VITE_ prefix) in .env and restart.',
  );
} else {
  console.log(`[CRM proxy] CRM token loaded (${CRM_API_TOKEN.length} chars), version ${CRM_API_VERSION}.`);
}
const WALLET_PROXY_TARGET = process.env.WALLET_PROXY_TARGET || 'https://crm.skylinkscapital.com';
const BACKEND_API_TARGET =
  process.env.BACKEND_API_BASE_URL ||
  process.env.VITE_BACKEND_BASE_URL ||
  'https://api.skylinkscapital.com';

const walletNotifyLogs = [];
const MAX_WALLET_NOTIFY_LOGS = 100;
const LP_EQUITY_DB_HOST = process.env.LP_EQUITY_DB_HOST || process.env.AUTH_DB_HOST || process.env.DB_HOST;
const LP_EQUITY_DB_PORT = Number(process.env.LP_EQUITY_DB_PORT || process.env.AUTH_DB_PORT || process.env.DB_PORT || 3306);
const LP_EQUITY_DB_NAME = process.env.LP_EQUITY_DB_NAME || process.env.AUTH_DB_NAME || process.env.DB_NAME;
const LP_EQUITY_DB_USER = process.env.LP_EQUITY_DB_USER || process.env.AUTH_DB_USER || process.env.DB_USER;
const LP_EQUITY_DB_PASSWORD = process.env.LP_EQUITY_DB_PASSWORD || process.env.AUTH_DB_PASSWORD || process.env.DB_PASSWORD;
let lpEquityPool = null;
let lpEquityInitPromise = null;

function pushWalletNotifyLog(entry) {
  walletNotifyLogs.unshift({ timestamp: new Date().toISOString(), ...entry });
  if (walletNotifyLogs.length > MAX_WALLET_NOTIFY_LOGS) {
    walletNotifyLogs.length = MAX_WALLET_NOTIFY_LOGS;
  }
}

function hasLpEquityDbConfig() {
  return Boolean(LP_EQUITY_DB_HOST && LP_EQUITY_DB_NAME && LP_EQUITY_DB_USER && LP_EQUITY_DB_PASSWORD);
}

function toSnapshotDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return null;
}

function toFixedNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function ensureLpEquityStore() {
  if (!hasLpEquityDbConfig()) {
    throw new Error('LP equity DB env vars are missing.');
  }
  if (lpEquityPool) return lpEquityPool;
  if (lpEquityInitPromise) return lpEquityInitPromise;

  lpEquityInitPromise = (async () => {
    lpEquityPool = mysql.createPool({
      host: LP_EQUITY_DB_HOST,
      port: LP_EQUITY_DB_PORT,
      database: LP_EQUITY_DB_NAME,
      user: LP_EQUITY_DB_USER,
      password: LP_EQUITY_DB_PASSWORD,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    await lpEquityPool.query(`
      CREATE TABLE IF NOT EXISTS lp_equity_snapshots (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        snapshot_date DATE NOT NULL,
        lp_withdrawable_equity DECIMAL(20,2) NOT NULL DEFAULT 0,
        client_withdrawable_equity DECIMAL(20,2) NOT NULL DEFAULT 0,
        equity_difference DECIMAL(20,2) NOT NULL DEFAULT 0,
        source VARCHAR(50) NOT NULL DEFAULT 'dashboard',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_lp_equity_snapshot_date (snapshot_date)
      )
    `);

    await lpEquityPool.query(`
      CREATE TABLE IF NOT EXISTS lp_equity_live_snapshots (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        snapshot_time DATETIME NOT NULL,
        lp_withdrawable_equity DECIMAL(20,2) NOT NULL DEFAULT 0,
        client_withdrawable_equity DECIMAL(20,2) NOT NULL DEFAULT 0,
        equity_difference DECIMAL(20,2) NOT NULL DEFAULT 0,
        source VARCHAR(50) NOT NULL DEFAULT 'dashboard',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_lp_equity_live_snapshot_time (snapshot_time)
      )
    `);

    await lpEquityPool.query(`
      CREATE TABLE IF NOT EXISTS dealing_client_lots_snapshots (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        snapshot_time DATETIME NOT NULL,
        total_lots DECIMAL(20,4) NOT NULL DEFAULT 0,
        total_volume DECIMAL(20,2) NOT NULL DEFAULT 0,
        source VARCHAR(50) NOT NULL DEFAULT 'dashboard',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_dealing_client_lots_snapshot_time (snapshot_time)
      )
    `);

    // Backward-compatible migration for older tables created before metadata columns existed.
    const ensureColumn = async (columnName, ddl) => {
      const [rows] = await lpEquityPool.query(
        `
          SELECT COUNT(*) AS cnt
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'lp_equity_snapshots'
            AND COLUMN_NAME = ?
        `,
        [columnName]
      );
      const exists = Number(rows?.[0]?.cnt || 0) > 0;
      if (!exists) {
        await lpEquityPool.query(`ALTER TABLE lp_equity_snapshots ADD COLUMN ${ddl}`);
      }
    };

    await ensureColumn('source', "source VARCHAR(50) NOT NULL DEFAULT 'dashboard'");
    await ensureColumn('created_at', 'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('updated_at', 'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    return lpEquityPool;
  })();

  return lpEquityInitPromise;
}

app.set('trust proxy', true);

app.disable('x-powered-by');
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()) : true,
  credentials: true,
}));
app.use(express.json({
  limit: '1mb',
  // DocuSign Connect signs the RAW request bytes; keep them for that route only.
  verify: (req, _res, buf) => {
    if (String(req.originalUrl || '').startsWith('/api/docusign/webhooks/connect')) {
      req.rawBody = Buffer.from(buf);
    }
  },
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Deny by default. Every /api and /rest route needs a session unless it is on
// the allow-list in auth/requireSession.js. Seventeen routes shipped without
// authentication -- including the treasury report and six write endpoints --
// because the default was open and nothing made the omission visible.
//
// This must stay ABOVE every route definition below; mounted after them it
// would silently protect nothing.
app.use(requireSession);

app.get('/api/lp-equity-snapshots', async (req, res) => {
  if (!hasLpEquityDbConfig()) {
    return res.json({
      ok: true,
      rows: [],
      warning: 'lp_equity_store_not_configured',
    });
  }
  try {
    const pool = await ensureLpEquityStore();
    const daysRaw = Number.parseInt(String(req.query.days ?? '120'), 10);
    const days = Number.isFinite(daysRaw) ? Math.max(7, Math.min(365, daysRaw)) : 120;
    const [rows] = await pool.query(
      `
        SELECT
          DATE_FORMAT(snapshot_date, '%Y-%m-%d') AS snapshotDate,
          lp_withdrawable_equity AS lpWithdrawableEquity,
          client_withdrawable_equity AS clientWithdrawableEquity,
          equity_difference AS difference,
          source,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM lp_equity_snapshots
        WHERE snapshot_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        ORDER BY snapshot_date ASC
      `,
      [days]
    );

    return res.json({
      ok: true,
      rows: rows.map((row) => ({
        snapshotDate: row.snapshotDate,
        lpWithdrawableEquity: toFixedNumber(row.lpWithdrawableEquity),
        clientWithdrawableEquity: toFixedNumber(row.clientWithdrawableEquity),
        difference: toFixedNumber(row.difference),
        source: row.source || 'dashboard',
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    });
  } catch (error) {
    return res.json({
      ok: true,
      rows: [],
      warning: 'lp_equity_store_unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/api/lp-equity-snapshots', async (req, res) => {
  if (!hasLpEquityDbConfig()) {
    return res.json({
      ok: false,
      error: 'lp_equity_store_not_configured',
      warning: true,
    });
  }
  try {
    const pool = await ensureLpEquityStore();
    const body = req.body || {};
    const snapshotDate = toSnapshotDate(body.snapshotDate);
    if (!snapshotDate) {
      return res.status(400).json({ ok: false, error: 'invalid_snapshot_date' });
    }

    const lpWithdrawableEquity = toFixedNumber(body.lpWithdrawableEquity);
    const clientWithdrawableEquity = toFixedNumber(body.clientWithdrawableEquity);
    const difference = toFixedNumber(body.difference);
    const source = String(body.source || 'dashboard').slice(0, 50);

    await pool.query(
      `
        INSERT INTO lp_equity_snapshots
          (snapshot_date, lp_withdrawable_equity, client_withdrawable_equity, equity_difference, source)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          lp_withdrawable_equity = VALUES(lp_withdrawable_equity),
          client_withdrawable_equity = VALUES(client_withdrawable_equity),
          equity_difference = VALUES(equity_difference),
          source = VALUES(source)
      `,
      [snapshotDate, lpWithdrawableEquity, clientWithdrawableEquity, difference, source]
    );

    return res.json({
      ok: true,
      snapshot: {
        snapshotDate,
        lpWithdrawableEquity,
        clientWithdrawableEquity,
        difference,
        source,
      },
    });
  } catch (error) {
    return res.json({
      ok: false,
      error: 'lp_equity_store_unavailable',
      warning: true,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get('/api/lp-equity-live-snapshots', async (req, res) => {
  if (!hasLpEquityDbConfig()) {
    return res.json({
      ok: true,
      rows: [],
      warning: 'lp_equity_live_store_not_configured',
    });
  }
  try {
    const pool = await ensureLpEquityStore();
    const hoursRaw = Number.parseInt(String(req.query.hours ?? '168'), 10);
    const hours = Number.isFinite(hoursRaw) ? Math.max(1, Math.min(24 * 30, hoursRaw)) : 168;
    const [rows] = await pool.query(
      `
        SELECT
          DATE_FORMAT(snapshot_time, '%Y-%m-%d %H:%i:%s') AS snapshotTime,
          lp_withdrawable_equity AS lpWithdrawableEquity,
          client_withdrawable_equity AS clientWithdrawableEquity,
          equity_difference AS difference,
          source,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM lp_equity_live_snapshots
        WHERE snapshot_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)
        ORDER BY snapshot_time ASC
      `,
      [hours]
    );
    return res.json({
      ok: true,
      rows: rows.map((row) => ({
        snapshotTime: row.snapshotTime,
        lpWithdrawableEquity: toFixedNumber(row.lpWithdrawableEquity),
        clientWithdrawableEquity: toFixedNumber(row.clientWithdrawableEquity),
        difference: toFixedNumber(row.difference),
        source: row.source || 'dashboard',
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    });
  } catch (error) {
    return res.json({
      ok: true,
      rows: [],
      warning: 'lp_equity_live_store_unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/api/lp-equity-live-snapshots', async (req, res) => {
  if (!hasLpEquityDbConfig()) {
    return res.json({
      ok: false,
      error: 'lp_equity_live_store_not_configured',
      warning: true,
    });
  }
  try {
    const pool = await ensureLpEquityStore();
    const body = req.body || {};
    const snapshotTimeRaw = String(body.snapshotTime || '').trim();
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(snapshotTimeRaw)) {
      return res.status(400).json({ ok: false, error: 'invalid_snapshot_time' });
    }
    const lpWithdrawableEquity = toFixedNumber(body.lpWithdrawableEquity);
    const clientWithdrawableEquity = toFixedNumber(body.clientWithdrawableEquity);
    const difference = toFixedNumber(body.difference);
    const source = String(body.source || 'dashboard').slice(0, 50);

    await pool.query(
      `
        INSERT INTO lp_equity_live_snapshots
          (snapshot_time, lp_withdrawable_equity, client_withdrawable_equity, equity_difference, source)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          lp_withdrawable_equity = VALUES(lp_withdrawable_equity),
          client_withdrawable_equity = VALUES(client_withdrawable_equity),
          equity_difference = VALUES(equity_difference),
          source = VALUES(source)
      `,
      [snapshotTimeRaw, lpWithdrawableEquity, clientWithdrawableEquity, difference, source]
    );
    return res.json({
      ok: true,
      snapshot: {
        snapshotTime: snapshotTimeRaw,
        lpWithdrawableEquity,
        clientWithdrawableEquity,
        difference,
        source,
      },
    });
  } catch (error) {
    return res.json({
      ok: false,
      error: 'lp_equity_live_store_unavailable',
      warning: true,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get('/api/dealing-client-lots-snapshots', async (req, res) => {
  if (!hasLpEquityDbConfig()) {
    return res.json({
      ok: true,
      rows: [],
      warning: 'dealing_client_lots_store_not_configured',
    });
  }
  try {
    const pool = await ensureLpEquityStore();
    const hoursRaw = Number.parseInt(String(req.query.hours ?? '72'), 10);
    const hours = Number.isFinite(hoursRaw) ? Math.max(1, Math.min(24 * 30, hoursRaw)) : 72;
    const [rows] = await pool.query(
      `
        SELECT
          DATE_FORMAT(snapshot_time, '%Y-%m-%d %H:%i:%s') AS snapshotTime,
          total_lots AS totalLots,
          total_volume AS totalVolume,
          source,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM dealing_client_lots_snapshots
        WHERE snapshot_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)
        ORDER BY snapshot_time ASC
      `,
      [hours]
    );
    console.info('[Dealing Client Lots] history query ok, rows:', Array.isArray(rows) ? rows.length : 0, '| hours:', hours);

    return res.json({
      ok: true,
      rows: rows.map((row) => ({
        snapshotTime: row.snapshotTime,
        totalLots: toFixedNumber(row.totalLots),
        totalVolume: toFixedNumber(row.totalVolume),
        source: row.source || 'dashboard',
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    });
  } catch (error) {
    console.warn('[Dealing Client Lots] GET failed:', error instanceof Error ? error.message : String(error));
    return res.json({
      ok: true,
      rows: [],
      warning: 'dealing_client_lots_store_unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/api/dealing-client-lots-snapshots', async (req, res) => {
  if (!hasLpEquityDbConfig()) {
    return res.json({
      ok: false,
      error: 'dealing_client_lots_store_not_configured',
      warning: true,
    });
  }
  try {
    const pool = await ensureLpEquityStore();
    const body = req.body || {};
    const snapshotTimeRaw = String(body.snapshotTime || '').trim();
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(snapshotTimeRaw)) {
      return res.status(400).json({ ok: false, error: 'invalid_snapshot_time' });
    }
    const totalLots = toFixedNumber(body.totalLots);
    const totalVolume = toFixedNumber(body.totalVolume);
    const source = String(body.source || 'dashboard').slice(0, 50);

    await pool.query(
      `
        INSERT INTO dealing_client_lots_snapshots
          (snapshot_time, total_lots, total_volume, source)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          total_lots = VALUES(total_lots),
          total_volume = VALUES(total_volume),
          source = VALUES(source)
      `,
      [snapshotTimeRaw, totalLots, totalVolume, source]
    );

    console.info('[Dealing Client Lots] snapshot upsert ok:', snapshotTimeRaw, '| lots:', totalLots, '| volume:', totalVolume);

    return res.json({
      ok: true,
      snapshot: {
        snapshotTime: snapshotTimeRaw,
        totalLots,
        totalVolume,
        source,
      },
    });
  } catch (error) {
    console.warn('[Dealing Client Lots] POST failed:', error instanceof Error ? error.message : String(error));
    return res.json({
      ok: false,
      error: 'dealing_client_lots_store_unavailable',
      warning: true,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get('/api/closing-balance-report', async (_req, res) => {
  try {
    // Ensure every poll gets fresh balances (avoid browser/proxy caching).
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const report = await checkAllBalances();
    // Fire-and-forget: send email+Telegram if Total Combined changed
    notifyIfTotalChanged(report)
      .then((result) => {
        pushWalletNotifyLog({
          source: 'closing-balance-report',
          totalBalance: Number(report?.data?.total_balance || 0),
          result,
        });
      })
      .catch((e) => {
        console.error('[Server] notifyIfTotalChanged error:', e.message);
        pushWalletNotifyLog({
          source: 'closing-balance-report',
          totalBalance: Number(report?.data?.total_balance || 0),
          result: { ok: false, status: 'error', reason: e?.message || String(e) },
        });
      });
    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'Failed to fetch closing balance report',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

// Temporary diagnostics endpoint for wallet notification delivery status.
app.get('/api/closing-balance-report/notify-log', (req, res) => {
  const limitRaw = Number.parseInt(String(req.query.limit ?? '20'), 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 20;
  return res.json({
    ok: true,
    count: Math.min(limit, walletNotifyLogs.length),
    logs: walletNotifyLogs.slice(0, limit),
  });
});

app.get('/api/wallet/google-sheets-debug', async (req, res) => {
  try {
    const daysBack = Number.parseInt(String(req.query.daysBack ?? '7'), 10);
    const client = new GoogleSheetsClient();
    const debug = await client.getDebugSnapshot(Number.isFinite(daysBack) ? daysBack : 7);
    return res.json(debug);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'Failed to inspect Google Sheets wallet cells',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get('/api/wallet/google-sheet-mapping', (_req, res) => {
  try {
    const config = loadGoogleSheetsMappingConfig();
    return res.json({ ok: true, ...config });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'Failed to load Google Sheets mapping',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

app.put('/api/wallet/google-sheet-mapping', (req, res) => {
  try {
    const saved = saveGoogleSheetsMappingConfig({ fields: req.body?.fields || [] });
    return res.json({ ok: true, ...saved });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: 'Failed to save Google Sheets mapping',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/api/wallet/google-sheet-mapping/reset', (_req, res) => {
  try {
    const config = resetGoogleSheetsMappingConfig();
    return res.json({ ok: true, ...config });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'Failed to reset Google Sheets mapping',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

function buildProxyHeaders(req, options = {}) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  delete headers['accept-encoding'];
  if (options.injectAuth) {
    // Drop whatever the caller sent before setting ours. Without the delete a
    // client could pin its own credential -- and header names are
    // case-insensitive over the wire, so a stray "Authorization" would survive
    // a plain assignment to the lowercase key and win.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'authorization') delete headers[key];
    }
    headers.authorization = `Bearer ${options.injectAuth}`;
  }
  return headers;
}

// The CRM rejects a request with no version, and the browser no longer knows
// which one to ask for, so fill it in when it is absent or arrived as the
// string "undefined" (what a template literal yields for a missing env var).
function withCrmVersion(path) {
  const [base, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  const current = params.get('version');
  if (!current || current === 'undefined' || current === 'null') {
    params.set('version', CRM_API_VERSION);
  }
  return `${base}?${params.toString()}`;
}

function buildProxyBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const body = req.body;
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

async function proxyHttp(req, res, options) {
  if (options.requiresCrmToken && !CRM_API_TOKEN) {
    return res.status(503).json({
      error: 'crm_token_not_configured',
      message:
        'The server has no API_TOKEN, so it cannot authenticate to the CRM. Set API_TOKEN ' +
        '(without the VITE_ prefix) in the server .env and restart. Proxying without it ' +
        'returns a 403 invalid_grant from the CRM that looks unrelated to configuration.',
    });
  }
  try {
    const incomingPath = req.originalUrl;
    const rewrittenPath = options.stripPrefix
      ? incomingPath.replace(new RegExp(`^${options.stripPrefix}`), '')
      : incomingPath;
    const finalPath = options.injectAuth ? withCrmVersion(rewrittenPath) : rewrittenPath;
    const targetUrl = `${options.targetBase.replace(/\/+$/, '')}${finalPath}`;

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: buildProxyHeaders(req, options),
      body: buildProxyBody(req),
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'transfer-encoding') return;
      if (lower === 'content-encoding') return;
      if (lower === 'content-length') return;
      if (lower === 'connection') return;
      res.setHeader(key, value);
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    // An upstream rejection on the CRM proxy is almost always a credential
    // problem, and the browser only sees the CRM's own wording. Log enough to
    // tell config from data -- never the token itself.
    if (options.injectAuth && upstream.status >= 400) {
      console.error(
        `[CRM proxy] ${req.method} ${finalPath} -> HTTP ${upstream.status}. ` +
          `Token ${CRM_API_TOKEN ? `present (${CRM_API_TOKEN.length} chars)` : 'MISSING'}. ` +
          `Upstream said: ${buffer.toString('utf8').slice(0, 200)}`,
      );
    }
    res.send(buffer);
  } catch (error) {
    res.status(502).json({
      error: 'proxy_error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// authRequired is not optional here. The proxy now attaches our CRM credential,
// so without a session check it is an open relay into the CRM for anyone who
// can reach the host.
app.use('/rest/applications', authRequired, (req, res) =>
  proxyHttp(req, res, { targetBase: REST_PROXY_TARGET, injectAuth: CRM_API_TOKEN, requiresCrmToken: true })
);
app.use('/rest', authRequired, (req, res) =>
  proxyHttp(req, res, { targetBase: REST_PROXY_TARGET, injectAuth: CRM_API_TOKEN })
);
app.use('/api/rest', authRequired, (req, res) =>
  proxyHttp(req, res, { targetBase: REST_PROXY_TARGET, stripPrefix: '/api', injectAuth: CRM_API_TOKEN, requiresCrmToken: true })
);
app.use('/api/wallet', (req, res) =>
  proxyHttp(req, res, { targetBase: WALLET_PROXY_TARGET, stripPrefix: '/api/wallet' })
);
[
  '/Metrics',
  '/Coverage',
  '/EquityOverview',
  '/Swap',
  '/History',
  '/Transactions',
  '/Report',
  '/Deal',
  '/Position',
  '/Bonus',
  '/Account',
  '/ContractSize',
  '/api/ContractSize',
].forEach((prefix) => {
  app.use(prefix, (req, res) => proxyHttp(req, res, { targetBase: BACKEND_API_TARGET }));
});

// Simple SSE mock for development to emit sample alerts (mounted under /api so Vite proxy works)
// SSE mock: supports periodic automatic events and a manual trigger endpoint
const sseClients = new Set();

app.get('/api/mock/alerts', (req, res) => {
  console.log('SSE mock: connection from', req.ip, 'headers', Object.keys(req.headers).slice(0,5));
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  // Add to connected clients so we can broadcast manual test alerts
  sseClients.add(res);

  // helper to send on this connection
  const send = (event, payload) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (e) { /* ignore write errors */ }
  };

  // periodic automatic events (keeps the stream alive and simulates traffic)
  let counter = 0;
  const iv = setInterval(() => {
    counter++;
    if (counter % 2 === 0) {
      send('UserChangeAlert', {
        time: new Date().toISOString().replace('T', ' ').substring(0, 19),
        eventType: 'Add',
        login: 900000 + counter,
        name: `Test User ${counter}`,
        group: 'Retail',
        balance: (Math.random() * 10000).toFixed(2),
        comment: 'Mock add event'
      });
    } else {
      send('AccountAlert', {
        alertType: counter % 3 === 0 ? 'StopOutEnter' : 'MarginCallEnter',
        account: { login: 800000 + counter, equity: (Math.random()*1000).toFixed(2), balance: (Math.random()*2000).toFixed(2), margin: (Math.random()*100).toFixed(2) },
        group: 'Retail'
      });
    }
  }, 3000);

  req.on('close', () => {
    clearInterval(iv);
    sseClients.delete(res);
    try { res.end(); } catch (e) {}
  });
});

// POST /api/mock/alerts/trigger
// Body: { event: 'UserChangeAlert'|'AccountAlert', data: {...} }
app.post('/api/mock/alerts/trigger', (req, res) => {
  const body = req.body || {};
  const event = body.event;
  const payload = body.data || body.payload || {};
  if (!event) return res.status(400).json({ error: 'missing event name' });

  // Broadcast to all connected SSE clients
  let sent = 0;
  for (const client of sseClients) {
    try {
      client.write(`event: ${event}\n`);
      client.write(`data: ${JSON.stringify(payload)}\n\n`);
      sent++;
    } catch (e) { /* ignore per-client errors */ }
  }

  res.json({ ok: true, event, sent });
});

// GET number of currently connected SSE clients (for debugging)
app.get('/api/mock/alerts/clients', (req, res) => {
  res.json({ clients: sseClients.size });
});

// Simple helper to return a SignalR access token from env for local dev
app.get('/api/signalr/token', (req, res) => {
  const token = process.env.SIGNALR_TOKEN || null;
  if (!token) return res.status(404).json({ error: 'no-signalr-token-configured' });
  res.json({ token });
});

// Central alarm config (served by our Node server). GET is open to the app; PUT is admin-only.
app.get('/api/alarm-config', (req, res) => {
  res.json(readAlarmConfig());
});
// Says whether the server can talk to the CRM, and why not when it cannot.
// Exists because a missing or whitespace-damaged token surfaces in the browser
// as the CRM's own "403 invalid_grant", which reads like an upstream outage
// rather than a config problem. Never returns the token -- only its length.
app.get('/api/crm-health', authRequired, async (req, res) => {
  if (!canManageUsers(req.auth)) return res.status(403).json({ error: 'forbidden' });
  const result = {
    tokenConfigured: Boolean(CRM_API_TOKEN),
    tokenLength: CRM_API_TOKEN.length,
    tokenHasEdgeWhitespace: false,
    version: CRM_API_VERSION,
    target: REST_PROXY_TARGET,
    source: process.env.API_TOKEN ? 'API_TOKEN' : process.env.VITE_API_TOKEN ? 'VITE_API_TOKEN (legacy)' : 'none',
  };
  const untrimmed = String(process.env.API_TOKEN || process.env.VITE_API_TOKEN || '');
  result.tokenHasEdgeWhitespace = untrimmed !== untrimmed.trim();
  if (!CRM_API_TOKEN) {
    return res.status(503).json({ ...result, ok: false, error: 'crm_token_not_configured' });
  }
  try {
    const probe = await fetch(`${REST_PROXY_TARGET}/rest/users?version=${encodeURIComponent(CRM_API_VERSION)}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CRM_API_TOKEN}`,
      },
      body: JSON.stringify({ segment: { limit: 1, offset: 0 } }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await probe.text().catch(() => '');
    res.status(probe.ok ? 200 : 502).json({
      ...result,
      ok: probe.ok,
      upstreamStatus: probe.status,
      upstreamBody: probe.ok ? undefined : body.slice(0, 300),
    });
  } catch (e) {
    res.status(502).json({ ...result, ok: false, error: 'probe_failed', message: e?.message || String(e) });
  }
});

app.put('/api/alarm-config', authRequired, (req, res) => {
  if (!canManageUsers(req.auth)) return res.status(403).json({ error: 'forbidden' });
  try {
    res.json(writeAlarmConfig(req.body || {}));
  } catch (e) {
    res.status(500).json({ error: 'save_failed', message: e?.message || String(e) });
  }
});

// Recipients for an on-demand weekly-report test send: accepts either an array
// or a comma-separated string in the request body.
function parseTestRecipients(body) {
  const rawList = Array.isArray(body?.recipients)
    ? body.recipients
    : String(body?.recipients || '').split(',');
  return rawList.map((e) => String(e).trim()).filter(Boolean);
}

// On-demand test send of the weekly Slippage email (admin-only). Recipients
// come from the request body and there is NO fallback to
// SLIPPAGE_ALERT_RECIPIENTS -- an empty body is a 400. That is why a test send
// can succeed while the scheduled run silently sends nothing.
app.post('/api/reports/slippage-weekly/test', authRequired, async (req, res) => {
  if (!canManageUsers(req.auth)) return res.status(403).json({ error: 'forbidden' });
  const recipients = parseTestRecipients(req.body);
  if (!recipients.length) return res.status(400).json({ error: 'recipient_required' });
  try {
    const result = await runWeeklySlippageEmailReport({ recipients });
    res.json(result);
  } catch (e) {
    res.status(502).json({ ok: false, error: 'send_failed', message: e?.message || String(e) });
  }
});

// On-demand test send of the Weekly Business Summary (admin-only).
app.post('/api/reports/summary-weekly/test', authRequired, async (req, res) => {
  if (!canManageUsers(req.auth)) return res.status(403).json({ error: 'forbidden' });
  const recipients = parseTestRecipients(req.body);
  if (!recipients.length) return res.status(400).json({ error: 'recipient_required' });
  try {
    const result = await runWeeklyBusinessSummary({ recipients });
    res.json(result);
  } catch (e) {
    res.status(502).json({ ok: false, error: 'send_failed', message: e?.message || String(e) });
  }
});

// On-demand test send of the weekly Deal Match email (admin-only). Mirrors the
// slippage test route: body recipients only, no env fallback.
app.post('/api/reports/dealmatch-weekly/test', authRequired, async (req, res) => {
  if (!canManageUsers(req.auth)) return res.status(403).json({ error: 'forbidden' });
  const recipients = parseTestRecipients(req.body);
  if (!recipients.length) return res.status(400).json({ error: 'recipient_required' });
  try {
    const result = await runWeeklyDealMatchEmailReport({ recipients });
    res.json(result);
  } catch (e) {
    res.status(502).json({ ok: false, error: 'send_failed', message: e?.message || String(e) });
  }
});

// Minimal SignalR-like negotiate + WebSocket mock, FOR LOCAL DEV ONLY.
//
// It invents a MarginCallEnter or StopOutEnter every 3 seconds with random
// equity, balance and margin, and fires the dashboard's audible alarm. Mounted
// unconditionally it was doing that on production: any browser reaching
// wss://<host>/ws/dashboard received fabricated margin calls, unauthenticated.
//
// It is now off unless ENABLE_MOCK_SIGNALR=true is set explicitly. Absent
// alerts are recoverable; invented ones are acted on.
const MOCK_SIGNALR = String(process.env.ENABLE_MOCK_SIGNALR || 'false').toLowerCase() === 'true';
if (MOCK_SIGNALR) {
  console.warn('[SignalR] MOCK HUB ENABLED -- alerts are fabricated. Never set ENABLE_MOCK_SIGNALR in production.');
}

app.all('/ws/dashboard/negotiate', (req, res) => {
  if (!MOCK_SIGNALR) return res.status(404).json({ error: 'mock_signalr_disabled' });
  const connectionId = Math.random().toString(36).slice(2, 10);
  // Return a negotiate-like payload compatible with @microsoft/signalr client
  res.json({
    connectionId,
    connectionToken: connectionId,
    negotiateVersion: 1,
    availableTransports: [
      { transport: 'WebSockets', transferFormats: ['Text'] }
    ],
    // Keep relative so browser preserves https scheme under reverse proxy.
    url: `/ws/dashboard`
  });
});

// Chart images embedded in the weekly report emails. Mail clients fetch these
// unauthenticated, so the folder name is a 128-bit random token and nothing is
// listable: an exact token + filename is the only way in. Images are pruned
// after REPORT_CHART_RETENTION_DAYS.
app.get(`${CHART_ROUTE}/:token/:name`, async (req, res) => {
  const { token, name } = req.params;
  if (!/^[a-f0-9]{32}$/.test(token) || !/^[A-Za-z0-9._-]+\.png$/.test(name)) {
    return res.status(400).end();
  }
  let base;
  try {
    base = await getChartDir();
  } catch {
    return res.status(503).end();
  }
  const file = path.resolve(base, token, name);
  // Belt and braces against traversal even though both parts are regex-checked.
  if (!file.startsWith(path.resolve(base) + path.sep)) return res.status(400).end();
  res.type('png');
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  res.sendFile(file, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// Mount marketing API
app.use('/api', marketingApi);
app.use("/api/agent", agentRouter);
app.use("/api/auth", authRouter);
app.use("/api/ClientProfile", clientProfileRouter);
app.use("/api/docusign", docusignRouter);
app.use("/oauth", oauthRouter);

// Serve the development copy of account-alerts.html for quick testing
app.get('/account-alerts.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'account-alerts.html'));
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Global JSON error handler — catches any unhandled Express errors
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[server error]', err?.message || err);
  if (res.headersSent) return;
  res.status(500).json({
    error: 'internal_server_error',
    message: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : (err?.message || String(err)),
  });
});

// Serve static files from Vite build output
app.use(express.static(path.join(__dirname, 'dist')));

// SPA fallback: serve dist/index.html for all non-API GET requests
// Express 5 requires /*splat instead of bare * wildcard
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Create HTTP server and attach WebSocket mock
const server = http.createServer(app);

const wss = MOCK_SIGNALR ? new WebSocketServer({ server, path: '/ws/dashboard' }) : null;

const RS = String.fromCharCode(0x1e);

wss?.on('connection', (ws, req) => {
  console.log('Mock SignalR WS: client connected', req.socket.remoteAddress);

  // Send SignalR handshake response (empty object) terminated by RS
  try { ws.send('{}' + RS); } catch (e) {}

  // Simple periodic messages to emulate server invocations
  let counter = 0;
  const iv = setInterval(() => {
    counter++;
    const payload = counter % 2 === 0
      ? { time: new Date().toISOString().replace('T', ' ').substring(0, 19), eventType: 'Add', login: 900000 + counter, name: `Mock User ${counter}`, group: 'Retail', balance: (Math.random() * 10000).toFixed(2) }
      : { alertType: counter % 3 === 0 ? 'StopOutEnter' : 'MarginCallEnter', account: { login: 800000 + counter, equity: (Math.random()*1000).toFixed(2), balance: (Math.random()*2000).toFixed(2), margin: (Math.random()*100).toFixed(2) }, group: 'Retail' };

    // Build SignalR invocation message
    const msg = { type: 1, target: counter % 2 === 0 ? 'UserChangeAlert' : 'AccountAlert', arguments: [payload] };
    try { ws.send(JSON.stringify(msg) + RS); } catch (e) {}
  }, 3000);

  ws.on('message', (data) => {
    // ignore client messages (could parse handshake if needed)
    // console.log('WS recv:', String(data).slice(0,200));
  });

  ws.on('close', () => {
    clearInterval(iv);
    console.log('Mock SignalR WS: client disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`Express + mock SignalR server running on http://localhost:${PORT}`);
  getDocusignPool()
    .then((pool) => runAppIdMigration(pool))
    .then((r) => console.log("[docusign-migrate]", JSON.stringify(r)))
    .catch((e) => console.error("[docusign-migrate] failed:", e?.message || String(e)));
  startDocusignReconcileScheduler();

  const profileCronEnabled = String(process.env.CLIENT_PROFILE_CRON_ENABLED || "true").toLowerCase() !== "false";
  const profileCronExpr = String(process.env.CLIENT_PROFILE_CRON || "15 2 * * *");
  if (profileCronEnabled) {
    cron.schedule(profileCronExpr, async () => {
      try {
        await runClientProfilingJob({ runType: "daily" });
      } catch (error) {
        console.error("[ClientProfileCron] run failed:", error?.message || error);
      }
    });
    console.log(`[ClientProfileCron] scheduled with expression "${profileCronExpr}"`);
  } else {
    console.log("[ClientProfileCron] disabled by CLIENT_PROFILE_CRON_ENABLED=false");
  }

  startWeeklyDealMatchScheduler();
  startWeeklySlippageScheduler();
  startWeeklyBusinessSummaryScheduler();

  try {
    startHubWatcher();
  } catch (e) {
    console.error('[Alerts] failed to start hub watcher:', e?.message || e);
  }
});
