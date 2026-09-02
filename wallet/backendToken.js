/**
 * Resolves a usable Bearer token for the trading backend from
 * BACKEND_API_KEY, either by using it directly or by exchanging it at
 * api.skylinkscapital.com.
 *
 * Why this exists: the trading backend was open until it wasn't. It now
 * answers every endpoint with 401 invalid_token, and the operator has put a
 * BACKEND_API_KEY in the server .env.
 *
 * What was established by probing the live /oauth/token endpoint (do not
 * re-derive):
 *   GET  /oauth/token                          -> 405, so it exists and is POST-only
 *   POST /oauth/token with a JSON body         -> 415, so it wants form encoding
 *   POST form, grant_type=client_credentials,
 *        every credential shape tried          -> 500 "Authenticated principal is
 *                                                missing required claims."
 *   POST form, grant_type=client_credentials,
 *        no credential at all                  -> the SAME 500, same message
 * Everything else probed (/connect/token, /api/token, /api/auth/token, /token,
 * /.well-known/openid-configuration) is a 404.
 *
 * The identical response with and without a credential is the key fact: the
 * endpoint is not reading whatever we send it, so /oauth/token is very likely
 * not our path at all -- it wants a caller that is already an authenticated
 * principal, which no client-credentials exchange we can construct will ever
 * produce. The likelier reading is that BACKEND_API_KEY already IS the
 * Bearer, with no exchange step. So that is tried first, but only adopted
 * after a real authenticated request confirms it -- an operator could still
 * be handed an /oauth/token-shaped key by mistake, and a key that merely gets
 * past validation without being checked would silently break every backend
 * call.
 *
 * If the direct-Bearer attempt is rejected, the code falls back to the
 * six-shape /oauth/token exchange walk. The parameter name for that exchange
 * could not be settled by probing, because the key lives only in the server
 * .env and is not readable from a developer machine, so it tries an ordered
 * list of standard shapes, and the shape that works is remembered for the
 * life of the process -- later refreshes go straight to it instead of
 * re-probing.
 */

import { redactText, redactSecretValues, buildSecretList } from './redactSecrets.js';

// Refresh this far before the stated expiry. A token that expires mid-flight
// on a DealMatch/Run call costs ~40s of wall clock to discover; renewing a
// minute early costs one cheap POST.
const REFRESH_SKEW_MS = 60_000;

// Used when the token response omits expires_in. Deliberately short: guessing
// long and being wrong means every call 401s until the guess elapses, while
// guessing short only costs an extra token exchange every few minutes.
const FALLBACK_LIFETIME_MS = 5 * 60_000;

const TOKEN_PATH = '/oauth/token';

// Cheap, already-authenticated endpoint used to validate the direct-Bearer
// candidate before it is adopted: small, requires real auth to return 2xx
// (so passing it is actual evidence, not a fluke), and already used
// elsewhere in this codebase (reports/summaryCore.js), so it is known-good
// against the live backend.
const VALIDATION_PATH = '/Metrics/dashboard';

/**
 * The shapes to try, in order, on the first exchange.
 *
 * The direct-Bearer candidate goes first: the token endpoint's identical
 * response with and without a credential (see file header) means it is very
 * likely not our path, and BACKEND_API_KEY is very likely the Bearer itself.
 * It is a different kind of attempt from the rest -- no exchange, just a
 * validation GET -- so it is marked `kind: 'direct-bearer'` and handled by a
 * separate branch in attemptCandidate() rather than a `build()`.
 *
 * The remaining six are ordered by how likely each is to be what an OAuth2
 * client_credentials server with a single opaque key expects, for use if the
 * direct-Bearer attempt is rejected. `form` is always x-www-form-urlencoded
 * because the JSON probe came back 415.
 */
