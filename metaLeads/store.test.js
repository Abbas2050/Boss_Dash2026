// @vitest-environment node
//
// The queries themselves are exercised in worker.test.js through injected
// fakes; this file holds the two things a fake cannot check -- what the schema
// actually declares, and how a database row becomes the config the payload
// builder reads.
import { describe, expect, it } from "vitest";
import { META_LEAD_ROWS_SCHEMA, META_LEAD_SHEETS_SCHEMA, toSheetConfig } from "./store.js";

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
