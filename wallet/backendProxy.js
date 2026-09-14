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

import express from 'express';

import { fetchWithBackendToken } from './backendToken.js';
import { redactText } from './redactSecrets.js';

export const BACKEND_PROXY_PREFIX = '/api/backend';

// The media types the GLOBAL parsers in server.js already own: express.json()
// claims application/json and express.urlencoded() claims
// application/x-www-form-urlencoded, both mounted above every route.
//
// This set is the whole reason the raw capture below cannot regress the JSON
// path. The raw parser is given an explicit predicate rather than a catch-all,
// so for a JSON request it never runs at all: express.json() has already parsed
// the stream and set req.body to the object, and express.raw() declines the
// request on the content type alone, leaving that object exactly as it was.
// A catch-all raw parser would instead depend on body-parser noticing the
// stream was already drained -- true today, but an internal detail, and a
// silently-emptied req.body on every JSON POST is precisely the class of
// failure this whole change exists to prevent.
const EXPRESS_PARSED_MEDIA_TYPES = new Set([
  'application/json',
  'application/x-www-form-urlencoded',
]);

// 25mb, deliberately above the 1mb the JSON/urlencoded parsers cap at.
//
// The 1mb cap is right for a JSON payload and wrong for this route: the LP
// Statements page uploads broker PDF statements, and a monthly statement from a
// prime broker routinely runs to tens of megabytes. 25mb is a compromise: high
// enough that a real statement is not refused, low enough that a handful of
// concurrent uploads cannot exhaust this process -- the body is buffered in
// memory before forwarding, and this box also serves the whole dashboard.
//
// Whatever the number is, exceeding it must be a LOUD 413 naming the limit, not
// a truncated upload. A half-read multipart body is not a smaller statement; it
// is a corrupt one, and importing it would write partial deal rows.
export const BACKEND_PROXY_RAW_BODY_LIMIT = '25mb';

/**
 * Whether the proxy should capture this request's bytes verbatim.
 *
 * True for any content type the global parsers do not own -- multipart/form-data
 * above all, but also application/pdf, text/csv or anything else the backend
 * grows an endpoint for later. False for JSON and urlencoded, which already
 * arrived parsed.
 */
export function backendProxyWantsRawBody(req) {
  const header = String(req?.headers?.['content-type'] || '');
  if (!header) return false;
  const mediaType = header.split(';')[0].trim().toLowerCase();
  if (!mediaType) return false;
  return !EXPRESS_PARSED_MEDIA_TYPES.has(mediaType);
}

/**
 * Middleware for the /api/backend mount that leaves an unparseable body intact.
 *
 * THE SILENT FAILURE THIS PREVENTS. server.js mounts only express.json() and
 * express.urlencoded(). Neither claims multipart/form-data, so before this
 * existed a file upload arrived at the proxy with req.body unset, buildBody()
 * returned undefined, and the proxy forwarded a perfectly valid request
 * carrying no file at all. The backend answered 200, the page said the import
 * succeeded, and nothing was imported. No error anywhere -- which is why this
 * is a parser problem and not something a retry or a bigger timeout would fix.
 *
 * WHY RAW AND NOT A MULTIPART PARSER. A multipart body is only meaningful
 * together with the boundary token in its own Content-Type header, and the
 * parts are byte-exact -- this is a PDF. Parsing it here and re-encoding it
 * would mint a new boundary and re-serialise binary content through our code
 * for no gain: the proxy has no interest in the fields, only the backend does.
 * So the bytes go through untouched and the caller's Content-Type goes with
 * them, boundary parameter and all (buildBackendProxyHeaders copies it
 * verbatim; it drops content-length so fetch recomputes it from the buffer).
 */