export const TOKEN_REQUEST_CANDIDATES = [
  {
    // Not an exchange: BACKEND_API_KEY is sent as-is as the Bearer against a
    // real endpoint, and only adopted if that comes back 2xx. A 401/403 means
    // the key is not a Bearer, and the walk falls through to the exchange
    // shapes below exactly as it would have without this candidate.
    name: 'direct Bearer (BACKEND_API_KEY as-is)',
    kind: 'direct-bearer',
  },
  {
    // Most .NET/IdentityServer-style deployments want both halves of a client
    // credential; with one opaque key the same value is usually issued as both.
    name: 'form client_secret+client_id',
    build: (key) => ({
      form: { grant_type: 'client_credentials', client_secret: key, client_id: key },
      headers: {},
    }),
  },
  {
    name: 'form client_secret',
    build: (key) => ({
      form: { grant_type: 'client_credentials', client_secret: key },
      headers: {},
    }),
  },
  {
    name: 'form api_key',
    build: (key) => ({
      form: { grant_type: 'client_credentials', api_key: key },
      headers: {},
    }),
  },
  {
    name: 'header X-Api-Key',
    build: (key) => ({
      form: { grant_type: 'client_credentials' },
      headers: { 'X-Api-Key': key },
    }),
  },
  {
    // The key presented as if it were already a Bearer. Some gateways accept
    // this even though the key is not the token they hand back.
    name: 'header Authorization Bearer',
    build: (key) => ({
      form: { grant_type: 'client_credentials' },
      headers: { Authorization: `Bearer ${key}` },
    }),
  },
  {
    name: 'form grant_type=api_key',
    build: (key) => ({
      form: { grant_type: 'api_key', api_key: key },
      headers: {},
    }),
  },
];

// Module-level so the token and the discovered shape outlive a single request.
// Fetching per request would multiply every dashboard load (~27 backend calls)
// by an extra round trip and would hammer an endpoint that is rate limited on
// most gateways.
let cachedToken = null; // { token: string, expiresAt: number }
let rememberedCandidateName = null;
let inFlight = null; // de-dupes a burst of concurrent callers into one exchange

/**
 * Test seam. Module state that survives between calls is the whole point of
 * this file, which also means a test asserting on a cold start has to be able
 * to get one. Nothing in production calls this.
 */
export function resetBackendTokenState() {
  cachedToken = null;
  rememberedCandidateName = null;
  inFlight = null;
}

