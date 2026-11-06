/**
 * One row of a Meta Lead Ads export becomes one candidate lead, or a reason it
 * is not one.
 *
 * Everything here is pure: a row in, an object out, no clock and no network.
 * The rules it holds are the ones that quietly produce wrong data when they
 * are wrong, so each is tested against the real sheets rather than against an
 * idea of what Meta sends.
 *
 * Design: ../docs/superpowers/specs/2026-11-06-meta-leads-to-fxbo-design.md
 */

/**
 * Dialling code to ISO alpha-2, for codes that name exactly one country.
 *
 * Longest match wins, which is why 97 and 971 can both be reasoned about
 * safely. Codes shared between countries are in AMBIGUOUS_DIAL_CODES below and
 * answer nothing at all.
 */
export const DIAL_CODES = Object.freeze({
  "20": "EG", "27": "ZA", "30": "GR", "31": "NL", "32": "BE", "33": "FR",
  "34": "ES", "36": "HU", "39": "IT", "40": "RO", "41": "CH", "43": "AT",
  "44": "GB", "45": "DK", "46": "SE", "47": "NO", "48": "PL", "49": "DE",
  "51": "PE", "52": "MX", "54": "AR", "55": "BR", "56": "CL", "57": "CO",
  "58": "VE", "60": "MY", "61": "AU", "62": "ID", "63": "PH", "64": "NZ",
  "65": "SG", "66": "TH", "81": "JP", "82": "KR", "84": "VN", "86": "CN",
  "90": "TR", "91": "IN", "92": "PK", "93": "AF", "94": "LK", "95": "MM",
  "98": "IR", "212": "MA", "213": "DZ", "216": "TN", "218": "LY", "233": "GH",
  "234": "NG", "249": "SD", "251": "ET", "254": "KE", "255": "TZ", "256": "UG",
  "351": "PT", "352": "LU", "353": "IE", "354": "IS", "356": "MT", "357": "CY",
  "358": "FI", "359": "BG", "370": "LT", "371": "LV", "372": "EE", "373": "MD",
  "374": "AM", "375": "BY", "380": "UA", "381": "RS", "382": "ME", "385": "HR",
  "386": "SI", "387": "BA", "389": "MK", "420": "CZ", "421": "SK", "591": "BO",
  "593": "EC", "595": "PY", "598": "UY", "673": "BN", "855": "KH", "856": "LA",
  "880": "BD", "960": "MV", "961": "LB", "962": "JO", "963": "SY", "964": "IQ",
  "965": "KW", "966": "SA", "967": "YE", "968": "OM", "971": "AE", "972": "IL",
  "973": "BH", "974": "QA", "976": "MN", "977": "NP", "992": "TJ", "993": "TM",
  "994": "AZ", "995": "GE", "996": "KG", "998": "UZ",
});

/** +1 is twenty-odd countries, +7 is two. Neither can be read off a number. */
export const AMBIGUOUS_DIAL_CODES = Object.freeze(["1", "7"]);

const LONGEST_DIAL_CODE = 3;

export function countryFromPhone(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  for (let length = LONGEST_DIAL_CODE; length >= 1; length -= 1) {
    const prefix = digits.slice(0, length);
    if (AMBIGUOUS_DIAL_CODES.includes(prefix)) return null;
    if (DIAL_CODES[prefix]) return DIAL_CODES[prefix];
  }
  return null;
}

/** The countries actually named in these campaigns, plus the near neighbours. */
export const COUNTRY_WORDS = Object.freeze({
  iraq: "IQ", turkey: "TR", turkiye: "TR", uae: "AE", emirates: "AE",
  dubai: "AE", abudhabi: "AE", saudi: "SA", ksa: "SA", kuwait: "KW",
  qatar: "QA", bahrain: "BH", oman: "OM", jordan: "JO", lebanon: "LB",
  egypt: "EG", morocco: "MA", algeria: "DZ", tunisia: "TN", pakistan: "PK",
  india: "IN", nigeria: "NG", kenya: "KE", malaysia: "MY", indonesia: "ID",
  philippines: "PH", vietnam: "VN", thailand: "TH",
});

export function countryFromAdset(text) {
  const tokens = String(text ?? "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const token of tokens) {
    if (COUNTRY_WORDS[token]) return COUNTRY_WORDS[token];
  }
  return null;
}