export function backendRawBodyParser(options = {}) {
  const limit = options.limit || BACKEND_PROXY_RAW_BODY_LIMIT;
  const parser = express.raw({ type: backendProxyWantsRawBody, limit });

  return function captureBackendRawBody(req, res, next) {
    parser(req, res, (error) => {
      if (!error) return next();
      // Answer this one ourselves rather than handing it to Express's default
      // error handler, which renders an HTML stack page a fetch() caller cannot
      // read and which never names the number that has to change.
      if (error.type === 'entity.too.large' || error.status === 413) {
        console.error(
          `[backend proxy] ${req.method} ${req.originalUrl} REFUSED: body exceeds ${limit}`,
        );
        return res.status(413).json({
          error: 'payload_too_large',
          limit,
          message:
            `Request body exceeds the ${limit} limit for ${BACKEND_PROXY_PREFIX}. ` +
            'Nothing was forwarded to the backend.',
        });
      }
      return next(error);
    });
  };
}

export function backendProxyTarget() {
  return String(
    process.env.BACKEND_API_BASE_URL ||
      process.env.VITE_BACKEND_BASE_URL ||
      'https://api.skylinkscapital.com',
  ).replace(/\/+$/, '');
}

// The budget for everything that is not in the slow-route table below.
//
// Deliberately short. Nearly every backend endpoint answers in well under a
// second, and a long GLOBAL budget is not free: a hung backend would hold this
// process's sockets and worker capacity for minutes per request, so a single
// sick upstream could starve the whole dashboard. Same env var and same default
// as the CRM proxy in server.js, so one setting moves both.
export function backendProxyTimeoutMs() {
  return Number(process.env.PROXY_TIMEOUT_MS || 45_000);
}

// The budget for the endpoints that are genuinely slow.
//
// This is the same 180s the report layer already proved these endpoints need --
// see VOLUME_RUN_TIMEOUT_MS in reports/volumeSection.js and
// DEALMATCH_RUN_TIMEOUT_MS in reports/dealMatchWeeklyReport.js, both carrying
// the measurement: DealMatch/Run costs ~40s whatever window it is asked for
// (41.8s for one day, 40.4s for a month, measured 2026-08-31), because the cost
// is in starting the match, not in the deals matched. Under the old single
// global budget that left under four seconds of headroom.
//
// /api/SwapsReport is worse and is the reason this table exists at all: measured
// live against production on 2026-09-14, a request for a SINGLE DAY died at 45.3s
// -- our own proxy limit, not the backend's -- with
// {"error":"proxy_timeout","message":"The operation was aborted due to timeout"}.
// The Swaps Report tab could not load at all. It was not even deployed when that
// tab was built (see src/lib/swapsReportApi.ts), so there is no older, faster
// baseline to appeal to. It gets the same 180s rather than a bespoke number:
// nothing has yet measured where SwapsReport actually settles, and inventing a
// third figure would imply a precision we do not have.
//
// WHAT ELSE CAN CUT A REQUEST SHORT, checked 2026-09-14, because a 180s budget
// in Node buys nothing if something downstream gives up first:
//   - Node itself is fine. server.requestTimeout is 300s and fetch()'s undici
//     headers/body timeouts are 300s, both above 180s. No agent is configured
//     here, so those defaults are what a forwarded call actually gets.
//   - IIS/iisnode is the open question. web.config registers the iisnode handler
//     but carries NO <iisnode> settings element and there is no iisnode.yml, so
//     every iisnode default applies unreviewed, and IIS's own webLimits
//     connectionTimeout defaults to 120s. Neither has been measured against a
//     180s response on this box. If a deployed SwapsReport call still dies --
//     particularly at ~2 minutes rather than at 180s -- the limit is there and
//     not here, and the fix is iisnode/IIS configuration, not this number.
export const LONG_BACKEND_ROUTE_TIMEOUT_MS = 180_000;

// Path -> budget. Keys are the path the proxy is ABOUT TO FORWARD (the incoming
// URL with the /api/backend mount prefix already stripped), lowercased, with the
// query string and any trailing slash removed. They are written lowercase here
// because the lookup lowercases the incoming path: the backend routes are
// ASP.NET and case-insensitive, so /api/swapsreport and /api/SwapsReport are the
// same endpoint and must get the same budget.
//
// The lookup is an EXACT match on that path, never a prefix or substring test.
// A substring match would quietly hand a 180s budget to any future endpoint
// whose name happens to start with one of these -- /api/SwapsReportSomethingElse
// is a different endpoint with unknown cost, and it gets the 45s default.
const LONG_BACKEND_ROUTES = new Map([
  ['/api/swapsreport', LONG_BACKEND_ROUTE_TIMEOUT_MS],
  ['/dealmatch/run', LONG_BACKEND_ROUTE_TIMEOUT_MS],
]);