export function getRememberedCandidateName() {
  return rememberedCandidateName;
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

function backendApiKey() {
  // .trim(): a .env edited on Windows leaves a trailing CR on the value, and a
  // credential with an invisible \r is rejected with an error that says nothing
  // about whitespace. The CRM token above it in server.js trims for this reason.
  return String(process.env.BACKEND_API_KEY || '').trim();
}

// Redaction inputs for anything that might end up in a thrown message. The
// env-configured key comes from the shared list in redactSecrets.js; tokens
// are added explicitly because they are minted at runtime and so can never be
// in an env var.
function secretsFor(extra = []) {
  return [...buildSecretList(), backendApiKey(), cachedToken?.token, ...extra].filter(
    (v) => typeof v === 'string' && v.length > 0,
  );
}

// A shape only counts as working if the response is 2xx AND actually carries a
// token. A gateway that answers 200 with an error document would otherwise be
// remembered as the winner and poison every later call.
function extractToken(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const token = payload.access_token ?? payload.token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

function lifetimeMsFrom(payload) {
  const seconds = Number(payload?.expires_in);
  if (!Number.isFinite(seconds) || seconds <= 0) return FALLBACK_LIFETIME_MS;
  const ms = seconds * 1000;
  // A very short-lived token (skew >= lifetime) would otherwise compute an
  // expiry already in the past, making every single call re-mint. Half of a
  // short lifetime still leaves room to make the request.
  return ms > REFRESH_SKEW_MS * 2 ? ms - REFRESH_SKEW_MS : ms / 2;
}

// Validates the direct-Bearer candidate with one GET against a real,
// already-authenticated endpoint. This is not an exchange -- there is no
// response payload to pull a token out of, because the token being tested
// IS the key. A 2xx is the only thing that counts as proof: it means the
// backend actually accepted this value as a Bearer, not merely that the
// endpoint didn't complain about the shape of the request.
async function attemptDirectBearer(key, fetchImpl) {
  const url = `${backendBaseUrl()}${VALIDATION_PATH}`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await res.text();
  if (!res.ok) return { ok: false, status: res.status, body: raw };
  // No expires_in exists for this path -- the key either works or it
  // doesn't -- so it is treated as long-lived (Infinity) rather than given a
  // guessed lifetime. It still goes through the normal invalidate-on-401
  // path in fetchWithBackendToken, which re-validates (once) rather than
  // trusting a key forever once the backend actually rejects it.
  return { ok: true, status: res.status, token: key, lifetimeMs: Infinity, field: 'direct' };
}

async function attemptCandidate(candidate, key, fetchImpl) {
  if (candidate.kind === 'direct-bearer') return attemptDirectBearer(key, fetchImpl);
  const { form, headers } = candidate.build(key);
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
  return { ok: true, status: res.status, token, lifetimeMs: lifetimeMsFrom(payload), field: payload.access_token ? 'access_token' : 'token' };
}

// Builds the one error the operator will actually be handed. It names the
// endpoint and every shape tried with its status and body, because "the
// backend rejects us" is not something the backend team can act on, whereas
// "client_secret+client_id -> 400 unsupported_grant_type" is.
function buildExhaustedError(attempts, secrets) {
  const lines = attempts.map(
    (a) =>
      `  - ${a.name}: ${a.status === null ? 'request failed' : `HTTP ${a.status}`} ${redactText(
        String(a.body ?? '').slice(0, 300),
        secrets,
      )}`,
  );
  const message =
    `Could not obtain a backend token. Tried BACKEND_API_KEY directly against ` +
    `GET ${backendBaseUrl()}${VALIDATION_PATH} and every exchange shape at ` +
    `POST ${backendBaseUrl()}${TOKEN_PATH}. All ${attempts.length} attempts were rejected:\n${lines.join('\n')}\n` +
    'The parameter name for BACKEND_API_KEY is a guess -- ask the backend team which ' +
    'of these the token endpoint expects, or for the exact form of a working request.';
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

async function exchangeKeyForToken(fetchImpl) {
  const key = backendApiKey();
  if (!key) {
    const error = new Error(
      'BACKEND_API_KEY is not set, so the server cannot authenticate to ' +
        `${backendBaseUrl()}. Every backend call will fail with 401 invalid_token. ` +
        'Set BACKEND_API_KEY in the server .env and restart.',
    );
    error.name = 'BackendTokenError';
    throw error;
  }

  // Once a shape has proven itself, later refreshes use only it. Re-walking
  // the list every time would send up to five pointless requests -- and some
  // gateways count a rejected credential toward a lockout.
  const candidates = rememberedCandidateName
    ? TOKEN_REQUEST_CANDIDATES.filter((c) => c.name === rememberedCandidateName)
    : TOKEN_REQUEST_CANDIDATES;

  const attempts = [];
  for (const candidate of candidates) {
    let result;
    try {
      result = await attemptCandidate(candidate, key, fetchImpl);
    } catch (error) {
      // A transport failure on one shape must not abort the walk: the next
      // shape may well be the one that works.
      attempts.push({
        name: candidate.name,
        status: null,
        body: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      continue;
    }
    if (result.ok) {
      rememberedCandidateName = candidate.name;
      cachedToken = { token: result.token, expiresAt: Date.now() + result.lifetimeMs };
      return cachedToken;
    }
    attempts.push({ name: candidate.name, status: result.status, body: result.body });
  }

  // A remembered shape that stops working (key rotated, endpoint changed) must
  // not strand the process on a dead shape forever.
  if (rememberedCandidateName) rememberedCandidateName = null;
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
