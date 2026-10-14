import express from "express";
import { backendFetch } from "./reports/reportShared.js";

const router = express.Router();

function toYmd(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

/**
 * Thrown when the backend answered, but not with data.
 *
 * It carries the upstream status and NOTHING else. The status is enough to
 * tell "our Bearer was refused" from "the backend itself is unwell", and the
 * body of a 401 from this backend is an invalid_token document describing our
 * credential -- not something to copy into our own response or into a log.
 */
class UpstreamStatusError extends Error {
  constructor(status) {
    super(`ClientProfile upstream HTTP ${status}`);
    this.name = "UpstreamStatusError";
    this.status = status;
  }
}

/**
 * The one way this router reaches api.skylinkscapital.com.
 *
 * WHY IT GOES THROUGH backendFetch. This router is the SIXTH caller of that
 * backend and was the only one still calling it unauthenticated: every request
 * left here with nothing but an Accept header and came back 401 invalid_token,
 * which is the whole reason the Client Profiling tab showed an empty
 * leaderboard for every date range anyone picked. reports/reportShared.js owns
 * the token dance precisely because callers that each write their own drift
 * apart -- that file exists because the same arithmetic written twice made the
 * Deal Match tab and the weekly email disagree for weeks -- so this is the
 * sixth caller borrowing it rather than the seventh copy of it.
 *
 * WHY THERE IS NO LOCAL BASE URL ANY MORE. backendFetch resolves a relative
 * path against BACKEND_BASE_URL, so the CLIENT_PROFILE_BASE_URL constant that
 * used to live here is gone. That is not only tidiness: the local constant
 * preferred VITE_BACKEND_BASE_URL over BACKEND_API_BASE_URL, while the token
 * is minted against the opposite precedence in wallet/backendToken.js. An
 * install that set both variables to different hosts would have sent a token to
 * a host that never issued it, and got a 401 for a second, subtler reason.
 */
async function fetchUpstreamJson(path) {
  const response = await backendFetch(`/api/ClientProfile${path}`, {
    headers: { Accept: "application/json" },
  });

  // backendFetch resolves with the upstream Response whatever its status --
  // it deliberately does not throw on a 4xx/5xx -- so deciding that a non-2xx
  // is a failure is still this caller's job.
  if (!response.ok) throw new UpstreamStatusError(response.status);

  return response.json();
}

/**
 * Turns a failure into an HTTP status and one sentence for the screen.
 *
 * WHY NOT AN EMPTY 200. Both handlers below used to catch everything and
 * answer 200 with empty arrays (or, worse, a zeroed account object) plus a
 * `warning` field that ClientProfilingTab.tsx never rendered. A reader could
 * then not tell a dead backend from a quiet week, and the bug that was
 * reported -- "no results for any date range" -- was exactly that: a total
 * authentication failure wearing an empty result's clothes. The same rule
 * reportShared.js states for a figure applies to a list: a failure must never
 * become a zero, because a zero is indistinguishable from a real figure, and
 * an empty array is that same lie in a different shape. So an outage leaves
 * here as a non-2xx carrying a sentence that names what to check, and only a
 * genuinely quiet range leaves as a 200 with empty arrays.
 *
 * WHAT IS DELIBERATELY NOT IN HERE: the upstream body, and anything derived
 * from the credential. Forwarding the backend's own words about our token
 * would put them in a browser response and in an access log, and it tells the
 * reader nothing that "the credential was refused" does not already.
 */
function describeFailure(error) {
  // Our side, and no request was even attempted: backendToken.js could not
  // mint a Bearer. 503 rather than 502 because nothing upstream is broken --
  // this server is not configured to serve the tab yet.
  if (error?.name === "BackendTokenError") {
    return {
      status: 503,
      error:
        "Client profiling is unavailable: this server could not obtain an access token for the trading " +
        "backend, so no request was made. Check BACKEND_API_KEY and BACKEND_CLIENT_ID in the server .env " +
        "and restart.",
    };
  }

  // The backend answered, and what it said was "not you". Separated from the
  // other statuses because it is the one failure an operator fixes with a
  // credential rather than by waiting.
  if (error?.status === 401 || error?.status === 403) {
    return {
      status: 502,
      error:
        `Client profiling is unavailable: the trading backend rejected this server's access token (HTTP ${error.status}). ` +
        "The backend credential is missing, expired or revoked -- check BACKEND_API_KEY and BACKEND_CLIENT_ID " +
        "with the backend team. This is an authentication failure, not an empty result.",
    };
  }

  if (error?.status) {
    return {
      status: 502,
      error:
        `Client profiling is unavailable: the trading backend answered HTTP ${error.status}. ` +
        "This is an upstream failure, not an empty result -- retry, and if it persists it is a backend problem.",
    };
  }

  // No status at all, so we never got an answer. backendFetch's budget is an
  // AbortSignal.timeout(), which rejects as TimeoutError (AbortError on older
  // runtimes). Named separately for the reason SwapsReportTab pins: an
  // operator told "something went wrong" goes looking for a bug, while one
  // told the window was too wide narrows it.
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return {
      status: 504,
      error:
        "Client profiling timed out waiting for the trading backend. Try a narrower date range or a smaller " +
        "Top N; if every range times out, the backend is not answering.",
    };
  }

  return {
    status: 502,
    error:
      "Client profiling is unavailable: the trading backend could not be reached. This is a connection " +
      "failure, not an empty result.",
  };
}

// One place to answer a failure, so the two routes cannot drift into
// disagreeing about what an outage looks like. The log line carries the same
// sentence that goes to the browser and no more -- see describeFailure.
function respondFailure(res, label, error) {
  const failure = describeFailure(error);
  console.error(`[ClientProfile] ${label} failed: ${failure.error}`);
  res.status(failure.status).json({ error: failure.error });
}

/**
 * Both handlers are exported as well as mounted, for the reason
 * reports/reportScheduleRoute.js exports its own: a test reaches them with a
 * fake `res` instead of booting Express, because importing server.js starts a
 * real listener and a database pool as a side effect of module load. The
 * mounting below is what clientProfileRouter.test.js checks against
 * server.js's source.
 */
export async function topClientsHandler(req, res) {
  const fromDate = toYmd(req.query.from);
  const toDate = toYmd(req.query.to);
  const count = Math.max(1, Number(req.query.count || 10) || 10);

  try {
    const json = await fetchUpstreamJson(`/top-clients?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}&count=${encodeURIComponent(String(count))}`);
    res.json(json);
  } catch (error) {
    respondFailure(res, `top-clients ${fromDate}..${toDate}`, error);
  }
}

export async function clientDetailHandler(req, res) {
  // Rejected here rather than passed upstream as 0. The old handler coerced a
  // non-numeric login to 0, asked the backend about it, and on failure
  // answered 200 with `Client 0` and every figure zeroed -- which reads as a
  // real client holding no money. There is no login 0.
  const login = Number(req.params.login);
  if (!Number.isInteger(login) || login <= 0) {
    return res.status(400).json({ error: `"${String(req.params.login).slice(0, 32)}" is not a client login.` });
  }

  const days = Math.max(1, Number(req.query.days || 30) || 30);

  try {
    const json = await fetchUpstreamJson(`/${encodeURIComponent(String(login))}/detail?days=${encodeURIComponent(String(days))}`);
    res.json(json);
  } catch (error) {
    respondFailure(res, `${login}/detail last ${days}d`, error);
  }
}

router.get("/top-clients", topClientsHandler);
router.get("/:login/detail", clientDetailHandler);

export default router;
