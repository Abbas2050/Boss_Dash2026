import React, { useEffect, useState } from "react";
import { authHeaders } from "@/lib/auth";

// The shape GET /api/reports/schedule returns. Built from REPORT_SCHEDULES on
// the server, so this panel never carries its own list of the nine reports --
// a tenth appears here the moment it is scheduled.
export type RecipientChainEntry = {
  var: string;
  recipients: string[];
  status: "active" | "overridden" | "unset";
};

export type ResolvedSetting = {
  var: string;
  value: string;
  default: string;
  source: "env" | "default";
};

export type ScheduledReportView = {
  label: string;
  report: string;
  cadence: string;
  enabled: boolean;
  enabledVar: string;
  cron: ResolvedSetting;
  timezone: ResolvedSetting;
  recipientChain: RecipientChainEntry[];
  activeVar: string | null;
  recipients: string[];
  willNotSend: boolean;
};

export type ReportScheduleView = {
  reports: ScheduledReportView[];
  total: number;
  willNotSendCount: number;
  readOnlyNote: string;
};

export const REPORT_SCHEDULE_ENDPOINT = "/api/reports/schedule";

/**
 * One row of the recipient chain.
 *
 * THIS IS THE POINT OF THE WHOLE PANEL. resolveRecipients returns the first
 * non-empty variable and stops, so a chain of two means the second one is dead
 * weight whenever the first carries anything. An operator adding an address to
 * the shared list needs to see that it will be ignored BEFORE they add it, not
 * after a week of wondering why the report did not change. So an overridden
 * variable is shown -- with its addresses, struck through, and the name of the
 * variable that is beating it -- rather than hidden for tidiness.
 */
const ChainRow: React.FC<{ entry: RecipientChainEntry; activeVar: string | null }> = ({ entry, activeVar }) => {
  const tone =
    entry.status === "active"
      ? "border-success/40 bg-success/10"
      : entry.status === "overridden"
        ? "border-warning/40 bg-warning/10"
        : "border-border/40 bg-background/40";

  return (
    <li className={`rounded-lg border px-3 py-2 ${tone}`}>
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-[11px] text-foreground">{entry.var}</code>
        {entry.status === "active" && (
          <span className="rounded bg-success/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success">
            In use
          </span>
        )}
        {entry.status === "overridden" && (
          <span className="rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
            Overridden
          </span>
        )}
        {entry.status === "unset" && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Not set
          </span>
        )}
      </div>

      {entry.recipients.length > 0 ? (
        <div className={`mt-1 break-words text-xs ${entry.status === "overridden" ? "text-muted-foreground line-through" : "text-foreground"}`}>
          {entry.recipients.join(", ")}
        </div>
      ) : (
        <div className="mt-1 text-xs text-muted-foreground">empty</div>
      )}

      {entry.status === "overridden" && (
        <div className="mt-1 text-[11px] text-warning">
          Ignored for this report — <code className="font-mono">{activeVar}</code> is set, and only the first non-empty
          variable is used. Editing this line changes nothing here.
        </div>
      )}
    </li>
  );
};

// One card per report rather than one row of a wide table: the primary reader
// opens this on a phone, and the repo's tables already stack into cards at that
// width. A grid would either scroll sideways or shrink the addresses to nothing.
const ReportCard: React.FC<{ report: ScheduledReportView }> = ({ report }) => (
  <article
    data-testid={`report-${report.label}`}
    className={`rounded-xl border p-4 ${report.willNotSend ? "border-destructive/50 bg-destructive/5" : "border-border/40 bg-background/40"}`}
  >
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-base font-semibold text-foreground">{report.report}</h3>
      <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-secondary-foreground">
        {report.cadence}
      </span>
      {report.enabled ? (
        <span className="text-[11px] text-muted-foreground">Enabled</span>
      ) : (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Disabled
        </span>
      )}
    </div>

    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
      <div>
        <span className="font-semibold text-foreground">Schedule:</span>{" "}
        <code className="font-mono text-foreground">{report.cron.value}</code> ({report.timezone.value})
        {report.cron.source === "env" ? (
          <>
            {" "}
            — set by <code className="font-mono">{report.cron.var}</code>, overriding the default{" "}
            <code className="font-mono">{report.cron.default}</code>
          </>
        ) : (
          <> — the coded default; <code className="font-mono">{report.cron.var}</code> is not set</>
        )}
      </div>
      <div>
        <span className="font-semibold text-foreground">Enabled flag:</span>{" "}
        <code className="font-mono">{report.enabledVar}</code>
      </div>
    </div>

    {report.willNotSend && (
      <p className="mt-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive">
        Will not send: no recipients in any of {report.recipientChain.map((e) => e.var).join(", ")}. The scheduled run
        fires, logs one line and sends nothing.
      </p>
    )}

    <ul className="mt-2 list-none space-y-2">
      {report.recipientChain.map((entry) => (
        <ChainRow key={entry.var} entry={entry} activeVar={report.activeVar} />
      ))}
    </ul>
  </article>
);

export const ReportScheduleRecipientsPanel: React.FC = () => {
  const [view, setView] = useState<ReportScheduleView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(REPORT_SCHEDULE_ENDPOINT, { headers: { ...authHeaders() } });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(
            res.status === 403
              ? "You do not have permission to view report recipients."
              : data?.message || data?.error || `Failed (${res.status})`,
          );
        } else {
          setView(data as ReportScheduleView);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="rounded-2xl border border-border/40 bg-card/70 p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Report Schedule &amp; Recipients</h2>
          <p className="text-xs text-muted-foreground">
            Who actually receives each scheduled report, and when it goes out. Each report reads a list of recipient
            variables and uses the <strong>first one that is not empty</strong> — the rest are ignored entirely, not
            merged. Read-only: these live in the server's <code className="font-mono">.env</code> and take effect on
            restart, so there is nothing to save here.
          </p>
        </div>
        {view && view.willNotSendCount > 0 && (
          <span className="rounded-lg border border-destructive/50 bg-destructive/10 px-2 py-1 text-xs font-semibold text-destructive">
            {view.willNotSendCount} will not send
          </span>
        )}
      </div>

      {loading && <p className="text-xs text-muted-foreground">Loading…</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}

      {view && (
        <>
          <p className="mb-2 text-xs text-muted-foreground">
            {view.total} scheduled report{view.total === 1 ? "" : "s"}.
          </p>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {view.reports.map((report) => (
              <ReportCard key={report.label} report={report} />
            ))}
          </div>
        </>
      )}
    </section>
  );
};
