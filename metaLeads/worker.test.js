// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { drainOnce, MAX_ATTEMPTS, pollSheetOnce, wantsFullRead } from "./worker.js";

const HEADER = ["id","created_time","ad_id","ad_name","adset_id","adset_name","campaign_id","campaign_name","form_id","form_name","is_organic","platform","email","phone_number","first_name","last_name","country","lead_status"];
const leadRow = (id, email) => ["l:" + id,"2026-11-04T06:19:44-05:00","ag:1","Ad3","as:1","Partners-IB-Iraq","c:1","Partners-IB","f:1","Form","false","fb",email,"p:+9647705108061","Kaboul","Mutawa","IQ","CREATED"];

const sheet = (over = {}) => ({
  id: 1, label: "Meta – Iraq", spreadsheetId: "abc", tabName: "Sheet1",
  enabled: true, ib: false, sendLeadSource: false, managerId: null,
  language: "en", status: null, tags: null, lastRowCount: 0,
  lastPolledAt: null, lastFullReadAt: null, lastError: null,
  bootstrappedAt: "2026-11-06T00:00:00Z", ...over,
});

const pollDeps = (over = {}) => ({
  readHeaderAndRows: vi.fn(async () => ({ header: HEADER, rows: [], firstRowNumber: 2 })),
  insertLeadRow: vi.fn(async () => ({ inserted: true, id: 1 })),
  markSheetPolled: vi.fn(async () => {}),
  markSheetBootstrapped: vi.fn(async () => {}),
  disableSheetWithError: vi.fn(async () => {}),
  now: () => new Date("2026-11-06T09:00:00Z"),
  ...over,
});

describe("wantsFullRead", () => {
  const now = new Date("2026-11-06T09:00:00Z");

  it("is due when the sheet has never had one", () => {
    expect(wantsFullRead({ lastFullReadAt: null }, now)).toBe(true);
  });

  it("is not due within the hour", () => {
    expect(wantsFullRead({ lastFullReadAt: "2026-11-06T08:30:00Z" }, now)).toBe(false);
  });

  it("is due after the hour", () => {
    expect(wantsFullRead({ lastFullReadAt: "2026-11-06T07:30:00Z" }, now)).toBe(true);
  });

  // A stored timestamp in the future means the clock it was written by is not
  // the clock we are reading it with -- which happened on 2026-11-06, five
  // hours out, and silently stopped the full read for good. Subtracting a
  // future instant gives a negative age that is never an hour old, so the
  // sheet would never reconcile again and nothing would say why.
  it("is due when the last one is somehow in the future", () => {
    expect(wantsFullRead({ lastFullReadAt: "2026-11-06T14:00:00Z" }, now)).toBe(true);
  });

  it("is due when the timestamp cannot be read at all", () => {
    expect(wantsFullRead({ lastFullReadAt: "not a date" }, now)).toBe(true);
  });
});

