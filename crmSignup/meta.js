import { createHash } from "crypto";

export const GRAPH_HOST = "https://graph.facebook.com";

/** One Meta event per funnel stage. One owner per stage: the website pixel no
 *  longer fires conversions, so nothing here can double-count. */
export const META_EVENT_NAMES = {
  lead: "Lead",
  registered: "CompleteRegistration",
  verified: "Client_Verified",
  live_account: "TradingAccountOpened",
  first_deposit: "Purchase",
};

/** Meta requires exactly these three values on a CRM event. */
const ACTION_SOURCE = "system_generated";
const EVENT_SOURCE = "crm";
const LEAD_EVENT_SOURCE = "FXBackOffice";

// Transient Graph API conditions. Meta returns these with an unreliable
// HTTP status -- commonly 400 -- so the code is what decides, not the status.
//   1   unknown/transient, Meta's guidance is to retry
//   2   service temporarily unavailable
//   4   application-level rate limit
//   17  user-level rate limit
//   32  page-level rate limit
//   341 application limit reached, documented as temporary and retryable
//   613 custom-level rate limit
// 368 (temporary policy block) is left out: it will not clear on a retry.
const TRANSIENT_GRAPH_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Meta hashes the NORMALISED value on its side, so we must normalise before
 * hashing or the digests can never meet. Empty in, empty out -- sha256("") is
 * a perfectly valid digest that would be sent as though it were an address.
 */
export function hashEmail(email) {
  const v = String(email ?? "").trim().toLowerCase();
  return v ? sha256(v) : "";
}

export function hashPhone(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits ? sha256(digits) : "";
}

export function buildMetaPayload({ stage, email, phone, fbc, eventTimeSeconds, eventId, testEventCode }) {
  const user_data = {};

  const em = hashEmail(email);
  if (em) user_data.em = [em];

  const ph = hashPhone(phone);
  if (ph) user_data.ph = [ph];

  // Passed through verbatim: it was frozen at this client's first event, and
  // recomputing it per stage hands Meta a different click identity each time.
  const click = String(fbc ?? "").trim();
  if (click) user_data.fbc = click;

  // The two CRM constants and nothing else. A deposit reports that it
  // happened, not what it was worth (decided 2026-10-13).
  const custom_data = {
    event_source: EVENT_SOURCE,
    lead_event_source: LEAD_EVENT_SOURCE,
  };

  const event = {
    action_source: ACTION_SOURCE,
    custom_data,
    event_name: META_EVENT_NAMES[stage],
    event_time: Number(eventTimeSeconds),
    user_data,
  };

  // Meta dedupes on event_id plus event_name. The caller derives it from the
  // client and stage, so a retry of the same funnel event carries the same id.
  const id = String(eventId ?? "").trim();
  if (id) event.event_id = id;

  const payload = { data: [event] };

  const code = String(testEventCode ?? "").trim();
  if (code) payload.test_event_code = code;

  return payload;
}

export function classifyMetaOutcome({ transportError, httpStatus: rawStatus, body } = {}) {
  if (transportError) {
    return {
      status: "failed",
      retryable: true,
      detail: `transport: ${String(transportError?.message || transportError).slice(0, 200)}`,
    };
  }

  const httpStatus = Number(rawStatus) || 0;
  const reason = String(body?.error?.message ?? "").slice(0, 200);
  const detail = reason ? `http ${httpStatus} ${reason}` : `http ${httpStatus}`;

  // The Graph code decides, whatever status carries it: Meta throttles with a 400.
  if (TRANSIENT_GRAPH_CODES.has(Number(body?.error?.code))) {
    return { status: "failed", retryable: true, detail };
  }

  if (httpStatus === 429 || httpStatus >= 500) {
    return { status: "failed", retryable: true, detail };
  }

  if (httpStatus >= 200 && httpStatus < 300) {
    // Meta's success body always carries the count. Without one, a proxy answered
    // instead of Meta: the outcome is unknown, and event_id makes a retry safe.
    // An explicit zero is Meta saying so, and a retry would hear the same thing.
    const received = Number(body?.events_received);
    if (received >= 1) {
      return { status: "sent", retryable: false, detail: `http ${httpStatus}` };
    }
    const noCount = body?.events_received == null || Number.isNaN(received);
    const reported = noCount ? "no events_received" : `events_received=${received}`;
    return { status: "failed", retryable: noCount, detail: `http ${httpStatus} ${reported}` };
  }

  return { status: "failed", retryable: false, detail };
}

/** Never throws, and never puts the access token in its result. */
export async function sendMetaEvent({
  fetchImpl = fetch,
  datasetId,
  apiVersion = "v26.0",
  accessToken,
  payload,
}) {
  const url = `${GRAPH_HOST}/${apiVersion}/${datasetId}/events?access_token=${encodeURIComponent(
    String(accessToken ?? "")
  )}`;

  // A fetch error may echo the request URL, which carries the token in raw and
  // encoded form. Neither may reach the detail, because the detail is logged.
  const token = String(accessToken ?? "");
  // Encoded before raw: a token containing % has a raw form that sits inside its
  // encoded form (%25 inside %2525), so the raw pass must never run first.
  const secrets = [encodeURIComponent(token), token].filter(Boolean);

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (transportError) {
    let message = String(transportError?.message || transportError);
    // Structural first: whatever follows access_token= is the token, in whatever
    // form the URL class re-serialised it. The literals then catch a bare quoted value.
    message = message.replace(/access_token=[^&\s]*/gi, "access_token=[redacted]");
    for (const secret of secrets) message = message.split(secret).join("[redacted]");
    return classifyMetaOutcome({ transportError: { message } });
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return classifyMetaOutcome({ httpStatus: response?.status, body });
}
