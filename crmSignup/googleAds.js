import { sendTimeoutSignal } from "./sendTimeout.js";
import { isTransientHttpStatus } from "./transientHttp.js";
// The one currency allowlist this service reports in, and the one stage that
// carries money -- imported, not restated, exactly as meta.js and openai.js
// import them. A third opinion about which codes are reportable is how the same
// deposit gets priced on two platforms and dropped on the third.
import { isoCurrency, DEPOSIT_VALUE_STAGE } from "./depositValue.js";

export const GOOGLE_ADS_API_HOST = "https://googleads.googleapis.com";

/**
 * The API version, in the REST path.
 *
 * **Configurable because it expires.** Google releases a version every three or
 * four months and sunsets each one about a year after its release; a sunset
 * version does not degrade, it stops answering. So this is a value an operator
 * can move with a restart (GOOGLE_ADS_API_VERSION) rather than a deploy, and
 * `v26` is the current one -- released 2026-10-14, sunset November 2027.
 * Confirmed against developers.google.com/google-ads/api/docs/sunset-dates on
 * 2026-10-21, not inherited from the brief, which did not state one.
 */
export const GOOGLE_ADS_API_VERSION = "v26";

/** Where a refresh token is exchanged for the hour-long access token. */
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * One Google Ads CONVERSION ACTION per funnel stage, by NAME.
 *
 * **Google is a different shape from the other three destinations: there is no
 * event name on the wire.** Each stage maps to a conversion action created in
 * the Google Ads UI, and the upload names it by resource name --
 * `customers/<id>/conversionActions/<numeric id>`. These three were created
 * 2026-10-21 as "Website (Import from clicks)" actions with a 90-day
 * click-through window and Count = One.
 *
 * **The names are here and the ids are not, deliberately.** A hardcoded numeric
 * id is unreadable, unverifiable against the UI, and wrong in exactly the way
 * nobody notices: it uploads successfully to whatever action now holds that id.
 * The name is resolved to its resource name once per process
 * (resolveGoogleConversionAction) and a name that does not resolve fails loudly
 * rather than guessing.
 *
 * **`registered` has no entry and must never be given one.** The customer's GTM
 * container already fires `Account_Registration (GADs)` with enhanced
 * conversions, so that stage has an owner; a second one would count every
 * signup twice. GTM_OWNED_STAGE below is what makes the row say so rather than
 * reporting an absent mapping.
 *
 * `lead` has none either, for the reason it has no Meta send: FXBO has no
 * trigger for a lead yet, so there is no conversion to attribute and no action
 * was created for one.
 */
export const GOOGLE_ADS_CONVERSION_ACTIONS = {
  verified: "FXBO_Client_Verified",
  live_account: "FXBO_Live_Account_Opened",
  // The one that carries value and currency. See googleValueFields -- the
  // decimal, never the minor-unit integer.
  first_deposit: "FXBO_First_Deposit",
};

/**
 * The stage whose conversion belongs to the website's GTM container, not to us.
 *
 * The same decision Meta and ChatGPT Ads each took for the registration stage,
 * reached here for a sharper reason: the container's tag uses enhanced
 * conversions, so Google already has that conversion with better identity than
 * we could supply. One owner per stage, or every signup counts twice.
 *
 * Its own constant rather than an import from openai.js or meta.js: the three
 * destinations reached the same conclusion separately, and lifting one gate must
 * not silently lift the others.
 */
export const GTM_OWNED_STAGE = "registered";

/**
 * The account's own UTC offset, and the format Google documents for it.
 *
 * `conversionDateTime` is `"yyyy-mm-dd hh:mm:ss+|-hh:mm"` -- a space, not an
 * ISO `T`, and an explicit signed offset. **`Date.prototype.toISOString()`
 * produces neither**, so the formatter below writes the string by hand.
 *
 * Google's own wording is that the offset "does not have to match the account's
 * timezone", but that "if you plan on comparing your imported conversion data
 * with those in the Google Ads UI, we recommend using the same timezone as your
 * Google Ads account so that the conversion counts match". So this is a
 * reconciliation decision rather than a validation one, and reconciliation is
 * the whole point here: these numbers are read beside the UI's. The Sky Links
 * account is GMT+04:00 (Gulf Standard Time), confirmed in its settings.
 *
 * Neither UTC nor the server's zone, and the difference is a day, not an hour:
 * a deposit at 02:30 Dubai time is still the previous date in UTC, so a UTC
 * stamp reports it against yesterday's clicks.
 */
export const GOOGLE_ADS_ACCOUNT_OFFSET = "+04:00";

/** The configured offset's accepted shape: a sign, two digits, a colon, two
 *  digits. Deliberately refuses `Z` and a bare `+04` -- both are readable as
 *  "the author meant UTC" and one of them is the mistake this module exists to
 *  make impossible. */
const UTC_OFFSET_RE = /^([+-])(\d{2}):(\d{2})$/;

const text = (v) => String(v ?? "").trim();

/** Digits only: the API rejects the dashed form of a customer id, and an
 *  operator copying one out of the UI gets `474-306-7250`. */
const digitsOnly = (v) => text(v).replace(/\D/g, "");

/**
 * The stage's conversion action NAME, or null.
 *
 * `Object.hasOwn` rather than a plain index, because a stage of `__proto__`
 * indexes to Object.prototype -- a truthy value that would be read as a mapping
 * and then resolved as the name `[object Object]`, which no account holds.
 */
export function googleConversionActionFor(stage) {
  const key = String(stage ?? "");
  return Object.hasOwn(GOOGLE_ADS_CONVERSION_ACTIONS, key) ? GOOGLE_ADS_CONVERSION_ACTIONS[key] : null;
}

