// @vitest-environment node
//
// Meta writes "p:+9647705108061" and "l:1593296142070496" so Sheets does not
// reformat long digit strings as numbers. And the Turkey sheet's headers are
// Turkish while its columns sit in exactly the same places -- which is why
// nothing here looks a column up by its name.
import { describe, expect, it } from "vitest";
import { COLUMN_COUNT, COLUMN_INDEX, headerProblem, readRow, stripMetaPrefix } from "./columns.js";

const ENGLISH_HEADER = ["id","created_time","ad_id","ad_name","adset_id","adset_name","campaign_id","campaign_name","form_id","form_name","is_organic","platform","email","phone_number","first_name","last_name","country","lead_status"];
const TURKISH_HEADER = ["id","created_time","ad_id","ad_name","adset_id","adset_name","campaign_id","campaign_name","form_id","form_name","is_organic","platform","e-posta","telefon_numarası","adı","soyadı","ülke","lead_status"];
const IRAQ_ROW = ["l:1593296142070496","2026-11-04T06:19:44-05:00","ag:120254281744030268","Partners-IB-Iraq-Ad3","as:120254281668190268","Partners-IB-Iraq","c:120254281171170268","Partners-IB","f:1417668933787039","نموذج","false","fb","sajdkrym1962@gmail.com","p:+9647705108061","ساجد كريم جاسم البياتي","","IQ","CREATED"];

describe("stripMetaPrefix", () => {
  it("removes every prefix Meta uses", () => {
    expect(stripMetaPrefix("l:1593296142070496")).toBe("1593296142070496");
    expect(stripMetaPrefix("p:+9647705108061")).toBe("+9647705108061");
    expect(stripMetaPrefix("ag:120254281744030268")).toBe("120254281744030268");
    expect(stripMetaPrefix("as:1")).toBe("1");
    expect(stripMetaPrefix("c:1")).toBe("1");
    expect(stripMetaPrefix("f:1")).toBe("1");
  });

  // An email is the field most likely to contain something prefix-shaped, and
  // stripping part of one would send a lead to an address that does not exist.
  it("leaves a value that merely contains a colon alone", () => {
    expect(stripMetaPrefix("Partners-IB: Iraq")).toBe("Partners-IB: Iraq");
    expect(stripMetaPrefix("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(stripMetaPrefix("  spaced@b.com  ")).toBe("spaced@b.com");
  });

  it("answers an empty string for nothing at all", () => {
    expect(stripMetaPrefix(undefined)).toBe("");
    expect(stripMetaPrefix(null)).toBe("");
  });
});

describe("headerProblem", () => {
  it("accepts the English header", () => {
    expect(headerProblem(ENGLISH_HEADER)).toBeNull();
  });

  // The whole reason this module reads by position.
  it("accepts the Turkish header", () => {
    expect(headerProblem(TURKISH_HEADER)).toBeNull();
  });

  it("rejects a header whose columns have moved", () => {
    const swapped = [...ENGLISH_HEADER];
    [swapped[12], swapped[13]] = [swapped[13], swapped[12]];
    expect(headerProblem(swapped)).toMatch(/column 13/);
  });

  it("rejects a header that is too short to hold the columns", () => {
    expect(headerProblem(ENGLISH_HEADER.slice(0, 10))).toMatch(/expected 18 columns, found 10/);
  });

  it("ignores case and surrounding space", () => {
    expect(headerProblem(ENGLISH_HEADER.map((h) => ` ${h.toUpperCase()} `))).toBeNull();
  });
});

describe("readRow", () => {
  it("names every column and strips the prefixes", () => {
    const row = readRow(IRAQ_ROW);
    expect(row.metaLeadId).toBe("1593296142070496");
    expect(row.phone).toBe("+9647705108061");
    expect(row.email).toBe("sajdkrym1962@gmail.com");
    expect(row.firstName).toBe("ساجد كريم جاسم البياتي");
    expect(row.lastName).toBe("");
    expect(row.adsetName).toBe("Partners-IB-Iraq");
    expect(row.adName).toBe("Partners-IB-Iraq-Ad3");
    expect(row.campaignName).toBe("Partners-IB");
    expect(row.platform).toBe("fb");
    expect(row.isOrganic).toBe("false");
    expect(row.country).toBe("IQ");
  });

  // Sheets omits trailing empty cells entirely, so a short array is normal.
  it("gives an empty string for a cell the sheet did not send", () => {
    const row = readRow(["l:1"]);
    expect(row.email).toBe("");
    expect(row.country).toBe("");
    expect(Object.keys(row)).toHaveLength(COLUMN_COUNT);
    expect(Object.keys(row).sort()).toEqual(Object.keys(COLUMN_INDEX).sort());
  });
});
