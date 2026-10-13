// @vitest-environment node
//
// The SQL layer, run against a fake pool. A fake pool cannot tell us how MySQL
// behaves, but it does show which statement runs, which parameter binds to which
// placeholder, and how a duplicate-key error becomes a return value. Those are
// the things a careless edit to store.js would change silently.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import {
  SIGNUP_EVENTS_SCHEMA,
  INSERT_COLUMNS,
  buildInsertParams,
  initCrmSignupStore,
  findExistingFbc,
  insertSignupEvent,
  markSignupInvalid,
  claimDueEvents,
  updateMetaStatus,
  updateWhatsappStatus,
  updateBrevoStatus,
  listEventsSince,
} from "./store.js";

// The env vars are read when store.js loads, so they are set before the import.
// The values are throwaway: nothing here connects to anything.
const db = vi.hoisted(() => {
  process.env.AUTH_DB_HOST = "db.test";
  process.env.AUTH_DB_NAME = "crm_test";
  process.env.AUTH_DB_USER = "crm_test";
  process.env.AUTH_DB_PASSWORD = "test-only";
  const state = {
    calls: [],
    // mysql2 resolves [result, fields]; store.js destructures the first element.
    respond: () => [{ affectedRows: 1, insertId: 1 }],
  };
  const pool = {
    query: async (sql, params) => {
      state.calls.push({ sql, params });
      return state.respond(sql, params);
    },
  };
  return { state, pool };
});

vi.mock("mysql2/promise", () => ({ default: { createPool: () => db.pool } }));

const FIELDS = {
  stage: "registered",
  crmClientId: "88214",
  firstName: "Ali",
  middleName: "Hassan",
  lastName: "Khan",
  email: "ali.khan@example.com",
  phone: "+971507192185",
  recordType: "client",
  marketingConsent: true,
  source: "SVG",
  entity: "SVG Ltd",
  isIb: false,
  language: "en",
  utmSource: "meta",
  utmMedium: "cpc",
  utmCampaign: "zero-spread",
  referer: "https://skylinkscapital.com/en/",
  fullLink: "https://skylinkscapital.com/en/?fbclid=ABC",
  fxboUniqueId: "d3f1-aa",
};

const at = (params, column) => params[INSERT_COLUMNS.indexOf(column)];
const duplicateKeyError = () => Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062 });

let ddlCalls = [];

beforeAll(async () => {
  await initCrmSignupStore();
  ddlCalls = db.state.calls.splice(0);
});

beforeEach(() => {
  db.state.calls.length = 0;
  db.state.respond = () => [{ affectedRows: 1, insertId: 1 }];
});

describe("initCrmSignupStore", () => {
  it("creates the table from the schema text", () => {
    expect(ddlCalls).toHaveLength(1);
    expect(ddlCalls[0].sql).toBe(SIGNUP_EVENTS_SCHEMA);
  });
});

