/**
 * Mints a short-lived Bearer for the trading backend by exchanging
 * BACKEND_API_KEY + BACKEND_CLIENT_ID at api.skylinkscapital.com.
 *
 * THIS PROTOCOL IS DOCUMENTED BY THE BACKEND TEAM. It is not inferred, and it
 * is not the product of probing the live endpoint. An earlier version of this
 * file walked an ordered list of six guessed credential shapes plus a
 * direct-Bearer attempt, because the exchange had to be reverse engineered
 * from 400s and 500s; all seven failed. Everything below replaces that
 * guessing outright. Please do not re-add a guessed shape "just in case" -- a
 * shape that is not in their documentation is not a fallback, it is noise on a
 * gateway that counts rejected credentials, and it was what produced the
 * confusing 500 that hid the real problem for days.
 *
 * The documented exchange:
 *
 *   POST https://api.skylinkscapital.com/oauth/token
 *   Content-Type: application/x-www-form-urlencoded
 *
 *     grant_type=client_credentials
 *     client_id=<numeric client id>       (BACKEND_CLIENT_ID)
 *     client_secret=<the slc_live_... key> (BACKEND_API_KEY)
 *     scope=<optional>                     (BACKEND_API_SCOPE)
 *
 * Credentials may equivalently travel in an HTTP Basic header --
 * `Authorization: Basic base64("<client_id>:<client_secret>")` -- with
 * grant_type still in the form body. The backend team confirmed BOTH work.
 * There is no third mechanism: no X-Api-Key, no custom header.
 *
 * A 200 carries `{ access_token, token_type: "Bearer", expires_in, scope }`.
 * The access_token is opaque hex and lives ONE HOUR; it is what goes on data
 * requests as `Authorization: Bearer <access_token>`.
 *
 * The rule that shapes the rest of this file: THE API KEY MUST NEVER APPEAR ON
 * A DATA ENDPOINT. Sending the key itself as a Bearer to a data endpoint
 * always fails with 401 invalid_token, so it buys nothing, and it would put a
 * long-lived secret in front of endpoints (and their access logs) that should
 * only ever see an hour-long token.
 *
 * scope is omitted entirely when BACKEND_API_SCOPE is unset, because the
 * backend then grants the client's full set -- sending an empty or guessed
 * scope would narrow the grant rather than widen it.
 */

import { redactText, redactSecretValues, buildSecretList } from './redactSecrets.js';

/**
 * Refresh this far ahead of the stated expiry.
 *
 * Five minutes, and the number is driven by the slowest thing we do with a
 * token rather than by the token's length. A DealMatch/Run call costs ~40
 * seconds of wall clock whatever date range it is given, and the morning
 * report fires a run of them back to back; a token handed out with less than a
 * report's worth of life left expires mid-report, and the failure surfaces as
 * blank sections in an email nobody can re-send. Five minutes covers a whole
 * report run that started just under the wire. It costs almost nothing: on a
 * 3600-second token it still leaves 55 minutes of reuse, i.e. at most ~13
 * exchanges a day, against one cheap POST each.
 */
const REFRESH_SKEW_MS = 5 * 60_000;

// Used when a token response omits expires_in. The documented response always
// carries it, so this only fires if the backend changes; deliberately short,
// because guessing long and being wrong means every call 401s until the guess
// elapses, while guessing short only costs an extra exchange now and then.
const FALLBACK_LIFETIME_MS = 5 * 60_000;

const TOKEN_PATH = '/oauth/token';

/**
 * The two documented ways to present the same credential, in the order the
 * backend team presented them: the form body is their primary example, HTTP
 * Basic is their stated equivalent. The Basic attempt is a documented
 * alternative, NOT a guess -- it exists so that a gateway configured to read
 * only the Authorization header still works without an operator having to
 * redeploy. There is no third entry, and there must not be one.
 */
export const TOKEN_REQUEST_SHAPES = [
  {
    name: 'form body (client_id + client_secret)',
    build: (clientId, secret, scope) => ({
      form: {
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: secret,
        // Spread, not a null placeholder: URLSearchParams would serialise
        // `scope=undefined` as a literal string and narrow the grant.
        ...(scope ? { scope } : {}),
      },
      headers: {},
    }),
  },
  {
    name: 'HTTP Basic (client_id:client_secret)',
    build: (clientId, secret, scope) => ({
      form: {
        grant_type: 'client_credentials',
        ...(scope ? { scope } : {}),
      },
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`, 'utf8').toString('base64')}`,
      },
    }),
  },
];

