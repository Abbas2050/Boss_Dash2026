// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { makeMetaLeadsOverviewHandler, makeMetaLeadsRetryHandler, makeMetaLeadsSaveSheetHandler } from "./router.js";

const res = () => {
  const r = { statusCode: 200, body: null };
  r.status = vi.fn((code) => { r.statusCode = code; return r; });
  r.json = vi.fn((payload) => { r.body = payload; return r; });
  return r;
};

describe("the overview handler", () => {
  it("answers the sheets, the counts and the recent rows", async () => {
    const handler = makeMetaLeadsOverviewHandler({
      listSheets: vi.fn(async () => [{ id: 1, label: "Meta – Iraq", enabled: true }]),
      listRecentRows: vi.fn(async () => [{ id: 10, meta_lead_id: "1", status: "sent", email: "a@b.com" }]),
      countRowsByStatus: vi.fn(async () => ({ sent: 4, duplicate: 1 })),
    });
    const r = res();
    await handler({ query: {} }, r);
    expect(r.statusCode).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.sheets).toHaveLength(1);
    expect(r.body.counts).toEqual({ sent: 4, duplicate: 1 });
    expect(r.body.rows[0].metaLeadId).toBe("1");
  });

  it("answers 500 with the reason when a read fails", async () => {
    const handler = makeMetaLeadsOverviewHandler({
      listSheets: vi.fn(async () => { throw new Error("pool is not initialized"); }),
      listRecentRows: vi.fn(async () => []),
      countRowsByStatus: vi.fn(async () => ({})),
    });
    const r = res();
    await handler({ query: {} }, r);
    expect(r.statusCode).toBe(500);
    expect(r.body.error).toMatch(/pool is not initialized/);
  });
});

describe("the save-sheet handler", () => {
  it("creates a sheet with the defaults the design names", async () => {
    const insertSheet = vi.fn(async () => ({ id: 3 }));
    const handler = makeMetaLeadsSaveSheetHandler({ insertSheet, updateSheet: vi.fn(), kick: vi.fn() });
    const r = res();
    await handler({ body: { label: "Meta – UAE", spreadsheetId: "xyz" } }, r);
    expect(insertSheet).toHaveBeenCalledWith(expect.objectContaining({
      label: "Meta – UAE", spreadsheetId: "xyz", tabName: "Sheet1",
      enabled: true, ib: false, sendLeadSource: false,
      managerId: null, language: "en", status: null, tags: null,
    }));
    expect(r.body).toEqual({ ok: true, id: 3 });
  });

  // A spreadsheet URL pasted whole is the obvious thing to do, and the id in
  // the middle of it is the only part that works.
  it("accepts a pasted spreadsheet URL", async () => {
    const insertSheet = vi.fn(async () => ({ id: 4 }));
    const handler = makeMetaLeadsSaveSheetHandler({ insertSheet, updateSheet: vi.fn(), kick: vi.fn() });
    await handler({ body: { label: "L", spreadsheetId: "https://docs.google.com/spreadsheets/d/1-lAAXoq/edit?gid=0#gid=0" } }, res());
    expect(insertSheet).toHaveBeenCalledWith(expect.objectContaining({ spreadsheetId: "1-lAAXoq" }));
  });

  it("updates when given an id", async () => {
    const updateSheet = vi.fn(async () => {});
    const handler = makeMetaLeadsSaveSheetHandler({ insertSheet: vi.fn(), updateSheet, kick: vi.fn() });
    await handler({ body: { id: 2, label: "Meta – Turkey", spreadsheetId: "abc", ib: true, managerId: "20" } }, res());
    expect(updateSheet).toHaveBeenCalledWith(2, expect.objectContaining({ ib: true, managerId: 20 }));
  });

  it("refuses a sheet with no label or no spreadsheet", async () => {
    const handler = makeMetaLeadsSaveSheetHandler({ insertSheet: vi.fn(), updateSheet: vi.fn(), kick: vi.fn() });
    const r = res();
    await handler({ body: { label: "" } }, r);
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toMatch(/label and spreadsheetId are required/);
  });

  it("refuses a manager id that is not a positive whole number", async () => {
    const handler = makeMetaLeadsSaveSheetHandler({ insertSheet: vi.fn(), updateSheet: vi.fn(), kick: vi.fn() });
    const r = res();
    await handler({ body: { label: "L", spreadsheetId: "a", managerId: "twenty" } }, r);
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toMatch(/managerId/);
  });

  it("names the collision when the same tab is registered twice", async () => {
    const insertSheet = vi.fn(async () => { const e = new Error("dup"); e.code = "ER_DUP_ENTRY"; throw e; });
    const handler = makeMetaLeadsSaveSheetHandler({ insertSheet, updateSheet: vi.fn(), kick: vi.fn() });
    const r = res();
    await handler({ body: { label: "L", spreadsheetId: "abc" } }, r);
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toMatch(/already registered/);
  });
});

describe("the retry handler", () => {
  it("requeues the row and wakes the worker", async () => {
    const requeueRow = vi.fn(async () => true);
    const kick = vi.fn();
    const handler = makeMetaLeadsRetryHandler({ requeueRow, kick });
    const r = res();
    await handler({ body: { id: 10 } }, r);
    expect(requeueRow).toHaveBeenCalledWith(10);
    expect(kick).toHaveBeenCalled();
    expect(r.body).toEqual({ ok: true, requeued: true });
  });

  // Only a failed row can be requeued; a sent one must not be sent twice.
  it("reports a row it could not requeue, and does not wake the worker", async () => {
    const kick = vi.fn();
    const handler = makeMetaLeadsRetryHandler({ requeueRow: vi.fn(async () => false), kick });
    const r = res();
    await handler({ body: { id: 10 } }, r);
    expect(r.body).toEqual({ ok: true, requeued: false });
    expect(kick).not.toHaveBeenCalled();
  });

  it("refuses a request with no id", async () => {
    const handler = makeMetaLeadsRetryHandler({ requeueRow: vi.fn(), kick: vi.fn() });
    const r = res();
    await handler({ body: {} }, r);
    expect(r.statusCode).toBe(400);
  });
});
