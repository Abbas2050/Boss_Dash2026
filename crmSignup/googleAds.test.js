// @vitest-environment node
//
// The Google Ads half, now ingesting through the Data Manager API. Five of the
// failure modes here produce no error at all, and every one of them has a
// precedent in this repository:
//
//   **HTTP 200 means "accepted for asynchronous processing" and nothing more.**
//   The conversion's real outcome arrives up to 24 hours later from
//   `requestStatus:retrieve`. Recording `sent` on the 200 is the Meta failure
//   that cost this project a month, and the 2026-10-22 failure that cost it this
//   migration -- `uploadClickConversions` answered 200 carrying
//   `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`.
//
//   **One event per request, or a status is unattributable.** The API reports
//   failures as `errorInfo.errorCounts[]` of `{reason, recordCount}` with NO
//   per-record identifier, so a batch that comes back PARTIAL_SUCCESS names no
//   rows.
//
//   `conversionValue` is the DECIMAL. The same lookup's `amountMinor` is what
//   OpenAI takes, and sending it here reports a $54.49 deposit as $5,449. Both
//   numbers are accepted without a word, so the fixture below uses an amount
//   whose two forms differ.
//
//   `productDestinationId` is the NUMERIC id. A resource name there is a
//   well-formed string that would be accepted with a 200 and refused a day
//   later as an error count naming no row.
//
//   A row with no gclid cannot be attributed. Ingested anyway it is a conversion
//   counted against no campaign, inflating the account total while every
//   campaign's own number stays put.
//
// So each of those is pinned by test rather than by care.
import { describe, it, expect, vi, afterEach } from "vitest";
import { describeSendTimeout, stalledBodyResponse } from "./sendTimeout.contract.js";
// The other two destinations' helpers, imported ONLY to be compared against.
// The currency allowlist is one authority read in three places and the funnel
// event's identity is one scheme used by three platforms, and both of those
// facts are asserted below rather than assumed: these imports are the alarm
// that rings if any side changes on its own.
import { metaValueFields } from "./meta.js";
import { openaiEventId, openaiAmountFields } from "./openai.js";
// The one stage that carries money, from the module that owns that fact.
import { DEPOSIT_VALUE_STAGE } from "./depositValue.js";
import {
  DATA_MANAGER_API_HOST,
  DATA_MANAGER_API_VERSION,
  DATA_MANAGER_SCOPE,
  GOOGLE_ADS_ACCOUNT_OFFSET,
  GOOGLE_ADS_ACCOUNT_TYPE,
  GOOGLE_ADS_API_HOST,
  GOOGLE_ADS_API_VERSION,
  GOOGLE_ADS_CONVERSION_ACTIONS,
  GOOGLE_CONFIRM_BACKOFF,
  GOOGLE_CONFIRM_FIRST_DELAY_MINUTES,
  GOOGLE_CONFIRM_MAX_ATTEMPTS,
  GOOGLE_CONFIRM_MAX_DELAY_MINUTES,
  GOOGLE_CONFIRM_WINDOW_MINUTES,
  GOOGLE_EVENT_SOURCE,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_TOKEN_REFRESH_MARGIN_MS,
  GTM_OWNED_STAGE,
  buildGoogleIngest,
  classifyGoogleConfirm,
  classifyGoogleIngest,
  clearGoogleCaches,
  conversionActionQuery,
  decideGoogleSkip,
  decideGoogleValueFailure,
  describeFieldWarnings,
  eventsIngestUrl,
  getGoogleAccessToken,
  googleConfirmDelayMinutes,
  googleConversionActionFor,
  googleEventTimestamp,
  googleTransactionId,
  googleValueFields,
  ingestGoogleConversion,
  parseUtcOffsetMinutes,
  readDataManagerError,
  readGoogleAdsError,
  requestStatusUrl,
  resolveGoogleConversionAction,
  resolveTimezoneOffset,
  retrieveGoogleRequestStatus,
  searchUrl,
} from "./googleAds.js";

// The live account, digits only. The dashed form is what an operator copies out
// of the Google Ads UI and what the API refuses.
const CUSTOMER_ID = "4743067250";
// What the lookup resolves to: the bare numeric id, and the resource name it
// also selects. The two are deliberately both present in the fixtures, because
// sending the second where the first belongs is one of the mutations this file
// exists to kill.
const ACTION_ID = "987654321";
const ACTION_RESOURCE = `customers/${CUSTOMER_ID}/conversionActions/${ACTION_ID}`;

const CREDENTIALS = {
  customerId: CUSTOMER_ID,
  clientId: "google-client",
  clientSecret: "google-secret",
  refreshToken: "google-refresh",
};

// The access token a healthy exchange hands back. Distinctive, so a header
// carrying something else cannot pass by accident.
const ACCESS_TOKEN = "ya29.a0-access-token";
// The id Google mints for one accepted request. This is the whole of what makes
// a per-conversion outcome askable later.
const REQUEST_ID = "dm-request-7f2b9c";
const GCLID = "Cj0KCQiA-gclid";

const TOKEN_OK = { status: 200, json: async () => ({ access_token: ACCESS_TOKEN, expires_in: 3600 }) };
const SEARCH_OK = {
  status: 200,
  json: async () => ({
    results: [{ conversionAction: { id: ACTION_ID, resourceName: ACTION_RESOURCE, name: "FXBO_Client_Verified" } }],
  }),
};
const INGEST_OK = { status: 200, json: async () => ({ requestId: REQUEST_ID }) };
const CONFIRM_OK = {
  status: 200,
  json: async () => ({
    requestStatusPerDestination: [
      {
        destination: { operatingAccount: { accountType: "GOOGLE_ADS", accountId: CUSTOMER_ID } },
        requestStatus: "SUCCESS",
      },
    ],
  }),
};

const isTokenUrl = (url) => String(url) === GOOGLE_OAUTH_TOKEN_URL;
const isSearchUrl = (url) => String(url).endsWith("googleAds:search");
const isIngestUrl = (url) => String(url).endsWith("/events:ingest");
const isStatusUrl = (url) => String(url).includes("/requestStatus:retrieve");

/** A fetch that answers every one of this destination's four calls the way a
 *  healthy Google does. */
const healthyFetch = () =>
  vi.fn(async (url) => {
    if (isTokenUrl(url)) return TOKEN_OK;
    if (isSearchUrl(url)) return SEARCH_OK;
    if (isIngestUrl(url)) return INGEST_OK;
    if (isStatusUrl(url)) return CONFIRM_OK;
    throw new Error(`unexpected fetch: ${url}`);
  });

