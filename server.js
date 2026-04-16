// Main Express server for Google Analytics API
import "dotenv/config";
import express from 'express';
import cors from 'cors';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import marketingApi from './api.js';
import agentRouter from "./agent/router.js";
import authRouter from "./auth/router.js";
import clientProfileRouter from "./clientProfileRouter.js";
import docusignRouter from "./docusign/router.js";
import { startDocusignApprovedSyncScheduler } from "./docusign/sync.js";
import oauthRouter from "./oauth/router.js";
import { checkAllBalances } from './wallet/walletMonitor.js';
import { notifyIfTotalChanged } from './wallet/scheduler.js';
import { GoogleSheetsClient } from './wallet/pspClients.js';
import {
  loadGoogleSheetsMappingConfig,
  saveGoogleSheetsMappingConfig,
  resetGoogleSheetsMappingConfig,
} from './wallet/googleSheetsMappingConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const REST_PROXY_TARGET = process.env.REST_PROXY_TARGET || 'https://portal.skylinkscapital.com';
const WALLET_PROXY_TARGET = process.env.WALLET_PROXY_TARGET || 'https://crm.skylinkscapital.com';
const BACKEND_API_TARGET =
  process.env.BACKEND_API_BASE_URL ||
  process.env.VITE_BACKEND_BASE_URL ||
  'https://api.skylinkscapital.com';

const walletNotifyLogs = [];
const MAX_WALLET_NOTIFY_LOGS = 100;

function pushWalletNotifyLog(entry) {
  walletNotifyLogs.unshift({ timestamp: new Date().toISOString(), ...entry });
  if (walletNotifyLogs.length > MAX_WALLET_NOTIFY_LOGS) {
    walletNotifyLogs.length = MAX_WALLET_NOTIFY_LOGS;
  }
}

app.set('trust proxy', true);

app.disable('x-powered-by');
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()) : true,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
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

function buildProxyHeaders(req) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  delete headers['accept-encoding'];
  return headers;
}

function buildProxyBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const body = req.body;
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

async function proxyHttp(req, res, options) {
  try {
    const incomingPath = req.originalUrl;
    const rewrittenPath = options.stripPrefix
      ? incomingPath.replace(new RegExp(`^${options.stripPrefix}`), '')
      : incomingPath;
    const targetUrl = `${options.targetBase.replace(/\/+$/, '')}${rewrittenPath}`;

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: buildProxyHeaders(req),
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
    res.send(buffer);
  } catch (error) {
    res.status(502).json({
      error: 'proxy_error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

app.use('/rest', (req, res) => proxyHttp(req, res, { targetBase: REST_PROXY_TARGET }));
app.use('/api/wallet', (req, res) =>
  proxyHttp(req, res, { targetBase: WALLET_PROXY_TARGET, stripPrefix: '/api/wallet' })
);
[
  '/Metrics',
  '/Coverage',
  '/EquityOverview',
  '/Swap',
  '/History',
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

// Minimal SignalR-like negotiate + WebSocket mock for local dev
// - negotiate: GET/POST /ws/dashboard/negotiate
// - websocket endpoint: /ws/dashboard (expects SignalR JSON protocol with RS delimiters)
app.all('/ws/dashboard/negotiate', (req, res) => {
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

const wss = new WebSocketServer({ server, path: '/ws/dashboard' });

const RS = String.fromCharCode(0x1e);

wss.on('connection', (ws, req) => {
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
  startDocusignApprovedSyncScheduler();
});
