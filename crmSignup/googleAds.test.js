// @vitest-environment node
//
// The Google Ads half. Four of the failure modes here produce no error at all,
// and every one of them has a precedent in this repository:
//
//   A refused conversion arrives inside an HTTP 200, in `partialFailureError`.
//   Classifying on the status alone records `sent` for a conversion Google threw
//   away -- which is the Meta failure that cost this project a month.
//
//   `conversionValue` is the DECIMAL. The same lookup's `amountMinor` is what
//   OpenAI takes, and sending it here reports a $54.49 deposit as $5,449. Both
//   numbers are accepted without a word, so the fixture below uses an amount
//   whose two forms differ.
//
//   `conversionDateTime` carries an offset, and the account's is +04:00. A UTC
//   stamp is off by a DAY, not an hour, for a deposit made in the small hours of
//   Dubai time -- so the format is pinned with exactly such an instant.
//
//   A row with no gclid cannot be attributed. Uploaded anyway it is a conversion
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
  GOOGLE_ADS_ACCOUNT_OFFSET,
  GOOGLE_ADS_API_HOST,
  GOOGLE_ADS_API_VERSION,
  GOOGLE_ADS_CONVERSION_ACTIONS,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_TOKEN_REFRESH_MARGIN_MS,
  GTM_OWNED_STAGE,
  buildGoogleUpload,
  classifyGoogleOutcome,
  clearGoogleCaches,
  conversionActionQuery,
  decideGoogleSkip,
  decideGoogleValueFailure,
  getGoogleAccessToken,
  googleConversionActionFor,
  googleConversionDateTime,
  googleOrderId,
  googleValueFields,
  parseUtcOffsetMinutes,
  readGoogleError,
  resolveGoogleConversionAction,
  resolveTimezoneOffset,
  searchUrl,
  uploadClickConversionsUrl,
  uploadGoogleConversion,
} from "./googleAds.js";

// The live account, digits only. The dashed form is what an operator copies out
// of the Google Ads UI and what the API refuses.
const CUSTOMER_ID = "4743067250";
const ACTION_RESOURCE = "customers/4743067250/conversionActions/987654321";

const CREDENTIALS = {
  customerId: CUSTOMER_ID,
  clientId: "google-client",
  clientSecret: "google-secret",
  refreshToken: "google-refresh",
};

// The access token a healthy exchange hands back. Distinctive, so a header
// carrying something else cannot pass by accident.
const ACCESS_TOKEN = "ya29.a0-access-token";
const TOKEN_OK = { status: 200, json: async () => ({ access_token: ACCESS_TOKEN, expires_in: 3600 }) };
const SEARCH_OK = {
  status: 200,
  json: async () => ({ results: [{ conversionAction: { resourceName: ACTION_RESOURCE } }] }),
};
const UPLOAD_OK = {
  status: 200,
  json: async () => ({
    results: [{ conversionAction: ACTION_RESOURCE, gclid: "Cj0-gclid", conversionDateTime: "2026-10-12 16:00:00+04:00" }],
    jobId: "1001",
  }),
};

const isTokenUrl = (url) => String(url) === GOOGLE_OAUTH_TOKEN_URL;
const isSearchUrl = (url) => String(url).endsWith("googleAds:search");
const isUploadUrl = (url) => String(url).endsWith(":uploadClickConversions");

/** A fetch that answers every one of this destination's three calls the way a
 *  healthy Google does. */
const healthyFetch = () =>
  vi.fn(async (url) => {
    if (isTokenUrl(url)) return TOKEN_OK;
    if (isSearchUrl(url)) return SEARCH_OK;
    if (isUploadUrl(url)) return UPLOAD_OK;
    throw new Error(`unexpected fetch: ${url}`);
  });

afterEach(() => {
  // The token and the resolved conversion action live in the module, so without
  // this one case's token is served to the next -- and the case that proves a
  // token is REUSED would pass on a token minted by the case before it.
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
});