afterEach(() => {
  // The token and the resolved action id live in the module, so without this one
  // case's token is served to the next -- and the case that proves a token is
  // REUSED would pass on a token minted by the case before it.
  clearGoogleCaches();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("GOOGLE_ADS_CONVERSION_ACTIONS", () => {
  it("names the three actions that exist in the account, and nothing else", () => {
    expect(GOOGLE_ADS_CONVERSION_ACTIONS).toEqual({
      verified: "FXBO_Client_Verified",
      live_account: "FXBO_Live_Account_Opened",
      first_deposit: "FXBO_First_Deposit",
    });
  });

  it("has no entry for the registration stage, which the GTM container owns", () => {
    // The container fires Account_Registration (GADs) with enhanced
    // conversions. A second owner counts every signup twice, and the absence
    // here is what makes that unconstructable rather than merely gated.
    expect(GOOGLE_ADS_CONVERSION_ACTIONS).not.toHaveProperty(GTM_OWNED_STAGE);
    expect(googleConversionActionFor(GTM_OWNED_STAGE)).toBeNull();
  });

  it("has no entry for a lead, which FXBO has no trigger for", () => {
    expect(googleConversionActionFor("lead")).toBeNull();
  });

  it("reads __proto__ as a stage with no action, not as Object.prototype", () => {
    // A plain index would hand back a truthy object, which would then be
    // resolved by name as "[object Object]" -- a lookup no account answers.
    expect(googleConversionActionFor("__proto__")).toBeNull();
    expect(googleConversionActionFor("constructor")).toBeNull();
    expect(googleConversionActionFor(undefined)).toBeNull();
  });

  it("keeps the action NAMES in code and the ids out of configuration", () => {
    // The wire wants the numeric id now, which is a reason for the resolver to
    // return one and NOT a reason to move three numbers into .env: a hardcoded
    // id is unverifiable against the UI and ingests into whatever action now
    // holds it.
    for (const name of Object.values(GOOGLE_ADS_CONVERSION_ACTIONS)) {
      expect(name, name).toMatch(/^FXBO_/);
      expect(name, name).not.toMatch(/^\d+$/);
    }
  });
});

describe("decideGoogleSkip", () => {
  const SENDABLE = { stage: "verified", ...CREDENTIALS, gclid: GCLID };

  it("is silent for a stage with an action, a configured account and a gclid", () => {
    expect(decideGoogleSkip(SENDABLE)).toBeNull();
  });

  it("names the refresh token first, because it is what 'not configured' means", () => {
    // With nothing set, every reason below is also true, and this is the one an
    // operator can act on. The ordering is decideMetaSkip's, decideBrevoSkip's
    // and decideOpenaiSkip's.
    expect(decideGoogleSkip({ ...SENDABLE, refreshToken: "" })).toEqual({
      reason: "google ads not configured",
    });
    expect(decideGoogleSkip({ stage: "verified" })).toEqual({ reason: "google ads not configured" });
  });

  it("names the OAuth client separately, because it is a different line of .env", () => {
    expect(decideGoogleSkip({ ...SENDABLE, clientId: "" })).toEqual({
      reason: "google ads oauth client not configured",
    });
    expect(decideGoogleSkip({ ...SENDABLE, clientSecret: "" })).toEqual({
      reason: "google ads oauth client not configured",
    });
  });

  it("names the customer id separately: it is the operating account", () => {
    // It moved out of the URL and into `destinations[].operatingAccount` with
    // the API, and it is just as required there -- an ingest with no operating
    // account has no account to ingest into.
    expect(decideGoogleSkip({ ...SENDABLE, customerId: "" })).toEqual({
      reason: "google ads customer id not configured",
    });
    // A value with no digits in it is not a customer id either.
    expect(decideGoogleSkip({ ...SENDABLE, customerId: "not-an-id" })).toEqual({
      reason: "google ads customer id not configured",
    });
    // The dashed form an operator pastes out of the UI still counts.
    expect(decideGoogleSkip({ ...SENDABLE, customerId: "474-306-7250" })).toBeNull();
  });

  it("does NOT read a developer token at all, from either API", () => {
    // Two facts, not one: the Google Ads API has ignored developer tokens since
    // the 2026-09-09 sunset and says it will start rejecting them, and the Data
    // Manager API documents no such header and says not to set request headers
    // on an ingest. A gate on it would skip every conversion over a header
    // nobody wants.
    expect(decideGoogleSkip({ ...SENDABLE, developerToken: "" })).toBeNull();
    expect(decideGoogleSkip({ ...SENDABLE, developerToken: undefined })).toBeNull();
  });

  it("leaves the registration stage to the GTM container, naming it", () => {
    expect(decideGoogleSkip({ ...SENDABLE, stage: GTM_OWNED_STAGE })).toEqual({
      reason: "registered is owned by the GTM container",
    });
  });

  it("skips a stage with no conversion action", () => {
    expect(decideGoogleSkip({ ...SENDABLE, stage: "lead" })).toEqual({
      reason: "stage has no Google Ads conversion action",
    });
    expect(decideGoogleSkip({ ...SENDABLE, stage: "nonsense" })).toEqual({
      reason: "stage has no Google Ads conversion action",
    });
  });

  it("skips a row with no gclid, saying that the click cannot be attributed", () => {
    // `adIdentifiers` is where the gclid goes and we configure no `userData`, so
    // there is no hashed-email fallback here as there is for Meta and OpenAI. An
    // ingest without one is a conversion counted against no campaign: it
    // inflates the account total while every campaign's own number stays put,
    // which corrupts the figure the bidding reads.
    expect(decideGoogleSkip({ ...SENDABLE, gclid: "" })).toEqual({
      reason: "no gclid: the click cannot be attributed in Google Ads",
    });
    expect(decideGoogleSkip({ ...SENDABLE, gclid: undefined })).toEqual({
      reason: "no gclid: the click cannot be attributed in Google Ads",
    });
  });

  it("puts the configuration reasons ahead of the stage and the row", () => {
    // With nothing configured every reason is true at once, and the one worth
    // reading is the one an operator can act on.
    expect(decideGoogleSkip({ stage: GTM_OWNED_STAGE }).reason).toBe("google ads not configured");
    expect(decideGoogleSkip({ stage: "verified", refreshToken: "r" }).reason).toBe(
      "google ads oauth client not configured"
    );
  });
});

describe("googleEventTimestamp", () => {
  it("emits RFC 3339 with a T, which is what a proto Timestamp parses", () => {
    // **The one character the format change turns on.** `conversionDateTime`
    // took `"yyyy-mm-dd hh:mm:ss+hh:mm"` -- a SPACE -- and a Timestamp refuses a
    // space where the `T` belongs, so the previous formatter's output would be
    // rejected by the field this one feeds.
    expect(googleEventTimestamp("2026-10-12T12:00:00Z")).toBe("2026-10-12T16:00:00+04:00");
    expect(googleEventTimestamp("2026-10-12T12:00:00Z")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/
    );
    expect(googleEventTimestamp("2026-10-12T12:00:00Z")).not.toContain(" ");
  });

  it("names the same instant whatever offset it is written in", () => {
    // **The other half of the format change, and the easier half to miss.** A
    // Timestamp is an INSTANT: Google converts to the account's zone for
    // reporting from the account's own setting, not from our string. So an
    // offset can no longer move a conversion to another DAY the way
    // `conversionDateTime`'s could -- it labels the instant, it does not define
    // it. Asserted by parsing both writings back.
    const dubai = googleEventTimestamp("2026-10-11T22:30:00Z", "+04:00");
    const utc = googleEventTimestamp("2026-10-11T22:30:00Z", "+00:00");
    expect(dubai).toBe("2026-10-12T02:30:00+04:00");
    expect(utc).toBe("2026-10-11T22:30:00+00:00");
    // Different digits, different dates in the text -- one instant.
    expect(dubai).not.toBe(utc);
    expect(Date.parse(dubai)).toBe(Date.parse(utc));
    expect(Date.parse(dubai)).toBe(Date.parse("2026-10-11T22:30:00Z"));
  });

  it("is the account's offset by default, and +04:00 is what that is", () => {
    expect(GOOGLE_ADS_ACCOUNT_OFFSET).toBe("+04:00");
    expect(googleEventTimestamp("2026-10-12T12:00:00Z")).toBe(
      googleEventTimestamp("2026-10-12T12:00:00Z", GOOGLE_ADS_ACCOUNT_OFFSET)
    );
  });

  it("does not read the server's own timezone", () => {
    // The IIS host's zone is not the account's, and a host somebody moved must
    // not change what a row stamps. Every field is read with a getUTC* accessor
    // off a shifted instant, which is what makes this true. It matters less than
    // it did now that the offset is presentational, and it is kept because a
    // timestamp that quietly follows the host is a bug waiting for the next host
    // move.
    for (const tz of ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Kiritimati"]) {
      vi.stubEnv("TZ", tz);
      expect(googleEventTimestamp("2026-10-12T12:00:00Z"), tz).toBe("2026-10-12T16:00:00+04:00");
    }
  });

  it("writes the offset from the same number it shifted by", () => {
    // Two independent writings of an offset can disagree, and the one that
    // matters is the one the digits were computed with.
    expect(googleEventTimestamp("2026-10-12T12:00:00Z", "-08:00")).toBe("2026-10-12T04:00:00-08:00");
    expect(googleEventTimestamp("2026-10-12T12:00:00Z", "+00:00")).toBe("2026-10-12T12:00:00+00:00");
    // A half-hour zone, which is where a formatter that only carried hours
    // would be half an hour wrong and perfectly well-formed.
    expect(googleEventTimestamp("2026-10-12T12:00:00Z", "+05:30")).toBe("2026-10-12T17:30:00+05:30");
    expect(googleEventTimestamp("2026-10-12T12:00:00Z", "-03:30")).toBe("2026-10-12T08:30:00-03:30");
  });

  it("takes a Date, an epoch and a MySQL-shaped string alike", () => {
    const at = new Date("2026-10-12T12:00:00Z");
    expect(googleEventTimestamp(at)).toBe("2026-10-12T16:00:00+04:00");
    expect(googleEventTimestamp(at.getTime())).toBe("2026-10-12T16:00:00+04:00");
  });

  it("is empty for a value that is not a time, rather than stamping NaN", () => {
    // "NaN-NaN-NaNTNaN:NaN:NaN+04:00" is well-formed enough to send and is
    // refused with nothing in the row to say why -- and under this API the
    // refusal would arrive a day later as an error count.
    for (const bad of ["", null, undefined, "not a date", new Date("nope"), NaN]) {
      expect(googleEventTimestamp(bad), JSON.stringify(bad)).toBe("");
    }
  });

  it("is empty for an offset that is not an offset, so no payload can carry one", () => {
    // The resolver falls back to the account's offset for a bad configured
    // value, so this is the backstop beneath it: a bad offset reaching here
    // produces no timestamp, and buildGoogleIngest then builds no payload.
    for (const bad of ["Z", "+4:00", "0400", "+04", "", "GMT+4", "+15:00", "+04:60"]) {
      expect(googleEventTimestamp("2026-10-12T12:00:00Z", bad), bad).toBe("");
    }
  });
});

describe("parseUtcOffsetMinutes and resolveTimezoneOffset", () => {
  it("reads a signed +hh:mm as minutes east of UTC", () => {
    expect(parseUtcOffsetMinutes("+04:00")).toBe(240);
    expect(parseUtcOffsetMinutes("-08:00")).toBe(-480);
    expect(parseUtcOffsetMinutes("+05:30")).toBe(330);
    expect(parseUtcOffsetMinutes("+00:00")).toBe(0);
    expect(parseUtcOffsetMinutes("-00:30")).toBe(-30);
  });

  it("refuses Z, so nobody can configure UTC by writing the thing UTC looks like", () => {
    expect(parseUtcOffsetMinutes("Z")).toBeNull();
    expect(parseUtcOffsetMinutes("+04")).toBeNull();
  });

  it("falls back to the account's offset for anything unusable, and warns once", () => {
    // The right direction for this one value and not for a key: the account's
    // own offset is the CORRECT setting, and this variable exists only to move
    // off it, so refusing every conversion over a typo would cost real
    // conversions to protect a number that was already right.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTimezoneOffset("Europe/Berlin")).toBe(GOOGLE_ADS_ACCOUNT_OFFSET);
    expect(resolveTimezoneOffset("Europe/Berlin")).toBe(GOOGLE_ADS_ACCOUNT_OFFSET);
    // Once per distinct value: this is read on every send.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("GOOGLE_ADS_TIMEZONE_OFFSET");
    expect(warn.mock.calls[0][0]).toContain(GOOGLE_ADS_ACCOUNT_OFFSET);
  });

  it("is silent for an unset value, which is the normal case", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTimezoneOffset("")).toBe(GOOGLE_ADS_ACCOUNT_OFFSET);
    expect(resolveTimezoneOffset(undefined)).toBe(GOOGLE_ADS_ACCOUNT_OFFSET);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a usable configured offset", () => {
    expect(resolveTimezoneOffset("-05:00")).toBe("-05:00");
  });
});

describe("googleTransactionId", () => {
  it("is <client>:<stage>, the identity the row already has", () => {
    expect(googleTransactionId({ crmClientId: "88214", stage: "verified" })).toBe("88214:verified");
  });

  it("is the SAME identity Meta's event_id and OpenAI's event id are built from", () => {
    // One funnel event, one identity across three platforms. A third scheme
    // would be a third thing to keep consistent, and the dedupe is the whole
    // reason any of them exists.
    const of = { crmClientId: "88214", stage: "first_deposit" };
    expect(googleTransactionId(of)).toBe(openaiEventId(of));
    expect(googleTransactionId(of)).toBe(`${of.crmClientId}:${of.stage}`);
  });

  it("is empty with no client id, rather than an id shared by every such client", () => {
    // ":verified" would be the same transaction id for every client with no id.
    expect(googleTransactionId({ stage: "verified" })).toBe("");
    expect(googleTransactionId({ crmClientId: "", stage: "verified" })).toBe("");
    expect(googleTransactionId({ crmClientId: "88214" })).toBe("");
    expect(googleTransactionId()).toBe("");
  });
});

