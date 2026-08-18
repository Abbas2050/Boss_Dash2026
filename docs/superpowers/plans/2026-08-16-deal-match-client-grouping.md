# Deal Match Client Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Deal Match Client Revenue Table show one row per CRM client instead of one per MT5 account, and report the IB column as commission withdrawn during the week rather than the IB wallet balance.

**Architecture:** Three units added to `reports/dealMatchWeeklyReport.js`. `resolveClientIds()` maps MT5 logins to CRM users over the network. `groupRowsByClient()` folds the per-login revenue rows into per-client rows with no I/O at all, so it is trivially testable. `attachRebateWithdrawn()` does one IB lookup per client. The email then renders the grouped rows. The existing lots-proportional split is deleted, because grouping removes the need for it.

**Tech Stack:** Node 20+ ESM, vitest (already configured; backend tests live beside their module as `*.test.js`, e.g. `alerts/alarmConfig.test.js`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-16-deal-match-client-grouping-design.md`. Read it before starting.
- Only `reports/dealMatchWeeklyReport.js` and its new test file change. Do not touch the Slippage report, the Business Summary, or `reportShared.js`.
- The IB column is named **Rebate Withdrawn**, never "IB Commission".
- Rebate counts only approved `ib transfer to account` and `ib withdrawal` settled inside the reporting week. The IB wallet balance is never included.
- A failed lookup records `0` and must be counted for the footer. A zero must never pass silently as a real figure.
- Email CSS: no `@media`, no `overscroll-behavior`, no `touch-action`, no `min-width` on tables. Zoho strips all of those.
- Run tests with `npx vitest run reports/dealMatchClientGrouping.test.js --reporter=basic`.
- The test file MUST begin with `// @vitest-environment node`. The project's vitest config defaults to jsdom, which lacks `AbortSignal.timeout`; without the directive the CRM helpers throw before reaching `fetch` and the tests fail for reasons unrelated to the code.

---

### Task 1: Group revenue rows by CRM client

Pure function, no network. Folds the per-login rows from `deriveClientRevenueRows()` into one row per CRM client.

**Files:**
- Modify: `reports/dealMatchWeeklyReport.js` (add `groupRowsByClient`, exported)
- Test: `reports/dealMatchClientGrouping.test.js` (create)

**Interfaces:**
- Consumes: rows shaped `{ login, name, lots, markup, clientComm, lpComm, totalRev }` as produced by the existing `deriveClientRevenueRows()`.
- Produces: `groupRowsByClient(rows, userIdByLogin)` returning an array of
  `{ clientKey: string, userId: number|null, name: string, accounts: string[], lots: number, markup: number, clientComm: number, lpComm: number, totalRev: number, rebateWithdrawn: number, netRev: number }`
  sorted by `lots` descending. `userIdByLogin` is a `Map<string, number|null>`.
  Task 2 sets `rebateWithdrawn`; Task 3 computes `netRev`.

- [ ] **Step 1: Write the failing test**

Create `reports/dealMatchClientGrouping.test.js`:

```javascript
// @vitest-environment node
//
// THIS DIRECTIVE IS REQUIRED AND MUST BE THE FIRST LINE. The project's vitest
// config defaults to jsdom, where AbortSignal.timeout does not exist -- the CRM
// helper throws before it ever reaches fetch, and every Task 2 test fails for a
// reason that has nothing to do with the code. Verified: under jsdom the stub
// fetch is never called; under node it is.
import { describe, it, expect } from "vitest";

// CRM_API_TOKEN is captured when the module first loads, so the environment has
// to be set BEFORE the import. A static import would be hoisted above this line
// and the token would be empty, sending Task 2's functions down their no-token
// path. Hence the dynamic import.
process.env.API_TOKEN = "stub";
const mod = await import("./dealMatchWeeklyReport.js");
const { groupRowsByClient } = mod;

// Shaped like clientRevenueSummaries[]: one entry per MT5 account.
const ROWS = [
  { login: "102244", name: "Dawei Huang", lots: 1.94, markup: 467.5, clientComm: 0, lpComm: 6.3, totalRev: 461.2 },
  { login: "102233", name: "Dawei Huang", lots: 1.92, markup: 528, clientComm: 0, lpComm: 6.2, totalRev: 521.8 },
  { login: "101499", name: "Gaurav Sharma", lots: 5, markup: 100, clientComm: 10, lpComm: 4, totalRev: 106 },
  { login: "109999", name: "No CRM Record", lots: 0.5, markup: 20, clientComm: 0, lpComm: 1, totalRev: 19 },
];
const IDS = new Map([
  ["102244", 9001],
  ["102233", 9001],
  ["101499", 9002],
  ["109999", null],
]);

describe("groupRowsByClient", () => {
  it("merges a client's accounts into one row", () => {
    const out = groupRowsByClient(ROWS, IDS);
    const dawei = out.find((r) => r.userId === 9001);
    expect(dawei.accounts).toEqual(["102233", "102244"]);
    expect(dawei.lots).toBeCloseTo(3.86, 10);
    expect(dawei.markup).toBeCloseTo(995.5, 10);
    expect(dawei.lpComm).toBeCloseTo(12.5, 10);
    expect(dawei.totalRev).toBeCloseTo(983, 10);
  });

  it("keeps a login with no CRM user as its own row", () => {
    const out = groupRowsByClient(ROWS, IDS);
    const orphan = out.find((r) => r.clientKey === "login:109999");
    expect(orphan.userId).toBeNull();
    expect(orphan.accounts).toEqual(["109999"]);
    expect(orphan.lots).toBeCloseTo(0.5, 10);
  });

  it("names the client from its largest account", () => {
    const mixed = [
      { login: "1", name: "", lots: 1, markup: 0, clientComm: 0, lpComm: 0, totalRev: 0 },
      { login: "2", name: "Real Name", lots: 9, markup: 0, clientComm: 0, lpComm: 0, totalRev: 0 },
    ];
    const out = groupRowsByClient(mixed, new Map([["1", 5], ["2", 5]]));
    expect(out[0].name).toBe("Real Name");
  });

  it("sorts by lots descending and preserves totals", () => {
    const out = groupRowsByClient(ROWS, IDS);
    expect(out.map((r) => r.clientKey)).toEqual(["user:9002", "user:9001", "login:109999"]);
    const sum = (k) => out.reduce((s, r) => s + r[k], 0);
    expect(sum("lots")).toBeCloseTo(9.36, 10);
    expect(sum("totalRev")).toBeCloseTo(1108, 10);
  });

  it("starts rebate and net at zero for later tasks to fill", () => {
    const out = groupRowsByClient(ROWS, IDS);
    expect(out.every((r) => r.rebateWithdrawn === 0 && r.netRev === 0)).toBe(true);
  });

  // Mian Ali Khalid held four accounts in the week of 8-14 Aug, the worst case
  // in the live data and a 4x rebate overcharge before this change.
  it("collapses a four-account client into one row", () => {
    const four = [1, 2, 3, 4].map((n) => ({
      login: `20000${n}`,
      name: "Mian Ali Khalid",
      lots: n,
      markup: n * 10,
      clientComm: 0,
      lpComm: n,
      totalRev: n * 9,
    }));
    const ids = new Map(four.map((r) => [r.login, 9500]));
    const out = groupRowsByClient(four, ids);
    expect(out).toHaveLength(1);
    expect(out[0].accounts).toEqual(["200001", "200002", "200003", "200004"]);
    expect(out[0].lots).toBeCloseTo(10, 10);
    expect(out[0].markup).toBeCloseTo(100, 10);
    expect(out[0].totalRev).toBeCloseTo(90, 10);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run reports/dealMatchClientGrouping.test.js --reporter=basic`

Expected: FAIL with `groupRowsByClient is not a function` — it is not exported yet.

- [ ] **Step 3: Write the implementation**

In `reports/dealMatchWeeklyReport.js`, add this immediately after the closing brace of `deriveClientRevenueRows()`:

```javascript
// One row per CRM client rather than per MT5 account. A client commonly holds
// several trading accounts -- 10 did in the week of 8-14 Aug, one of them four
// -- which made the table hard to read and, before this, caused their IB rebate
// to be charged once per account.
//
// Pure: the login-to-user map is resolved by resolveClientIds() and passed in,
// so this function does no I/O and is cheap to test.
export function groupRowsByClient(rows, userIdByLogin) {
  const byClient = new Map();

  for (const row of rows) {
    const login = String(row.login || "").trim();
    const userId = userIdByLogin.get(login);
    const resolved = Number.isFinite(userId) && userId > 0 ? userId : null;
    // An unresolved login cannot be merged without inventing a relationship the
    // CRM does not assert, so it stands alone under its own key.
    const clientKey = resolved === null ? `login:${login}` : `user:${resolved}`;

    let client = byClient.get(clientKey);
    if (!client) {
      client = {
        clientKey,
        userId: resolved,
        name: "",
        accounts: [],
        lots: 0,
        markup: 0,
        clientComm: 0,
        lpComm: 0,
        totalRev: 0,
        rebateWithdrawn: 0,
        netRev: 0,
        _nameLots: -1,
      };
      byClient.set(clientKey, client);
    }

    if (login) client.accounts.push(login);
    client.lots += Number(row.lots) || 0;
    client.markup += Number(row.markup) || 0;
    client.clientComm += Number(row.clientComm) || 0;
    client.lpComm += Number(row.lpComm) || 0;
    client.totalRev += Number(row.totalRev) || 0;

    // Name comes from the largest account, so the choice is deterministic
    // instead of depending on the order the API happened to return.
    const lots = Number(row.lots) || 0;
    const name = String(row.name || "").trim();
    if (name && lots > client._nameLots) {
      client.name = name;
      client._nameLots = lots;
    }
  }

  return [...byClient.values()]
    .map(({ _nameLots, ...client }) => ({ ...client, accounts: client.accounts.sort() }))
    .sort((a, b) => b.lots - a.lots);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run reports/dealMatchClientGrouping.test.js --reporter=basic`

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add reports/dealMatchWeeklyReport.js reports/dealMatchClientGrouping.test.js
git commit -m "Add groupRowsByClient for the Deal Match revenue table"
```

---

### Task 2: Resolve client ids and look the rebate up once per client

Replaces `attachIbCommissions()`, which cached per login and split the result across a client's rows.

**Files:**
- Modify: `reports/dealMatchWeeklyReport.js` (add `resolveClientIds` and `attachRebateWithdrawn`; delete `attachIbCommissions`)
- Test: `reports/dealMatchClientGrouping.test.js` (append)

**Interfaces:**
- Consumes: `groupRowsByClient()` output from Task 1; the existing private helpers `getCrmUserIdByMt5Login(login)`, `isIbUser(crmUserId)`, `getIbApprovedTransfersAndWithdrawals(crmUserId, period)`, `mapWithConcurrency(items, worker, limit)` and the module constant `CRM_API_TOKEN`.
- Produces:
  - `resolveClientIds(logins)` returning `{ userIdByLogin: Map<string, number|null>, unresolved: number }`
  - `attachRebateWithdrawn(clientRows, period)` returning `{ failed: number, clients: number }` and setting `row.rebateWithdrawn` on each input row. `period` is `{ from: Date, to: Date }`.

- [ ] **Step 1: Write the failing test**

Append to `reports/dealMatchClientGrouping.test.js`:

```javascript
import { afterEach } from "vitest";

// Reuses the module namespace imported at the top of the file, which was loaded
// after VITE_API_TOKEN was set. Do NOT add a static import here.
const { resolveClientIds, attachRebateWithdrawn } = mod;

const PERIOD = { from: new Date("2026-08-08T00:00:00Z"), to: new Date("2026-08-14T23:59:59Z") };
const LOGIN_TO_USER = { "102244": 9001, "102233": 9001, "101499": 9002, "109999": 0 };
let calls;
const realFetch = globalThis.fetch;

function stubCrm({ failTransactionsFor = null, notIb = [] } = {}) {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : {};
    const ok = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => "" });
    if (u.includes("/rest/ib/tree")) {
      const id = Number(u.split("ibId=")[1]);
      calls.push({ kind: "tree", id });
      return ok(notIb.includes(id) ? [] : [{ id: 1 }]);
    }
    if (u.includes("/rest/accounts")) {
      calls.push({ kind: "account", login: body.login });
      return ok([{ userId: LOGIN_TO_USER[String(body.login)] ?? 0 }]);
    }
    if (u.includes("/rest/transactions")) {
      calls.push({ kind: "tx", id: body.fromUserId });
      if (body.fromUserId === failTransactionsFor) throw new Error("CRM down");
      return ok([{ processedAmount: -646 }]);
    }
    return ok([]);
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("resolveClientIds", () => {
  it("maps logins to CRM users and counts the ones that fail", async () => {
    stubCrm();
    const { userIdByLogin, unresolved } = await resolveClientIds(["102244", "102233", "109999"]);
    expect(userIdByLogin.get("102244")).toBe(9001);
    expect(userIdByLogin.get("102233")).toBe(9001);
    expect(userIdByLogin.get("109999")).toBeNull();
    expect(unresolved).toBe(1);
  });
});

