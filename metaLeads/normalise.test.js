// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readRow } from "./columns.js";
import {
  buildUtmParams, countryFromAdset, countryFromPhone, normaliseRow,
  resolveCountry, resolveLeadSource, skipReason, splitName,
} from "./normalise.js";

const row = (over = {}) => ({
  metaLeadId: "1", createdTime: "2026-11-04T06:19:44-05:00", adId: "1",
  adName: "Partners-IB-Iraq-Ad3", adsetId: "1", adsetName: "Partners-IB-Iraq",
  campaignId: "1", campaignName: "Partners-IB", formId: "1", formName: "Form",
  isOrganic: "false", platform: "fb", email: "a@b.com", phone: "+9647705108061",
  firstName: "ساجد كريم جاسم البياتي", lastName: "", country: "US",
  leadStatus: "CREATED", ...over,
});

describe("splitName", () => {
  it("keeps both names when the form supplied both", () => {
    expect(splitName("Dogan", "Gungor")).toEqual({ firstName: "Dogan", lastName: "Gungor" });
  });

  // Most of the Iraq sheet: the whole name sits in first_name. The family name
  // is the LAST token -- an Arabic name is a given name, then patronymics,
  // then the family name.
  it("splits a whole name on its final space", () => {
    expect(splitName("ساجد كريم جاسم البياتي", "")).toEqual({
      firstName: "ساجد كريم جاسم", lastName: "البياتي",
    });
  });

  it("leaves a single word as a first name with no last name", () => {
    expect(splitName("Kaboul", "")).toEqual({ firstName: "Kaboul", lastName: "" });
  });

  it("collapses the runs of space a pasted name carries", () => {
    expect(splitName("  أبو   فهد  ", "")).toEqual({ firstName: "أبو", lastName: "فهد" });
  });

  it("uses the last name when it is the only one given", () => {
    expect(splitName("", "Mutawa")).toEqual({ firstName: "Mutawa", lastName: "" });
  });

  it("answers two empty strings for no name at all", () => {
    expect(splitName("", "")).toEqual({ firstName: "", lastName: "" });
  });
});

describe("countryFromPhone", () => {
  it("reads the unambiguous dialling codes", () => {
    expect(countryFromPhone("+9647705108061")).toBe("IQ");
    expect(countryFromPhone("+905332360123")).toBe("TR");
    expect(countryFromPhone("+971501234567")).toBe("AE");
    expect(countryFromPhone("+923001234567")).toBe("PK");
  });

  it("prefers the longer code when one is a prefix of another", () => {
    // 971 (AE) must not be read as 97, and 964 (IQ) must not be read as 96.
    expect(countryFromPhone("+971501234567")).toBe("AE");
    expect(countryFromPhone("+9647705108061")).toBe("IQ");
  });

  // +1 is the US, Canada and twenty Caribbean countries; +7 is Russia and
  // Kazakhstan. Guessing either is worse than not answering.
  it("refuses to guess an ambiguous code", () => {
    expect(countryFromPhone("+15551234567")).toBeNull();
    expect(countryFromPhone("+77011234567")).toBeNull();
  });

  it("answers null for a local number with no country code", () => {
    expect(countryFromPhone("07705108061")).toBeNull();
    expect(countryFromPhone("")).toBeNull();
  });
});

describe("countryFromAdset", () => {
  it("finds the country named in the ad set", () => {
    expect(countryFromAdset("Partners-IB-Iraq")).toBe("IQ");
    expect(countryFromAdset("Partners-IB-Turkey")).toBe("TR");
    expect(countryFromAdset("Zero-Spread-UAE")).toBe("AE");
  });

  it("answers null when no token names a country", () => {
    expect(countryFromAdset("Partners-IB")).toBeNull();
    expect(countryFromAdset("")).toBeNull();
  });
});

describe("resolveCountry", () => {
  // The defect this whole rule exists for: seven of thirty Iraq rows say US.
  it("believes the phone over Meta's country column", () => {
    expect(resolveCountry(row({ phone: "+9647705108061", country: "US" }))).toBe("IQ");
  });

  it("falls back to the ad set when the phone cannot say", () => {
    expect(resolveCountry(row({ phone: "+15551234567", adsetName: "Partners-IB-Turkey", country: "" }))).toBe("TR");
  });

  it("falls back to the column when neither can", () => {
    expect(resolveCountry(row({ phone: "", adsetName: "Partners-IB", country: "gb" }))).toBe("GB");
  });

  it("answers null rather than invent one", () => {
    expect(resolveCountry(row({ phone: "", adsetName: "Partners-IB", country: "" }))).toBeNull();
    expect(resolveCountry(row({ phone: "", adsetName: "Partners-IB", country: "Iraq" }))).toBeNull();
  });
});