describe("googleValueFields", () => {
  // $54.49: the decimal and the minor-unit integer differ, and differ by a
  // factor of a hundred. A fixture with a round amount would pass with the two
  // units crossed.
  const DEPOSIT = { currency: "USD", valueDecimal: 54.49, amountMinor: 5449 };

  it("sends the DECIMAL, never the minor-unit integer", () => {
    // **`conversionValue` is a plain number.** `5449` here reports a $54.49
    // deposit as $5,449, and Google accepts it without a word -- in the
    // direction that tells Smart Bidding to buy much more of that traffic.
    expect(googleValueFields(DEPOSIT)).toEqual({ conversionValue: 54.49, currency: "USD" });
    expect(googleValueFields(DEPOSIT).conversionValue).not.toBe(DEPOSIT.amountMinor);
  });

  it("is not micros either, which is the trap from the other side", () => {
    // The Google Ads API states money in micros nearly everywhere
    // (`amountMicros`, `costMicros`). Conversion value is neither micros nor
    // minor units.
    expect(googleValueFields(DEPOSIT).conversionValue).not.toBe(54_490_000);
    expect(JSON.stringify(googleValueFields(DEPOSIT))).not.toContain("54490000");
  });

  it("takes the same number Meta takes, and never OpenAI's", () => {
    // The one lookup hands out two numbers. metaValueFields reads
    // `valueDecimal`, openaiAmountFields reads `amountMinor`, and this reads
    // the first -- asserted against both so a change on any side fails here.
    expect(googleValueFields(DEPOSIT).conversionValue).toBe(metaValueFields(DEPOSIT).value);
    expect(googleValueFields(DEPOSIT).conversionValue).not.toBe(openaiAmountFields(DEPOSIT).amount);
    expect(openaiAmountFields(DEPOSIT).amount).toBe(5449);
  });

  it("is both fields or neither", () => {
    // A value with no currency is a number with no unit, and both are
    // documented optional -- so Google would take the value alone and price it
    // in whatever the account assumes.
    expect(googleValueFields({ valueDecimal: 54.49 })).toEqual({});
    expect(googleValueFields({ currency: "USD" })).toEqual({});
    expect(googleValueFields({ currency: "USD", valueDecimal: 0 })).toEqual({});
    expect(googleValueFields({ currency: "USD", valueDecimal: -5 })).toEqual({});
    expect(googleValueFields({ currency: "USD", valueDecimal: "abc" })).toEqual({});
    expect(googleValueFields()).toEqual({});
  });

  it("qualifies a currency against the allowlist, exactly as the other two do", () => {
    // `/^[A-Z]{3}$/` is the gate that let BTC through once on this branch, and
    // a shape test cannot tell BRL from BTC. One authority, read in three
    // places: a destination narrowing on its own is how the same deposit gets
    // priced on one platform and dropped on another.
    const btc = { currency: "BTC", valueDecimal: 0.4, amountMinor: 40000000 };
    expect(googleValueFields(btc)).toEqual({});
    expect(metaValueFields(btc)).toEqual({});
    expect(openaiAmountFields(btc)).toEqual({});

    for (const code of ["USD", "EUR", "GBP", "AED"]) {
      expect(googleValueFields({ currency: code, valueDecimal: 10 }), code).toEqual({
        conversionValue: 10,
        currency: code,
      });
    }
  });

  it("upper-cases a code as the allowlist holds it", () => {
    expect(googleValueFields({ currency: "usd", valueDecimal: 54.49 })).toEqual({
      conversionValue: 54.49,
      currency: "USD",
    });
  });

  it("names the field `currency`, which is what the Data Manager event takes", () => {
    // Renamed on the wire from `currencyCode`, same ISO 4219 value. A payload
    // carrying the old name would be an unrecognised field.
    const fields = googleValueFields(DEPOSIT);
    expect(Object.keys(fields).sort()).toEqual(["conversionValue", "currency"]);
    expect(fields).not.toHaveProperty("currencyCode");
  });
});

describe("decideGoogleValueFailure", () => {
  it("is silent at every stage that carries no money", () => {
    for (const stage of ["verified", "live_account", "registered", "lead"]) {
      expect(decideGoogleValueFailure({ stage }), stage).toBeNull();
    }
  });

  it("is silent for a deposit whose money can be stated", () => {
    expect(
      decideGoogleValueFailure({
        stage: DEPOSIT_VALUE_STAGE,
        depositValue: { currency: "USD", valueDecimal: 54.49 },
      })
    ).toBeNull();
  });

  it("fails the deposit by name rather than ingesting it unpriced", () => {
    // Ingesting with no value is available -- both fields are optional -- and is
    // refused: `transactionId` makes this conversion unique per action for ever,
    // so an unpriced ingest is the FINAL word on that deposit's worth and no
    // later send can correct it.
    const failure = decideGoogleValueFailure({
      stage: DEPOSIT_VALUE_STAGE,
      depositValue: { currency: "BTC", valueDecimal: 0.4 },
    });
    expect(failure.status).toBe("failed");
    expect(failure.retryable).toBe(false);
    expect(failure.detail).toContain("BTC");
  });

  it("says so when the amount rather than the code is the problem", () => {
    const failure = decideGoogleValueFailure({
      stage: DEPOSIT_VALUE_STAGE,
      depositValue: { currency: "USD", valueDecimal: 0 },
    });
    expect(failure.status).toBe("failed");
    expect(failure.detail).toContain("not a positive number");
  });

  it("names the absence when there is no currency at all", () => {
    const failure = decideGoogleValueFailure({ stage: DEPOSIT_VALUE_STAGE, depositValue: {} });
    expect(failure.detail).toContain("(none)");
  });

  it("is `failed` and not `rejected`, because nothing was sent", () => {
    // The same shape decideBrevoListIdFailure returns. `rejected` would read as
    // a provider refusal on the destination card, and there was no request.
    // Both are requeueable, so a deposit repriced in FXBO can still be sent.
    const failure = decideGoogleValueFailure({
      stage: DEPOSIT_VALUE_STAGE,
      depositValue: { currency: "ETH", valueDecimal: 2 },
    });
    expect(failure.status).toBe("failed");
  });
});

describe("buildGoogleIngest", () => {
  const PARTS = {
    stage: "verified",
    crmClientId: "88214",
    gclid: GCLID,
    conversionActionId: ACTION_ID,
    customerId: CUSTOMER_ID,
    receivedAt: "2026-10-12T12:00:00Z",
  };

  it("builds the whole documented request, destinations and one event", () => {
    expect(buildGoogleIngest(PARTS)).toEqual({
      destinations: [
        {
          operatingAccount: { accountType: "GOOGLE_ADS", accountId: CUSTOMER_ID },
          productDestinationId: ACTION_ID,
        },
      ],
      events: [
        {
          adIdentifiers: { gclid: GCLID },
          transactionId: "88214:verified",
          eventTimestamp: "2026-10-12T16:00:00+04:00",
          eventSource: "WEB",
        },
      ],
    });
  });

  it("IS ONE EVENT PER REQUEST, which is what makes a status attributable", () => {
    // **The heart of the design.** The API reports failures as
    // `errorInfo.errorCounts[]` of `{reason, recordCount}` with NO per-record
    // identifier. A batch of five that came back PARTIAL_SUCCESS with
    // `recordCount: 2` would name no rows: two of those conversions do not
    // exist and nothing could say which. One event per request means one
    // requestId is one conversion.
    for (const stage of Object.keys(GOOGLE_ADS_CONVERSION_ACTIONS)) {
      const payload = buildGoogleIngest({
        ...PARTS,
        stage,
        depositValue: { currency: "USD", valueDecimal: 54.49, amountMinor: 5449 },
      });
      expect(payload.events, stage).toHaveLength(1);
      expect(payload.destinations, stage).toHaveLength(1);
    }
  });

  it("carries the NUMERIC id, and refuses a resource name outright", () => {
    // `productDestinationId` is "The ID of the Google Ads conversion action",
    // taken from `conversion_action.id`. A resource name there is a well-formed
    // string that would be accepted with a 200 and refused a day later as an
    // error count naming no row -- the quietest way to be wrong on this API, so
    // it builds nothing instead.
    expect(buildGoogleIngest(PARTS).destinations[0].productDestinationId).toBe(ACTION_ID);
    expect(buildGoogleIngest({ ...PARTS, conversionActionId: ACTION_RESOURCE })).toBeNull();
    expect(buildGoogleIngest({ ...PARTS, conversionActionId: "customers/1/conversionActions/2" })).toBeNull();
    expect(buildGoogleIngest({ ...PARTS, conversionActionId: "FXBO_Client_Verified" })).toBeNull();
    // Not the display name either: the request names the action by id.
    expect(JSON.stringify(buildGoogleIngest(PARTS))).not.toContain("FXBO_Client_Verified");
  });

  it("names the operating account by type and digits", () => {
    // Google: "Set `accountType` to `GOOGLE_ADS` and `accountId` to your
    // 10-digit Google Ads customer ID (without hyphens)."
    const [destination] = buildGoogleIngest({ ...PARTS, customerId: "474-306-7250" }).destinations;
    expect(destination.operatingAccount).toEqual({ accountType: GOOGLE_ADS_ACCOUNT_TYPE, accountId: CUSTOMER_ID });
    expect(GOOGLE_ADS_ACCOUNT_TYPE).toBe("GOOGLE_ADS");
  });

  it("adds loginAccount only when a manager account is configured", () => {
    // Where `login-customer-id` went: this API takes no request headers on an
    // ingest, so reaching the customer through a manager is stated in the body.
    // Omitted otherwise, because it defaults to the operating account -- and
    // because the status retrieval has to use the same access path, so a
    // loginAccount nobody needs is a second place for that path to be wrong.
    expect(buildGoogleIngest(PARTS).destinations[0]).not.toHaveProperty("loginAccount");
    expect(buildGoogleIngest({ ...PARTS, loginCustomerId: "" }).destinations[0]).not.toHaveProperty("loginAccount");
    expect(buildGoogleIngest({ ...PARTS, loginCustomerId: "123-456-7890" }).destinations[0].loginAccount).toEqual({
      accountType: "GOOGLE_ADS",
      accountId: "1234567890",
    });
  });

  it("puts the gclid in adIdentifiers and nowhere else", () => {
    const [event] = buildGoogleIngest(PARTS).events;
    expect(event.adIdentifiers).toEqual({ gclid: GCLID });
    // No gbraid, no wbraid, no sessionAttributes: ours is a web click with a
    // gclid, and a field we have no value for must be absent rather than empty.
    expect(Object.keys(event.adIdentifiers)).toEqual(["gclid"]);
  });

  it("states eventSource, which every event requires", () => {
    expect(buildGoogleIngest(PARTS).events[0].eventSource).toBe("WEB");
    expect(GOOGLE_EVENT_SOURCE).toBe("WEB");
  });

  it("carries the deposit's decimal value and currency, at the deposit stage only", () => {
    const deposit = { currency: "USD", valueDecimal: 54.49, amountMinor: 5449 };
    const [event] = buildGoogleIngest({ ...PARTS, stage: DEPOSIT_VALUE_STAGE, depositValue: deposit }).events;
    expect(event.conversionValue).toBe(54.49);
    expect(event.currency).toBe("USD");
    expect(event.transactionId).toBe("88214:first_deposit");

    // Every other stage passes no depositValue and carries no pair -- and one
    // that somehow did must still not carry it.
    const [other] = buildGoogleIngest({ ...PARTS, stage: "live_account", depositValue: deposit }).events;
    expect(other).not.toHaveProperty("conversionValue");
    expect(other).not.toHaveProperty("currency");
  });

  it("never puts the minor-unit integer in conversionValue", () => {
    const [event] = buildGoogleIngest({
      ...PARTS,
      stage: DEPOSIT_VALUE_STAGE,
      depositValue: { currency: "USD", valueDecimal: 54.49, amountMinor: 5449 },
    }).events;
    expect(event.conversionValue).not.toBe(5449);
    expect(JSON.stringify(event)).not.toContain("5449");
  });

  it("adds validateOnly only when it is on, and never sends it as false", () => {
    expect(buildGoogleIngest(PARTS)).not.toHaveProperty("validateOnly");
    expect(buildGoogleIngest({ ...PARTS, validateOnly: false })).not.toHaveProperty("validateOnly");
    expect(buildGoogleIngest({ ...PARTS, validateOnly: true }).validateOnly).toBe(true);
  });

  it("builds nothing at all without a gclid", () => {
    // decideGoogleSkip already refuses this with a reason that lands in the
    // row; this is the second half of that one test, because "no payload" is a
    // louder way to be wrong than an unattributed conversion.
    expect(buildGoogleIngest({ ...PARTS, gclid: "" })).toBeNull();
    expect(buildGoogleIngest({ ...PARTS, gclid: undefined })).toBeNull();
  });

  it("builds nothing for a stage with no conversion action", () => {
    expect(buildGoogleIngest({ ...PARTS, stage: GTM_OWNED_STAGE })).toBeNull();
    expect(buildGoogleIngest({ ...PARTS, stage: "lead" })).toBeNull();
  });

  it("builds nothing without a resolved conversion action id", () => {
    expect(buildGoogleIngest({ ...PARTS, conversionActionId: "" })).toBeNull();
    expect(buildGoogleIngest({ ...PARTS, conversionActionId: undefined })).toBeNull();
  });

  it("builds nothing without an operating account", () => {
    expect(buildGoogleIngest({ ...PARTS, customerId: "" })).toBeNull();
    expect(buildGoogleIngest({ ...PARTS, customerId: "not-an-id" })).toBeNull();
  });

  it("builds nothing without a client id, so no two clients share a transaction id", () => {
    expect(buildGoogleIngest({ ...PARTS, crmClientId: "" })).toBeNull();
  });

  it("builds nothing when received_at is not a time, or the offset is not one", () => {
    expect(buildGoogleIngest({ ...PARTS, receivedAt: "" })).toBeNull();
    expect(buildGoogleIngest({ ...PARTS, receivedAt: "not a date" })).toBeNull();
    expect(buildGoogleIngest({ ...PARTS, offset: "Z" })).toBeNull();
  });

  it("sends no consent, no userData, no encoding and no encryptionInfo", () => {
    // `consent` is documented optional and we have collected neither
    // `adUserData` nor `adPersonalization`. Sending CONSENT_GRANTED because the
    // sample payload does would be a claim about the client that nobody here is
    // in a position to make; if Google ever requires it the polls will say so
    // with PROCESSING_ERROR_REASON_DENIED_CONSENT, which is visible.
    //
    // `userData` would be an enhanced-conversions setup nobody has configured,
    // and `encoding` is documented as required only for UserData uploads --
    // which is why omitting the identifiers and omitting the encoding are the
    // same decision.
    const payload = buildGoogleIngest(PARTS);
    expect(Object.keys(payload).sort()).toEqual(["destinations", "events"]);
    for (const absent of ["consent", "encoding", "encryptionInfo"]) {
      expect(payload, absent).not.toHaveProperty(absent);
    }
    const [event] = payload.events;
    expect(Object.keys(event).sort()).toEqual([
      "adIdentifiers",
      "eventSource",
      "eventTimestamp",
      "transactionId",
    ]);
  });

  it("sends nothing of the old API's shape", () => {
    // `conversions`, `partialFailure`, `conversionAction`, `conversionDateTime`
    // and `orderId` all belonged to uploadClickConversions. A payload still
    // carrying one would be an unrecognised field on this API.
    const payload = buildGoogleIngest({
      ...PARTS,
      stage: DEPOSIT_VALUE_STAGE,
      depositValue: { currency: "USD", valueDecimal: 54.49 },
    });
    const text = JSON.stringify(payload);
    for (const gone of ["conversions", "partialFailure", "conversionDateTime", "orderId", "currencyCode"]) {
      expect(text, gone).not.toContain(gone);
    }
  });
});