describe("decideGoogleSkip", () => {
  const SENDABLE = { stage: "verified", ...CREDENTIALS, gclid: "Cj0-gclid" };

  it("is silent for a stage with an action, a configured account and a gclid", () => {
    expect(decideGoogleSkip(SENDABLE)).toBeNull();
  });

  it("names the refresh token first, because it is what 'not configured' means", () => {
    // With nothing set, every reason below is also true, and this is the one an
    // operator can act on. The ordering is decideMetaSkip's, decideBrevoSkip's
    // and decideOpenaiSkip's.
    expect(decideGoogleSkip({})).toEqual({ reason: "google ads not configured" });
    expect(decideGoogleSkip({ ...SENDABLE, refreshToken: "" })).toEqual({
      reason: "google ads not configured",
    });
    expect(decideGoogleSkip({ ...SENDABLE, refreshToken: "   " })).toEqual({
      reason: "google ads not configured",
    });
  });

  it("names the OAuth client separately, because it is a different line of .env", () => {
    expect(decideGoogleSkip({ ...SENDABLE, clientId: "" })).toEqual({
      reason: "google ads oauth client not configured",
    });
    expect(decideGoogleSkip({ ...SENDABLE, clientSecret: "" })).toEqual({
      reason: "google ads oauth client not configured",
    });
  });

  it("names the customer id separately: without it there is no URL to post to", () => {
    // The same shape as OpenAI's missing pixel id, and a skip for the same
    // reason -- nothing was attempted, so nothing was refused.
    expect(decideGoogleSkip({ ...SENDABLE, customerId: "" })).toEqual({
      reason: "google ads customer id not configured",
    });
    // A value with no digits at all is no customer id either.
    expect(decideGoogleSkip({ ...SENDABLE, customerId: "none" })).toEqual({
      reason: "google ads customer id not configured",
    });
    // The dashed form IS a customer id; the sender strips the dashes.
    expect(decideGoogleSkip({ ...SENDABLE, customerId: "474-306-7250" })).toBeNull();
  });

  it("does NOT require a developer token, which the API has ignored since the sunset", () => {
    // Google's own words: "optional and ignored by the API servers", and "we
    // encourage you to update your app to stop sending a developer token". A
    // gate on it would skip every conversion over a header the API throws away.
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
    expect(decideGoogleSkip({ ...SENDABLE, stage: "whatever" })).toEqual({
      reason: "stage has no Google Ads conversion action",
    });
  });

  it("skips a row with no gclid, saying that the click cannot be attributed", () => {
    // **The upload must not happen.** Google counts an unattributed conversion
    // against no campaign, so it inflates the account total while leaving every
    // campaign's own number unchanged -- it corrupts the figure the bidding
    // reads, and nothing in the account says where it came from. A visible skip
    // is strictly better.
    for (const gclid of ["", "   ", null, undefined]) {
      expect(decideGoogleSkip({ ...SENDABLE, gclid }), JSON.stringify(gclid)).toEqual({
        reason: "no gclid: the click cannot be attributed in Google Ads",
      });
    }
  });

  it("puts the configuration reasons ahead of the stage and the row", () => {
    // A row that is wrong in several ways at once must report the reason an
    // operator can act on. With nothing configured, "registered" and "no gclid"
    // are both true as well, and reading either would make a dead integration
    // look like a design choice in the settings tab.
    expect(decideGoogleSkip({ stage: GTM_OWNED_STAGE, gclid: "" })).toEqual({
      reason: "google ads not configured",
    });
    // And the stage ahead of the row: `registered` is never ours whatever click
    // produced it, so it must not be reported as a missing gclid.
    expect(decideGoogleSkip({ ...SENDABLE, stage: GTM_OWNED_STAGE, gclid: "" })).toEqual({
      reason: "registered is owned by the GTM container",
    });
  });
});

