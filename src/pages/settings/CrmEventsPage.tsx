import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authHeaders } from "@/lib/auth";
// Every instant here is a UTC instant. The business runs on Dubai time and this
// dashboard is read on a phone that is not always there, so nothing is rendered
// with the reader's own zone.
import { formatDubaiInstant } from "@/lib/dubaiTime";

const OVERVIEW_URL = "/api/crm-events/overview";
const REQUEUE_URL = "/api/crm-events/requeue";

/** The four destinations one control resends together.
 *
 *  Safe to repeat, each for its own reason: Meta deduplicates server events that
 *  share an event id and an event name, the Brevo call is an upsert, OpenAI
 *  deduplicates on the event `id` -- which this service derives from
 *  `<crm_client_id>:<stage>` and therefore reuses unchanged on every retry and
 *  every resend -- and Google Ads deduplicates on the `orderId`, which is that
 *  same `<crm_client_id>:<stage>` string. So a row that did in fact go through
 *  is not counted twice or contacted twice, and there is nothing to be gained by
 *  making an operator press four buttons.
 *
 *  Google's is the narrowest of the four and is still enough. Google documents
 *  exactly one rule -- an order id may be used for one conversion per conversion
 *  action, refused as `DUPLICATE_ORDER_ID` -- so a resend of a row whose first
 *  send succeeded and whose response was lost comes back refused rather than
 *  booked a second time. Nothing in that exchange reaches a person at all.
 *
 *  WhatsApp is deliberately not in here (2026-10-14, user's call). It has none
 *  of those properties, and a `failed` or `rejected` WhatsApp row may already
 *  have reached the handset -- DoubleTick can answer 2xx carrying a status
 *  outside our allowlist, which we record as `rejected` on purpose so that the
 *  value gets found. Resending one of those sends a second welcome. It gets its
 *  own control, its own warning in plain sight, and its own confirmation.
 *
 *  **The test for this list is "would a repeat reach a person twice", not "is a
 *  repeat wasted".** An OpenAI resend of a row older than seven days reaches
 *  nobody and sends nothing -- the worker skips it and the count below never
 *  offered it -- so the window is a reason the number is smaller, never a reason
 *  for a warning. */
const SAFE_TO_REPEAT = ["meta", "brevo", "openai", "google"] as const;

const STAGE_LABELS: Record<string, string> = {
  lead: "Lead",
  registered: "Registered",
  verified: "Verified",
  live_account: "Live account",
  first_deposit: "First deposit",
};

/** The five destinations, in the backend's own order (crmSignup/store.js
 *  DESTINATIONS), with the name an operator knows each by. OpenAI's column is
 *  `openai_*` and its requeue key is `openai`, but the thing it feeds is the
 *  ChatGPT Ads conversion setup screen, which is where anybody reading this tab
 *  would go to check it.
 *
 *  `google` is the same shape of name: the column and the requeue key are
 *  `google*`, and "Google Ads" is what the screen holding the conversion actions
 *  is called. Leaving it out of this list is not an error anywhere -- the
 *  backend has carried `google_status`, `google_detail` and `google_attempts`
 *  since 2026-10-21 and the requeue endpoint has always accepted it -- it simply
 *  deletes a working destination's card, its column and its resend from the one
 *  page built to show them. */
