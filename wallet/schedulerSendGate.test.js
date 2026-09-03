import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notifyIfTotalChanged } from "./scheduler.js";

// The send decision as the scheduler actually runs it: through the state file,
// the channel dedupe, and the "Total Combined must have changed" gate.
//
// scheduler.test.js deliberately stays a pure comparison of two snapshots. This
// file is the other half -- the gate lives in _runNotifyLogic(), which is not
// exported, so the only honest way to assert it is to run a poll.
//
// No credentials are set, so both channels decline before opening a socket and
// the run reports send-failed. That is fine: what is under test here is whether
// the run reached the sending step at all, not whether Brevo answered.

const CONNECTED = "ok";

const BASE_WIDGETS = {
  bitpace: { name: "Bitpace", balance: 0.44, currencies: { USDT: 0.437722 }, status: CONNECTED },
  letknowpay: { name: "LetKnow Pay", balance: 191.32, currencies: { USD: 130.95, ETH: 0.00288773 }, status: CONNECTED },
  ownbit: { name: "OwnBit", balance: 1000, currencies: { "USDT TRC20": 1000 }, status: CONNECTED },
  ownbitnew: { name: "OwnBit New", balance: 37570, currencies: { "USDT TRC20": 37570 }, status: CONNECTED },
  heropayment: { name: "HeroPayment", balance: 153041.73, currencies: { USDT: 153041.73 }, status: CONNECTED },
  googlesheets_match2pay: { name: "Match2Pay", balance: 10, currencies: {}, status: CONNECTED },
  googlesheets_deusxpay: { name: "DeusXpay", balance: 20, currencies: {}, status: CONNECTED },
  googlesheets_openpayed: { name: "OpenPayed", balance: 30, currencies: {}, status: CONNECTED },
  googlesheets_goldsouq: { name: "Gold Souq", balance: 50694.96, currencies: {}, status: CONNECTED },
  googlesheets_fab: { name: "FAB Bank", balance: 245.5, currencies: { "FAB AED": 200 }, status: CONNECTED },
  googlesheets_mbme: { name: "MBME", balance: 40, currencies: {}, status: CONNECTED },
};

const DISCONNECTED = { balance: 0, currencies: {}, status: "error", error: "request timed out" };

function reportWith(overrides = {}, total = null) {
  const widgets = {};
  for (const [id, widget] of Object.entries(BASE_WIDGETS)) widgets[id] = { ...widget };
  for (const [id, patch] of Object.entries(overrides)) widgets[id] = { ...widgets[id], ...patch };
  const entries = Object.entries(widgets).map(([id, w]) => ({ id, ...w }));
  const summed = entries.reduce((sum, w) => sum + Number(w.balance || 0), 0);
  return {
    data: {
      total_balance: total === null ? Number(summed.toFixed(2)) : total,
      widgets: entries,
    },
  };
}

let stateFile;
const savedEnv = {};

beforeEach(() => {
  stateFile = path.join(os.tmpdir(), `wallet_gate_${process.pid}_${Math.random().toString(16).slice(2)}.json`);
  for (const key of ["WALLET_REPORT_STATE_FILE", "BREVO_API_KEY", "WALLET_RECIPIENTS", "ALERT_RECIPIENTS", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID", "WALLET_REPORT_SEND_ON_FIRST_RUN"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.WALLET_REPORT_STATE_FILE = stateFile;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(stateFile, { force: true });
});

// Two polls: the first only writes the baseline, the second is the one under
// test.
async function poll(firstReport, secondReport) {
  const baseline = await notifyIfTotalChanged(firstReport);
  expect(baseline.status).toBe("baseline-initialized");
  return notifyIfTotalChanged(secondReport);
}

describe("wallet alert send gate", () => {
  it("sends nothing when two providers drop off and LetKnow Pay drifts on price", async () => {
    // The reported email, end to end. The one cent between the after-total and
    // the sum of the rounded rows is what the old delta-matching rule could not
    // account for, and is why this was ever sent.
    const result = await poll(
      reportWith({}, 242843.95),
      reportWith(
        { ownbit: DISCONNECTED, ownbitnew: DISCONNECTED, letknowpay: { balance: 191.37 } },
        204274.01,
      ),
    );

    expect(result.status).toBe("ignored");
    expect(result.changeItems).toEqual([]);
  });

  it("still reports a Gold Souq deposit while OwnBit is disconnected", async () => {
    // The gate normally suppresses provider movement that leaves the total
    // alone. It cannot rule here -- there is no total while OwnBit is silent --
    // so a surviving change item sends on its own rather than waiting out the
    // outage.
    const result = await poll(
      reportWith({}, 242843.95),
      reportWith({ ownbit: DISCONNECTED, googlesheets_goldsouq: { balance: 60000 } }, 251148.99),
    );

    expect(result.status).not.toBe("skipped");
    expect(result.reason).not.toBe("total-combined-unchanged");
    expect(result.changeItems.map((item) => item.key)).toEqual(["googlesheets_goldsouq"]);
  });

  it("keeps suppressing offsetting movement while every provider is connected", async () => {
    // The gate's original job, unchanged: $100 moved from one of our wallets to
    // another is not money entering or leaving, and the unchanged total proves
    // it.
    const result = await poll(
      reportWith({}),
      reportWith({
        ownbit: { balance: 900, currencies: { "USDT TRC20": 900 } },
        ownbitnew: { balance: 37670, currencies: { "USDT TRC20": 37670 } },
      }),
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("total-combined-unchanged");
  });
});
