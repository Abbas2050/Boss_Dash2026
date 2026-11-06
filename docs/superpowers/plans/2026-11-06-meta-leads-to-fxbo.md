# Meta leads → FXBO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every new row in three Meta Lead Ads Google Sheets becomes a lead in FXBO, once, within about a minute.

**Architecture:** A new `metaLeads/` module mirroring `crmSignup/`: a 60-second `setInterval` worker polls each registered sheet with the existing Google service account, writes each unseen Meta lead id into a MariaDB queue, then drains that queue by calling `POST /rest/users/new` on FXBO. Reading and sending are separate passes over separate state, so a Google outage cannot lose a queued lead and a CRM outage cannot make us re-read a sheet.

**Tech Stack:** Node 22 ESM, `googleapis` (service account, `spreadsheets.readonly`), `mysql2/promise`, Express 5, React 18 + Vite, Vitest.

**Design:** `docs/superpowers/specs/2026-11-06-meta-leads-to-fxbo-design.md`

## Global Constraints

- **Columns are read by position, never by header name.** The Turkey sheet's headers are Turkish (`e-posta`, `telefon_numarası`, `adı`, `soyadı`, `ülke`). The header row is verified against a per-position alias table; a mismatch disables that sheet rather than importing blanks.
- **`meta_lead_id` is UNIQUE in `meta_lead_rows`.** Deduplication happens at the database, not in a check-then-act race.
- **Eleven fields are sent to FXBO**: `lead`, `ib`, `firstName`, `lastName`, `email`, `phone`, `country`, `language`, `utmParams`, `sendWelcomeEmail`, `acceptedDocuments`. `managerId`, `referrer`, `tags` and `status` are **omitted entirely** unless the sheet sets them. Never send an empty string where FXBO has a default.
- **All three sheets ship with:** `language = "en"`, `ib = false`, `send_lead_source = false`, `manager_id` NULL, `tags` NULL, `status` NULL.
- **A newly registered sheet is bootstrapped**: every row already present is written as `skipped_existing` and nothing is sent.
- **Duplicate rule:** skip on email, allow on phone. No email means no duplicate check, and the row is still sent.
- **Country** comes from the phone dialling code first, then the ad set name, then Meta's `country` column — because that column reads `US` on seven of thirty Iraq rows whose phones start `+964`.
- **These are plain JS ESM files** (`.js`, `import`/`export`). `npm run lint` only covers `.ts`/`.tsx`, so a clean ESLint run proves nothing about this module — Vitest is the gate.
- **Typecheck is `npx tsc -b --noEmit`**, never `tsc --noEmit`.
- Every guard test is **mutation-proved**: break the guard, watch the test fail, restore it.

---

### Task 1: Column positions and Meta's prefixes

**Files:**
- Create: `metaLeads/columns.js`
- Test: `metaLeads/columns.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `COLUMN_INDEX` (frozen object, 18 named positions), `COLUMN_COUNT = 18`, `stripMetaPrefix(value: string): string`, `KNOWN_HEADERS: Record<number, string[]>`, `headerProblem(headerCells: string[]): string | null`, `readRow(cells: string[]): RawRow`.
- `RawRow` has exactly the keys of `COLUMN_INDEX`, every value a trimmed string (never null/undefined).

- [ ] **Step 1: Write the failing test**

```javascript
// metaLeads/columns.test.js
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
  // stripping part of one would send a lead to a address that does not exist.
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run metaLeads/columns.test.js`
Expected: FAIL — `Failed to load ./columns.js`.

- [ ] **Step 3: Write the implementation**

```javascript
// metaLeads/columns.js
/**
 * Where each field sits in a Meta Lead Ads export, and how to get a usable
 * value out of it.
 *
 * Read BY POSITION, never by header name. All three sheets carry the same
 * eighteen columns in the same order, but the Turkey sheet names columns 13-17
 * in Turkish -- `e-posta`, `telefon_numarası`, `adı`, `soyadı`, `ülke`. A
 * reader keyed on header names works on two sheets and reads blanks on the
 * third, and a blank name and a blank email reach FXBO as a lead nobody can
 * contact. Positions are the thing the three sheets genuinely agree on.
 */
export const COLUMN_INDEX = Object.freeze({
  metaLeadId: 0,
  createdTime: 1,
  adId: 2,
  adName: 3,
  adsetId: 4,
  adsetName: 5,
  campaignId: 6,
  campaignName: 7,
  formId: 8,
  formName: 9,
  isOrganic: 10,
  platform: 11,
  email: 12,
  phone: 13,
  firstName: 14,
  lastName: 15,
  country: 16,
  leadStatus: 17,
});

export const COLUMN_COUNT = Object.keys(COLUMN_INDEX).length;

/**
 * Meta's type guards: `l:` on a lead id, `ag:` `as:` `c:` `f:` on the ad, ad
 * set, campaign and form ids, and `p:` on the phone. Without them Sheets turns
 * a sixteen-digit id into 1.59329614207e+15.
 *
 * Anchored and alternated over the known tokens rather than a general
 * `^[a-z]+:` -- the loose form eats the scheme off anything URL-shaped and the
 * local part off an address like `p:x@y.com`, and a half-eaten email is a lead
 * that silently cannot be reached.
 */
const META_PREFIX = /^(?:l|ag|as|c|f|p):/;

export function stripMetaPrefix(value) {
  const text = String(value ?? "").trim();
  if (!META_PREFIX.test(text)) return text;
  return text.slice(text.indexOf(":") + 1).trim();
}

/**
 * What each position is allowed to be called, for the five columns whose names
 * are localised plus the id. Checked on every poll: if Meta ever reorders the
 * export, the sheet stops instead of filing names into the email column.
 */
export const KNOWN_HEADERS = Object.freeze({
  [COLUMN_INDEX.metaLeadId]: ["id"],
  [COLUMN_INDEX.email]: ["email", "e-posta"],
  [COLUMN_INDEX.phone]: ["phone_number", "telefon_numarası"],
  [COLUMN_INDEX.firstName]: ["first_name", "adı"],
  [COLUMN_INDEX.lastName]: ["last_name", "soyadı"],
  [COLUMN_INDEX.country]: ["country", "ülke"],
});

/** null when the header is one we understand, otherwise why it is not. */
export function headerProblem(headerCells) {
  const cells = Array.isArray(headerCells) ? headerCells : [];
  if (cells.length < COLUMN_COUNT) {
    return `expected ${COLUMN_COUNT} columns, found ${cells.length}`;
  }
  for (const [position, allowed] of Object.entries(KNOWN_HEADERS)) {
    const index = Number(position);
    const actual = String(cells[index] ?? "").trim().toLowerCase();
    if (!allowed.includes(actual)) {
      return `column ${index + 1} reads "${actual}", expected one of: ${allowed.join(", ")}`;
    }
  }
  return null;
}

/**
 * One array of cells to one named object, every value a trimmed string.
 *
 * Never null and never undefined: a caller that has to ask which kind of empty
 * it received is a caller that will get it wrong once.
 */