describe("pollSheetOnce", () => {
  it("queues a new row as pending", async () => {
    const deps = pollDeps({
      readHeaderAndRows: vi.fn(async () => ({ header: HEADER, rows: [leadRow("1", "a@b.com")], firstRowNumber: 2 })),
    });
    const result = await pollSheetOnce(sheet(), deps);
    expect(deps.insertLeadRow).toHaveBeenCalledWith(1, expect.objectContaining({ metaLeadId: "1", email: "a@b.com" }), "pending");
    expect(result.inserted).toBe(1);
  });

  it("files a test row under skipped_test without sending it", async () => {
    const deps = pollDeps({
      readHeaderAndRows: vi.fn(async () => ({ header: HEADER, rows: [leadRow("2", "test@meta.com")], firstRowNumber: 2 })),
    });
    await pollSheetOnce(sheet(), deps);
    expect(deps.insertLeadRow).toHaveBeenCalledWith(1, expect.anything(), "skipped_test");
  });

  // The thing that makes going live safe: 36 leads the team has already
  // worked must not be re-created.
  it("marks every existing row skipped_existing on the first poll", async () => {
    const deps = pollDeps({
      readHeaderAndRows: vi.fn(async () => ({ header: HEADER, rows: [leadRow("1", "a@b.com"), leadRow("2", "c@d.com")], firstRowNumber: 2 })),
    });
    const result = await pollSheetOnce(sheet({ bootstrappedAt: null }), deps);
    expect(deps.insertLeadRow).toHaveBeenNthCalledWith(1, 1, expect.anything(), "skipped_existing");
    expect(deps.insertLeadRow).toHaveBeenNthCalledWith(2, 1, expect.anything(), "skipped_existing");
    expect(deps.markSheetBootstrapped).toHaveBeenCalledWith(1);
    expect(result.bootstrapped).toBe(true);
  });

  it("stops a sheet whose header moved instead of importing it", async () => {
    const moved = [...HEADER];
    [moved[12], moved[13]] = [moved[13], moved[12]];
    const deps = pollDeps({
      readHeaderAndRows: vi.fn(async () => ({ header: moved, rows: [leadRow("1", "a@b.com")], firstRowNumber: 2 })),
    });
    const result = await pollSheetOnce(sheet(), deps);
    expect(deps.disableSheetWithError).toHaveBeenCalledWith(1, expect.stringMatching(/column 13/));
    expect(deps.insertLeadRow).not.toHaveBeenCalled();
    expect(result.disabled).toBe(true);
  });

  it("advances the row count so the next poll reads only what is new", async () => {
    const deps = pollDeps({
      readHeaderAndRows: vi.fn(async () => ({ header: HEADER, rows: [leadRow("1", "a@b.com")], firstRowNumber: 31 })),
    });
    await pollSheetOnce(sheet({ lastRowCount: 30 }), deps);
    expect(deps.markSheetPolled).toHaveBeenCalledWith(1, expect.objectContaining({ rowCount: 31, error: null }));
  });

  // A Google outage must leave the sheet exactly where it was, or the rows it
  // could not read this minute become rows it never reads.
  it("records the error and does not move the row count", async () => {
    const deps = pollDeps({
      readHeaderAndRows: vi.fn(async () => { throw new Error("The caller does not have permission"); }),
    });
    await pollSheetOnce(sheet({ lastRowCount: 30 }), deps);
    expect(deps.markSheetPolled).toHaveBeenCalledWith(1, expect.objectContaining({ rowCount: 30, error: expect.stringMatching(/permission/) }));
  });

  // The windowed read would never see a row inserted above the end, or one
  // edited after it arrived. The hourly full read is what finds them, and the
  // unique lead id is what stops it sending anything twice.
  it("reads the whole sheet once an hour and the window otherwise", async () => {
    const read = vi.fn(async () => ({ header: HEADER, rows: [], firstRowNumber: 2 }));
    const base = pollDeps({ readHeaderAndRows: read });

    await pollSheetOnce(sheet({ lastRowCount: 30, lastFullReadAt: "2026-11-06T08:50:00Z" }), base);
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ fromRow: 31 }), expect.anything());

    await pollSheetOnce(sheet({ lastRowCount: 30, lastFullReadAt: "2026-11-06T07:00:00Z" }), base);
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ fromRow: 1 }), expect.anything());
  });

  it("skips a row whose lead id is already known", async () => {
    const deps = pollDeps({
      readHeaderAndRows: vi.fn(async () => ({ header: HEADER, rows: [leadRow("1", "a@b.com")], firstRowNumber: 2 })),
      insertLeadRow: vi.fn(async () => ({ inserted: false, id: null })),
    });
    const result = await pollSheetOnce(sheet(), deps);
    expect(result.inserted).toBe(0);
  });
});

const dbRow = (over = {}) => ({
  id: 10, sheet_id: 1, meta_lead_id: "1", first_name: "Kaboul", last_name: "Mutawa",
  email: "a@b.com", phone: "+9647705108061", country: "IQ",
  lead_source: "Partners-IB-Iraq", utm_params: "utm_medium=paid_social",
  campaign_name: "Partners-IB", adset_name: "Partners-IB-Iraq", ad_name: "Ad3",
  status: "pending", attempts: 0, ...over,
});

