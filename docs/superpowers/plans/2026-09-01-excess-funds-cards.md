# Excess Funds Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Excess Funds section to `/departments/accounts` with nine cards — seven inputs plus Gross and Net Excess Fund.

**Architecture:** A pure `computeExcessFunds()` holds all the arithmetic and every degradation rule, so both are testable without a network. A new isolated Google Sheets client reads two FAB balances from a workbook unrelated to the existing one. A new component renders the cards; `AccountsDepartment.tsx` only mounts it and supplies data.

**Tech Stack:** React 18, TypeScript, Vite, vitest. Server is Node ESM + Express. `googleapis` is already a dependency.

## Global Constraints

- **The formulas, exactly:**
  `Gross Excess Fund = netDifference + Net Crypto + (FAB + MBME) + Gold Souq`
  `Net Excess Fund = Gross Excess Fund + FAB Operating + FAB Holding`
- **Use the backend's `netDifference`.** Never compute `lpWithdrawableEquity - clientWithdrawableEquity` in our code. Verified live 2026-09-01: `3,275,567.91 - 4,465,937.54 = -1,190,369.63`, identical to the backend's own field.
- **A missing input makes the figure unavailable, never a partial sum.** If any term a figure needs is `null`, that figure renders as unavailable and names what was missing.
- **Zero is a real balance.** `0` must never stand for "could not read". A failed source is `null`.
- **`status: 'error'` on a wallet widget means `null`, not `0`.** `walletMonitor` returns `balance: 0, status: 'error'` when a PSP check fails, and `AccountsDepartment.tsx:374` already coerces that to `0`. This section must read the raw widgets, not the coerced `pspBalances` array.
- **The crypto set is derived**, never a literal count. Use `PSP_ORDER.filter(p => p.group === 'crypto')`. A hardcoded `7` previously mis-grouped the rows (`AccountsDepartment.tsx:159`).
- **The new workbook is completely separate.** Its own env var, its own client, its own failure path. It must not share a code path with `wallet/pspClients.js`.
- **Sheet location is configuration, not code** — spreadsheet id, tab, and both cell addresses.
- **Do not change `lpPlusPspDifference`** (`AccountsDepartment.tsx:591`) or any existing tile's value.
- Run tests with `npx vitest run`. This project's `tsconfig.json` has `"files": []`, so `npx tsc --noEmit` checks **nothing** — always use `npx tsc -b --noEmit`. Files under `wallet/` and `reports/` are plain JavaScript and are not type-checked at all.
- Comments explain **why**, in prose. No comment restates what the line does.

### A counting note that will otherwise confuse you

The spec speaks of *seven inputs* — that is the **card** count. Net LP Equity and
Net Client Equity are display-only cards; the arithmetic uses the single
`netDifference` value the backend already publishes.

So there are **six computed inputs**: `netDifference`, `netCrypto`, `fabAndMbme`,
`goldSouq`, `fabOperating`, `fabHolding`. Gross needs the first four; Net needs
all six.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/excessFunds.ts` (create) | `computeExcessFunds()` — all arithmetic and degradation rules. Pure, no I/O, no React. |
| `src/lib/excessFunds.test.ts` (create) | Tests for the above. |
| `wallet/fabAccountsMappingConfig.js` (create) | Spreadsheet tab and the two cell addresses, with a JSON override file. |
| `wallet/fabAccountsSheet.js` (create) | The second workbook client. Isolated from `pspClients.js`. |
| `wallet/fabAccountsSheet.test.js` (create) | Tests for cell parsing and error messages. |
| `src/lib/excessFundsApi.ts` (create) | `fetchFabAccounts()` — throws loudly on an unexpected shape. |
| `src/lib/excessFundsApi.test.ts` (create) | Tests for the unwrap. |
| `src/components/dashboard/ExcessFundsSection.tsx` (create) | The nine cards. |
| `src/components/dashboard/ExcessFundsSection.test.tsx` (create) | Render tests. |
| `src/components/dashboard/AccountsDepartment.tsx` (modify) | Un-gate the equity fetch; keep raw widgets; mount the section; add a scope note to the existing figure. |
| `server.js` (modify) | `GET /api/fab-accounts`. |
| `.env.example` (modify) | `FAB_ACCOUNTS_SHEET_ID`. |

---

## Task 1: The arithmetic and the degradation rules

**Files:**
- Create: `src/lib/excessFunds.ts`
- Test: `src/lib/excessFunds.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type ExcessInput = number | null;
  export interface ExcessFundsInputs {
    netDifference: ExcessInput;
    netCrypto: ExcessInput;
    fabAndMbme: ExcessInput;
    goldSouq: ExcessInput;
    fabOperating: ExcessInput;
    fabHolding: ExcessInput;
  }
  export interface ExcessFigure { value: number | null; missing: string[] }
  export interface ExcessFundsResult { gross: ExcessFigure; net: ExcessFigure }
  export function computeExcessFunds(inputs: ExcessFundsInputs): ExcessFundsResult;
  export const GROSS_TERMS: readonly (keyof ExcessFundsInputs)[];
  export const NET_EXTRA_TERMS: readonly (keyof ExcessFundsInputs)[];
  export const EXCESS_LABELS: Record<keyof ExcessFundsInputs, string>;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/excessFunds.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { computeExcessFunds, EXCESS_LABELS, type ExcessFundsInputs } from "./excessFunds";

// The live figures on 2026-09-01, so the arithmetic is anchored to something
// real rather than to numbers chosen to make the test pass.
const LIVE: ExcessFundsInputs = {
  netDifference: -1190369.63,
  netCrypto: 500000,
  fabAndMbme: 250000,
  goldSouq: 100000,
  fabOperating: 300000,
  fabHolding: 200000,
};

const all = (over: Partial<ExcessFundsInputs> = {}): ExcessFundsInputs => ({ ...LIVE, ...over });

describe("the two formulas", () => {
  it("sums gross from its four terms", () => {
    const { gross } = computeExcessFunds(all());
    expect(gross.value).toBeCloseTo(-1190369.63 + 500000 + 250000 + 100000, 2);
    expect(gross.missing).toEqual([]);
  });

  it("adds the two FAB accounts on top of gross to make net", () => {
    const { gross, net } = computeExcessFunds(all());
    expect(net.value).toBeCloseTo((gross.value as number) + 300000 + 200000, 2);
    expect(net.missing).toEqual([]);
  });

  // netDifference is negative today: clients hold more withdrawable equity than
  // the LPs do. A result that came back positive would mean a sign error.
  it("keeps a negative result negative", () => {
    const { gross } = computeExcessFunds(all({ netCrypto: 0, fabAndMbme: 0, goldSouq: 0 }));
    expect(gross.value).toBeCloseTo(-1190369.63, 2);
    expect(gross.value as number).toBeLessThan(0);
  });
});