/**
 * The forward path used for the timeout lookup and named in the timeout error:
 * mount prefix stripped, query string and fragment dropped, no trailing slash.
 *
 * The query string must go before matching, because these endpoints are entirely
 * driven by their query params -- "/api/SwapsReport?from=...&to=..." is the only
 * shape this route is ever called in, and a table keyed on the raw URL would
 * match nothing.
 */
export function backendForwardPath(req) {
  const incoming = String(req?.originalUrl || req?.url || '');
  const rewritten = incoming.startsWith(BACKEND_PROXY_PREFIX)
    ? incoming.slice(BACKEND_PROXY_PREFIX.length)
    : incoming;
  const withSlash = rewritten.startsWith('/') ? rewritten : `/${rewritten}`;
  const pathOnly = withSlash.split('?')[0].split('#')[0];
  return pathOnly.length > 1 ? pathOnly.replace(/\/+$/, '') || '/' : pathOnly;
}

/**
 * The budget for one request.
 *
 * WHICH SETTING WINS, and why: for a listed slow route the table value is a
 * FLOOR, not a fixed number -- the route gets whichever of (table budget,
 * PROXY_TIMEOUT_MS) is larger. So PROXY_TIMEOUT_MS still does exactly what it
 * always did for every other endpoint, and an operator who raises it to debug a
 * sluggish upstream raises these routes too. What it cannot do is LOWER them:
 * the 45s default is below the measured cost of these endpoints, so letting the
 * global knob cut them back would silently reintroduce the exact 504 this table
 * exists to fix, in a deployment where nobody touched these routes at all.
 */
export function backendRouteTimeoutMs(req, defaultMs = backendProxyTimeoutMs()) {
  const listed = LONG_BACKEND_ROUTES.get(backendForwardPath(req).toLowerCase());
  return listed === undefined ? defaultMs : Math.max(listed, defaultMs);
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
  // A Buffer is what backendRawBodyParser() leaves behind: the request bytes
  // exactly as they arrived. It is forwarded as-is and must be checked BEFORE
  // the JSON branch below -- JSON.stringify() on a Buffer yields
  // {"type":"Buffer","data":[...]}, which is what a re-encoded file upload
  // looks like on the wire and why it imported nothing.
  //
  // An empty buffer forwards no body at all rather than a zero-length one, so a
  // bodyless request looks identical to the backend whether or not this parser
  // happened to run.
  if (Buffer.isBuffer(body)) return body.length ? body : undefined;
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
  const forwardPath = backendForwardPath(req);
  // deps.timeoutMs stays an unconditional override for tests; production goes
  // through the per-route table.
  const timeoutMs = deps.timeoutMs || backendRouteTimeoutMs(req);

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
          signal: AbortSignal.timeout(timeoutMs),
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
    // A bare "The operation was aborted due to timeout" is what this endpoint
    // returned on 2026-09-14 and it is not actionable: it does not say which
    // budget ran out, so the reader cannot tell whether the backend is slow or
    // whether THIS proxy gave up early, and cannot find the number to change.
    // Naming the route and the budget makes the next 504 a one-line diagnosis.
    const detail = timedOut ? `proxy_timeout after ${timeoutMs}ms for ${forwardPath}: ${message}` : message;
    console.error(`[backend proxy] ${req.method} ${req.originalUrl} FAILED: ${detail}`);
    const status = isTokenError ? 503 : timedOut ? 504 : 502;
    return res.status(status).json({
      error: isTokenError ? 'backend_token_unavailable' : timedOut ? 'proxy_timeout' : 'proxy_error',
      target: backendProxyTarget(),
      ...(timedOut ? { route: forwardPath, timeoutMs } : {}),
      message: detail,
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
