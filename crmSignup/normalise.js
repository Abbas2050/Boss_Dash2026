/**
 * Turning one FXBO webhook body into the fields the rest of the module uses.
 *
 * Everything here is pure. The two decisions worth reading twice are the record
 * type (which gates whether anyone gets a WhatsApp message) and the middle name
 * (which FXBO has no placeholder for, so it is derived).
 */

/** The funnel, in order. The value is typed by hand into each FXBO rule. */
export const STAGES = ["lead", "registered", "verified", "live_account", "first_deposit"];

const STAGE_SET = new Set(STAGES);

export function isStage(value) {
  return STAGE_SET.has(String(value ?? ""));
}

/** E.164: a plus, a non-zero leading digit, then 7 to 14 more. 8-15 digits. */
export const PHONE_RE = /^\+[1-9]\d{7,14}$/;

/** Without these there is nothing to key on, nothing to greet, and nothing to
 *  create in Brevo. A missing phone is NOT fatal -- it is a WhatsApp skip. */
export const REQUIRED_FIELDS = ["stage", "crmClientId", "firstName", "email"];

/** A template variable that failed to render arrives as one of these strings.
 *  For the required fields it counts as missing, so a "null" client id cannot
 *  act as a shared key. The values themselves stay in `fields`. */
const UNRENDERED = new Set(["null", "undefined"]);

const FALSY = new Set(["", "0", "false", "no", "n", "off", "null", "undefined"]);

/**
 * The client-meaning literals for the record type, exactly as spec §2 names
 * them. Deliberately narrower than FALSY: the asymmetry is intentional, because
 * a lead who receives a login link for an account that does not exist is worse
 * than a client who misses a welcome message. So "null" and "undefined" stay out
 * here, even though they are falsy for consent and IB flags, where absent
 * legitimately means no.
 */
const CLIENT_LITERALS = new Set(["0", "false", "no", "n", "off"]);

const text = (v) => String(v ?? "").trim();

export function isFalsyLiteral(value) {
  return FALSY.has(text(value).toLowerCase());
}

/**
 * Lead or client.
 *
 * Only a recognised client literal (see CLIENT_LITERALS) makes a client. Absent,
 * empty and anything unrecognised resolve to "lead", the side that cannot cause
 * harm: the welcome message links to a login page, and a lead has no account to
 * log into.
 */
export function deriveRecordType(isLead) {
  return CLIENT_LITERALS.has(text(isLead).toLowerCase()) ? "client" : "lead";
}

/**
 * FXBO has no middle-name placeholder, so it comes out of the full name.
 * Conservative: the full name must begin with the first name and end with the
 * last, or we cannot say which part is the middle and return nothing. Matching
 * is on the whole first and last name, so a multi-word surname works.
 */
export function deriveMiddleName(fullName, firstName, lastName) {
  const collapse = (v) => text(v).replace(/\s+/g, " ");
  const full = collapse(fullName);
  const fullLower = full.toLowerCase();
  const first = collapse(firstName).toLowerCase();
  const last = collapse(lastName).toLowerCase();
  if (!full || !first || !last) return "";
  if (!fullLower.startsWith(`${first} `) || !fullLower.endsWith(` ${last}`)) return "";
  return full.slice(first.length, full.length - last.length).trim();
}

export function maskEmail(email) {
  const v = text(email);
  if (!v) return "";
  // The last '@' is the one that begins the domain. Splitting on the first
  // would leave a second address in a multi-address value whole.
  const at = v.lastIndexOf("@");
  if (at < 1) return "***";
  return `${v.slice(0, 1)}***${v.slice(at)}`;
}

export function maskPhone(phone) {
  const v = text(phone);
  if (!v) return "";
  // Four leading and two trailing characters must not cover most of a short number.
  if (v.length < 12) return "***";
  return `${v.slice(0, 4)}***${v.slice(-2)}`;
}

export function normaliseEvent(raw = {}) {
  const body = raw && typeof raw === "object" ? raw : {};
  const firstName = text(body.first_name);
  const lastName = text(body.last_name);
  const stage = text(body.stage);

  const fields = {
    stage: isStage(stage) ? stage : "",
    crmClientId: text(body.client_id),
    firstName,
    middleName: deriveMiddleName(body.full_name, firstName, lastName),
    lastName,
    email: text(body.email).toLowerCase(),
    phone: text(body.phone),
    recordType: deriveRecordType(body.is_lead),
    // The literal, kept beside the verdict derived from it. deriveRecordType
    // resolves everything it does not recognise to "lead", so the row cannot be
    // read backwards to find out what FXBO actually sent -- and that is the one
    // thing CUTOVER step 5 has to discover, because a literal missing from
    // CLIENT_LITERALS means nobody gets a WhatsApp message. Not lowercased:
    // "False" and "false" are the same verdict but not the same evidence.
    isLeadRaw: text(body.is_lead),
    marketingConsent: !isFalsyLiteral(body.marketing_consent),
    source: text(body.source),
    entity: text(body.entity),
    isIb: !isFalsyLiteral(body.is_ib),
    language: text(body.language),
    utmSource: text(body.utm_source),
    utmMedium: text(body.utm_medium),
    utmCampaign: text(body.utm_campaign),
    referer: text(body.referer),
    fullLink: text(body.full_link),
    fxboUniqueId: text(body.unique_id),
  };

  const missing = REQUIRED_FIELDS.filter(
    (key) => !fields[key] || UNRENDERED.has(fields[key].toLowerCase()),
  );
  return { valid: missing.length === 0, missing, fields };
}