// Module-level so the token and the working shape outlive a single request.
// Fetching per request would multiply every dashboard load (~27 backend calls)
// by an extra round trip and would hammer an endpoint that is rate limited on
// most gateways.
let cachedToken = null; // { token: string, expiresAt: number }
let rememberedShapeName = null;
let inFlight = null; // de-dupes a burst of concurrent callers into one exchange

/**
 * Test seam. Module state that survives between calls is the whole point of
 * this file, which also means a test asserting on a cold start has to be able
 * to get one. Nothing in production calls this.
 */
export function resetBackendTokenState() {
  cachedToken = null;
  rememberedShapeName = null;
  inFlight = null;
}

export function getRememberedShapeName() {
  return rememberedShapeName;
}

/**
 * Drops the cached token so the next getBackendToken() mints a fresh one.
 * Called when the backend rejects a token we believed was still valid --
 * revoked early, or the backend restarted and forgot it.
 */
export function invalidateBackendToken() {
  cachedToken = null;
}

function backendBaseUrl() {
  // Read at call time, not at import time, so a test (or a .env reload) can
  // change it without the module having to be re-imported.
  return String(
    process.env.BACKEND_API_BASE_URL ||
      process.env.VITE_BACKEND_BASE_URL ||
      'https://api.skylinkscapital.com',
  ).replace(/\/+$/, '');
}

// .trim() on all three: a .env edited on Windows leaves a trailing CR on the
// value, and a credential with an invisible \r is rejected with an error that
// says nothing about whitespace. The CRM token in server.js trims for the same
// reason.
function backendApiKey() {
  return String(process.env.BACKEND_API_KEY || '').trim();
}

function backendClientId() {
  return String(process.env.BACKEND_CLIENT_ID || '').trim();
}

function backendScope() {
  return String(process.env.BACKEND_API_SCOPE || '').trim();
}

// Redaction inputs for anything that might end up in a thrown message. The
// env-configured key comes from the shared list in redactSecrets.js; tokens
// are added explicitly because they are minted at runtime and so can never be
// in an env var. The client id is deliberately NOT redacted: it is an
// identifier rather than a secret, and seeing which client id was rejected is
// most of the diagnosis when the exchange fails.
function secretsFor(extra = []) {
  return [...buildSecretList(), backendApiKey(), cachedToken?.token, ...extra].filter(
    (v) => typeof v === 'string' && v.length > 0,
  );
}

