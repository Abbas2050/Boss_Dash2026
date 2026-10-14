import { PHONE_RE } from "./normalise.js";
import { sendTimeoutSignal } from "./sendTimeout.js";
import { isTransientHttpStatus } from "./transientHttp.js";

export const DOUBLETICK_TEMPLATE_URL = "https://public.doubletick.io/whatsapp/message/template";

/** A 2xx from DoubleTick means the REQUEST was accepted. These are the
 *  messages[0].status values that mean the MESSAGE was not. */
export const WHATSAPP_FAILURE_STATUSES = [
  "FAILED",
  "ERROR",
  "REJECTED",
  "UNDELIVERED",
  "UNDELIVERABLE",
  "INVALID",
];

const FAILURE_SET = new Set(WHATSAPP_FAILURE_STATUSES);

/** The messages[0].status values that mean the MESSAGE was accepted for sending.
 *  Two, because DoubleTick changed the value and the API reference never recorded
 *  it: SENT is the historical value, which the reference still documents, and
 *  ENQUEUED is the current one, per DoubleTick's help article on the template-send
 *  response. We do not know which this account's plan returns, so both are kept.
 *  Nothing else is: an unlisted status is rejected loudly, with its value in the
 *  detail, rather than assumed to be a send. */
const SENT_STATUSES = ["SENT", "ENQUEUED"];
const SENT_SET = new Set(SENT_STATUSES);

export function parseSkipSources(raw) {
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Whether to send at all, and why not. Configuration first: an unset key is
 * our problem and should not be reported as a fact about the client.
 *
 * **The record type is not asked about, and takes no parameter (2026-10-14,
 * user's call).** A lead gets the same template as a client. The link in its
 * body and its button is `https://skylinkscapital.com/en/login/`, so for a lead
 * it leads to a page they have no account for; the user was told that and chose
 * to send anyway. There is no second template and no configuration for one --
 * the template is approved by Meta as it stands, and a second one would need its
 * own approval before it could carry anything different.
 *
 * So nothing here reads `record_type`. The phone format and SKIP_SOURCES are the
 * only remaining facts about the client, and they apply to a lead exactly as
 * they do to a client: a lead with no usable phone is still `invalid phone
 * number`, not a send.
 */
export function decideWhatsappSkip({ stage, apiKey, source, phone, skipSources }) {
  if (!String(apiKey ?? "").trim()) return { reason: "whatsapp not configured" };
  if (stage !== "registered") return { reason: "stage not applicable" };
  const sources = skipSources instanceof Set ? skipSources : parseSkipSources(skipSources);
  if (sources.has(String(source ?? "").trim().toLowerCase())) return { reason: "source excluded" };
  if (!PHONE_RE.test(String(phone ?? ""))) return { reason: "invalid phone number" };
  return null;
}

/** `from` and `messageId` sit beside `content` inside the message, not at the
 *  top level, and omitting either is enough on its own for a rejection. */
export function buildWhatsappPayload({
  templateName,
  language,
  firstName,
  bodyParam,
  buttonUrl,
  from,
  to,
  messageId,
}) {
  return {
    messages: [
      {
        content: {
          templateName,
          language,
          templateData: {
            header: { type: "TEXT", placeholder: String(firstName ?? "") },
            body: { placeholders: [bodyParam] },
            buttons: [{ type: "URL", parameter: buttonUrl }],
          },
        },
        from,
        to,
        messageId,
      },
    ],
  };
}

export function classifyWhatsappOutcome({ transportError, httpStatus, body, bodyTimedOut } = {}) {
  if (transportError) {
    return {
      status: "failed",
      retryable: true,
      detail: `transport: ${String(transportError?.message || transportError).slice(0, 200)}`,
      messageId: null,
    };
  }

  const code = Number(httpStatus) || 0;

  // The rule all three senders share, written once in transientHttp.js.
  if (isTransientHttpStatus(code)) {
    return { status: "failed", retryable: true, detail: `http ${code}`, messageId: null };
  }

  if (code < 200 || code >= 300) {
    // A bad key, an unapproved template, a malformed body: identical on retry.
    return { status: "rejected", retryable: false, detail: `http ${code}`, messageId: null };
  }

  const message = Array.isArray(body?.messages) ? body.messages[0] : null;
  const rawStatus = message?.status;

  // Only a string can be matched. Coercing anything else would let ["SENT"] pass as SENT.
  if (rawStatus !== undefined && rawStatus !== null && typeof rawStatus !== "string") {
    return {
      status: "rejected",
      retryable: false,
      detail: `unrecognised status: ${JSON.stringify(rawStatus)}`,
      messageId: message?.messageId ?? null,
    };
  }

  const status = String(rawStatus ?? "").trim();

  if (!status) {
    return {
      status: "failed",
      retryable: false,
      // Never retried either way: a 2xx means the message may have gone out. But
      // the timeout signal bounds the body read too, and a row that fails here
      // should say the body timed out rather than blame a field DoubleTick omitted.
      detail: bodyTimedOut ? "body timed out in a 2xx response" : "no message status in a 2xx response",
      messageId: message?.messageId ?? null,
    };
  }

  const messageId = message?.messageId ?? null;
  const upper = status.toUpperCase();

  if (SENT_SET.has(upper)) {
    return { status: "sent", retryable: false, detail: status, messageId };
  }

  if (FAILURE_SET.has(upper)) {
    return { status: "rejected", retryable: false, detail: status, messageId };
  }

  // A status we do not recognise is not a send. It is not retried either: it may
  // well mean the message was delivered, and a retry would send a second welcome.
  return {
    status: "rejected",
    retryable: false,
    detail: `unrecognised status: ${status}`,
    messageId,
  };
}

/** Never throws. */
export async function sendWhatsappTemplate({ fetchImpl = fetch, apiKey, payload }) {
  let response;
  try {
    response = await fetchImpl(DOUBLETICK_TEMPLATE_URL, {
      method: "POST",
      headers: {
        // Raw key. NOT "Bearer <key>" -- the provider rejects that.
        Authorization: String(apiKey ?? ""),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      // Bounded: a stall aborts with a TimeoutError, which lands in the catch below.
      signal: sendTimeoutSignal(),
    });
  } catch (transportError) {
    // A thrown falsy value is still a transport failure, not something that falls through.
    return classifyWhatsappOutcome({ transportError: transportError || new Error("unknown") });
  }

  let body = null;
  let bodyTimedOut = false;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
    // The timeout signal covers reading the body as well as the headers.
    bodyTimedOut = error?.name === "TimeoutError";
  }

  return classifyWhatsappOutcome({ httpStatus: response?.status, body, bodyTimedOut });
}
