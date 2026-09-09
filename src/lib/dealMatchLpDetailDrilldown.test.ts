// The per-symbol drilldown under each (client, LP) row of the Client LP
// Allocation Detail table. Three properties matter beyond "it expands":
// children belong to exactly one parent, an expansion never touches a total,
// and expanding survives the next fetch.
import { describe, expect, it } from "vitest";
import {
  buildClientLpDetailRows,
  computeClientLpDetailTotals,
  hasSymbolChildren,
  isDetailRow,
  lpDetailExpansionKey,
  parentRowsOnly,
  symbolChildrenFor,
  withDetailRowsFollowingParents,
} from "@/lib/dealMatchLpDetailDrilldown";
import { deriveBaseRows } from "@/lib/dealMatchApi";
import type { ClientLpSymbolCommission } from "@/lib/dealMatchCommSource";
import type { SortableTableColumn } from "@/components/ui/SortableTable";

const PARENT_FINALTO = {
  login: "9001",
  lpsid: "S1",
  lpName: "Finalto",
  tradeCount: 12,
  symbols: "EURUSD, AAPL",
  clientLotsPlaced: 30,
  clientMillionsUsd: 4,
  lpLotsSent: 28,
  allocationPct: 60,
  markupRevenueUsd: 500,
  clientCommissionUsd: 100,
  grossRevenueUsd: 600,
  lpCommissionUsd: 40,
};

const PARENT_CFH = {
  login: "9001",
  lpsid: "S2",
  lpName: "CFH",
  tradeCount: 5,
  symbols: "GBPUSD",
  clientLotsPlaced: 10,
  clientMillionsUsd: 2,
  lpLotsSent: 9,
  allocationPct: 40,
  markupRevenueUsd: 200,
  clientCommissionUsd: 50,
  grossRevenueUsd: 250,
  lpCommissionUsd: 20,
};

// Two symbols under Finalto that hit different branches, so the parent is Mixed.
const SYMBOLS: ClientLpSymbolCommission[] = [
  {
    login: "9001",
    lpsid: "S1",
    lpName: "Finalto",
    symbol: "EURUSD",
    tradeCount: 8,
    clientLots: 25,
    clientMillionsUsd: 3,
    coverageSymbolCommissionUsd: 300,
    perMillionRateUsd: 7,
    netLpCommUsd: 34,
    grossRevenueUsd: 500,
  },
  {
    login: "9001",
    lpsid: "S1",
    lpName: "Finalto",
    symbol: "AAPL",
    tradeCount: 4,
    clientLots: 5,
    clientMillionsUsd: 1,
    coverageSymbolCommissionUsd: 0,
    isStock: true,
    netLpCommUsd: 0,
    grossRevenueUsd: 100,
  },
];

const expandFinalto = () => new Set([lpDetailExpansionKey(PARENT_FINALTO)]);

describe("symbolChildrenFor", () => {
  it("matches children on login, lpsid AND lpName", () => {
    const kids = symbolChildrenFor(PARENT_FINALTO, SYMBOLS);
    expect(kids.map((k) => k.symbol)).toEqual(["EURUSD", "AAPL"]);
  });

  it("does NOT attach a child whose lpsid matches but whose lpName differs", () => {
    // Same sid, different LP: the reference page matches on both keys precisely
    // because a sid is reused across LP names, and a one-key match would pull
    // this row under the wrong parent.
    const otherLp: ClientLpSymbolCommission = { ...SYMBOLS[0], lpName: "CFH", symbol: "USDJPY" };
    const kids = symbolChildrenFor(PARENT_FINALTO, [...SYMBOLS, otherLp]);
    expect(kids.map((k) => k.symbol)).toEqual(["EURUSD", "AAPL"]);
    expect(kids.some((k) => k.symbol === "USDJPY")).toBe(false);
  });

  it("does not attach another client's symbols", () => {
    const otherClient: ClientLpSymbolCommission = { ...SYMBOLS[0], login: "9999", symbol: "USDCHF" };
    expect(symbolChildrenFor(PARENT_FINALTO, [...SYMBOLS, otherClient]).some((k) => k.symbol === "USDCHF")).toBe(false);
  });

  it("orders children by client lots desc, then symbol", () => {
    const tie: ClientLpSymbolCommission = { ...SYMBOLS[1], symbol: "AAA", clientLots: 5 };
    expect(symbolChildrenFor(PARENT_FINALTO, [...SYMBOLS, tie]).map((k) => k.symbol)).toEqual(["EURUSD", "AAA", "AAPL"]);
  });
});