// A response only counts as a success if it is 2xx AND actually carries a
// token. A gateway that answers 200 with an error document would otherwise be
// cached as a token and poison every later call.
function extractToken(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const token = payload.access_token ?? payload.token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

function lifetimeMsFrom(payload) {
  const seconds = Number(payload?.expires_in);
  if (!Number.isFinite(seconds) || seconds <= 0) return FALLBACK_LIFETIME_MS;
  const ms = seconds * 1000;
  // A token shorter than twice the skew would otherwise compute an expiry
  // already in the past, making every single call re-mint. Half of a short
  // lifetime still leaves room to make the request.
  return ms > REFRESH_SKEW_MS * 2 ? ms - REFRESH_SKEW_MS : ms / 2;
}

async function attemptShape(shape, clientId, key, fetchImpl) {
  const { form, headers } = shape.build(clientId, key, backendScope());
  const url = `${backendBaseUrl()}${TOKEN_PATH}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20_000),
  });

  const raw = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    // A non-JSON body is a failure, not a crash: it still has to be reported
    // back with its status so the backend team can see what was returned.
    payload = null;
  }

  if (!res.ok) return { ok: false, status: res.status, body: raw };
  const token = extractToken(payload);
  if (!token) return { ok: false, status: res.status, body: raw };
  return { ok: true, status: res.status, token, lifetimeMs: lifetimeMsFrom(payload) };
}

// Builds the one error the operator will actually be handed. It names the
// endpoint and both documented shapes with their status and body, because "the
// backend rejects us" is not something the backend team can act on, whereas
// "HTTP Basic -> 401 invalid_client" is.
function buildExhaustedError(attempts, secrets) {
  const lines = attempts.map(
    (a) =>
      `  - ${a.name}: ${a.status === null ? 'request failed' : `HTTP ${a.status}`} ${redactText(
        String(a.body ?? '').slice(0, 300),
        secrets,
      )}`,
  );
  const message =
    `Could not obtain a backend token from POST ${backendBaseUrl()}${TOKEN_PATH}. ` +
    `Both documented client_credentials shapes were rejected:\n${lines.join('\n')}\n` +
    'Check BACKEND_CLIENT_ID and BACKEND_API_KEY against what the backend team issued ' +
    '(the key is the client_secret, never a Bearer). The shapes above are the two they ' +
    'documented; do not add others.';
  const error = new Error(redactSecretValues(message, secrets));
  error.name = 'BackendTokenError';
  // Structured copy for programmatic callers, redacted to the same degree as
  // the message so neither path can leak.
  error.attempts = attempts.map((a) => ({
    shape: a.name,
    status: a.status,
    body: redactText(String(a.body ?? '').slice(0, 300), secrets),
  }));
  return error;
}

function configError(message) {
  const error = new Error(message);
  error.name = 'BackendTokenError';
  return error;
}

async function exchangeKeyForToken(fetchImpl) {
  const key = backendApiKey();
  if (!key) {
    throw configError(
      'BACKEND_API_KEY is not set, so the server cannot authenticate to ' +
        `${backendBaseUrl()}. Every backend call will fail with 401 invalid_token. ` +
        'Set BACKEND_API_KEY in the server .env and restart.',
    );
  }

  const clientId = backendClientId();
  if (!clientId) {
    // Fail here rather than attempting the exchange with the secret alone.
    // Sending client_secret with no client_id is exactly what produced the
    // opaque 500 ("Authenticated principal is missing required claims") that
    // sent us guessing in the first place, and a 500 tells the operator
    // nothing about which variable is missing.
    throw configError(
      'BACKEND_CLIENT_ID is not set, so the client_credentials exchange at ' +
        `${backendBaseUrl()}${TOKEN_PATH} cannot be attempted. The backend team issues a ` +
        'numeric client id alongside the BACKEND_API_KEY secret; both are required. ' +
        'Set BACKEND_CLIENT_ID in the server .env and restart.',
    );
  }

  // Once a shape has proven itself, later refreshes use only it. Re-trying the
  // form body on every refresh when this deployment answers only to Basic
  // would double the exchange traffic and log a rejected credential each time.
  const shapes = rememberedShapeName
    ? TOKEN_REQUEST_SHAPES.filter((s) => s.name === rememberedShapeName)
    : TOKEN_REQUEST_SHAPES;

  const attempts = [];
  for (const shape of shapes) {
    let result;
    try {
      result = await attemptShape(shape, clientId, key, fetchImpl);
    } catch (error) {
      // A transport failure on the form body must not abort before Basic is
      // tried: a proxy in front of the gateway can reject one and pass the
      // other.
      attempts.push({
        name: shape.name,
        status: null,
        body: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      continue;
    }
    if (result.ok) {
      rememberedShapeName = shape.name;
      cachedToken = { token: result.token, expiresAt: Date.now() + result.lifetimeMs };
      return cachedToken;
    }
    attempts.push({ name: shape.name, status: result.status, body: result.body });
  }

  // A remembered shape that stops working (key rotated, gateway reconfigured)
  // must not strand the process on a dead shape forever.
  if (rememberedShapeName) rememberedShapeName = null;
  throw buildExhaustedError(attempts, secretsFor());
}

/**
 * Returns a valid Bearer token, reusing the cached one until shortly before it
 * expires. Concurrent callers arriving while an exchange is in flight share
 * that one exchange rather than starting their own.
 */
export async function getBackendToken(options = {}) {
  const { token } = await getBackendTokenWithMeta(options);
  return token;
}

/**
 * As getBackendToken(), but also says whether the token came from the cache.
 * The proxy needs to know: retrying a 401 is only worth a round trip if the
 * token we used was one we had been holding. A token minted moments ago and
 * rejected immediately will be rejected again, so re-minting it just doubles
 * the failure latency.
 */
export async function getBackendTokenWithMeta({ fetchImpl } = {}) {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return { token: cachedToken.token, fromCache: true };
  }
  const impl = fetchImpl || globalThis.fetch;
  if (!inFlight) {
    inFlight = exchangeKeyForToken(impl).finally(() => {
      inFlight = null;
    });
  }
  const fresh = await inFlight;
  return { token: fresh.token, fromCache: false };
}

/**
 * Runs `doRequest(token)` against the backend and, if the backend rejects a
 * token we were holding in cache, discards it, mints one more, and retries the
 * request EXACTLY once. The retry's response is returned whatever its status,
 * so a backend that 401s persistently produces two calls and then stops --
 * there is no path here that can loop.
 */
export async function fetchWithBackendToken(doRequest, options = {}) {
  const { token, fromCache } = await getBackendTokenWithMeta(options);
  const response = await doRequest(token);
  if (response?.status !== 401 || !fromCache) return response;

  invalidateBackendToken();
  const { token: refreshed } = await getBackendTokenWithMeta(options);
  return doRequest(refreshed);
}
