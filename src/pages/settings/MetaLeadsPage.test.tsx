import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { MetaLeadsPage } from "./MetaLeadsPage";

// A sheet's label appears twice on the page -- once in the sheets list and
// once per lead in the table's Sheet column -- so every assertion about a
// sheet is scoped to the section it is really about.
const sheets = () => within(screen.getByRole("region", { name: "Sheets" }));
const leads = () => within(screen.getByRole("region", { name: "Recent leads" }));

const overview = {
  ok: true,
  counts: { sent: 4, duplicate: 1, failed: 1, skipped_existing: 36 },
  sheets: [
    {
      id: 1, label: "Meta – Iraq", spreadsheetId: "abc", tabName: "Sheet1",
      enabled: true, ib: false, sendLeadSource: false, managerId: null,
      language: "en", status: null, tags: null, lastRowCount: 31,
      lastPolledAt: "2026-11-06T09:00:00Z", lastError: null,
      bootstrappedAt: "2026-11-06T08:00:00Z",
    },
    {
      id: 2, label: "Meta – Turkey", spreadsheetId: "def", tabName: "Sheet1",
      enabled: false, ib: false, sendLeadSource: false, managerId: null,
      language: "en", status: null, tags: null, lastRowCount: 7,
      lastPolledAt: "2026-11-06T09:00:00Z",
      lastError: 'header changed: column 13 reads "first_name"',
      bootstrappedAt: null,
    },
  ],
  rows: [
    {
      id: 10, sheetId: 1, sheetLabel: "Meta – Iraq", metaLeadId: "1593296142070496",
      name: "Kaboul Mutawa", email: "a@b.com", phone: "+9647705108061", country: "IQ",
      adName: "Partners-IB-Iraq-Ad3", status: "sent", detail: null, crmUserId: 14620,
      attempts: 1, nextAttemptAt: null, updatedAt: "2026-11-06T09:00:00Z",
    },
    {
      id: 11, sheetId: 1, sheetLabel: "Meta – Iraq", metaLeadId: "2113586602691774",
      name: "Hussein Younis", email: "c@d.com", phone: "+9647826732758", country: "IQ",
      adName: "Partners-IB-Iraq-Ad2", status: "failed",
      detail: "HTTP 422: email already used", crmUserId: null,
      attempts: 6, nextAttemptAt: null, updatedAt: "2026-11-06T09:00:00Z",
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => overview })));
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MetaLeadsPage", () => {
  it("shows each registered sheet, with what it last read", async () => {
    render(<MetaLeadsPage />);
    await screen.findByRole("region", { name: "Sheets" });
    expect(sheets().getByText("Meta – Iraq")).toBeInTheDocument();
    expect(sheets().getByText("Meta – Turkey")).toBeInTheDocument();
    expect(sheets().getByText(/31 rows read/)).toBeInTheDocument();
  });

  // A disabled sheet with an error is the one state somebody has to act on,
  // so it must not read the same as a sheet that is merely off.
  it("shows why a sheet was disabled", async () => {
    render(<MetaLeadsPage />);
    await screen.findByRole("region", { name: "Sheets" });
    expect(sheets().getByText(/header changed: column 13/)).toBeInTheDocument();
  });

  it("tells a bootstrapped sheet from one that has never been read", async () => {
    render(<MetaLeadsPage />);
    await screen.findByRole("region", { name: "Sheets" });
    expect(sheets().getByText(/first read not done yet/i)).toBeInTheDocument();
  });

  it("lists the recent leads with their status", async () => {
    render(<MetaLeadsPage />);
    await screen.findByRole("region", { name: "Recent leads" });
    expect(leads().getByText("Kaboul Mutawa")).toBeInTheDocument();
    expect(leads().getByText("in the CRM (#14620)")).toBeInTheDocument();
    expect(leads().getByText("HTTP 422: email already used")).toBeInTheDocument();
  });

  it("offers a retry only on a failed row", async () => {
    render(<MetaLeadsPage />);
    await screen.findByRole("region", { name: "Recent leads" });
    expect(leads().getAllByRole("button", { name: /retry/i })).toHaveLength(1);
  });

  it("posts the retry and reloads", async () => {
    render(<MetaLeadsPage />);
    await screen.findByRole("region", { name: "Recent leads" });
    fireEvent.click(leads().getByRole("button", { name: /retry/i }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/meta-leads/retry", expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ id: 11 }),
      }));
    });
  });

  // The sheet ids are not in the code, so this form is the only way a sheet
  // ever gets watched. Without it the module is inert however well it works.
  it("registers a sheet from a pasted URL, with the defaults", async () => {
    render(<MetaLeadsPage />);
    await screen.findByRole("region", { name: "Sheets" });

    fireEvent.change(screen.getByLabelText(/label/i), { target: { value: "Meta – UAE" } });
    fireEvent.change(screen.getByLabelText(/spreadsheet/i), {
      target: { value: "https://docs.google.com/spreadsheets/d/1aSbMb79/edit?gid=0#gid=0" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add sheet/i }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/meta-leads/sheets", expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          label: "Meta – UAE",
          spreadsheetId: "https://docs.google.com/spreadsheets/d/1aSbMb79/edit?gid=0#gid=0",
          tabName: "Sheet1",
          language: "en",
          ib: false,
          sendLeadSource: true,
          managerId: "",
          status: "",
          tags: "",
          enabled: true,
        }),
      }));
    });
  });

  it("will not post a sheet with no label or no spreadsheet", async () => {
    render(<MetaLeadsPage />);
    await screen.findByRole("region", { name: "Sheets" });
    const calls = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /add sheet/i }));
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(calls);
    expect(screen.getByText(/a label and a spreadsheet link are needed/i)).toBeInTheDocument();
  });

  // Turning a sheet off is how you stop a runaway import without a deploy.
  // Turkey was registered before the lead-source decision was made, so there
  // has to be a way to change a sheet that does not involve the database.
  it("loads a sheet into the form and saves it back under its own id", async () => {
    render(<MetaLeadsPage />);
    await screen.findByRole("region", { name: "Sheets" });
    fireEvent.click(sheets().getAllByRole("button", { name: /^edit$/i })[0]);

    expect(screen.getByLabelText(/label/i)).toHaveValue("Meta – Iraq");
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/meta-leads/sheets", expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"id":1'),
      }));
    });
  });

  it("turns a sheet off from its row", async () => {
    render(<MetaLeadsPage />);
    await screen.findByRole("region", { name: "Sheets" });
    fireEvent.click(sheets().getAllByRole("button", { name: /turn off/i })[0]);
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/meta-leads/sheets", expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"enabled":false'),
      }));
    });
  });

  it("says so when the overview cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 500, json: async () => ({ ok: false, error: "pool is not initialized" }),
    })));
    render(<MetaLeadsPage />);
    expect(await screen.findByText(/pool is not initialized/)).toBeInTheDocument();
  });
});
