// @vitest-environment node
//
// The guard that stops WEEKLY_*_RUN_ON_START mailing a report every time the
// app pool recycles.
//
// One state file for the whole file, set before the dynamic import: the module
// resolves its log path once and caches it for the process lifetime, which is
// exactly what a running server does. Each test therefore uses its own report
// key so the cases stay independent.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";

const dir = mkdtempSync(path.join(os.tmpdir(), "sendguard-"));
process.env.WEEKLY_REPORT_STATE_FILE = path.join(dir, "sends.json");
const { alreadySentFor, recordSentFor } = await import("./reportShared.js");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const WEEK = "2026-08-08..2026-08-14";
const NEXT = "2026-08-15..2026-08-21";

describe("one send per reporting window", () => {
  it("reports nothing sent before anything is recorded", async () => {
    expect(await alreadySentFor("untouched", WEEK)).toBe(false);
  });

  it("blocks a repeat of the same window", async () => {
    expect(await recordSentFor("repeat", WEEK)).toBe(true);
    expect(await alreadySentFor("repeat", WEEK)).toBe(true);
  });

  it("lets the next week through", async () => {
    await recordSentFor("nextweek", WEEK);
    expect(await alreadySentFor("nextweek", NEXT)).toBe(false);
  });

  it("keeps the three reports independent", async () => {
    await recordSentFor("summary", WEEK);
    expect(await alreadySentFor("dealmatch", WEEK)).toBe(false);
    expect(await alreadySentFor("slippage", WEEK)).toBe(false);
    await recordSentFor("dealmatch", WEEK);
    expect(await alreadySentFor("dealmatch", WEEK)).toBe(true);
    // Recording one report must not clear another's entry.
    expect(await alreadySentFor("summary", WEEK)).toBe(true);
  });

  it("survives repeated boots recording the same window", async () => {
    for (let i = 0; i < 5; i++) await recordSentFor("boots", WEEK);
    expect(await alreadySentFor("boots", WEEK)).toBe(true);
    expect(await alreadySentFor("boots", NEXT)).toBe(false);
  });
});
