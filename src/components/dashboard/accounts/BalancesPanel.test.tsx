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
