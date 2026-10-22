import { sendTimeoutSignal } from "./sendTimeout.js";
import { isTransientHttpStatus } from "./transientHttp.js";
// The one currency allowlist this service reports in, and the one stage that
// carries money -- imported, not restated, exactly as meta.js and openai.js
// import them. A third opinion about which codes are reportable is how the same
// deposit gets priced on two platforms and dropped on the third.
import { isoCurrency, DEPOSIT_VALUE_STAGE } from "./depositValue.js";

/**
 * TWO Google APIs, and they are not interchangeable.
 *
 * `googleads.googleapis.com` is still used, for exactly one thing: turning a
 * conversion action's NAME into its numeric id (resolveGoogleConversionAction).
 * That is a read, it needs the `adwords` scope, and it is why the three action
 * ids stay out of configuration.
 *
 * `datamanager.googleapis.com` is where the conversion itself now goes.
 * `ConversionUploadService.UploadClickConversions` answered this account with
 * HTTP 200 carrying `notAllowlistedError:
 * CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE -- New integrations for uploading
 * click conversions should use the Data Manager API` on 2026-10-22, with a real
 * conversion in the request. That restriction is not an access level and no
 * approval clears it, so the ingestion call moved and everything upstream of it
 * -- OAuth, the token exchange, resolution by name, the gclid, the value pair,
 * the outcome classifier -- did not.
 */
export const GOOGLE_ADS_API_HOST = "https://googleads.googleapis.com";

/**
 * The Google Ads API version, in the REST path of the ONE call still made to it.
 *
 * **Configurable because it expires.** Google releases a version every three or
 * four months and sunsets each one about a year after its release; a sunset
 * version does not degrade, it stops answering. So this is a value an operator
 * can move with a restart (GOOGLE_ADS_API_VERSION) rather than a deploy, and
 * `v26` is the current one -- released 2026-10-14, sunset November 2027.
 * Confirmed against developers.google.com/google-ads/api/docs/sunset-dates on
 * 2026-10-21.
 */
export const GOOGLE_ADS_API_VERSION = "v26";

/** Where a refresh token is exchanged for the hour-long access token. One
 *  exchange serves both APIs: the token minted from our refresh token carries
 *  both scopes (see DATA_MANAGER_SCOPE). */
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The Data Manager API's host. */
export const DATA_MANAGER_API_HOST = "https://datamanager.googleapis.com";

/**
 * The Data Manager API version in the REST path, and the reason it is a constant
 * where the Google Ads one is an env var.
 *
 * The two expire differently. Google Ads ships `v24`, `v25`, `v26` as separate
 * paths and sunsets each about a year on. Data Manager has shipped one path,
 * `v1`, since it went generally available (2025-12-09); its releases are minor
 * -- v1.3, v1.6, v1.8 -- and none of them changes the path or retires the one
 * before it. So there is nothing yet for an operator to move, and an env var
 * for it would be a knob whose only use is to break the integration.
 * GOOGLE_DATA_MANAGER_HOST exists for the case of pointing this somewhere else
 * entirely.
 */
export const DATA_MANAGER_API_VERSION = "v1";

/**
 * The scope the ingestion calls need, recorded here because it is a different
 * one from the reads.
 *
 * Google: the Data Manager API "requires credentials with a different scope
 * than the Google Ads API". Both are requested in one consent by
 * scripts/google-ads-refresh-token.mjs (ce092b8), so one refresh token serves
 * both calls -- but **a refresh token minted before 2026-10-22 carries only
 * `adwords`**, and scopes are not additive on an existing token. Such a token
 * resolves conversion actions perfectly and is refused by every ingest with
 * `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, which readDataManagerError names so the fix
 * is "re-run the script" rather than a hunt.
 *
 * Not sent anywhere: a scope is a property of the token, not of a request. This
 * is here to be read.
 */
export const DATA_MANAGER_SCOPE = "https://www.googleapis.com/auth/datamanager";

/** `destinations[].operatingAccount.accountType` for a Google Ads account.
 *  Google: "Set `accountType` to `GOOGLE_ADS` and `accountId` to your 10-digit
 *  Google Ads customer ID (without hyphens)." */
export const GOOGLE_ADS_ACCOUNT_TYPE = "GOOGLE_ADS";

/** `events[].eventSource`, required on every event. Every conversion this
 *  service reports began as a click on the website, so WEB is the truth for all
 *  of them rather than a default. */
export const GOOGLE_EVENT_SOURCE = "WEB";

/**
 * One Google Ads CONVERSION ACTION per funnel stage, by NAME.
 *
 * **Google is a different shape from the other three destinations: there is no
 * event name on the wire.** Each stage maps to a conversion action created in
 * the Google Ads UI, and the ingest names it by NUMERIC ID in
 * `destinations[].productDestinationId` -- Google's wording is "The ID of the
 * Google Ads conversion action in the `operatingAccount` that receives the
 * events", taken from the `id` field of `conversion_action`, NOT from its
 * resource name. These three were created 2026-10-21 as "Website (Import from
 * clicks)" actions -- `UPLOAD_CLICKS`, which is the type the Data Manager API
 * requires for offline events -- with a 90-day click-through window and
 * Count = One.
 *
 * **The names are here and the ids are not, deliberately, and the move to the
 * Data Manager API does not change that.** A hardcoded numeric id is
 * unreadable, unverifiable against the UI, and wrong in exactly the way nobody
 * notices: it ingests successfully into whatever action now holds that id. The
 * name is resolved to its id once per process (resolveGoogleConversionAction)
 * and a name that does not resolve fails loudly rather than guessing. That the
 * wire now wants the bare id rather than the resource name is a reason to make
 * the resolver return the id, not a reason to move three numbers into .env.
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
 * The account's own UTC offset, and what it does and does NOT decide now.
 *
 * **This changed meaning with the API and the change is easy to miss.**
 * `uploadClickConversions` took `conversionDateTime`, a LOCAL WALL CLOCK
 * (`"yyyy-mm-dd hh:mm:ss+|-hh:mm"`) whose offset told Google which instant the
 * digits beside it named -- so writing UTC digits under a `+04:00` label, or
 * Dubai digits under a `Z`, moved the conversion by a DAY at the boundary.
 *
 * The Data Manager API takes `eventTimestamp`, a proto3 `Timestamp`: RFC 3339,
 * and "offsets other than 'Z' are also accepted". A Timestamp is an INSTANT.
 * `2026-10-22T02:30:00+04:00` and `2026-10-21T22:30:00Z` are the same instant
 * and Google files them identically -- it is Google that converts to the
 * account's zone for reporting, from the account's own setting, not from
 * anything in our string.
 *
 * So the offset is now **presentational**: it decides how the timestamp reads to
 * a person, not which day the conversion lands on. It is kept, written in the
 * account's zone (GMT+04:00, confirmed in the account's settings), because a
 * stamp a reader can compare to the Google Ads UI without arithmetic is worth
 * having and because the formatter that produces it is the one that cannot read
 * the IIS host's own timezone. What it no longer is, is load-bearing -- and
 * saying so here is cheaper than somebody later rediscovering that
 * GOOGLE_ADS_TIMEZONE_OFFSET cannot shift a conversion any more.
 */
