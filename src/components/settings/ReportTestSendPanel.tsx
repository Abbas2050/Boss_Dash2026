import React, { useMemo, useState } from "react";
import { authHeaders, getCurrentUser } from "@/lib/auth";
import { describePeriod, previousFullPeriodUtc, type ReportCadence } from "@/lib/reportPeriods";

// The report emails that can be test-sent on demand. Each entry maps to the
// matching /api/reports/<endpoint>/test route on the server. All three routes
// accept an optional cadence or an optional from/to window in the body.
export const TEST_SEND_REPORTS = [
  {
    key: "slippage",
    label: "Slippage Report",
    endpoint: "/api/reports/slippage-weekly/test",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    summary: (d: any) => `${d?.lps ?? 0} LPs`,
  },
  {
    key: "dealmatch",
    label: "Deal Match Report",
    endpoint: "/api/reports/dealmatch-weekly/test",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    summary: (d: any) => `${d?.rows ?? 0} clients`,
  },
  {
    key: "summary",
    label: "Business Summary",
    endpoint: "/api/reports/summary-weekly/test",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    summary: (d: any) => `${d?.psps ?? 0} PSPs, ${d?.depositors ?? 0} active accounts`,
  },
] as const;

export type TestSendReportKey = (typeof TEST_SEND_REPORTS)[number]["key"];

// A cadence chosen in the picker, or "" for "don't send one at all".
type CadenceChoice = ReportCadence | "";

/**
 * The request body for one test send.
 *
 * CADENCE AND PERIOD ARE MUTUALLY EXCLUSIVE AND THAT IS ENFORCED HERE, in the
 * `else`, not merely suggested by the layout. The server 400s
 * cadence_period_conflict on a body carrying both, and a UI that can compose
 * that request is a UI that teaches the operator to read error codes. The
 * controls stand each other down as well, but this is the guarantee.
 *
 * An untouched panel posts `{ recipients }` and nothing else -- byte for byte
 * the request this panel sent before it grew a cadence and a date range.
 */