export function readRow(cells) {
  const source = Array.isArray(cells) ? cells : [];
  const row = {};
  for (const [name, index] of Object.entries(COLUMN_INDEX)) {
    row[name] = stripMetaPrefix(source[index]);
  }
  return row;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run metaLeads/columns.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Mutation-prove the header guard**

Temporarily change `KNOWN_HEADERS` so the phone position also allows `"first_name"`, re-run, and confirm `rejects a header whose columns have moved` fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add metaLeads/columns.js metaLeads/columns.test.js
git commit -m "meta leads: read the export by position, because the headers are localised"
```

---

### Task 2: Turning a row into a lead

**Files:**
- Create: `metaLeads/normalise.js`
- Test: `metaLeads/normalise.test.js`

**Interfaces:**
- Consumes: `RawRow` from `readRow` (Task 1).
- Produces: `splitName(first, last): { firstName, lastName }`, `countryFromPhone(phone): string|null`, `countryFromAdset(text): string|null`, `resolveCountry(raw): string|null`, `resolveLeadSource(raw): string|null`, `buildUtmParams(raw): string|null`, `skipReason(raw): "skipped_test"|"skipped_empty"|null`, `normaliseRow(raw): Normalised`.
- `Normalised` = `{ metaLeadId, createdTime, firstName, lastName, email, phone, country, leadSource, utmParams, campaignName, adsetName, adName, skip }` — `skip` is `null` or a status string; `country`, `leadSource`, `utmParams` are `string|null`; the rest are strings.

- [ ] **Step 1: Write the failing test**

```javascript
// metaLeads/normalise.test.js
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run metaLeads/normalise.test.js`
Expected: FAIL — `Failed to load ./normalise.js`.

- [ ] **Step 3: Write the implementation**

```javascript
// metaLeads/normalise.js
/**
 * One row of a Meta Lead Ads export becomes one candidate lead, or a reason it
 * is not one.
 *
 * Everything here is pure: a row in, an object out, no clock and no network.
 * The rules it holds are the ones that quietly produce wrong data when they are
 * wrong, so each of them is tested against the real sheets rather than against
 * an idea of what Meta sends.
 */

/**
 * Dialling code to ISO alpha-2, for codes that name exactly one country.
 *
 * Longest match wins, which is why 971 and 97x can both be here safely. Codes
 * shared between countries are in AMBIGUOUS_DIAL_CODES below and answer
 * nothing at all.
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

/** The countries actually named in these campaigns, plus the obvious neighbours. */
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
 * The order is the finding, not a preference: on the Iraq sheet, seven of
 * thirty rows carry `US` beside a `+964` phone, because Meta reports the
 * profile's locale rather than where the person is. A lead filed under the
 * wrong country is worse than one filed under none, so a rule that cannot
 * answer answers null.
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
 * take the ad and ad set with it.
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
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run metaLeads/normalise.test.js`
Expected: PASS, 24 tests.

- [ ] **Step 5: Mutation-prove the two rules that silently corrupt data**

Change `resolveCountry` to read `iso2(raw?.country)` first and confirm `believes the phone over Meta's country column` fails. Restore. Change `splitName` to use `indexOf(" ")` and confirm `splits a whole name on its final space` fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add metaLeads/normalise.js metaLeads/normalise.test.js
git commit -m "meta leads: the phone decides the country, and the last space the family name"
```

---

### Task 3: The FXBO payload and the two calls

**Files:**
- Create: `metaLeads/fxbo.js`
- Test: `metaLeads/fxbo.test.js`
- Read first: `docusign/crm.js` — `getCrmBaseUrl()`, `authHeaders()`, `versionQuery()`, `fetchCrmUserByEmail(email)` already exist and are reused rather than rewritten.

**Interfaces:**
- Consumes: `Normalised` from Task 2; a `SheetConfig` = `{ id, label, ib: boolean, sendLeadSource: boolean, managerId: number|null, language: string|null, status: string|null, tags: string|null }`.
- Produces: `buildLeadPayload(lead: Normalised, sheet: SheetConfig): object`, `parseTags(raw: string|null): string[]`, `findLeadByEmail(email, deps?): Promise<{id:number}|null>`, `createLead(payload, deps?): Promise<{ok, status, userId, detail}>`.
- `deps` on both calls is `{ fetch?, getCrmBaseUrl?, authHeaders?, versionQuery?, fetchCrmUserByEmail? }`, defaulting to the real ones, so tests never touch the network.

- [ ] **Step 1: Write the failing test**

```javascript
// metaLeads/fxbo.test.js
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { buildLeadPayload, createLead, findLeadByEmail, parseTags } from "./fxbo.js";

const lead = (over = {}) => ({
  metaLeadId: "1", createdTime: "", firstName: "Dogan", lastName: "Gungor",
  email: "d_gungor43@hotmail.com", phone: "+905332360123", country: "TR",
  leadSource: "Partners-IB-Turkey",
  utmParams: "utm_source=facebook&utm_medium=paid_social&utm_campaign=Partners-IB",
  campaignName: "Partners-IB", adsetName: "Partners-IB-Turkey", adName: "Ad2",
  skip: null, ...over,
});

const sheet = (over = {}) => ({
  id: 2, label: "Meta – Turkey", ib: false, sendLeadSource: false,
  managerId: null, language: "en", status: null, tags: null, ...over,
});

describe("buildLeadPayload", () => {
  it("sends exactly the eleven fields the design names", () => {
    expect(buildLeadPayload(lead(), sheet())).toEqual({
      lead: true,
      ib: false,
      firstName: "Dogan",
      lastName: "Gungor",
      email: "d_gungor43@hotmail.com",
      phone: "+905332360123",
      country: "TR",
      language: "en",
      utmParams: "utm_source=facebook&utm_medium=paid_social&utm_campaign=Partners-IB",
      sendWelcomeEmail: false,
      acceptedDocuments: false,
    });
  });

  // The whole point of "omitted, not sent empty": an empty string where FXBO
  // has a default is how the default gets overwritten with nothing.
  it("omits the four unset fields rather than sending them empty", () => {
    const payload = buildLeadPayload(lead(), sheet());
    expect(payload).not.toHaveProperty("managerId");
    expect(payload).not.toHaveProperty("referrer");
    expect(payload).not.toHaveProperty("tags");
    expect(payload).not.toHaveProperty("status");
  });

  it("adds each one only when the sheet sets it", () => {
    const payload = buildLeadPayload(lead(), sheet({
      ib: true, sendLeadSource: true, managerId: 20, status: "new", tags: "IB, Meta",
    }));
    expect(payload.ib).toBe(true);
    expect(payload.referrer).toBe("Partners-IB-Turkey");
    expect(payload.managerId).toBe(20);
    expect(payload.status).toBe("new");
    expect(payload.tags).toEqual(["IB", "Meta"]);
  });

  it("omits what the lead itself does not have", () => {
    const payload = buildLeadPayload(lead({ email: "", country: null, lastName: "", utmParams: null }), sheet());
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("country");
    expect(payload).not.toHaveProperty("lastName");
    expect(payload).not.toHaveProperty("utmParams");
    expect(payload.phone).toBe("+905332360123");
  });

  // A sheet with the switch on but a row with no ad set, campaign or form.
  it("omits referrer when the switch is on but there is no source", () => {
    const payload = buildLeadPayload(lead({ leadSource: null }), sheet({ sendLeadSource: true }));
    expect(payload).not.toHaveProperty("referrer");
  });
});

describe("parseTags", () => {
  it("splits, trims and drops the blanks", () => {
    expect(parseTags("IB, Meta ,, ")).toEqual(["IB", "Meta"]);
    expect(parseTags(null)).toEqual([]);
    expect(parseTags("   ")).toEqual([]);
  });
});

describe("findLeadByEmail", () => {
  it("answers the match the CRM found", async () => {
    const fetchCrmUserByEmail = vi.fn(async () => ({ id: 14613, email: "a@b.com" }));
    await expect(findLeadByEmail("a@b.com", { fetchCrmUserByEmail })).resolves.toEqual({ id: 14613 });
  });

  it("answers null when nobody has that address", async () => {
    const fetchCrmUserByEmail = vi.fn(async () => null);
    await expect(findLeadByEmail("a@b.com", { fetchCrmUserByEmail })).resolves.toBeNull();
  });

  // A lookup that throws must not be read as "nobody has it" -- that would
  // create a duplicate every time the CRM hiccuped.
  it("lets a failed lookup throw", async () => {
    const fetchCrmUserByEmail = vi.fn(async () => { throw new Error("CRM users lookup failed (503)"); });
    await expect(findLeadByEmail("a@b.com", { fetchCrmUserByEmail })).rejects.toThrow(/503/);
  });
});

describe("createLead", () => {
  const deps = (fetchImpl) => ({
    fetch: fetchImpl,
    getCrmBaseUrl: () => "https://portal.example.com/rest",
    authHeaders: () => ({ Authorization: "Bearer x", "Content-Type": "application/json" }),
    versionQuery: () => "version=1.0.0",
  });

  it("posts to /users/new and reads the new id back", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify([{ id: 14620 }]) }));
    const result = await createLead({ lead: true }, deps(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://portal.example.com/rest/users/new?version=1.0.0",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ lead: true }) }),
    );
    expect(result).toEqual({ ok: true, status: 200, userId: 14620, detail: null });
  });

  it("accepts a bare object as well as an array", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: 7 }) }));
    await expect(createLead({}, deps(fetchImpl))).resolves.toMatchObject({ ok: true, userId: 7 });
  });

  // The CRM's own wording, because "the CRM refused this" and "we have not
  // tried yet" must never look alike in the tab.
  it("carries the CRM's refusal back verbatim", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 422, text: async () => '{"error":"email already used"}' }));
    const result = await createLead({}, deps(fetchImpl));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
    expect(result.detail).toContain("email already used");
  });

  it("reports a success whose body it could not parse", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => "OK" }));
    await expect(createLead({}, deps(fetchImpl))).resolves.toEqual({ ok: true, status: 200, userId: null, detail: null });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run metaLeads/fxbo.test.js`
Expected: FAIL — `Failed to load ./fxbo.js`.

- [ ] **Step 3: Write the implementation**

```javascript
// metaLeads/fxbo.js
/**
 * The two calls this module makes to FXBO, and the payload they carry.
 *
 * The credential is read by docusign/crm.js and nowhere else here: these
 * helpers are shared with the Back Office panel so there is one definition of
 * the CRM's base URL, its bearer header and its version query, and no second
 * place to forget the trailing-CR trimming that a .env edited on Windows
 * requires.
 *
 * Every function takes an optional `deps` so a test can run the whole path
 * without a network. The defaults are the real thing.
 */
import {
  authHeaders as realAuthHeaders,
  fetchCrmUserByEmail as realFetchCrmUserByEmail,
  getCrmBaseUrl as realGetCrmBaseUrl,
  versionQuery as realVersionQuery,
} from "../docusign/crm.js";

