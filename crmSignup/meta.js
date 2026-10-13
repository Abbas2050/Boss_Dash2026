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

export function buildMetaPayload({ stage, email, phone, fbc, eventTimeSeconds, testEventCode }) {
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

  const payload = {
    data: [
      {
        action_source: ACTION_SOURCE,
        custom_data,
        event_name: META_EVENT_NAMES[stage],
        event_time: Number(eventTimeSeconds),
        user_data,
      },
    ],
  };

  const code = String(testEventCode ?? "").trim();
  if (code) payload.test_event_code = code;

  return payload;
}

export function classifyMetaOutcome({ transportError, httpStatus, body } = {}) {
  if (transportError) {
    return {
      status: "failed",
      retryable: true,
      detail: `transport: ${String(transportError?.message || transportError).slice(0, 200)}`,
    };
  }

  const code = Number(httpStatus) || 0;

  if (code === 429 || code >= 500) {
    return { status: "failed", retryable: true, detail: `http ${code}` };
  }

  if (code >= 200 && code < 300) {
    // A 200 that reports nothing received is not a success.
    const received = Number(body?.events_received);
    if (Number.isFinite(received) && received < 1) {
      return { status: "failed", retryable: false, detail: "http 200 events_received=0" };
    }
    return { status: "sent", retryable: false, detail: `http ${code}` };
  }

  const reason = String(body?.error?.message ?? "").slice(0, 200);
  return {
    status: "failed",
    retryable: false,
    detail: reason ? `http ${code} ${reason}` : `http ${code}`,
  };
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

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (transportError) {
    return classifyMetaOutcome({ transportError });
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return classifyMetaOutcome({ httpStatus: response?.status, body });
}