export const GOOGLE_ADS_ACCOUNT_OFFSET = "+04:00";

/** The configured offset's accepted shape: a sign, two digits, a colon, two
 *  digits. Deliberately refuses `Z` and a bare `+04` -- both are readable as
 *  "the author meant UTC" and one of them is the mistake this module exists to
 *  make impossible. */
const UTC_OFFSET_RE = /^([+-])(\d{2}):(\d{2})$/;

const text = (v) => String(v ?? "").trim();

/** Digits only: an operator copying a customer id out of the UI gets
 *  `474-306-7250`, and Google's own instruction for `accountId` is "your
 *  10-digit Google Ads customer ID (without hyphens)". */
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
  // is a typo, and although a Timestamp's offset no longer moves the conversion
  // (see GOOGLE_ADS_ACCOUNT_OFFSET) a malformed one would be refused outright.
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
 * `received_at` as `yyyy-mm-ddThh:mm:ss+hh:mm`, or "".
 *
 * **An RFC 3339 `T`, not `conversionDateTime`'s space.** That is the one
 * character the format change turns on, and the old separator is not a laxer
 * spelling of this one: a proto3 `Timestamp` parses RFC 3339 and refuses a space
 * where the `T` belongs, so the previous formatter's output would be rejected by
 * the field this one feeds. Seconds precision with no fractional digits, which
 * proto3 JSON accepts ("0, 3, 6 or 9 fractional digits" is what Google
 * GENERATES).
 *
 * **Every field is read with a getUTC* accessor off a shifted instant, and that
 * is the whole technique.** The local getters would read the IIS host's own
 * zone, so the same row would stamp differently on a server somebody moved --
 * and the offset text beside it would then be a lie about the digits it labels.
 * Shifting the instant and reading it as UTC makes the output depend on nothing
 * but the row and the offset. It matters less than it did now that the offset is
 * presentational (see GOOGLE_ADS_ACCOUNT_OFFSET), and it is kept because a
 * timestamp that quietly follows the host's timezone is a bug waiting for the
 * next host move, not because the day depends on it.
 *
 * The offset is written from the same number the shift used, for the same
 * reason: two independent writings of "+04:00" can disagree, and the one that
 * matters is the one the digits were computed with.
 */
