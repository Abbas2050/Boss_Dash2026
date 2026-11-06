import React, { useCallback, useEffect, useState } from "react";
import { authHeaders } from "@/lib/auth";
// Every instant is a UTC instant rendered in Dubai time: this is read on a
// phone that is not always in Dubai, and "last polled at 09:00" has to mean
// the same thing wherever it is read.
import { formatDubaiInstant } from "@/lib/dubaiTime";

const OVERVIEW_URL = "/api/meta-leads/overview";
const RETRY_URL = "/api/meta-leads/retry";
const SHEETS_URL = "/api/meta-leads/sheets";
const IMPORT_URL = "/api/meta-leads/import-existing";

type Sheet = {
  id: number;
  label: string;
  spreadsheetId: string;
  tabName: string;
  enabled: boolean;
  ib: boolean;
  sendLeadSource: boolean;
  managerId: number | null;
  language: string | null;
  status: string | null;
  tags: string | null;
  lastRowCount: number;
  lastPolledAt: string | null;
  lastError: string | null;
  bootstrappedAt: string | null;
};

type Row = {
  id: number;
  sheetLabel: string | null;
  metaLeadId: string;
  name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  adName: string | null;
  status: string;
  detail: string | null;
  crmUserId: number | null;
  attempts: number;
  nextAttemptAt: string | null;
  updatedAt: string | null;
};

type Overview = { ok: boolean; sheets: Sheet[]; counts: Record<string, number>; rows: Row[] };

/**
 * Every status a row can hold, in words rather than in the database's own.
 * "skipped_existing" is the one most worth translating: it does not mean
 * anything went wrong, it means the row was in the sheet before we started
 * watching and was deliberately never sent.
 */
const STATUS_LABEL: Record<string, string> = {
  pending: "queued",
  retrying: "retrying",
  sending: "sending",
  sent: "in the CRM",
  duplicate: "already in the CRM",
  failed: "refused",
  skipped_test: "Meta test row",
  skipped_empty: "no contact details",
  skipped_existing: "was there before",
};

const STATUS_TONE: Record<string, string> = {
  sent: "text-emerald-600 dark:text-emerald-400",
  duplicate: "text-amber-600 dark:text-amber-400",
  retrying: "text-amber-600 dark:text-amber-400",
  failed: "text-rose-600 dark:text-rose-400",
};

/**
 * A new sheet, before it is saved. The spreadsheet field takes a pasted URL
 * as readily as a bare id -- pasting the URL is what anyone will actually do,
 * and the server pulls the id out of it.
 *
 * Everything below `language` defaults to off or empty, which is the whole
 * point: the three sheets in use differ in nothing but their label, so any
 * difference between them later is one somebody chose.
 */
const BLANK_SHEET = {
  label: "",
  spreadsheetId: "",
  tabName: "Sheet1",
  language: "en",
  ib: false,
  // On by default: without it a lead arrives in FXBO with nothing naming
  // where it came from, which is the first thing anyone asks of one.
  sendLeadSource: true,
  managerId: "",
  status: "",
  tags: "",
};

