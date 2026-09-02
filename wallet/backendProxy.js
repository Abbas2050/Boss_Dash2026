/**
 * Server-side proxy for the trading backend, so the browser never holds the
 * backend Bearer.
 *
 * server.js mounts this at /api/backend, below the deny-by-default gate in
 * auth/requireSession.js, so only a logged-in dashboard user can reach it.
 * The token itself is minted from BACKEND_API_KEY by wallet/backendToken.js
 * and only ever exists in this process -- shipping it to the browser would put
 * a credential for every client's equity, balance and margin into devtools.
 *
 * The handler lives here rather than inline in server.js because server.js
 * opens database pools and registers cron schedulers at import time, so a test
 * cannot import it. This module is a pure function of (req, res, deps).
 */

import { fetchWithBackendToken } from './backendToken.js';
import { redactText } from './redactSecrets.js';

export const BACKEND_PROXY_PREFIX = '/api/backend';

export function backendProxyTarget() {
  return String(
    process.env.BACKEND_API_BASE_URL ||
      process.env.VITE_BACKEND_BASE_URL ||
      'https://api.skylinkscapital.com',
  ).replace(/\/+$/, '');
}

// DealMatch/Run legitimately takes ~40 seconds regardless of the date range
// asked for, so anything shorter than the existing proxy budget would turn a
// working report into a timeout. Same env var and same default as the CRM
// proxy in server.js, so one setting moves both.
export function backendProxyTimeoutMs() {
  return Number(process.env.PROXY_TIMEOUT_MS || 45_000);
}

/**
 * Same approach as buildProxyHeaders() in server.js: forward the caller's
 * headers minus the hop-by-hop ones, then overwrite Authorization.
 *
 * The delete loop is the load-bearing part. The browser sends OUR session JWT
 * in Authorization; that is a credential for this dashboard and means nothing
 * to the trading backend, so forwarding it would leak a session token to a
 * third party and, worse, could be mistaken for the backend token. Header
 * names are case-insensitive over the wire, so a stray "Authorization" key
 * would survive a plain assignment to the lowercase key and win.
 */
export function buildBackendProxyHeaders(req, token) {
  const headers = { ...(req.headers || {}) };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  delete headers['accept-encoding'];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'authorization') delete headers[key];
  }
  headers.authorization = `Bearer ${token}`;
  return headers;
}

function buildBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const body = req.body;
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

// Preserves the path AND the query string: req.originalUrl carries both, and
// the backend's report endpoints are entirely driven by their query params.
export function backendTargetUrl(req, targetBase = backendProxyTarget()) {
  const incoming = String(req.originalUrl || req.url || '');
  const rewritten = incoming.startsWith(BACKEND_PROXY_PREFIX)
    ? incoming.slice(BACKEND_PROXY_PREFIX.length)
    : incoming;
  return `${targetBase}${rewritten.startsWith('/') ? rewritten : `/${rewritten}`}`;
}

export async function backendProxy(req, res, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const targetUrl = backendTargetUrl(req, deps.targetBase || backendProxyTarget());
  const body = buildBody(req);

  let upstream;
  try {
    // fetchWithBackendToken owns the 401 refresh-and-retry, so the request is
    // expressed once here and it decides whether to run it a second time.
    upstream = await fetchWithBackendToken(
      (token) =>
        fetchImpl(targetUrl, {
          method: req.method,
          headers: buildBackendProxyHeaders(req, token),
          body,
          signal: AbortSignal.timeout(deps.timeoutMs || backendProxyTimeoutMs()),
        }),
      { fetchImpl: deps.tokenFetchImpl || fetchImpl },
    );
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    // A token-exchange failure is a configuration problem, not a bad request,
    // and its message already names every shape tried. 503 distinguishes it
    // from the upstream being unreachable.
    const isTokenError = error?.name === 'BackendTokenError';
    const message = redactText(error instanceof Error ? error.message : String(error));
    console.error(`[backend proxy] ${req.method} ${req.originalUrl} FAILED: ${message}`);
    const status = isTokenError ? 503 : timedOut ? 504 : 502;
    return res.status(status).json({
      error: isTokenError ? 'backend_token_unavailable' : timedOut ? 'proxy_timeout' : 'proxy_error',
      target: backendProxyTarget(),
      message,
    });
  }

  // The upstream status and body go back untouched. A caller debugging a 400
  // from DealMatch/Run needs the backend's own words, not this proxy's
  // interpretation of them.
  res.status(upstream.status);
  upstream.headers?.forEach?.((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'transfer-encoding') return;
    if (lower === 'content-encoding') return;
    if (lower === 'content-length') return;
    if (lower === 'connection') return;
    res.setHeader(key, value);
  });
  const buffer = Buffer.from(await upstream.arrayBuffer());
  return res.send(buffer);
}
