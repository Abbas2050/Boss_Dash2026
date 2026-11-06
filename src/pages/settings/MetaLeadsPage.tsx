import React, { useCallback, useEffect, useState } from "react";
import { authHeaders } from "@/lib/auth";
// Every instant is a UTC instant rendered in Dubai time: this is read on a
// phone that is not always in Dubai, and "last polled at 09:00" has to mean
// the same thing wherever it is read.
import { formatDubaiInstant } from "@/lib/dubaiTime";

const OVERVIEW_URL = "/api/meta-leads/overview";
const RETRY_URL = "/api/meta-leads/retry";

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

export const MetaLeadsPage: React.FC = () => {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

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
            {data.sheets.map((sheet) => (
              <div key={sheet.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{sheet.label}</span>
                  <span className="text-muted-foreground">
                    {sheet.enabled ? "on" : "off"} · {sheet.lastRowCount} rows read ·{" "}
                    {sheet.lastPolledAt ? formatDubaiInstant(sheet.lastPolledAt) : "never polled"}
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