/** A sheet's tags column, "IB, Meta", as the array FXBO wants. */
export function parseTags(raw) {
  return String(raw ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * Eleven fields, and four more only when the sheet asks for them.
 *
 * The line between sent and omitted is whether we have an answer, not whether
 * the answer is interesting. `ib: false` is sent because the sheet states it;
 * `city` is absent because nobody asked the lead for one. Sending an empty
 * string where FXBO has a default is how a default gets overwritten.
 */
export function buildLeadPayload(lead, sheet) {
  const payload = {
    lead: true,
    ib: Boolean(sheet?.ib),
    sendWelcomeEmail: false,
    acceptedDocuments: false,
  };

  if (lead?.firstName) payload.firstName = lead.firstName;
  if (lead?.lastName) payload.lastName = lead.lastName;
  if (lead?.email) payload.email = lead.email;
  if (lead?.phone) payload.phone = lead.phone;
  if (lead?.country) payload.country = lead.country;
  if (lead?.utmParams) payload.utmParams = lead.utmParams;

  if (sheet?.language) payload.language = sheet.language;
  if (Number.isFinite(Number(sheet?.managerId)) && Number(sheet?.managerId) > 0) {
    payload.managerId = Number(sheet.managerId);
  }
  if (sheet?.sendLeadSource && lead?.leadSource) payload.referrer = lead.leadSource;
  if (sheet?.status) payload.status = sheet.status;
  const tags = parseTags(sheet?.tags);
  if (tags.length) payload.tags = tags;

  return payload;
}

/**
 * Has anyone in the CRM got this address already?
 *
 * Deliberately allowed to throw. A lookup that failed is not the same as an
 * address nobody holds, and treating it as one would create a duplicate every
 * time the CRM hiccuped. The caller retries instead.
 */
export async function findLeadByEmail(email, deps = {}) {
  const lookup = deps.fetchCrmUserByEmail || realFetchCrmUserByEmail;
  const match = await lookup(email);
  return match ? { id: Number(match.id) } : null;
}

/** POST /rest/users/new. Never throws on an HTTP status; the caller classifies it. */
export async function createLead(payload, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const baseUrl = (deps.getCrmBaseUrl || realGetCrmBaseUrl)();
  const headers = (deps.authHeaders || realAuthHeaders)();
  const query = (deps.versionQuery || realVersionQuery)();

  const response = await doFetch(`${baseUrl}/users/new?${query}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      userId: null,
      // Capped: this reaches a database column and a browser table, and FXBO
      // answers some refusals with an HTML error page.
      detail: `HTTP ${response.status}: ${text.slice(0, 500)}`,
    };
  }

  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const created = Array.isArray(body) ? body[0] : body;
  const userId = Number(created?.id);

  return {
    ok: true,
    status: response.status,
    userId: Number.isFinite(userId) && userId > 0 ? userId : null,
    detail: null,
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run metaLeads/fxbo.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Mutation-prove the omission rule**

Change `buildLeadPayload` to always set `payload.managerId = sheet?.managerId ?? null` and confirm both `sends exactly the eleven fields the design names` and `omits the four unset fields rather than sending them empty` fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add metaLeads/fxbo.js metaLeads/fxbo.test.js
git commit -m "meta leads: eleven fields, and four more only when a sheet asks"
```

---

### Task 4: The store

**Files:**
- Create: `metaLeads/store.js`
- Test: `metaLeads/store.test.js`
- Read first: `crmSignup/store.js:1-80` for the pool and schema conventions this follows.

**Interfaces:**
- Consumes: `Normalised` from Task 2.
- Produces: `META_LEAD_SHEETS_SCHEMA`, `META_LEAD_ROWS_SCHEMA` (exported strings), `initMetaLeadsStore()`, `listSheets()`, `getSheet(id)`, `insertSheet(fields)`, `updateSheet(id, fields)`, `markSheetPolled(id, {rowCount, fullRead, error})`, `markSheetBootstrapped(id)`, `disableSheetWithError(id, message)`, `insertLeadRow(sheetId, lead, status)`, `listDueRows(limit)`, `claimRow(id)`, `settleRow(id, {status, detail, crmUserId})`, `deferRow(id, {detail, nextAttemptAt})`, `listRecentRows(limit)`, `requeueRow(id)`, `countRowsByStatus()`.
- A sheet row read back from `listSheets()`/`getSheet()` is camelCased into `SheetConfig` (Task 3) plus `{ spreadsheetId, tabName, enabled, lastRowCount, lastPolledAt, lastFullReadAt, lastError, bootstrappedAt }`.

- [ ] **Step 1: Write the failing test**

This task's tests run against the schema strings and the row-mapping, not a live MariaDB — the project has no test database, and `crmSignup/store.sql.test.js` is the pattern for a SQL test that is skipped without one. The queries themselves are exercised in Task 6 through an injected fake.

```javascript
// metaLeads/store.test.js
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { META_LEAD_ROWS_SCHEMA, META_LEAD_SHEETS_SCHEMA, toSheetConfig } from "./store.js";

describe("the schema", () => {
  // The whole deduplication strategy: a re-read of a sheet collides at the
  // database rather than in a check-then-act race between two app-pool workers.
  it("makes the Meta lead id unique", () => {
    expect(META_LEAD_ROWS_SCHEMA).toMatch(/UNIQUE KEY uq_meta_lead_rows_lead \(meta_lead_id\)/);
  });

  it("indexes the rows the drain looks for", () => {
    expect(META_LEAD_ROWS_SCHEMA).toMatch(/KEY idx_meta_lead_rows_due \(status, next_attempt_at\)/);
  });

  it("refuses two registrations of the same tab", () => {
    expect(META_LEAD_SHEETS_SCHEMA).toMatch(/UNIQUE KEY uq_meta_lead_sheets_source \(spreadsheet_id, tab_name\)/);
  });

  it("defaults every optional lead field to off or empty", () => {
    expect(META_LEAD_SHEETS_SCHEMA).toMatch(/ib TINYINT\(1\) NOT NULL DEFAULT 0/);
    expect(META_LEAD_SHEETS_SCHEMA).toMatch(/send_lead_source TINYINT\(1\) NOT NULL DEFAULT 0/);
    expect(META_LEAD_SHEETS_SCHEMA).toMatch(/manager_id INT UNSIGNED NULL/);
    expect(META_LEAD_SHEETS_SCHEMA).toMatch(/tags VARCHAR\(512\) NULL/);
    expect(META_LEAD_SHEETS_SCHEMA).toMatch(/status VARCHAR\(64\) NULL/);
  });

  it("starts a sheet un-bootstrapped, so its existing rows are never sent", () => {
    expect(META_LEAD_SHEETS_SCHEMA).toMatch(/bootstrapped_at DATETIME NULL/);
  });
});

describe("toSheetConfig", () => {
  it("turns a database row into the config the payload builder wants", () => {
    expect(toSheetConfig({
      id: 1, label: "Meta – Iraq", spreadsheet_id: "abc", tab_name: "Sheet1",
      enabled: 1, ib: 0, send_lead_source: 0, manager_id: null, language: "en",
      status: null, tags: null, last_row_count: 31, last_polled_at: null,
      last_full_read_at: null, last_error: null, bootstrapped_at: null,
    })).toEqual({
      id: 1, label: "Meta – Iraq", spreadsheetId: "abc", tabName: "Sheet1",
      enabled: true, ib: false, sendLeadSource: false, managerId: null,
      language: "en", status: null, tags: null, lastRowCount: 31,
      lastPolledAt: null, lastFullReadAt: null, lastError: null, bootstrappedAt: null,
    });
  });

  // MySQL answers TINYINT(1) as 0/1, and `0` is truthy nowhere but is a number
  // everywhere -- a payload carrying ib: 0 is not the same as ib: false.
  it("turns the TINYINTs into real booleans", () => {
    const config = toSheetConfig({ id: 1, enabled: 1, ib: 1, send_lead_source: 1 });
    expect(config.enabled).toBe(true);
    expect(config.ib).toBe(true);
    expect(config.sendLeadSource).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run metaLeads/store.test.js`
Expected: FAIL — `Failed to load ./store.js`.

- [ ] **Step 3: Write the implementation**

```javascript
// metaLeads/store.js
/**
 * Two tables: the sheets we watch, and every Meta lead row we have seen.
 *
 * On the same MariaDB the auth and CRM-events tables use (AUTH_DB_*), with the
 * same pool shape as crmSignup/store.js. Nothing here reaches outside the
 * database -- the Google read and the FXBO call live in their own modules, so
 * a failure of either cannot leave a half-written row behind.
 */
import mysql from "mysql2/promise";

const AUTH_DB_HOST = process.env.AUTH_DB_HOST;
const AUTH_DB_PORT = Number(process.env.AUTH_DB_PORT || 3306);
const AUTH_DB_NAME = process.env.AUTH_DB_NAME;
const AUTH_DB_USER = process.env.AUTH_DB_USER;
const AUTH_DB_PASSWORD = process.env.AUTH_DB_PASSWORD;

let pool = null;
let initialized = false;

export const META_LEAD_SHEETS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta_lead_sheets (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    label VARCHAR(128) NOT NULL,
    spreadsheet_id VARCHAR(128) NOT NULL,
    tab_name VARCHAR(128) NOT NULL DEFAULT 'Sheet1',
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    ib TINYINT(1) NOT NULL DEFAULT 0,
    send_lead_source TINYINT(1) NOT NULL DEFAULT 0,
    manager_id INT UNSIGNED NULL,
    language VARCHAR(8) NULL,
    status VARCHAR(64) NULL,
    tags VARCHAR(512) NULL,
    last_row_count INT UNSIGNED NOT NULL DEFAULT 0,
    last_polled_at DATETIME NULL,
    last_full_read_at DATETIME NULL,
    last_error TEXT NULL,
    bootstrapped_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_meta_lead_sheets_source (spreadsheet_id, tab_name)
  )
`;

/**
 * `meta_lead_id` is UNIQUE on its own, not per sheet.
 *
 * Meta's lead id is globally unique, so the same person cannot arrive twice
 * even if someone registers the same workbook under two labels -- which is
 * exactly the mistake a UNIQUE (sheet_id, meta_lead_id) would let through.
 */
export const META_LEAD_ROWS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta_lead_rows (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sheet_id INT UNSIGNED NOT NULL,
    meta_lead_id VARCHAR(64) NOT NULL,
    created_time VARCHAR(64) NULL,
    first_name VARCHAR(255) NULL,
    last_name VARCHAR(255) NULL,
    email VARCHAR(255) NULL,
    phone VARCHAR(32) NULL,
    country VARCHAR(2) NULL,
    lead_source VARCHAR(255) NULL,
    utm_params VARCHAR(1024) NULL,
    campaign_name VARCHAR(255) NULL,
    adset_name VARCHAR(255) NULL,
    ad_name VARCHAR(255) NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'pending',
    detail TEXT NULL,
    crm_user_id INT UNSIGNED NULL,
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_meta_lead_rows_lead (meta_lead_id),
    KEY idx_meta_lead_rows_due (status, next_attempt_at),
    KEY idx_meta_lead_rows_sheet (sheet_id, id)
  )
`;

function hasDbConfig() {
  return Boolean(AUTH_DB_HOST && AUTH_DB_NAME && AUTH_DB_USER && AUTH_DB_PASSWORD);
}

async function run(sql, params = []) {
  if (!pool) throw new Error("Meta leads DB pool is not initialized.");
  const [result] = await pool.query(sql, params);
  return result;
}

async function all(sql, params = []) {
  if (!pool) throw new Error("Meta leads DB pool is not initialized.");
  const [rows] = await pool.query(sql, params);
  return Array.isArray(rows) ? rows : [];
}

export async function initMetaLeadsStore() {
  if (initialized) return;
  if (!hasDbConfig()) {
    throw new Error(
      "Meta leads DB env vars are missing. Expected AUTH_DB_HOST, AUTH_DB_NAME, AUTH_DB_USER, AUTH_DB_PASSWORD."
    );
  }
  if (!pool) {
    pool = mysql.createPool({
      host: AUTH_DB_HOST,
      port: AUTH_DB_PORT,
      database: AUTH_DB_NAME,
      user: AUTH_DB_USER,
      password: AUTH_DB_PASSWORD,
      waitForConnections: true,
      connectionLimit: 3,
      queueLimit: 0,
    });
  }
  await run(META_LEAD_SHEETS_SCHEMA);
  await run(META_LEAD_ROWS_SCHEMA);
  initialized = true;
}

const bool = (value) => value === 1 || value === true || value === "1";
const nullableNumber = (value) => (value === null || value === undefined ? null : Number(value));

/** A database row as the rest of the module wants to read it. */
export function toSheetConfig(row) {
  return {
    id: Number(row.id),
    label: row.label ?? null,
    spreadsheetId: row.spreadsheet_id ?? null,
    tabName: row.tab_name ?? null,
    enabled: bool(row.enabled),
    ib: bool(row.ib),
    sendLeadSource: bool(row.send_lead_source),
    managerId: nullableNumber(row.manager_id),
    language: row.language ?? null,
    status: row.status ?? null,
    tags: row.tags ?? null,
    lastRowCount: Number(row.last_row_count ?? 0),
    lastPolledAt: row.last_polled_at ?? null,
    lastFullReadAt: row.last_full_read_at ?? null,
    lastError: row.last_error ?? null,
    bootstrappedAt: row.bootstrapped_at ?? null,
  };
}

export async function listSheets() {
  const rows = await all(`SELECT * FROM meta_lead_sheets ORDER BY id`);
  return rows.map(toSheetConfig);
}

export async function getSheet(id) {
  const rows = await all(`SELECT * FROM meta_lead_sheets WHERE id = ?`, [id]);
  return rows.length ? toSheetConfig(rows[0]) : null;
}

export async function insertSheet(fields) {
  const result = await run(
    `INSERT INTO meta_lead_sheets
       (label, spreadsheet_id, tab_name, enabled, ib, send_lead_source, manager_id, language, status, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.label, fields.spreadsheetId, fields.tabName || "Sheet1",
      fields.enabled ? 1 : 0, fields.ib ? 1 : 0, fields.sendLeadSource ? 1 : 0,
      fields.managerId ?? null, fields.language ?? null,
      fields.status ?? null, fields.tags ?? null,
    ],
  );
  return { id: Number(result?.insertId) };
}

export async function updateSheet(id, fields) {
  await run(
    `UPDATE meta_lead_sheets
        SET label = ?, tab_name = ?, enabled = ?, ib = ?, send_lead_source = ?,
            manager_id = ?, language = ?, status = ?, tags = ?
      WHERE id = ?`,
    [
      fields.label, fields.tabName || "Sheet1", fields.enabled ? 1 : 0,
      fields.ib ? 1 : 0, fields.sendLeadSource ? 1 : 0, fields.managerId ?? null,
      fields.language ?? null, fields.status ?? null, fields.tags ?? null, id,
    ],
  );
}

export async function markSheetPolled(id, { rowCount, fullRead = false, error = null }) {
  await run(
    `UPDATE meta_lead_sheets
        SET last_row_count = ?,
            last_polled_at = UTC_TIMESTAMP(),
            last_full_read_at = CASE WHEN ? THEN UTC_TIMESTAMP() ELSE last_full_read_at END,
            last_error = ?
      WHERE id = ?`,
    [rowCount, fullRead ? 1 : 0, error, id],
  );
}

export async function markSheetBootstrapped(id) {
  await run(`UPDATE meta_lead_sheets SET bootstrapped_at = UTC_TIMESTAMP() WHERE id = ?`, [id]);
}

/**
 * A sheet whose header moved stops, rather than importing into the wrong
 * columns. Disabling is the loud failure: the tab shows it off with a reason.
 */
export async function disableSheetWithError(id, message) {
  await run(`UPDATE meta_lead_sheets SET enabled = 0, last_error = ? WHERE id = ?`, [message, id]);
}

export async function insertLeadRow(sheetId, lead, status) {
  try {
    const result = await run(
      `INSERT INTO meta_lead_rows
         (sheet_id, meta_lead_id, created_time, first_name, last_name, email, phone,
          country, lead_source, utm_params, campaign_name, adset_name, ad_name, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sheetId, lead.metaLeadId, lead.createdTime || null,
        lead.firstName || null, lead.lastName || null, lead.email || null,
        lead.phone || null, lead.country, lead.leadSource, lead.utmParams,
        lead.campaignName || null, lead.adsetName || null, lead.adName || null,
        status,
      ],
    );
    return { inserted: true, id: Number(result?.insertId) };
  } catch (error) {
    // The unique key doing its job: this lead is already known.
    if (error?.code === "ER_DUP_ENTRY") return { inserted: false, id: null };
    throw error;
  }
}

export async function listDueRows(limit = 25) {
  return all(
    `SELECT * FROM meta_lead_rows
      WHERE status IN ('pending', 'retrying')
        AND (next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP())
      ORDER BY id
      LIMIT ?`,
    [limit],
  );
}

/**
 * Take the row, or discover somebody else already has.
 *
 * IIS overlapped recycling briefly runs two Node workers, each with its own
 * in-process flag, so two sweepers really can read the same row from
 * listDueRows. The claim is what makes that harmless: the UPDATE narrows on
 * the status it expects, and only one caller sees a row change.
 */
export async function claimRow(id) {
  const result = await run(
    `UPDATE meta_lead_rows
        SET status = 'sending', attempts = attempts + 1
      WHERE id = ? AND status IN ('pending', 'retrying')`,
    [id],
  );
  return Number(result?.affectedRows || 0) === 1;
}

export async function settleRow(id, { status, detail = null, crmUserId = null }) {
  await run(
    `UPDATE meta_lead_rows
        SET status = ?, detail = ?, crm_user_id = ?, next_attempt_at = NULL
      WHERE id = ?`,
    [status, detail, crmUserId, id],
  );
}

export async function deferRow(id, { detail, nextAttemptAt }) {
  await run(
    `UPDATE meta_lead_rows SET status = 'retrying', detail = ?, next_attempt_at = ? WHERE id = ?`,
    [detail, nextAttemptAt, id],
  );
}

export async function requeueRow(id) {
  const result = await run(
    `UPDATE meta_lead_rows
        SET status = 'pending', attempts = 0, next_attempt_at = NULL, detail = NULL
      WHERE id = ? AND status = 'failed'`,
    [id],
  );
  return Number(result?.affectedRows || 0) === 1;
}

export async function listRecentRows(limit = 100) {
  return all(
    `SELECT r.*, s.label AS sheet_label
       FROM meta_lead_rows r
       LEFT JOIN meta_lead_sheets s ON s.id = r.sheet_id
      ORDER BY r.id DESC
      LIMIT ?`,
    [limit],
  );
}

export async function countRowsByStatus() {
  const rows = await all(`SELECT status, COUNT(*) AS cnt FROM meta_lead_rows GROUP BY status`);
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.cnt)]));
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run metaLeads/store.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation-prove the unique key**

Change the rows schema to `UNIQUE KEY uq_meta_lead_rows_lead (sheet_id, meta_lead_id)` and confirm `makes the Meta lead id unique` fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add metaLeads/store.js metaLeads/store.test.js
git commit -m "meta leads: two tables, and a unique lead id doing the deduplication"
```

---

### Task 5: Reading a sheet

**Files:**
- Create: `metaLeads/sheetsReader.js`
- Test: `metaLeads/sheetsReader.test.js`
- Read first: `wallet/fabAccountsSheet.js:19-32` for the service-account pattern this copies.

**Interfaces:**
- Consumes: `COLUMN_COUNT` from Task 1.
- Produces: `columnLetter(index: number): string`, `buildRange(tabName, fromRow): string`, `readSheetRange({ spreadsheetId, tabName, fromRow }, deps?): Promise<{ cells: string[][] }>`, `readHeaderAndRows({ spreadsheetId, tabName, fromRow }, deps?): Promise<{ header: string[], rows: string[][], firstRowNumber: number }>`.
- `deps` is `{ getSheetsClient? }` where `getSheetsClient()` returns `{ spreadsheets: { values: { get } } }`.
- `fromRow` is 1-based and counts the header: `fromRow = 2` means "everything after the header".

- [ ] **Step 1: Write the failing test**

```javascript
// metaLeads/sheetsReader.test.js
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { buildRange, columnLetter, readHeaderAndRows } from "./sheetsReader.js";

const client = (values) => ({
  spreadsheets: { values: { get: vi.fn(async () => ({ data: { values } })) } },
});

describe("columnLetter", () => {
  it("names the columns the export uses", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(17)).toBe("R");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
  });
});

describe("buildRange", () => {
  it("asks for every column of the export from one row on", () => {
    expect(buildRange("Sheet1", 2)).toBe("'Sheet1'!A2:R");
  });

  // A tab called "Leads 2026" breaks an unquoted range, and a tab with an
  // apostrophe breaks a naively quoted one.
  it("quotes the tab name", () => {
    expect(buildRange("Leads 2026", 2)).toBe("'Leads 2026'!A2:R");
    expect(buildRange("Dave's tab", 2)).toBe("'Dave''s tab'!A2:R");
  });
});

describe("readHeaderAndRows", () => {
  const HEADER = ["id","created_time","ad_id","ad_name","adset_id","adset_name","campaign_id","campaign_name","form_id","form_name","is_organic","platform","email","phone_number","first_name","last_name","country","lead_status"];

  it("reads the header and the rows after it on a full read", async () => {
    const sheets = client([HEADER, ["l:1"], ["l:2"]]);
    const result = await readHeaderAndRows(
      { spreadsheetId: "abc", tabName: "Sheet1", fromRow: 1 },
      { getSheetsClient: () => sheets },
    );
    expect(sheets.spreadsheets.values.get).toHaveBeenCalledWith({
      spreadsheetId: "abc", range: "'Sheet1'!A1:R", majorDimension: "ROWS",
    });
    expect(result.header).toEqual(HEADER);
    expect(result.rows).toEqual([["l:1"], ["l:2"]]);
    expect(result.firstRowNumber).toBe(2);
  });

  // The windowed read: the header is fetched separately so the caller can still
  // verify it without pulling thousands of rows back every minute.
  it("fetches the header separately on a windowed read", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ data: { values: [HEADER] } })
      .mockResolvedValueOnce({ data: { values: [["l:9"]] } });
    const result = await readHeaderAndRows(
      { spreadsheetId: "abc", tabName: "Sheet1", fromRow: 31 },
      { getSheetsClient: () => ({ spreadsheets: { values: { get } } }) },
    );
    expect(get).toHaveBeenNthCalledWith(1, { spreadsheetId: "abc", range: "'Sheet1'!A1:R1", majorDimension: "ROWS" });
    expect(get).toHaveBeenNthCalledWith(2, { spreadsheetId: "abc", range: "'Sheet1'!A31:R", majorDimension: "ROWS" });
    expect(result.header).toEqual(HEADER);
    expect(result.rows).toEqual([["l:9"]]);
    expect(result.firstRowNumber).toBe(31);
  });

  it("answers no rows when the window is past the end of the sheet", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ data: { values: [HEADER] } })
      .mockResolvedValueOnce({ data: {} });
    const result = await readHeaderAndRows(
      { spreadsheetId: "abc", tabName: "Sheet1", fromRow: 999 },
      { getSheetsClient: () => ({ spreadsheets: { values: { get } } }) },
    );
    expect(result.rows).toEqual([]);
    expect(result.header).toEqual(HEADER);
  });

  it("answers an empty header for an empty sheet", async () => {
    const sheets = client([]);
    const result = await readHeaderAndRows(
      { spreadsheetId: "abc", tabName: "Sheet1", fromRow: 1 },
      { getSheetsClient: () => sheets },
    );
    expect(result.header).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("lets a Google failure through to the caller", async () => {
    const get = vi.fn(async () => { throw new Error("The caller does not have permission"); });
    await expect(readHeaderAndRows(
      { spreadsheetId: "abc", tabName: "Sheet1", fromRow: 1 },
      { getSheetsClient: () => ({ spreadsheets: { values: { get } } }) },
    )).rejects.toThrow(/permission/);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run metaLeads/sheetsReader.test.js`
Expected: FAIL — `Failed to load ./sheetsReader.js`.

- [ ] **Step 3: Write the implementation**

```javascript
// metaLeads/sheetsReader.js
/**
 * Reading a Meta Lead Ads sheet, and nothing else.
 *
 * The service account is the one wallet/fabAccountsSheet.js already uses --
 * same Google identity, read-only scope, and the three lead workbooks have to
 * be shared with it. Nothing else is shared: a layout change in one workbook
 * must not be able to break another's read.
 *
 * This module does not know what a lead is. It answers cells.
 */
import { google } from "googleapis";
import { COLUMN_COUNT } from "./columns.js";

let cachedClient = null;

function defaultSheetsClient() {
  if (cachedClient) return cachedClient;
  const raw = process.env.GA4_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GA4_SERVICE_ACCOUNT_JSON not configured");
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  cachedClient = google.sheets({ version: "v4", auth });
  return cachedClient;
}

/** 0 -> "A", 17 -> "R", 26 -> "AA". */
export function columnLetter(index) {
  let n = Number(index);
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
}

const LAST_COLUMN = columnLetter(COLUMN_COUNT - 1);

/**
 * A1 notation for every column of the export from `fromRow` down.
 *
 * The tab name is always quoted and its apostrophes doubled: "Leads 2026"
 * breaks an unquoted range, and Sheets reads `''` inside quotes as one
 * apostrophe.
 */
export function buildRange(tabName, fromRow) {
  const quoted = String(tabName ?? "Sheet1").replace(/'/g, "''");
  return `'${quoted}'!A${fromRow}:${LAST_COLUMN}`;
}

async function getValues(sheets, spreadsheetId, range) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    majorDimension: "ROWS",
  });
  const values = response?.data?.values;
  return Array.isArray(values) ? values : [];
}

/**
 * The header row, and the rows from `fromRow` down.
 *
 * `fromRow === 1` is the full read: one call brings the header and every row
 * back together. Anything higher is the windowed read the worker does every
 * minute, and then the header is fetched on its own -- one extra call per
 * sheet per minute, which is the price of still being able to notice that the
 * columns moved without pulling the whole sheet back to find out.
 */
export async function readHeaderAndRows({ spreadsheetId, tabName, fromRow }, deps = {}) {
  const sheets = (deps.getSheetsClient || defaultSheetsClient)();
  const start = Math.max(1, Number(fromRow) || 1);

  if (start === 1) {
    const cells = await getValues(sheets, spreadsheetId, buildRange(tabName, 1));
    return { header: cells[0] ?? [], rows: cells.slice(1), firstRowNumber: 2 };
  }

  const headerCells = await getValues(sheets, spreadsheetId, `${buildRange(tabName, 1)}1`);
  const rows = await getValues(sheets, spreadsheetId, buildRange(tabName, start));
  return { header: headerCells[0] ?? [], rows, firstRowNumber: start };
}
```

Note on the header range: `buildRange(tabName, 1)` is `'Sheet1'!A1:R`, and appending `1` makes `'Sheet1'!A1:R1` — a single row. The test asserts that exact string.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run metaLeads/sheetsReader.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Mutation-prove the quoting**

Remove the `.replace(/'/g, "''")` and confirm `quotes the tab name` fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add metaLeads/sheetsReader.js metaLeads/sheetsReader.test.js
git commit -m "meta leads: read a window of a sheet, and the header every time"
```

---

### Task 6: The worker

**Files:**
- Create: `metaLeads/worker.js`
- Test: `metaLeads/worker.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `BACKOFF_MINUTES`, `MAX_ATTEMPTS`, `FULL_READ_INTERVAL_MS`, `pollSheetOnce(sheet, deps): Promise<{ inserted, skipped, bootstrapped, disabled }>`, `drainOnce(deps): Promise<{ sent, duplicate, failed, deferred }>`, `sweepOnce(deps): Promise<{ polled, drained }>`, `startMetaLeadsWorker()`, `kickMetaLeadsWorker()`.
- `deps` carries every store function, `readHeaderAndRows`, `findLeadByEmail`, `createLead` and `now: () => Date`, all injectable; the defaults are the real modules.

- [ ] **Step 1: Write the failing test**

```javascript
// metaLeads/worker.test.js
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drainOnce, MAX_ATTEMPTS, pollSheetOnce } from "./worker.js";

const HEADER = ["id","created_time","ad_id","ad_name","adset_id","adset_name","campaign_id","campaign_name","form_id","form_name","is_organic","platform","email","phone_number","first_name","last_name","country","lead_status"];
const leadRow = (id, email) => ["l:" + id,"2026-11-04T06:19:44-05:00","ag:1","Ad3","as:1","Partners-IB-Iraq","c:1","Partners-IB","f:1","Form","false","fb",email,"p:+9647705108061","Kaboul","Mutawa","IQ","CREATED"];

const sheet = (over = {}) => ({
  id: 1, label: "Meta – Iraq", spreadsheetId: "abc", tabName: "Sheet1",
  enabled: true, ib: false, sendLeadSource: false, managerId: null,
  language: "en", status: null, tags: null, lastRowCount: 0,
  lastPolledAt: null, lastFullReadAt: null, lastError: null,
  bootstrappedAt: "2026-11-06T00:00:00Z", ...over,
});

const pollDeps = (over = {}) => ({
  readHeaderAndRows: vi.fn(async () => ({ header: HEADER, rows: [], firstRowNumber: 2 })),
  insertLeadRow: vi.fn(async () => ({ inserted: true, id: 1 })),
  markSheetPolled: vi.fn(async () => {}),
  markSheetBootstrapped: vi.fn(async () => {}),
  disableSheetWithError: vi.fn(async () => {}),
  now: () => new Date("2026-11-06T09:00:00Z"),
  ...over,
});

describe("pollSheetOnce", () => {
  it("queues a new row as pending", async () => {
    const deps = pollDeps({
      readHeaderAndRows: vi.fn(async () => ({ header: HEADER, rows: [leadRow("1", "a@b.com")], firstRowNumber: 2 })),
    });
    const result = await pollSheetOnce(sheet(), deps);
    expect(deps.insertLeadRow).toHaveBeenCalledWith(1, expect.objectContaining({ metaLeadId: "1", email: "a@b.com" }), "pending");
    expect(result.inserted).toBe(1);
  });

  it("files a test row under skipped_test without sending it", async () => {
    const testRow = [...leadRow("2", "test@meta.com")];
    const deps = pollDeps({
      readHeaderAndRows: vi.fn(async () => ({ header: HEADER, rows: [testRow], firstRowNumber: 2 })),
    });
    await pollSheetOnce(sheet(), deps);
    expect(deps.insertLeadRow).toHaveBeenCalledWith(1, expect.anything(), "skipped_test");
  });

  // The thing that makes going live safe: 36 leads the team has already worked
  // must not be re-created.
  it("marks every existing row skipped_existing on the first poll", async () => {
    const deps = pollDeps({
      readHeaderAndRows: vi.fn(async () => ({ header: HEADER, rows: [leadRow("1", "a@b.com"), leadRow("2", "c@d.com")], firstRowNumber: 2 })),
    });
    const result = await pollSheetOnce(sheet({ bootstrappedAt: null }), deps);
    expect(deps.insertLeadRow).toHaveBeenNthCalledWith(1, 1, expect.anything(), "skipped_existing");
    expect(deps.insertLeadRow).toHaveBeenNthCalledWith(2, 1, expect.anything(), "skipped_existing");
    expect(deps.markSheetBootstrapped).toHaveBeenCalledWith(1);
    expect(result.bootstrapped).toBe(true);
  });

  it("stops a sheet whose header moved instead of importing it", async () => {
    const moved = [...HEADER];
    [moved[12], moved[13]] = [moved[13], moved[12]];
    const deps = pollDeps({
      readHeaderAndRows: vi.fn(async () => ({ header: moved, rows: [leadRow("1", "a@b.com")], firstRowNumber: 2 })),
    });
    const result = await pollSheetOnce(sheet(), deps);
    expect(deps.disableSheetWithError).toHaveBeenCalledWith(1, expect.stringMatching(/column 13/));
    expect(deps.insertLeadRow).not.toHaveBeenCalled();
    expect(result.disabled).toBe(true);
  });

  it("advances the row count so the next poll reads only what is new", async () => {
    const deps = pollDeps({
      readHeaderAndRows: vi.fn(async () => ({ header: HEADER, rows: [leadRow("1", "a@b.com")], firstRowNumber: 31 })),
    });
    await pollSheetOnce(sheet({ lastRowCount: 30 }), deps);
    expect(deps.markSheetPolled).toHaveBeenCalledWith(1, expect.objectContaining({ rowCount: 31, error: null }));
  });

  // A Google outage must leave the sheet exactly where it was, or the rows it
  // could not read this minute become rows it never reads.
  it("records the error and does not move the row count", async () => {
    const deps = pollDeps({
      readHeaderAndRows: vi.fn(async () => { throw new Error("The caller does not have permission"); }),
    });
    await pollSheetOnce(sheet({ lastRowCount: 30 }), deps);
    expect(deps.markSheetPolled).toHaveBeenCalledWith(1, expect.objectContaining({ rowCount: 30, error: expect.stringMatching(/permission/) }));
  });

  // The windowed read would never see a row inserted above the end, or one
  // edited after it arrived. The hourly full read is what finds them, and the
  // unique lead id is what stops it sending anything twice.
  it("reads the whole sheet once an hour and the window otherwise", async () => {
    const read = vi.fn(async () => ({ header: HEADER, rows: [], firstRowNumber: 2 }));
    const base = { ...pollDeps({ readHeaderAndRows: read }), now: () => new Date("2026-11-06T09:00:00Z") };

    await pollSheetOnce(sheet({ lastRowCount: 30, lastFullReadAt: "2026-11-06T08:50:00Z" }), base);
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ fromRow: 31 }), expect.anything());

    await pollSheetOnce(sheet({ lastRowCount: 30, lastFullReadAt: "2026-11-06T07:00:00Z" }), base);
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ fromRow: 1 }), expect.anything());
  });

  it("skips a row whose lead id is already known", async () => {
    const deps = pollDeps({
      readHeaderAndRows: vi.fn(async () => ({ header: HEADER, rows: [leadRow("1", "a@b.com")], firstRowNumber: 2 })),
      insertLeadRow: vi.fn(async () => ({ inserted: false, id: null })),
    });
    const result = await pollSheetOnce(sheet(), deps);
    expect(result.inserted).toBe(0);
  });
});

const dbRow = (over = {}) => ({
  id: 10, sheet_id: 1, meta_lead_id: "1", first_name: "Kaboul", last_name: "Mutawa",
  email: "a@b.com", phone: "+9647705108061", country: "IQ",
  lead_source: "Partners-IB-Iraq", utm_params: "utm_medium=paid_social",
  campaign_name: "Partners-IB", adset_name: "Partners-IB-Iraq", ad_name: "Ad3",
  status: "pending", attempts: 0, ...over,
});

const drainDeps = (over = {}) => ({
  listDueRows: vi.fn(async () => [dbRow()]),
  claimRow: vi.fn(async () => true),
  getSheet: vi.fn(async () => sheet()),
  findLeadByEmail: vi.fn(async () => null),
  createLead: vi.fn(async () => ({ ok: true, status: 200, userId: 14620, detail: null })),
  settleRow: vi.fn(async () => {}),
  deferRow: vi.fn(async () => {}),
  now: () => new Date("2026-11-06T09:00:00Z"),
  ...over,
});

describe("drainOnce", () => {
  it("creates the lead and records the CRM id", async () => {
    const deps = drainDeps();
    const result = await drainOnce(deps);
    expect(deps.createLead).toHaveBeenCalledWith(expect.objectContaining({ lead: true, email: "a@b.com" }));
    expect(deps.settleRow).toHaveBeenCalledWith(10, { status: "sent", detail: null, crmUserId: 14620 });
    expect(result.sent).toBe(1);
  });

  it("skips a row whose email is already in the CRM", async () => {
    const deps = drainDeps({ findLeadByEmail: vi.fn(async () => ({ id: 14613 })) });
    const result = await drainOnce(deps);
    expect(deps.createLead).not.toHaveBeenCalled();
    expect(deps.settleRow).toHaveBeenCalledWith(10, { status: "duplicate", detail: "already in the CRM as user 14613", crmUserId: 14613 });
    expect(result.duplicate).toBe(1);
  });

  // Skip on email, allow on phone: two people may share an office line.
  it("sends a row with no email without looking anyone up", async () => {
    const deps = drainDeps({ listDueRows: vi.fn(async () => [dbRow({ email: null })]) });
    await drainOnce(deps);
    expect(deps.findLeadByEmail).not.toHaveBeenCalled();
    expect(deps.createLead).toHaveBeenCalled();
  });

  it("leaves a row alone when another worker claimed it first", async () => {
    const deps = drainDeps({ claimRow: vi.fn(async () => false) });
    await drainOnce(deps);
    expect(deps.createLead).not.toHaveBeenCalled();
  });

  it("defers a transient refusal with a backoff", async () => {
    const deps = drainDeps({ createLead: vi.fn(async () => ({ ok: false, status: 503, userId: null, detail: "HTTP 503: upstream" })) });
    const result = await drainOnce(deps);
    expect(deps.deferRow).toHaveBeenCalledWith(10, expect.objectContaining({ detail: "HTTP 503: upstream" }));
    expect(deps.settleRow).not.toHaveBeenCalled();
    expect(result.deferred).toBe(1);
  });

  it("fails a permanent refusal immediately, with the CRM's wording", async () => {
    const deps = drainDeps({ createLead: vi.fn(async () => ({ ok: false, status: 422, userId: null, detail: "HTTP 422: email already used" })) });
    const result = await drainOnce(deps);
    expect(deps.settleRow).toHaveBeenCalledWith(10, { status: "failed", detail: "HTTP 422: email already used", crmUserId: null });
    expect(result.failed).toBe(1);
  });

  it("gives up after the last attempt rather than retrying for ever", async () => {
    const deps = drainDeps({
      listDueRows: vi.fn(async () => [dbRow({ attempts: MAX_ATTEMPTS - 1 })]),
      createLead: vi.fn(async () => ({ ok: false, status: 503, userId: null, detail: "HTTP 503: upstream" })),
    });
    await drainOnce(deps);
    expect(deps.deferRow).not.toHaveBeenCalled();
    expect(deps.settleRow).toHaveBeenCalledWith(10, expect.objectContaining({ status: "failed" }));
  });

  // A lookup that threw is not "nobody has this address".
  it("defers when the duplicate check itself fails", async () => {
    const deps = drainDeps({ findLeadByEmail: vi.fn(async () => { throw new Error("CRM users lookup failed (503)"); }) });
    await drainOnce(deps);
    expect(deps.createLead).not.toHaveBeenCalled();
    expect(deps.deferRow).toHaveBeenCalledWith(10, expect.objectContaining({ detail: expect.stringMatching(/503/) }));
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run metaLeads/worker.test.js`
Expected: FAIL — `Failed to load ./worker.js`.

- [ ] **Step 3: Write the implementation**

```javascript
// metaLeads/worker.js
/**
 * Poll the sheets, then drain the queue. Two passes, in that order, every
 * sixty seconds.
 *
 * They are separate on purpose. A Google outage leaves queued rows untouched,
 * and a CRM outage leaves the sheet's row count where it was -- so neither
 * failure can turn into the other one's data loss. Nothing here needs the
 * catch-up machinery the scheduled reports carry: polling is stateless, so a
 * dead app pool costs a delay and nothing else, and the unique lead id makes
 * the re-read that follows harmless.
 */
import { isTransientHttpStatus } from "../crmSignup/transientHttp.js";
import { headerProblem, readRow } from "./columns.js";
import { normaliseRow } from "./normalise.js";
import { createLead as realCreateLead, buildLeadPayload, findLeadByEmail as realFindLeadByEmail } from "./fxbo.js";
import { readHeaderAndRows as realReadHeaderAndRows } from "./sheetsReader.js";
import {
  claimRow as realClaimRow,
  deferRow as realDeferRow,
  disableSheetWithError as realDisableSheetWithError,
  getSheet as realGetSheet,
  insertLeadRow as realInsertLeadRow,
  listDueRows as realListDueRows,
  listSheets as realListSheets,
  markSheetBootstrapped as realMarkSheetBootstrapped,
  markSheetPolled as realMarkSheetPolled,
  settleRow as realSettleRow,
} from "./store.js";

/** Attempt 1 waits a minute, attempt 6 waits twelve hours, then it stops. */
export const BACKOFF_MINUTES = Object.freeze([1, 5, 15, 60, 180, 720]);
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length;

/** Once an hour the windowed read is replaced by a full one. */
export const FULL_READ_INTERVAL_MS = 60 * 60 * 1000;

const DRAIN_BATCH = 25;

function mysqlDatetime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function dueAfter(attempts, now) {
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];
  return mysqlDatetime(new Date(now.getTime() + minutes * 60 * 1000));
}

/** Is this poll the hourly full read? */
export function wantsFullRead(sheet, now) {
  if (!sheet.lastFullReadAt) return true;
  return now.getTime() - new Date(sheet.lastFullReadAt).getTime() >= FULL_READ_INTERVAL_MS;
}

/**
 * One sheet, one poll.
 *
 * On the very first poll of a newly registered sheet, every row present is
 * written as `skipped_existing` and nothing is sent. That is what makes going
 * live safe: the leads already in these workbooks, some of them worked by hand
 * already, cannot be re-created.
 */
export async function pollSheetOnce(sheet, deps = {}) {
  const readHeaderAndRows = deps.readHeaderAndRows || realReadHeaderAndRows;
  const insertLeadRow = deps.insertLeadRow || realInsertLeadRow;
  const markSheetPolled = deps.markSheetPolled || realMarkSheetPolled;
  const markSheetBootstrapped = deps.markSheetBootstrapped || realMarkSheetBootstrapped;
  const disableSheetWithError = deps.disableSheetWithError || realDisableSheetWithError;
  const now = (deps.now || (() => new Date()))();

  const bootstrapping = !sheet.bootstrappedAt;
  const fullRead = bootstrapping || wantsFullRead(sheet, now);
  const fromRow = fullRead ? 1 : Math.max(2, Number(sheet.lastRowCount || 0) + 1);

  let read;
  try {
    read = await readHeaderAndRows({
      spreadsheetId: sheet.spreadsheetId,
      tabName: sheet.tabName,
      fromRow,
    }, deps);
  } catch (error) {
    // The row count stays exactly where it was: a window we could not read is
    // a window the next poll must read again.
    await markSheetPolled(sheet.id, {
      rowCount: Number(sheet.lastRowCount || 0),
      fullRead: false,
      error: String(error?.message || error).slice(0, 500),
    });
    return { inserted: 0, skipped: 0, bootstrapped: false, disabled: false };
  }

  const problem = headerProblem(read.header);
  if (problem) {
    await disableSheetWithError(sheet.id, `header changed: ${problem}`);
    return { inserted: 0, skipped: 0, bootstrapped: false, disabled: true };
  }

  let inserted = 0;
  let skipped = 0;
  for (const cells of read.rows) {
    const lead = normaliseRow(readRow(cells));
    if (!lead.metaLeadId) continue; // a blank row at the end of the sheet
    const status = bootstrapping ? "skipped_existing" : (lead.skip || "pending");
    const result = await insertLeadRow(sheet.id, lead, status);
    if (!result.inserted) continue;
    if (status === "pending") inserted += 1;
    else skipped += 1;
  }

  const rowCount = Math.max(
    Number(sheet.lastRowCount || 0),
    read.firstRowNumber + read.rows.length - 1,
  );
  await markSheetPolled(sheet.id, { rowCount, fullRead, error: null });
  if (bootstrapping) await markSheetBootstrapped(sheet.id);

  return { inserted, skipped, bootstrapped: bootstrapping, disabled: false };
}

/** The queued row as the payload builder wants it. */
function toLead(row) {
  return {
    metaLeadId: row.meta_lead_id,
    createdTime: row.created_time || "",
    firstName: row.first_name || "",
    lastName: row.last_name || "",
    email: row.email || "",
    phone: row.phone || "",
    country: row.country || null,
    leadSource: row.lead_source || null,
    utmParams: row.utm_params || null,
    campaignName: row.campaign_name || "",
    adsetName: row.adset_name || "",
    adName: row.ad_name || "",
    skip: null,
  };
}

export async function drainOnce(deps = {}) {
  const listDueRows = deps.listDueRows || realListDueRows;
  const claimRow = deps.claimRow || realClaimRow;
  const getSheet = deps.getSheet || realGetSheet;
  const findLeadByEmail = deps.findLeadByEmail || realFindLeadByEmail;
  const createLead = deps.createLead || realCreateLead;
  const settleRow = deps.settleRow || realSettleRow;
  const deferRow = deps.deferRow || realDeferRow;
  const clock = deps.now || (() => new Date());

  const counts = { sent: 0, duplicate: 0, failed: 0, deferred: 0 };
  const rows = await listDueRows(DRAIN_BATCH);

  for (const row of rows) {
    if (!(await claimRow(row.id))) continue;
    const attempts = Number(row.attempts || 0) + 1;
    const now = clock();

    const give = async (detail) => {
      if (attempts >= MAX_ATTEMPTS) {
        await settleRow(row.id, { status: "failed", detail, crmUserId: null });
        counts.failed += 1;
      } else {
        await deferRow(row.id, { detail, nextAttemptAt: dueAfter(attempts, now) });
        counts.deferred += 1;
      }
    };

    try {
      const sheet = await getSheet(row.sheet_id);
      if (!sheet) {
        await settleRow(row.id, { status: "failed", detail: `sheet ${row.sheet_id} no longer registered`, crmUserId: null });
        counts.failed += 1;
        continue;
      }

      const lead = toLead(row);

      // Skip on email, allow on phone. No email means no check, not a block:
      // a lead with a phone is still workable.
      if (lead.email) {
        const existing = await findLeadByEmail(lead.email);
        if (existing) {
          await settleRow(row.id, {
            status: "duplicate",
            detail: `already in the CRM as user ${existing.id}`,
            crmUserId: existing.id,
          });
          counts.duplicate += 1;
          continue;
        }
      }

      const result = await createLead(buildLeadPayload(lead, sheet));
      if (result.ok) {
        await settleRow(row.id, { status: "sent", detail: null, crmUserId: result.userId });
        counts.sent += 1;
        continue;
      }

      if (isTransientHttpStatus(result.status)) {
        await give(result.detail);
      } else {
        await settleRow(row.id, { status: "failed", detail: result.detail, crmUserId: null });
        counts.failed += 1;
      }
    } catch (error) {
      // A thrown lookup, a dropped socket, a CRM with no token configured:
      // transport trouble, which is worth another attempt.
      await give(String(error?.message || error).slice(0, 500));
    }
  }

  return counts;
}

let sweeping = false;

export async function sweepOnce(deps = {}) {
  if (sweeping) return { polled: 0, drained: null };
  sweeping = true;
  try {
    const listSheets = deps.listSheets || realListSheets;
    const sheets = await listSheets();
    let polled = 0;
    for (const sheet of sheets) {
      if (!sheet.enabled) continue;
      try {
        await pollSheetOnce(sheet, deps);
        polled += 1;
      } catch (error) {
        console.error(`[meta-leads] sheet ${sheet.id} poll failed: ${error?.message || String(error)}`);
      }
    }
    // Rows queued by the poll above are drained in this same sweep, so a lead
    // is in the CRM a second after it is noticed rather than a minute.
    const drained = await drainOnce(deps);
    return { polled, drained };
  } finally {
    sweeping = false;
  }
}

function workerEnabled() {
  return String(process.env.META_LEADS_WORKER_ENABLED || "true").toLowerCase() !== "false";
}

/** Fire and forget, for a settings-tab action that should not wait a minute. */
export function kickMetaLeadsWorker() {
  setImmediate(() => {
    sweepOnce().catch((e) => console.error("[meta-leads] kick failed:", e?.message || String(e)));
  });
}

export function startMetaLeadsWorker() {
  if (!workerEnabled()) {
    console.log("[meta-leads] worker disabled by META_LEADS_WORKER_ENABLED=false");
    return null;
  }
  const intervalSeconds = Math.max(30, Number(process.env.META_LEADS_WORKER_INTERVAL_SECONDS || 60) || 60);
  const timer = setInterval(() => {
    sweepOnce().catch((e) => console.error("[meta-leads] sweep failed:", e?.message || String(e)));
  }, intervalSeconds * 1000);
  console.log(`[meta-leads] worker started (interval=${intervalSeconds}s)`);
  return { stop: () => clearInterval(timer), intervalSeconds };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run metaLeads/worker.test.js`
Expected: PASS, 16 tests.

- [ ] **Step 5: Mutation-prove the three guards that matter**

Change `pollSheetOnce` to use `lead.skip || "pending"` even while bootstrapping, and confirm `marks every existing row skipped_existing on the first poll` fails. Restore. Change the Google-failure branch to write `rowCount: read?.rows?.length ?? 0`, and confirm `records the error and does not move the row count` fails. Restore. Change the duplicate check to `catch { return null; }`, and confirm `defers when the duplicate check itself fails` fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add metaLeads/worker.js metaLeads/worker.test.js
git commit -m "meta leads: poll then drain, and a first poll that sends nothing"
```

---

### Task 7: The HTTP routes

**Files:**
- Create: `metaLeads/router.js`
- Test: `metaLeads/router.test.js`

**Interfaces:**
- Consumes: store functions from Task 4, `kickMetaLeadsWorker` from Task 6.
- Produces: `makeMetaLeadsOverviewHandler(deps)`, `makeMetaLeadsSaveSheetHandler(deps)`, `makeMetaLeadsRetryHandler(deps)` — each returns an `(req, res)` Express handler.
- `deps` for overview: `{ listSheets, listRecentRows, countRowsByStatus }`. For save: `{ listSheets, insertSheet, updateSheet, kick }`. For retry: `{ requeueRow, kick }`.

- [ ] **Step 1: Write the failing test**

```javascript
// metaLeads/router.test.js
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { makeMetaLeadsOverviewHandler, makeMetaLeadsRetryHandler, makeMetaLeadsSaveSheetHandler } from "./router.js";

const res = () => {
  const r = { statusCode: 200, body: null };
  r.status = vi.fn((code) => { r.statusCode = code; return r; });
  r.json = vi.fn((payload) => { r.body = payload; return r; });
  return r;
};

describe("the overview handler", () => {
  it("answers the sheets, the counts and the recent rows", async () => {
    const handler = makeMetaLeadsOverviewHandler({
      listSheets: vi.fn(async () => [{ id: 1, label: "Meta – Iraq", enabled: true }]),
      listRecentRows: vi.fn(async () => [{ id: 10, meta_lead_id: "1", status: "sent", email: "a@b.com" }]),
      countRowsByStatus: vi.fn(async () => ({ sent: 4, duplicate: 1 })),
    });
    const r = res();
    await handler({ query: {} }, r);
    expect(r.statusCode).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.sheets).toHaveLength(1);
    expect(r.body.counts).toEqual({ sent: 4, duplicate: 1 });
    expect(r.body.rows[0].metaLeadId).toBe("1");
  });

  it("answers 500 with the reason when a read fails", async () => {
    const handler = makeMetaLeadsOverviewHandler({
      listSheets: vi.fn(async () => { throw new Error("pool is not initialized"); }),
      listRecentRows: vi.fn(async () => []),
      countRowsByStatus: vi.fn(async () => ({})),
    });
    const r = res();
    await handler({ query: {} }, r);
    expect(r.statusCode).toBe(500);
    expect(r.body.error).toMatch(/pool is not initialized/);
  });
});

describe("the save-sheet handler", () => {
  it("creates a sheet with the defaults the design names", async () => {
    const insertSheet = vi.fn(async () => ({ id: 3 }));
    const handler = makeMetaLeadsSaveSheetHandler({ insertSheet, updateSheet: vi.fn(), kick: vi.fn() });
    const r = res();
    await handler({ body: { label: "Meta – UAE", spreadsheetId: "xyz" } }, r);
    expect(insertSheet).toHaveBeenCalledWith(expect.objectContaining({
      label: "Meta – UAE", spreadsheetId: "xyz", tabName: "Sheet1",
      enabled: true, ib: false, sendLeadSource: false,
      managerId: null, language: "en", status: null, tags: null,
    }));
    expect(r.body).toEqual({ ok: true, id: 3 });
  });

  // A spreadsheet URL pasted whole is the obvious thing to do, and the id in
  // the middle of it is the only part that works.
  it("accepts a pasted spreadsheet URL", async () => {
    const insertSheet = vi.fn(async () => ({ id: 4 }));
    const handler = makeMetaLeadsSaveSheetHandler({ insertSheet, updateSheet: vi.fn(), kick: vi.fn() });
    await handler({ body: { label: "L", spreadsheetId: "https://docs.google.com/spreadsheets/d/1-lAAXoq/edit?gid=0#gid=0" } }, res());
    expect(insertSheet).toHaveBeenCalledWith(expect.objectContaining({ spreadsheetId: "1-lAAXoq" }));
  });

  it("updates when given an id", async () => {
    const updateSheet = vi.fn(async () => {});
    const handler = makeMetaLeadsSaveSheetHandler({ insertSheet: vi.fn(), updateSheet, kick: vi.fn() });
    await handler({ body: { id: 2, label: "Meta – Turkey", spreadsheetId: "abc", ib: true, managerId: "20" } }, res());
    expect(updateSheet).toHaveBeenCalledWith(2, expect.objectContaining({ ib: true, managerId: 20 }));
  });

  it("refuses a sheet with no label or no spreadsheet", async () => {
    const handler = makeMetaLeadsSaveSheetHandler({ insertSheet: vi.fn(), updateSheet: vi.fn(), kick: vi.fn() });
    const r = res();
    await handler({ body: { label: "" } }, r);
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toMatch(/label and spreadsheetId are required/);
  });

  it("refuses a manager id that is not a positive number", async () => {
    const handler = makeMetaLeadsSaveSheetHandler({ insertSheet: vi.fn(), updateSheet: vi.fn(), kick: vi.fn() });
    const r = res();
    await handler({ body: { label: "L", spreadsheetId: "a", managerId: "twenty" } }, r);
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toMatch(/managerId/);
  });
});

describe("the retry handler", () => {
  it("requeues the row and wakes the worker", async () => {
    const requeueRow = vi.fn(async () => true);
    const kick = vi.fn();
    const handler = makeMetaLeadsRetryHandler({ requeueRow, kick });
    const r = res();
    await handler({ body: { id: 10 } }, r);
    expect(requeueRow).toHaveBeenCalledWith(10);
    expect(kick).toHaveBeenCalled();
    expect(r.body).toEqual({ ok: true, requeued: true });
  });

  // Only a failed row can be requeued; a sent one must not be sent twice.
  it("reports a row it could not requeue, and does not wake the worker", async () => {
    const kick = vi.fn();
    const handler = makeMetaLeadsRetryHandler({ requeueRow: vi.fn(async () => false), kick });
    const r = res();
    await handler({ body: { id: 10 } }, r);
    expect(r.body).toEqual({ ok: true, requeued: false });
    expect(kick).not.toHaveBeenCalled();
  });

  it("refuses a request with no id", async () => {
    const handler = makeMetaLeadsRetryHandler({ requeueRow: vi.fn(), kick: vi.fn() });
    const r = res();
    await handler({ body: {} }, r);
    expect(r.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run metaLeads/router.test.js`
Expected: FAIL — `Failed to load ./router.js`.

- [ ] **Step 3: Write the implementation**

```javascript
// metaLeads/router.js
/**
 * The three calls the settings tab makes. Mounting, auth and the permission
 * gate are server.js's business; these are handlers and nothing else, which is
 * what lets them be tested without an HTTP server.
 */

const DEFAULT_ROW_LIMIT = 100;
const MAX_ROW_LIMIT = 500;

/** A spreadsheet id, whether it arrived bare or inside a pasted URL. */
export function parseSpreadsheetId(raw) {
  const text = String(raw ?? "").trim();
  const inUrl = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return inUrl ? inUrl[1] : text;
}

function rowLimit(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_ROW_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_ROW_LIMIT;
  return Math.min(MAX_ROW_LIMIT, Math.max(1, Math.floor(n)));
}

/** A database row as the browser reads it. The raw column names do not travel. */
function toClientRow(row) {
  return {
    id: Number(row.id),
    sheetId: Number(row.sheet_id),
    sheetLabel: row.sheet_label ?? null,
    metaLeadId: row.meta_lead_id,
    createdTime: row.created_time ?? null,
    name: [row.first_name, row.last_name].filter(Boolean).join(" "),
    email: row.email ?? null,
    phone: row.phone ?? null,
    country: row.country ?? null,
    leadSource: row.lead_source ?? null,
    adName: row.ad_name ?? null,
    status: row.status,
    detail: row.detail ?? null,
    crmUserId: row.crm_user_id ?? null,
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: row.next_attempt_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/** GET /api/meta-leads/overview?limit=100 */
export function makeMetaLeadsOverviewHandler({ listSheets, listRecentRows, countRowsByStatus }) {
  return async function metaLeadsOverview(req, res) {
    try {
      const limit = rowLimit(req?.query?.limit);
      const [sheets, rows, counts] = await Promise.all([
        listSheets(),
        listRecentRows(limit),
        countRowsByStatus(),
      ]);
      res.json({ ok: true, sheets, counts, rows: rows.map(toClientRow) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  };
}

/**
 * POST /api/meta-leads/sheets
 *
 * Creates when there is no id, updates when there is. The defaults are the
 * design's: English, not IB, no owner, no tags, no status, no lead source.
 */
export function makeMetaLeadsSaveSheetHandler({ insertSheet, updateSheet, kick }) {
  return async function metaLeadsSaveSheet(req, res) {
    const body = req?.body || {};
    const label = String(body.label ?? "").trim();
    const spreadsheetId = parseSpreadsheetId(body.spreadsheetId);
    if (!label || !spreadsheetId) {
      return res.status(400).json({ ok: false, error: "label and spreadsheetId are required" });
    }

    let managerId = null;
    if (body.managerId !== undefined && body.managerId !== null && String(body.managerId).trim() !== "") {
      const parsed = Number(body.managerId);
      if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
        return res.status(400).json({ ok: false, error: "managerId must be a positive whole number" });
      }
      managerId = parsed;
    }

    const fields = {
      label,
      spreadsheetId,
      tabName: String(body.tabName ?? "").trim() || "Sheet1",
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
      ib: Boolean(body.ib),
      sendLeadSource: Boolean(body.sendLeadSource),
      managerId,
      language: String(body.language ?? "").trim() || "en",
      status: String(body.status ?? "").trim() || null,
      tags: String(body.tags ?? "").trim() || null,
    };

    try {
      if (body.id) {
        await updateSheet(Number(body.id), fields);
        kick();
        return res.json({ ok: true, id: Number(body.id) });
      }
      const created = await insertSheet(fields);
      kick();
      return res.json({ ok: true, id: created.id });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ ok: false, error: "that spreadsheet and tab are already registered" });
      }
      return res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  };
}

/**
 * POST /api/meta-leads/retry
 *
 * Only a `failed` row moves; the store's WHERE sees to that. A `sent` row
 * answers requeued:false rather than being sent to the CRM a second time.
 */
export function makeMetaLeadsRetryHandler({ requeueRow, kick }) {
  return async function metaLeadsRetry(req, res) {
    const id = Number(req?.body?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "id is required" });
    }
    try {
      const requeued = await requeueRow(id);
      if (requeued) kick();
      return res.json({ ok: true, requeued });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run metaLeads/router.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Mutation-prove the requeue gate**

Change the retry handler to call `kick()` unconditionally and confirm `reports a row it could not requeue, and does not wake the worker` fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add metaLeads/router.js metaLeads/router.test.js
git commit -m "meta leads: three handlers, and a retry that only moves a failure"
```

---

### Task 8: Wiring it into the server

**Files:**
- Modify: `server.js` — imports beside the `crmSignup` block near line 25; route mounts beside `/api/crm-events` near line 1332; boot beside `initCrmSignupStore()` near line 1539.
- Modify: `.env.example` — a new block at the end.

**Interfaces:**
- Consumes: `initMetaLeadsStore`, `listSheets`, `listRecentRows`, `countRowsByStatus`, `insertSheet`, `updateSheet`, `requeueRow` (Task 4); the three handler factories (Task 7); `startMetaLeadsWorker`, `kickMetaLeadsWorker` (Task 6).
- Produces: `GET /api/meta-leads/overview`, `POST /api/meta-leads/sheets`, `POST /api/meta-leads/retry`, all behind `authRequired` + `adminOnly`.

- [ ] **Step 1: Add the imports**

After the `crmSignup` imports (around line 25 of `server.js`):

```javascript
import {
  makeMetaLeadsOverviewHandler,
  makeMetaLeadsRetryHandler,
  makeMetaLeadsSaveSheetHandler,
} from "./metaLeads/router.js";
import {
  countRowsByStatus as countMetaLeadRows,
  initMetaLeadsStore,
  insertSheet as insertMetaLeadSheet,
  listRecentRows as listMetaLeadRows,
  listSheets as listMetaLeadSheets,
  requeueRow as requeueMetaLeadRow,
  updateSheet as updateMetaLeadSheet,
} from "./metaLeads/store.js";
import { kickMetaLeadsWorker, startMetaLeadsWorker } from "./metaLeads/worker.js";
```

- [ ] **Step 2: Mount the routes**

After the `/api/crm-events/requeue` mount (around line 1346):

```javascript
// The same gate as the CRM Events tab, and for the same reason: these routes
// register a data source and replay a CRM write, which is admin work rather
// than a setting.
app.get('/api/meta-leads/overview', authRequired, adminOnly, makeMetaLeadsOverviewHandler({
  listSheets: listMetaLeadSheets,
  listRecentRows: listMetaLeadRows,
  countRowsByStatus: countMetaLeadRows,
}));

app.post('/api/meta-leads/sheets', authRequired, adminOnly, makeMetaLeadsSaveSheetHandler({
  insertSheet: insertMetaLeadSheet,
  updateSheet: updateMetaLeadSheet,
  kick: kickMetaLeadsWorker,
}));

app.post('/api/meta-leads/retry', authRequired, adminOnly, makeMetaLeadsRetryHandler({
  requeueRow: requeueMetaLeadRow,
  kick: kickMetaLeadsWorker,
}));
```

- [ ] **Step 3: Start the store and the worker at boot**

Immediately after the `initCrmSignupStore()` block (around line 1541):

```javascript
  initMetaLeadsStore()
    .then(() => startMetaLeadsWorker())
    .catch((e) => console.error("[meta-leads] store init failed:", e?.message || String(e)));
```

- [ ] **Step 4: Document the configuration**

Append to `.env.example`:

```bash
# ───────────────────────────────────────────────────────────────────────────
# Meta lead ads -> FXBO leads
#
# Reads the Meta Lead Ads export sheets and creates each new row as a lead in
# FXBO. The sheets themselves are registered in /settings/meta-leads, not here.
#
# No new credentials. It reuses GA4_SERVICE_ACCOUNT_JSON to read the sheets --
# each workbook must be SHARED (Viewer) with that service account's address --
# the AUTH_DB_* database for its two tables, and API_TOKEN for the CRM.
#
# Design: docs/superpowers/specs/2026-11-06-meta-leads-to-fxbo-design.md
META_LEADS_WORKER_ENABLED=true
META_LEADS_WORKER_INTERVAL_SECONDS=60
```

- [ ] **Step 5: Verify the server still starts and the routes exist**

Run: `node --check server.js`
Expected: no output.

Run: `npx vitest run metaLeads/`
Expected: PASS, all five metaLeads suites.

- [ ] **Step 6: Commit**

```bash
git add server.js .env.example
git commit -m "meta leads: three admin routes, and a worker that starts with the app"
```

---

### Task 9: The settings tab

**Files:**
- Create: `src/pages/settings/MetaLeadsPage.tsx`
- Create: `src/pages/settings/MetaLeadsPage.test.tsx`
- Modify: `src/App.tsx:51` — add to the settings page map.
- Modify: `src/lib/permissions.ts` — add to `SETTINGS_MENU_ITEMS` after the `crm-events` entry.
- Modify: `src/lib/permissions.settings.test.ts:27` — add `"meta-leads"` to the expected key list.

**Interfaces:**
- Consumes: `GET /api/meta-leads/overview`, `POST /api/meta-leads/sheets`, `POST /api/meta-leads/retry` (Task 8); `authHeaders()` from `@/lib/auth`; `formatDubaiInstant` from `@/lib/dubaiTime`.
- Produces: `MetaLeadsPage` (default and named export), and the settings menu item `{ key: "meta-leads", name: "Meta Leads", path: "/settings/meta-leads", icon: "Share2", group: "admin", requiredPermissions: ["Settings", "Auth:ManageUsers"] }`.

- [ ] **Step 1: Register the page in the menu and the router**

In `src/lib/permissions.ts`, immediately after the `crm-events` entry:

```typescript
  // Beside CRM Events, on the same gate and for the same reason: its routes
  // are mounted behind adminOnly, so a Settings-only user would be shown a tab
  // that could only ever read "Could not load". It is the inbound counterpart
  // of that page -- CRM Events watches what FXBO tells us, this watches what
  // we tell FXBO.
  {
    key: "meta-leads",
    name: "Meta Leads",
    path: "/settings/meta-leads",
    icon: "Share2",
    group: "admin",
    requiredPermissions: ["Settings", "Auth:ManageUsers"],
  },
```

In `src/App.tsx`, beside `"crm-events": CrmEventsPage`:

```typescript
  "meta-leads": MetaLeadsPage,
```

and its import alongside the other settings pages:

```typescript
import { MetaLeadsPage } from "@/pages/settings/MetaLeadsPage";
```

In `src/lib/permissions.settings.test.ts`, add `"meta-leads"` to the expected key array on line 27.

- [ ] **Step 2: Write the failing test**

```tsx
// src/pages/settings/MetaLeadsPage.test.tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MetaLeadsPage } from "./MetaLeadsPage";

const overview = {
  ok: true,
  counts: { sent: 4, duplicate: 1, failed: 1, skipped_existing: 36 },
  sheets: [
    { id: 1, label: "Meta – Iraq", spreadsheetId: "abc", tabName: "Sheet1", enabled: true, ib: false, sendLeadSource: false, managerId: null, language: "en", status: null, tags: null, lastRowCount: 31, lastPolledAt: "2026-11-06T09:00:00Z", lastError: null, bootstrappedAt: "2026-11-06T08:00:00Z" },
    { id: 2, label: "Meta – Turkey", spreadsheetId: "def", tabName: "Sheet1", enabled: false, ib: false, sendLeadSource: false, managerId: null, language: "en", status: null, tags: null, lastRowCount: 7, lastPolledAt: "2026-11-06T09:00:00Z", lastError: "header changed: column 13 reads \"first_name\"", bootstrappedAt: null },
  ],
  rows: [
    { id: 10, sheetId: 1, sheetLabel: "Meta – Iraq", metaLeadId: "1593296142070496", name: "Kaboul Mutawa", email: "a@b.com", phone: "+9647705108061", country: "IQ", adName: "Partners-IB-Iraq-Ad3", status: "sent", detail: null, crmUserId: 14620, attempts: 1, nextAttemptAt: null, updatedAt: "2026-11-06T09:00:00Z" },
    { id: 11, sheetId: 1, sheetLabel: "Meta – Iraq", metaLeadId: "2113586602691774", name: "Hussein Younis", email: "c@d.com", phone: "+9647826732758", country: "IQ", adName: "Partners-IB-Iraq-Ad2", status: "failed", detail: "HTTP 422: email already used", crmUserId: null, attempts: 6, nextAttemptAt: null, updatedAt: "2026-11-06T09:00:00Z" },
  ],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => overview })));
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MetaLeadsPage", () => {
  it("shows each registered sheet and what it last did", async () => {
    render(<MetaLeadsPage />);
    expect(await screen.findByText("Meta – Iraq")).toBeInTheDocument();
    expect(screen.getByText("Meta – Turkey")).toBeInTheDocument();
  });

  // A disabled sheet with an error is the one state somebody has to act on,
  // so it must not read the same as a sheet that is merely off.
  it("shows why a sheet was disabled", async () => {
    render(<MetaLeadsPage />);
    expect(await screen.findByText(/header changed: column 13/)).toBeInTheDocument();
  });

  it("tells a bootstrapped sheet from one that has never been read", async () => {
    render(<MetaLeadsPage />);
    expect(await screen.findByText(/first read not done/i)).toBeInTheDocument();
  });

  it("lists the recent leads with their status", async () => {
    render(<MetaLeadsPage />);
    expect(await screen.findByText("Kaboul Mutawa")).toBeInTheDocument();
    expect(screen.getByText("HTTP 422: email already used")).toBeInTheDocument();
  });

  it("offers a retry only on a failed row", async () => {
    render(<MetaLeadsPage />);
    await screen.findByText("Kaboul Mutawa");
    expect(screen.getAllByRole("button", { name: /retry/i })).toHaveLength(1);
  });

  it("posts the retry and reloads", async () => {
    const user = userEvent.setup();
    render(<MetaLeadsPage />);
    await screen.findByText("Kaboul Mutawa");
    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/meta-leads/retry", expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ id: 11 }),
      }));
    });
  });

  it("says so when the overview cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: "pool is not initialized" }) })));
    render(<MetaLeadsPage />);
    expect(await screen.findByText(/pool is not initialized/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npx vitest run src/pages/settings/MetaLeadsPage.test.tsx`
Expected: FAIL — cannot resolve `./MetaLeadsPage`.

- [ ] **Step 4: Write the page**

```tsx
// src/pages/settings/MetaLeadsPage.tsx
import { useCallback, useEffect, useState } from "react";
import { authHeaders } from "@/lib/auth";
// Every instant is a UTC instant rendered in Dubai time: this is read on a
// phone that is not always in Dubai, and a sheet that "last polled at 09:00"
// has to mean the same thing wherever it is read.
import { formatDubaiInstant } from "@/lib/dubaiTime";

const OVERVIEW_URL = "/api/meta-leads/overview";
const RETRY_URL = "/api/meta-leads/retry";

type Sheet = {
  id: number;
  label: string;
  spreadsheetId: string;
  tabName: string;
  enabled: boolean;
  ib: boolean;
  sendLeadSource: boolean;
  managerId: number | null;
  language: string | null;
  status: string | null;
  tags: string | null;
  lastRowCount: number;
  lastPolledAt: string | null;
  lastError: string | null;
  bootstrappedAt: string | null;
};

type Row = {
  id: number;
  sheetLabel: string | null;
  metaLeadId: string;
  name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  adName: string | null;
  status: string;
  detail: string | null;
  crmUserId: number | null;
  attempts: number;
  nextAttemptAt: string | null;
  updatedAt: string | null;
};

type Overview = { ok: boolean; sheets: Sheet[]; counts: Record<string, number>; rows: Row[] };

/** The six statuses a row can hold, and how each should read at a glance. */
const STATUS_LABEL: Record<string, string> = {
  pending: "queued",
  retrying: "retrying",
  sending: "sending",
  sent: "in the CRM",
  duplicate: "already in the CRM",
  failed: "refused",
  skipped_test: "Meta test row",
  skipped_empty: "no contact details",
  skipped_existing: "was there before",
};

const STATUS_TONE: Record<string, string> = {
  sent: "text-emerald-600 dark:text-emerald-400",
  duplicate: "text-amber-600 dark:text-amber-400",
  failed: "text-rose-600 dark:text-rose-400",
  retrying: "text-amber-600 dark:text-amber-400",
};

export const MetaLeadsPage: React.FC = () => {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(OVERVIEW_URL, { headers: authHeaders() });
      const body = await response.json();
      if (!response.ok || !body?.ok) {
        setError(String(body?.error || `Could not load (HTTP ${response.status})`));
        return;
      }
      setError(null);
      setData(body as Overview);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = useCallback(async (id: number) => {
    setBusyId(id);
    try {
      await fetch(RETRY_URL, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }, [load]);

  return (
    <div className="space-y-6 p-4">
      <header>
        <h1 className="text-xl font-semibold">Meta Leads</h1>
        <p className="text-sm text-muted-foreground">
          Every new row in these sheets becomes a lead in FXBO, once, within about a minute.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">
          {error}
        </div>
      )}

      {data && (
        <>
          <section className="flex flex-wrap gap-3">
            {Object.entries(data.counts).map(([status, count]) => (
              <div key={status} className="rounded-md border px-3 py-2 text-sm">
                <div className="font-semibold">{count}</div>
                <div className="text-muted-foreground">{STATUS_LABEL[status] ?? status}</div>
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase text-muted-foreground">Sheets</h2>
            {data.sheets.map((sheet) => (
              <div key={sheet.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{sheet.label}</span>
                  <span className="text-muted-foreground">
                    {sheet.enabled ? "on" : "off"} · {sheet.lastRowCount} rows read ·{" "}
                    {sheet.lastPolledAt ? formatDubaiInstant(sheet.lastPolledAt) : "never polled"}
                  </span>
                </div>
                {!sheet.bootstrappedAt && (
                  <div className="mt-1 text-muted-foreground">
                    First read not done yet — everything already in this sheet will be recorded
                    without being sent.
                  </div>
                )}
                {sheet.lastError && (
                  <div className="mt-1 text-rose-600 dark:text-rose-400">{sheet.lastError}</div>
                )}
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase text-muted-foreground">Recent leads</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="p-2">Lead</th>
                    <th className="p-2">Sheet</th>
                    <th className="p-2">Ad</th>
                    <th className="p-2">Status</th>
                    <th className="p-2">When</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.id} className="border-t align-top">
                      <td className="p-2">
                        <div className="font-medium">{row.name || "(no name)"}</div>
                        <div className="text-muted-foreground">{row.email || row.phone}</div>
                      </td>
                      <td className="p-2">{row.sheetLabel}</td>
                      <td className="p-2">{row.adName}</td>
                      <td className="p-2">
                        <div className={STATUS_TONE[row.status] ?? ""}>
                          {STATUS_LABEL[row.status] ?? row.status}
                          {row.crmUserId ? ` (#${row.crmUserId})` : ""}
                        </div>
                        {row.detail && <div className="text-muted-foreground">{row.detail}</div>}
                      </td>
                      <td className="p-2 text-muted-foreground">
                        {row.updatedAt ? formatDubaiInstant(row.updatedAt) : "—"}
                      </td>
                      <td className="p-2">
                        {row.status === "failed" && (
                          <button
                            type="button"
                            className="rounded border px-2 py-1"
                            disabled={busyId === row.id}
                            onClick={() => void retry(row.id)}
                          >
                            Retry
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
};

export default MetaLeadsPage;
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/pages/settings/MetaLeadsPage.test.tsx src/lib/permissions.settings.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and build**

Run: `npx tsc -b --noEmit`
Expected: the four pre-existing `SwapsReportTab.tsx` errors about `unrealizedSwap` and nothing new.

Run: `node scripts/build.mjs`
Expected: `assets/index.js` plus a new `assets/chunk-MetaLeadsPage.js`.

- [ ] **Step 7: Run everything**

Run: `npx vitest run`
Expected: PASS, including the five `metaLeads/` suites and the two touched `src/lib` suites.

- [ ] **Step 8: Commit**

```bash
git add src/pages/settings/MetaLeadsPage.tsx src/pages/settings/MetaLeadsPage.test.tsx src/App.tsx src/lib/permissions.ts src/lib/permissions.settings.test.ts
git commit -m "meta leads: a tab that says what each sheet last did and where each lead went"
```

---

## After the plan: going live

These are the user's steps, not the implementer's, and they are deliberately in this order.

1. **Share the three workbooks** (Viewer) with the service account in `GA4_SERVICE_ACCOUNT_JSON`. Its address is the `client_email` of that JSON, readable on the server.
2. Push and restart. Confirm `[meta-leads] worker started (interval=60s)` in the newest `logs/iisnode/*-stdout-*.txt`.
3. **Register one sheet first — Turkey, the smallest.** Its six existing rows must all appear as *was there before*, and nothing must reach FXBO. That is the bootstrap proving itself on six rows rather than on thirty.
4. Register Iraq and UAE.
5. Wait for one genuinely new lead, and check it in FXBO: name split correctly, country `IQ` or `TR` rather than `US`, and the campaign readable in the user's marketing details.

| Sheet | Spreadsheet id | Label | Language |
|---|---|---|---|
| Iraq | `1-lAAXoqOQGwnGGKbTqGHSqe2hQmOOzh2HvluPABl3g8` | Meta – Iraq | `en` |
| Turkey | `1QTnAk_02wen7JoKnzb647YtH0HhI2KPElaH79Re-oKE` | Meta – Turkey | `en` |
| UAE | `1aSbMb79K8L4YdFVyCXzOZB0SXoFjrxPsdCqYxb1K35c` | Meta – UAE | `en` |

Everything else is left at its default: `ib` off, no lead source, no owner, no tags, no status.
