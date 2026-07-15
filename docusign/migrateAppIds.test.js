import { describe, expect, it } from "vitest";
import { decideRowActions } from "./migrateAppIds.js";

const row = (id, applicationId, updatedAt) => ({ id, application_id: applicationId, updated_at: updatedAt });

describe("decideRowActions", () => {
  it("leaves already-clean rows alone", () => {
    const r = decideRowActions([row(1, "3525", "2026-06-01")]);
    expect(r.updates).toEqual([]);
    expect(r.deletes).toEqual([]);
    expect(r.supersedes).toEqual([]);
  });

  it("normalizes an HTML row when there is no conflict", () => {
    const r = decideRowActions([row(2, '<a href="x">3891</a>', "2026-06-01")]);
    expect(r.updates).toEqual([{ id: 2, applicationId: "3891" }]);
  });

  it("deletes junk rows with no digits", () => {
    const r = decideRowActions([row(3, "Application ID + Link", "2026-06-01")]);
    expect(r.deletes).toEqual([3]);
    expect(r.updates).toEqual([]);
  });

  it("on collision keeps the newest row and supersedes the older", () => {
    const rows = [
      row(10, "3892", "2026-06-24T14:20:58Z"),
      row(11, '<a href="x">3892</a>', "2026-06-24T10:19:19Z"),
    ];
    const r = decideRowActions(rows);
    expect(r.supersedes).toEqual([11]);
    expect(r.updates).toEqual([]);
    expect(r.deletes).toEqual([]);
  });

  it("on collision where the HTML row is newer, supersedes the older plain row and normalizes the winner", () => {
    const rows = [
      row(20, "3900", "2026-06-01T00:00:00Z"),
      row(21, '<a href="x">3900</a>', "2026-07-01T00:00:00Z"),
    ];
    const r = decideRowActions(rows);
    expect(r.supersedes).toEqual([20]);
    expect(r.updates).toEqual([{ id: 21, applicationId: "3900" }]);
  });

  it("reports a summary", () => {
    const r = decideRowActions([
      row(1, "3525", "2026-06-01"),
      row(2, '<a href="x">3891</a>', "2026-06-01"),
      row(3, "Application ID + Link", "2026-06-01"),
    ]);
    expect(r.summary).toEqual({ scanned: 3, normalized: 1, deleted: 1, superseded: 0 });
  });
});
