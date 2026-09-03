import { describe, expect, it } from "vitest";
import { buildEmailHtml, buildEmailSubject, buildTelegramMessage } from "./notifier.js";

// What the report says, not whether it was delivered. Both builders are pure
// string functions; nothing here reaches Brevo or Telegram.
//
// The email of 2026-09-03 printed "✗ OwnBit $0.00" for a provider that never
// answered, and put the resulting understated sum in the subject line. A dash
// means "could not read"; "$0.00" means the balance is zero. This file pins
// that distinction in both channels.

const widgetsWith = (overrides = {}) => ({
  bitpace: { name: "Bitpace", balance: 0.44, status: "ok" },
  letknowpay: { name: "LetKnow Pay", balance: 191.71, status: "ok" },
  ownbit: { name: "OwnBit", balance: 1000, status: "ok" },
  ownbitnew: { name: "OwnBit New", balance: 37570, status: "ok" },
  heropayment: { name: "HeroPayment", balance: 153041.73, status: "ok" },
  googlesheets_match2pay: { name: "Match2Pay", balance: 10, status: "ok" },
  googlesheets_deusxpay: { name: "DeusXpay", balance: 20, status: "ok" },
  googlesheets_openpayed: { name: "OpenPayed", balance: 30, status: "ok" },
  googlesheets_goldsouq: { name: "Gold Souq", balance: 50694.96, status: "ok" },
  googlesheets_fab: { name: "FAB Bank", balance: 245.5, status: "ok" },
  googlesheets_mbme: { name: "MBME", balance: 40, status: "ok" },
  ...overrides,
});

const DISCONNECTED_OWNBIT = { name: "OwnBit", balance: 0, status: "error", error: "request timed out" };
const DISCONNECTED_OWNBIT_NEW = { name: "OwnBit New", balance: 0, status: "error", error: "request timed out" };

const html = (widgets, total) => buildEmailHtml(widgets, total, "2026-09-03", 0, 0, 0, 0, {});
const telegram = (widgets, total) => buildTelegramMessage(widgets, total, "2026-09-03", 0, 0, 0, 0, {});

describe("wallet report subject line", () => {
  it("leads with the total", () => {
    expect(buildEmailSubject(638034.14, "2026-09-03", widgetsWith())).toBe(
      "[Total: $638034.14] Closing Balance - 2026-09-03",
    );
  });

  it("says the total is unavailable when a provider is disconnected", () => {
    // A precise dollar figure is the single most-read thing in the whole
    // report, because it is what a phone shows without opening anything. While
    // a provider is silent that figure is a sum with a missing term, so the
    // subject stops quoting one.
    expect(
      buildEmailSubject(638034.14, "2026-09-03", widgetsWith({ ownbit: DISCONNECTED_OWNBIT })),
    ).toBe("[Total: —] Closing Balance - 2026-09-03");
  });
});

describe("wallet report renders an unreadable balance as unavailable", () => {
  it("prints a dash, not $0.00, beside a disconnected provider in the email", () => {
    const body = html(
      widgetsWith({ ownbit: DISCONNECTED_OWNBIT, ownbitnew: DISCONNECTED_OWNBIT_NEW }),
      638034.14,
    );

    expect(body).toContain("✗ OwnBit");
    expect(body).toContain("✗ OwnBit New");
    expect(body).toContain("—");
    expect(body).toContain("not connected");
    // The ✗ and the figure beside it must not contradict each other.
    expect(body).not.toMatch(/✗ OwnBit<\/td><td[^>]*>\$0\.00/);
    expect(body).not.toMatch(/✗ OwnBit New<\/td><td[^>]*>\$0\.00/);
  });

  it("prints a dash, not $0.00, beside a disconnected provider on Telegram", () => {
    const message = telegram(widgetsWith({ ownbit: DISCONNECTED_OWNBIT }), 638034.14);

    expect(message).toContain("• OwnBit `—`");
    expect(message).toContain("not connected");
    expect(message).not.toContain("• OwnBit `$0.00`");
  });

  it("does not quote a total summed from a provider that never answered", () => {
    const widgets = widgetsWith({ ownbit: DISCONNECTED_OWNBIT });

    expect(html(widgets, 638034.14)).not.toContain("$638,034.14");
    expect(telegram(widgets, 638034.14)).not.toContain("$638,034.14");
    // And it names who is missing, which is the actionable half.
    expect(html(widgets, 638034.14)).toContain("not connected: OwnBit");
    expect(telegram(widgets, 638034.14)).toContain("not connected: OwnBit");
  });

  it("still prints every figure while all providers are connected", () => {
    const widgets = widgetsWith();

    expect(html(widgets, 241844.34)).toContain("$1,000.00");
    expect(html(widgets, 241844.34)).toContain("$241,844.34");
    expect(html(widgets, 241844.34)).not.toContain("not connected");
    expect(telegram(widgets, 241844.34)).toContain("*TOTAL* `$241,844.34`");
    expect(telegram(widgets, 241844.34)).not.toContain("—");
  });

  it("prints $0.00 for a connected provider that genuinely holds nothing", () => {
    // The other half of the rule. Match2Pay's sheet cell is empty and the read
    // succeeded, so zero is a fact about the balance and must be stated.
    const widgets = widgetsWith({ googlesheets_match2pay: { name: "Match2Pay", balance: 0, status: "ok" } });

    expect(html(widgets, 241834.34)).toContain("✓ Match2Pay");
    expect(html(widgets, 241834.34)).toMatch(/✓ Match2Pay<\/td><td[^>]*>\$0\.00/);
    expect(telegram(widgets, 241834.34)).toContain("• M2P `$0.00`");
  });
});
