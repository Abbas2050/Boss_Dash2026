import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authHeaders } from "@/lib/auth";
// Every instant here is a UTC instant. The business runs on Dubai time and this
// dashboard is read on a phone that is not always there, so nothing is rendered
// with the reader's own zone.
import { formatDubaiInstant } from "@/lib/dubaiTime";

const OVERVIEW_URL = "/api/crm-events/overview";

const STAGE_LABELS: Record<string, string> = {
  lead: "Lead",
  registered: "Registered",
  verified: "Verified",
  live_account: "Live account",
  first_deposit: "First deposit",
};

const DESTINATIONS = [
  ["meta", "Meta"],
  ["whatsapp", "WhatsApp"],
  ["brevo", "Brevo"],
] as const;

/** A status that means something needs attention, as opposed to one that is
 *  simply not applicable at this stage. */
const PROBLEM = new Set(["failed", "rejected", "invalid", "retrying"]);

/** Every status the backend can record, in the backend's own order
 *  (crmSignup/stats.js STATUSES). All seven are shown on purpose: a counter set
 *  that leaves out `pending` cannot show a dead dispatch worker, and one that
 *  leaves out `invalid` shows a clean card for rows the table flags. */
const DESTINATION_STATUSES = ["pending", "sent", "skipped", "retrying", "failed", "rejected", "invalid"];

type Counts = Record<string, number>;

type DestinationStatus = { status: string; detail: string | null; attempts: number };

type EventRow = {
  id: number;
  receivedAt: string;
  stage: string;
  crmClientId: string;
  name: string;
  email: string;
  phone: string;
  recordType: string;
  source: string;
  meta: DestinationStatus;
  whatsapp: DestinationStatus;
  brevo: DestinationStatus;
};

/** One FXBO rule's health. `everSeen` is what separates a rule that fired and
 *  then went quiet (worth a warning) from one that never existed (not). */
type StageHealth = {
  lastReceivedAt: string | null;
  ageHours: number | null;
  stale: boolean;
  everSeen: boolean;
};

type Overview = {
  windowDays: number;
  health: {
    lastReceivedAt: string | null;
    ageHours: number | null;
    stale: boolean;
    /** Optional on purpose: the page must still render, and still raise the
     *  overall warning, if a response ever arrives without it. */
    stages?: Record<string, StageHealth>;
  };
  funnel: Counts;
  destinations: Record<string, Counts>;
  events: EventRow[];
};

/** A bare duration -- "5 minutes", "1 hour", "4 days" -- for the caller to put
 *  "ago" or "for" in front of or behind. */
function describeAge(hours: number | null | undefined): string {
  if (!Number.isFinite(hours)) return "an unknown time";
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (hours < 48) {
    const whole = Math.round(hours);
    return `${whole} hour${whole === 1 ? "" : "s"}`;
  }
  return `${Math.round(hours / 24)} days`;
}

function toneFor(status: string): string {
  if (status === "sent") return "text-emerald-600 dark:text-emerald-400";
  if (PROBLEM.has(status)) return "text-red-600 dark:text-red-400";
  return "text-muted-foreground";
}

/** A stage warns only when it fired and then stopped. A stage that has never
 *  fired is not stale, whatever else the payload claims. */