describe("buildClientLpDetailRows", () => {
  it("flags only the parent that has children, so the other shows no chevron", () => {
    const rows = buildClientLpDetailRows([PARENT_FINALTO, PARENT_CFH], SYMBOLS, new Set());
    expect(rows).toHaveLength(2);
    expect(rows[0].__hasChildren).toBe(true);
    expect(rows[1].__hasChildren).toBe(false);
    expect(hasSymbolChildren(PARENT_CFH, SYMBOLS)).toBe(false);
  });

  it("collapsed rows are exactly the parents, in their fetched order", () => {
    const rows = buildClientLpDetailRows([PARENT_FINALTO, PARENT_CFH], SYMBOLS, new Set());
    expect(rows.map((r) => r.lpsid)).toEqual(["S1", "S2"]);
    expect(rows.some(isDetailRow)).toBe(false);
  });

  it("splices children directly beneath their parent, leaving the parents' order intact", () => {
    const rows = buildClientLpDetailRows([PARENT_FINALTO, PARENT_CFH], SYMBOLS, expandFinalto());
    expect(rows.map((r) => (isDetailRow(r) ? `  ${r.__symKey}` : r.lpsid))).toEqual(["S1", "  EURUSD", "  AAPL", "S2"]);
  });

  it("remaps a child onto the parent's column fields", () => {
    const child = buildClientLpDetailRows([PARENT_FINALTO], SYMBOLS, expandFinalto())[1];
    expect(child.symbols).toBe("EURUSD");
    expect(child.clientLotsPlaced).toBe(25);
    expect(child.lpCommissionUsd).toBe(34);
    expect(child.lpLotsSent).toBeNull();
  });

  it("labels a parent Mixed when its symbols hit different branches", () => {
    const rows = buildClientLpDetailRows([PARENT_FINALTO], SYMBOLS, expandFinalto());
    expect(rows[0].lpCommissionSource).toBe("Mixed");
    expect(rows[1].lpCommissionSource).toBe("Actual");
    expect(rows[2].lpCommissionSource).toBe("Stock");
  });

  it("falls back to the backend's own tag when a parent has no per-symbol rows", () => {
    const rows = buildClientLpDetailRows([{ ...PARENT_CFH, lpCommissionSource: "PerMillion" }], SYMBOLS, new Set());
    expect(rows[0].lpCommissionSource).toBe("PerMillion");
  });

  it("leaves a parent unlabelled when nothing identifies a branch", () => {
    expect(buildClientLpDetailRows([PARENT_CFH], SYMBOLS, new Set())[0].lpCommissionSource).toBe("");
  });

  it("keeps the expansion after a data refresh -- the state is not held in the data", () => {
    const expanded = expandFinalto();
    const before = buildClientLpDetailRows([PARENT_FINALTO, PARENT_CFH], SYMBOLS, expanded);
    expect(before.filter(isDetailRow)).toHaveLength(2);

    // A refresh replaces every row object -- new fetch, structurally equal data.
    const refetchedParents = [{ ...PARENT_FINALTO }, { ...PARENT_CFH }];
    const refetchedSymbols = SYMBOLS.map((s) => ({ ...s }));
    const after = buildClientLpDetailRows(refetchedParents, refetchedSymbols, expanded);

    expect(after.filter(isDetailRow).map((r) => r.__symKey)).toEqual(["EURUSD", "AAPL"]);
    expect(after[0].__expanded).toBe(true);
  });

  it("uses the caller's login when the payload row omits one", () => {
    const noLogin = { ...PARENT_FINALTO, login: undefined };
    expect(hasSymbolChildren(noLogin, SYMBOLS, "9001")).toBe(true);
    expect(hasSymbolChildren(noLogin, SYMBOLS)).toBe(false);
  });
});