function iso2(value) {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * Phone, then ad set, then Meta's column.
 *
 * The order is a finding, not a preference: on the Iraq sheet, seven of thirty
 * rows carry `US` beside a `+964` phone, because Meta reports the profile's
 * locale rather than where the person is. A lead filed under the wrong country
 * is worse than one filed under none, so a rule that cannot answer answers
 * null and the field is omitted.
 */
export function resolveCountry(raw) {
  return countryFromPhone(raw?.phone)
    || countryFromAdset(raw?.adsetName)
    || iso2(raw?.country);
}

/** Ad set, then campaign, then form. Organic and test rows have no ad set. */
export function resolveLeadSource(raw) {
  const first = [raw?.adsetName, raw?.campaignName, raw?.formName]
    .map((value) => String(value ?? "").trim())
    .find(Boolean);
  return first || null;
}

const PLATFORM_SOURCES = Object.freeze({ fb: "facebook", ig: "instagram" });

/**
 * The only attribution that reaches the CRM, since `referrer` is off.
 *
 * URLSearchParams rather than string concatenation: a campaign named
 * "Iraq & Turkey" would otherwise end the query string at the ampersand and
 * take the ad and the ad set with it.
 */
export function buildUtmParams(raw) {
  const params = new URLSearchParams();
  const source = PLATFORM_SOURCES[String(raw?.platform ?? "").trim().toLowerCase()];
  if (source) params.set("utm_source", source);
  params.set("utm_medium", "paid_social");
  const campaign = String(raw?.campaignName ?? "").trim();
  const ad = String(raw?.adName ?? "").trim();
  const adset = String(raw?.adsetName ?? "").trim();
  if (campaign) params.set("utm_campaign", campaign);
  if (ad) params.set("utm_content", ad);
  if (adset) params.set("utm_term", adset);
  const text = params.toString();
  // Nothing but the constant: there is no attribution here to record.
  return text === "utm_medium=paid_social" ? null : text;
}

const TEST_MARKER = "<test lead:";
const TEST_EMAIL = "test@meta.com";

/** null when the row should be sent, otherwise the status to file it under. */
export function skipReason(raw) {
  const values = Object.values(raw ?? {}).map((value) => String(value ?? "").toLowerCase());
  if (values.some((value) => value.includes(TEST_MARKER))) return "skipped_test";
  if (String(raw?.email ?? "").trim().toLowerCase() === TEST_EMAIL) return "skipped_test";
  if (String(raw?.isOrganic ?? "").trim().toLowerCase() === "true") return "skipped_test";
  const hasEmail = Boolean(String(raw?.email ?? "").trim());
  const hasPhone = Boolean(String(raw?.phone ?? "").trim());
  if (!hasEmail && !hasPhone) return "skipped_empty";
  return null;
}

/**
 * Both names when the form gave both; otherwise the whole name split on its
 * LAST space.
 *
 * The last and not the first: these are Arabic names, a given name followed by
 * patronymics and then the family name, so the family name is the final token.
 */
export function splitName(firstRaw, lastRaw) {
  const tidy = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const first = tidy(firstRaw);
  const last = tidy(lastRaw);
  if (first && last) return { firstName: first, lastName: last };
  const whole = first || last;
  if (!whole) return { firstName: "", lastName: "" };
  const cut = whole.lastIndexOf(" ");
  if (cut === -1) return { firstName: whole, lastName: "" };
  return { firstName: whole.slice(0, cut), lastName: whole.slice(cut + 1) };
}

export function normaliseRow(raw) {
  const { firstName, lastName } = splitName(raw?.firstName, raw?.lastName);
  return {
    metaLeadId: String(raw?.metaLeadId ?? "").trim(),
    createdTime: String(raw?.createdTime ?? "").trim(),
    firstName,
    lastName,
    email: String(raw?.email ?? "").trim().toLowerCase(),
    phone: String(raw?.phone ?? "").trim(),
    country: resolveCountry(raw),
    leadSource: resolveLeadSource(raw),
    utmParams: buildUtmParams(raw),
    campaignName: String(raw?.campaignName ?? "").trim(),
    adsetName: String(raw?.adsetName ?? "").trim(),
    adName: String(raw?.adName ?? "").trim(),
    skip: skipReason(raw),
  };
}