function isQuiet(stage: StageHealth | undefined): boolean {
  return Boolean(stage && stage.everSeen && stage.stale);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A response that is not an overview at all (a proxy's empty body, say) must
 *  read as a failed load. Rendering it would either crash the page or, worse,
 *  build a calm-looking one out of nothing. */
function isOverview(body: unknown): body is Overview {
  return (
    isRecord(body) &&
    isRecord(body.health) &&
    isRecord(body.funnel) &&
    isRecord(body.destinations) &&
    Array.isArray(body.events)
  );
}

const CARD = "rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800/80 dark:bg-slate-950/70";
const SECTION_TITLE = "mb-2 text-sm font-semibold uppercase tracking-wide text-primary";
const CONTROL = "rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900/70";

export function CrmEventsPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState("all");
  const [problemsOnly, setProblemsOnly] = useState(false);
  // Which request is the latest. Changing the period twice quickly puts two
  // requests in flight, and the slower one must not overwrite the newer one's
  // numbers while the selector reads the newer period.
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latestRequest.current;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${OVERVIEW_URL}?days=${days}`, { headers: { ...authHeaders() } });
      if (!resp.ok) throw new Error(String(resp.status));
      const body: unknown = await resp.json();
      if (!isOverview(body)) throw new Error("not an overview");
      if (mine === latestRequest.current) setData(body);
    } catch {
      // The server's message can name internal schema, so it is not shown.
      if (mine === latestRequest.current) {
        setError("Could not load CRM events.");
        setData(null);
      }
    } finally {
      if (mine === latestRequest.current) setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const all = data?.events ?? [];
    return all.filter((row) => {
      if (stage !== "all" && row.stage !== stage) return false;
      if (!problemsOnly) return true;
      return [row.meta, row.whatsapp, row.brevo].some((d) => PROBLEM.has(d?.status));
    });
  }, [data, stage, problemsOnly]);

  const stages = data?.health.stages ?? {};
  const quietStages = Object.keys(STAGE_LABELS).filter((key) => isQuiet(stages[key]));

  return (
    <div className="min-h-screen bg-background p-3 sm:p-4 md:p-6 lg:p-8">
      <div className="mx-auto max-w-[1300px] space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">CRM Events</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Every FXBO funnel webhook, and what we sent to Meta, WhatsApp and Brevo.
            </p>
          </div>
          <label className="text-sm">
            <span className="mr-2">Period</span>
            <select
              aria-label="Period"
              className={CONTROL}
              value={String(days)}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
          </label>
        </header>

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-3 text-sm text-rose-700 dark:text-rose-200"
          >
            {error}
          </div>
        ) : null}

        {data?.health.stale ? (
          <div
            role="alert"
            className="rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-3 text-sm text-amber-800 dark:text-amber-200"
          >
            {data.health.lastReceivedAt
              ? `No CRM events for ${describeAge(data.health.ageHours)}. A rule in FXBO may have stopped firing.`
              : "No CRM events received at all. Check that the FXBO rules exist and point at this endpoint."}
          </div>
        ) : null}

        {quietStages.length > 0 ? (
          <div
            role="alert"
            className="rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-3 text-sm text-amber-800 dark:text-amber-200"
          >
            <div className="font-medium">An FXBO rule may have stopped firing.</div>
            <ul className="mt-1 list-disc pl-5">
              {quietStages.map((key) => (
                <li key={key}>
                  {STAGE_LABELS[key]}: no event for {describeAge(stages[key].ageHours)}.
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {loading && !data ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

        {data ? (
          <>
            <section>
              <h2 className={SECTION_TITLE}>Health</h2>
              {data.health.stale ? null : (
                <p className="mb-2 text-sm text-muted-foreground">Last event {describeAge(data.health.ageHours)} ago.</p>
              )}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {Object.entries(STAGE_LABELS).map(([key, label]) => {
                  const s = stages[key];
                  const state = !s
                    ? "Not reported"
                    : !s.everSeen
                      ? "Never received"
                      : isQuiet(s)
                        ? `Quiet for ${describeAge(s.ageHours)}`
                        : "Receiving";
                  const tone = isQuiet(s)
                    ? "text-amber-700 dark:text-amber-300"
                    : s?.everSeen
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-muted-foreground";
                  return (
                    <div key={key} data-testid={`stage-health-${key}`} className={CARD}>
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div className={`text-sm font-semibold ${tone}`}>{state}</div>
                      {s?.everSeen ? (
                        <div className="text-[11px] text-muted-foreground">
                          Last seen {formatDubaiInstant(s.lastReceivedAt)} Dubai
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>

            <section>
              <h2 className={SECTION_TITLE}>Funnel</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {Object.entries(STAGE_LABELS).map(([key, label]) => (
                  <div key={key} data-testid={`funnel-${key}`} className={CARD}>
                    <div className="text-2xl font-semibold tabular-nums text-foreground">{data.funnel[key] ?? 0}</div>
                    <div className="text-xs text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h2 className={SECTION_TITLE}>Destinations</h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {DESTINATIONS.map(([key, label]) => {
                  const counts = data.destinations[key] ?? {};
                  return (
                    <div key={key} data-testid={`dest-${key}`} className={CARD}>
                      <div className="mb-1 text-sm font-medium text-foreground">{label}</div>
                      <dl className="grid grid-cols-2 gap-x-3 text-sm">
                        {DESTINATION_STATUSES.map((status) => (
                          <div key={status} className="flex justify-between">
                            <dt className={toneFor(status)}>{status}</dt>
                            <dd className="tabular-nums">{counts[status] ?? 0}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  );
                })}
              </div>
            </section>

            <section>
              <div className="mb-2 flex flex-wrap items-center gap-4">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-primary">Events</h2>
                <label className="text-sm">
                  <span className="mr-2">Stage</span>
                  <select
                    aria-label="Stage"
                    className={CONTROL}
                    value={stage}
                    onChange={(e) => setStage(e.target.value)}
                  >
                    <option value="all">All stages</option>
                    {Object.entries(STAGE_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label="Problems only"
                    checked={problemsOnly}
                    onChange={(e) => setProblemsOnly(e.target.checked)}
                  />
                  Problems only
                </label>
              </div>

              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {data.events.length === 0 ? "No events in this period." : "No events match these filters."}
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-100 text-[11px] uppercase tracking-wide text-muted-foreground dark:bg-slate-900/80">
                      <tr>
                        <th className="p-2 text-left">Received (Dubai)</th>
                        <th className="p-2 text-left">Stage</th>
                        <th className="p-2 text-left">CRM id</th>
                        <th className="p-2 text-left">Name</th>
                        <th className="p-2 text-left">Email</th>
                        <th className="p-2 text-left">Phone</th>
                        <th className="p-2 text-left">Form</th>
                        <th className="p-2 text-left">Meta</th>
                        <th className="p-2 text-left">WhatsApp</th>
                        <th className="p-2 text-left">Brevo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id} className="border-t border-slate-200 align-top dark:border-slate-800">
                          <td className="p-2 whitespace-nowrap">{formatDubaiInstant(row.receivedAt)}</td>
                          <td className="p-2">{STAGE_LABELS[row.stage] ?? row.stage}</td>
                          <td className="p-2">{row.crmClientId}</td>
                          <td className="p-2">{row.name}</td>
                          <td className="p-2">{row.email}</td>
                          <td className="p-2">{row.phone}</td>
                          <td className="p-2">{row.source}</td>
                          {DESTINATIONS.map(([key]) => {
                            const d = row[key];
                            const status = d?.status ?? "—";
                            return (
                              <td key={key} className="p-2">
                                <span className={`font-medium ${toneFor(status)}`}>{status}</span>
                                {d?.detail ? <div className="text-[11px] text-muted-foreground">{d.detail}</div> : null}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