describe("a zero is a balance, not a gap", () => {
  it("computes normally when every input is a genuine zero", () => {
    const zeroes: ExcessFundsInputs = {
      netDifference: 0, netCrypto: 0, fabAndMbme: 0,
      goldSouq: 0, fabOperating: 0, fabHolding: 0,
    };
    const { gross, net } = computeExcessFunds(zeroes);
    expect(gross.value).toBe(0);
    expect(net.value).toBe(0);
    expect(gross.missing).toEqual([]);
    expect(net.missing).toEqual([]);
  });
});

describe("a missing input makes the figure unavailable, never a partial sum", () => {
  // One case per term. A partial sum here is the failure this whole design
  // exists to prevent: a treasury figure quietly short by a million dollars.
  for (const term of ["netDifference", "netCrypto", "fabAndMbme", "goldSouq"] as const) {
    it(`kills both figures when ${term} is missing`, () => {
      const { gross, net } = computeExcessFunds(all({ [term]: null }));
      expect(gross.value).toBeNull();
      expect(net.value).toBeNull();
      expect(gross.missing).toContain(EXCESS_LABELS[term]);
      expect(net.missing).toContain(EXCESS_LABELS[term]);
    });
  }

  // The two FAB accounts are additions on top of gross, so losing them must
  // cost the net figure only. This is the expected state whenever the new
  // workbook is unreachable, and gross must survive it.
  for (const term of ["fabOperating", "fabHolding"] as const) {
    it(`kills only net when ${term} is missing`, () => {
      const { gross, net } = computeExcessFunds(all({ [term]: null }));
      expect(gross.value).not.toBeNull();
      expect(gross.missing).toEqual([]);
      expect(net.value).toBeNull();
      expect(net.missing).toEqual([EXCESS_LABELS[term]]);
    });
  }

  it("names every missing input, not just the first", () => {
    const { net } = computeExcessFunds(all({ fabOperating: null, fabHolding: null }));
    expect(net.missing).toEqual([EXCESS_LABELS.fabOperating, EXCESS_LABELS.fabHolding]);
  });

  it("reports nothing at all when every source failed", () => {
    const none: ExcessFundsInputs = {
      netDifference: null, netCrypto: null, fabAndMbme: null,
      goldSouq: null, fabOperating: null, fabHolding: null,
    };
    const { gross, net } = computeExcessFunds(none);
    expect(gross.value).toBeNull();
    expect(net.value).toBeNull();
    expect(net.missing).toHaveLength(6);
  });
});

describe("a non-finite input is treated as missing", () => {
  // Number("") is 0 and Number(undefined) is NaN; neither may become a figure.
  it("rejects NaN and Infinity rather than propagating them", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const { gross } = computeExcessFunds(all({ netCrypto: bad }));
      expect(gross.value).toBeNull();
      expect(gross.missing).toContain(EXCESS_LABELS.netCrypto);
    }
  });
});