/** The offset as minutes east of UTC, or null when it is not one. */
export function parseUtcOffsetMinutes(offset) {
  const match = UTC_OFFSET_RE.exec(text(offset));
  if (!match) return null;
  const [, sign, hours, minutes] = match;
  const h = Number(hours);
  const m = Number(minutes);
  // 14:00 is the largest real offset and 59 the largest minute; outside that it
  // is a typo that would move a conversion by days.
  if (h > 14 || m > 59) return null;
  return (sign === "-" ? -1 : 1) * (h * 60 + m);
}

// A configured value is reported once, not per send: this is read on every one.
const reportedOffsets = new Set();

/**
 * The offset to stamp with: the configured one, or the account's.
 *
 * Anything unusable falls back to GOOGLE_ADS_ACCOUNT_OFFSET with a warning
 * rather than stopping the send, and that is the right direction here where it
 * would not be for a provider key: the account's own offset is the CORRECT
 * value, and this variable exists only to move off it. Refusing every
 * conversion over a typo in an optional variable would cost real conversions to
 * protect a number that was already right.
 *
 * The formatter below is strict anyway, so a bad value cannot reach a payload
 * even if this is bypassed.
 */
export function resolveTimezoneOffset(raw) {
  const value = text(raw);
  if (!value) return GOOGLE_ADS_ACCOUNT_OFFSET;
  if (parseUtcOffsetMinutes(value) !== null) return value;
  if (!reportedOffsets.has(value)) {
    reportedOffsets.add(value);
    console.warn(
      `[crm-events] GOOGLE_ADS_TIMEZONE_OFFSET=${JSON.stringify(value)} is not a +hh:mm offset; ` +
        `using the account's ${GOOGLE_ADS_ACCOUNT_OFFSET}`
    );
  }
  return GOOGLE_ADS_ACCOUNT_OFFSET;
}

/** One reading of the row's instant, in milliseconds. NaN -- an invalid Date,
 *  an unparseable string -- is not a time, and a formatter fed one would emit
 *  "NaN-NaN-NaN", which Google would refuse with nothing in the row to say why. */
function instantMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const ms =
    value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

const pad = (n, width = 2) => String(Math.abs(n)).padStart(width, "0");

/**
 * `received_at` as `yyyy-mm-dd hh:mm:ss+hh:mm` in the account's zone, or "".
 *
 * **Every field is read with a getUTC* accessor off a shifted instant, and that
 * is the whole technique.** The local getters would read the IIS host's own
 * zone, so the same row would stamp differently on a server somebody moved --
 * and the offset text beside it would then be a lie about the digits it labels.
 * Shifting the instant and reading it as UTC makes the output depend on nothing
 * but the row and the offset.
 *
 * The offset is written from the same number the shift used, for the same
 * reason: two independent writings of "+04:00" can disagree, and the one that
 * matters is the one the digits were computed with.
 */