export function buildTestSendBody({
  recipients,
  cadence,
  from,
  to,
}: {
  recipients: string[];
  cadence: CadenceChoice;
  from: string;
  to: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = { recipients };
  if (cadence) body.cadence = cadence;
  else if (from && to) {
    body.from = from;
    body.to = to;
  }
  return body;
}

/**
 * Why a half-filled or backwards range is refused before anything is sent.
 *
 * The server would refuse both too (bad_period), but a report test send is not
 * a cheap request to burn on a typo: a Deal Match run costs about forty
 * seconds of backend time whatever window it is asked for.
 */
export function validateDateRange(from: string, to: string): string | null {
  if (!from && !to) return null;
  if (!from || !to) return "Enter both a start and an end date.";
  // YYYY-MM-DD sorts lexicographically, so this is the calendar comparison.
  if (from > to) return "The start date is after the end date.";
  return null;
}

// The server's error codes, in words. A code is a fine thing to log and a poor
// thing to show someone who was trying to send an email.
const ERROR_TEXT: Record<string, string> = {
  recipient_required: "Enter at least one recipient — a test send is never delivered to the configured report list.",
  cadence_period_conflict: "Choose a cadence or a date range, not both.",
  cadence_not_allowed: "That report's test route always sends its own cadence.",
  bad_cadence: "Choose one of daily, weekly or monthly.",
  bad_period: "Those dates are not a usable range — pick two real dates with the start on or before the end.",
  forbidden: "You do not have permission to send report tests.",
  send_failed: "The report was built but the email could not be sent.",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readableError(data: any, status: number): string {
  const mapped = typeof data?.error === "string" ? ERROR_TEXT[data.error] : undefined;
  if (mapped) return mapped;
  return data?.message || data?.error || `Failed (${status})`;
}

export const ReportTestSendPanel: React.FC = () => {
  const [kind, setKind] = useState<TestSendReportKey>("slippage");
  const [email, setEmail] = useState<string>(() => getCurrentUser()?.email || "");
  const [cadence, setCadence] = useState<CadenceChoice>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const selectedReport = TEST_SEND_REPORTS.find((r) => r.key === kind) ?? TEST_SEND_REPORTS[0];

  // Each side of the choice stands the other down, so an invalid request is not
  // something the panel can be talked into composing in the first place. Both
  // sides can always clear themselves, so neither is a trap.
  const usingCadence = cadence !== "";
  const usingDates = Boolean(from || to);
  const rangeError = validateDateRange(from, to);

  const periodHint = useMemo(() => {
    if (usingDates) {
      return rangeError ? null : describePeriod({ fromYmd: from, toYmd: to });
    }
    return describePeriod(previousFullPeriodUtc((cadence || "weekly") as ReportCadence));
  }, [usingDates, rangeError, from, to, cadence]);

  const clearPeriod = () => {
    setCadence("");
    setFrom("");
    setTo("");
  };

  const sendReportTest = async () => {
    setSending(true);
    setMsg(null);
    try {
      const recipients = email.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await fetch(selectedReport.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(buildTestSendBody({ recipients, cadence, from, to })),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        setMsg({ text: readableError(data, res.status), ok: false });
      } else {
        setMsg({
          text: `${selectedReport.label} sent to ${recipients.join(", ")} · ${selectedReport.summary(data)} · ${data.fromYmd}→${data.toYmd}`,
          ok: true,
        });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setMsg({ text: e?.message || "error", ok: false });
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border/40 bg-card/70 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Report Test Sends</h2>
          <p className="text-xs text-muted-foreground">
            Pick a report and send an on-demand test of its email so you don't have to wait for the schedule. Leave the
            period alone for the usual weekly send, or choose a cadence or an exact date range. Uses the same Brevo
            pipeline as the live report.
          </p>
        </div>
        {msg && <span className={`text-xs ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.text}</span>}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label="Report"
          value={kind}
          onChange={(e) => setKind(e.target.value as TestSendReportKey)}
          className="rounded-md border border-border bg-background/70 px-3 py-2 text-sm text-foreground"
        >
          {TEST_SEND_REPORTS.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          aria-label="Recipients"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="recipient@example.com (comma-separated for several)"
          className="min-w-[280px] flex-1 rounded-md border border-border bg-background/70 px-3 py-2 text-sm text-foreground"
        />
        <button
          type="button"
          onClick={sendReportTest}
          disabled={sending || !email.trim() || Boolean(rangeError)}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {sending ? "Sending…" : `Send ${selectedReport.label} test`}
        </button>
      </div>

      <div className="mt-3 rounded-xl border border-border/40 bg-background/40 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className={`inline-flex items-center gap-2 text-sm text-muted-foreground ${usingDates ? "opacity-40" : ""}`}>
            Cadence
            <select
              aria-label="Cadence"
              value={cadence}
              disabled={usingDates}
              onChange={(e) => setCadence(e.target.value as CadenceChoice)}
              className="rounded-md border border-border bg-background/70 px-3 py-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">Default (weekly)</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>

          <span className="text-xs uppercase tracking-wide text-muted-foreground">or</span>

          <div className={`flex flex-wrap items-center gap-2 ${usingCadence ? "opacity-40" : ""}`}>
            <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              From
              <input
                type="date"
                aria-label="From date"
                value={from}
                max={to || undefined}
                disabled={usingCadence}
                onChange={(e) => setFrom(e.target.value)}
                className="rounded-md border border-border bg-background/70 px-3 py-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              To
              <input
                type="date"
                aria-label="To date"
                value={to}
                min={from || undefined}
                disabled={usingCadence}
                onChange={(e) => setTo(e.target.value)}
                className="rounded-md border border-border bg-background/70 px-3 py-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
          </div>

          {(usingCadence || usingDates) && (
            <button
              type="button"
              onClick={clearPeriod}
              className="rounded-lg border border-border/60 bg-secondary px-3 py-2 text-sm hover:bg-secondary/80"
            >
              Clear period
            </button>
          )}
        </div>

        <div className="mt-2 text-xs">
          {rangeError ? (
            <span className="text-destructive">{rangeError}</span>
          ) : (
            <span className="text-muted-foreground">This test send {periodHint}.</span>
          )}
        </div>
      </div>
    </section>
  );
};