describe("conversionActionQuery", () => {
  it("asks for the NUMERIC id, which is what the ingest takes", () => {
    const query = conversionActionQuery("FXBO_Client_Verified");
    expect(query).toContain("conversion_action.id");
    // The resource name is selected beside it as the fallback, and because it is
    // what a person pastes into the UI to check they have the right action.
    expect(query).toContain("conversion_action.resource_name");
  });

  it("filters on the name, on UPLOAD_CLICKS and on ENABLED", () => {
    const query = conversionActionQuery("FXBO_Client_Verified");
    expect(query).toContain("FROM conversion_action");
    expect(query).toContain("conversion_action.name = 'FXBO_Client_Verified'");
    // The Data Manager API's offline event ingestion requires UPLOAD_CLICKS, and
    // an account can hold a website tag and an import action with the same name.
    // A removed action still resolves by name, too, and ingesting into one
    // records nothing while answering 200.
    expect(query).toContain("conversion_action.type = 'UPLOAD_CLICKS'");
    expect(query).toContain("conversion_action.status = 'ENABLED'");
  });

  it("escapes a quote rather than ending the literal early", () => {
    expect(conversionActionQuery("it's")).toContain("'it\\'s'");
    expect(conversionActionQuery("a\\b")).toContain("'a\\\\b'");
  });
});