describe("labels", () => {
  it("names every input in a way a reader would recognise on the card", () => {
    expect(EXCESS_LABELS).toEqual({
      netDifference: "Net LP Equity − Net Client Equity",
      netCrypto: "Net Crypto",
      fabAndMbme: "Net FAB & MBME",
      goldSouq: "Gold Souq",
      fabOperating: "FAB Operating Balance",
      fabHolding: "FAB Holding Balance",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/excessFunds.test.ts`
Expected: FAIL — `Failed to resolve import "./excessFunds"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/excessFunds.ts`:

```typescript
// Gross and Net Excess Fund, and every rule about what happens when a figure is
// missing. Pure: no fetching, no React, no formatting. Three independent sources
// feed this section and each can fail on its own, so the degradation rules are
// the substance here -- the addition is the easy part.
//
// Design: docs/superpowers/specs/2026-09-01-excess-funds-cards-design.md

export type ExcessInput = number | null;

export interface ExcessFundsInputs {
  // The BACKEND's netDifference, not a subtraction we performed. It already
  // equals lps.netWithdrawableEquity - clients.netWithdrawableEquity; computing
  // it again here would create a second answer to a question already answered.
  netDifference: ExcessInput;
  netCrypto: ExcessInput;
  fabAndMbme: ExcessInput;
  goldSouq: ExcessInput;
  fabOperating: ExcessInput;
  fabHolding: ExcessInput;
}

export interface ExcessFigure {
  value: number | null;
  // The labels of the inputs that were missing. A card shows these so the reader
  // knows which source failed rather than just that something did.
  missing: string[];
}

export interface ExcessFundsResult {
  gross: ExcessFigure;
  net: ExcessFigure;
}

export const EXCESS_LABELS: Record<keyof ExcessFundsInputs, string> = {
  netDifference: "Net LP Equity − Net Client Equity",
  netCrypto: "Net Crypto",
  fabAndMbme: "Net FAB & MBME",
  goldSouq: "Gold Souq",
  fabOperating: "FAB Operating Balance",
  fabHolding: "FAB Holding Balance",
};

export const GROSS_TERMS = [
  "netDifference",
  "netCrypto",
  "fabAndMbme",
  "goldSouq",
] as const satisfies readonly (keyof ExcessFundsInputs)[];

export const NET_EXTRA_TERMS = [
  "fabOperating",
  "fabHolding",
] as const satisfies readonly (keyof ExcessFundsInputs)[];

// A value only counts if it is a real finite number. Number("") is 0 and
// Number(undefined) is NaN, so an absent figure can otherwise arrive looking
// like a balance of zero -- which is a real balance and must stay meaningful.
function usable(value: ExcessInput): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sum(
  inputs: ExcessFundsInputs,
  terms: readonly (keyof ExcessFundsInputs)[],
): ExcessFigure {
  const missing = terms.filter((t) => !usable(inputs[t])).map((t) => EXCESS_LABELS[t]);
  if (missing.length) return { value: null, missing };
  const value = terms.reduce((total, t) => total + (inputs[t] as number), 0);
  return { value, missing: [] };
}

export function computeExcessFunds(inputs: ExcessFundsInputs): ExcessFundsResult {
  const gross = sum(inputs, GROSS_TERMS);
  // Net is gross plus the two FAB accounts, so it inherits everything gross was
  // missing. Losing only the FAB workbook costs net and leaves gross standing --
  // the expected state whenever that sheet is unreachable.
  const net = sum(inputs, [...GROSS_TERMS, ...NET_EXTRA_TERMS]);
  return { gross, net };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/excessFunds.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Prove the degradation tests can fail**

Temporarily change `sum` to skip missing terms instead of returning null:

```typescript
  const value = terms.reduce((total, t) => total + (usable(inputs[t]) ? (inputs[t] as number) : 0), 0);
  return { value, missing: [] };
```

Run: `npx vitest run src/lib/excessFunds.test.ts`
Expected: FAIL — the partial-sum tests fail. Record the count, then restore the
real implementation and confirm PASS again. A degradation test that cannot fail
is worse than none.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc -b --noEmit
git add src/lib/excessFunds.ts src/lib/excessFunds.test.ts
git commit -m "Add the Excess Funds arithmetic and its degradation rules"
```

---

## Task 2: The second Google Sheets workbook

**Files:**
- Create: `wallet/fabAccountsMappingConfig.js`, `wallet/fabAccountsSheet.js`
- Test: `wallet/fabAccountsSheet.test.js`
- Modify: `server.js`, `.env.example`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `loadFabAccountsMapping()` → `{ tab: string, cells: { fabOperating: string, fabHolding: string } }`
  - `saveFabAccountsMapping(next)`, `resetFabAccountsMapping()`
  - `parseSheetNumber(raw)` → `number | null`
  - `readFabAccounts()` → `{ fabOperating, fabHolding, fetchedAt, source }`
  - `GET /api/fab-accounts`

**Context you need:** the existing workbook is read by `wallet/pspClients.js` using
`process.env.GOOGLE_SHEETS_ID` and a service account in
`process.env.GA4_SERVICE_ACCOUNT_JSON`. **This workbook is unrelated to that one.**
Reuse the *credentials* (same service account) but nothing else — no shared client
instance, no shared config, no assumption that its tabs are date-named.

Its spreadsheet id, tab name and cell addresses are **not known yet**. Build to the
contract below; a mismatch must fail loudly naming the sheet and cell.

- [ ] **Step 1: Write the failing test**

Create `wallet/fabAccountsSheet.test.js`:

```javascript
import { describe, expect, it } from "vitest";
import { parseSheetNumber, describeSheetError } from "./fabAccountsSheet.js";
import { DEFAULT_FAB_ACCOUNTS_MAPPING } from "./fabAccountsMappingConfig.js";

describe("parseSheetNumber", () => {
  it("reads a plain number", () => expect(parseSheetNumber("1234.56")).toBe(1234.56));

  // Sheets hand back display strings, not numbers.
  it("strips currency formatting", () => {
    expect(parseSheetNumber("$1,234,567.89")).toBe(1234567.89);
    expect(parseSheetNumber("AED 12,000")).toBe(12000);
  });

  it("reads a negative in accounting parentheses", () => {
    expect(parseSheetNumber("(1,234.56)")).toBe(-1234.56);
  });

  it("reads a genuine zero as zero, not as missing", () => {
    expect(parseSheetNumber("0")).toBe(0);
    expect(parseSheetNumber("$0.00")).toBe(0);
  });

  // An empty or unreadable cell is NOT a balance of zero. Returning 0 here is
  // the exact failure this design exists to prevent.
  it("returns null for an empty or unreadable cell", () => {
    for (const bad of ["", "   ", null, undefined, "#REF!", "N/A", "-"]) {
      expect(parseSheetNumber(bad)).toBeNull();
    }
  });
});

describe("describeSheetError", () => {
  // A permission failure is the likeliest first error: the sheet exists but was
  // never shared with the service account. The message must say so and name the
  // account, or whoever reads the log has to go and find it.
  it("names the service account when access is denied", () => {
    const msg = describeSheetError(
      { code: 403, message: "The caller does not have permission" },
      { spreadsheetId: "abc123", tab: "Sheet1", account: "svc@project.iam.gserviceaccount.com" },
    );
    expect(msg).toContain("abc123");
    expect(msg).toContain("svc@project.iam.gserviceaccount.com");
    expect(msg).toMatch(/share/i);
  });

  it("names the tab when the tab is missing", () => {
    const msg = describeSheetError(
      { code: 400, message: "Unable to parse range: NoSuchTab!B4" },
      { spreadsheetId: "abc123", tab: "NoSuchTab", account: "svc@x.com" },
    );
    expect(msg).toContain("NoSuchTab");
  });

  it("never returns an empty message", () => {
    expect(describeSheetError({}, { spreadsheetId: "x", tab: "y", account: "z" })).toBeTruthy();
  });
});

describe("the default mapping", () => {
  it("declares both cells so config, not code, locates them", () => {
    expect(Object.keys(DEFAULT_FAB_ACCOUNTS_MAPPING.cells).sort())
      .toEqual(["fabHolding", "fabOperating"]);
    expect(DEFAULT_FAB_ACCOUNTS_MAPPING.tab).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run wallet/fabAccountsSheet.test.js`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Write the mapping config**

Create `wallet/fabAccountsMappingConfig.js`:

```javascript
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = path.join(__dirname, "../storage");
const CONFIG_FILE = path.join(STORAGE_DIR, "fab_accounts_mapping.json");

// Where the two balances sit in the FAB workbook. This is CONFIG, not code, and
// deliberately so: the existing wallet mapping carries three generations of cell
// addresses because someone inserting a row silently shifted every reference. A
// row inserted here is fixed by editing a JSON file, not by shipping a release.
//
// These defaults are placeholders until the real sheet is supplied. A wrong cell
// fails loudly -- readFabAccounts throws naming the sheet and cell -- rather than
// returning a plausible number from the wrong place.
export const DEFAULT_FAB_ACCOUNTS_MAPPING = {
  tab: "Sheet1",
  cells: { fabOperating: "B2", fabHolding: "B3" },
};

export function loadFabAccountsMapping() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const tab = typeof raw?.tab === "string" && raw.tab.trim() ? raw.tab.trim() : DEFAULT_FAB_ACCOUNTS_MAPPING.tab;
    const cells = { ...DEFAULT_FAB_ACCOUNTS_MAPPING.cells };
    for (const key of Object.keys(cells)) {
      const cell = raw?.cells?.[key];
      if (typeof cell === "string" && /^[A-Z]+[0-9]+$/i.test(cell.trim())) cells[key] = cell.trim().toUpperCase();
    }
    return { tab, cells };
  } catch {
    // Absent or corrupt: the defaults are as good a guess as anything, and the
    // read will fail loudly if they are wrong.
    return { tab: DEFAULT_FAB_ACCOUNTS_MAPPING.tab, cells: { ...DEFAULT_FAB_ACCOUNTS_MAPPING.cells } };
  }
}

export function saveFabAccountsMapping(next) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  const current = loadFabAccountsMapping();
  const merged = {
    tab: typeof next?.tab === "string" && next.tab.trim() ? next.tab.trim() : current.tab,
    cells: { ...current.cells },
  };
  for (const key of Object.keys(merged.cells)) {
    const cell = next?.cells?.[key];
    if (typeof cell === "string" && /^[A-Z]+[0-9]+$/i.test(cell.trim())) merged.cells[key] = cell.trim().toUpperCase();
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

export function resetFabAccountsMapping() {
  try {
    fs.unlinkSync(CONFIG_FILE);
  } catch {
    // Already absent; loadFabAccountsMapping falls back to the defaults.
  }
  return loadFabAccountsMapping();
}
```

- [ ] **Step 4: Write the sheet client**

Create `wallet/fabAccountsSheet.js`:

```javascript
import { google } from "googleapis";
import { loadFabAccountsMapping } from "./fabAccountsMappingConfig.js";

// The FAB Operating and Holding balances, from a workbook that has NOTHING to do
// with the wallet workbook read by pspClients.js. Separate spreadsheet, separate
// id, separate client, separate failure path -- a layout change in one must not
// be able to break the other's read.
//
// The service account is shared, because it is the same Google identity; nothing
// else is.
//
// Design: docs/superpowers/specs/2026-09-01-excess-funds-cards-design.md

let cachedService = null;

function getService() {
  if (cachedService) return cachedService;
  const raw = process.env.GA4_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GA4_SERVICE_ACCOUNT_JSON not configured");
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  cachedService = { sheets: google.sheets({ version: "v4", auth }), account: credentials.client_email || "unknown" };
  return cachedService;
}

// Sheets returns display strings. An empty or unreadable cell is NOT zero -- zero
// is a real balance, and conflating the two is how a treasury figure silently
// loses a term.
export function parseSheetNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (/^[-–—]$/.test(text)) return null;
  if (/^(#|N\/A$)/i.test(text)) return null;
  const negative = /^\(.*\)$/.test(text);
  const digits = text.replace(/[()]/g, "").replace(/[^0-9.-]/g, "");
  if (!/[0-9]/.test(digits)) return null;
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return negative ? -Math.abs(value) : value;
}

// The likeliest first failure is that the sheet was never shared with the service
// account. Saying so, and naming the account, saves whoever reads the log from
// having to dig the address out of the credentials JSON.
export function describeSheetError(error, { spreadsheetId, tab, account }) {
  const base = `FAB accounts sheet ${spreadsheetId} (tab "${tab}")`;
  const code = Number(error?.code);
  if (code === 403) {
    return `${base}: access denied. Share the sheet with ${account} as a Viewer.`;
  }
  if (code === 404) {
    return `${base}: not found. Check FAB_ACCOUNTS_SHEET_ID.`;
  }
  const message = String(error?.message || "unknown error");
  if (/unable to parse range/i.test(message)) {
    return `${base}: tab "${tab}" does not exist in that spreadsheet. ${message}`;
  }
  return `${base}: ${message} (service account ${account})`;
}

export async function readFabAccounts() {
  const spreadsheetId = String(process.env.FAB_ACCOUNTS_SHEET_ID || "").trim();
  if (!spreadsheetId) throw new Error("FAB_ACCOUNTS_SHEET_ID not configured");

  const { tab, cells } = loadFabAccountsMapping();
  const { sheets, account } = getService();
  const ranges = [`${tab}!${cells.fabOperating}`, `${tab}!${cells.fabHolding}`];

  let response;
  try {
    response = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges });
  } catch (error) {
    throw new Error(describeSheetError(error, { spreadsheetId, tab, account }));
  }

  const valueRanges = response?.data?.valueRanges || [];
  const cellAt = (index) => valueRanges[index]?.values?.[0]?.[0];
  const fabOperating = parseSheetNumber(cellAt(0));
  const fabHolding = parseSheetNumber(cellAt(1));

  // An unreadable cell is reported as null and named. It is never zero: the page
  // shows "unavailable" for a null and a real figure for a zero.
  return {
    fabOperating,
    fabHolding,
    fetchedAt: new Date().toISOString(),
    source: { spreadsheetId, tab, cells },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run wallet/fabAccountsSheet.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 6: Add the route**

In `server.js`, beside the other wallet routes (near `/api/wallet/google-sheets-debug`, around line 600), add the import at the top with the other `wallet/` imports:

```javascript
import { readFabAccounts } from './wallet/fabAccountsSheet.js';
```

and the route:

```javascript
// FAB Operating and Holding balances, for the Excess Funds section. Its own
// workbook, so its own route -- a failure here must not take the closing-balance
// report down with it, and vice versa.
app.get('/api/fab-accounts', authRequired, async (_req, res) => {
  try {
    res.json({ ok: true, ...(await readFabAccounts()) });
  } catch (e) {
    // 502, not 500: the sheet is an upstream dependency, and the message names
    // the spreadsheet, tab and service account so the cause is actionable.
    res.status(502).json({ ok: false, error: 'fab_sheet_unavailable', message: e?.message || String(e) });
  }
});
```

- [ ] **Step 7: Verify the auth gate still covers every route**

Run: `npx vitest run auth/routeCoverage.test.js`
Expected: PASS. This project denies API access by default; a route the gate does
not know about is unreachable. If it fails, register the route with the gate —
read `auth/requireSession.js` — rather than weakening the test.

- [ ] **Step 8: Document the configuration**

In `.env.example`, after the existing Google Sheets settings:

```
# FAB Operating / Holding balances for the Excess Funds cards.
# A SEPARATE workbook from GOOGLE_SHEETS_ID -- unrelated sheet, unrelated layout.
# It is read with the same service account (GA4_SERVICE_ACCOUNT_JSON), so the
# sheet must be shared with that account's client_email as a Viewer or the read
# fails with a 403 naming the address.
# The tab and the two cell addresses live in storage/fab_accounts_mapping.json,
# so a row inserted in the sheet is fixed by editing config, not by deploying.
# FAB_ACCOUNTS_SHEET_ID=
```

- [ ] **Step 9: Full verification and commit**

```bash
npx vitest run
node --check server.js
git add wallet/fabAccountsMappingConfig.js wallet/fabAccountsSheet.js wallet/fabAccountsSheet.test.js server.js .env.example
git commit -m "Read FAB Operating and Holding from their own workbook"
```

---

## Task 3: Fetching the FAB balances from the browser

**Files:**
- Create: `src/lib/excessFundsApi.ts`
- Test: `src/lib/excessFundsApi.test.ts`

**Interfaces:**
- Consumes: `GET /api/fab-accounts` from Task 2.
- Produces:
  ```ts
  export interface FabAccounts {
    fabOperating: number | null;
    fabHolding: number | null;
    fetchedAt: string;
    source: { spreadsheetId: string; tab: string; cells: Record<string, string> };
  }
  export function unwrapFabAccounts(payload: unknown): FabAccounts;
  export function fetchFabAccounts(): Promise<FabAccounts>;
  ```

**Why this throws rather than returning a default:** the Revenue Share page was
built against a wrongly-assumed response shape and rendered an empty table with no
error at all. `src/lib/revenueShareApi.ts` is the pattern to copy — unwrap through
a function that throws naming the endpoint and the keys actually present.

Note the route is behind the deny-by-default gate, so the fetch must send
`authHeaders()` from `@/lib/auth`, exactly as `src/lib/walletApi.ts` does.

- [ ] **Step 1: Write the failing test**

Create `src/lib/excessFundsApi.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { unwrapFabAccounts } from "./excessFundsApi";

const ok = {
  ok: true,
  fabOperating: 1234567.89,
  fabHolding: 987654.32,
  fetchedAt: "2026-09-01T06:00:00Z",
  source: { spreadsheetId: "abc", tab: "Sheet1", cells: { fabOperating: "B2", fabHolding: "B3" } },
};

describe("unwrapFabAccounts", () => {
  it("returns both balances and the source that produced them", () => {
    const out = unwrapFabAccounts(ok);
    expect(out.fabOperating).toBe(1234567.89);
    expect(out.fabHolding).toBe(987654.32);
    expect(out.source.tab).toBe("Sheet1");
  });

  // A cell the server could not read arrives as null and stays null. It is not a
  // balance of zero, and the card must say unavailable rather than show 0.00.
  it("passes a null balance through untouched", () => {
    const out = unwrapFabAccounts({ ...ok, fabOperating: null });
    expect(out.fabOperating).toBeNull();
    expect(out.fabHolding).toBe(987654.32);
  });

  it("keeps a genuine zero as zero", () => {
    expect(unwrapFabAccounts({ ...ok, fabHolding: 0 }).fabHolding).toBe(0);
  });

  // The failure the Revenue Share page had: a wrong shape rendered as empty with
  // no error. Every rejection below must name the endpoint and what arrived.
  it("throws naming the endpoint and the keys present when a balance key is absent", () => {
    const { fabOperating, ...missing } = ok;
    expect(() => unwrapFabAccounts(missing)).toThrow(/\/api\/fab-accounts/);
    expect(() => unwrapFabAccounts(missing)).toThrow(/fabOperating/);
    expect(() => unwrapFabAccounts(missing)).toThrow(/fabHolding/);
  });

  it("throws when a balance is a non-numeric, non-null value", () => {
    expect(() => unwrapFabAccounts({ ...ok, fabHolding: "987654.32" })).toThrow(/fabHolding/);
    expect(() => unwrapFabAccounts({ ...ok, fabHolding: Number.NaN })).toThrow(/fabHolding/);
  });

  it("throws on a bare array, on null, and on an error envelope", () => {
    expect(() => unwrapFabAccounts([])).toThrow(/\/api\/fab-accounts/);
    expect(() => unwrapFabAccounts(null)).toThrow(/\/api\/fab-accounts/);
    expect(() => unwrapFabAccounts({ ok: false, error: "fab_sheet_unavailable" }))
      .toThrow(/fab_sheet_unavailable/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/excessFundsApi.test.ts`
Expected: FAIL — `Failed to resolve import "./excessFundsApi"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/excessFundsApi.ts`:

```typescript
import { authHeaders } from "@/lib/auth";

// The FAB workbook's two balances. Unwrapped through a function that THROWS
// naming the endpoint and what arrived, because the Revenue Share page was built
// against a wrongly-assumed shape and rendered an empty table with no error at
// all. A loud failure on deploy day beats a silent blank.
//
// This sheet does not exist yet, so the shape below is a contract, not an
// observation. Expect to correct it the first time the real sheet is connected.

const ENDPOINT = "/api/fab-accounts";

export interface FabAccounts {
  fabOperating: number | null;
  fabHolding: number | null;
  fetchedAt: string;
  source: { spreadsheetId: string; tab: string; cells: Record<string, string> };
}

function describeShape(payload: unknown): string {
  if (payload === null || payload === undefined) return String(payload);
  if (Array.isArray(payload)) return `array of ${payload.length}`;
  if (typeof payload !== "object") return typeof payload;
  const keys = Object.keys(payload as object);
  return keys.length ? `object with keys: ${keys.join(", ")}` : "object with no keys";
}

// null means the server read the cell and could not make a number of it. A number
// is a balance, zero included. Anything else is a contract breach.
function balance(payload: Record<string, unknown>, key: keyof FabAccounts): number | null {
  const raw = payload[key];
  if (raw === null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  throw new Error(
    `${ENDPOINT} returned an unusable ${key}: ${JSON.stringify(raw)}. Expected a finite number or null. Received ${describeShape(payload)}.`,
  );
}

export function unwrapFabAccounts(payload: unknown): FabAccounts {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${ENDPOINT} returned ${describeShape(payload)}; expected an object.`);
  }
  const obj = payload as Record<string, unknown>;
  if (obj.ok === false) {
    throw new Error(`${ENDPOINT} reported a failure: ${String(obj.error || "unknown")} ${String(obj.message || "")}`.trim());
  }
  if (!("fabOperating" in obj) || !("fabHolding" in obj)) {
    throw new Error(
      `${ENDPOINT} is missing fabOperating and/or fabHolding. Received ${describeShape(payload)}.`,
    );
  }
  const source = (obj.source || {}) as FabAccounts["source"];
  return {
    fabOperating: balance(obj, "fabOperating"),
    fabHolding: balance(obj, "fabHolding"),
    fetchedAt: String(obj.fetchedAt || ""),
    source: {
      spreadsheetId: String(source.spreadsheetId || ""),
      tab: String(source.tab || ""),
      cells: (source.cells || {}) as Record<string, string>,
    },
  };
}

export async function fetchFabAccounts(): Promise<FabAccounts> {
  const response = await fetch(`${ENDPOINT}?_ts=${Date.now()}`, {
    cache: "no-store",
    headers: { "cache-control": "no-cache", ...authHeaders() },
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // A 200 carrying an SPA fallback page surfaces as "Unexpected token '<'"
    // without this, and never names the endpoint.
    throw new Error(`${ENDPOINT} returned HTTP ${response.status} with a body that is not JSON.`);
  }
  return unwrapFabAccounts(payload);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/excessFundsApi.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc -b --noEmit
git add src/lib/excessFundsApi.ts src/lib/excessFundsApi.test.ts
git commit -m "Fetch the FAB balances, failing loudly on an unexpected shape"
```

---

## Task 4: The nine cards

**Files:**
- Create: `src/components/dashboard/ExcessFundsSection.tsx`
- Test: `src/components/dashboard/ExcessFundsSection.test.tsx`

**Interfaces:**
- Consumes: `computeExcessFunds`, `EXCESS_LABELS`, `ExcessFundsInputs` (Task 1).
- Produces:
  ```ts
  export interface ExcessFundsSectionProps {
    inputs: ExcessFundsInputs;
    lpEquity: number | null;
    clientEquity: number | null;
  }
  export function ExcessFundsSection(props: ExcessFundsSectionProps): JSX.Element;
  ```

`lpEquity` and `clientEquity` are **display only** — the arithmetic uses
`inputs.netDifference`. They are passed separately because the note asks for them
as their own cards.

Check whether this repo already has React render tests (`git ls-files '*.test.tsx'`).
If `@testing-library/react` is not a dependency, do **not** add it: write the tests
against a pure `excessFundsCards(props)` helper exported from the same file that
returns the card descriptors (`{ label, value, tone, note }[]`), and render from
that. Say in your report which route you took.

- [ ] **Step 1: Write the failing test**

Create `src/components/dashboard/ExcessFundsSection.test.tsx`:

```typescript
import { describe, expect, it } from "vitest";
import { excessFundsCards } from "./ExcessFundsSection";
import type { ExcessFundsInputs } from "@/lib/excessFunds";

const INPUTS: ExcessFundsInputs = {
  netDifference: -1190369.63,
  netCrypto: 500000,
  fabAndMbme: 250000,
  goldSouq: 100000,
  fabOperating: 300000,
  fabHolding: 200000,
};

const cards = (over: Partial<ExcessFundsInputs> = {}, lp: number | null = 3275567.91, cl: number | null = 4465937.54) =>
  excessFundsCards({ inputs: { ...INPUTS, ...over }, lpEquity: lp, clientEquity: cl });

const byLabel = (list: ReturnType<typeof excessFundsCards>, label: string) =>
  list.find((c) => c.label === label);

describe("the nine cards", () => {
  it("renders exactly nine, in the order of the note", () => {
    expect(cards().map((c) => c.label)).toEqual([
      "Net LP Equity",
      "Net Client Equity",
      "Net Crypto",
      "Net FAB & MBME",
      "Gold Souq",
      "FAB Operating Balance",
      "FAB Holding Balance",
      "Gross Excess Fund",
      "Net Excess Fund",
    ]);
  });

  it("formats money to two decimals with a thousands separator", () => {
    expect(byLabel(cards(), "Net LP Equity")?.value).toBe("$3,275,567.91");
  });

  it("shows the two results", () => {
    // -1,190,369.63 + 500,000 + 250,000 + 100,000 = -340,369.63
    expect(byLabel(cards(), "Gross Excess Fund")?.value).toBe("-$340,369.63");
    // and the two FAB accounts carry it back over zero: -340,369.63 + 500,000
    expect(byLabel(cards(), "Net Excess Fund")?.value).toBe("$159,630.37");
  });

  // Gross negative and net positive from the same inputs is the realistic case
  // today, and the two tones must differ accordingly.
  it("tones the two results independently", () => {
    expect(byLabel(cards(), "Gross Excess Fund")?.tone).toBe("negative");
    expect(byLabel(cards(), "Net Excess Fund")?.tone).toBe("positive");
  });

  // netDifference is negative today, so a negative result is the normal case and
  // must read as one rather than being clamped or relabelled.
  it("tones a negative result as negative", () => {
    expect(byLabel(cards(), "Gross Excess Fund")?.tone).toBe("negative");
  });

  it("tones a positive result as positive", () => {
    expect(byLabel(cards({ netCrypto: 5000000 }), "Gross Excess Fund")?.tone).toBe("positive");
  });
});

describe("unavailable is not zero", () => {
  it("shows a dash and names the missing source on a result that cannot be computed", () => {
    const list = cards({ fabOperating: null });
    const net = byLabel(list, "Net Excess Fund");
    expect(net?.value).toBe("—");
    expect(net?.note).toContain("FAB Operating Balance");
    // Gross does not need it, so gross survives.
    expect(byLabel(list, "Gross Excess Fund")?.value).not.toBe("—");
  });

  it("shows a dash on an input card whose own source failed", () => {
    expect(byLabel(cards({ goldSouq: null }), "Gold Souq")?.value).toBe("—");
  });

  it("shows a dash for equity when the equity call failed", () => {
    const list = cards({}, null, null);
    expect(byLabel(list, "Net LP Equity")?.value).toBe("—");
    expect(byLabel(list, "Net Client Equity")?.value).toBe("—");
  });

  it("renders a genuine zero as money, never as a dash", () => {
    expect(byLabel(cards({ goldSouq: 0 }), "Gold Souq")?.value).toBe("$0.00");
  });
});

describe("the results say what they include", () => {
  // The page already carries lpPlusPspDifference, which also reads as "spare
  // cash" and will give a different number. Both stay, so both must say what
  // they count or neither can be trusted.
  it("notes the scope of Gross Excess Fund", () => {
    const note = byLabel(cards(), "Gross Excess Fund")?.note ?? "";
    expect(note).toMatch(/crypto/i);
    expect(note).toMatch(/gold souq/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/dashboard/ExcessFundsSection.test.tsx`
Expected: FAIL — `Failed to resolve import "./ExcessFundsSection"`.

- [ ] **Step 3: Write the implementation**

Create `src/components/dashboard/ExcessFundsSection.tsx`:

```tsx
import { computeExcessFunds, type ExcessFundsInputs } from "@/lib/excessFunds";

// The Excess Funds section: seven inputs and the two figures they produce.
//
// Its own component rather than a tenth of AccountsDepartment.tsx, which is
// already 964 lines.
//
// Design: docs/superpowers/specs/2026-09-01-excess-funds-cards-design.md

export interface ExcessFundsSectionProps {
  inputs: ExcessFundsInputs;
  // Display only. The arithmetic uses inputs.netDifference, which is the
  // backend's own field -- subtracting these two here would create a second
  // answer to a question already answered upstream.
  lpEquity: number | null;
  clientEquity: number | null;
}

export interface ExcessCard {
  label: string;
  value: string;
  tone: "positive" | "negative" | "neutral";
  note?: string;
  emphasis?: boolean;
}

const DASH = "—";

function money(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  const text = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value < 0 ? `-$${text}` : `$${text}`;
}

function tone(value: number | null): ExcessCard["tone"] {
  if (value === null || !Number.isFinite(value)) return "neutral";
  return value < 0 ? "negative" : "positive";
}

export function excessFundsCards({ inputs, lpEquity, clientEquity }: ExcessFundsSectionProps): ExcessCard[] {
  const { gross, net } = computeExcessFunds(inputs);
  const unavailable = (missing: string[]) => `Unavailable — could not read ${missing.join(", ")}.`;

  return [
    { label: "Net LP Equity", value: money(lpEquity), tone: tone(lpEquity) },
    { label: "Net Client Equity", value: money(clientEquity), tone: tone(clientEquity) },
    { label: "Net Crypto", value: money(inputs.netCrypto), tone: tone(inputs.netCrypto) },
    { label: "Net FAB & MBME", value: money(inputs.fabAndMbme), tone: tone(inputs.fabAndMbme) },
    { label: "Gold Souq", value: money(inputs.goldSouq), tone: tone(inputs.goldSouq) },
    { label: "FAB Operating Balance", value: money(inputs.fabOperating), tone: tone(inputs.fabOperating) },
    { label: "FAB Holding Balance", value: money(inputs.fabHolding), tone: tone(inputs.fabHolding) },
    {
      label: "Gross Excess Fund",
      value: money(gross.value),
      tone: tone(gross.value),
      emphasis: true,
      // Says what it counts because the page also carries "Equity Difference +
      // PSPs", which counts every PSP plus receivables and will disagree.
      note: gross.missing.length
        ? unavailable(gross.missing)
        : "LP less client equity, plus crypto, FAB & MBME and Gold Souq only",
    },
    {
      label: "Net Excess Fund",
      value: money(net.value),
      tone: tone(net.value),
      emphasis: true,
      note: net.missing.length ? unavailable(net.missing) : "Gross Excess Fund plus both FAB accounts",
    },
  ];
}

export function ExcessFundsSection(props: ExcessFundsSectionProps) {
  const cards = excessFundsCards(props);
  const toneClass = (t: ExcessCard["tone"]) =>
    t === "negative" ? "text-destructive" : t === "positive" ? "text-success" : "text-muted-foreground";

  return (
    <div className="pt-2 border-t border-border/30">
      <div className="text-xs font-semibold text-foreground mb-2">Excess Funds</div>
      <div className="grid grid-cols-2 gap-1.5">
        {cards.map((card) => (
          <div
            key={card.label}
            className={`p-2 rounded-md border ${card.emphasis ? "bg-primary/10 border-primary/20 col-span-2" : "bg-muted/30 border-border/30"}`}
          >
            <div className="text-[10px] text-muted-foreground mb-0.5">{card.label}</div>
            <div className={`font-mono font-semibold text-sm ${toneClass(card.tone)}`}>{card.value}</div>
            {card.note ? <div className="text-[10px] text-muted-foreground mt-0.5">{card.note}</div> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/dashboard/ExcessFundsSection.test.tsx`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc -b --noEmit
git add src/components/dashboard/ExcessFundsSection.tsx src/components/dashboard/ExcessFundsSection.test.tsx
git commit -m "Add the Excess Funds cards"
```

---

## Task 5: Mount it on the Accounts page

**Files:**
- Modify: `src/components/dashboard/AccountsDepartment.tsx`
- Test: `src/components/dashboard/excessFundsWiring.test.ts` (create)

**Interfaces:**
- Consumes: `ExcessFundsSection`, `excessFundsCards` (Task 4); `fetchFabAccounts` (Task 3); `ExcessFundsInputs` (Task 1).
- Produces: nothing later tasks depend on.

**The trap this task exists to avoid.** `walletMonitor` returns
`balance: 0, status: 'error'` for a PSP whose check failed, and
`AccountsDepartment.tsx:374` maps that to `balance: 0`. So the existing
`pspBalances` array **cannot distinguish a real zero from a failed read**. If this
section derives its inputs from `pspBalances`, a dead crypto provider silently
subtracts its balance from the treasury figure with no warning.

Derive the inputs from the **raw widgets** instead, mapping `status === 'error'`
to `null`.

- [ ] **Step 1: Write the failing test**

Create `src/components/dashboard/excessFundsWiring.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync("src/components/dashboard/AccountsDepartment.tsx", "utf8");

// A source-scanning tripwire. The wiring itself needs a live component and three
// live endpoints to exercise, but the two ways it can be wired WRONGLY are both
// visible in the text.
describe("the Excess Funds inputs are not taken from the coerced balances", () => {
  it("mounts the section", () => {
    expect(SOURCE).toMatch(/<ExcessFundsSection/);
  });

  // pspBalances has already had status:'error' flattened to 0 at line ~374.
  // Building the treasury inputs from it would silently drop a dead provider's
  // balance instead of reporting the figure as unavailable.
  it("does not build the excess inputs from pspBalances", () => {
    const wiring = SOURCE.slice(SOURCE.indexOf("excessInputs"));
    expect(wiring).not.toMatch(/excessInputs[\s\S]{0,400}pspBalances/);
  });

  it("reads the raw widget status so a failed source becomes null", () => {
    expect(SOURCE).toMatch(/status\s*===\s*['"]error['"]\s*\?\s*null/);
  });

  // lpEquitySummary initialises to zeroes, so using its value without checking
  // that the fetch succeeded turns a dead equity endpoint into a confident
  // netDifference of 0.00 -- the same class of bug as the widget status one.
  it("guards netDifference on whether the equity fetch succeeded", () => {
    expect(SOURCE).toMatch(/netDifference:\s*equityLoaded\s*\?/);
  });

  // The equity call is gated behind isLpMode today, so the Accounts page never
  // makes it. Without this, netDifference is permanently null here.
  it("no longer gates the equity fetch to LP mode only", () => {
    expect(SOURCE).not.toMatch(/if\s*\(\s*!isLpMode\s*\)\s*return;[\s\S]{0,200}fetchLpEquitySummary/);
  });
});

describe("the existing figure keeps its own scope note", () => {
  // Both lpPlusPspDifference and Gross Excess Fund read as "spare cash" and give
  // different answers. Both stay, so both must say what they count.
  it("labels what lpPlusPspDifference includes", () => {
    const idx = SOURCE.indexOf("lpPlusPspDifference");
    expect(idx).toBeGreaterThan(-1);
    expect(SOURCE.slice(idx)).toMatch(/all PSPs|every PSP/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/dashboard/excessFundsWiring.test.ts`
Expected: FAIL — the section is not mounted and the status mapping does not exist.

- [ ] **Step 3: Keep the raw widgets**

In `AccountsDepartment.tsx`, inside `fetchWalletData` (around line 366), add a
state setter alongside the existing `setPspBalances(mapped)`:

```typescript
  // The raw widgets, before status:'error' is flattened to a balance of 0 for
  // display. The Excess Funds figures need to tell a real zero from a failed
  // read; pspBalances cannot, by design, because a zero row still has to render.
  setWalletWidgets(widgets);
```

and declare the state near the other `useState` calls (around line 269):

```typescript
  const [walletWidgets, setWalletWidgets] = useState<WalletWidgetEntry[]>([]);
  const [fabAccounts, setFabAccounts] = useState<FabAccounts | null>(null);
```

Import the types and functions at the top of the file:

```typescript
import type { WalletWidgetEntry } from '@/lib/walletApi';
import { fetchFabAccounts, type FabAccounts } from '@/lib/excessFundsApi';
import { ExcessFundsSection } from './ExcessFundsSection';
import type { ExcessFundsInputs } from '@/lib/excessFunds';
```

- [ ] **Step 4: Un-gate the equity fetch and fetch the FAB balances**

Find the effect that calls `fetchLpEquitySummary` and remove the `isLpMode`
condition guarding it so the Accounts page makes the call too. Add the FAB fetch
in the same effect:

```typescript
    const fetchFab = async () => {
      try {
        setFabAccounts(await fetchFabAccounts());
      } catch (error) {
        // Its own catch: the FAB workbook is a separate dependency and its
        // absence must cost the Net Excess Fund card, not the page.
        console.warn('[ExcessFunds] FAB accounts unavailable:', (error as Error)?.message || error);
        setFabAccounts(null);
      }
    };
    void fetchFab();
```

- [ ] **Step 5: Derive the inputs and mount the section**

Near `lpPlusPspDifference` (around line 591):

```typescript
  // Built from the RAW widgets, not from pspBalances: that array has already had
  // status:'error' flattened to a balance of 0 so the row can still render, and a
  // treasury figure must never treat a failed read as a zero balance.
  const widgetValue = (id: string): number | null => {
    const entry = walletWidgets.find((w) => w.id === id);
    if (!entry) return null;
    return entry.status === 'error' ? null : Number(entry.balance ?? Number.NaN);
  };

  const addOrNull = (...values: (number | null)[]): number | null =>
    values.some((v) => v === null || !Number.isFinite(v as number))
      ? null
      : values.reduce((total: number, v) => total + (v as number), 0);

  const cryptoKeys = PSP_ORDER.filter((p) => p.group === 'crypto').map((p) => p.key);

  const excessInputs: ExcessFundsInputs = {
    // equityLoaded, not the value itself: lpEquitySummary initialises to zeroes,
    // so a failed equity fetch would otherwise present as a real netDifference
    // of 0.00 and produce a confident, wrong treasury figure.
    netDifference: equityLoaded ? lpEquitySummary.difference : null,
    netCrypto: addOrNull(...cryptoKeys.map(widgetValue)),
    fabAndMbme: addOrNull(widgetValue('googlesheets_fab'), widgetValue('googlesheets_mbme')),
    goldSouq: widgetValue('googlesheets_goldsouq'),
    fabOperating: fabAccounts ? fabAccounts.fabOperating : null,
    fabHolding: fabAccounts ? fabAccounts.fabHolding : null,
  };
```

`equityLoaded` is new state you add in this step. Declare it beside the others:

```typescript
  const [equityLoaded, setEquityLoaded] = useState(false);
```

set it in `fetchLpEquitySummary`'s success path, immediately after
`setLpEquitySummary({...})`:

```typescript
        setEquityLoaded(true);
```

and leave it `false` in that function's existing `catch`. Do not set it to `false`
on a later failure — a stale-but-real figure is more useful than a dash, and the
card's timestamp already tells the reader how fresh the page is.

Then mount the section in the non-LP branch, after the receivables block:

```tsx
      {!isLpMode && (
        <ExcessFundsSection
          inputs={excessInputs}
          lpEquity={equityLoaded ? lpEquitySummary.lpWithdrawableEquity : null}
          clientEquity={equityLoaded ? lpEquitySummary.clientWithdrawableEquity : null}
        />
      )}
```

- [ ] **Step 6: Note the scope of the existing figure**

The tile rendering `lpPlusPspDifference` (around line 671) gains a note, because
Gross Excess Fund now sits on the same page answering a similar question with a
different number:

```tsx
              <div className="text-[10px] text-muted-foreground mt-0.5">
                Counts every PSP, plus receivables and to-LP amounts
              </div>
```

Do not change its value or its existing label.

- [ ] **Step 7: Run the tests**

```bash
npx vitest run src/components/dashboard/excessFundsWiring.test.ts
npx vitest run
npx tsc -b --noEmit
```

Expected: all pass.

- [ ] **Step 8: Prove the tripwire can fail**

Temporarily change `widgetValue` to return `Number(entry.balance ?? 0)` with no
status check. Run `npx vitest run src/components/dashboard/excessFundsWiring.test.ts`
and confirm the status test fails. Restore and confirm it passes. Report both
outputs.

- [ ] **Step 9: Commit**

```bash
git add src/components/dashboard/AccountsDepartment.tsx src/components/dashboard/excessFundsWiring.test.ts
git commit -m "Mount the Excess Funds section on the Accounts page"
```

---

## Verification before merge

- [ ] `npx vitest run` — all green
- [ ] `npx tsc -b --noEmit` — clean
- [ ] `node --check server.js` — parses
- [ ] `npx vitest run auth/routeCoverage.test.js` — the new route is known to the gate
- [ ] No existing tile's value changed: `git diff main -- src/components/dashboard/AccountsDepartment.tsx` shows no edit to the `lpPlusPspDifference` expression itself
- [ ] With the FAB sheet unconfigured (`FAB_ACCOUNTS_SHEET_ID` unset), the page still renders, Gross Excess Fund shows a number, and Net Excess Fund shows "Unavailable — could not read FAB Operating Balance, FAB Holding Balance"

**What this cannot verify:** the FAB workbook does not exist yet. No cell address,
tab name or spreadsheet id in this plan has been confirmed against a real sheet.
Budget a correction pass for the day it is connected.

## What the operator must supply

1. `FAB_ACCOUNTS_SHEET_ID` in the server `.env` — the id from the sheet's URL.
2. The sheet **shared as Viewer** with the service account in
   `GA4_SERVICE_ACCOUNT_JSON` (its `client_email`). A 403 from this route names
   that address.
3. The tab name and the two cell addresses, in
   `storage/fab_accounts_mapping.json`:
   ```json
   { "tab": "Sheet1", "cells": { "fabOperating": "B2", "fabHolding": "B3" } }
   ```
