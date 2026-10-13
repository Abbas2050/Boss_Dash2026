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

  const list = Number(listId);
  if (Number.isFinite(list) && list > 0) contact.listIds = [list];

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

  if (code === 429 || code >= 500) {
    return { status: "failed", retryable: true, detail: `http ${code}` };
  }

  if (code >= 200 && code < 300) {
    return { status: "sent", retryable: false, detail: `http ${code}` };
  }

  const reason = [body?.code, body?.message].filter(Boolean).join(": ").slice(0, 200);
  return {
    status: "failed",
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
    });
  } catch (transportError) {
    // A thrown falsy value is still a transport failure, not something that falls through.
    return classifyBrevoOutcome({ transportError: transportError || new Error("unknown") });
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // 204 has no body, and that is a success, not a parse failure.
    body = null;
  }

  return classifyBrevoOutcome({ httpStatus: response?.status, body });
}
