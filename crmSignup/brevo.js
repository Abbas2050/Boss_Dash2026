import { sendTimeoutSignal } from "./sendTimeout.js";
import { isTransientHttpStatus } from "./transientHttp.js";

export const BREVO_CONTACTS_URL = "https://api.brevo.com/v3/contacts";

const text = (v) => String(v ?? "").trim();

/**
 * Brevo runs at registration only. It is deliberately NOT gated on marketing
 * consent: decided 2026-10-09 and reaffirmed 2026-10-12, everyone lands in the
 * list with consent recorded as OPT_IN, which is Brevo's own flag and which its
 * double-opt-in tooling reads. Campaigns segment on it.
 */
export function decideBrevoSkip({ stage, apiKey }) {
  if (!text(apiKey)) return { reason: "brevo not configured" };
  if (stage !== "registered") return { reason: "stage not applicable" };
  return null;
}

/**
 * Whether `BREVO_LIST_ID` names a list Brevo can be asked for.
 *
 * One test, read by three places that must not disagree: the gate below, the
 * payload builder, and the boot-time warning in server.js. A warning that
 * disagreed with the gate would be worse than no warning.
 *
 * A positive finite number, which is what the API takes. `""`, `"  "`, unset and
 * `"nineteen"` all fail it; so does `0` and `-1`.
 */
export function isUsableBrevoListId(listId) {
  const list = Number(text(listId));
  return Number.isFinite(list) && list > 0;
}

/**
 * What the row says when the list id is unusable. It does NOT name the value.
 *
 * The commonest way this column goes wrong is a paste into the wrong line of
 * .env, and the line above it is `BREVO_API_KEY` -- echoing the value here would
 * write the key into a column the settings tab prints. The variable's name is
 * the whole of what a person needs.
 */
export const UNUSABLE_LIST_ID_DETAIL = "not sent: BREVO_LIST_ID is unset, blank or not a positive number";

/**
 * The second reason not to call Brevo, and it is a failure rather than a skip.
 *
 * Until 2026-10-14 an unusable list id failed OPEN: the contact was created and
 * joined no list, while the row recorded `sent`. Nobody would have found out
 * until they opened list 19 to run a campaign and found it short. So this is
 * decided before the request and the request is not made (2026-10-14, user's
 * call).
 *
 * `failed`, not `rejected`: Brevo never saw this one, so no provider refused it,
 * and `rejected` is reserved for the provider refusing (classifyBrevoOutcome
 * below). Not `skipped` either -- a skip is a deliberate decision not to send,
 * and this is a misconfiguration. It follows the backstop's precedent, where a
 * send that was never attempted is `failed` with the detail carrying the
 * difference.
 *
 * Terminal, not retryable: a wrong environment variable will not become right in
 * five minutes, so three attempts would be three identical lines in the log and
 * nothing else. The row keeps its client data instead (SCRUBBABLE in settled.js),
 * which is what makes the resend possible once the variable is fixed.
 */
export function decideBrevoListIdFailure({ listId } = {}) {
  if (isUsableBrevoListId(listId)) return null;
  return { status: "failed", retryable: false, detail: UNUSABLE_LIST_ID_DETAIL };
}

/**
 * One contact, ready for POST /v3/contacts with updateEnabled.
 *
 * Two attributes are Brevo's own rather than ours: EXT_ID carries the CRM
 * client id, and OPT_IN carries marketing consent -- a custom
 * MARKETING_CONSENT would be invisible to Brevo's compliance tooling.
 *
 * Empty text is omitted rather than sent as "". A false boolean IS sent,
 * because false is a real answer and absent is not.
 */
export function buildBrevoContact(fields = {}, { listId } = {}) {
  const attributes = {
    OPT_IN: Boolean(fields.marketingConsent),
    IS_IB: Boolean(fields.isIb),
  };

  const textAttributes = {
    FIRSTNAME: fields.firstName,
    LASTNAME: fields.lastName,
    MIDDLE_NAME: fields.middleName,
    EXT_ID: fields.crmClientId,
    ENTITY: fields.entity,
    FORM_NAME: fields.source,
    LANGUAGE: fields.language,
    UTM_SOURCE: fields.utmSource,
    UTM_MEDIUM: fields.utmMedium,
    UTM_CAMPAIGN: fields.utmCampaign,
    REFERER: fields.referer,
  };

  for (const [key, value] of Object.entries(textAttributes)) {
    const v = text(value);
    if (v) attributes[key] = v;
  }

  const contact = {
    email: text(fields.email).toLowerCase(),
    updateEnabled: true,
    attributes,
  };

  // The same test the gate above applies, so a contact can never be built
  // listless by one of them disagreeing with the other. Nothing should reach here
  // with an unusable id any more -- the step returns a failure first -- and this
  // stays as the second half of that one test rather than as a separate opinion.
  if (isUsableBrevoListId(listId)) contact.listIds = [Number(text(listId))];

  return contact;
}

export function classifyBrevoOutcome({ transportError, httpStatus, body } = {}) {
  if (transportError) {
    return {
      status: "failed",
      retryable: true,
      detail: `transport: ${String(transportError?.message || transportError).slice(0, 200)}`,
    };
  }

  const code = Number(httpStatus) || 0;

  // The rule all three senders share, written once in transientHttp.js.
  if (isTransientHttpStatus(code)) {
    return { status: "failed", retryable: true, detail: `http ${code}` };
  }

  if (code >= 200 && code < 300) {
    return { status: "sent", retryable: false, detail: `http ${code}` };
  }

  const reason = [body?.code, body?.message].filter(Boolean).join(": ").slice(0, 200);
  // `rejected`, not `failed`: this is Brevo refusing the contact -- an attribute
  // it does not know returns 400, the failure that makes a contact silently
  // never land (spec section 8). planRetry writes `failed` when a retryable
  // outcome runs out of attempts, so one word for both would read a dead
  // attribute and a transport outage as the same thing on the destination card.
  return {
    status: "rejected",
    retryable: false,
    detail: reason ? `http ${code} ${reason}` : `http ${code}`,
  };
}

/** Never throws. */
export async function upsertBrevoContact({ fetchImpl = fetch, apiKey, contact }) {
  let response;
  try {
    response = await fetchImpl(BREVO_CONTACTS_URL, {
      method: "POST",
      headers: {
        "api-key": String(apiKey ?? ""),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(contact),
      // Bounded: a stall aborts with a TimeoutError, which lands in the catch below.
      signal: sendTimeoutSignal(),
    });
  } catch (transportError) {
    // A thrown falsy value is still a transport failure, not something that falls through.
    return classifyBrevoOutcome({ transportError: transportError || new Error("unknown") });
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // 204 has no body, and that is a success, not a parse failure. A body cut off
    // by the timeout lands here too, and the 2xx has already said the upsert worked.
    body = null;
  }

  return classifyBrevoOutcome({ httpStatus: response?.status, body });
}