describe("resolveLeadSource", () => {
  it("is the ad set name", () => {
    expect(resolveLeadSource(row())).toBe("Partners-IB-Iraq");
  });

  it("falls back to the campaign, then the form", () => {
    expect(resolveLeadSource(row({ adsetName: "" }))).toBe("Partners-IB");
    expect(resolveLeadSource(row({ adsetName: "", campaignName: "", formName: "Zero-Spread-UAE" }))).toBe("Zero-Spread-UAE");
    expect(resolveLeadSource(row({ adsetName: "", campaignName: "", formName: "" }))).toBeNull();
  });
});

describe("buildUtmParams", () => {
  it("names the platform, the campaign, the ad and the ad set", () => {
    expect(buildUtmParams(row())).toBe(
      "utm_source=facebook&utm_medium=paid_social&utm_campaign=Partners-IB" +
      "&utm_content=Partners-IB-Iraq-Ad3&utm_term=Partners-IB-Iraq"
    );
  });

  it("maps ig to instagram", () => {
    expect(buildUtmParams(row({ platform: "ig" }))).toContain("utm_source=instagram");
  });

  // A campaign called "Iraq & Turkey" would otherwise truncate the string at
  // the ampersand and silently drop the ad and ad set.
  it("encodes a value containing an ampersand", () => {
    expect(buildUtmParams(row({ campaignName: "Iraq & Turkey" })))
      .toContain("utm_campaign=Iraq+%26+Turkey");
  });

  it("answers null when there is nothing but the medium to report", () => {
    expect(buildUtmParams(row({ platform: "", campaignName: "", adName: "", adsetName: "" }))).toBeNull();
  });
});

describe("skipReason", () => {
  it("rejects Meta's test lead", () => {
    expect(skipReason(row({ firstName: "<test lead: dummy data for first_name>" }))).toBe("skipped_test");
    expect(skipReason(row({ email: "test@meta.com" }))).toBe("skipped_test");
    expect(skipReason(row({ isOrganic: "true" }))).toBe("skipped_test");
    expect(skipReason(row({ isOrganic: "TRUE" }))).toBe("skipped_test");
  });

  it("rejects a row with no way to contact anyone", () => {
    expect(skipReason(row({ email: "", phone: "" }))).toBe("skipped_empty");
  });

  it("accepts a row with only a phone", () => {
    expect(skipReason(row({ email: "" }))).toBeNull();
  });

  it("accepts an ordinary row", () => {
    expect(skipReason(row())).toBeNull();
  });
});

describe("normaliseRow", () => {
  it("turns the real Iraq row into a lead", () => {
    const raw = readRow(["l:1593296142070496","2026-11-04T06:19:44-05:00","ag:1","Partners-IB-Iraq-Ad3","as:1","Partners-IB-Iraq","c:1","Partners-IB","f:1","نموذج","false","fb","SAJDKRYM1962@Gmail.com ","p:+9647705108061","ساجد كريم جاسم البياتي","","US","CREATED"]);
    expect(normaliseRow(raw)).toEqual({
      metaLeadId: "1593296142070496",
      createdTime: "2026-11-04T06:19:44-05:00",
      firstName: "ساجد كريم جاسم",
      lastName: "البياتي",
      email: "sajdkrym1962@gmail.com",
      phone: "+9647705108061",
      country: "IQ",
      leadSource: "Partners-IB-Iraq",
      utmParams: "utm_source=facebook&utm_medium=paid_social&utm_campaign=Partners-IB&utm_content=Partners-IB-Iraq-Ad3&utm_term=Partners-IB-Iraq",
      campaignName: "Partners-IB",
      adsetName: "Partners-IB-Iraq",
      adName: "Partners-IB-Iraq-Ad3",
      skip: null,
    });
  });

  it("carries the skip reason instead of a lead", () => {
    const raw = readRow(["l:2","","","","","","","","f:1","Zero-Spread-UAE","true","","test@meta.com","p:<test lead: dummy data for phone_number>","<test lead: dummy data for first_name>","","","success"]);
    expect(normaliseRow(raw).skip).toBe("skipped_test");
  });
});
