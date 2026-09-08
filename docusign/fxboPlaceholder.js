/**
 * Telling "somebody pressed Test webhook" apart from "the rule is broken".
 *
 * The FXBO Assistant rule "DocuSign" (#36) has a Test webhook button. A test has
 * no real application behind it, so FXBO cannot substitute %application_id% with
 * anything — instead it sends each parameter's LABEL from its own placeholder
 * table. `applicationId` therefore arrives as the literal string
 * "Application ID + Link", `email` as "Client Email", and so on.
 *
 * That payload is correctly rejected (see appId.js and commit 7b84916: before
 * 15 July the raw label was accepted as the idempotency key, which stored junk
 * applications and sent clients duplicate envelopes). The rejection is not the
 * problem. The problem was diagnostic: a harmless test and a genuinely
 * misconfigured rule produced the identical log line and the identical error
 * code, so nobody reading the log could tell which had happened.
 *
 * RECOGNITION MUST BE NARROW. If "anything without digits" counted as a
 * placeholder, a genuinely broken rule would report the friendly code and hide
 * behind it — exactly the failure this module exists to prevent. So two shapes
 * are recognised, at two different confidence levels:
 *
 *   1. A raw token — "%application_id%" or "{{application_id}}". Nothing that
 *      is a real value ever looks like this, so one field is proof on its own.
 *   2. An exact label from FXBO's placeholder table. This is ordinary English
 *      text, so one field alone is NOT proof — it needs CORROBORATION: at least
 *      one OTHER field in the same payload must also be a label or a token.
 *      That is free to obtain, because a test webhook substitutes every
 *      parameter with its label at once, never just one.
 *
 * The composite rule is what makes this safe. A real rule would have to break
 * in two fields simultaneously, each landing on a verbatim FXBO label, to be
 * misread as a test.
 */

/**
 * The parameter labels shown in FXBO's placeholder table on the Assistant rules
 * page. These are the strings a test webhook substitutes for real values.
 * Matching the label table rather than a generic pattern is the whole point:
 * anything outside this list is a genuine misconfiguration and must keep
 * reporting as one.
 */
export const FXBO_PLACEHOLDER_LABELS = [
  "Application ID + Link",
  "Application Type",
  "Client ID",
  "Client ID + Link",
  "Client Full Name",
  "Client First Name",
  "Client Last Name",
  "Client Email",
  "Client Country",
  "Client Title (Mr/Mrs/Ms)",
  "Current Time",
];

// Case and internal whitespace are normalised because the label is copied out
// of an HTML table; the wording itself is matched exactly.
function canonicalise(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

const LABEL_SET = new Set(FXBO_PLACEHOLDER_LABELS.map(canonicalise));

/** "%application_id%" / "{{application_id}}" — an unsubstituted token. */
export function isPlaceholderToken(value) {
  const v = String(value ?? "").trim();
  if (!v) return false;
  return /^%[^%\s][^%]*%$/.test(v) || /^\{\{[^}]+\}\}$/.test(v);
}

/** Exactly one of FXBO's own placeholder labels, e.g. "Application ID + Link". */
export function isFxboPlaceholderLabel(value) {
  return LABEL_SET.has(canonicalise(value));
}

function classify(value) {
  if (isPlaceholderToken(value)) return "token";
  if (isFxboPlaceholderLabel(value)) return "label";
  return null;
}

/**
 * Decide whether `field` in `payload` carries an unsubstituted FXBO placeholder
 * rather than a value.
 *
 * Returns `{ placeholder, field, value, kind, corroborating }`. `corroborating`
 * lists the OTHER fields that also arrived as placeholders — it is the evidence
 * the caller should quote, and for the `label` kind it is also the condition:
 * a lone label is deliberately NOT enough.
 */
export function detectUnsubstitutedPlaceholder(payload, field = "applicationId") {
  const source = payload && typeof payload === "object" ? payload : {};
  const value = String(source[field] ?? "");
  const kind = classify(value);

  const corroborating = [];
  if (kind) {
    for (const [key, other] of Object.entries(source)) {
      if (key === field) continue;
      if (other && typeof other === "object") continue;
      const otherKind = classify(other);
      if (otherKind) corroborating.push({ field: key, value: String(other), kind: otherKind });
    }
  }

  return {
    placeholder: kind === "token" || (kind === "label" && corroborating.length > 0),
    field,
    value,
    kind,
    corroborating,
  };
}

export const PLACEHOLDER_NOT_SUBSTITUTED = "placeholder_not_substituted";

/**
 * Operator-facing sentence. It names the field and says the value is a label,
 * so the reader is not left to infer that a test was pressed.
 */
export function describePlaceholderRejection(detection) {
  const others = (detection?.corroborating || []).map((c) => c.field);
  const evidence = others.length
    ? ` The same request carried placeholder values in ${others.join(", ")}, which is what an FXBO "Test webhook" press looks like.`
    : "";
  return (
    `${detection?.field ?? "applicationId"} arrived as ${JSON.stringify(String(detection?.value ?? "").slice(0, 120))}, ` +
    `which is an FXBO placeholder label rather than a value, so no application could be identified.${evidence}`
  );
}