describe("googleConversionDateTime", () => {
  it("emits Google's documented format, to the second, with the offset", () => {
    // "yyyy-mm-dd hh:mm:ss+|-hh:mm" -- a SPACE, not an ISO `T`, and an explicit
    // signed offset. Date.prototype.toISOString() produces neither.
    expect(googleConversionDateTime("2026-10-12T12:00:00Z")).toBe("2026-10-12 16:00:00+04:00");
    expect(googleConversionDateTime("2026-10-12T12:00:00Z")).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/
    );
  });

  it("stamps the ACCOUNT's zone on an instant where UTC falls on another DAY", () => {
    // 22:30 UTC on 11 October is 02:30 on 12 October in Dubai. A UTC stamp
    // would report this deposit against the previous day's clicks, which is a
    // reconciliation that silently never matches the Google Ads UI -- the
    // numbers a report is read beside.
    expect(googleConversionDateTime("2026-10-11T22:30:00Z")).toBe("2026-10-12 02:30:00+04:00");
    // And the other edge of the same day.
    expect(googleConversionDateTime("2026-10-12T20:00:00Z")).toBe("2026-10-13 00:00:00+04:00");
  });

  it("is the account's offset by default, and +04:00 is what that is", () => {
    expect(GOOGLE_ADS_ACCOUNT_OFFSET).toBe("+04:00");
    expect(googleConversionDateTime("2026-10-12T12:00:00Z")).toBe(
      googleConversionDateTime("2026-10-12T12:00:00Z", GOOGLE_ADS_ACCOUNT_OFFSET)
    );
  });

  it("does not read the server's own timezone", () => {
    // The IIS host's zone is not the account's, and a host somebody moves must
    // not change what a row stamps. Every field is read with a getUTC* accessor
    // off a shifted instant, which is what makes this true.
    for (const tz of ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Kiritimati"]) {
      vi.stubEnv("TZ", tz);
      expect(googleConversionDateTime("2026-10-12T12:00:00Z"), tz).toBe("2026-10-12 16:00:00+04:00");
    }
  });

  it("writes the offset from the same number it shifted by", () => {
    // Two independent writings of an offset can disagree, and the one that
    // matters is the one the digits were computed with.
    expect(googleConversionDateTime("2026-10-12T12:00:00Z", "-08:00")).toBe("2026-10-12 04:00:00-08:00");
    expect(googleConversionDateTime("2026-10-12T12:00:00Z", "+00:00")).toBe("2026-10-12 12:00:00+00:00");
    // A half-hour zone, which is where a formatter that only carried hours
    // would be half an hour wrong and perfectly well-formed.
    expect(googleConversionDateTime("2026-10-12T12:00:00Z", "+05:30")).toBe("2026-10-12 17:30:00+05:30");
    expect(googleConversionDateTime("2026-10-12T12:00:00Z", "-03:30")).toBe("2026-10-12 08:30:00-03:30");
  });

  it("takes a Date, an epoch and a MySQL-shaped string alike", () => {
    const at = new Date("2026-10-12T12:00:00Z");
    expect(googleConversionDateTime(at)).toBe("2026-10-12 16:00:00+04:00");
    expect(googleConversionDateTime(at.getTime())).toBe("2026-10-12 16:00:00+04:00");
  });

  it("is empty for a value that is not a time, rather than stamping NaN", () => {
    // "NaN-NaN-NaN NaN:NaN:NaN+04:00" is well-formed enough to send and is
    // refused with nothing in the row to say why.
    for (const bad of ["", null, undefined, "not a date", new Date("nope"), NaN]) {
      expect(googleConversionDateTime(bad), JSON.stringify(bad)).toBe("");
    }
  });

  it("is empty for an offset that is not an offset, so no payload can carry one", () => {
    // The resolver falls back to the account's offset for a bad configured
    // value, so this is the backstop beneath it: a bad offset reaching here
    // produces no timestamp, and buildGoogleUpload then builds no payload.
    for (const bad of ["Z", "+4:00", "0400", "+04", "", "GMT+4", "+15:00", "+04:60"]) {
      expect(googleConversionDateTime("2026-10-12T12:00:00Z", bad), bad).toBe("");
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

describe("googleOrderId", () => {
  it("is <client>:<stage>, the identity the row already has", () => {
    expect(googleOrderId({ crmClientId: "88214", stage: "verified" })).toBe("88214:verified");
  });

  it("is the SAME identity Meta's event_id and OpenAI's event id are built from", () => {
    // One funnel event, one identity across three platforms. A third scheme
    // would be a third thing to keep consistent, and the dedupe is the whole
    // reason any of them exists.
    const of = { crmClientId: "88214", stage: "first_deposit" };
    expect(googleOrderId(of)).toBe(openaiEventId(of));
    expect(googleOrderId(of)).toBe(`${of.crmClientId}:${of.stage}`);
  });

  it("is empty with no client id, rather than an id shared by every such client", () => {
    // ":verified" would be the same order id for every client with no id -- and
    // since Google's uniqueness is per conversion action, the second one would
    // be refused outright as DUPLICATE_ORDER_ID.
    expect(googleOrderId({ stage: "verified" })).toBe("");
    expect(googleOrderId({ crmClientId: "", stage: "verified" })).toBe("");
    expect(googleOrderId({ crmClientId: "88214" })).toBe("");
    expect(googleOrderId()).toBe("");
  });
});

describe("googleValueFields", () => {
  // $54.49: the decimal and the minor-unit integer differ, and differ by a
  // factor of a hundred. A fixture with a round amount would pass with the two
  // units crossed.
  const DEPOSIT = { currency: "USD", valueDecimal: 54.49, amountMinor: 5449 };

  it("sends the DECIMAL, never the minor-unit integer", () => {
    // **Google's conversionValue is a double.** `5449` here reports a $54.49
    // deposit as $5,449, and Google accepts it without a word -- in the
    // direction that tells Smart Bidding to buy much more of that traffic.
    expect(googleValueFields(DEPOSIT)).toEqual({ conversionValue: 54.49, currencyCode: "USD" });
    expect(googleValueFields(DEPOSIT).conversionValue).not.toBe(DEPOSIT.amountMinor);
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
    // A value with no currency is a number with no unit.
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
        currencyCode: code,
      });
    }
  });

  it("upper-cases a code as the allowlist holds it", () => {
    expect(googleValueFields({ currency: "usd", valueDecimal: 54.49 })).toEqual({
      conversionValue: 54.49,
      currencyCode: "USD",
    });
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

  it("fails the deposit by name rather than uploading it unpriced", () => {
    // Uploading with no value is available -- Google accepts it -- and is
    // refused: `orderId` makes this conversion unique per action for ever, so
    // an unpriced upload is the FINAL word on that deposit's worth and no later
    // send can correct it.
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

describe("buildGoogleUpload", () => {
  const PARTS = {
    stage: "verified",
    crmClientId: "88214",
    gclid: "Cj0KCQiA-gclid",
    conversionAction: ACTION_RESOURCE,
    receivedAt: "2026-10-12T12:00:00Z",
  };

  it("builds one conversion, with the four fields every stage carries", () => {
    expect(buildGoogleUpload(PARTS)).toEqual({
      conversions: [
        {
          gclid: "Cj0KCQiA-gclid",
          conversionAction: ACTION_RESOURCE,
          conversionDateTime: "2026-10-12 16:00:00+04:00",
          orderId: "88214:verified",
        },
      ],
      partialFailure: true,
    });
  });

  it("always sets partialFailure, which is how a refusal reaches us at all", () => {
    // Google documents the field as required and says it "should always be set
    // to true". With it off, one bad conversion fails the whole request at the
    // RPC level; with it on, the refusal arrives inside a 200 where
    // classifyGoogleOutcome reads it.
    for (const stage of Object.keys(GOOGLE_ADS_CONVERSION_ACTIONS)) {
      const payload = buildGoogleUpload({
        ...PARTS,
        stage,
        depositValue: { currency: "USD", valueDecimal: 54.49, amountMinor: 5449 },
      });
      expect(payload.partialFailure, stage).toBe(true);
    }
  });

  it("carries the resource name it was given, and never a name or an id of its own", () => {
    const payload = buildGoogleUpload({ ...PARTS, conversionAction: "customers/1/conversionActions/2" });
    expect(payload.conversions[0].conversionAction).toBe("customers/1/conversionActions/2");
    // Not the display name: the upload names the action by resource name.
    expect(JSON.stringify(payload)).not.toContain("FXBO_Client_Verified");
  });

  it("carries the deposit's decimal value and currency, at the deposit stage only", () => {
    const deposit = { currency: "USD", valueDecimal: 54.49, amountMinor: 5449 };
    const [conversion] = buildGoogleUpload({ ...PARTS, stage: DEPOSIT_VALUE_STAGE, depositValue: deposit }).conversions;
    expect(conversion.conversionValue).toBe(54.49);
    expect(conversion.currencyCode).toBe("USD");
    expect(conversion.orderId).toBe("88214:first_deposit");

    // Every other stage passes no depositValue and carries no pair -- and one
    // that somehow did must still not carry it.
    const [other] = buildGoogleUpload({ ...PARTS, stage: "live_account", depositValue: deposit }).conversions;
    expect(other).not.toHaveProperty("conversionValue");
    expect(other).not.toHaveProperty("currencyCode");
  });

  it("never puts the minor-unit integer in conversionValue", () => {
    const [conversion] = buildGoogleUpload({
      ...PARTS,
      stage: DEPOSIT_VALUE_STAGE,
      depositValue: { currency: "USD", valueDecimal: 54.49, amountMinor: 5449 },
    }).conversions;
    expect(conversion.conversionValue).not.toBe(5449);
    expect(JSON.stringify(conversion)).not.toContain("5449");
  });

  it("adds validateOnly only when it is on, and never sends it as false", () => {
    expect(buildGoogleUpload(PARTS)).not.toHaveProperty("validateOnly");
    expect(buildGoogleUpload({ ...PARTS, validateOnly: false })).not.toHaveProperty("validateOnly");
    expect(buildGoogleUpload({ ...PARTS, validateOnly: true }).validateOnly).toBe(true);
  });

  it("builds nothing at all without a gclid", () => {
    // decideGoogleSkip already refuses this with a reason that lands in the
    // row; this is the second half of that one test, because "no payload" is a
    // louder way to be wrong than an unattributed conversion.
    expect(buildGoogleUpload({ ...PARTS, gclid: "" })).toBeNull();
    expect(buildGoogleUpload({ ...PARTS, gclid: undefined })).toBeNull();
  });

  it("builds nothing for a stage with no conversion action", () => {
    expect(buildGoogleUpload({ ...PARTS, stage: GTM_OWNED_STAGE })).toBeNull();
    expect(buildGoogleUpload({ ...PARTS, stage: "lead" })).toBeNull();
  });

  it("builds nothing without a resolved conversion action", () => {
    // An upload with no conversion action is not a conversion, and the field is
    // refused here rather than attached behind an `if`.
    expect(buildGoogleUpload({ ...PARTS, conversionAction: "" })).toBeNull();
    expect(buildGoogleUpload({ ...PARTS, conversionAction: undefined })).toBeNull();
  });

  it("builds nothing without a client id, so no two clients share an order id", () => {
    expect(buildGoogleUpload({ ...PARTS, crmClientId: "" })).toBeNull();
  });

  it("builds nothing when received_at is not a time, or the offset is not one", () => {
    expect(buildGoogleUpload({ ...PARTS, receivedAt: "" })).toBeNull();
    expect(buildGoogleUpload({ ...PARTS, receivedAt: "not a date" })).toBeNull();
    expect(buildGoogleUpload({ ...PARTS, offset: "Z" })).toBeNull();
  });

  it("sends no jobId, no userIdentifiers and no consent", () => {
    // `jobId` groups the requests of one logical batch in Google's offline-data
    // diagnostics, and a batch of one has no siblings. Hashed identifiers would
    // be an enhanced-conversions setup nobody has configured on this account,
    // and sending them unasked would be a consent claim we cannot make.
    const [conversion] = buildGoogleUpload(PARTS).conversions;
    expect(Object.keys(conversion).sort()).toEqual([
      "conversionAction",
      "conversionDateTime",
      "gclid",
      "orderId",
    ]);
    expect(buildGoogleUpload(PARTS)).not.toHaveProperty("jobId");
  });

  it("is a batch of exactly one", () => {
    expect(buildGoogleUpload(PARTS).conversions).toHaveLength(1);
  });
});

describe("conversionActionQuery", () => {
  it("filters on the name, on UPLOAD_CLICKS and on ENABLED", () => {
    const query = conversionActionQuery("FXBO_Client_Verified");
    expect(query).toContain("FROM conversion_action");
    expect(query).toContain("conversion_action.name = 'FXBO_Client_Verified'");
    // An account can hold a website tag and an import action with the same
    // name, and uploading to the wrong kind records nothing while answering
    // 200. A removed action still resolves by name, too.
    expect(query).toContain("conversion_action.type = 'UPLOAD_CLICKS'");
    expect(query).toContain("conversion_action.status = 'ENABLED'");
    // The resource name is the whole point of asking.
    expect(query).toContain("conversion_action.resource_name");
  });

  it("escapes a quote rather than ending the literal early", () => {
    expect(conversionActionQuery("it's")).toContain("'it\\'s'");
    expect(conversionActionQuery("a\\b")).toContain("'a\\\\b'");
  });
});

describe("the URLs", () => {
  it("posts the upload to the documented custom method on the customer", () => {
    expect(uploadClickConversionsUrl(GOOGLE_ADS_API_HOST, GOOGLE_ADS_API_VERSION, CUSTOMER_ID)).toBe(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/4743067250:uploadClickConversions`
    );
  });

  it("posts the lookup to googleAds:search on the same customer", () => {
    expect(searchUrl(GOOGLE_ADS_API_HOST, GOOGLE_ADS_API_VERSION, CUSTOMER_ID)).toBe(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/4743067250/googleAds:search`
    );
  });

  it("strips the dashes an operator copies out of the Google Ads UI", () => {
    expect(uploadClickConversionsUrl(GOOGLE_ADS_API_HOST, "v26", "474-306-7250")).toContain(
      "/customers/4743067250:uploadClickConversions"
    );
  });

  it("takes the version from its caller, so a sunset one can be moved without a deploy", () => {
    // Google sunsets a version about a year after releasing it, and a sunset
    // version stops answering rather than degrading.
    expect(uploadClickConversionsUrl(GOOGLE_ADS_API_HOST, "v27", CUSTOMER_ID)).toContain("/v27/");
    expect(GOOGLE_ADS_API_VERSION).toMatch(/^v\d+$/);
  });

  it("falls back to the documented host and version for a blank one", () => {
    expect(uploadClickConversionsUrl("", "", CUSTOMER_ID)).toBe(
      `${GOOGLE_ADS_API_HOST}/${GOOGLE_ADS_API_VERSION}/customers/4743067250:uploadClickConversions`
    );
  });
});

describe("readGoogleError", () => {
  const failure = (errors) => ({
    partialFailureError: {
      code: 3,
      message: "one or more conversions failed",
      details: [{ "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure", errors }],
    },
  });

  it("reads a per-conversion refusal out of a partial-failure body", () => {
    const read = readGoogleError(
      failure([
        {
          errorCode: { conversionUploadError: "EXPIRED_EVENT" },
          message: "The click is older than the conversion action's lookback window.",
          location: { fieldPathElements: [{ fieldName: "conversions", index: 0 }, { fieldName: "gclid" }] },
        },
      ])
    );
    expect(read.partial).toBe(true);
    expect(read.message).toContain("conversionUploadError: EXPIRED_EVENT");
    expect(read.message).toContain("conversions[0]");
  });

  it("matches the failure detail by @type SUFFIX, not by the whole string", () => {
    // The `@type` is version-pinned -- `...v26.errors.GoogleAdsFailure` -- so a
    // full-string match would stop reading errors on the first version bump and
    // every refusal would then read as "accepted".
    const next = {
      partialFailureError: {
        details: [
          {
            "@type": "type.googleapis.com/google.ads.googleads.v31.errors.GoogleAdsFailure",
            errors: [{ errorCode: { conversionUploadError: "CLICK_NOT_FOUND" }, message: "no click" }],
          },
        ],
      },
    };
    expect(readGoogleError(next).message).toContain("CLICK_NOT_FOUND");
  });

  it("still reports a refusal whose details it cannot unpack", () => {
    // A body we only half understand has to fail toward refusing the
    // conversion, never toward calling it sent.
    expect(readGoogleError({ partialFailureError: { message: "something went wrong" } }).message).toContain(
      "something went wrong"
    );
    expect(readGoogleError({ partialFailureError: { details: [] } })).toMatchObject({
      message: "error reported with no message",
    });
    expect(readGoogleError({ partialFailureError: true })).toBeTruthy();
  });

  it("reads the RPC-level error a non-2xx carries, with its enum", () => {
    const read = readGoogleError({
      error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" },
    });
    expect(read.partial).toBe(false);
    expect(read.message).toContain("PERMISSION_DENIED");
  });

  it("names the enum of the four failures that look alike from outside", () => {
    for (const code of [
      "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
      "USER_PERMISSION_DENIED",
      "CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE",
      "DUPLICATE_ORDER_ID",
    ]) {
      const read = readGoogleError({
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
    expect(readGoogleError(UPLOAD_OK_BODY)).toBeNull();
    expect(readGoogleError({ results: [{}] })).toBeNull();
    // An explicit null or empty error is saying there was none.
    expect(readGoogleError({ partialFailureError: null })).toBeNull();
    expect(readGoogleError({ error: null })).toBeNull();
    expect(readGoogleError(null)).toBeNull();
    expect(readGoogleError("")).toBeNull();
  });

  it("cuts the message to what the detail column can hold", () => {
    const read = readGoogleError({ error: { message: "x".repeat(1000), status: "INTERNAL" } });
    expect(read.message.length).toBeLessThanOrEqual(200);
  });
});

const UPLOAD_OK_BODY = {
  results: [{ conversionAction: ACTION_RESOURCE, gclid: "Cj0-gclid" }],
  jobId: "1001",
};

describe("classifyGoogleOutcome", () => {
  it("records a 200 that confirms the conversion as sent", () => {
    expect(classifyGoogleOutcome({ httpStatus: 200, body: UPLOAD_OK_BODY })).toEqual({
      status: "sent",
      retryable: false,
      detail: "http 200",
    });
  });

  it("NEVER records sent for a partialFailureError inside a 200", () => {
    // **The failure this whole module is shaped around.** Google answers 200
    // and reports the refusal in the body; classifying on the status alone
    // records `sent` for a conversion that does not exist. A provider accepting
    // and discarding while our row read `sent` is what cost a month on Meta.
    const outcome = classifyGoogleOutcome({
      httpStatus: 200,
      body: {
        results: [{}],
        partialFailureError: {
          details: [
            {
              "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
              errors: [
                {
                  errorCode: { conversionUploadError: "EXPIRED_EVENT" },
                  message: "too old",
                  location: { fieldPathElements: [{ fieldName: "conversions", index: 0 }] },
                },
              ],
            },
          ],
        },
      },
    });
    expect(outcome.status).toBe("rejected");
    expect(outcome.status).not.toBe("sent");
    expect(outcome.retryable).toBe(false);
    expect(outcome.detail).toContain("EXPIRED_EVENT");
  });

  it("does not record sent for a 200 whose body it could not read", () => {
    // **The opposite of what openai.js does with the same situation, and the
    // difference is the reason.** OpenAI documents no response shape at all, so
    // an empty body there is the API behaving as documented. Google documents
    // `results` and `partialFailureError` exactly, so a body we cannot read
    // means something other than Google answered. Retryable, because the
    // request may well have landed and `orderId` is what makes repeating it
    // safe.
    const unreadable = classifyGoogleOutcome({ httpStatus: 200, body: null, bodyUnreadable: true });
    expect(unreadable).toEqual({ status: "failed", retryable: true, detail: "http 200 unreadable body" });

    const timedOut = classifyGoogleOutcome({
      httpStatus: 200,
      body: null,
      bodyUnreadable: true,
      bodyTimedOut: true,
    });
    expect(timedOut.detail).toBe("http 200 body timed out");
    expect(timedOut.status).toBe("failed");
  });

  it("does not record sent for a 200 that confirms nothing", () => {
    // A proxy answering `{}` with a 200 is not Google taking the conversion.
    for (const body of [{}, { results: [] }, { results: [{}] }, { jobId: "1001" }]) {
      const outcome = classifyGoogleOutcome({ httpStatus: 200, body });
      expect(outcome.status, JSON.stringify(body)).toBe("failed");
      expect(outcome.retryable, JSON.stringify(body)).toBe(true);
      expect(outcome.detail, JSON.stringify(body)).toContain("no result for the conversion");
    }
  });

  it("takes a validated request at its word, because Google returns no results for one", () => {
    // Google: "Results are not returned when validate_only is true." Insisting
    // on a confirmation that does not exist would spend every row's retry
    // budget, so the caller says which kind of request it made.
    expect(classifyGoogleOutcome({ httpStatus: 200, body: {}, expectResults: false })).toEqual({
      status: "sent",
      retryable: false,
      detail: "http 200",
    });
    // A validated request that was REFUSED is still a refusal.
    expect(
      classifyGoogleOutcome({
        httpStatus: 200,
        body: { partialFailureError: { message: "bad gclid" } },
        expectResults: false,
      }).status
    ).toBe("rejected");
  });

  it("retries a transient status, by the one rule all five senders share", () => {
    for (const status of [408, 429, 500, 502, 503]) {
      const outcome = classifyGoogleOutcome({ httpStatus: status, body: {} });
      expect(outcome.status, String(status)).toBe("failed");
      expect(outcome.retryable, String(status)).toBe(true);
    }
  });

  it("rejects a permanent non-2xx, naming the enum that says what to fix", () => {
    const outcome = classifyGoogleOutcome({
      httpStatus: 403,
      body: {
        error: {
          status: "PERMISSION_DENIED",
          details: [
            {
              "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
              errors: [
                {
                  errorCode: { notAllowlistedError: "CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE" },
                  message: "not allowlisted",
                },
              ],
            },
          ],
        },
      },
    });
    expect(outcome.status).toBe("rejected");
    expect(outcome.retryable).toBe(false);
    expect(outcome.detail).toContain("CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE");
  });

  it("is rejected and not failed for a permanent refusal, so the card reads differently", () => {
    // planRetry writes `failed` the moment a retryable outcome runs out of
    // attempts, so with one word for both, an account the project cannot reach
    // would read exactly like a transport outage.
    expect(classifyGoogleOutcome({ httpStatus: 401, body: {} }).status).toBe("rejected");
    expect(classifyGoogleOutcome({ httpStatus: 400, body: {} }).status).toBe("rejected");
  });

  it("reports a transport failure as retryable, with the transport prefix", () => {
    const outcome = classifyGoogleOutcome({ transportError: { message: "fetch failed" } });
    expect(outcome).toEqual({ status: "failed", retryable: true, detail: "transport: fetch failed" });
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
    expect(body.get("client_id")).toBe("google-client");
    expect(body.get("client_secret")).toBe("google-secret");
    expect(body.get("refresh_token")).toBe("google-refresh");
    // The secrets travel in the body, so no request line can carry one into a log.
    expect(url).not.toContain("google-refresh");
    expect(url).not.toContain("google-secret");
  });

  it("reuses a cached token rather than minting one per send", async () => {
    const fetchImpl = healthyFetch();
    const at = new Date("2026-10-12T12:00:00Z");
    const first = await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS, now: at });
    const second = await getGoogleAccessToken({
      fetchImpl,
      ...CREDENTIALS,
      now: new Date(at.getTime() + 60_000),
    });
    expect(second.accessToken).toBe(first.accessToken);
    expect(second.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("NEVER reuses a token past its expiry", async () => {
    // A token used after its hour is a 401 on every send until a restart. The
    // margin is what keeps a correct cache from producing one on a boundary:
    // the lifetime is 3600s, so a call inside the last minute mints again.
    const fetchImpl = healthyFetch();
    const at = new Date("2026-10-12T12:00:00Z");
    await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS, now: at });

    const justInside = new Date(at.getTime() + 3_600_000 - GOOGLE_TOKEN_REFRESH_MARGIN_MS - 1000);
    expect((await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS, now: justInside })).cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const insideMargin = new Date(at.getTime() + 3_600_000 - GOOGLE_TOKEN_REFRESH_MARGIN_MS + 1000);
    expect((await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS, now: insideMargin })).cached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const expired = new Date(at.getTime() + 7_200_000);
    expect((await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS, now: expired })).cached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not serve a token minted for another credential", async () => {
    // A refresh token changed in .env, or a second account: the cached token is
    // perfectly valid and belongs to the wrong customer.
    const fetchImpl = healthyFetch();
    const at = new Date("2026-10-12T12:00:00Z");
    await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS, now: at });
    const other = await getGoogleAccessToken({
      fetchImpl,
      ...CREDENTIALS,
      refreshToken: "another-refresh",
      now: at,
    });
    expect(other.cached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not cache a token whose lifetime it was not told", async () => {
    // A lifetime we were not told is not one to assume, and the only safe
    // assumption is that it has already run out. A round trip per send against
    // a server behaving unexpectedly is the cheap direction.
    const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => ({ access_token: ACCESS_TOKEN }) }));
    const at = new Date("2026-10-12T12:00:00Z");
    expect((await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS, now: at })).accessToken).toBe(ACCESS_TOKEN);
    expect((await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS, now: at })).cached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats invalid_grant as permanent, naming it", async () => {
    // A revoked or expired refresh token. .env.example warns about the common
    // cause: a consent screen left in "Testing" expires one after seven days.
    // Permanent, so a row does not spend its budget discovering that.
    const fetchImpl = vi.fn(async () => ({
      status: 400,
      json: async () => ({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
    }));
    const { failure } = await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS });
    expect(failure.retryable).toBe(false);
    expect(failure.detail).toContain("invalid_grant");
    expect(failure.detail).toContain("access token");
  });

  it("retries a 5xx from the token endpoint", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 503, json: async () => ({ error: "backend_error" }) }));
    const { failure } = await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS });
    expect(failure.retryable).toBe(true);
  });

  it("fails rather than returning an empty token for a 200 with no access_token", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => ({}) }));
    const got = await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS });
    expect(got.accessToken).toBeUndefined();
    expect(got.failure.retryable).toBe(true);
  });

  it("never puts a secret in a failure detail, however the error quoted it", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect failed sending refresh_token=google-refresh&client_secret=google-secret");
    });
    const { failure } = await getGoogleAccessToken({ fetchImpl, ...CREDENTIALS });
    expect(failure.detail).not.toContain("google-refresh");
    expect(failure.detail).not.toContain("google-secret");
    expect(failure.detail).toContain("[redacted]");
    // The transport prefix leads, as it does in every sender.
    expect(failure.detail).toMatch(/^transport: /);
  });
});