const DESTINATIONS = [
  ["meta", "Meta"],
  ["whatsapp", "WhatsApp"],
  ["brevo", "Brevo"],
  ["openai", "ChatGPT Ads"],
  ["google", "Google Ads"],
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

/** What DoubleTick later said became of one message.
 *
 *  `status` is their word, verbatim and never rewritten here: the exact string
 *  WhatsApp's read receipt arrives as is NOT documented, so an unexpected value
 *  has to be visible on this page rather than folded into a word of ours. All
 *  three are null until their webhook arrives, which is the ordinary state for
 *  the first minute or two after a signup. */
type Delivery = { status: string | null; at: string | null; detail: string | null };

type DestinationStatus = {
  status: string;
  detail: string | null;
  attempts: number;
  /** WhatsApp's alone. Optional because a response from a server that predates
   *  the status webhook must still render the rest of the page. */
  delivery?: Delivery;
  /** Brevo's alone: the id of the contact it created, which is the one piece of
   *  proof in that exchange that a person can open. Null on an update -- Brevo
   *  mints an id only when it creates -- and the detail says so. */
  contactId?: string | null;
};

type EventRow = {
  id: number;
  receivedAt: string;
  /** When the row's client fields were nulled, or null if they never were. */
  scrubbedAt: string | null;
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
  openai: DestinationStatus;
  google: DestinationStatus;
};

/** One FXBO rule's health. `everSeen` is what separates a rule that fired and
 *  then went quiet (worth a warning) from one that never existed (not). */
type StageHealth = {
  lastReceivedAt: string | null;
  ageHours: number | null;
  stale: boolean;
  everSeen: boolean;
};

/** Per destination, how many failures the resend would pick up and the two
 *  reasons it can no longer reach the rest.
 *
 *  Not the same numbers as `destinations`, and it has to be its own field for
 *  two reasons: those counters follow the selected period, and they count rows
 *  whose client data has been scrubbed, which cannot be resent at all. A button
 *  promising 40 and delivering 12 is worse than no button.
 *
 *  **The three account for every failure a destination has**, which is the only
 *  reason they are all here: `scrubbed` is the thirty-day backstop, and
 *  `expired` is OpenAI's 7-day window -- rows that still hold their client data
 *  and that OpenAI refuses on their age alone. It is zero for the other four,
 *  which have no deadline the backend can write. Show one of the two and the
 *  subtraction looks complete when it is not, which is worse than showing
 *  neither.
 *
 *  **`expired` for google is a literal zero that does not mean "none yet", and
 *  that is why this page never prints it.** Google's conversion actions do have
 *  a 90-day limit, but it is measured from the CLICK, and the click is not an
 *  instant this table holds (the reasoning is in crmSignup/store.js
 *  `sendableWindow`). So no honest count could be written, the backend writes a
 *  zero to keep every answer the same shape, and a zero rendered beside
 *  OpenAI's real number would read as "nothing of Google's has expired" when
 *  what it means is "we cannot tell from here". The number is left unshown and
 *  the Resend card says so in words instead. */
type Resendable = { resendable: number; scrubbed: number; expired: number };

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
  /** Optional on purpose, like `health.stages`: a response from a server that
   *  predates the resend must still render the rest of the page. The controls
   *  then read zero and say there is nothing to resend, which is the safe
   *  direction to be wrong in. */
  requeue?: Record<string, Resendable>;
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

/**
 * The symbol each row shows per destination, and why there are four of them.
 *
 * The ask was "tick or cross -- tick means sent, cross means some error". Two
 * symbols would mislead every day: Meta and ChatGPT Ads are `skipped` on EVERY
 * registration by design, so a binary reading paints a red cross on every row
 * of the commonest case, and a dashboard with a permanent red column is a
 * dashboard nobody reads. `pending` and `retrying` are the other half: a send
 * still in the air is neither a success nor a fault, and calling it either is
 * wrong within the minute.
 *
 * Google Ads is the clearest case of all and needed nothing added here, which is
 * the point of a shared vocabulary: its commonest value by far is a `skipped`
 * for a signup that carried no gclid, and `skipped` already reads as NONE. A
 * cross there would have put a red mark on nearly every row of the table.
 *
 *   OK      a send that succeeded, or -- for WhatsApp -- one DoubleTick has
 *           since reported delivered or read
 *   BAD     failed, rejected or invalid, and a WhatsApp message DoubleTick
 *           reports as not delivered
 *   NONE    skipped: deliberately not sent, which is not a fault
 *   WAITING pending or retrying: on its way, nothing to conclude yet
 *   UNKNOWN a status this page has never heard of. Not silently a tick and not
 *           silently a cross; the word beside it is the whole point.
 */
const MARKS = {
  ok: { symbol: "✓", tone: "text-emerald-600 dark:text-emerald-400" },
  bad: { symbol: "✗", tone: "text-red-600 dark:text-red-400" },
  none: { symbol: "–", tone: "text-muted-foreground" },
  waiting: { symbol: "⋯", tone: "text-muted-foreground" },
  unknown: { symbol: "?", tone: "text-amber-700 dark:text-amber-300" },
} as const;

type MarkState = keyof typeof MARKS;

/** Every status the backend records, mapped to its symbol. All seven are here;
 *  a status missing from this map reads as `unknown` and shows its own word,
 *  rather than defaulting into whichever state was convenient. */
const STATE_OF: Record<string, MarkState> = {
  sent: "ok",
  failed: "bad",
  rejected: "bad",
  invalid: "bad",
  skipped: "none",
  pending: "waiting",
  retrying: "waiting",
};

/**
 * What DoubleTick's own report changes about the symbol, and what it does not.
 *
 * This is the whole point of the status webhook: `sent` means DoubleTick
 * accepted the request and `ENQUEUED` is their queue, so a row that has since
 * been reported delivered or read should say so -- that is the only reading that
 * involves a handset. A report of failure moves the other way, because a tick on
 * a message DoubleTick says failed is exactly the lie this work removes.
 *
 * **`SENT` is deliberately absent**: it adds nothing we did not already have.
 *
 * **And this map is not an allowlist.** The exact string WhatsApp's read receipt
 * arrives as is not documented. A value that is not in here leaves the symbol
 * alone AND is printed verbatim under it, so the real one is visible the first
 * time it arrives instead of being dropped. Keying the display off a guessed
 * "READ" and nothing else is the mistake this shape exists to make impossible.
 */
const DELIVERY_REPORTS: Record<string, { word: string; state: MarkState }> = {
  DELIVERED: { word: "delivered", state: "ok" },
  READ: { word: "read", state: "ok" },
  FAILED: { word: "not delivered", state: "bad" },
};

/**
 * One destination's symbol and the word beside it.
 *
 * The word is never dropped in favour of the symbol. A cross with no reason is a
 * thing an operator has to come and ask about, and the reason is the useful half
 * -- so the symbol leads and the word follows it, both as text, on every row.
 */
function markOf(d: DestinationStatus | undefined, destination: string): { state: MarkState; word: string } {
  const status = d?.status ?? "";
  const ours: { state: MarkState; word: string } = {
    state: STATE_OF[status] ?? "unknown",
    word: status || "not reported",
  };
  if (destination !== "whatsapp") return ours;

  const reported = DELIVERY_REPORTS[(d?.delivery?.status ?? "").trim().toUpperCase()];
  // Only ever on top of a send. A report about a row we never sent would be a
  // row whose frozen id somebody else is using, and the status we recorded is
  // the one to show.
  if (!reported || status !== "sent") return ours;
  return reported;
}

/**
 * The muted lines under the symbol: the proof, our own word when the symbol no
 * longer shows it, and the details.
 *
 * All of it is text in the cell rather than a `title`. This dashboard is read on
 * a phone, where there is no hover and a long-press is a text selection -- a
 * tooltip is the same as deleting the reason.
 */
function notesFor(d: DestinationStatus | undefined, destination: string, word: string): string[] {
  const notes: string[] = [];
  const status = d?.status ?? "";

  if (destination === "whatsapp") {
    const reported = d?.delivery?.status;
    if (reported) {
      // Verbatim, with their name on it, so an unrecognised value is readable
      // and attributable rather than mistaken for one of ours.
      const at = d?.delivery?.at ? ` at ${formatDubaiInstant(d.delivery.at)} Dubai` : "";
      notes.push(`DoubleTick reported ${reported}${at}`);
    } else if (status === "sent") {
      // The honest gap. Without this an operator reads the tick as a handset,
      // which is the misreading the whole webhook was added to stop.
      notes.push("no delivery report yet");
    }
  }

  if (destination === "brevo" && d?.contactId) {
    // The proof. `http 201` says the request was accepted; this names a contact
    // in Brevo that can be opened.
    notes.push(`contact ${d.contactId}`);
  }

  // Our own status, whenever the symbol's word has replaced it. Both facts
  // matter and they are different facts: what DoubleTick answered our request,
  // and what DoubleTick later said became of the message.
  if (status && word !== status) notes.push(`we recorded ${status}`);

  if (d?.detail) notes.push(d.detail);
  if (destination === "whatsapp" && d?.delivery?.detail) notes.push(d.delivery.detail);

  return notes;
}

/** One cell of the events table: the symbol, its word, and everything under it. */
function DestinationCell({ d, destination }: { d: DestinationStatus | undefined; destination: string }) {
  const { state, word } = markOf(d, destination);
  const mark = MARKS[state];
  return (
    <>
      <div className="flex items-baseline gap-1">
        {/* Hidden from screen readers, which read the word beside it: the symbol
            is a second rendering of the same fact, not an extra one. */}
        <span aria-hidden="true" className={`font-semibold ${mark.tone}`}>
          {mark.symbol}
        </span>
        <span className={`font-medium ${mark.tone}`}>{word}</span>
      </div>
      {/* Keyed by position, because two notes can legitimately read the same:
          DoubleTick's failMessage and our own detail are different columns that
          may carry identical text, and React warns on a duplicate key. The list
          is rebuilt whole on every render, so a positional key costs nothing. */}
      {notesFor(d, destination, word).map((note, i) => (
        <div key={`${i}-${note}`} className="text-[11px] text-muted-foreground">
          {note}
        </div>
      ))}
    </>
  );
}

/** A stage warns only when it fired and then stopped. A stage that has never
 *  fired is not stale, whatever else the payload claims. */
function isQuiet(stage: StageHealth | undefined): boolean {
  return Boolean(stage && stage.everSeen && stage.stale);
}

/** Name, email and phone, which almost every row no longer holds.
 *
 *  The backend nulls them once Meta, WhatsApp and Brevo have all succeeded or
 *  been deliberately skipped, which is about a minute after signup, so an empty
 *  cell here is the normal case and not a broken page. A row with a failed or
 *  rejected destination still holds them, because a resend needs them.
 *  Saying so is the whole job of this: an operator reading
 *  three blank columns concludes the feed is broken, and would be wrong. A row
 *  that genuinely never carried the value reads as a dash instead, which is what
 *  `scrubbedAt` is for. */
function Personal({ value, scrubbedAt }: { value: string; scrubbedAt: string | null }) {
  if (value) return <>{value}</>;
  return <span className="text-muted-foreground">{scrubbedAt ? "scrubbed" : "—"}</span>;
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
const BUTTON = `${CONTROL} font-medium disabled:cursor-not-allowed disabled:opacity-50`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function CrmEventsPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState("all");
  const [problemsOnly, setProblemsOnly] = useState(false);
  // Which resend control is in flight, so both can be disabled while either one
  // is: the two share the endpoint and a second press while the first is still
  // running would report against a count that has already moved.
  const [resending, setResending] = useState<"safe" | "whatsapp" | null>(null);
  // What the last resend did, in words. Null until one has been pressed.
  const [resendNote, setResendNote] = useState<string | null>(null);
  // Whether the WhatsApp control is showing its confirmation. A press of the
  // first button only ever gets here; nothing is sent until the second one.
  const [confirmWhatsapp, setConfirmWhatsapp] = useState(false);
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

  /**
   * One destination's failures, or three, put back in the queue.
   *
   * One request per destination, because the endpoint is per destination and the
   * statement behind it writes one destination's columns -- which is the point:
   * fixing BREVO_LIST_ID must not re-send anybody's WhatsApp welcome. The safe
   * control simply asks for each of its own.
   *
   * What happened is always reported, success or not, and the failure says how
   * many went out BEFORE it failed rather than claiming nothing did: the first
   * request can succeed and the second fail, and those rows are pending now.
   * Then the page reloads, so the counts on screen are the ones after the action
   * rather than the ones that justified it.
   */
  const resend = useCallback(
    async (which: "safe" | "whatsapp", destinations: readonly string[]) => {
      setResending(which);
      setResendNote(null);
      let requeued = 0;
      let scrubbed = 0;
      let expired = 0;
      try {
        for (const destination of destinations) {
          const resp = await fetch(REQUEUE_URL, {
            method: "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ destination }),
          });
          if (!resp.ok) throw new Error(String(resp.status));
          const body: unknown = await resp.json();
          const answer = isRecord(body) ? body : {};
          requeued += Number(answer.requeued) || 0;
          scrubbed += Number(answer.alreadyScrubbed) || 0;
          // The other half of the same shortfall, and the half nothing else on
          // the page can explain after the action: the counts it was pressed
          // against have already been replaced by the reload below.
          //
          // Summed although the line below names ChatGPT Ads, and that stays
          // true: of the four this loop asks, only OpenAI has a window the
          // backend can write, and the other three -- google included -- answer
          // with a literal zero. If one of them ever gains a real deadline this
          // attributes its rows to the wrong destination, so the line to change
          // then is this one.
          expired += Number(answer.expired) || 0;
        }
        setResendNote(
          requeued === 0
            ? "Nothing was left to resend."
            : `${plural(requeued, "send")} queued; they go out within a minute.` +
                (scrubbed > 0
                  ? ` ${plural(scrubbed, "earlier failure")} had already been scrubbed and can never be resent.`
                  : "") +
                (expired > 0
                  ? ` ${plural(expired, "ChatGPT Ads failure")} ${expired === 1 ? "is" : "are"} older than OpenAI's` +
                    " 7-day window, which no resend can reach."
                  : ""),
        );
      } catch {
        // The server's message can name internal schema, so it is not shown.
        setResendNote(
          requeued === 0
            ? "Could not resend. Nothing was queued."
            : `Could not finish: ${plural(requeued, "send")} had been queued before it failed.`,
        );
      } finally {
        setResending(null);
        setConfirmWhatsapp(false);
        void load();
      }
    },
    [load],
  );

  const resendable = (key: string) => data?.requeue?.[key]?.resendable ?? 0;
  const safeCount = SAFE_TO_REPEAT.reduce((n, key) => n + resendable(key), 0);
  const whatsappCount = resendable("whatsapp");
  // Read from `openai` by name rather than summed over the group, because it is
  // the only destination with a deadline and the line below names it. A sum
  // would read the same today -- the other four report a literal zero -- and
  // would quietly attribute somebody else's expired rows to ChatGPT Ads the day
  // that stopped being true. Google is the reason that is no longer theoretical:
  // it has a real 90-day limit and still answers zero here, because the limit is
  // on the click and not on anything this table holds.
  const expiredCount = data?.requeue?.openai?.expired ?? 0;

  const rows = useMemo(() => {
    const all = data?.events ?? [];
    return all.filter((row) => {
      if (stage !== "all" && row.stage !== stage) return false;
      // Every destination, because a row whose ONLY problem is in the newest
      // column is exactly the row this filter is pressed for -- and one left out
      // here is invisible the moment an operator narrows the table.
      if (!problemsOnly) return true;
      return [row.meta, row.whatsapp, row.brevo, row.openai, row.google].some((d) => PROBLEM.has(d?.status));
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
              Every FXBO funnel webhook, and what we sent to Meta, WhatsApp, Brevo, ChatGPT Ads and Google Ads.
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
              {/* The one thing a reader of these five cards can misread, said
                  once rather than in a tooltip on one of them. ChatGPT Ads is
                  the first destination whose skip depends on the clock, and
                  `skipped` is the counter where that lands -- so the word means
                  two unrelated things on this card and only the row's own detail
                  tells them apart. A second counter was the alternative and was
                  not taken: the backend has one vocabulary of seven statuses,
                  and a status invented on the page would be a number no query
                  could reproduce. */}
              <p className="mb-2 text-xs text-muted-foreground">
                ChatGPT Ads counts every registration as <span className="font-medium">skipped</span> — the website
                pixel owns that conversion, so we deliberately never send it. It is also the only destination whose
                skip can mean the clock instead of the stage: OpenAI accepts no conversion more than 7 days old, so a
                row left unsent through an outage is skipped for its age once the worker reaches it. Both reasons are
                in each row’s detail in the table below.
              </p>
              {/* Google's card is the one that looks alarming and is not, which
                  is why it gets its own line rather than a clause on the one
                  above. Its `skipped` will be nearly its whole total on an
                  ordinary week, and the reason is about the ROW and not the
                  stage: Google attributes a click conversion on the gclid and on
                  nothing else -- there is no hashed-email fallback as there is
                  for Meta and ChatGPT Ads -- so an organic signup is a
                  conversion we could only file against no campaign at all. That
                  would inflate the account total the bidding reads while leaving
                  every campaign's own number unchanged, which is why it is a
                  deliberate skip and not an attempt. */}
              <p className="mb-2 text-xs text-muted-foreground">
                Google Ads counts most signups as <span className="font-medium">skipped</span> too, for a different
                reason: only a visitor who arrived by clicking an ad carries a <span className="font-medium">gclid</span>
                , and Google attributes a click conversion on that and on nothing else. Most signups are organic, so
                there is nothing to attribute and we deliberately send nothing — a high number here is the ordinary
                shape of the week, not a fault. Each row’s detail says which reason applied to it.
              </p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5">
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
              <h2 className={SECTION_TITLE}>Resend</h2>
              <p className="mb-2 text-xs text-muted-foreground">
                A destination whose send failed or was rejected keeps the client’s details so the cause can be fixed
                and the send retried. These counts cover the whole table rather than the selected period, and they
                leave out rows the 30-day scrub has already taken — those can never be resent. ChatGPT Ads leaves
                out one more kind: a conversion older than OpenAI’s 7-day window, which they would refuse whatever
                we fixed.
              </p>
              {/* Why there is no expired line for Google, said rather than left
                  as an absence. Google DOES have a limit -- 90 days -- so a
                  reader who knows that and sees nothing here would reasonably
                  conclude none of our rows had hit it. The truth is that the
                  limit is measured from the click and the click is not an
                  instant this table holds, so the backend writes a literal zero
                  (crmSignup/store.js `sendableWindow`) and this page prints no
                  number rather than one that would read as "none yet". */}
              <p data-testid="resend-google-age" className="mb-2 text-xs text-muted-foreground">
                There is no such line for Google Ads, and that is not because nothing of theirs has aged out. Their
                90-day limit is measured from the <span className="font-medium">ad click</span>, which this table does
                not record — a signup can follow its own click by any interval — so no count here could honestly
                promise what they would accept. Google’s rows are offered like Meta’s, and one they refuse on age
                comes back as a <span className="font-medium">rejected</span> row naming{" "}
                <span className="font-medium">EXPIRED_EVENT</span> in the table below.
              </p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className={CARD}>
                  <div className="mb-1 text-sm font-medium text-foreground">Meta, Brevo, ChatGPT Ads and Google Ads</div>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Safe to repeat: Meta deduplicates on the event id, the Brevo contact call is an upsert, ChatGPT
                    Ads deduplicates on the event id too — which we reuse unchanged on every retry — and Google Ads
                    deduplicates on the order id, which is that same id. A row that did go through is not counted or
                    contacted twice.
                  </p>
                  <button
                    type="button"
                    data-testid="resend-safe"
                    className={BUTTON}
                    disabled={safeCount === 0 || resending !== null}
                    onClick={() => void resend("safe", SAFE_TO_REPEAT)}
                  >
                    {resending === "safe"
                      ? "Resending…"
                      : safeCount === 0
                        ? "Nothing to resend"
                        : `Resend ${plural(safeCount, "failed Meta, Brevo, ChatGPT Ads and Google Ads send")}`}
                  </button>
                  {/* Stated as the fact it is, in the muted tone the rest of
                      this card uses and not the amber the WhatsApp warning uses.
                      An operator reading "12 resendable, 28 expired" has to
                      finish the sentence with "because OpenAI will not take
                      them", not with "because something here is broken" -- so
                      the rule is named, and whose rule it is. Hidden at zero:
                      the commonest state is no expired rows at all, and a
                      permanent nil line is a line people stop reading. */}
                  {expiredCount > 0 ? (
                    <p data-testid="resend-expired" className="mt-2 text-xs text-muted-foreground">
                      {plural(expiredCount, "ChatGPT Ads failure")} {expiredCount === 1 ? "is" : "are"} older than 7
                      days and {expiredCount === 1 ? "is" : "are"} not in that count. OpenAI accepts no conversion
                      more than 7 days old, and the event has to say when the conversion actually happened, so no
                      resend can reach {expiredCount === 1 ? "it" : "them"}. That is OpenAI’s rule, not a fault here.
                    </p>
                  ) : null}
                </div>

                <div className={CARD}>
                  <div className="mb-1 text-sm font-medium text-foreground">WhatsApp</div>
                  {/* Visible text, not a tooltip: the one thing an operator has to
                      read before pressing this is the one thing a tooltip hides. */}
                  <p className="mb-2 text-xs text-amber-700 dark:text-amber-300">
                    Resending may send a second welcome message. A failed WhatsApp row may already have reached the
                    handset — DoubleTick can answer 2xx with a status we do not recognise, and that is recorded as
                    rejected on purpose — and nothing deduplicates this message.
                  </p>
                  {confirmWhatsapp ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        data-testid="resend-whatsapp-confirm"
                        className={`${BUTTON} border-amber-500 text-amber-800 dark:text-amber-200`}
                        disabled={resending !== null}
                        onClick={() => void resend("whatsapp", ["whatsapp"])}
                      >
                        {resending === "whatsapp"
                          ? "Resending…"
                          : `Yes, resend ${plural(whatsappCount, "welcome message")} — some may arrive twice`}
                      </button>
                      <button
                        type="button"
                        data-testid="resend-whatsapp-cancel"
                        className={BUTTON}
                        disabled={resending !== null}
                        onClick={() => setConfirmWhatsapp(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      data-testid="resend-whatsapp"
                      className={BUTTON}
                      disabled={whatsappCount === 0 || resending !== null}
                      onClick={() => setConfirmWhatsapp(true)}
                    >
                      {whatsappCount === 0
                        ? "Nothing to resend"
                        : `Resend ${plural(whatsappCount, "failed WhatsApp welcome")}…`}
                    </button>
                  )}
                </div>
              </div>
              {resendNote ? (
                <p role="status" data-testid="resend-note" className="mt-2 text-xs text-foreground">
                  {resendNote}
                </p>
              ) : null}
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

              {/* The symbols, said once in text rather than in a tooltip on each
                  of them: this page is read on a phone, where there is no hover.
                  Four and not two, which is the one place this deliberately does
                  not do what was asked -- a cross on `skipped` would paint a red
                  mark on every row of the commonest case, since Meta and ChatGPT
                  Ads are skipped on every registration by design and Google Ads
                  is skipped on every signup that did not arrive by an ad click.
                  Adding a fifth column made that argument stronger rather than
                  weaker: the dash is now the commonest mark on the table. */}
              <p className="mb-2 text-xs text-muted-foreground">
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">{"✓"}</span> sent
                {" · "}
                <span className="font-semibold text-red-600 dark:text-red-400">{"✗"}</span> failed, rejected or
                invalid
                {" · "}
                <span className="font-semibold">{"–"}</span> deliberately not sent — Meta and ChatGPT Ads
                skip every registration, and Google Ads skips every signup that carried no ad click, which is not a
                fault
                {" · "}
                <span className="font-semibold">{"⋯"}</span> still going out. The word and the reason are beside
                every symbol, because the reason is the useful part.
              </p>
              <p className="mb-2 text-xs text-muted-foreground">
                <span className="font-medium">WhatsApp shows the best we actually know.</span> A 2xx from DoubleTick
                means the request was accepted and <span className="font-medium">ENQUEUED</span> is their queue, not a
                handset — so a tick there says delivered or read only once DoubleTick’s status webhook has said
                so, and a row still waiting for that report says it plainly. Their word is printed as it arrives, since
                the exact string for a read receipt is not documented. Brevo shows the id of the contact it created,
                which is a record that can be opened; an update returns no id and says so.
              </p>
              <p className="mb-2 text-xs text-muted-foreground">
                Name, email and phone are removed once Meta, WhatsApp, Brevo, ChatGPT Ads and Google Ads have all
                succeeded or been skipped —
                about a minute after signup — so most rows read “scrubbed”. FXBO holds the client record; this table
                holds the statistics. A row with a failed or rejected destination keeps its name, email and phone so
                the send can be fixed and retried; it is scrubbed anyway after 30 days, and whatever it had not sent
                by then reads “failed”, with a detail saying it was never attempted.
              </p>

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
                        <th className="p-2 text-left">ChatGPT Ads</th>
                        {/* Spelled out beside the other four rather than
                            generated from DESTINATIONS: the cells below ARE
                            generated from it, so a header list that drifted
                            would shift every destination's column under the
                            wrong name -- which is worse than a missing column,
                            because it reads as a confident answer. */}
                        <th className="p-2 text-left">Google Ads</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id} className="border-t border-slate-200 align-top dark:border-slate-800">
                          <td className="p-2 whitespace-nowrap">{formatDubaiInstant(row.receivedAt)}</td>
                          <td className="p-2">{STAGE_LABELS[row.stage] ?? row.stage}</td>
                          <td className="p-2">{row.crmClientId}</td>
                          <td className="p-2">
                            <Personal value={row.name} scrubbedAt={row.scrubbedAt} />
                          </td>
                          <td className="p-2">
                            <Personal value={row.email} scrubbedAt={row.scrubbedAt} />
                          </td>
                          <td className="p-2">
                            <Personal value={row.phone} scrubbedAt={row.scrubbedAt} />
                          </td>
                          <td className="p-2">{row.source}</td>
                          {DESTINATIONS.map(([key]) => (
                            <td key={key} data-testid={`cell-${key}-${row.id}`} className="p-2">
                              <DestinationCell d={row[key]} destination={key} />
                            </td>
                          ))}
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