describe("computeClientLpDetailTotals", () => {
  it("totals the parents only, so an expansion cannot double-count", () => {
    const collapsed = computeClientLpDetailTotals(buildClientLpDetailRows([PARENT_FINALTO, PARENT_CFH], SYMBOLS, new Set()));
    const expanded = computeClientLpDetailTotals(
      buildClientLpDetailRows([PARENT_FINALTO, PARENT_CFH], SYMBOLS, expandFinalto()),
    );

    expect(collapsed).toEqual(expanded);
    // Parent figures only: 30 + 10 lots, 600 + 250 gross, 40 + 20 LP comm.
    expect(expanded.clientLotsPlaced).toBe(40);
    expect(expanded.grossRevenueUsd).toBe(850);
    expect(expanded.lpCommissionUsd).toBe(60);
    expect(expanded.netRevenueUsd).toBe(790);
  });

  it("parentRowsOnly drops the children an expansion added", () => {
    const rows = buildClientLpDetailRows([PARENT_FINALTO, PARENT_CFH], SYMBOLS, expandFinalto());
    expect(rows).toHaveLength(4);
    expect(parentRowsOnly(rows)).toHaveLength(2);
  });
});

describe("withDetailRowsFollowingParents", () => {
  it("sorts a child by its parent's value, so the child never leaves the parent", () => {
    const columns: SortableTableColumn<Record<string, any>>[] = [
      { key: "clientLotsPlaced", label: "Client Lots", sortValue: (r) => Number(r.clientLotsPlaced) || 0, render: () => null },
    ];
    const [col] = withDetailRowsFollowingParents(columns);
    const rows = buildClientLpDetailRows([PARENT_FINALTO, PARENT_CFH], SYMBOLS, expandFinalto());

    // Children report 30 (the Finalto parent's lots), not their own 25 / 5.
    expect(rows.map((r) => col.sortValue!(r))).toEqual([30, 30, 30, 10]);
  });
});

describe("the new column changes no existing figure", () => {
  it("Net Revenue is still built from the per-million LP commission, not lpCommissionUsd", () => {
    // lpCommPerMillionUsd (60) and lpCommissionUsd (5) deliberately disagree:
    // Net must follow the per-million figure. docs/dealing-reporting.md §5.
    const [row] = deriveBaseRows({
      clientRevenueSummaries: [
        {
          login: 9001,
          name: "A",
          lots: 30,
          markupRevenueUsd: 500,
          clientCommissionUsd: 100,
          lpCommissionUsd: -5,
          clientMillionsUsd: 4,
          lpCommPerMillionUsd: 60,
          totalRevenueUsd: 0,
        },
      ],
    });

    expect(row.totalRev).toBe(540); // 500 + 100 - 60
    expect(row.netRevenue).toBe(540);
    expect(row.totalRev).not.toBe(595); // what lpCommissionUsd (5) would give
    expect(row.lpComm).toBe(5);
    expect(row.lpCommPerM).toBe(60);
  });

  it("a detail row's Net Revenue inputs are untouched by the drilldown", () => {
    const [parent] = buildClientLpDetailRows([PARENT_FINALTO], SYMBOLS, expandFinalto());
    expect(parent.grossRevenueUsd).toBe(PARENT_FINALTO.grossRevenueUsd);
    expect(parent.lpCommissionUsd).toBe(PARENT_FINALTO.lpCommissionUsd);
    expect(parent.grossRevenueUsd - parent.lpCommissionUsd).toBe(560);
  });
});