describe("resolveGoogleConversionAction", () => {
  const args = () => ({ fetchImpl: healthyFetch(), ...CREDENTIALS, stage: "verified" });

  it("asks for the action by name and hands back its resource name", async () => {
    const a = args();
    const resolved = await resolveGoogleConversionAction(a);
    expect(resolved.resourceName).toBe(ACTION_RESOURCE);

    const [url, init] = a.fetchImpl.mock.calls.find(([u]) => isSearchUrl(u));
    expect(url).toContain(`/customers/${CUSTOMER_ID}/googleAds:search`);
    const body = JSON.parse(init.body);
    expect(body.query).toContain("conversion_action.name = 'FXBO_Client_Verified'");
    // `pageSize` in the body is answered with PAGE_SIZE_NOT_SUPPORTED.
    expect(body).not.toHaveProperty("pageSize");
    expect(init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("caches the resource name, so the lookup is not a second round trip per conversion", async () => {
    const a = args();
    await resolveGoogleConversionAction(a);
    const again = await resolveGoogleConversionAction({ ...a, fetchImpl: a.fetchImpl });
    expect(again.resourceName).toBe(ACTION_RESOURCE);
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
    expect(resolved.resourceName).toBeUndefined();
    expect(resolved.failure.retryable).toBe(false);
    expect(resolved.failure.detail).toContain("FXBO_Client_Verified");
    expect(resolved.failure.detail).toContain("did not resolve");
  });

  it("does not cache a failure, so a fix in the UI needs no restart", async () => {
    let answer = { status: 200, json: async () => ({ results: [] }) };
    const fetchImpl = vi.fn(async (url) => (isTokenUrl(url) ? TOKEN_OK : answer));
    expect((await resolveGoogleConversionAction({ ...args(), fetchImpl })).failure).toBeTruthy();
    answer = SEARCH_OK;
    expect((await resolveGoogleConversionAction({ ...args(), fetchImpl })).resourceName).toBe(ACTION_RESOURCE);
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
          results: [
            { conversionAction: { resourceName: "customers/1/conversionActions/1" } },
            { conversionAction: { resourceName: "customers/1/conversionActions/2" } },
          ],
        }),
      };
    });
    const resolved = await resolveGoogleConversionAction({ ...args(), fetchImpl });
    expect(resolved.resourceName).toBeUndefined();
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
});

