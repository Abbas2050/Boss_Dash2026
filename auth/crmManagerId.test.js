// @vitest-environment node
//
// `crm_manager_id` on the dashboard user record: the field GET
// /api/sales/commission reads to decide whose commission a caller may see.
//
// It is tested here rather than through the route because the route takes the
// value as already-resolved -- these are the boundaries where it is parsed,
// stored and handed to the session, and each one has a way of failing silently:
// a string that matches nothing, a null that reads as set, a SELECT that forgot
// the column, a stale copy riding inside an eight-hour JWT.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { USERS_ADDED_COLUMNS, parseCrmManagerId, toAuthUser } from "./router.js";

const ROUTER = readFileSync(path.resolve("auth/router.js"), "utf8");

describe("parseCrmManagerId", () => {
  it("tells absent apart from cleared", () => {
    // The difference decides whether an update leaves a salesperson's view
    // alone or revokes it.
    expect(parseCrmManagerId(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseCrmManagerId(null)).toEqual({ ok: true, value: null });
    expect(parseCrmManagerId("")).toEqual({ ok: true, value: null });
    expect(parseCrmManagerId("   ")).toEqual({ ok: true, value: null });
  });

  it("stores a number, including when it arrives as a string", () => {
    // `28 === "28"` is false, and the commission join compares this to FXBO's
    // numeric managerId -- so a string stored verbatim would match none of the
    // salesperson's own clients and report an empty book with no error.
    expect(parseCrmManagerId(28)).toEqual({ ok: true, value: 28 });
    expect(parseCrmManagerId("28")).toEqual({ ok: true, value: 28 });
    expect(parseCrmManagerId(" 28 ")).toEqual({ ok: true, value: 28 });
  });

  it("rejects rubbish rather than quietly nulling it", () => {
    // A silently dropped typo would leave the admin believing they had made
    // someone a salesperson and the salesperson looking at a 403.
    for (const bad of ["abc", "28abc", 0, -5, 2.5, "2.5", Infinity, NaN, {}, [], true]) {
      expect(parseCrmManagerId(bad), JSON.stringify(bad) ?? String(bad)).toEqual({ ok: false });
    }
  });
});

describe("toAuthUser", () => {
  const row = {
    id: 7,
    name: "Mitul",
    email: "mitul@example.com",
    role: "Analyst",
    status: "active",
    access_json: '["Sales"]',
  };

  it("leaves the key out entirely for a user who is not a salesperson", () => {
    // Not null and not zero. A null would serialise into every session payload
    // and every user list as a field that looks set-but-empty, and 0 is a
    // manager id as far as a `!= null` check is concerned.
    const user = toAuthUser({ ...row, crm_manager_id: null });
    expect(user).not.toHaveProperty("crmManagerId");
    expect(JSON.stringify(user)).not.toContain("crmManagerId");
    expect(toAuthUser({ ...row, crm_manager_id: 0 })).not.toHaveProperty("crmManagerId");
  });

  it("surfaces a usable id as a number", () => {
    expect(toAuthUser({ ...row, crm_manager_id: 28 }).crmManagerId).toBe(28);
    // Drivers and JSON columns have returned numerics as strings before.
    expect(toAuthUser({ ...row, crm_manager_id: "28" }).crmManagerId).toBe(28);
  });
});

describe("the wiring that would fail silently", () => {
  it("names crm_manager_id in every SELECT that builds a user", () => {
    // toAuthUser reads row.crm_manager_id. A SELECT that lists access_json but
    // not this column yields a user with no crmManagerId -- so the salesperson
    // gets a 403 and nothing anywhere says why.
    const selects = ROUTER.match(/SELECT [^"']*FROM users[^"']*/g) || [];
    const buildUsers = selects.filter((s) => s.includes("access_json"));
    expect(buildUsers.length).toBeGreaterThan(3);
    for (const select of buildUsers) {
      expect(select, select).toContain("crm_manager_id");
    }
  });

  it("keeps crmManagerId out of the signed token", () => {
    // A JWT lives eight hours. This field decides whose money a caller can
    // look at, so there must be exactly one source for it and it must be the
    // one an admin can change -- the database row, re-read on every request.
    const payload = ROUTER.slice(ROUTER.indexOf("function signUserToken"));
    const body = payload.slice(0, payload.indexOf("AUTH_JWT_SECRET"));
    expect(body).not.toContain("crmManagerId");
    expect(body).not.toContain("crm_manager_id");
  });

  it("sets crmManagerId on req.auth after the token payload is spread", () => {
    // `req.auth = { ...payload, ...db fields }`. Assigned before the spread, a
    // stale claim in an old token would win.
    const authBlock = ROUTER.slice(ROUTER.indexOf("req.auth = {"));
    const spreadAt = authBlock.indexOf("...payload");
    const fieldAt = authBlock.indexOf("crmManagerId: user.crmManagerId");
    expect(spreadAt).toBeGreaterThan(-1);
    expect(fieldAt).toBeGreaterThan(spreadAt);
  });

  it("allows Sales as an access root", () => {
    // sanitizeAccess drops any chip whose root is not on this list, so without
    // the entry the Sales chip would be silently stripped on every save and the
    // nav item would never appear.
    const roots = ROUTER.slice(
      ROUTER.indexOf("const ALLOWED_ACCESS_ROOTS"),
      ROUTER.indexOf("const LOGIN_WINDOW_MS"),
    );
    expect(roots).toContain('"Sales"');
  });

  it("migrates the column onto a table that already exists", () => {
    // CREATE TABLE IF NOT EXISTS will not add a column to the deployed `users`
    // table, and every SELECT above now names it.
    expect(USERS_ADDED_COLUMNS).toEqual([
      ["crm_manager_id", "ALTER TABLE users ADD COLUMN crm_manager_id INT NULL"],
    ]);
    // Guarded on information_schema, because MySQL 8 rejects the MariaDB
    // "ADD COLUMN IF NOT EXISTS" shorthand this would otherwise want.
    expect(ROUTER).toContain("information_schema.COLUMNS");
    expect(USERS_ADDED_COLUMNS.every(([, sql]) => !/IF NOT EXISTS/i.test(sql))).toBe(true);
  });

  it("writes the column on create and on update, and keeps it out of nothing else", () => {
    expect(ROUTER).toContain("INSERT INTO users (name, email, password_hash, role, status, access_json, crm_manager_id)");
    const updates = ROUTER.match(/UPDATE users SET [^"']*/g) || [];
    const profileUpdates = updates.filter((s) => s.includes("access_json"));
    expect(profileUpdates.length).toBe(2); // with and without a password change
    for (const update of profileUpdates) {
      expect(update, update).toContain("crm_manager_id=?");
    }
  });
});