describe("insertSignupEvent", () => {
  it("runs one plain INSERT with the builder's parameters, and reports the new id", async () => {
    db.state.respond = () => [{ affectedRows: 1, insertId: 42 }];
    const derived = { fbc: "fb.1.1673035686000.ABC" };
    const result = await insertSignupEvent(FIELDS, derived, "{}");
    expect(db.state.calls).toHaveLength(1);
    expect(db.state.calls[0].sql).toMatch(/^\s*INSERT INTO signup_events \(/);
    expect(db.state.calls[0].sql).not.toMatch(/ON DUPLICATE/i);
    expect(db.state.calls[0].params).toEqual(buildInsertParams(FIELDS, derived, "{}"));
    expect(result).toEqual({ inserted: true, id: 42 });
  });

  it("reports a duplicate as not inserted, with a genuine null id", async () => {
    db.state.respond = () => {
      throw duplicateKeyError();
    };
    const result = await insertSignupEvent(FIELDS, {}, "{}");
    expect(result).toEqual({ inserted: false, id: null });
    expect(result.id).toBeNull();
  });

  it("rethrows any other database error rather than reporting a duplicate", async () => {
    db.state.respond = () => {
      throw Object.assign(new Error("Data too long"), { code: "ER_DATA_TOO_LONG" });
    };
    await expect(insertSignupEvent(FIELDS, {}, "{}")).rejects.toThrow("Data too long");
  });

  it("stores an invalid payload's statuses in that same single statement", async () => {
    await insertSignupEvent(FIELDS, {}, "{}", "missing required fields: email");
    expect(db.state.calls).toHaveLength(1);
    const { params } = db.state.calls[0];
    for (const action of ["meta", "whatsapp", "brevo"]) {
      expect(at(params, `${action}_status`), action).toBe("invalid");
    }
    expect(at(params, "brevo_detail")).toBe("missing required fields: email");
  });
});

describe("findExistingFbc", () => {
  it("takes the earliest click on file, breaking a one-second tie by id", async () => {
    db.state.respond = () => [[{ fbc: "fb.1.1.EARLIEST" }]];
    expect(await findExistingFbc(88214)).toBe("fb.1.1.EARLIEST");
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(/ORDER BY received_at ASC, id ASC\s+LIMIT 1/);
    expect(params).toEqual(["88214"]);
  });

  it("returns empty when no click is on file, and never queries for the word undefined", async () => {
    db.state.respond = () => [[]];
    expect(await findExistingFbc(undefined)).toBe("");
    expect(db.state.calls[0].params).toEqual([""]);
  });
});

describe("claimDueEvents", () => {
  it("selects due rows by three independent clauses, each on its own status and clock", async () => {
    db.state.respond = () => [[]];
    const now = new Date("2026-10-13T10:00:00Z");
    await claimDueEvents(25, now);
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(
      /meta_status\s+IN \('pending','retrying'\)\s+AND \(meta_next_attempt_at\s+IS NULL\s+OR meta_next_attempt_at\s+<= \?\)/
    );
    expect(sql).toMatch(
      /whatsapp_status\s+IN \('pending','retrying'\)\s+AND \(whatsapp_next_attempt_at\s+IS NULL\s+OR whatsapp_next_attempt_at\s+<= \?\)/
    );
    expect(sql).toMatch(
      /brevo_status\s+IN \('pending','retrying'\)\s+AND \(brevo_next_attempt_at\s+IS NULL\s+OR brevo_next_attempt_at\s+<= \?\)/
    );
    expect(params).toEqual([now, now, now, 25]);
  });

  it("defaults a zero limit to 25", async () => {
    db.state.respond = () => [[]];
    await claimDueEvents(0, new Date(0));
    expect(db.state.calls[0].params.at(-1)).toBe(25);
  });
});

describe("markSignupInvalid", () => {
  it("updates only the one client and stage, marking all three actions invalid with the same detail", async () => {
    await markSignupInvalid("88214", "registered", "missing required fields: email");
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(/meta_status = 'invalid'/);
    expect(sql).toMatch(/whatsapp_status = 'invalid'/);
    expect(sql).toMatch(/brevo_status = 'invalid'/);
    expect(sql).toMatch(/WHERE crm_client_id = \? AND stage = \?/);
    const detail = "missing required fields: email";
    expect(params).toEqual([detail, detail, detail, "88214", "registered"]);
  });

  it("truncates a long detail to 500 characters", async () => {
    await markSignupInvalid("88214", "registered", "x".repeat(900));
    expect(db.state.calls[0].params[0]).toHaveLength(500);
  });
});

describe("the three action writers", () => {
  const next = new Date("2026-10-13T11:00:00Z");

  it("updateMetaStatus writes only the meta columns", async () => {
    await updateMetaStatus(7, { status: "retrying", detail: "boom", attempts: 2, nextAttemptAt: next });
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(
      /SET meta_status = \?, meta_detail = \?, meta_attempts = \?, meta_next_attempt_at = \?\s+WHERE id = \?/
    );
    expect(sql).not.toMatch(/whatsapp|brevo/);
    expect(params).toEqual(["retrying", "boom", 2, next, 7]);
  });

  it("updateWhatsappStatus writes only the whatsapp columns, and never the frozen request id", async () => {
    await updateWhatsappStatus(7, { status: "sent", messageId: "msg-1", detail: "ok", attempts: 1, nextAttemptAt: null });
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(
      /SET whatsapp_status = \?, whatsapp_message_id = \?, whatsapp_detail = \?,\s*whatsapp_attempts = \?, whatsapp_next_attempt_at = \?\s+WHERE id = \?/
    );
    expect(sql).not.toMatch(/whatsapp_request_id|meta_|brevo_/);
    expect(params).toEqual(["sent", "msg-1", "ok", 1, null, 7]);
  });

  it("updateBrevoStatus writes only the brevo columns", async () => {
    await updateBrevoStatus(7, { status: "sent", detail: "", attempts: 0, nextAttemptAt: null });
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(
      /SET brevo_status = \?, brevo_detail = \?, brevo_attempts = \?, brevo_next_attempt_at = \?\s+WHERE id = \?/
    );
    expect(sql).not.toMatch(/meta_|whatsapp/);
    expect(params).toEqual(["sent", null, 0, null, 7]);
  });
});

describe("listEventsSince", () => {
  it("selects newest first, capped, from the cutoff", async () => {
    const since = new Date("2026-09-13T00:00:00Z");
    await listEventsSince(since);
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(/WHERE received_at >= \?\s+ORDER BY received_at DESC\s+LIMIT \?/);
    expect(params).toEqual([since, 2000]);
  });
});