export function googleEventTimestamp(receivedAt, offset = GOOGLE_ADS_ACCOUNT_OFFSET) {
  const ms = instantMs(receivedAt);
  if (ms === null) return "";
  const minutes = parseUtcOffsetMinutes(offset);
  if (minutes === null) return "";

  const at = new Date(ms + minutes * 60_000);
  const date = `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
  const sign = minutes < 0 ? "-" : "+";
  return `${date}T${time}${sign}${pad(Math.trunc(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

/**
 * `<crm_client_id>:<stage>` as the event's `transactionId` -- the row's existing
 * identity, not a third scheme.
 *
 * **This is the deduplication, and under the Data Manager API it carries more
 * weight than it did.** Google's offline guide calls `transactionId` optional
 * and says it "is used for deduplication"; it is the order-id equivalent and the
 * same uniqueness rule applies, one per conversion action. What the API dedupes
 * on when no transaction id is sent is documented nowhere.
 *
 * It matters more because the ingest is now ASYNCHRONOUS. A 200 means "accepted
 * for processing" and the outcome arrives hours later, so there is one window
 * this service cannot close by itself: the process dies between the ingest
 * leaving and `google_request_id` being written, the next sweep finds no request
 * id and ingests again. The row cannot tell those apart -- nothing it holds
 * distinguishes "never sent" from "sent and unrecorded" -- so this id is what
 * makes the repeat the same conversion rather than a second one. It is not
 * optional for us.
 *
 * The id is the same `<client>:<stage>` Meta's `event_id` and OpenAI's event id
 * are built from, so one funnel event has one identity across all three
 * platforms. A fourth scheme would be a fourth thing to keep consistent.
 *
 * Empty for a client with no id. ":verified" would not merely lose the
 * deduplication, it would be the SAME transaction id for every such client.
 */
export function googleTransactionId({ crmClientId, stage } = {}) {
  const client = text(crmClientId);
  const s = text(stage);
  if (!client || !s) return "";
  return `${client}:${s}`;
}

/**
 * Whether this conversion is ours to ingest, and if not, why not.
 *
 * The configuration reasons come first and in the order an operator can act on
 * them, which is the ordering decideMetaSkip, decideBrevoSkip, decideWhatsappSkip
 * and decideOpenaiSkip all use: with nothing configured, every reason below is
 * also true, and "not configured" is the one worth reading. Each is named
 * separately because they live on different lines of .env and "not configured"
 * alone would not say which.
 *
 * The refresh token stands for the key. It is the credential neither call can be
 * made without and the one that is minted by hand
 * (scripts/google-ads-refresh-token.mjs), so its absence is what "this
 * destination is not set up" means.
 *
 * **There is no developer-token gate and no developer token anywhere in this
 * module any more.** Two facts, not one: Google Ads sunset developer tokens on
 * 2026-09-09 ("optional and ignored by the API servers", and they "will start
 * rejecting developer tokens in API calls in a future major version"), and the
 * Data Manager API documents no such header at all -- its destinations guide
 * says "Don't set request headers in an `IngestionService` request". A header
 * that is ignored today and refused tomorrow is not a bridge worth keeping, so
 * GOOGLE_ADS_DEVELOPER_TOKEN is no longer read. Access to both APIs is the
 * access level of the Google Cloud project that owns the OAuth client, granted
 * in the Cloud Console.
 *
 * **A row with no gclid is the one reason that is about the row rather than the
 * stage, and it is a skip rather than a send.** Google attributes a click
 * conversion on the gclid -- `adIdentifiers` is where it goes, and we configure
 * no `userData`, so there is no hashed-email fallback here as there is for Meta
 * and OpenAI. An ingest without one is a conversion Google counts against no
 * campaign at all. That inflates the account's conversion total while leaving
 * every campaign's own number unchanged, which is worse than a visible skip: it
 * corrupts the figure the bidding reads, and nothing in the account says where
 * it came from. Most signups are organic and carry no gclid, so this is the
 * commonest reason here and it is normal.
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
  // The customer id is `operatingAccount.accountId` -- it moved out of the URL
  // and into the body with the API, and it is just as required there: an ingest
  // with no operating account has no account to ingest into. The same shape as
  // OpenAI's missing pixel id, and a skip for the same reason: nothing was
  // attempted and nothing was refused.
  if (!digitsOnly(customerId)) return { reason: "google ads customer id not configured" };

  if (stage === GTM_OWNED_STAGE) return { reason: `${GTM_OWNED_STAGE} is owned by the GTM container` };
  if (!googleConversionActionFor(stage)) return { reason: "stage has no Google Ads conversion action" };

  if (!text(gclid)) return { reason: "no gclid: the click cannot be attributed in Google Ads" };

  return null;
}

/**
 * The event's `conversionValue` and `currency`, or NEITHER.
 *
 * **`valueDecimal`, not `amountMinor`, and that is the whole reason this is a
 * function rather than two lines at the call site.** `conversionValue` is a
 * plain `number`: a $54.49 deposit is `54.49`. OpenAI's `amount` on the very
 * same lookup is the minor-unit integer `5449`, and **Google would accept that
 * number without a word** -- as a $5,449 deposit. A hundredfold overstatement,
 * in the direction that tells Smart Bidding to buy much more of that traffic.
 *
 * It is not micros either, which is the other half of the trap: the Google Ads
 * API states money in micros nearly everywhere (`amountMicros`, `costMicros`),
 * so the mistake is inviting from both sides. Conversion value is neither.
 *
 * So the unit is carried by the field name, and googleAds.test.js pins the pair
 * with a deposit whose decimal and minor-unit forms genuinely differ. A test
 * using a round number would pass with the units crossed.
 *
 * The field is `currency` here and was `currencyCode` on the old API -- renamed
 * on the wire, same ISO 4217 value. The code is checked against the
 * **allowlist** rather than a three-letter shape, as both other destinations do:
 * `/^[A-Z]{3}$/` is the gate that let `BTC` through once on this branch, and a
 * shape test cannot tell `BRL` from `BTC`. `isoCurrency` and not
 * `settlementCurrency` -- this refuses an unsettled code, it does not settle
 * one, because the amount beside it has already been scaled.
 *
 * Both or neither: a value with no currency is a number with no unit. Both are
 * documented optional, so Google would take the value alone and price it in
 * whatever the account assumes.
 */
export function googleValueFields(depositValue) {
  const currency = isoCurrency(depositValue?.currency);
  const value = Number(depositValue?.valueDecimal);
  if (!currency) return {};
  if (!Number.isFinite(value) || !(value > 0)) return {};
  return { conversionValue: value, currency };
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
 * The alternative was ingesting the conversion with no value, which Google
 * accepts. It is refused for the reason openai.js refuses it: `transactionId`
 * makes this conversion unique per action for ever, so an unpriced ingest now is
 * the FINAL word on that deposit's value and no later send can correct it. A
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
  if (googleValueFields(depositValue).currency) return null;

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

/** A `productDestinationId` has to be the conversion action's bare numeric id.
 *  Checked rather than trusted because the wrong value here is the worst kind of
 *  wrong available on this API: a resource name is a perfectly well-formed
 *  string, the ingest would answer 200, and the refusal would arrive hours later
 *  as an aggregate error count with no per-record identifier on it. */
const isNumericId = (v) => /^\d+$/.test(text(v));

/**
 * ONE conversion, as the single-event request it has to be.
 *
 * **One event per request, and this is not a style choice -- it is what makes a
 * per-request status a per-conversion status.** The Data Manager API accepts up
 * to 2,000 events, answers 200 for the whole request, and reports the real
 * outcome hours later through `requestStatus:retrieve` as
 * `errorInfo.errorCounts[]` of `{reason, recordCount}`. **There is no per-record
 * identifier anywhere in that reply.** So a batch of five that comes back
 * `PARTIAL_SUCCESS` with `recordCount: 2` names no rows: two of those five
 * conversions do not exist and nothing can say which, and every one of the five
 * would have to be settled on a guess. With one event per request, one
 * `requestId` is one conversion and `SUCCESS`/`FAILED` is that conversion's own
 * answer.
 *
 * The cost is request count, and it is affordable: Google's limit is 300
 * requests a minute and 100,000 a day per Cloud project, with the
 * IngestionService holding its own allowance. This service ingests on the order
 * of ten conversions a day and polls each up to 25 times, so a few hundred
 * requests against a hundred thousand.
 *
 * **No `consent`.** Both `adUserData` and `adPersonalization` are documented
 * optional, and we have not collected either signal. Sending `CONSENT_GRANTED`
 * because the sample payload does would be a claim about the client that nobody
 * here is in a position to make; if Google ever requires it, the polls will say
 * so with `PROCESSING_ERROR_REASON_DENIED_CONSENT` and that is a visible answer.
 *
 * **No `userData`, no `encoding`, no `encryptionInfo`.** Hashed identifiers here
 * would be an enhanced-conversions setup nobody has configured on this account,
 * and `encoding` is documented as required only for `UserData` uploads -- which
 * is why omitting the identifiers and omitting the encoding have to be the same
 * decision.
 *
 * `loginAccount` only when a manager account is configured. It is where
 * `login-customer-id` went: the Data Manager API takes no request headers on an
 * ingest, so reaching the customer THROUGH a manager is stated in the body. Left
 * out otherwise, because Google documents it as defaulting to the operating
 * account -- and because the status retrieval has to be made through the same
 * access path, so a `loginAccount` nobody needs would be a second place for that
 * path to be wrong.
 *
 * **Returns null rather than a request that is invalid by construction** --
 * every case where a required field has no value: an unmapped stage, an
 * unresolved conversion action, an action id that is not a number, no gclid, no
 * customer id, no client id, a `received_at` that is not a time.
 * decideGoogleSkip already refuses most of these with a reason that lands in the
 * row; this is the second half of that one test, not a second opinion, because
 * "no payload" is a louder way to be wrong than a malformed one.
 */
export function buildGoogleIngest({
  stage,
  crmClientId,
  gclid,
  conversionActionId,
  customerId,
  loginCustomerId,
  receivedAt,
  offset = GOOGLE_ADS_ACCOUNT_OFFSET,
  depositValue,
  validateOnly,
} = {}) {
  if (!googleConversionActionFor(stage)) return null;

  // The NUMERIC id the caller resolved from the action's name. Refused here
  // rather than attached behind an `if`: an ingest with no product destination
  // is not a conversion, and one carrying a resource name is worse than none.
  if (!isNumericId(conversionActionId)) return null;

  const account = digitsOnly(customerId);
  if (!account) return null;

  const click = text(gclid);
  if (!click) return null;

  const transactionId = googleTransactionId({ crmClientId, stage });
  if (!transactionId) return null;

  const eventTimestamp = googleEventTimestamp(receivedAt, offset);
  if (!eventTimestamp) return null;

  const destination = {
    operatingAccount: { accountType: GOOGLE_ADS_ACCOUNT_TYPE, accountId: account },
    productDestinationId: text(conversionActionId),
  };
  const manager = digitsOnly(loginCustomerId);
  if (manager) destination.loginAccount = { accountType: GOOGLE_ADS_ACCOUNT_TYPE, accountId: manager };

  const event = {
    adIdentifiers: { gclid: click },
    transactionId,
    eventTimestamp,
    eventSource: GOOGLE_EVENT_SOURCE,
  };

  // Only the deposit stage carries money, and the stage that does is named by
  // depositValue.js rather than by a literal here. Every other stage passes no
  // depositValue and carries no pair -- decideGoogleValueFailure is what stops
  // this stage sending without one.
  if (stage === DEPOSIT_VALUE_STAGE) Object.assign(event, googleValueFields(depositValue));

  const payload = { destinations: [destination], events: [event] };
  // Omitted rather than sent as false. A validated request "is validated but not
  // executed, and only errors are returned" -- so it records nothing AND there
  // is no request to poll, which classifyGoogleIngest has to be told about
  // rather than read as a missing request id.
  if (validateOnly) payload.validateOnly = true;

  return payload;
}

/** GAQL quotes string literals with single quotes, so a name carrying one would
 *  end the literal early. Our three names are constants that contain neither,
 *  which is exactly why this is cheap insurance rather than a live concern. */
const gaqlLiteral = (value) => `'${text(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * The query that turns a conversion action's name into its NUMERIC ID.
 *
 * `conversion_action.id` leads the select list, and it is the field Google's own
 * Data Manager guide points at: take the id from the `id` field of
 * `conversion_action`, not from the resource name. The resource name is selected
 * beside it as the fallback only -- its last segment is the same number -- and
 * because it is what a person pastes into the UI's URL bar to check they are
 * looking at the right action.
 *
 * Three filters, each load-bearing:
 *
 *   `name` -- the lookup itself.
 *
 *   `type = 'UPLOAD_CLICKS'` -- the action must be an import-from-clicks one,
 *   which is what the Data Manager API's offline event ingestion requires
 *   ("must have `type` set to `UPLOAD_CLICKS`"; in the UI, "Website (Import from
 *   clicks)"). An account can hold a website tag and an import action with the
 *   same name, and ingesting into the wrong kind is refused at best and silently
 *   attributed to the wrong thing at worst -- and under this API that refusal
 *   would arrive hours later as an error count.
 *
 *   `status = 'ENABLED'` -- a removed action still resolves by name, and
 *   ingesting into one records nothing while answering 200.
 *
 * So a name that resolves here is one the ingest can actually use, which is
 * what lets resolveGoogleConversionAction treat "no rows" as a loud failure.
 * GAQL enums are quoted string literals, not bare words.
 */
export function conversionActionQuery(name) {
  return (
    "SELECT conversion_action.id, conversion_action.resource_name, conversion_action.name, " +
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

/** Where one conversion goes. No customer id in the path: the account is in the
 *  body now, as `destinations[].operatingAccount`. */
export const eventsIngestUrl = (host, version) =>
  `${text(host) || DATA_MANAGER_API_HOST}/${text(version) || DATA_MANAGER_API_VERSION}/events:ingest`;

/**
 * Where the real outcome is asked for, hours later.
 *
 * The request id travels on the query string, which is where Google documents it
 * ("The request body must be empty"). Nothing client-linked goes with it: a
 * request id is an opaque handle Google minted for one request of ours, and the
 * gclid, the transaction id and every credential stay out of every URL this
 * module builds -- so no request line, access log or proxy can carry one.
 */
export const requestStatusUrl = (host, version, requestId) =>
  `${text(host) || DATA_MANAGER_API_HOST}/${text(version) || DATA_MANAGER_API_VERSION}` +
  `/requestStatus:retrieve?requestId=${encodeURIComponent(text(requestId))}`;

/**
 * The headers the Google Ads lookup takes.
 *
 * `login-customer-id` is sent only when set, because it is required only when
 * reaching the customer THROUGH a manager account and wrong otherwise. Digits
 * only, for the same reason the customer id is: Google's own instruction is
 * "1234567890, not 123-456-7890".
 *
 * No `developer-token`, in any form: see decideGoogleSkip. The header must be
 * absent rather than present and empty, and the simplest way to guarantee that
 * is for this module to hold no developer token at all.
 */
function googleAdsHeaders({ accessToken, loginCustomerId }) {
  const headers = {
    Authorization: `Bearer ${text(accessToken)}`,
    "Content-Type": "application/json",
  };
  const manager = digitsOnly(loginCustomerId);
  if (manager) headers["login-customer-id"] = manager;
  return headers;
}

/**
 * The headers a Data Manager call takes, which is the bearer and nothing else.
 *
 * Google's destinations guide: "Don't set request headers in an
 * `IngestionService` request." The manager account, which used to be the
 * `login-customer-id` header, is a body field now (`loginAccount`), and the
 * status retrieval "accepts only a `request_id`, not destination accounts or
 * headers". So the shortest correct header set is the whole of the
 * instruction -- `json` is passed only when there is a body to type.
 */
function dataManagerHeaders({ accessToken, json = false }) {
  const headers = { Authorization: `Bearer ${text(accessToken)}` };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

/**
 * Whatever a message quoted back at us, with everything that must not be stored
 * taken out of it.
 *
 * Five things must never reach a log line or the `*_detail` column: the client
 * secret, the refresh token, the access token, and -- the one that is not a
 * credential -- the gclid. The structural half is that all the credentials
 * travel in a header or a form body and never in a URL, so no request line can
 * carry one; what remains is an error message that echoed one, and the detail is
 * both logged and stored.
 *
 * The gclid is in the list because it IS client-linked: it names one person's
 * click, Google echoes request content in validation messages, and `*_detail`
 * is read straight into the admin table. It is replaced wholesale rather than
 * shortened, because a prefix of a click id is still that click id's prefix.
 *
 * Encoded before raw, as sendOpenaiEvent does it: a value containing `%` has a
 * raw form that sits inside its encoded form (`%25` inside `%2525`), so the raw
 * pass must never run first.
 */
function redactEchoes(message, values) {
  let out = String(message ?? "");
  // Structural first: whatever follows "Bearer " is a token, in whatever form
  // the thrower wrote it.
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  const forms = values
    .map((s) => String(s ?? ""))
    .filter(Boolean)
    .flatMap((s) => [encodeURIComponent(s), s])
    .filter(Boolean);
  for (const form of forms) out = out.split(form).join("[redacted]");
  return out;
}

/**
 * How early a cached access token is replaced.
 *
 * Google's tokens last an hour. A token used in the last seconds of its life
 * works for the request that checked it and fails for the one in flight, so the
 * margin is what keeps a correct cache from producing a 401 on a boundary.
 */
export const GOOGLE_TOKEN_REFRESH_MARGIN_MS = 60_000;

// { key, accessToken, expiresAtMs }. One per process, shared by all three calls
// -- the Ads lookup, the ingest and the status retrieval -- because one refresh
// token mints one token carrying both scopes. A token per call would be three
// wasted round trips per conversion.
let accessTokenCache = null;

// name -> numeric conversion action id, for one customer and one API version.
// Successes only.
const conversionActionCache = new Map();

/** Both caches, emptied. Exported for the tests, which must not inherit a token
 *  or an action id from each other -- and for an operator reading this: nothing
 *  else empties them, so a conversion action renamed in the UI needs a restart
 *  to be seen. */
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
 *
 * The scopes a token carries are NOT visible here: Google's token response
 * includes a `scope` it is not obliged to echo, and a token minted before
 * 2026-10-22 looks identical to one minted after. A token short of
 * `datamanager` therefore passes this and is refused at the ingest, which is
 * where readDataManagerError names it.
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
    const message = redactEchoes(error?.message || error || "unknown", secrets);
    // `transport:` leads, as it does in every sender's own transport branch, and
    // the step follows it: the prefix is what a reader (and sendTimeout.contract.js)
    // recognises as "the request never completed", and `access token` is which
    // of this destination's requests it was.
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
        detail: `access token: http ${status} ${redactEchoes(named || "no reason given", secrets)}`.slice(0, 200),
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
 * The conversion action's NUMERIC ID, resolved from its name once.
 *
 * Cached per customer, per API version and per name, because a conversion
 * action's id does not change and asking for it on every ingest is a second
 * round trip per conversion.
 *
 * **It returns the id and no longer the resource name, because that is what the
 * wire wants.** `productDestinationId` is the bare number; a resource name there
 * is a well-formed string that would be accepted into an asynchronous request
 * and refused hours later as an unattributable error count. Read from
 * `conversion_action.id`, which is where Google's own guide says to take it
 * from, with the resource name's last segment as the fallback for a response
 * that carried one and not the other -- proto3 JSON renders an int64 as a
 * string, so both arrive as text and both are checked for being digits.
 *
 * **A name that does not resolve is a loud failure and never a guess.** Three
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
 *   A row with no readable id. Not possible from a healthy response and refused
 *   anyway, because the alternative is building an ingest around an empty
 *   `productDestinationId`.
 *
 * Returns `{ conversionActionId }` or `{ failure }`; never throws.
 */
export async function resolveGoogleConversionAction({
  fetchImpl = fetch,
  apiHost = GOOGLE_ADS_API_HOST,
  apiVersion = GOOGLE_ADS_API_VERSION,
  customerId,
  loginCustomerId,
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
  if (cached) return { conversionActionId: cached, cached: true };

  const token = await getGoogleAccessToken({ fetchImpl, tokenUrl, clientId, clientSecret, refreshToken, now });
  if (token.failure) return { failure: token.failure };

  const secrets = [clientSecret, refreshToken, token.accessToken];
  let response;
  try {
    response = await fetchImpl(searchUrl(apiHost, apiVersion, customerId), {
      method: "POST",
      headers: googleAdsHeaders({ accessToken: token.accessToken, loginCustomerId }),
      // `pageSize` is deliberately absent: Google answers
      // PAGE_SIZE_NOT_SUPPORTED when it is sent in the body at all.
      body: JSON.stringify({ query: conversionActionQuery(name) }),
      signal: sendTimeoutSignal(),
    });
  } catch (error) {
    const message = redactEchoes(error?.message || error || "unknown", secrets);
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
    const reported = readGoogleAdsError(body);
    return {
      failure: {
        detail: `conversion action ${name}: http ${status} ${redactEchoes(reported?.message || "no reason given", secrets)}`.slice(
          0,
          200
        ),
        retryable: isTransientHttpStatus(status),
      },
    };
  }

  const rows = Array.isArray(body?.results) ? body.results : [];
  // The id, or the last segment of the resource name, whichever the row
  // actually carried -- and only if it is all digits, because neither
  // `undefined` nor `customers/.../conversionActions/...` is an id.
  const ids = rows
    .map((row) => {
      const id = text(row?.conversionAction?.id);
      if (isNumericId(id)) return id;
      const tail = text(row?.conversionAction?.resourceName).split("/").pop();
      return isNumericId(tail) ? tail : "";
    })
    .filter(Boolean);

  if (rows.length === 0) {
    return {
      failure: {
        detail: `conversion action ${name} did not resolve: no enabled UPLOAD_CLICKS action of that name`,
        retryable: false,
      },
    };
  }
  if (rows.length > 1) {
    return {
      failure: {
        detail: `conversion action ${name} is ambiguous: ${rows.length} enabled UPLOAD_CLICKS actions share the name`,
        retryable: false,
      },
    };
  }
  if (ids.length !== 1) {
    return {
      failure: {
        detail: `conversion action ${name} resolved to a row with no numeric id`,
        retryable: false,
      },
    };
  }

  conversionActionCache.set(cacheKey, ids[0]);
  return { conversionActionId: ids[0], cached: false };
}

/** The suffix of the one `details` element that carries a Google Ads failure.
 *  Matched on the suffix and not the whole `@type`, which is version-pinned --
 *  `...v26.errors.GoogleAdsFailure` -- so a full-string match would stop reading
 *  errors on the first version bump. */
const GOOGLE_ADS_FAILURE_TYPE = "GoogleAdsFailure";

/** `google.rpc.ErrorInfo`, which is where every Google API puts the machine
 *  `reason` for a refusal -- `ACCESS_TOKEN_SCOPE_INSUFFICIENT`,
 *  `SERVICE_DISABLED`, `RESOURCE_EXHAUSTED`. Matched on the suffix for the same
 *  reason as above. */
const RPC_ERROR_INFO_TYPE = "google.rpc.ErrorInfo";

/**
 * What a Google Ads body says went wrong, or null.
 *
 * Only the conversion-action lookup reaches this now -- the ingest has its own
 * reader below -- so `partialFailureError` is gone with the upload it belonged
 * to. A non-2xx from `googleAds:search` carries `error` as a `google.rpc.Status`
 * with `status` (PERMISSION_DENIED, INVALID_ARGUMENT) and a message, and its
 * `details` may pack one `GoogleAdsFailure` whose `errors[]` each carry an
 * `errorCode` object with a single key naming the enum. The enum is the part
 * worth storing: the prose repeats it at length, and the detail column holds 500
 * characters.
 */
export function readGoogleAdsError(body) {
  if (!body || typeof body !== "object") return null;

  const status = body.error;
  if (status === null || status === undefined || status === false || status === "") return null;
  if (typeof status !== "object") return { message: String(status).slice(0, 200) };

  const details = Array.isArray(status.details) ? status.details : [];
  const failure = details.find((d) => String(d?.["@type"] ?? "").endsWith(GOOGLE_ADS_FAILURE_TYPE));
  const errors = Array.isArray(failure?.errors) ? failure.errors : [];

  const described = errors.slice(0, 3).map((error) => {
    const code = error?.errorCode && typeof error.errorCode === "object" ? Object.entries(error.errorCode)[0] : null;
    return [code ? `${code[0]}: ${code[1]}` : "", String(error?.message ?? "")].filter(Boolean).join(" -- ");
  });

  const message =
    described.filter(Boolean).join("; ") ||
    [status.status, status.message].filter(Boolean).join(": ") ||
    "error reported with no message";

  return { message: String(message).slice(0, 200) };
}

/**
 * What a Data Manager body says went wrong, or null.
 *
 * A different shape from the Google Ads one and read by its own function rather
 * than by a widened version of it: there is no `partialFailureError` and no
 * `GoogleAdsFailure` here, and the piece worth having is `details[]`'s
 * `google.rpc.ErrorInfo.reason`. That is the enum that tells the four failures
 * apart, and they have four different fixes:
 *
 *   `ACCESS_TOKEN_SCOPE_INSUFFICIENT` -- the refresh token predates 2026-10-22
 *   and carries only `adwords`. Re-run scripts/google-ads-refresh-token.mjs;
 *   scopes are not additive on an existing token.
 *
 *   `SERVICE_DISABLED` -- the Data Manager API is not enabled on the Cloud
 *   project that owns the OAuth client.
 *
 *   `PERMISSION_DENIED` on the operating account -- the authorising user cannot
 *   reach it, or reaches it through a manager that `loginAccount` does not name.
 *   Google's rule is stricter for the status retrieval than for the ingest: the
 *   same access path, including `login_account`, and Read-only access is refused.
 *
 *   `RESOURCE_EXHAUSTED` -- the 300-a-minute or 100,000-a-day project quota,
 *   which arrives as a 429 and is therefore retried rather than settled.
 *
 * `status` is kept alongside the reason because the two are not the same thing
 * and the reason is often absent: `status` is the canonical code
 * (PERMISSION_DENIED) and `reason` the specific cause within it.
 */
export function readDataManagerError(body) {
  if (!body || typeof body !== "object") return null;

  const error = body.error;
  if (error === null || error === undefined || error === false || error === "") return null;
  if (typeof error !== "object") return { message: String(error).slice(0, 200) };

  const details = Array.isArray(error.details) ? error.details : [];
  const info = details.find((d) => String(d?.["@type"] ?? "").endsWith(RPC_ERROR_INFO_TYPE));
  const reason = text(info?.reason);

  const message =
    [reason, error.status, error.message].filter(Boolean).join(": ") || "error reported with no message";
  return { reason, message: String(message).slice(0, 200) };
}

/**
 * The non-blocking warnings a 200 may carry, as a short phrase or "".
 *
 * `reason` and `field` only, never `description`. The description is prose
 * Google writes about one row and may quote that row's own values back -- which
 * on this payload means the gclid -- and this string is stored in a column the
 * admin table prints. The enum and the field path say what to look at without
 * repeating what was sent.
 */
export function describeFieldWarnings(body) {
  const warnings = Array.isArray(body?.fieldWarnings) ? body.fieldWarnings : [];
  const described = warnings
    .slice(0, 3)
    .map((warning) => [text(warning?.reason), text(warning?.field)].filter(Boolean).join(" at "))
    .filter(Boolean);
  return described.length ? `warnings: ${described.join("; ")}` : "";
}

/**
 * The ingest's HTTP exchange, as a status word and a request id.
 *
 * **A 200 is not delivery, and under this API it is not even an attempt that
 * has been judged.** The Data Manager API answers 200 for "accepted for
 * asynchronous processing"; the body carries a `requestId` and nothing about
 * whether the conversion will be recorded. The real answer arrives from
 * `requestStatus:retrieve` up to 24 hours later.
 *
 * So the only honest status for an accepted ingest is **`retrying`** -- not
 * `sent`. This project has been bitten twice by the other reading: Meta
 * answering 200 with `events_received: 1` and discarding the event, and
 * `uploadClickConversions` answering 200 on 2026-10-22 with a refusal inside it.
 * An accepted-but-unconfirmed conversion is not a delivered one, and `sent` is a
 * word the resend control cannot reach back through.
 *
 * `retrying` with `retryable: true` is also the fail-safe default: a caller that
 * ignored `requestId` and simply wrote this status would leave the row
 * claimable, which costs one early poll. The opposite default -- a status word
 * that means nothing to SETTLED -- would leave the row claimed for ever.
 *
 *   An error in a 200 is a refusal: `rejected`. The API does not do this, which
 *   is why it is read anyway.
 *
 *   A 200 whose body could not be read is NOT a send AND NOT a settled failure:
 *   the request may well have been accepted, and without the body there is no
 *   request id to confirm it with. Retryable, and `transactionId` is what makes
 *   the repeat the same conversion.
 *
 *   A 200 with no request id is the harder case and it settles `rejected`. The
 *   conversion may have been accepted and there is no handle left to ask about
 *   it -- so it can never be confirmed, and it must not be ingested again on a
 *   clock either, because each repeat would be another unconfirmable request.
 *   The detail says exactly that. Under `validateOnly` there is no request id to
 *   miss, which is why `expectRequestId` is a parameter rather than inferred: a
 *   validated request read as unconfirmable would settle every row `rejected`.
 *
 * `rejected` rather than `failed` on a permanent refusal, which is the
 * vocabulary all five senders settled on: planRetry writes `failed` the moment a
 * retryable outcome runs out of attempts, so with one word for both, an
 * unenabled API would read on the destination card exactly like a transport
 * outage.
 */
export function classifyGoogleIngest({
  transportError,
  httpStatus: rawStatus,
  body,
  bodyTimedOut,
  bodyUnreadable,
  expectRequestId = true,
} = {}) {
  if (transportError) {
    return {
      status: "failed",
      retryable: true,
      detail: `transport: ${String(transportError?.message || transportError).slice(0, 200)}`,
    };
  }

  const httpStatus = Number(rawStatus) || 0;
  const error = readDataManagerError(body);
  const reported = error ? error.message : "";
  // bodyTimedOut before bodyUnreadable: a timeout IS an unreadable body, and
  // "the body never arrived" is the more useful of the two things to be told.
  const unread = bodyTimedOut ? "body timed out" : bodyUnreadable ? "unreadable body" : "";
  const withDetail = (suffix) => (suffix ? `http ${httpStatus} ${suffix}` : `http ${httpStatus}`);

  // The rule all five senders share, written once in transientHttp.js. 429 is
  // the project quota (RESOURCE_EXHAUSTED) and belongs here, not in a settle.
  if (isTransientHttpStatus(httpStatus)) {
    return { status: "failed", retryable: true, detail: withDetail(reported || unread) };
  }

  if (httpStatus >= 200 && httpStatus < 300) {
    if (error) return { status: "rejected", retryable: false, detail: withDetail(reported) };
    if (unread) return { status: "failed", retryable: true, detail: withDetail(unread) };

    const requestId = text(body?.requestId);
    if (!expectRequestId) {
      // Validated, so nothing was ingested and nothing is pending. The row
      // settles here and the worker's own detail says the conversion does not
      // exist.
      return { status: "sent", retryable: false, detail: withDetail(describeFieldWarnings(body)) };
    }
    if (!requestId) {
      return {
        status: "rejected",
        retryable: false,
        detail: withDetail("accepted with no requestId; the outcome can never be confirmed"),
      };
    }

    return {
      status: "retrying",
      retryable: true,
      requestId,
      detail: [withDetail("accepted for processing"), describeFieldWarnings(body)].filter(Boolean).join("; "),
    };
  }

  // Everything else is permanent and about the account, the credentials or the
  // Cloud project rather than the row. readDataManagerError names the enum,
  // because the failures here look alike from the outside and have different
  // fixes.
  return { status: "rejected", retryable: false, detail: withDetail(reported || unread) };
}

/** The status words Google documents for a request, and the one disagreement
 *  between its own pages. The REST reference lists `FAILED`; the diagnostics
 *  guide's prose says `FAILURE`. Both are treated as the same answer rather than
 *  one of them being guessed at -- an unrecognised word here would poll for 24
 *  hours and then settle `failed`, so picking wrong is not silent, but it would
 *  turn a refusal that is knowable now into a day of waiting. */
const CONFIRM_SUCCESS = "SUCCESS";
const CONFIRM_PROCESSING = "PROCESSING";
const CONFIRM_FAILED = new Set(["FAILED", "FAILURE"]);
const CONFIRM_PARTIAL = "PARTIAL_SUCCESS";

/** `errorInfo.errorCounts[]` as a phrase, or "". `recordCount` is an int64 and
 *  therefore a string in JSON. Each entry is one REASON and how many records it
 *  took -- and there is no identifier on any of them, which is the whole reason
 *  one request carries one event. */
function describeErrorCounts(destination) {
  const counts = Array.isArray(destination?.errorInfo?.errorCounts) ? destination.errorInfo.errorCounts : [];
  const described = counts
    .slice(0, 3)
    .map((count) => {
      const reason = text(count?.reason) || "unnamed reason";
      const records = text(count?.recordCount);
      return records ? `${reason} x${records}` : reason;
    })
    .filter(Boolean);
  return described.join("; ");
}

/**
 * The status retrieval, as a status word. This is where `sent` is finally
 * earned.
 *
 * **Every path returns a status, and that is the property to preserve above all
 * the rest of this function.** A step that returns without one writes nothing,
 * the action stays `pending` or `retrying` with its clock due, and the row is
 * claimed again on every sweep for ever. On 2026-10-22 exactly that -- a guard
 * that returned without writing -- starved the whole queue: claimDueEvents takes
 * the 25 oldest rows, the same 25 came back every sweep, and no row behind them
 * was ever reached. WhatsApp and Brevo stopped for live signups. So an
 * unrecognised word, an empty list, a body of the wrong shape and a status that
 * is not a string all fall through to a retryable failure with the word in the
 * detail, and the attempt budget settles them `failed`.
 *
 *   `SUCCESS` -- Google recorded the conversion. `sent`, and the only route to
 *   it.
 *
 *   `FAILED` (`FAILURE` in Google's own prose) -- it did not. `rejected`, with
 *   `errorCounts[]`'s reasons in the detail. Not retryable: a terminal status
 *   returns the same answer to every later poll.
 *
 *   `PARTIAL_SUCCESS` -- unreachable by construction, because a request of one
 *   event cannot be partly anything, and handled as a refusal rather than
 *   assumed away. If it ever arrives, something sent more than one event and the
 *   counts name no rows, so the one conversion this request was about cannot be
 *   claimed as recorded. `rejected`, saying so.
 *
 *   `PROCESSING` -- not yet an answer. Retryable, on Google's own backoff
 *   (googleConfirmDelayMinutes), for the 24 hours Google says processing may
 *   take. Still processing after that settles `failed` -- which does NOT mean
 *   refused, and the worker's detail says which it was.
 *
 * A 404 is terminal in the other direction: the request id is unknown to Google
 * and will not become known, so there is nothing left to wait for.
 */
export function classifyGoogleConfirm({
  transportError,
  httpStatus: rawStatus,
  body,
  bodyTimedOut,
  bodyUnreadable,
} = {}) {
  if (transportError) {
    return {
      status: "failed",
      retryable: true,
      detail: `transport: ${String(transportError?.message || transportError).slice(0, 200)}`,
    };
  }

  const httpStatus = Number(rawStatus) || 0;
  const error = readDataManagerError(body);
  const reported = error ? error.message : "";
  const unread = bodyTimedOut ? "body timed out" : bodyUnreadable ? "unreadable body" : "";
  const withDetail = (suffix) => (suffix ? `status http ${httpStatus} ${suffix}` : `status http ${httpStatus}`);

  if (isTransientHttpStatus(httpStatus)) {
    return { status: "failed", retryable: true, detail: withDetail(reported || unread) };
  }

  if (httpStatus === 404) {
    return {
      status: "rejected",
      retryable: false,
      detail: withDetail(reported || "requestId unknown to Google; the conversion cannot be confirmed"),
    };
  }

  if (httpStatus < 200 || httpStatus >= 300) {
    return { status: "rejected", retryable: false, detail: withDetail(reported || unread) };
  }

  if (unread) return { status: "failed", retryable: true, detail: withDetail(unread) };

  // One destination was sent, and Google documents the reply as ordered to match
  // it, so element zero is ours. Read by position rather than by matching the
  // account back, because a reply that does not line up with a request of one is
  // a reply we do not understand -- and the branch below says so rather than
  // searching for something to agree with.
  const perDestination = Array.isArray(body?.requestStatusPerDestination)
    ? body.requestStatusPerDestination
    : [];
  if (perDestination.length !== 1) {
    return {
      status: "failed",
      retryable: true,
      detail: withDetail(`${perDestination.length} destination statuses for a request of one`),
    };
  }

  const destination = perDestination[0];
  const word = text(destination?.requestStatus);

  if (word === CONFIRM_SUCCESS) {
    return { status: "sent", retryable: false, detail: withDetail(CONFIRM_SUCCESS) };
  }
  if (CONFIRM_FAILED.has(word)) {
    const counts = describeErrorCounts(destination);
    return {
      status: "rejected",
      retryable: false,
      detail: withDetail(counts ? `${word}: ${counts}` : `${word} with no error counts`),
    };
  }
  if (word === CONFIRM_PARTIAL) {
    const counts = describeErrorCounts(destination);
    return {
      status: "rejected",
      retryable: false,
      detail: withDetail(
        `${CONFIRM_PARTIAL} for a request of one event, so this conversion is not confirmed` +
          (counts ? `: ${counts}` : "")
      ),
    };
  }
  if (word === CONFIRM_PROCESSING) {
    return { status: "failed", retryable: true, detail: withDetail(CONFIRM_PROCESSING) };
  }

  // REQUEST_STATUS_UNKNOWN, a word Google adds later, or nothing at all.
  // Retryable, because "we do not recognise this" is not evidence that the
  // conversion failed -- and bounded, because the budget is what guarantees it
  // settles.
  return {
    status: "failed",
    retryable: true,
    detail: withDetail(`unrecognised requestStatus ${JSON.stringify(word || "(none)")}`),
  };
}

/**
 * Google's own polling schedule for this API, and the budget derived from it.
 *
 * Straight out of the diagnostics guide's table: wait 30 minutes before the
 * first status request, multiply each wait by 1.3, cap it at 60 minutes, and
 * give up after 24 hours in total. The numbers are Google's rather than ours
 * because the thing being waited for is Google's processing time -- their own
 * statement is "This may take up to 24 hours", with some requests finishing in
 * about 30 minutes.
 *
 * **No jitter, although Google recommends it.** Jitter spreads a herd of
 * requests that would otherwise poll in step, which is a real concern for a bulk
 * uploader with thousands of requests in flight. This service has on the order
 * of ten conversions a day; there is no herd, and a random clock would make
 * every test of this schedule probabilistic for nothing.
 */
export const GOOGLE_CONFIRM_FIRST_DELAY_MINUTES = 30;
export const GOOGLE_CONFIRM_BACKOFF = 1.3;
export const GOOGLE_CONFIRM_MAX_DELAY_MINUTES = 60;
export const GOOGLE_CONFIRM_WINDOW_MINUTES = 24 * 60;

/**
 * How long to wait before the poll that follows `polls` polls, in whole minutes.
 *
 * `polls` is how many status requests have already been made, so 0 is the wait
 * the ingest itself sets: 30 minutes. Whole minutes because the schedule is read
 * by people and because sub-minute precision on a wait of half an hour is noise.
 */
export function googleConfirmDelayMinutes(polls = 0) {
  const n = Number(polls);
  const already = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  const grown = GOOGLE_CONFIRM_FIRST_DELAY_MINUTES * GOOGLE_CONFIRM_BACKOFF ** already;
  return Math.min(GOOGLE_CONFIRM_MAX_DELAY_MINUTES, Math.round(grown));
}

/**
 * How many polls the 24-hour window is worth, COMPUTED from the schedule above.
 *
 * Deliberately not a literal. The two have to agree -- a budget short of the
 * window gives up on conversions Google was still processing, and one longer
 * than it keeps a row unsettled past the point Google will ever answer -- and a
 * number typed beside a schedule is a number that stops matching it the first
 * time either is edited.
 *
 * It comes out at 25 with Google's figures: 30 + 39 + 51 minutes, then 60 a time
 * until the total reaches 1,440. **It is nowhere near the three attempts the
 * other destinations get**, which is the whole reason the two phases of this
 * destination count separately (see worker.js): three polls would abandon every
 * conversion after two hours, and 25 ingest attempts would hammer a broken
 * endpoint for a day.
 */
export const GOOGLE_CONFIRM_MAX_ATTEMPTS = (() => {
  let elapsed = 0;
  let polls = 0;
  while (elapsed < GOOGLE_CONFIRM_WINDOW_MINUTES) {
    elapsed += googleConfirmDelayMinutes(polls);
    polls += 1;
  }
  return polls;
})();

/**
 * One conversion, ingested. Never throws, and never puts a secret or a gclid in
 * its result.
 *
 * The access token is taken from the cache (getGoogleAccessToken), so the common
 * case is one HTTP request per conversion and not two.
 *
 * `gclid` is passed in only to be redacted out of whatever Google echoes back.
 * It is already inside `payload`; naming it here is what lets the detail be
 * scrubbed of it without this function unpicking a payload it was handed.
 */
export async function ingestGoogleConversion({
  fetchImpl = fetch,
  dataManagerHost = DATA_MANAGER_API_HOST,
  dataManagerVersion = DATA_MANAGER_API_VERSION,
  clientId,
  clientSecret,
  refreshToken,
  tokenUrl,
  payload,
  gclid,
  now,
} = {}) {
  const token = await getGoogleAccessToken({ fetchImpl, tokenUrl, clientId, clientSecret, refreshToken, now });
  if (token.failure) {
    // Not an ingest that failed -- no ingest was made. It reads as a retryable
    // or permanent failure exactly as the exchange itself was, and the detail
    // says which step it belongs to.
    return { status: "failed", retryable: token.failure.retryable, detail: token.failure.detail };
  }

  const echoes = [clientSecret, refreshToken, token.accessToken, gclid];

  let response;
  try {
    response = await fetchImpl(eventsIngestUrl(dataManagerHost, dataManagerVersion), {
      method: "POST",
      headers: dataManagerHeaders({ accessToken: token.accessToken, json: true }),
      body: JSON.stringify(payload),
      // Bounded: a stall aborts with a TimeoutError, which lands in the catch
      // below as a retryable transport failure.
      signal: sendTimeoutSignal(),
    });
  } catch (transportError) {
    const message = redactEchoes(transportError?.message || transportError || "unknown", echoes);
    return classifyGoogleIngest({ transportError: { message } });
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

  const outcome = classifyGoogleIngest({
    httpStatus: response?.status,
    body,
    bodyTimedOut,
    bodyUnreadable,
    // A validated request is not executed, so there is no request to confirm and
    // no id to miss. Read off the payload we actually sent rather than from
    // configuration, so the two cannot disagree.
    expectRequestId: !payload?.validateOnly,
  });
  // A provider that echoed a credential or the click id back in its message must
  // not put it in the row, which is read straight into the admin table.
  return { ...outcome, detail: redactEchoes(outcome.detail, echoes) };
}

/**
 * What became of one ingested request. Never throws, and never puts a secret in
 * its result.
 *
 * A GET with the id on the query string and no body, which is what Google
 * documents. The same credentials as the ingest, which is also what Google
 * requires: the status request has to reach the operating account by the same
 * access path, `loginAccount` included -- which is one more reason
 * buildGoogleIngest omits a `loginAccount` nobody needs.
 */
export async function retrieveGoogleRequestStatus({
  fetchImpl = fetch,
  dataManagerHost = DATA_MANAGER_API_HOST,
  dataManagerVersion = DATA_MANAGER_API_VERSION,
  clientId,
  clientSecret,
  refreshToken,
  tokenUrl,
  requestId,
  now,
} = {}) {
  const id = text(requestId);
  // Never asked without one. A blank id on the query string is a request for
  // the status of nothing, and the answer to it would be read as an outcome.
  if (!id) {
    return { status: "failed", retryable: false, detail: "no requestId to confirm" };
  }

  const token = await getGoogleAccessToken({ fetchImpl, tokenUrl, clientId, clientSecret, refreshToken, now });
  if (token.failure) {
    return { status: "failed", retryable: token.failure.retryable, detail: token.failure.detail };
  }

  const echoes = [clientSecret, refreshToken, token.accessToken];

  let response;
  try {
    response = await fetchImpl(requestStatusUrl(dataManagerHost, dataManagerVersion, id), {
      method: "GET",
      headers: dataManagerHeaders({ accessToken: token.accessToken }),
      // Bounded like every other outbound call here. A poll that hung would hold
      // the sweep exactly as a send would.
      signal: sendTimeoutSignal(),
    });
  } catch (transportError) {
    const message = redactEchoes(transportError?.message || transportError || "unknown", echoes);
    return classifyGoogleConfirm({ transportError: { message } });
  }

  let body = null;
  let bodyTimedOut = false;
  let bodyUnreadable = false;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
    bodyUnreadable = true;
    bodyTimedOut = error?.name === "TimeoutError";
  }

  const outcome = classifyGoogleConfirm({
    httpStatus: response?.status,
    body,
    bodyTimedOut,
    bodyUnreadable,
  });
  return { ...outcome, detail: redactEchoes(outcome.detail, echoes) };
}
