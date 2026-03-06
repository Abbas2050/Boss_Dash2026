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

app.set('trust proxy', true);

app.disable('x-powered-by');
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()) : true,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
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
  '/Swap',
  '/History',
  '/Report',
  '/Deal',
  '/Position',
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

// Serve the development copy of account-alerts.html for quick testing
app.get('/account-alerts.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'account-alerts.html'));
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Serve static files (optional, for production)
app.use(express.static(path.join(__dirname, 'dist')));

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
});