describe("uploadGoogleConversion", () => {
  const PAYLOAD = {
    conversions: [
      {
        gclid: "Cj0-gclid",
        conversionAction: ACTION_RESOURCE,
        conversionDateTime: "2026-10-12 16:00:00+04:00",
        orderId: "88214:verified",
      },
    ],
    partialFailure: true,
  };

  const upload = (over = {}) =>
    uploadGoogleConversion({ fetchImpl: healthyFetch(), ...CREDENTIALS, payload: PAYLOAD, ...over });

  it("posts the payload to the customer's uploadClickConversions, with the bearer", async () => {
    const fetchImpl = healthyFetch();
    const outcome = await upload({ fetchImpl });
    expect(outcome.status).toBe("sent");

    const [url, init] = fetchImpl.mock.calls.find(([u]) => isUploadUrl(u));
    expect(url).toBe(`${GOOGLE_ADS_API_HOST}/${GOOGLE_ADS_API_VERSION}/customers/${CUSTOMER_ID}:uploadClickConversions`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(PAYLOAD);
  });

  it("omits developer-token entirely when none is set", async () => {
    // Not present and empty: `developer-token: ""` is a token the API would
    // have to judge. Google encourages not sending one at all, and says it will
    // reject the header in a future major version.
    const fetchImpl = healthyFetch();
    await upload({ fetchImpl });
    const [, init] = fetchImpl.mock.calls.find(([u]) => isUploadUrl(u));
    expect(init.headers).not.toHaveProperty("developer-token");
  });

  it("sends a developer token when one is set, as a bridge for an account mid-transition", async () => {
    const fetchImpl = healthyFetch();
    await upload({ fetchImpl, developerToken: "dev-token" });
    const [, init] = fetchImpl.mock.calls.find(([u]) => isUploadUrl(u));
    expect(init.headers["developer-token"]).toBe("dev-token");
  });

  it("omits login-customer-id unless the account is reached through a manager", async () => {
    // Required only when authorising as a manager, and wrong otherwise:
    // omitting it defaults to the operating customer, and sending the wrong one
    // is USER_PERMISSION_DENIED.
    const fetchImpl = healthyFetch();
    await upload({ fetchImpl });
    const [, plain] = fetchImpl.mock.calls.find(([u]) => isUploadUrl(u));
    expect(plain.headers).not.toHaveProperty("login-customer-id");

    const withManager = healthyFetch();
    await upload({ fetchImpl: withManager, loginCustomerId: "123-456-7890" });
    const [, init] = withManager.mock.calls.find(([u]) => isUploadUrl(u));
    // Digits only: Google's own instruction is "1234567890, not 123-456-7890".
    expect(init.headers["login-customer-id"]).toBe("1234567890");
  });

  it("mints the access token once and then uploads on the cached one", async () => {
    const fetchImpl = healthyFetch();
    await upload({ fetchImpl });
    await upload({ fetchImpl });
    expect(fetchImpl.mock.calls.filter(([u]) => isTokenUrl(u))).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([u]) => isUploadUrl(u))).toHaveLength(2);
  });

  it("does not upload at all when the token cannot be minted", async () => {
    const fetchImpl = vi.fn(async (url) =>
      isTokenUrl(url) ? { status: 400, json: async () => ({ error: "invalid_grant" }) } : UPLOAD_OK
    );
    const outcome = await upload({ fetchImpl });
    expect(outcome.status).toBe("failed");
    expect(outcome.retryable).toBe(false);
    expect(outcome.detail).toContain("access token");
    expect(fetchImpl.mock.calls.filter(([u]) => isUploadUrl(u))).toHaveLength(0);
  });

  it("reads a refusal out of a 200 and records rejected", async () => {
    const fetchImpl = vi.fn(async (url) =>
      isTokenUrl(url)
        ? TOKEN_OK
        : {
            status: 200,
            json: async () => ({
              results: [{}],
              partialFailureError: {
                details: [
                  {
                    "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
                    errors: [{ errorCode: { conversionUploadError: "CLICK_NOT_FOUND" }, message: "no click" }],
                  },
                ],
              },
            }),
          }
    );
    const outcome = await upload({ fetchImpl });
    expect(outcome.status).toBe("rejected");
    expect(outcome.detail).toContain("CLICK_NOT_FOUND");
  });

  it("tells the classifier not to expect results for a validated request", async () => {
    // Read off the payload actually sent rather than from configuration, so the
    // two cannot disagree.
    const fetchImpl = vi.fn(async (url) => (isTokenUrl(url) ? TOKEN_OK : { status: 200, json: async () => ({}) }));
    const outcome = await upload({ fetchImpl, payload: { ...PAYLOAD, validateOnly: true } });
    expect(outcome.status).toBe("sent");

    const real = vi.fn(async (url) => (isTokenUrl(url) ? TOKEN_OK : { status: 200, json: async () => ({}) }));
    clearGoogleCaches();
    expect((await upload({ fetchImpl: real })).status).toBe("failed");
  });

  it("reports a stalled body as a retryable failure, not a send", async () => {
    const fetchImpl = vi.fn(async (url) => (isTokenUrl(url) ? TOKEN_OK : stalledBodyResponse(200)));
    const outcome = await upload({ fetchImpl });
    expect(outcome.status).toBe("failed");
    expect(outcome.retryable).toBe(true);
    expect(outcome.detail).toContain("body timed out");
  });

  it("bounds BOTH of its outbound calls, not just the upload", async () => {
    // This destination is the only one that makes two requests, and the shared
    // contract below walks whichever comes first. An unbounded second call is
    // the same hung sweep as an unbounded first: Node's fetch has no timeout,
    // and the sweeper runs rows serially. So each call's signal is checked
    // against its own AbortSignal.timeout, by identity.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = healthyFetch();
    await uploadGoogleConversion({ fetchImpl, ...CREDENTIALS, payload: PAYLOAD });

    const signals = fetchImpl.mock.calls.map(([, init]) => init?.signal);
    expect(signals).toHaveLength(2);
    expect(timeout).toHaveBeenCalledTimes(2);
    for (const [i, signal] of signals.entries()) {
      expect(signal, `call ${i}`).toBeInstanceOf(AbortSignal);
      expect(signal, `call ${i}`).toBe(timeout.mock.results[i].value);
      expect(signal.aborted, `call ${i}`).toBe(false);
    }
    // And the lookup, which is the third call this module can make.
    clearGoogleCaches();
    const resolving = healthyFetch();
    await resolveGoogleConversionAction({ fetchImpl: resolving, ...CREDENTIALS, stage: "verified" });
    for (const [, init] of resolving.mock.calls) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("never puts a secret in the detail, even when Google quotes one back", async () => {
    const fetchImpl = vi.fn(async (url) =>
      isTokenUrl(url)
        ? TOKEN_OK
        : {
            status: 401,
            json: async () => ({
              error: { status: "UNAUTHENTICATED", message: `Bearer ${ACCESS_TOKEN} is not valid for dev-token` },
            }),
          }
    );
    const outcome = await upload({ fetchImpl, developerToken: "dev-token" });
    expect(outcome.detail).not.toContain(ACCESS_TOKEN);
    expect(outcome.detail).not.toContain("dev-token");
    expect(outcome.detail).toContain("[redacted]");
  });
});

// The timeout behaviour every outbound sender shares, from the one contract.
// Node's fetch has no timeout of its own and the sweeper runs rows serially, so
// a stalled Google call would hold every row behind it -- and this destination
// makes TWO requests, both of which the contract's cases walk: the first fetch
// here is the token exchange and the second is the upload.
describeSendTimeout("google ads", {
  ok: () => healthyFetch(),
  send: (fetchImpl) =>
    uploadGoogleConversion({
      fetchImpl,
      ...CREDENTIALS,
      payload: {
        conversions: [
          {
            gclid: "Cj0-gclid",
            conversionAction: ACTION_RESOURCE,
            conversionDateTime: "2026-10-12 16:00:00+04:00",
            orderId: "88214:verified",
          },
        ],
        partialFailure: true,
      },
    }),
});