describe("the URLs", () => {
  it("posts the ingest to events:ingest, with no customer id in the path", () => {
    // The account moved into the body as `destinations[].operatingAccount`.
    expect(eventsIngestUrl(DATA_MANAGER_API_HOST, DATA_MANAGER_API_VERSION)).toBe(
      "https://datamanager.googleapis.com/v1/events:ingest"
    );
    expect(eventsIngestUrl(DATA_MANAGER_API_HOST, DATA_MANAGER_API_VERSION)).not.toContain(CUSTOMER_ID);
  });

  it("gets the status from requestStatus:retrieve, with the id on the query string", () => {
    expect(requestStatusUrl(DATA_MANAGER_API_HOST, DATA_MANAGER_API_VERSION, REQUEST_ID)).toBe(
      `https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=${REQUEST_ID}`
    );
    // Encoded, because the id's shape is documented only as "auto-generated".
    expect(requestStatusUrl(DATA_MANAGER_API_HOST, DATA_MANAGER_API_VERSION, "a b&c=d")).toContain(
      "requestId=a%20b%26c%3Dd"
    );
  });

  it("puts nothing client-linked, and no credential, in any URL", () => {
    // The gclid is client-linked and the credentials travel in a header or a
    // form body, so no request line, access log or proxy can carry one.
    const urls = [
      eventsIngestUrl(DATA_MANAGER_API_HOST, DATA_MANAGER_API_VERSION),
      requestStatusUrl(DATA_MANAGER_API_HOST, DATA_MANAGER_API_VERSION, REQUEST_ID),
      searchUrl(GOOGLE_ADS_API_HOST, GOOGLE_ADS_API_VERSION, CUSTOMER_ID),
    ];
    for (const url of urls) {
      for (const secret of [GCLID, ACCESS_TOKEN, CREDENTIALS.clientSecret, CREDENTIALS.refreshToken]) {
        expect(url, `${url} / ${secret}`).not.toContain(secret);
      }
    }
  });

  it("posts the lookup to googleAds:search on the customer, on the Ads API", () => {
    expect(searchUrl(GOOGLE_ADS_API_HOST, GOOGLE_ADS_API_VERSION, CUSTOMER_ID)).toBe(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/4743067250/googleAds:search`
    );
    // Two hosts, two APIs, and the lookup is the only call still made to the
    // older one.
    expect(GOOGLE_ADS_API_HOST).not.toBe(DATA_MANAGER_API_HOST);
  });

  it("strips the dashes an operator copies out of the Google Ads UI", () => {
    expect(searchUrl(GOOGLE_ADS_API_HOST, "v26", "474-306-7250")).toContain("/customers/4743067250/");
  });

  it("takes each version from its caller, so a sunset one can be moved", () => {
    // Google Ads sunsets a version about a year after releasing it, and a sunset
    // version stops answering rather than degrading. Data Manager has shipped
    // one path since going generally available, so its version is a constant.
    expect(searchUrl(GOOGLE_ADS_API_HOST, "v27", CUSTOMER_ID)).toContain("/v27/");
    expect(GOOGLE_ADS_API_VERSION).toMatch(/^v\d+$/);
    expect(DATA_MANAGER_API_VERSION).toBe("v1");
  });

  it("falls back to the documented hosts and versions for a blank one", () => {
    expect(eventsIngestUrl("", "")).toBe(`${DATA_MANAGER_API_HOST}/${DATA_MANAGER_API_VERSION}/events:ingest`);
    expect(requestStatusUrl("", "", "x")).toBe(
      `${DATA_MANAGER_API_HOST}/${DATA_MANAGER_API_VERSION}/requestStatus:retrieve?requestId=x`
    );
    expect(searchUrl("", "", CUSTOMER_ID)).toBe(
      `${GOOGLE_ADS_API_HOST}/${GOOGLE_ADS_API_VERSION}/customers/4743067250/googleAds:search`
    );
  });

  it("records the scope the ingest needs, which is not the one the lookup needs", () => {
    // A refresh token minted before 2026-10-22 carries only `adwords`, resolves
    // conversion actions perfectly, and is refused by every ingest. Scopes are
    // not additive on an existing token, so the fix is to re-mint.
    expect(DATA_MANAGER_SCOPE).toBe("https://www.googleapis.com/auth/datamanager");
  });
});

describe("readGoogleAdsError", () => {
  it("reads the RPC-level error the lookup's non-2xx carries, with its enum", () => {
    const read = readGoogleAdsError({
      error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" },
    });
    expect(read.message).toContain("PERMISSION_DENIED");
  });

  it("matches the failure detail by @type SUFFIX, not by the whole string", () => {
    // The `@type` is version-pinned -- `...v26.errors.GoogleAdsFailure` -- so a
    // full-string match would stop reading errors on the first version bump.
    expect(
      readGoogleAdsError({
        error: {
          details: [
            {
              "@type": "type.googleapis.com/google.ads.googleads.v31.errors.GoogleAdsFailure",
              errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" }, message: "no" }],
            },
          ],
        },
      }).message
    ).toContain("USER_PERMISSION_DENIED");
  });

  it("names the enum of the failures that look alike from outside", () => {
    for (const code of [
      "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
      "USER_PERMISSION_DENIED",
      "DEVELOPER_TOKEN_NOT_APPROVED",
    ]) {
      const read = readGoogleAdsError({
        error: {
          details: [
            {
              "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
              errors: [{ errorCode: { authorizationError: code }, message: "see the enum" }],
            },
          ],
        },
      });
      expect(read.message, code).toContain(code);
    }
  });

  it("is null for a body that reports no error", () => {
    expect(readGoogleAdsError({ results: [{ conversionAction: { id: ACTION_ID } }] })).toBeNull();
    expect(readGoogleAdsError({ error: null })).toBeNull();
    expect(readGoogleAdsError(null)).toBeNull();
    expect(readGoogleAdsError("")).toBeNull();
  });

  it("cuts the message to what the detail column can hold", () => {
    const read = readGoogleAdsError({ error: { message: "x".repeat(1000), status: "INTERNAL" } });
    expect(read.message.length).toBeLessThanOrEqual(200);
  });

  it("no longer reads a partialFailureError, which belonged to the old upload", () => {
    // There is no partial failure on this API: the whole request succeeds or
    // fails. A reader still looking for one would report nothing for a real
    // error and an error for nothing.
    expect(readGoogleAdsError({ partialFailureError: { message: "gone" } })).toBeNull();
  });
});

describe("readDataManagerError", () => {
  const withReason = (reason) => ({
    error: {
      code: 403,
      status: "PERMISSION_DENIED",
      message: "Request had insufficient authentication scopes.",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason,
          domain: "googleapis.com",
        },
      ],
    },
  });

  it("names the reason, which is the enum that says what to fix", () => {
    // Four failures that look alike from the outside and have four different
    // fixes: a token short of the datamanager scope, the API not enabled on the
    // Cloud project, an access path that does not reach the operating account,
    // and the project quota.
    for (const reason of [
      "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
      "SERVICE_DISABLED",
      "IAM_PERMISSION_DENIED",
      "RATE_LIMIT_EXCEEDED",
    ]) {
      const read = readDataManagerError(withReason(reason));
      expect(read.reason, reason).toBe(reason);
      expect(read.message, reason).toContain(reason);
    }
  });

  it("keeps the canonical status beside the reason, because the reason is often absent", () => {
    const read = readDataManagerError({ error: { status: "PERMISSION_DENIED", message: "nope" } });
    expect(read.message).toContain("PERMISSION_DENIED");
    expect(read.reason).toBe("");
  });

  it("matches ErrorInfo by @type suffix", () => {
    expect(readDataManagerError(withReason("SERVICE_DISABLED")).reason).toBe("SERVICE_DISABLED");
    // A details array with something else in it must not be read as the reason.
    expect(
      readDataManagerError({
        error: { status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.BadRequest" }] },
      }).reason
    ).toBe("");
  });

  it("still reports an error whose details it cannot unpack", () => {
    // A body we only half understand has to fail toward refusing, never toward
    // calling the conversion recorded.
    expect(readDataManagerError({ error: { message: "something went wrong" } }).message).toContain(
      "something went wrong"
    );
    expect(readDataManagerError({ error: {} })).toMatchObject({ message: "error reported with no message" });
    expect(readDataManagerError({ error: true })).toBeTruthy();
  });

  it("is null for a body that reports no error", () => {
    expect(readDataManagerError({ requestId: REQUEST_ID })).toBeNull();
    expect(readDataManagerError({ error: null })).toBeNull();
    expect(readDataManagerError(null)).toBeNull();
    expect(readDataManagerError("")).toBeNull();
  });

  it("cuts the message to what the detail column can hold", () => {
    const read = readDataManagerError({ error: { message: "x".repeat(1000), status: "INTERNAL" } });
    expect(read.message.length).toBeLessThanOrEqual(200);
  });
});

describe("describeFieldWarnings", () => {
  it("reports the reason and the field path", () => {
    const described = describeFieldWarnings({
      requestId: REQUEST_ID,
      fieldWarnings: [
        {
          reason: "WARNING_REASON_INVALID_CLIENT_ID",
          field: "events[0].clientId",
          description: "clientId 123 is invalid",
        },
      ],
    });
    expect(described).toContain("WARNING_REASON_INVALID_CLIENT_ID");
    expect(described).toContain("events[0].clientId");
  });

  it("NEVER reports the description, which can quote the row's own values back", () => {
    // `description` is prose Google writes about one row, and on this payload
    // the row's values are the gclid. This string is stored in a column the
    // admin table prints.
    const described = describeFieldWarnings({
      fieldWarnings: [{ reason: "WARNING_REASON_GENERIC", field: "events[0]", description: `bad gclid ${GCLID}` }],
    });
    expect(described).not.toContain(GCLID);
    expect(described).not.toContain("bad gclid");
  });

  it("is empty when there are none, which is the normal case", () => {
    expect(describeFieldWarnings({ requestId: REQUEST_ID })).toBe("");
    expect(describeFieldWarnings({ fieldWarnings: [] })).toBe("");
    expect(describeFieldWarnings(null)).toBe("");
  });
});

describe("classifyGoogleIngest", () => {
  it("NEVER records sent for the 200 that accepted the conversion", () => {
    // **The whole point of this change.** A 200 from events:ingest means
    // "accepted for asynchronous processing" and says nothing about whether the
    // conversion will be recorded; the real answer comes from
    // requestStatus:retrieve up to 24 hours later. `sent` here is the Meta
    // failure that cost a month, and `sent` is a word the resend control cannot
    // reach back through.
    const outcome = classifyGoogleIngest({ httpStatus: 200, body: { requestId: REQUEST_ID } });
    expect(outcome.status).toBe("retrying");
    expect(outcome.status).not.toBe("sent");
    expect(outcome.retryable).toBe(true);
    expect(outcome.requestId).toBe(REQUEST_ID);
    expect(outcome.detail).toContain("accepted for processing");
  });

  it("carries any field warnings into the detail", () => {
    const outcome = classifyGoogleIngest({
      httpStatus: 200,
      body: {
        requestId: REQUEST_ID,
        fieldWarnings: [{ reason: "WARNING_REASON_GENERIC", field: "events[0]" }],
      },
    });
    expect(outcome.requestId).toBe(REQUEST_ID);
    expect(outcome.detail).toContain("WARNING_REASON_GENERIC");
  });

  it("rejects a 200 that carried no requestId, rather than retrying for ever", () => {
    // The conversion may have been accepted and there is no handle left to ask
    // about it, so it can never be confirmed -- and it must not be ingested
    // again on a clock either, because each repeat would be another
    // unconfirmable request.
    for (const body of [{}, { requestId: "" }, { fieldWarnings: [] }]) {
      const outcome = classifyGoogleIngest({ httpStatus: 200, body });
      expect(outcome.status, JSON.stringify(body)).toBe("rejected");
      expect(outcome.retryable, JSON.stringify(body)).toBe(false);
      expect(outcome.requestId, JSON.stringify(body)).toBeUndefined();
      expect(outcome.detail, JSON.stringify(body)).toContain("never be confirmed");
    }
  });

  it("does not record sent for a 200 whose body it could not read", () => {
    // The request may well have been accepted, and without the body there is no
    // request id to confirm it with. Retryable, and `transactionId` is what
    // makes the repeat the same conversion.
    const unreadable = classifyGoogleIngest({ httpStatus: 200, body: null, bodyUnreadable: true });
    expect(unreadable).toEqual({ status: "failed", retryable: true, detail: "http 200 unreadable body" });

    const timedOut = classifyGoogleIngest({
      httpStatus: 200,
      body: null,
      bodyUnreadable: true,
      bodyTimedOut: true,
    });
    expect(timedOut.detail).toBe("http 200 body timed out");
    expect(timedOut.status).toBe("failed");
  });

  it("takes a validated request at its word, because nothing was executed", () => {
    // A validated request "is validated but not executed, and only errors are
    // returned" -- so it records nothing AND there is no request to poll.
    // Insisting on a request id that does not exist would settle every row
    // `rejected`, so the caller says which kind of request it made.
    const validated = classifyGoogleIngest({ httpStatus: 200, body: {}, expectRequestId: false });
    expect(validated.status).toBe("sent");
    expect(validated.retryable).toBe(false);
    expect(validated).not.toHaveProperty("requestId");

    // A validated request that was REFUSED is still a refusal.
    expect(
      classifyGoogleIngest({
        httpStatus: 200,
        body: { error: { status: "INVALID_ARGUMENT", message: "bad gclid" } },
        expectRequestId: false,
      }).status
    ).toBe("rejected");
  });

  it("retries a transient status, by the one rule all five senders share", () => {
    // 429 is RESOURCE_EXHAUSTED -- the 300-a-minute or 100,000-a-day project
    // quota -- and belongs here rather than in a settle.
    for (const status of [408, 429, 500, 502, 503]) {
      const outcome = classifyGoogleIngest({ httpStatus: status, body: {} });
      expect(outcome.status, String(status)).toBe("failed");
      expect(outcome.retryable, String(status)).toBe(true);
      expect(outcome.requestId, String(status)).toBeUndefined();
    }
  });

  it("rejects a permanent non-2xx, naming the reason that says what to fix", () => {
    const outcome = classifyGoogleIngest({
      httpStatus: 403,
      body: {
        error: {
          status: "PERMISSION_DENIED",
          message: "Request had insufficient authentication scopes.",
          details: [
            { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" },
          ],
        },
      },
    });
    expect(outcome.status).toBe("rejected");
    expect(outcome.retryable).toBe(false);
    expect(outcome.detail).toContain("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
  });

  it("is rejected and not failed for a permanent refusal, so the card reads differently", () => {
    // planRetry writes `failed` the moment a retryable outcome runs out of
    // attempts, so with one word for both, an unenabled API would read exactly
    // like a transport outage.
    expect(classifyGoogleIngest({ httpStatus: 401, body: {} }).status).toBe("rejected");
    expect(classifyGoogleIngest({ httpStatus: 400, body: {} }).status).toBe("rejected");
  });

  it("reports a transport failure as retryable, with the transport prefix", () => {
    const outcome = classifyGoogleIngest({ transportError: { message: "fetch failed" } });
    expect(outcome).toEqual({ status: "failed", retryable: true, detail: "transport: fetch failed" });
  });

  it("always answers with a status in the five-word vocabulary", () => {
    // An action with no status writes nothing, stays claimable, and is claimed
    // again on every sweep for ever -- which starved the whole queue on
    // 2026-10-22.
    const words = new Set(["sent", "skipped", "rejected", "failed", "invalid", "retrying", "pending"]);
    for (const args of [
      {},
      { httpStatus: 0 },
      { httpStatus: 200, body: null },
      { httpStatus: 204, body: {} },
      { httpStatus: 302, body: {} },
      { httpStatus: 418, body: "nonsense" },
      { transportError: "boom" },
    ]) {
      const outcome = classifyGoogleIngest(args);
      expect(words.has(outcome.status), `${JSON.stringify(args)} -> ${outcome.status}`).toBe(true);
    }
  });
});

describe("classifyGoogleConfirm", () => {
  const reply = (requestStatus, extra = {}) => ({
    requestStatusPerDestination: [
      {
        destination: { operatingAccount: { accountType: "GOOGLE_ADS", accountId: CUSTOMER_ID } },
        requestStatus,
        ...extra,
      },
    ],
  });

  it("is the ONLY route to sent, and SUCCESS is the only word that takes it", () => {
    const outcome = classifyGoogleConfirm({ httpStatus: 200, body: reply("SUCCESS") });
    expect(outcome.status).toBe("sent");
    expect(outcome.retryable).toBe(false);
    expect(outcome.detail).toContain("SUCCESS");
  });

  it("rejects a FAILED request, naming the reasons and their counts", () => {
    const outcome = classifyGoogleConfirm({
      httpStatus: 200,
      body: reply("FAILED", {
        errorInfo: {
          errorCounts: [
            { reason: "PROCESSING_ERROR_REASON_EVENT_TOO_OLD", recordCount: "1" },
          ],
        },
      }),
    });
    expect(outcome.status).toBe("rejected");
    expect(outcome.retryable).toBe(false);
    expect(outcome.detail).toContain("PROCESSING_ERROR_REASON_EVENT_TOO_OLD");
    expect(outcome.detail).toContain("x1");
  });

  it("reads FAILURE as well as FAILED, because Google's own pages disagree", () => {
    // The REST reference lists `FAILED`; the diagnostics guide's prose says
    // `FAILURE`. Both are the same answer rather than one of them being guessed
    // at -- picking only one would turn a refusal that is knowable now into a
    // day of waiting.
    expect(classifyGoogleConfirm({ httpStatus: 200, body: reply("FAILURE") }).status).toBe("rejected");
    expect(classifyGoogleConfirm({ httpStatus: 200, body: reply("FAILED") }).status).toBe("rejected");
  });

  it("says so for a FAILED with no counts, rather than reading silence as success", () => {
    const outcome = classifyGoogleConfirm({ httpStatus: 200, body: reply("FAILED") });
    expect(outcome.status).toBe("rejected");
    expect(outcome.detail).toContain("no error counts");
  });

  it("does NOT record sent for PARTIAL_SUCCESS, which a request of one cannot be", () => {
    // Unreachable by construction and handled rather than assumed away. If it
    // arrives, something sent more than one event and the counts name no rows,
    // so this conversion cannot be claimed as recorded.
    const outcome = classifyGoogleConfirm({
      httpStatus: 200,
      body: reply("PARTIAL_SUCCESS", {
        errorInfo: { errorCounts: [{ reason: "PROCESSING_ERROR_REASON_DENIED_CONSENT", recordCount: "2" }] },
      }),
    });
    expect(outcome.status).toBe("rejected");
    expect(outcome.status).not.toBe("sent");
    expect(outcome.retryable).toBe(false);
    expect(outcome.detail).toContain("PARTIAL_SUCCESS");
    expect(outcome.detail).toContain("not confirmed");
  });

  it("keeps polling on PROCESSING, and never calls it sent or failed outright", () => {
    const outcome = classifyGoogleConfirm({ httpStatus: 200, body: reply("PROCESSING") });
    expect(outcome.status).toBe("failed");
    expect(outcome.retryable).toBe(true);
    expect(outcome.detail).toContain("PROCESSING");
  });

  it("keeps polling on a word it does not recognise, and says which word", () => {
    // "We do not recognise this" is not evidence that the conversion failed. It
    // is bounded by the attempt budget, which is what guarantees it settles.
    for (const word of ["REQUEST_STATUS_UNKNOWN", "SOMETHING_NEW", "", undefined, 7, null]) {
      const outcome = classifyGoogleConfirm({ httpStatus: 200, body: reply(word) });
      expect(outcome.status, String(word)).toBe("failed");
      expect(outcome.retryable, String(word)).toBe(true);
      expect(outcome.detail, String(word)).toContain("unrecognised requestStatus");
    }
  });

  it("keeps polling when the reply does not line up with a request of one", () => {
    // Google documents the reply as ordered to match the destinations sent, and
    // one destination was sent. A reply with none or several is a reply we do
    // not understand, and it must not be searched for something to agree with.
    for (const body of [{}, { requestStatusPerDestination: [] }, { requestStatusPerDestination: null }]) {
      const outcome = classifyGoogleConfirm({ httpStatus: 200, body });
      expect(outcome.status, JSON.stringify(body)).toBe("failed");
      expect(outcome.retryable, JSON.stringify(body)).toBe(true);
      expect(outcome.detail, JSON.stringify(body)).toContain("destination statuses for a request of one");
    }
    const two = {
      requestStatusPerDestination: [{ requestStatus: "SUCCESS" }, { requestStatus: "FAILED" }],
    };
    const outcome = classifyGoogleConfirm({ httpStatus: 200, body: two });
    expect(outcome.status).toBe("failed");
    expect(outcome.status).not.toBe("sent");
  });

  it("stops asking on a 404, because an unknown requestId will not become known", () => {
    const outcome = classifyGoogleConfirm({ httpStatus: 404, body: { error: { status: "NOT_FOUND" } } });
    expect(outcome.status).toBe("rejected");
    expect(outcome.retryable).toBe(false);
  });

  it("stops asking on a permission failure, naming it", () => {
    // Google's rule is stricter here than for the ingest: the same access path,
    // `login_account` included, and Read-only access is refused.
    const outcome = classifyGoogleConfirm({
      httpStatus: 403,
      body: {
        error: {
          status: "PERMISSION_DENIED",
          details: [
            { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" },
          ],
        },
      },
    });
    expect(outcome.status).toBe("rejected");
    expect(outcome.retryable).toBe(false);
    expect(outcome.detail).toContain("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
  });

  it("retries a transient status and an unreadable body", () => {
    for (const status of [408, 429, 500, 503]) {
      const outcome = classifyGoogleConfirm({ httpStatus: status, body: {} });
      expect(outcome.status, String(status)).toBe("failed");
      expect(outcome.retryable, String(status)).toBe(true);
    }
    const unread = classifyGoogleConfirm({ httpStatus: 200, body: null, bodyUnreadable: true });
    expect(unread.status).toBe("failed");
    expect(unread.retryable).toBe(true);
    expect(unread.detail).toContain("unreadable body");
  });

  it("reports a transport failure as retryable, with the transport prefix", () => {
    const outcome = classifyGoogleConfirm({ transportError: { message: "fetch failed" } });
    expect(outcome).toEqual({ status: "failed", retryable: true, detail: "transport: fetch failed" });
  });

  it("ALWAYS answers with a status, so a row can never be left unsettled", () => {
    // An action with no status writes nothing, stays claimable, and is claimed
    // again on every sweep for ever. On 2026-10-22 exactly that starved the
    // whole queue: the same 25 oldest rows came back every sweep and no row
    // behind them was reached, so WhatsApp and Brevo stopped for live signups.
    const words = new Set(["sent", "rejected", "failed"]);
    for (const args of [
      {},
      { httpStatus: 0 },
      { httpStatus: 200, body: null },
      { httpStatus: 200, body: "nonsense" },
      { httpStatus: 200, body: { requestStatusPerDestination: [{}] } },
      { httpStatus: 200, body: reply("PROCESSING") },
      { httpStatus: 204, body: {} },
      { httpStatus: 301, body: {} },
      { httpStatus: 404 },
      { httpStatus: 418, body: 7 },
      { transportError: "boom" },
    ]) {
      const outcome = classifyGoogleConfirm(args);
      expect(words.has(outcome.status), `${JSON.stringify(args)} -> ${outcome.status}`).toBe(true);
      expect(typeof outcome.detail, JSON.stringify(args)).toBe("string");
      expect(typeof outcome.retryable, JSON.stringify(args)).toBe("boolean");
    }
  });
});

describe("the confirmation schedule", () => {
  it("is Google's own published backoff", () => {
    // Straight out of the diagnostics guide's table: 30 minutes before the first
    // status request, x1.3 each time, capped at 60, abandoned after 24 hours.
    expect(GOOGLE_CONFIRM_FIRST_DELAY_MINUTES).toBe(30);
    expect(GOOGLE_CONFIRM_BACKOFF).toBe(1.3);
    expect(GOOGLE_CONFIRM_MAX_DELAY_MINUTES).toBe(60);
    expect(GOOGLE_CONFIRM_WINDOW_MINUTES).toBe(1440);

    expect(googleConfirmDelayMinutes(0)).toBe(30);
    expect(googleConfirmDelayMinutes(1)).toBe(39);
    expect(googleConfirmDelayMinutes(2)).toBe(51);
  });

  it("caps the wait, so a row is never parked for longer than an hour", () => {
    for (const polls of [3, 4, 10, 100]) {
      expect(googleConfirmDelayMinutes(polls), String(polls)).toBe(GOOGLE_CONFIRM_MAX_DELAY_MINUTES);
    }
  });

  it("reads a nonsense poll count as the first wait rather than NaN", () => {
    for (const bad of [undefined, null, "", "abc", -1, NaN]) {
      expect(googleConfirmDelayMinutes(bad), JSON.stringify(bad)).toBe(GOOGLE_CONFIRM_FIRST_DELAY_MINUTES);
    }
  });

  it("budgets exactly the 24 hours Google says processing may take", () => {
    // **Computed from the schedule, never typed beside it.** A budget short of
    // the window gives up on conversions Google was still processing; one longer
    // keeps a row unsettled past the point Google will ever answer.
    const elapsed = (polls) =>
      Array.from({ length: polls }, (_, k) => googleConfirmDelayMinutes(k)).reduce((a, b) => a + b, 0);

    expect(elapsed(GOOGLE_CONFIRM_MAX_ATTEMPTS)).toBeGreaterThanOrEqual(GOOGLE_CONFIRM_WINDOW_MINUTES);
    // And one fewer would not: the budget is the smallest that covers it.
    expect(elapsed(GOOGLE_CONFIRM_MAX_ATTEMPTS - 1)).toBeLessThan(GOOGLE_CONFIRM_WINDOW_MINUTES);
  });

  it("is an order of magnitude more than an ingest gets, which is the point", () => {
    // Three polls would abandon every conversion after two hours, unconfirmed,
    // while Google was still working on it.
    expect(GOOGLE_CONFIRM_MAX_ATTEMPTS).toBeGreaterThan(20);
  });
});

describe("getGoogleAccessToken", () => {
  it("exchanges the refresh token with the four documented parameters", async () => {
    const fetchImpl = healthyFetch();
    const got = await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS });
    expect(got.accessToken).toBe(ACCESS_TOKEN);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(GOOGLE_OAUTH_TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(init.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe(CREDENTIALS.clientId);
    expect(body.get("client_secret")).toBe(CREDENTIALS.clientSecret);
    expect(body.get("refresh_token")).toBe(CREDENTIALS.refreshToken);
    // The refresh token travels in the body and never on the query string, so
    // no request line can carry it into a log.
    expect(url).not.toContain(CREDENTIALS.refreshToken);
  });

  it("reuses a cached token rather than minting one per send", async () => {
    const fetchImpl = healthyFetch();
    expect((await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS })).cached).toBe(false);
    expect((await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS })).cached).toBe(true);
    expect(fetchImpl.mock.calls.filter(([u]) => isTokenUrl(u))).toHaveLength(1);
  });

  it("serves one token to BOTH APIs, because one token carries both scopes", async () => {
    // The ingest and the lookup are different hosts and different scopes, and
    // one refresh token mints one access token for both. A token per call would
    // be three wasted round trips per conversion.
    const fetchImpl = healthyFetch();
    await resolveGoogleConversionAction({ fetchImpl, ...CREDENTIALS, stage: "verified" });
    await ingestGoogleConversion({ fetchImpl, ...CREDENTIALS, payload: { events: [] } });
    await retrieveGoogleRequestStatus({ fetchImpl, ...CREDENTIALS, requestId: REQUEST_ID });
    expect(fetchImpl.mock.calls.filter(([u]) => isTokenUrl(u))).toHaveLength(1);
  });

  it("NEVER reuses a token past its expiry", async () => {
    const fetchImpl = healthyFetch();
    const start = Date.UTC(2026, 9, 12, 12, 0, 0);
    await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS, now: start });
    // Inside the hour, and more than the margin from the end of it.
    expect(
      (await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS, now: start + 1_000_000 })).cached
    ).toBe(true);
    // Inside the margin: the token would work for the request that checked it
    // and fail for the one in flight.
    expect(
      (
        await getGoogleAccessToken({
          fetchImpl,
          ...CREDENTIALS,
          now: start + 3_600_000 - GOOGLE_TOKEN_REFRESH_MARGIN_MS + 1,
        })
      ).cached
    ).toBe(false);
  });

  it("does not serve a token minted for another credential", async () => {
    // That token would be valid and belong to the wrong account.
    const fetchImpl = healthyFetch();
    await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS });
    const other = await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS, refreshToken: "a-different-token" });
    expect(other.cached).toBe(false);
  });

  it("does not cache a token whose lifetime it was not told", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => ({ access_token: ACCESS_TOKEN }) }));
    expect((await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS })).accessToken).toBe(ACCESS_TOKEN);
    expect((await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS })).cached).toBe(false);
  });

  it("treats invalid_grant as permanent, naming it", async () => {
    // The consent screen left in "Testing" expires refresh tokens after seven
    // days, and that is permanent until somebody mints a new one -- so it must
    // not spend a row's whole retry budget discovering it.
    const fetchImpl = vi.fn(async () => ({
      status: 400,
      json: async () => ({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
    }));
    const { failure } = await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS });
    expect(failure.retryable).toBe(false);
    expect(failure.detail).toContain("invalid_grant");
  });

  it("retries a 5xx from the token endpoint", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 503, json: async () => ({}) }));
    expect((await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS })).failure.retryable).toBe(true);
  });

  it("fails rather than returning an empty token for a 200 with no access_token", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => ({}) }));
    const { failure, accessToken } = await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS });
    expect(accessToken).toBeUndefined();
    expect(failure.retryable).toBe(true);
  });

  it("never puts a secret in a failure detail, however the error quoted it", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 400,
      json: async () => ({
        error: "invalid_client",
        error_description: `secret ${CREDENTIALS.clientSecret} and ${encodeURIComponent(CREDENTIALS.refreshToken)}`,
      }),
    }));
    const { failure } = await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS });
    expect(failure.detail).not.toContain(CREDENTIALS.clientSecret);
    expect(failure.detail).not.toContain(CREDENTIALS.refreshToken);
    expect(failure.detail).toContain("[redacted]");
  });

  it("reports a transport failure with the transport prefix and the step", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const { failure } = await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS });
    expect(failure.retryable).toBe(true);
    // The transport prefix leads, as it does in every sender.
    expect(failure.detail).toMatch(/^transport: /);
  });
});

describe("resolveGoogleConversionAction", () => {
  const args = () => ({ fetchImpl: healthyFetch(), ...CREDENTIALS, stage: "verified" });

  it("asks for the action by name and hands back its NUMERIC id", async () => {
    const a = args();
    const resolved = await resolveGoogleConversionAction(a);
    expect(resolved.conversionActionId).toBe(ACTION_ID);
    // And never the resource name: that is the value the ingest refuses.
    expect(resolved).not.toHaveProperty("resourceName");
    expect(resolved.conversionActionId).not.toContain("/");

    const [url, init] = a.fetchImpl.mock.calls.find(([u]) => isSearchUrl(u));
    expect(url).toContain(`/customers/${CUSTOMER_ID}/googleAds:search`);
    const body = JSON.parse(init.body);
    expect(body.query).toContain("conversion_action.name = 'FXBO_Client_Verified'");
    expect(body.query).toContain("conversion_action.id");
    // `pageSize` in the body is answered with PAGE_SIZE_NOT_SUPPORTED.
    expect(body).not.toHaveProperty("pageSize");
    expect(init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("falls back to the resource name's last segment, which is the same number", async () => {
    // Google says to take the id from the `id` field; the tail of the resource
    // name is the same value, and this covers a response that carried one and
    // not the other.
    const fetchImpl = vi.fn(async (url) =>
      isTokenUrl(url)
        ? TOKEN_OK
        : { status: 200, json: async () => ({ results: [{ conversionAction: { resourceName: ACTION_RESOURCE } }] }) }
    );
    expect((await resolveGoogleConversionAction({ ...args(), fetchImpl })).conversionActionId).toBe(ACTION_ID);
  });

  it("refuses a row whose id is not a number, rather than passing it on", async () => {
    // An empty `productDestinationId`, or one holding a name, is accepted with a
    // 200 and refused a day later as an error count naming no row.
    const fetchImpl = vi.fn(async (url) =>
      isTokenUrl(url)
        ? TOKEN_OK
        : {
            status: 200,
            json: async () => ({ results: [{ conversionAction: { name: "FXBO_Client_Verified" } }] }),
          }
    );
    const resolved = await resolveGoogleConversionAction({ ...args(), fetchImpl });
    expect(resolved.conversionActionId).toBeUndefined();
    expect(resolved.failure.retryable).toBe(false);
    expect(resolved.failure.detail).toContain("no numeric id");
  });

  it("caches the id, so the lookup is not a second round trip per conversion", async () => {
    const a = args();
    await resolveGoogleConversionAction(a);
    const again = await resolveGoogleConversionAction({ ...a, fetchImpl: a.fetchImpl });
    expect(again.conversionActionId).toBe(ACTION_ID);
    expect(again.cached).toBe(true);
    expect(a.fetchImpl.mock.calls.filter(([u]) => isSearchUrl(u))).toHaveLength(1);
  });

  it("asks once per stage, because each stage is its own action", async () => {
    const a = args();
    await resolveGoogleConversionAction(a);
    await resolveGoogleConversionAction({ ...a, stage: "first_deposit" });
    expect(a.fetchImpl.mock.calls.filter(([u]) => isSearchUrl(u))).toHaveLength(2);
  });

  it("FAILS LOUDLY when the name resolves to nothing, and never guesses an id", async () => {
    // Renamed, paused, removed, created in another account, or created as a
    // website tag rather than an import action. Terminal -- none of those is
    // different in five minutes -- and the detail names the constant so the fix
    // is a lookup in the UI.
    const fetchImpl = vi.fn(async (url) => {
      if (isTokenUrl(url)) return TOKEN_OK;
      return { status: 200, json: async () => ({ results: [] }) };
    });
    const resolved = await resolveGoogleConversionAction({ ...args(), fetchImpl });
    expect(resolved.conversionActionId).toBeUndefined();
    expect(resolved.failure.retryable).toBe(false);
    expect(resolved.failure.detail).toContain("FXBO_Client_Verified");
    expect(resolved.failure.detail).toContain("did not resolve");
  });

  it("does not cache a failure, so a fix in the UI needs no restart", async () => {
    let answer = { status: 200, json: async () => ({ results: [] }) };
    const fetchImpl = vi.fn(async (url) => (isTokenUrl(url) ? TOKEN_OK : answer));
    expect((await resolveGoogleConversionAction({ ...args(), fetchImpl })).failure).toBeTruthy();
    answer = SEARCH_OK;
    expect((await resolveGoogleConversionAction({ ...args(), fetchImpl })).conversionActionId).toBe(ACTION_ID);
  });

  it("refuses an ambiguous name rather than picking one of two actions", async () => {
    // Two enabled import actions sharing a name would split that stage's
    // reporting between them with nothing saying so, and there is no right
    // answer to choose.
    const fetchImpl = vi.fn(async (url) => {
      if (isTokenUrl(url)) return TOKEN_OK;
      return {
        status: 200,
        json: async () => ({
          results: [{ conversionAction: { id: "1" } }, { conversionAction: { id: "2" } }],
        }),
      };
    });
    const resolved = await resolveGoogleConversionAction({ ...args(), fetchImpl });
    expect(resolved.conversionActionId).toBeUndefined();
    expect(resolved.failure.retryable).toBe(false);
    expect(resolved.failure.detail).toContain("ambiguous");
    expect(resolved.failure.detail).toContain("2");
  });

  it("passes the token exchange's own failure through rather than hiding it", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 400, json: async () => ({ error: "invalid_grant" }) }));
    const resolved = await resolveGoogleConversionAction({ ...args(), fetchImpl });
    expect(resolved.failure.detail).toContain("access token");
    expect(resolved.failure.retryable).toBe(false);
  });

  it("retries a 5xx from the lookup and not a 403", async () => {
    const answer = (status) =>
      vi.fn(async (url) => (isTokenUrl(url) ? TOKEN_OK : { status, json: async () => ({ error: { status: "X" } }) }));
    expect((await resolveGoogleConversionAction({ ...args(), fetchImpl: answer(503) })).failure.retryable).toBe(true);
    clearGoogleCaches();
    expect((await resolveGoogleConversionAction({ ...args(), fetchImpl: answer(403) })).failure.retryable).toBe(false);
  });

  it("refuses a stage with no action without asking Google at all", async () => {
    const a = args();
    const resolved = await resolveGoogleConversionAction({ ...a, stage: GTM_OWNED_STAGE });
    expect(resolved.failure.retryable).toBe(false);
    expect(a.fetchImpl).not.toHaveBeenCalled();
  });

  it("sends login-customer-id on the Ads lookup only when a manager is configured", async () => {
    // The Google Ads API still takes headers, and this one is required only when
    // reaching the customer through that manager. A wrong one is
    // USER_PERMISSION_DENIED.
    const plain = healthyFetch();
    await resolveGoogleConversionAction({ ...CREDENTIALS, fetchImpl: plain, stage: "verified" });
    const [, bare] = plain.mock.calls.find(([u]) => isSearchUrl(u));
    expect(bare.headers).not.toHaveProperty("login-customer-id");

    clearGoogleCaches();
    const managed = healthyFetch();
    await resolveGoogleConversionAction({
      ...CREDENTIALS,
      fetchImpl: managed,
      stage: "verified",
      loginCustomerId: "123-456-7890",
    });
    const [, init] = managed.mock.calls.find(([u]) => isSearchUrl(u));
    // Digits only: Google's own instruction is "1234567890, not 123-456-7890".
    expect(init.headers["login-customer-id"]).toBe("1234567890");
  });

  it("never sends a developer token, in any form", async () => {
    const fetchImpl = healthyFetch();
    await resolveGoogleConversionAction({ ...CREDENTIALS, fetchImpl, stage: "verified", developerToken: "dev-token" });
    const [, init] = fetchImpl.mock.calls.find(([u]) => isSearchUrl(u));
    // Not present and empty either: `developer-token: ""` is a token the API
    // would have to judge. Google says it will start rejecting the header.
    expect(init.headers).not.toHaveProperty("developer-token");
    expect(JSON.stringify(init.headers)).not.toContain("dev-token");
  });
});

describe("ingestGoogleConversion", () => {
  const PAYLOAD = {
    destinations: [
      {
        operatingAccount: { accountType: "GOOGLE_ADS", accountId: CUSTOMER_ID },
        productDestinationId: ACTION_ID,
      },
    ],
    events: [
      {
        adIdentifiers: { gclid: GCLID },
        transactionId: "88214:verified",
        eventTimestamp: "2026-10-12T16:00:00+04:00",
        eventSource: "WEB",
      },
    ],
  };

  const ingest = (over = {}) =>
    ingestGoogleConversion({ fetchImpl: healthyFetch(), ...CREDENTIALS, payload: PAYLOAD, gclid: GCLID, ...over });

  it("posts the payload to events:ingest and hands back the requestId", async () => {
    const fetchImpl = healthyFetch();
    const outcome = await ingest({ fetchImpl });
    // Not `sent`: a 200 is an acceptance, and the conversion is unconfirmed.
    expect(outcome.status).toBe("retrying");
    expect(outcome.requestId).toBe(REQUEST_ID);

    const [url, init] = fetchImpl.mock.calls.find(([u]) => isIngestUrl(u));
    expect(url).toBe(`${DATA_MANAGER_API_HOST}/${DATA_MANAGER_API_VERSION}/events:ingest`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(PAYLOAD);
  });

  it("sends the bearer and NOTHING else as a header", async () => {
    // Google: "Don't set request headers in an `IngestionService` request." The
    // manager account is a body field here (`loginAccount`) and the developer
    // token does not exist on this API at all, so the shortest correct header
    // set is the whole of the instruction.
    const fetchImpl = healthyFetch();
    await ingest({ fetchImpl, loginCustomerId: "1234567890", developerToken: "dev-token" });
    const [, init] = fetchImpl.mock.calls.find(([u]) => isIngestUrl(u));
    expect(Object.keys(init.headers).sort()).toEqual(["Authorization", "Content-Type"]);
    expect(init.headers).not.toHaveProperty("developer-token");
    expect(init.headers).not.toHaveProperty("login-customer-id");
  });

  it("mints the access token once and then ingests on the cached one", async () => {
    const fetchImpl = healthyFetch();
    await ingest({ fetchImpl });
    await ingest({ fetchImpl });
    expect(fetchImpl.mock.calls.filter(([u]) => isTokenUrl(u))).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([u]) => isIngestUrl(u))).toHaveLength(2);
  });

  it("does not ingest at all when the token cannot be minted", async () => {
    const fetchImpl = vi.fn(async (url) =>
      isTokenUrl(url) ? { status: 400, json: async () => ({ error: "invalid_grant" }) } : INGEST_OK
    );
    const outcome = await ingest({ fetchImpl });
    expect(outcome.status).toBe("failed");
    expect(outcome.retryable).toBe(false);
    expect(outcome.detail).toContain("access token");
    expect(outcome.requestId).toBeUndefined();
    expect(fetchImpl.mock.calls.filter(([u]) => isIngestUrl(u))).toHaveLength(0);
  });

  it("rejects a refusal, naming the reason", async () => {
    const fetchImpl = vi.fn(async (url) =>
      isTokenUrl(url)
        ? TOKEN_OK
        : {
            status: 403,
            json: async () => ({
              error: {
                status: "PERMISSION_DENIED",
                message: "Request had insufficient authentication scopes.",
                details: [
                  { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" },
                ],
              },
            }),
          }
    );
    const outcome = await ingest({ fetchImpl });
    expect(outcome.status).toBe("rejected");
    expect(outcome.detail).toContain("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
  });

  it("tells the classifier not to expect a requestId for a validated request", async () => {
    // Read off the payload actually sent rather than from configuration, so the
    // two cannot disagree.
    const fetchImpl = vi.fn(async (url) => (isTokenUrl(url) ? TOKEN_OK : { status: 200, json: async () => ({}) }));
    const validated = await ingest({ fetchImpl, payload: { ...PAYLOAD, validateOnly: true } });
    expect(validated.status).toBe("sent");
    expect(validated.requestId).toBeUndefined();

    clearGoogleCaches();
    const real = vi.fn(async (url) => (isTokenUrl(url) ? TOKEN_OK : { status: 200, json: async () => ({}) }));
    expect((await ingest({ fetchImpl: real })).status).toBe("rejected");
  });

  it("reports a stalled body as a retryable failure, not an acceptance", async () => {
    const fetchImpl = vi.fn(async (url) => (isTokenUrl(url) ? TOKEN_OK : stalledBodyResponse(200)));
    const outcome = await ingest({ fetchImpl });
    expect(outcome.status).toBe("failed");
    expect(outcome.retryable).toBe(true);
    expect(outcome.requestId).toBeUndefined();
    expect(outcome.detail).toContain("body timed out");
  });

  it("bounds BOTH of its outbound calls, not just the ingest", async () => {
    // Node's fetch has no timeout and the sweeper runs rows serially, so an
    // unbounded second call is the same hung sweep as an unbounded first. Each
    // call's signal is checked against its own AbortSignal.timeout, by identity.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = healthyFetch();
    await ingestGoogleConversion({ fetchImpl, ...CREDENTIALS, payload: PAYLOAD });

    const signals = fetchImpl.mock.calls.map(([, init]) => init?.signal);
    expect(signals).toHaveLength(2);
    expect(timeout).toHaveBeenCalledTimes(2);
    for (const [i, signal] of signals.entries()) {
      expect(signal, `call ${i}`).toBeInstanceOf(AbortSignal);
      expect(signal, `call ${i}`).toBe(timeout.mock.results[i].value);
      expect(signal.aborted, `call ${i}`).toBe(false);
    }
  });

  it("never puts a secret OR THE GCLID in the detail, even when Google quotes one back", async () => {
    // The gclid is not a credential and is redacted for its own reason: it is
    // client-linked -- it names one person's click -- and `*_detail` is read
    // straight into the admin table.
    const fetchImpl = vi.fn(async (url) =>
      isTokenUrl(url)
        ? TOKEN_OK
        : {
            status: 400,
            json: async () => ({
              error: {
                status: "INVALID_ARGUMENT",
                message: `Bearer ${ACCESS_TOKEN} rejected: gclid ${GCLID} with secret ${CREDENTIALS.clientSecret}`,
              },
            }),
          }
    );
    const outcome = await ingest({ fetchImpl });
    expect(outcome.detail).not.toContain(ACCESS_TOKEN);
    expect(outcome.detail).not.toContain(CREDENTIALS.clientSecret);
    expect(outcome.detail).not.toContain(GCLID);
    expect(outcome.detail).toContain("[redacted]");
  });
});

describe("retrieveGoogleRequestStatus", () => {
  const confirm = (over = {}) =>
    retrieveGoogleRequestStatus({ fetchImpl: healthyFetch(), ...CREDENTIALS, requestId: REQUEST_ID, ...over });

  it("GETs requestStatus:retrieve with the id on the query string and no body", async () => {
    const fetchImpl = healthyFetch();
    const outcome = await confirm({ fetchImpl });
    expect(outcome.status).toBe("sent");

    const [url, init] = fetchImpl.mock.calls.find(([u]) => isStatusUrl(u));
    expect(url).toBe(
      `${DATA_MANAGER_API_HOST}/${DATA_MANAGER_API_VERSION}/requestStatus:retrieve?requestId=${REQUEST_ID}`
    );
    expect(init.method).toBe("GET");
    // "The request body must be empty."
    expect(init).not.toHaveProperty("body");
    expect(init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    // No Content-Type on a request with no content, and no other header: the
    // call "accepts only a `request_id`, not destination accounts or headers".
    expect(Object.keys(init.headers)).toEqual(["Authorization"]);
  });

  it("asks nothing at all without a request id", async () => {
    // A blank id on the query string is a request for the status of nothing, and
    // the answer to it would be read as this conversion's outcome.
    const fetchImpl = healthyFetch();
    for (const id of ["", null, undefined, "   "]) {
      const outcome = await retrieveGoogleRequestStatus({ fetchImpl, ...CREDENTIALS, requestId: id });
      expect(outcome.status, JSON.stringify(id)).toBe("failed");
      expect(outcome.retryable, JSON.stringify(id)).toBe(false);
      expect(outcome.detail, JSON.stringify(id)).toContain("no requestId");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not ask when the token cannot be minted", async () => {
    const fetchImpl = vi.fn(async (url) =>
      isTokenUrl(url) ? { status: 503, json: async () => ({}) } : CONFIRM_OK
    );
    const outcome = await confirm({ fetchImpl });
    expect(outcome.status).toBe("failed");
    expect(outcome.retryable).toBe(true);
    expect(fetchImpl.mock.calls.filter(([u]) => isStatusUrl(u))).toHaveLength(0);
  });

  it("reports what Google said about the one destination", async () => {
    const failing = vi.fn(async (url) =>
      isTokenUrl(url)
        ? TOKEN_OK
        : {
            status: 200,
            json: async () => ({
              requestStatusPerDestination: [
                {
                  requestStatus: "FAILED",
                  errorInfo: {
                    errorCounts: [{ reason: "PROCESSING_ERROR_REASON_INVALID_GCLID", recordCount: "1" }],
                  },
                },
              ],
            }),
          }
    );
    const outcome = await confirm({ fetchImpl: failing });
    expect(outcome.status).toBe("rejected");
    expect(outcome.detail).toContain("PROCESSING_ERROR_REASON_INVALID_GCLID");
  });

  it("reports a stalled body as retryable, not as an answer", async () => {
    const fetchImpl = vi.fn(async (url) => (isTokenUrl(url) ? TOKEN_OK : stalledBodyResponse(200)));
    const outcome = await confirm({ fetchImpl });
    expect(outcome.status).toBe("failed");
    expect(outcome.retryable).toBe(true);
    expect(outcome.detail).toContain("body timed out");
  });

  it("bounds both of its outbound calls", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = healthyFetch();
    await retrieveGoogleRequestStatus({ fetchImpl, ...CREDENTIALS, requestId: REQUEST_ID });
    const signals = fetchImpl.mock.calls.map(([, init]) => init?.signal);
    expect(signals).toHaveLength(2);
    for (const [i, signal] of signals.entries()) {
      expect(signal, `call ${i}`).toBeInstanceOf(AbortSignal);
      expect(signal, `call ${i}`).toBe(timeout.mock.results[i].value);
    }
  });

  it("never puts a secret in the detail", async () => {
    const fetchImpl = vi.fn(async (url) =>
      isTokenUrl(url)
        ? TOKEN_OK
        : {
            status: 401,
            json: async () => ({
              error: { status: "UNAUTHENTICATED", message: `Bearer ${ACCESS_TOKEN} is not valid` },
            }),
          }
    );
    const outcome = await confirm({ fetchImpl });
    expect(outcome.detail).not.toContain(ACCESS_TOKEN);
    expect(outcome.detail).toContain("[redacted]");
  });
});

// The timeout behaviour every outbound sender shares, from the one contract.
// Node's fetch has no timeout of its own and the sweeper runs rows serially, so
// a stalled Google call would hold every row behind it -- and this destination
// makes TWO requests per phase, both of which the contract's cases walk: the
// first fetch is the token exchange and the second is the ingest.
describeSendTimeout("google ads ingest", {
  ok: () => healthyFetch(),
  send: (fetchImpl) =>
    ingestGoogleConversion({
      fetchImpl,
      ...CREDENTIALS,
      payload: {
        destinations: [
          {
            operatingAccount: { accountType: "GOOGLE_ADS", accountId: CUSTOMER_ID },
            productDestinationId: ACTION_ID,
          },
        ],
        events: [
          {
            adIdentifiers: { gclid: GCLID },
            transactionId: "88214:verified",
            eventTimestamp: "2026-10-12T16:00:00+04:00",
            eventSource: "WEB",
          },
        ],
      },
    }),
});

// And the same contract over the confirmation phase, which is a separate
// outbound call on a separate clock. A poll that hung would hold the sweep
// exactly as a send would, and it is the call this service makes twenty-five
// times as often.
describeSendTimeout("google ads confirm", {
  ok: () => healthyFetch(),
  send: (fetchImpl) => retrieveGoogleRequestStatus({ fetchImpl, ...CREDENTIALS, requestId: REQUEST_ID }),
});