export function googleConversionDateTime(receivedAt, offset = GOOGLE_ADS_ACCOUNT_OFFSET) {
  const ms = instantMs(receivedAt);
  if (ms === null) return "";
  const minutes = parseUtcOffsetMinutes(offset);
  if (minutes === null) return "";

  const at = new Date(ms + minutes * 60_000);
  const date = `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
  const sign = minutes < 0 ? "-" : "+";
  return `${date} ${time}${sign}${pad(Math.trunc(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

/**
 * `<crm_client_id>:<stage>` as Google's `orderId` -- the row's existing identity,
 * not a third scheme.
 *
 * **This is the deduplication, and it is the only one available.** Google
 * documents exactly one rule: "An order id can only be used for one conversion
 * per conversion action", enforced as `DUPLICATE_ORDER_ID`. What it dedupes on
 * when no order id is sent is stated nowhere in the API reference -- the docs
 * hand that question to the consumer Help Centre, which answers it for
 * transaction ids and not for offline imports. So "gclid plus action plus time
 * would dedupe" is an inference, and it is not one to rest a retry on: a send
 * whose response was lost and is retried five minutes later would book the
 * conversion twice.
 *
 * The id is the same `<client>:<stage>` Meta's `event_id` and OpenAI's event id
 * are built from, so one funnel event has one identity across all three
 * platforms. A fourth scheme would be a fourth thing to keep consistent.
 *
 * It is also a one-way door worth recording: Google's own note is that "if you
 * set it during the import, you must use it for any adjustments", so a future
 * retraction or restatement through `uploadConversionAdjustments` has to quote
 * this exact string -- which is derivable from the row and needs no column.
 *
 * Empty for a client with no id. ":verified" would not merely lose the
 * deduplication, it would be the SAME order id for every such client -- and
 * since the uniqueness is per conversion action, the second one would be
 * refused outright as a duplicate rather than quietly merged.
 */
export function googleOrderId({ crmClientId, stage } = {}) {
  const client = text(crmClientId);
  const s = text(stage);
  if (!client || !s) return "";
  return `${client}:${s}`;
}

/**
 * Whether this conversion is ours to upload, and if not, why not.
 *
 * The configuration reasons come first and in the order an operator can act on
 * them, which is the ordering decideMetaSkip, decideBrevoSkip, decideWhatsappSkip
 * and decideOpenaiSkip all use: with nothing configured, every reason below is
 * also true, and "not configured" is the one worth reading. Each is named
 * separately because they live on different lines of .env and "not configured"
 * alone would not say which.
 *
 * The refresh token stands for the key. It is the credential the uploads cannot
 * be made without and the one that is minted by hand
 * (scripts/google-ads-refresh-token.mjs), so its absence is what "this
 * destination is not set up" means.
 *
 * **GOOGLE_ADS_DEVELOPER_TOKEN is deliberately NOT a gate**, and this is the
 * one place where the design brief described a Google that no longer exists.
 * Developer tokens were sunset on 2026-09-09. Google's own words, verbatim and
 * still current on 2026-10-21: "You can continue sending developer tokens in
 * your API call headers, but this is optional and ignored by the API servers",
 * and "We encourage you to update your app to stop sending a developer token".
 * Access now comes from the access level of the Google Cloud project that owns
 * the OAuth client (Test, then Explorer, which is the first that may call
 * production accounts), granted in the Cloud Console -- the API Center's
 * application form is dead and Google says a request made there "won't be
 * processed".
 *
 * So a gate on it would skip every conversion over a header the API throws
 * away. It is still sent when set (see googleHeaders), as a bridge for an
 * account mid-transition and because it costs nothing today -- but Google also
 * says they "will start rejecting developer tokens in API calls in a future
 * major version", so the variable is documented in .env.example as one to leave
 * unset, and this will have to stop sending it before a version bump that
 * refuses it.
 *
 * Two pages on developers.google.com still say the token is required, both only
 * inside an auto-generated "Key Takeaways" panel whose own page body never
 * mentions it. Treated as a documentation artefact rather than as the live
 * rule, which the sunset page, the deprecated `DEVELOPER_TOKEN_NOT_APPROVED`
 * enum and Google's own current curl examples all agree on.
 *
 * **A row with no gclid is the one reason that is about the row rather than the
 * stage, and it is a skip rather than a send.** Google attributes a click
 * conversion on the gclid and on nothing else -- there is no hashed-email
 * fallback here as there is for Meta and OpenAI -- so an upload without one is
 * a conversion Google counts against no campaign at all. That inflates the
 * account's conversion total while leaving every campaign's own number
 * unchanged, which is worse than a visible skip: it corrupts the figure the
 * bidding reads, and nothing in the account says where it came from. Most
 * signups are organic and carry no gclid, so this is the commonest reason here
 * and it is normal.
 */
export function decideGoogleSkip({
  stage,
  refreshToken,
  clientId,
  clientSecret,
  customerId,
  gclid,
} = {}) {
  if (!text(refreshToken)) return { reason: "google ads not configured" };
  if (!text(clientId) || !text(clientSecret)) return { reason: "google ads oauth client not configured" };
  // The customer id is in the URL, so without it there is nothing to post to --
  // the same shape as OpenAI's missing pixel id, and a skip for the same reason:
  // nothing was attempted and nothing was refused.
  if (!digitsOnly(customerId)) return { reason: "google ads customer id not configured" };

  if (stage === GTM_OWNED_STAGE) return { reason: `${GTM_OWNED_STAGE} is owned by the GTM container` };
  if (!googleConversionActionFor(stage)) return { reason: "stage has no Google Ads conversion action" };

  if (!text(gclid)) return { reason: "no gclid: the click cannot be attributed in Google Ads" };

  return null;
}

/**
 * Google's `conversionValue` and `currencyCode`, or NEITHER.
 *
 * **`valueDecimal`, not `amountMinor`, and that is the whole reason this is a
 * function rather than two lines at the call site.** Google's `conversionValue`
 * is a proto `double` and takes the decimal: a $54.49 deposit is `54.49`.
 * OpenAI's `amount` on the very same lookup is the minor-unit integer `5449`,
 * and **Google would accept that number without a word** -- as a $5,449
 * deposit. A hundredfold overstatement, in the direction that tells Smart
 * Bidding to buy much more of that traffic.
 *
 * Every other money field in this API is in micros (`amountMicros`,
 * `costMicros`), which is what makes the mistake inviting from the other side
 * too. Conversion value is the exception.
 *
 * So the unit is carried by the field name, and googleAds.test.js pins the pair
 * with a deposit whose decimal and minor-unit forms genuinely differ. A test
 * using a round number would pass with the units crossed.
 *
 * The currency is checked against the **allowlist** rather than a three-letter
 * shape, as both other destinations do: `/^[A-Z]{3}$/` is the gate that let
 * `BTC` through once on this branch, and a shape test cannot tell `BRL` from
 * `BTC`. `isoCurrency` and not `settlementCurrency` -- this refuses an unsettled
 * code, it does not settle one, because the amount beside it has already been
 * scaled.
 *
 * Both or neither: a value with no currency is a number with no unit, and
 * Google's own schema marks the two as a recommended pair.
 */
export function googleValueFields(depositValue) {
  const currency = isoCurrency(depositValue?.currency);
  const value = Number(depositValue?.valueDecimal);
  if (!currency) return {};
  if (!Number.isFinite(value) || !(value > 0)) return {};
  return { conversionValue: value, currencyCode: currency };
}

/**
 * The first deposit whose money cannot be stated, refused by name.
 *
 * Terminal and not retried, in the shape decideBrevoListIdFailure returns: a
 * currency Google cannot read will not be readable in five minutes. It is
 * `failed` rather than `rejected` because nothing was sent -- there is no
 * provider refusal to report -- and `failed` is requeueable, so a deposit
 * repriced in FXBO can be sent by the resend control.
 *
 * The alternative was uploading the conversion with no value, which Google
 * accepts. It is refused for the reason openai.js refuses it: `orderId` makes
 * this conversion unique per action for ever, so an unpriced upload now is the
 * FINAL word on that deposit's value and no later send can correct it. A
 * permanently valueless purchase on the one row whose whole point is the money
 * is worse than a visible failure naming the code.
 *
 * Reached only for a code that survived depositValue.js's own settlement -- that
 * module already fails a BTC deposit before this sees it -- so this is the
 * backstop for a shape nobody planned, and it names what it saw rather than
 * saying "no value".
 */
export function decideGoogleValueFailure({ stage, depositValue } = {}) {
  if (stage !== DEPOSIT_VALUE_STAGE) return null;
  if (googleValueFields(depositValue).currencyCode) return null;

  const code = text(depositValue?.currency);
  const reason = isoCurrency(code)
    ? `amount ${JSON.stringify(text(depositValue?.valueDecimal))} is not a positive number`
    : `currency ${JSON.stringify(code || "(none)")} is not one this service reports`;
  return {
    status: "failed",
    retryable: false,
    detail: `${DEPOSIT_VALUE_STAGE} value cannot be stated to Google Ads: ${reason}`,
  };
}

/**
 * One conversion, shaped as the batch of one that it is.
 *
 * **`partialFailure: true` always, never omitted and never false.** Google
 * documents the field as required and says it "should always be set to true".
 * With it off, one bad conversion fails the whole request at the RPC level;
 * with it on, the HTTP status stays 200 and the refusal arrives inside the body
 * (see classifyGoogleOutcome, which is where that becomes a status word).
 *
 * **A batch of one, like the other three senders.** Up to 2,000 are allowed and
 * one upload call costs one operation against the daily quota however many it
 * carries, so batching would be cheaper -- but the sweeper settles rows one at
 * a time, each with its own status, attempts and clock, and a batch would have
 * to map `results[]` and `partialFailureError`'s own indices back onto five
 * rows to settle them differently. The quota is nowhere near a constraint at
 * this volume.
 *
 * `jobId` is deliberately absent: it exists to group the requests of one
 * logical batch under a single entry in Google's offline-data diagnostics, and
 * a batch of one has no siblings to be grouped with. Google generates one.
 *
 * No `userIdentifiers`, no `consent`: a click conversion is attributed by its
 * gclid, and hashed identifiers here would be an enhanced-conversions setup
 * nobody has configured on this account. Sending them unasked would be a
 * consent claim we are not in a position to make.
 *
 * **Returns null rather than a request that is invalid by construction** --
 * every case where a required field has no value: an unmapped stage, an
 * unresolved conversion action, no gclid, no client id, a `received_at` that is
 * not a time. decideGoogleSkip already refuses most of these with a reason that
 * lands in the row; this is the second half of that one test, not a second
 * opinion, because "no payload" is a louder way to be wrong than a malformed
 * one.
 */
export function buildGoogleUpload({
  stage,
  crmClientId,
  gclid,
  conversionAction,
  receivedAt,
  offset = GOOGLE_ADS_ACCOUNT_OFFSET,
  depositValue,
  validateOnly,
} = {}) {
  if (!googleConversionActionFor(stage)) return null;

  // The resolved resource name, which the caller looked up by name. Required,
  // and refused here rather than attached behind an `if`: an upload with no
  // conversion action is not a conversion.
  const action = text(conversionAction);
  if (!action) return null;

  const click = text(gclid);
  if (!click) return null;

  const orderId = googleOrderId({ crmClientId, stage });
  if (!orderId) return null;

  const conversionDateTime = googleConversionDateTime(receivedAt, offset);
  if (!conversionDateTime) return null;

  const conversion = { gclid: click, conversionAction: action, conversionDateTime, orderId };

  // Only the deposit stage carries money, and the stage that does is named by
  // depositValue.js rather than by a literal here. Every other stage passes no
  // depositValue and carries no pair -- decideGoogleValueFailure is what stops
  // this stage sending without one.
  if (stage === DEPOSIT_VALUE_STAGE) Object.assign(conversion, googleValueFields(depositValue));

  const payload = { conversions: [conversion], partialFailure: true };
  // Omitted rather than sent as false, and a validated request records NOTHING
  // -- Google returns no `results` at all for one, which classifyGoogleOutcome
  // has to be told about rather than read as a missing confirmation.
  if (validateOnly) payload.validateOnly = true;

  return payload;
}

/** GAQL quotes string literals with single quotes, so a name carrying one would
 *  end the literal early. Our three names are constants that contain neither,
 *  which is exactly why this is cheap insurance rather than a live concern. */
const gaqlLiteral = (value) => `'${text(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * The query that turns a conversion action's name into its resource name.
 *
 * Three filters, each load-bearing:
 *
 *   `name` -- the lookup itself.
 *
 *   `type = 'UPLOAD_CLICKS'` -- the action must be an import-from-clicks one.
 *   An account can hold a website tag and an import action with the same name,
 *   and uploading to the wrong kind is refused as
 *   `INVALID_CONVERSION_ACTION_TYPE` at best and silently attributed to the
 *   wrong thing at worst.
 *
 *   `status = 'ENABLED'` -- a removed action still resolves by name, and
 *   uploading to one records nothing while answering 200.
 *
 * So a name that resolves here is one the upload can actually use, which is
 * what lets resolveGoogleConversionAction treat "no rows" as a loud failure.
 * GAQL enums are quoted string literals, not bare words.
 */
export function conversionActionQuery(name) {
  return (
    "SELECT conversion_action.resource_name, conversion_action.name, " +
    "conversion_action.type, conversion_action.status " +
    "FROM conversion_action " +
    `WHERE conversion_action.name = ${gaqlLiteral(name)} ` +
    "AND conversion_action.type = 'UPLOAD_CLICKS' " +
    "AND conversion_action.status = 'ENABLED'"
  );
}

export const searchUrl = (host, version, customerId) =>
  `${text(host) || GOOGLE_ADS_API_HOST}/${text(version) || GOOGLE_ADS_API_VERSION}` +
  `/customers/${digitsOnly(customerId)}/googleAds:search`;

export const uploadClickConversionsUrl = (host, version, customerId) =>
  `${text(host) || GOOGLE_ADS_API_HOST}/${text(version) || GOOGLE_ADS_API_VERSION}` +
  `/customers/${digitsOnly(customerId)}:uploadClickConversions`;

/**
 * The headers every Google Ads call takes.
 *
 * `login-customer-id` is sent only when set, because it is required only when
 * reaching the customer THROUGH a manager account and wrong otherwise. Digits
 * only, for the same reason the customer id is: Google's own instruction is
 * "1234567890, not 123-456-7890".
 *
 * `developer-token` likewise only when set, and an unset one is the documented
 * preference rather than a gap -- see decideGoogleSkip. Omitting it cleanly
 * matters more than it looks: the header must be absent, not present and empty,
 * because `developer-token: ""` is a token the API would have to judge.
 */
function googleHeaders({ accessToken, developerToken, loginCustomerId }) {
  const headers = {
    Authorization: `Bearer ${text(accessToken)}`,
    "Content-Type": "application/json",
  };
  const token = text(developerToken);
  if (token) headers["developer-token"] = token;
  const manager = digitsOnly(loginCustomerId);
  if (manager) headers["login-customer-id"] = manager;
  return headers;
}

/**
 * Whatever a message quoted back at us, with every secret taken out of it.
 *
 * Four things must never reach a log line or the `*_detail` column: the
 * developer token, the client secret, the refresh token and the access token.
 * The structural half is that all four travel in a header or a form body and
 * never in a URL, so no request line can carry one; what remains is an error
 * message that echoed one, and the detail is both logged and stored.
 *
 * Encoded before raw, as sendOpenaiEvent does it: a secret containing `%` has a
 * raw form that sits inside its encoded form (`%25` inside `%2525`), so the raw
 * pass must never run first.
 */
function redactSecrets(message, secrets) {
  let text = String(message ?? "");
  // Structural first: whatever follows "Bearer " is a token, in whatever form
  // the thrower wrote it.
  text = text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  const forms = secrets
    .map((s) => String(s ?? ""))
    .filter(Boolean)
    .flatMap((s) => [encodeURIComponent(s), s])
    .filter(Boolean);
  for (const form of forms) text = text.split(form).join("[redacted]");
  return text;
}

/**
 * How early a cached access token is replaced.
 *
 * Google's tokens last an hour. A token used in the last seconds of its life
 * works for the request that checked it and fails for the one in flight, so the
 * margin is what keeps a correct cache from producing a 401 on a boundary.
 */
export const GOOGLE_TOKEN_REFRESH_MARGIN_MS = 60_000;

// { key, accessToken, expiresAtMs }. One per process, which is the point: a
// token minted per send is a wasted round trip on every row and a rate limit
// nobody asked for.
let accessTokenCache = null;

// name -> resource name, for one customer and one API version. Successes only.
const conversionActionCache = new Map();

/** Both caches, emptied. Exported for the tests, which must not inherit a token
 *  or a resource name from each other -- and for an operator reading this:
 *  nothing else empties them, so a conversion action renamed in the UI needs a
 *  restart to be seen. */
export function clearGoogleCaches() {
  accessTokenCache = null;
  conversionActionCache.clear();
}

const msOf = (now) => {
  const ms = instantMs(now);
  return ms === null ? Date.now() : ms;
};

/**
 * An access token, from the cache or freshly exchanged. Never throws, and never
 * puts a secret in its result.
 *
 * The cache key carries the client id, the refresh token and the token URL, so
 * a credential changed in .env and a restart that re-reads it cannot be served
 * a token minted for the old one -- that token would be valid and belong to the
 * wrong account.
 *
 * A failure is retryable only when the exchange itself was: a 5xx or a dropped
 * connection is a moment, while `invalid_grant` is the refresh token being
 * revoked or expired. That second case is the one .env.example warns about -- a
 * consent screen left in "Testing" expires refresh tokens after seven days --
 * and it is permanent until somebody mints a new one, so it must not spend a
 * row's whole retry budget discovering that.
 */
export async function getGoogleAccessToken({
  fetchImpl = fetch,
  tokenUrl = GOOGLE_OAUTH_TOKEN_URL,
  clientId,
  clientSecret,
  refreshToken,
  now,
} = {}) {
  const key = `${text(clientId)}|${text(refreshToken)}|${text(tokenUrl) || GOOGLE_OAUTH_TOKEN_URL}`;
  const nowMs = msOf(now);

  if (
    accessTokenCache &&
    accessTokenCache.key === key &&
    nowMs < accessTokenCache.expiresAtMs - GOOGLE_TOKEN_REFRESH_MARGIN_MS
  ) {
    return { accessToken: accessTokenCache.accessToken, cached: true };
  }

  const secrets = [clientSecret, refreshToken];
  // The four parameters Google's own curl example sends, as a form body. The
  // refresh token travels in that body and never on the query string, so no
  // request line can carry it into a log.
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: text(clientId),
    client_secret: String(clientSecret ?? ""),
    refresh_token: String(refreshToken ?? ""),
  }).toString();

  let response;
  try {
    response = await fetchImpl(text(tokenUrl) || GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      // Bounded like every other outbound call here: Node's fetch has no
      // timeout and the sweeper runs rows serially.
      signal: sendTimeoutSignal(),
    });
  } catch (error) {
    const message = redactSecrets(error?.message || error || "unknown", secrets);
    // `transport:` leads, as it does in every sender's own transport branch, and
    // the step follows it: the prefix is what a reader (and sendTimeout.contract.js)
    // recognises as "the request never completed", and `access token` is which
    // of this destination's two requests it was.
    return { failure: { detail: `transport: access token: ${message.slice(0, 160)}`, retryable: true } };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  const status = Number(response?.status) || 0;
  if (status < 200 || status >= 300) {
    // Google's token endpoint names the cause in `error` with prose in
    // `error_description`; `invalid_grant` is the one worth reading.
    const named = [payload?.error, payload?.error_description].filter(Boolean).join(": ");
    return {
      failure: {
        detail: `access token: http ${status} ${redactSecrets(named || "no reason given", secrets)}`.slice(0, 200),
        retryable: isTransientHttpStatus(status),
      },
    };
  }

  const accessToken = text(payload?.access_token);
  if (!accessToken) {
    return { failure: { detail: `access token: http ${status} with no access_token`, retryable: true } };
  }

  // `expires_in` is the lifetime in seconds. A response that did not state one
  // is NOT cached: a lifetime we were not told is not one to assume, and the
  // only safe assumption is that it has already run out. That costs a round
  // trip per send against a server behaving unexpectedly, which is the cheap
  // direction -- the expensive one is a 401 on every send until a restart.
  const lifetimeSeconds = Number(payload?.expires_in);
  accessTokenCache =
    Number.isFinite(lifetimeSeconds) && lifetimeSeconds > 0
      ? { key, accessToken, expiresAtMs: nowMs + lifetimeSeconds * 1000 }
      : null;

  return { accessToken, cached: false };
}

/**
 * The conversion action's resource name, resolved from its name once.
 *
 * Cached per customer, per API version and per name, because
 * `customers/<id>/conversionActions/<id>` does not change and asking for it on
 * every upload is a second round trip per conversion.
 *
 * **A name that does not resolve is a loud failure and never a guess.** Two
 * shapes of wrong are refused rather than papered over:
 *
 *   No row. The action was renamed, paused, removed, created in another
 *   account, or created as a website tag rather than an import action. Terminal:
 *   none of those is different in five minutes, and the detail names the
 *   constant so the fix is a lookup in the UI. Not cached either, so fixing it
 *   in Google Ads does not need a restart.
 *
 *   More than one row. Two enabled import actions share the name, and picking
 *   one would split that stage's reporting between them with nothing saying so.
 *   There is no right answer to choose, so the row says how many it found.
 *
 * Returns `{ resourceName }` or `{ failure }`; never throws.
 */
export async function resolveGoogleConversionAction({
  fetchImpl = fetch,
  apiHost = GOOGLE_ADS_API_HOST,
  apiVersion = GOOGLE_ADS_API_VERSION,
  customerId,
  loginCustomerId,
  developerToken,
  clientId,
  clientSecret,
  refreshToken,
  tokenUrl,
  stage,
  now,
} = {}) {
  const name = googleConversionActionFor(stage);
  if (!name) return { failure: { detail: `stage ${JSON.stringify(String(stage ?? ""))} has no conversion action`, retryable: false } };

  const cacheKey = `${digitsOnly(customerId)}|${text(apiVersion)}|${name}`;
  const cached = conversionActionCache.get(cacheKey);
  if (cached) return { resourceName: cached, cached: true };

  const token = await getGoogleAccessToken({ fetchImpl, tokenUrl, clientId, clientSecret, refreshToken, now });
  if (token.failure) return { failure: token.failure };

  const secrets = [clientSecret, refreshToken, token.accessToken, developerToken];
  let response;
  try {
    response = await fetchImpl(searchUrl(apiHost, apiVersion, customerId), {
      method: "POST",
      headers: googleHeaders({ accessToken: token.accessToken, developerToken, loginCustomerId }),
      // `pageSize` is deliberately absent: Google answers
      // PAGE_SIZE_NOT_SUPPORTED when it is sent in the body at all.
      body: JSON.stringify({ query: conversionActionQuery(name) }),
      signal: sendTimeoutSignal(),
    });
  } catch (error) {
    const message = redactSecrets(error?.message || error || "unknown", secrets);
    return {
      failure: { detail: `transport: conversion action ${name}: ${message.slice(0, 140)}`, retryable: true },
    };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const status = Number(response?.status) || 0;
  if (status < 200 || status >= 300) {
    const reported = readGoogleError(body);
    return {
      failure: {
        detail: `conversion action ${name}: http ${status} ${redactSecrets(reported?.message || "no reason given", secrets)}`.slice(
          0,
          200
        ),
        retryable: isTransientHttpStatus(status),
      },
    };
  }

  const resourceNames = (Array.isArray(body?.results) ? body.results : [])
    .map((row) => text(row?.conversionAction?.resourceName))
    .filter(Boolean);

  if (resourceNames.length === 0) {
    return {
      failure: {
        detail: `conversion action ${name} did not resolve: no enabled UPLOAD_CLICKS action of that name`,
        retryable: false,
      },
    };
  }
  if (resourceNames.length > 1) {
    return {
      failure: {
        detail: `conversion action ${name} is ambiguous: ${resourceNames.length} enabled UPLOAD_CLICKS actions share the name`,
        retryable: false,
      },
    };
  }

  conversionActionCache.set(cacheKey, resourceNames[0]);
  return { resourceName: resourceNames[0], cached: false };
}

/** The suffix of the one `details` element that carries the per-conversion
 *  errors. Matched on the suffix and not the whole `@type`, which is
 *  version-pinned -- `...v26.errors.GoogleAdsFailure` -- so a full-string match
 *  would stop reading errors on the first version bump and every refusal would
 *  read as "accepted". */
const GOOGLE_ADS_FAILURE_TYPE = "GoogleAdsFailure";

/**
 * What Google's body says went wrong, or null.
 *
 * Two error channels, read as one because a row only ever needs the answer to
 * "was this conversion accepted":
 *
 *   `partialFailureError` -- the per-conversion refusals, **returned inside a
 *   200**. This is the whole reason this function exists (see
 *   classifyGoogleOutcome).
 *
 *   `error` -- the RPC-level failure that comes with a non-2xx status, carrying
 *   `status` (PERMISSION_DENIED, INVALID_ARGUMENT) and a message.
 *
 * Both are `google.rpc.Status`, so one unpacking serves both: `details` holds
 * exactly one element for a partial failure, that element packs one
 * `GoogleAdsFailure` however many operations failed, and each of its `errors`
 * carries an `errorCode` object with a single key naming the enum --
 * `{ conversionUploadError: "EXPIRED_EVENT" }`. The enum is the part worth
 * storing: the prose repeats it at length, and the detail column holds 500
 * characters.
 */
export function readGoogleError(body) {
  if (!body || typeof body !== "object") return null;

  const partial = body.partialFailureError;
  const status = partial ?? body.error;
  if (status === null || status === undefined || status === false || status === "") return null;
  if (typeof status !== "object") return { partial: Boolean(partial), message: String(status).slice(0, 200) };

  const details = Array.isArray(status.details) ? status.details : [];
  const failure = details.find((d) => String(d?.["@type"] ?? "").endsWith(GOOGLE_ADS_FAILURE_TYPE));
  const errors = Array.isArray(failure?.errors) ? failure.errors : [];

  const described = errors.slice(0, 3).map((error) => {
    const code = error?.errorCode && typeof error.errorCode === "object" ? Object.entries(error.errorCode)[0] : null;
    // The index is the operation's position in the request we sent. We send one
    // conversion, so it is always 0 -- it is read anyway because the day
    // anybody batches, an error reported against the wrong row is the failure
    // that is impossible to see afterwards.
    const index = error?.location?.fieldPathElements?.[0]?.index;
    const at = Number.isFinite(Number(index)) ? ` at conversions[${Number(index)}]` : "";
    return [code ? `${code[0]}: ${code[1]}` : "", String(error?.message ?? "")].filter(Boolean).join(" -- ") + at;
  });

  const message =
    described.filter(Boolean).join("; ") ||
    [status.status, status.message].filter(Boolean).join(": ") ||
    "error reported with no message";

  return { partial: Boolean(partial), message: String(message).slice(0, 200) };
}

/**
 * Whether the body actually confirms the one conversion we sent.
 *
 * `results` is index-aligned with the request's `conversions`, and Google's own
 * words are that the "proto will be empty for rows that received an error" --
 * so a successful row is a non-empty object and a failed one is a literal `{}`.
 * An empty object with no `partialFailureError` beside it should not happen; if
 * it does, it is not a send.
 */
function acceptedOneConversion(body) {
  const results = Array.isArray(body?.results) ? body.results : null;
  if (!results || results.length === 0) return false;
  const first = results[0];
  return Boolean(first) && typeof first === "object" && Object.keys(first).length > 0;
}

/**
 * The HTTP exchange, as a status word.
 *
 * **A 200 is not delivery, and that is the whole of this function.** With
 * `partialFailure` on -- which Google says to always set -- a refused
 * conversion comes back as HTTP 200 with the reason inside
 * `partialFailureError`, and Google's own error table maps "no error" to HTTP
 * 200 precisely so that it can tell the two apart in the body. Classifying on
 * the status code alone would record `sent` for a conversion Google threw away.
 *
 * This is the failure that cost this project a month on Meta -- a provider
 * accepting and discarding while our row read `sent` -- and the lesson is
 * written into meta.js. So the body is read, and the body has to SAY the
 * conversion was taken:
 *
 *   An error in a 200 is a refusal: `rejected`, not `sent`.
 *
 *   A 200 whose body could not be read is NOT a send. **This is the opposite of
 *   what openai.js does with the same situation, and the difference is the
 *   reason.** OpenAI documents no response shape at all, so an empty body there
 *   is the API behaving as documented; Google documents `results` and
 *   `partialFailureError` exactly, so a body we cannot read means a proxy
 *   answered instead of Google and the outcome is genuinely unknown. Retryable:
 *   the request may well have landed, and `orderId` is what makes repeating it
 *   safe.
 *
 *   A 200 with no result for our conversion is the same unknown, for the same
 *   reason -- except under `validateOnly`, where Google states that "results are
 *   not returned", so there is no confirmation to miss. That is why
 *   `expectResults` is a parameter rather than inferred: a validated request
 *   that read as unconfirmed would spend every row's retry budget.
 *
 * `rejected` rather than `failed` on a permanent refusal, which is the
 * vocabulary the other four senders settled on: planRetry writes `failed` the
 * moment a retryable outcome runs out of attempts, so with one word for both, a
 * developer token with no access to this account would read on the destination
 * card exactly like a transport outage.
 */
export function classifyGoogleOutcome({
  transportError,
  httpStatus: rawStatus,
  body,
  bodyTimedOut,
  bodyUnreadable,
  expectResults = true,
} = {}) {
  if (transportError) {
    return {
      status: "failed",
      retryable: true,
      detail: `transport: ${String(transportError?.message || transportError).slice(0, 200)}`,
    };
  }

  const httpStatus = Number(rawStatus) || 0;
  const error = readGoogleError(body);
  const reported = error ? error.message : "";
  // bodyTimedOut before bodyUnreadable: a timeout IS an unreadable body, and
  // "the body never arrived" is the more useful of the two things to be told.
  const unread = bodyTimedOut ? "body timed out" : bodyUnreadable ? "unreadable body" : "";
  const withDetail = (suffix) => (suffix ? `http ${httpStatus} ${suffix}` : `http ${httpStatus}`);

  // The rule all five senders share, written once in transientHttp.js.
  if (isTransientHttpStatus(httpStatus)) {
    return { status: "failed", retryable: true, detail: withDetail(reported || unread) };
  }

  if (httpStatus >= 200 && httpStatus < 300) {
    if (error) {
      // Every documented per-conversion refusal is permanent on the timescale
      // this retries on. `EXPIRED_EVENT` (the click is older than the action's
      // lookback window), `CONVERSION_PRECEDES_EVENT`, `DUPLICATE_ORDER_ID` and
      // `INVALID_CONVERSION_ACTION_TYPE` are all facts about the row or the
      // account. `TOO_RECENT_CONVERSION_ACTION` asks for six hours, which three
      // attempts five minutes apart cannot wait out -- so it settles `rejected`
      // and the resend control is what sends it, deliberately and once.
      //
      // `CLICK_NOT_FOUND` is the one to expect in volume rather than to alarm
      // at: Google's own advice is to "treat this error as a warning unless it
      // occurs with the majority of your conversions", since a click made
      // through another account or not yet processed produces it. It lands here
      // as `rejected` with the code in the detail, which is visible and
      // resendable, rather than being quietly called a send.
      return { status: "rejected", retryable: false, detail: withDetail(reported) };
    }

    if (unread) {
      return { status: "failed", retryable: true, detail: withDetail(unread) };
    }

    if (expectResults && !acceptedOneConversion(body)) {
      return { status: "failed", retryable: true, detail: withDetail("no result for the conversion") };
    }

    return { status: "sent", retryable: false, detail: withDetail("") };
  }

  // Everything else is permanent and about the account or the credentials
  // rather than the row, and the detail names the enum because four failures
  // here look alike from the outside and have four different fixes:
  //
  //   `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` -- the Cloud project is still
  //   at Test level. Somebody applies for Explorer in the Cloud Console. (Only
  //   v26 and v25 name it; v24 and earlier answer the generic
  //   ACTION_NOT_PERMITTED, which is one of the reasons the default version is
  //   not older.)
  //
  //   `USER_PERMISSION_DENIED` -- the authorising user cannot reach this
  //   customer, or `login-customer-id` is missing while reaching it through a
  //   manager account.
  //
  //   `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE` -- the one to know about,
  //   because it is not a defect in anything above and no access level clears
  //   it: Google restricted `uploadClickConversions` on 2026-06-15 to tokens
  //   that had already used it between December 2025 and that date, and directs
  //   everyone else to the Data Manager API. It is a different enum family from
  //   the access-level errors (`NotAllowlistedError`, not
  //   `AuthorizationError`), which is why Explorer access would not answer it.
  //
  //   An expired or revoked refresh token, which never reaches here -- it fails
  //   at the exchange, with `access token:` leading its detail.
  return { status: "rejected", retryable: false, detail: withDetail(reported || unread) };
}

/**
 * One conversion, uploaded. Never throws, and never puts a secret in its result.
 *
 * The access token is taken from the cache (getGoogleAccessToken), so the
 * common case is one HTTP request per conversion and not two.
 */
export async function uploadGoogleConversion({
  fetchImpl = fetch,
  apiHost = GOOGLE_ADS_API_HOST,
  apiVersion = GOOGLE_ADS_API_VERSION,
  customerId,
  loginCustomerId,
  developerToken,
  clientId,
  clientSecret,
  refreshToken,
  tokenUrl,
  payload,
  now,
} = {}) {
  const token = await getGoogleAccessToken({ fetchImpl, tokenUrl, clientId, clientSecret, refreshToken, now });
  if (token.failure) {
    // Not an upload that failed -- no upload was made. It reads as a retryable
    // or permanent failure exactly as the exchange itself was, and the detail
    // says which step it belongs to.
    return { status: "failed", retryable: token.failure.retryable, detail: token.failure.detail };
  }

  const secrets = [clientSecret, refreshToken, token.accessToken, developerToken];

  let response;
  try {
    response = await fetchImpl(uploadClickConversionsUrl(apiHost, apiVersion, customerId), {
      method: "POST",
      headers: googleHeaders({ accessToken: token.accessToken, developerToken, loginCustomerId }),
      body: JSON.stringify(payload),
      // Bounded: a stall aborts with a TimeoutError, which lands in the catch
      // below as a retryable transport failure.
      signal: sendTimeoutSignal(),
    });
  } catch (transportError) {
    const message = redactSecrets(transportError?.message || transportError || "unknown", secrets);
    return classifyGoogleOutcome({ transportError: { message } });
  }

  let body = null;
  let bodyTimedOut = false;
  let bodyUnreadable = false;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
    bodyUnreadable = true;
    // The timeout signal covers reading the body as well as the headers.
    bodyTimedOut = error?.name === "TimeoutError";
  }

  const outcome = classifyGoogleOutcome({
    httpStatus: response?.status,
    body,
    bodyTimedOut,
    bodyUnreadable,
    // Google returns no `results` for a validated request, so the confirmation
    // this would otherwise insist on does not exist. Read off the payload we
    // actually sent rather than from configuration, so the two cannot disagree.
    expectResults: !payload?.validateOnly,
  });
  // A provider that echoed a credential back in its message must not put it in
  // the row, which is read straight into the admin table.
  return { ...outcome, detail: redactSecrets(outcome.detail, secrets) };
}
