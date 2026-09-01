import { describe, expect, it } from "vitest";
import { balancesRows } from "./BalancesPanel";

const ORDER = [
  { key: "ownbit", label: "OwnBit", group: "crypto" },
  { key: "ownbitnew", label: "OwnBit New", group: "crypto" },
  { key: "googlesheets_goldsouq", label: "Gold Souq", group: "bank" },
  { key: "googlesheets_fab", label: "FAB Bank", group: "bank" },
] as const;

const w = (id: string, balance: number, status = "ok", name?: string) => ({ id, name: name ?? id, balance, status });

const props = (widgets: ReturnType<typeof w>[], totalBalance = 0) =>
  ({ widgets, totalBalance, reportDate: "2026-09-01", order: ORDER }) as never;

describe("grouping", () => {
  it("splits crypto from bank in the given order", () => {
    const { crypto, bank } = balancesRows(props([w("ownbit", 1), w("ownbitnew", 2), w("googlesheets_goldsouq", 3), w("googlesheets_fab", 4)]));
    expect(crypto.filter((r) => r.kind === "row").map((r) => r.id)).toEqual(["ownbit", "ownbitnew"]);
    expect(bank.map((r) => r.id)).toEqual(["googlesheets_goldsouq", "googlesheets_fab"]);
  });

  it("ends the crypto group with a subtotal of its own rows", () => {
    const { crypto } = balancesRows(props([w("ownbit", 1000), w("ownbitnew", 234.5)]));
    const last = crypto[crypto.length - 1];
    expect(last.kind).toBe("subtotal");
    expect(last.value).toBe("$1,234.50");
  });

  it("reports the total the API gave, not a sum of its own", () => {
    // totalBalance comes from the backend. Re-summing here would create a
    // second answer to the same question.
    const { total } = balancesRows(props([w("ownbit", 1), w("ownbitnew", 2)], 999999.99));
    expect(total.value).toBe("$999,999.99");
  });
});

describe("a failed provider is visibly failed", () => {
  // walletMonitor returns balance 0 with status 'error'. Rendering that as a
  // plain $0.00 is how $11,840.66 silently left Total Combined when Tronscan
  // rate-limited two wallets on 2026-09-01.
  it("marks a status:error row as failed while keeping its reported value", () => {
    const { crypto } = balancesRows(props([w("ownbit", 0, "error"), w("ownbitnew", 500)]));
    const failed = crypto.find((r) => r.id === "ownbit");
    expect(failed?.failed).toBe(true);
    expect(failed?.value).toBe("$0.00");
    expect(crypto.find((r) => r.id === "ownbitnew")?.failed).toBe(false);
  });

  it("does not mark a genuine zero as failed", () => {
    const { crypto } = balancesRows(props([w("ownbit", 0, "ok")]));
    expect(crypto.find((r) => r.id === "ownbit")?.failed).toBe(false);
  });
});

describe("missing widgets", () => {
  it("omits a widget the response did not carry rather than inventing a zero", () => {
    const { bank } = balancesRows(props([w("googlesheets_fab", 10)]));
    expect(bank.map((r) => r.id)).toEqual(["googlesheets_fab"]);
  });

  it("prefers the widget's own name over the configured label", () => {
    const { bank } = balancesRows(props([w("googlesheets_goldsouq", 5, "ok", "Gold Souq (-$30,000.00 deducted, J31)")]));
    expect(bank[0].label).toBe("Gold Souq (-$30,000.00 deducted, J31)");
  });
});

describe("the subtotal agrees with the rows it sums", () => {
  // The row value coerces with `Number(x) || 0` and the subtotal used to
  // coerce with `Number(x ?? 0)`. Those agree on every input except the one
  // that matters: a non-numeric balance printed $0.00 on the row and $NaN on
  // the subtotal directly beneath it.
  it("does not print $NaN under rows that printed $0.00", () => {
    const { crypto } = balancesRows(props([w("ownbit", "oops" as never), w("ownbitnew", 500)]));
    expect(crypto.find((r) => r.id === "ownbit")?.value).toBe("$0.00");
    const subtotal = crypto.find((r) => r.kind === "subtotal");
    expect(subtotal?.value).toBe("$500.00");
    expect(subtotal?.value).not.toContain("NaN");
  });

  // The subtotal used to be pushed unconditionally, which made the panel's
  // own `crypto.length > 0` guard permanently true: a never-loaded panel
  // rendered a "Crypto" heading over a lone "Subtotal crypto $0.00" -- a
  // subtotal of no rows at all, reading as a real zero balance.
  it("emits no crypto group at all when no crypto widget was reported", () => {
    const { crypto } = balancesRows(props([w("googlesheets_fab", 10)]));
    expect(crypto).toEqual([]);
  });

  it("still subtotals a single genuine zero row", () => {
    const { crypto } = balancesRows(props([w("ownbit", 0)]));
    expect(crypto.map((r) => r.kind)).toEqual(["row", "subtotal"]);
    expect(crypto[1].value).toBe("$0.00");
  });
});