describe("attachRebateWithdrawn", () => {
  it("charges a client once, not once per account", async () => {
    stubCrm();
    const clients = [
      { clientKey: "user:9001", userId: 9001, accounts: ["102233", "102244"], lots: 3.86, rebateWithdrawn: 0 },
      { clientKey: "user:9002", userId: 9002, accounts: ["101499"], lots: 5, rebateWithdrawn: 0 },
    ];
    const res = await attachRebateWithdrawn(clients, PERIOD);
    expect(clients[0].rebateWithdrawn).toBeCloseTo(646, 10);
    expect(clients[1].rebateWithdrawn).toBeCloseTo(646, 10);
    expect(res.failed).toBe(0);
    expect(res.clients).toBe(2);
    // One IB check and one transaction lookup per CLIENT, never per account.
    expect(calls.filter((c) => c.kind === "tree").length).toBe(2);
    expect(calls.filter((c) => c.kind === "tx").length).toBe(2);
  });

  it("charges a non-IB nothing and skips the transaction lookup", async () => {
    stubCrm({ notIb: [9002] });
    const clients = [{ clientKey: "user:9002", userId: 9002, accounts: ["101499"], lots: 5, rebateWithdrawn: 0 }];
    await attachRebateWithdrawn(clients, PERIOD);
    expect(clients[0].rebateWithdrawn).toBe(0);
    expect(calls.filter((c) => c.kind === "tx").length).toBe(0);
  });

  it("records zero for a failed lookup and counts it for the footer", async () => {
    stubCrm({ failTransactionsFor: 9001 });
    const clients = [{ clientKey: "user:9001", userId: 9001, accounts: ["102244"], lots: 1.94, rebateWithdrawn: 0 }];
    const res = await attachRebateWithdrawn(clients, PERIOD);
    expect(clients[0].rebateWithdrawn).toBe(0);
    expect(res.failed).toBe(1);
  });

  it("charges an unresolved login nothing without calling the CRM", async () => {
    stubCrm();
    const clients = [{ clientKey: "login:109999", userId: null, accounts: ["109999"], lots: 0.5, rebateWithdrawn: 0 }];
    const res = await attachRebateWithdrawn(clients, PERIOD);
    expect(clients[0].rebateWithdrawn).toBe(0);
    expect(res.clients).toBe(0);
    expect(calls.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run reports/dealMatchClientGrouping.test.js --reporter=basic`

Expected: FAIL with `resolveClientIds is not a function`.

- [ ] **Step 3: Write the implementation**

In `reports/dealMatchWeeklyReport.js`, delete the entire `attachIbCommissions()` function — it starts at the comment block beginning `// ── IB commission, per CLIENT, for the week ──` and ends at that function's closing brace — and put this in its place:

```javascript
// ── client identity and IB rebate ───────────────────────────────────────────
// The rebate is looked up ONCE PER CRM CLIENT. An earlier version cached per
// MT5 login while looking the value up per user, so a client with two accounts
// had their whole rebate charged to each one: Dawei Huang's 8,646 was billed as
// 17,292. Grouping first removes the need to split anything.
//
// It counts only the approved IB transfers and withdrawals SETTLED INSIDE the
// week. The IB wallet balance is deliberately excluded -- it is accumulated,
// still-unpaid commission read at the instant the report runs, so it is not a
// cost of this week, and including it made the same closed week produce a
// different Net Revenue on every run.
export async function resolveClientIds(logins) {
  const userIdByLogin = new Map();

  if (!CRM_API_TOKEN) {
    for (const login of logins) userIdByLogin.set(login, null);
    return { userIdByLogin, unresolved: logins.length };
  }

  await mapWithConcurrency(
    logins,
    async (login) => {
      try {
        const userId = await getCrmUserIdByMt5Login(login);
        userIdByLogin.set(login, Number.isFinite(userId) && userId > 0 ? userId : null);
      } catch (error) {
        console.warn(`[DealMatchWeekly] CRM user lookup failed for login=${login}:`, error?.message || error);
        userIdByLogin.set(login, null);
      }
    },
    6,
  );

  let unresolved = 0;
  for (const login of logins) {
    if (userIdByLogin.get(login) === null) unresolved += 1;
  }
  return { userIdByLogin, unresolved };
}

export async function attachRebateWithdrawn(clientRows, period) {
  const withUser = clientRows.filter((row) => Number.isFinite(row.userId) && row.userId > 0);
  let failed = 0;

  if (!CRM_API_TOKEN) {
    for (const row of clientRows) row.rebateWithdrawn = 0;
    return { failed: withUser.length, clients: withUser.length };
  }

  await mapWithConcurrency(
    withUser,
    async (row) => {
      try {
        if (!(await isIbUser(row.userId))) {
          row.rebateWithdrawn = 0;
          return;
        }
        row.rebateWithdrawn = await getIbApprovedTransfersAndWithdrawals(row.userId, period);
      } catch (error) {
        console.warn(`[DealMatchWeekly] rebate lookup failed for client=${row.userId}:`, error?.message || error);
        // Zero UNDERSTATES the cost and so overstates Net Revenue. It is counted
        // here and named in the footer rather than passing as a real figure.
        row.rebateWithdrawn = 0;
        failed += 1;
      }
    },
    6,
  );

  return { failed, clients: withUser.length };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run reports/dealMatchClientGrouping.test.js --reporter=basic`

Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add reports/dealMatchWeeklyReport.js reports/dealMatchClientGrouping.test.js
git commit -m "Look the IB rebate up once per client, not once per login"
```

---

### Task 3: Render the grouped table and report failures

Wires Tasks 1 and 2 into both call sites, renames the column, and surfaces both failure counts in the footer.

**Files:**
- Modify: `reports/dealMatchWeeklyReport.js` — `buildEmailHtml` (totals reducer, `bodyRows`, table head, footer), `runWeeklyDealMatchEmailReport`, `getWeeklyDealMatchDataset`
- Modify: `docs/superpowers/specs/2026-08-16-deal-match-client-grouping-design.md` (status line)
- Test: `reports/dealMatchClientGrouping.test.js` (append)

**Interfaces:**
- Consumes: `groupRowsByClient(rows, userIdByLogin)` and `attachRebateWithdrawn(clientRows, period)` from Tasks 1 and 2.
- Produces: no new exports. `buildEmailHtml` keeps its existing optional `ibNotice` parameter (string or null).

- [ ] **Step 1: Write the test that pins the formula**

Append to `reports/dealMatchClientGrouping.test.js`:

```javascript
describe("net revenue on grouped rows", () => {
  it("subtracts the rebate once per client", () => {
    const rows = groupRowsByClient(ROWS, IDS);
    const dawei = rows.find((r) => r.userId === 9001);
    dawei.rebateWithdrawn = 646;
    const netRev = (dawei.markup + dawei.clientComm) - (dawei.lpComm + dawei.rebateWithdrawn);
    // 995.50 + 0 - (12.50 + 646) = 337.00
    expect(netRev).toBeCloseTo(337, 10);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run reports/dealMatchClientGrouping.test.js --reporter=basic`

Expected: PASS, 12 tests. This one exercises Task 1 output plus arithmetic, so it should pass immediately. If it fails, Task 1 is wrong — fix that before continuing.

- [ ] **Step 3: Replace the row build in `runWeeklyDealMatchEmailReport`**

Find the block beginning `const ibResult = await attachIbCommissions(baseRows,` and ending with the `});` that closes the `baseRows.map(...)` call. Replace the whole block with:

```javascript
  const logins = [...new Set(baseRows.map((r) => String(r.login || "").trim()).filter(Boolean))];
  const { userIdByLogin, unresolved } = await resolveClientIds(logins);
  const clientRows = groupRowsByClient(baseRows, userIdByLogin);
  const rebateResult = await attachRebateWithdrawn(clientRows, { from: week.start, to: week.end });

  const rows = clientRows.map((row) => ({
    ...row,
    netRev: (row.markup + row.clientComm) - (row.lpComm + row.rebateWithdrawn),
  }));
```

- [ ] **Step 4: Replace the row build in `getWeeklyDealMatchDataset`**

Find the block beginning `await attachIbCommissions(baseRows,` and ending with the `});` that closes its `baseRows.map(...)`. Replace it with:

```javascript
  const logins = [...new Set(baseRows.map((r) => String(r.login || "").trim()).filter(Boolean))];
  const { userIdByLogin } = await resolveClientIds(logins);
  const clientRows = groupRowsByClient(baseRows, userIdByLogin);
  await attachRebateWithdrawn(clientRows, { from: week.start, to: week.end });

  const enriched = clientRows.map((row) => ({
    ...row,
    netRev: (row.markup + row.clientComm) - (row.lpComm + row.rebateWithdrawn),
  }));
```

- [ ] **Step 5: Update the totals reducer in `buildEmailHtml`**

Replace this line:

```javascript
      acc.ibCommission += Number(row.ibCommission) || 0;
```

with:

```javascript
      acc.rebateWithdrawn += Number(row.rebateWithdrawn) || 0;
```

and replace the reducer's seed object:

```javascript
    { lots: 0, markup: 0, clientComm: 0, lpComm: 0, ibCommission: 0, totalRev: 0, netRev: 0 },
```

with:

```javascript
    { lots: 0, markup: 0, clientComm: 0, lpComm: 0, rebateWithdrawn: 0, totalRev: 0, netRev: 0 },
```

- [ ] **Step 6: Update the table header**

Replace the `<thead>` inner row of the Client Revenue Table with:

```html
              <tr>
                <th width="22%">Client</th>
                <th width="14%">Accounts</th>
                <th width="8%">Lots</th>
                <th width="9%">Markup</th>
                <th width="10%">Client Comm</th>
                <th width="8%">LP Comm</th>
                <th width="9%">Total Rev</th>
                <th width="10%">Rebate Withdrawn</th>
                <th width="10%">Net Revenue</th>
              </tr>
```

- [ ] **Step 7: Update the TOTAL row**

In the `<tr class="total-row">` block, replace:

```javascript
                ${dataCell("IB Commission", money(totals.ibCommission), { align: "right", cls: "money-cost" })}
```

with:

```javascript
                ${dataCell("Rebate Withdrawn", money(totals.rebateWithdrawn), { align: "right", cls: "money-cost" })}
```

- [ ] **Step 8: Update the body rows**

Replace the whole `const bodyRows = rows.map(...).join("");` block with:

```javascript
  const bodyRows = rows
    .map(
      (row) => `<tr>
        ${dataCell("Client", escapeHtml(row.name || "(unnamed)"))}
        ${dataCell("Accounts", escapeHtml(row.accounts.join(", ")), { nowrap: true })}
        ${dataCell("Lots", fmtNum(row.lots, 2), { align: "right" })}
        ${dataCell("Markup", money(row.markup), { align: "right" })}
        ${dataCell("Client Comm", money(row.clientComm), { align: "right" })}
        ${dataCell("LP Comm", money(row.lpComm), { align: "right" })}
        ${dataCell("Total Rev", money(row.totalRev), { align: "right", bold: true })}
        ${dataCell("Rebate Withdrawn", money(row.rebateWithdrawn), { align: "right" })}
        ${dataCell("Net Revenue", money(row.netRev), { align: "right", bold: true })}
      </tr>`,
    )
    .join("");
```

- [ ] **Step 9: Update the footer wording**

Replace the footer line that begins `IB Commission counts the` with:

```javascript
            Rebate Withdrawn is the approved IB transfers and withdrawals <em>settled inside this week</em>, looked up once per client. It is money that left the IB wallet during the week and may have been earned earlier, so it is a cash figure rather than earnings. The running IB wallet balance is not included.<br/>
```

- [ ] **Step 10: Update the notice construction**

In `runWeeklyDealMatchEmailReport`, replace the `const ibNotice = ibResult && ...` assignment with:

```javascript
  // A zero rebate understates the cost and so overstates Net Revenue; an
  // unresolved login cannot be grouped. Both are named rather than left to look
  // like ordinary rows.
  const noticeParts = [];
  if (rebateResult.failed) {
    noticeParts.push(`rebate could not be read for ${rebateResult.failed} of ${rebateResult.clients} client(s), so their Net Revenue is overstated`);
  }
  if (unresolved) {
    noticeParts.push(`${unresolved} login(s) could not be matched to a CRM client and appear as their own rows`);
  }
  const ibNotice = noticeParts.length ? noticeParts.join("; ") : null;
```

- [ ] **Step 11: Run the whole suite and the syntax check**

Run: `npx vitest run reports/ --reporter=basic`

Expected: PASS, 12 tests, no failures.

Run: `node --check reports/dealMatchWeeklyReport.js`

Expected: no output.

Run: `node -e "import('./reports/dealMatchWeeklyReport.js').then(m => console.log(typeof m.groupRowsByClient, typeof m.attachRebateWithdrawn, typeof m.resolveClientIds))"`

Expected: `function function function`

- [ ] **Step 12: Confirm the old names are gone**

Run: `grep -n "ibCommission\|attachIbCommissions\|IB Commission" reports/dealMatchWeeklyReport.js`

Expected: no matches other than inside explanatory comments. If a live code path still references `ibCommission`, fix it before committing.

- [ ] **Step 13: Update the spec status and commit**

In `docs/superpowers/specs/2026-08-16-deal-match-client-grouping-design.md`, change the status line to:

```markdown
**Status:** implemented
```

```bash
git add reports/dealMatchWeeklyReport.js reports/dealMatchClientGrouping.test.js docs/superpowers/specs/2026-08-16-deal-match-client-grouping-design.md
git commit -m "Group the Deal Match revenue table by client, rebate as withdrawn"
```

---

## Verification after all tasks

Push, restart the server, then send a test Deal Match email from `/settings/alerts` and confirm:

1. Dawei Huang appears **once**, with `102233, 102244` in the Accounts column and 3.86 lots.
2. Mian Ali Khalid appears once with four accounts listed.
3. The column reads **Rebate Withdrawn**, and no row shows the old 8,646-style figure that included the wallet balance.
4. The row count dropped from about 73 to about 62.
5. Column totals still equal the sum of the rows.
