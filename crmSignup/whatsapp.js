import { PHONE_RE } from "./normalise.js";

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
 *  Anything else is not treated as sent, including a failure this list omits. */
const SUCCESS_SET = new Set(["SENT"]);

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
 */
export function decideWhatsappSkip({ stage, apiKey, recordType, source, phone, skipSources }) {
  if (!String(apiKey ?? "").trim()) return { reason: "whatsapp not configured" };
  if (stage !== "registered") return { reason: "stage not applicable" };
  if (recordType !== "client") return { reason: "lead, not client" };
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

export function classifyWhatsappOutcome({ transportError, httpStatus, body } = {}) {
  if (transportError) {
    return {
      status: "failed",
      retryable: true,
      detail: `transport: ${String(transportError?.message || transportError).slice(0, 200)}`,
      messageId: null,
    };
  }

  const code = Number(httpStatus) || 0;

  // A Request Timeout is transient by definition, as are 429 and every 5xx.
  if (code === 408 || code === 429 || code >= 500) {
    return { status: "failed", retryable: true, detail: `http ${code}`, messageId: null };
  }

  if (code < 200 || code >= 300) {
    // A bad key, an unapproved template, a malformed body: identical on retry.
    return { status: "rejected", retryable: false, detail: `http ${code}`, messageId: null };
  }

  const message = Array.isArray(body?.messages) ? body.messages[0] : null;
  const status = String(message?.status ?? "").trim();

  if (!status) {
    return {
      status: "failed",
      retryable: false,
      detail: "no message status in a 2xx response",
      messageId: message?.messageId ?? null,
    };
  }

  const messageId = message?.messageId ?? null;
  const upper = status.toUpperCase();

  if (SUCCESS_SET.has(upper)) {
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
    });
  } catch (transportError) {
    return classifyWhatsappOutcome({ transportError });
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return classifyWhatsappOutcome({ httpStatus: response?.status, body });
}
