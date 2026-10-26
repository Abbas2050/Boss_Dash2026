// The Sales page must take every visibility decision from the server's `scope`
// and never from the local session. jsdom (the project default) is fine for
// this; reading a file needs no node environment.
//
// SalesDepartmentPage.test.tsx already proves the behaviour with polluted
// payloads, and this is the second gate on the same rule: a behavioural test
// can only catch a local-role read that changes what is rendered for the
// fixtures it happens to use, whereas this catches the read itself. Roles and
// `access[]` live in localStorage (src/lib/auth.ts), so a salesperson can edit
// their own role -- which is the entire reason GET /api/sales/commission exists
// rather than a UI filter (spec §4).
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const FILE = "src/pages/departments/SalesDepartmentPage.tsx";
const SOURCE = readFileSync(path.resolve(FILE), "utf8");

// Comments are stripped before scanning, so that the file may freely EXPLAIN
// what it must not do. Only executable code is judged.
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe(`${FILE} decides from the server's scope`, () => {
  const FORBIDDEN: [string, string][] = [
    ["getCurrentUser", "the local user record is not the authority on what may be shown"],
    ["@/lib/permissions", "nav permissions decide the nav, never the figures on the page"],
    ["localStorage", "an editable store must not decide what a page renders"],
    ["sessionStorage", "same reason as localStorage"],
    ['=== "Super Admin"', "the role is a localStorage string; the server already answered this question"],
    [".role", "same reason"],
  ];

  for (const [token, why] of FORBIDDEN) {
    it(`never reads ${token}`, () => {
      expect(CODE, `${FILE} contains ${token}: ${why}.`).not.toContain(token);
    });
  }

  it("gates revenue on the scope the server sent", () => {
    // The columns follow the caller's scope; whether a figure exists follows
    // `revenue.available` and `degraded`, which is a different question.
    expect(CODE).toContain('scope === "all"');
    expect(CODE).toContain("revenue?.available !== true");
  });

  it("never falls back to a zero revenue figure", () => {
    // `degraded: ["revenue"]` leaves the revenue keys absent. A `?? 0` here
    // would turn a failed fetch into the claim that nothing was earned.
    expect(CODE).not.toContain("revenueUsd ?? 0");
    expect(CODE).not.toContain("marginAfterCommissionUsd ?? 0");
    expect(CODE).not.toContain("revenueUsd || 0");
  });

  it("reads the commission figure the server computed", () => {
    // The page must not multiply lots by the rate itself: the rate, the basis
    // and the rounding all live in sales/commissionCore.js, and a second
    // implementation here would be a second answer to "what is owed".
    expect(CODE).toContain("commissionUsd");
    expect(CODE).not.toContain("usdPerCfdLot *");
    expect(CODE).not.toContain("* report.rate");
    expect(CODE).not.toContain("cfdLots *");
  });
});