export const MetaLeadsPage: React.FC = () => {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [draft, setDraft] = useState({ ...BLANK_SHEET });
  const [editingId, setEditingId] = useState<number | null>(null);
  // Which sheet has had its import armed. One click would create every lead
  // already in that sheet, so it takes two.
  const [confirmImportId, setConfirmImportId] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(OVERVIEW_URL, { headers: authHeaders() });
      const body = await response.json();
      if (!response.ok || !body?.ok) {
        setError(String(body?.error || `Could not load (HTTP ${response.status})`));
        return;
      }
      setError(null);
      setData(body as Overview);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const postSheet = useCallback(async (body: unknown) => {
    await fetch(SHEETS_URL, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await load();
  }, [load]);

  const saveSheet = useCallback(async () => {
    if (!draft.label.trim() || !draft.spreadsheetId.trim()) {
      setFormError("A label and a spreadsheet link are needed.");
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      await postSheet(editingId === null
        ? { ...draft, enabled: true }
        : { ...draft, id: editingId, enabled: true });
      setDraft({ ...BLANK_SHEET });
      setEditingId(null);
    } finally {
      setSaving(false);
    }
  }, [draft, editingId, postSheet]);

  /** Loads a registered sheet back into the one form, rather than a second one. */
  const editSheet = useCallback((sheet: Sheet) => {
    setFormError(null);
    setEditingId(sheet.id);
    setDraft({
      label: sheet.label ?? "",
      spreadsheetId: sheet.spreadsheetId ?? "",
      tabName: sheet.tabName ?? "Sheet1",
      language: sheet.language ?? "en",
      ib: sheet.ib,
      sendLeadSource: sheet.sendLeadSource,
      managerId: sheet.managerId === null ? "" : String(sheet.managerId),
      status: sheet.status ?? "",
      tags: sheet.tags ?? "",
    });
  }, []);

  // Posts the sheet back with `enabled` flipped. The save route takes the
  // whole record, so the rest of its settings travel unchanged.
  const toggleSheet = useCallback(async (sheet: Sheet) => {
    setBusyId(-sheet.id);
    try {
      await postSheet({
        id: sheet.id,
        label: sheet.label,
        spreadsheetId: sheet.spreadsheetId,
        tabName: sheet.tabName,
        language: sheet.language ?? "en",
        ib: sheet.ib,
        sendLeadSource: sheet.sendLeadSource,
        managerId: sheet.managerId ?? "",
        status: sheet.status ?? "",
        tags: sheet.tags ?? "",
        enabled: !sheet.enabled,
      });
    } finally {
      setBusyId(null);
    }
  }, [postSheet]);

  const importExisting = useCallback(async (sheetId: number) => {
    setBusyId(-sheetId);
    try {
      await fetch(IMPORT_URL, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ sheetId }),
      });
      setConfirmImportId(null);
      await load();
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const retry = useCallback(async (id: number) => {
    setBusyId(id);
    try {
      await fetch(RETRY_URL, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }, [load]);

  return (
    <div className="space-y-6 p-4">
      <header>
        <h1 className="text-xl font-semibold">Meta Leads</h1>
        <p className="text-sm text-muted-foreground">
          Every new row in these sheets becomes a lead in FXBO, once, within about a minute.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">
          {error}
        </div>
      )}

      {data && (
        <>
          <section className="flex flex-wrap gap-3">
            {Object.entries(data.counts).map(([status, count]) => (
              <div key={status} className="rounded-md border px-3 py-2 text-sm">
                <div className="text-base font-semibold">{count}</div>
                <div className="text-muted-foreground">{STATUS_LABEL[status] ?? status}</div>
              </div>
            ))}
          </section>

          <section className="space-y-2" aria-label="Sheets">
            <h2 className="text-sm font-semibold uppercase text-muted-foreground">Sheets</h2>

            <div className="rounded-md border p-3 text-sm">
              <div className="mb-2 font-medium">
                {editingId === null ? "Add a sheet" : "Edit sheet"}
              </div>
              <p className="mb-3 text-muted-foreground">
                Everything already in the sheet when you add it is recorded as “was there
                before” and never sent. Only rows that arrive afterwards reach FXBO.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground">Label</span>
                  <input
                    className="rounded border bg-transparent px-2 py-1"
                    value={draft.label}
                    onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground">Spreadsheet link or id</span>
                  <input
                    className="rounded border bg-transparent px-2 py-1"
                    value={draft.spreadsheetId}
                    onChange={(e) => setDraft({ ...draft, spreadsheetId: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground">Tab name</span>
                  <input
                    className="rounded border bg-transparent px-2 py-1"
                    value={draft.tabName}
                    onChange={(e) => setDraft({ ...draft, tabName: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground">Language</span>
                  <input
                    className="rounded border bg-transparent px-2 py-1"
                    value={draft.language}
                    onChange={(e) => setDraft({ ...draft, language: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground">Owner (manager id) — optional</span>
                  <input
                    className="rounded border bg-transparent px-2 py-1"
                    value={draft.managerId}
                    onChange={(e) => setDraft({ ...draft, managerId: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground">Tags, comma separated — optional</span>
                  <input
                    className="rounded border bg-transparent px-2 py-1"
                    value={draft.tags}
                    onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground">Status — optional</span>
                  <input
                    className="rounded border bg-transparent px-2 py-1"
                    value={draft.status}
                    onChange={(e) => setDraft({ ...draft, status: e.target.value })}
                  />
                </label>
                <div className="flex flex-col justify-end gap-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft.ib}
                      onChange={(e) => setDraft({ ...draft, ib: e.target.checked })}
                    />
                    <span>Create these as IB leads</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft.sendLeadSource}
                      onChange={(e) => setDraft({ ...draft, sendLeadSource: e.target.checked })}
                    />
                    <span>Send this sheet’s name as the lead source</span>
                  </label>
                </div>
              </div>
              {formError && (
                <div className="mt-2 text-rose-600 dark:text-rose-400">{formError}</div>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className="rounded border px-3 py-1"
                  disabled={saving}
                  onClick={() => void saveSheet()}
                >
                  {editingId === null ? "Add sheet" : "Save changes"}
                </button>
                {editingId !== null && (
                  <button
                    type="button"
                    className="rounded border px-3 py-1"
                    onClick={() => { setEditingId(null); setDraft({ ...BLANK_SHEET }); setFormError(null); }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>

            {data.sheets.map((sheet) => (
              <div key={sheet.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{sheet.label}</span>
                  <span className="flex items-center gap-3 text-muted-foreground">
                    <span>
                      {sheet.enabled ? "on" : "off"} · {sheet.lastRowCount} rows read ·{" "}
                      {sheet.lastPolledAt ? formatDubaiInstant(sheet.lastPolledAt) : "never polled"}
                    </span>
                    <button
                      type="button"
                      className="rounded border px-2 py-1"
                      onClick={() => editSheet(sheet)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="rounded border px-2 py-1"
                      disabled={busyId === -sheet.id}
                      onClick={() => void toggleSheet(sheet)}
                    >
                      {sheet.enabled ? "Turn off" : "Turn on"}
                    </button>
                  </span>
                </div>
                {!sheet.bootstrappedAt && (
                  <div className="mt-1 text-muted-foreground">
                    First read not done yet — everything already in this sheet will be recorded
                    without being sent.
                  </div>
                )}
                {sheet.lastError && (
                  <div className="mt-1 text-rose-600 dark:text-rose-400">{sheet.lastError}</div>
                )}
                {sheet.bootstrappedAt && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {confirmImportId === sheet.id ? (
                      <>
                        <span className="text-rose-600 dark:text-rose-400">
                          This creates a lead in FXBO for every row that was already in this
                          sheet. It cannot be undone from here.
                        </span>
                        <button
                          type="button"
                          className="rounded border px-2 py-1"
                          disabled={busyId === -sheet.id}
                          onClick={() => void importExisting(sheet.id)}
                        >
                          Yes, send them to FXBO
                        </button>
                        <button
                          type="button"
                          className="rounded border px-2 py-1"
                          onClick={() => setConfirmImportId(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="rounded border px-2 py-1"
                        onClick={() => setConfirmImportId(sheet.id)}
                      >
                        Send the rows already here
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </section>

          <section className="space-y-2" aria-label="Recent leads">
            <h2 className="text-sm font-semibold uppercase text-muted-foreground">Recent leads</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="p-2">Lead</th>
                    <th className="p-2">Sheet</th>
                    <th className="p-2">Ad</th>
                    <th className="p-2">Status</th>
                    <th className="p-2">When</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.id} className="border-t align-top">
                      <td className="p-2">
                        <div className="font-medium">{row.name || "(no name)"}</div>
                        <div className="text-muted-foreground">{row.email || row.phone}</div>
                      </td>
                      <td className="p-2">{row.sheetLabel}</td>
                      <td className="p-2">{row.adName}</td>
                      <td className="p-2">
                        <div className={STATUS_TONE[row.status] ?? ""}>
                          {STATUS_LABEL[row.status] ?? row.status}
                          {row.crmUserId ? ` (#${row.crmUserId})` : ""}
                        </div>
                        {row.detail && <div className="text-muted-foreground">{row.detail}</div>}
                      </td>
                      <td className="p-2 text-muted-foreground">
                        {row.updatedAt ? formatDubaiInstant(row.updatedAt) : "—"}
                      </td>
                      <td className="p-2">
                        {row.status === "failed" && (
                          <button
                            type="button"
                            className="rounded border px-2 py-1"
                            disabled={busyId === row.id}
                            onClick={() => void retry(row.id)}
                          >
                            Retry
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
};

export default MetaLeadsPage;