const drainDeps = (over = {}) => ({
  listDueRows: vi.fn(async () => [dbRow()]),
  claimRow: vi.fn(async () => true),
  getSheet: vi.fn(async () => sheet()),
  findLeadByEmail: vi.fn(async () => null),
  createLead: vi.fn(async () => ({ ok: true, status: 200, userId: 14620, detail: null })),
  settleRow: vi.fn(async () => {}),
  deferRow: vi.fn(async () => {}),
  now: () => new Date("2026-11-06T09:00:00Z"),
  ...over,
});

describe("drainOnce", () => {
  it("creates the lead and records the CRM id", async () => {
    const deps = drainDeps();
    const result = await drainOnce(deps);
    expect(deps.createLead).toHaveBeenCalledWith(expect.objectContaining({ lead: true, email: "a@b.com" }));
    expect(deps.settleRow).toHaveBeenCalledWith(10, { status: "sent", detail: null, crmUserId: 14620 });
    expect(result.sent).toBe(1);
  });

  it("skips a row whose email is already in the CRM", async () => {
    const deps = drainDeps({ findLeadByEmail: vi.fn(async () => ({ id: 14613 })) });
    const result = await drainOnce(deps);
    expect(deps.createLead).not.toHaveBeenCalled();
    expect(deps.settleRow).toHaveBeenCalledWith(10, { status: "duplicate", detail: "already in the CRM as user 14613", crmUserId: 14613 });
    expect(result.duplicate).toBe(1);
  });

  // Skip on email, allow on phone: two people may share an office line.
  it("sends a row with no email without looking anyone up", async () => {
    const deps = drainDeps({ listDueRows: vi.fn(async () => [dbRow({ email: null })]) });
    await drainOnce(deps);
    expect(deps.findLeadByEmail).not.toHaveBeenCalled();
    expect(deps.createLead).toHaveBeenCalled();
  });

  it("leaves a row alone when another worker claimed it first", async () => {
    const deps = drainDeps({ claimRow: vi.fn(async () => false) });
    await drainOnce(deps);
    expect(deps.createLead).not.toHaveBeenCalled();
  });

  it("defers a transient refusal with a backoff", async () => {
    const deps = drainDeps({ createLead: vi.fn(async () => ({ ok: false, status: 503, userId: null, detail: "HTTP 503: upstream" })) });
    const result = await drainOnce(deps);
    expect(deps.deferRow).toHaveBeenCalledWith(10, expect.objectContaining({ detail: "HTTP 503: upstream" }));
    expect(deps.settleRow).not.toHaveBeenCalled();
    expect(result.deferred).toBe(1);
  });

  it("fails a permanent refusal immediately, with the CRM's wording", async () => {
    const deps = drainDeps({ createLead: vi.fn(async () => ({ ok: false, status: 422, userId: null, detail: "HTTP 422: email already used" })) });
    const result = await drainOnce(deps);
    expect(deps.settleRow).toHaveBeenCalledWith(10, { status: "failed", detail: "HTTP 422: email already used", crmUserId: null });
    expect(result.failed).toBe(1);
  });

  it("gives up after the last attempt rather than retrying for ever", async () => {
    const deps = drainDeps({
      listDueRows: vi.fn(async () => [dbRow({ attempts: MAX_ATTEMPTS - 1 })]),
      createLead: vi.fn(async () => ({ ok: false, status: 503, userId: null, detail: "HTTP 503: upstream" })),
    });
    await drainOnce(deps);
    expect(deps.deferRow).not.toHaveBeenCalled();
    expect(deps.settleRow).toHaveBeenCalledWith(10, expect.objectContaining({ status: "failed" }));
  });

  // A lookup that threw is not "nobody has this address".
  it("defers when the duplicate check itself fails", async () => {
    const deps = drainDeps({ findLeadByEmail: vi.fn(async () => { throw new Error("CRM users lookup failed (503)"); }) });
    await drainOnce(deps);
    expect(deps.createLead).not.toHaveBeenCalled();
    expect(deps.deferRow).toHaveBeenCalledWith(10, expect.objectContaining({ detail: expect.stringMatching(/503/) }));
  });
});
