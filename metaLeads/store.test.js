// @vitest-environment node
//
// The queries themselves are exercised in worker.test.js through injected
// fakes; this file holds the two things a fake cannot check -- what the schema
// actually declares, and how a database row becomes the config the payload
// builder reads.
import { describe, expect, it } from "vitest";
import {
  CLAIM_ROW_SQL,
  DUE_ROWS_SQL,
  META_LEAD_ROWS_SCHEMA,
  META_LEAD_SHEETS_SCHEMA,
  POOL_OPTIONS,
  RECLAIM_AFTER_MINUTES,
  SESSION_TIME_ZONE_SQL,
  toSheetConfig,
} from "./store.js";

describe("the schema", () => {
  // The whole deduplication strategy: a re-read of a sheet collides at the
  // database rather than in a check-then-act race between two app-pool workers.
  it("makes the Meta lead id unique", () => {
    expect(META_LEAD_ROWS_SCHEMA).toMatch(/UNIQUE KEY uq_meta_lead_rows_lead \(meta_lead_id\)/);
  });

  it("indexes the rows the drain looks for", () => {
    expect(META_LEAD_ROWS_SCHEMA).toMatch(/KEY idx_meta_lead_rows_due \(status, next_attempt_at\)/);
  });

  it("refuses two registrations of the same tab", () => {
    expect(META_LEAD_SHEETS_SCHEMA).toMatch(/UNIQUE KEY uq_meta_lead_sheets_source \(spreadsheet_id, tab_name\)/);
  });

  it("defaults every optional lead field to off or empty", () => {
    expect(META_LEAD_SHEETS_SCHEMA).toMatch(/ib TINYINT\(1\) NOT NULL DEFAULT 0/);
    expect(META_LEAD_SHEETS_SCHEMA).toMatch(/send_lead_source TINYINT\(1\) NOT NULL DEFAULT 0/);
    expect(META_LEAD_SHEETS_SCHEMA).toMatch(/manager_id INT UNSIGNED NULL/);
    expect(META_LEAD_SHEETS_SCHEMA).toMatch(/tags VARCHAR\(512\) NULL/);
    expect(META_LEAD_SHEETS_SCHEMA).toMatch(/status VARCHAR\(64\) NULL/);
  });

  it("starts a sheet un-bootstrapped, so its existing rows are never sent", () => {
    expect(META_LEAD_SHEETS_SCHEMA).toMatch(/bootstrapped_at DATETIME NULL/);
  });
});

// A row is moved to `sending` before the CRM is called, so a worker that dies
// mid-send -- an app pool recycle, which this host does routinely, or the
// outright stop it suffered twice this month -- leaves the row in a status
// nothing looks at again. The lead would be lost silently, and the tab's
// retry button cannot reach it either, because that only moves a failure.
describe("a send interrupted by a dying worker", () => {
  it("looks for rows stranded in sending as well as the due ones", () => {
    expect(DUE_ROWS_SQL).toMatch(/status IN \('pending', 'retrying'\)/);
    expect(DUE_ROWS_SQL).toMatch(
      new RegExp(`status = 'sending'[\\s\\S]*INTERVAL ${RECLAIM_AFTER_MINUTES} MINUTE`),
    );
  });

  // The age is re-checked inside the claim, not just in the search. Without
  // that, two workers reading the same stranded row would both claim it:
  // the first sets status to sending, which is what the second is matching on.
  it("re-checks the age when claiming, so only one worker takes it", () => {
    expect(CLAIM_ROW_SQL).toMatch(
      new RegExp(`status = 'sending'[\\s\\S]*INTERVAL ${RECLAIM_AFTER_MINUTES} MINUTE`),
    );
    expect(CLAIM_ROW_SQL).toMatch(/SET status = 'sending', attempts = attempts \+ 1, updated_at = UTC_TIMESTAMP\(\)/);
  });

  it("waits long enough that a send in flight is not taken from under it", () => {
    expect(RECLAIM_AFTER_MINUTES).toBeGreaterThanOrEqual(10);
  });
});

// Found live on 2026-11-06: last_polled_at came back five hours in the
// future. Columns written with UTC_TIMESTAMP() store a UTC wall clock, the
// defaults written with CURRENT_TIMESTAMP store the session's, and mysql2
// parses DATETIME in the Node process's zone -- which on this host is US
// Eastern. Three bases for one kind of value. Pinning the session and the
// driver to UTC makes all three the same.
describe("time", () => {
  it("reads and writes datetimes as UTC", () => {
    expect(POOL_OPTIONS.timezone).toBe("Z");
  });

  it("pins the session clock to UTC, so the column defaults agree", () => {
    expect(SESSION_TIME_ZONE_SQL).toMatch(/SET SESSION time_zone = '\+00:00'/);
  });
});

describe("toSheetConfig", () => {
  it("turns a database row into the config the payload builder wants", () => {
    expect(toSheetConfig({
      id: 1, label: "Meta – Iraq", spreadsheet_id: "abc", tab_name: "Sheet1",
      enabled: 1, ib: 0, send_lead_source: 0, manager_id: null, language: "en",
      status: null, tags: null, last_row_count: 31, last_polled_at: null,
      last_full_read_at: null, last_error: null, bootstrapped_at: null,
    })).toEqual({
      id: 1, label: "Meta – Iraq", spreadsheetId: "abc", tabName: "Sheet1",
      enabled: true, ib: false, sendLeadSource: false, managerId: null,
      language: "en", status: null, tags: null, lastRowCount: 31,
      lastPolledAt: null, lastFullReadAt: null, lastError: null, bootstrappedAt: null,
    });
  });

  // MySQL answers TINYINT(1) as 0/1, and a payload carrying ib: 0 is not the
  // same request as one carrying ib: false.
  it("turns the TINYINTs into real booleans", () => {
    const config = toSheetConfig({ id: 1, enabled: 1, ib: 1, send_lead_source: 1 });
    expect(config.enabled).toBe(true);
    expect(config.ib).toBe(true);
    expect(config.sendLeadSource).toBe(true);
  });
});
