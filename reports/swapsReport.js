// The Swaps report — the fourth email in the dealing family.
//
// WHY IT EXISTS: swap is money that moves every night on every open position,
// on both sides of the book, and nobody reads it in one place. This email puts
// what our clients were booked, what each LP cost or earned us, and what is
// accruing on open positions right now on one page.
//
// THE BACKEND TEAM'S STATED RULES (recorded 2026-09-16). These came from the
// people who own /api/SwapsReport, in answer to questions this report had left
// open. They are the rules this file implements; the code is not the authority.
//
//   Rule 1 — sign. A NEGATIVE LP swap means the LP charged us: a cost. A
//            POSITIVE LP swap means we received swap: revenue. For CLIENTS the
//            user confirmed (2026-09-16) the opposite: a negative client swap is
//            charged to the client, which is our revenue, and a positive one is
//            given to the client, which is our cost. Both are stated from
//            Skylinks' side of the book. Every figure in the email says which of
//            the two it is, in words, because a minus sign alone was exactly the
//            ambiguity that had to be asked about — and because the same sign
//            means opposite things in the two halves of the page. The mapping
//            lives in ONE function, swapEffect, so the two sides cannot drift.
//
//   Rule 2 — time. The window is taken exactly as it is sent. No rollover or
//            timezone adjustment is applied anywhere in this file.
//
//   Rule 4 — which LP figure counts depends on the LP's type:
//              Manager   our statements            -> statementSwap
//              Terminal  taken directly from the LP -> totalSwap
//              Api       fetched from the LP        -> totalSwap, and when no
//                        LP record exists, the DB statement -> statementSwap
//            The FIELD MAPPING on the right is our inference from the payload
//            and is NOT YET VERIFIED against a live LP row. That is why the
//            rule lives in one small function (effectiveLpSwap). The email
//            used to print each LP's type and source so a wrong pick was
//            visible; the user asked for those to go (2026-09-16) — the reader
//            wants one figure per LP and nothing else. With no label on the
//            page, the protection moved into the tests, which assert the NUMBER
//            each LP type displays when its two candidate figures differ.
//
//   Rule 5 — show every LP. Nothing is marked "skipped" or "incomplete" because
//            an API LP has no vendor feed; that LP falls back to the statement.
//            The email never names the type or the source to the reader.
//
//   Rule 6 — a row carrying excludeFromSwaps === true is left out of every
//            table and every total. The endpoint does not send the flag today;
//            honouring it now means turning it on needs no email change.
//
// (Rule 3 — daily and monthly windows are supported by the backend as-is.)
//
// WHY unrealizedSwap IS NEVER ADDED TO ANYTHING: it is accrued swap on positions
// open AT THE MOMENT THIS EMAIL IS BUILT. It belongs to no date range and will
// be different an hour later, so adding it to a period figure produces a number
// that describes no period at all. A "Realized" row was once placed in the
// volume funnel as though it were a downstream stage of deal flow, and the
// funnel widened as you read down it (see the note above renderVolumeSection);
// unrealizedSwap is the same trap wearing different clothes. It gets its own
// column, labelled "at send time" everywhere, and a test on a fixture where
// folding it in would visibly change a figure.
//
// NOT SCHEDULED YET, ON PURPOSE. The guard keys, the recipient variables and
// all three cadences are here and exported, but reports/schedulers.js is
// untouched: the reader wants to see a rendered email and approve it before it
// starts arriving on a cadence.
import {
  CADENCES,
  alreadySentFor,
  backendFetch,
  dataCell,
  dataTable,
  emailShell,
  escapeHtml,
  fmtNum,
  kpiGrid,
  money,
  recordSentFor,
  resolveRecipients,
  sendBrevoEmail,
  toUnixRange,
  toYmdUtc,
} from "./reportShared.js";

// A dash means "could not read". 0.00 means "the value is zero". Rule 4's Api
// fallback and the LP total both turn on the difference between those two.
const DASH = "&mdash;";

// The light shell's muted ink. Repeated here only for the inline-styled note
// cells; everything else takes its colour from a class the shell defines.
const MUTED = "#64748b";

// The weekly key is bare, matching SLIPPAGE_GUARD_KEYS: if this report is ever
// scheduled at more than one cadence, a shared key would make Saturday's weekly
// skip itself as "already sent" because the daily had claimed the window.
// Nothing has been recorded under these yet — they are written now so the later
// scheduling commit adds a cron line and nothing else.
export const SWAPS_GUARD_KEYS = {
  daily: "swaps-daily",
  weekly: "swaps",
  monthly: "swaps-monthly",
};

// Each cadence may have its own audience and falls back to one list, the same
// shape SLIPPAGE_RECIPIENT_VARS uses. SWAPS_ALERT_RECIPIENTS does not exist in
// the environment yet; until it does every cadence resolves to nobody and a
// scheduled run would skip, which is the correct behaviour for a report that
// has not been approved.
export const SWAPS_RECIPIENT_VARS = {
  daily: ["DAILY_SWAPS_RECIPIENTS", "SWAPS_ALERT_RECIPIENTS"],
  weekly: ["SWAPS_ALERT_RECIPIENTS"],
  monthly: ["MONTHLY_SWAPS_RECIPIENTS", "SWAPS_ALERT_RECIPIENTS"],
};

// 180s, the same budget DEALMATCH_RUN_TIMEOUT_MS and VOLUME_RUN_TIMEOUT_MS
// carry, and the same number wallet/backendProxy.js grants this exact route.
//
// Measured: a ONE-DAY range answered 200 in 67.2 seconds. The 45s default in
// reportShared would have aborted that call before it returned — a one-day
// Swaps report is already impossible on the default budget. The backend team
// has confirmed daily and monthly windows are supported as single calls, so the
// window is always fetched whole. Nothing has established where the call
// settles as the window grows, so this is not a measured ceiling: it is the
// house long-route budget, and 180s is also what the proxy allows, so a larger
// number here would only move the failure.
export const SWAPS_RUN_TIMEOUT_MS = 180_000;

// The live vendor pull is OFF for scheduled sends.
//
// liveFinalto=true bypasses the FinaltoCosts cache and calls Finalto's CFDCost
// SOAP endpoint once per business day per sub-account. On a call that already
// costs over a minute for a single day that turns a monthly report into a
// several-minute request, for a marginal freshness gain nobody reading a
// scheduled email at 07:00 can act on. Off, the backend still serves the cached
// rows and live-fetches only the (sub-account, day) tuples it is missing, so
// the figures are complete — just not re-pulled from the vendor.
//
// The dashboard tab keeps the switch for an operator who is standing there
// watching the spinner. An unattended cron job is not that operator.
const SCHEDULED_LIVE_FINALTO = false;

// How many rows a table may print. A month has hundreds of client accounts with
// a non-zero swap and the reader is on a phone, where table.data stacks every
// row into a card — three hundred cards is not a report. The LP table uses the
// cap too, but orders unresolved LPs first and says how many rows it dropped.
export const SWAPS_ROW_CAP = 15;

export function swapsSubject(cadence, fromYmd, toYmd) {
  const word = CADENCES[cadence].subjectWord;
  // A single day rendered as "2026-08-31 to 2026-08-31" reads like a bug.
  const period = fromYmd === toYmd ? fromYmd : `${fromYmd} to ${toYmd}`;
  return `${word} Swaps Report (${period})`;
}

// ── parsing ──────────────────────────────────────────────────────────────────

// A figure the backend did not send is null, never zero. `Number(undefined) || 0`
// collapses "absent" and "genuinely zero" into one confident 0.00, and under
// rule 4 that would also decide whether an Api LP falls back to the statement.
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// NaN and Infinity pass a typeof check and are not totals. Mirrors readTotals()
// in src/lib/swapsReportApi.ts deliberately: same rule, same reason.
function readTotals(payload, key) {
  const totals = payload?.[key];
  if (!totals || typeof totals !== "object") return null;
  const swap = Number(totals.totalSwap);
  const accounts = Number(totals.accountCount);
  if (!Number.isFinite(swap) || !Number.isFinite(accounts)) return null;
  return { totalSwap: swap, accountCount: accounts };
}

function readRows(payload, key) {
  const rows = payload?.[key];
  return Array.isArray(rows) ? rows : [];
}

// Rule 6. Strictly `=== true`: an absent flag, or a truthy string a future
// serializer might emit by mistake, keeps the row in. Dropping a real LP from
// the total on a guess is worse than showing one that should have been hidden.
const isExcluded = (row) => row?.excludeFromSwaps === true;

/**
 * A raw `/api/SwapsReport` payload, normalised. Pure — hand it a fixture.
 *
 * Deliberately lenient about the ENVELOPE and strict about the FIGURES: an
 * absent `clients` array becomes [], which renders as "no rows", while an
 * absent `clientTotals` stays null and renders as "unavailable".
 *
 * Rows flagged excludeFromSwaps (rule 6) are removed from `clients` / `lps`
 * here, so no table or total downstream can see them, and kept aside in
 * `excludedClients` / `excludedLps` so the email can say how many were left out
 * and take the excluded clients back out of the backend's client total.
 *
 * `lpTotals` is still parsed so the payload shape stays whole, but it is not
 * rendered: it is not rule-4 aware, so it is not the LP total.
 */
export function parseSwapsReport(payload) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const skipped = Number(source.skippedApiLpCount);
  const panelError = typeof source.clientPanelError === "string" ? source.clientPanelError.trim() : "";
  const clients = readRows(source, "clients");
  const lps = readRows(source, "lps");
  return {
    clients: clients.filter((r) => !isExcluded(r)),
    clientTotals: readTotals(source, "clientTotals"),
    lps: lps.filter((r) => !isExcluded(r)),
    lpTotals: readTotals(source, "lpTotals"),
    excludedClients: clients.filter(isExcluded),
    excludedLps: lps.filter(isExcluded),
    skippedApiLpCount: Number.isFinite(skipped) && skipped > 0 ? skipped : 0,
    clientPanelError: panelError || null,
    lpErrors: Array.isArray(source.lpErrors)
      ? source.lpErrors.map((e) => String(e)).filter((e) => e.trim().length > 0)
      : [],
  };
}

// ── rule 4 (pure) ────────────────────────────────────────────────────────────

function accountLabel(row) {
  const named = String(row?.lpName || row?.name || "").trim();
  if (named) return named;
  if (row?.login !== null && row?.login !== undefined && row.login !== "") return `login ${row.login}`;
  if (row?.id !== null && row?.id !== undefined) return `id ${row.id}`;
  return "Unidentified account";
}

// The three LP types, as `type LPSource` in src/pages/settings/LPManagerPage.tsx
// spells them. Matched case-insensitively ("api" and "Api" are the same type);
// anything else is unknown and gets no figure. LPManagerPage maps an unknown
// value to "Manager" for its dropdown — copying that here would silently pick
// our statement for an LP nobody has classified, which is a guess.
const LP_TYPES = ["Manager", "Terminal", "Api"];

/**
 * Rule 4 — the ONE place that decides which figure is an LP's swap.
 *
 * Returns `{ value, source, type, reason }`:
 *   value   the figure, or null when rule 4 has nothing to offer
 *   source  "statement" | "lp" | "statement-fallback" | null
 *   type    the canonical LP type, or null when unknown/missing
 *   reason  plain text saying why value is null (never set alongside a value).
 *           It names the type and the book, so it is for tests and debugging
 *           only; the email prints unresolvedLpReason's wording instead.
 *
 * `source` and `type` are likewise never rendered (user, 2026-09-16).
 *
 * UNVERIFIED MAPPING (2026-09-16): Manager -> statementSwap, Terminal ->
 * totalSwap, Api -> totalSwap else statementSwap is inferred from field names,
 * not checked against a live LP row. If it proves wrong, the fix is here.
 *
 * "No LP record" is null/absent. A 0 from the LP is a record of zero swap and
 * does NOT trigger the fallback — otherwise an LP that genuinely charged nothing
 * would be silently replaced by whatever our statement says.
 */
export function effectiveLpSwap(row) {
  const rawType = row?.source;
  const type = typeof rawType === "string"
    ? LP_TYPES.find((t) => t.toLowerCase() === rawType.trim().toLowerCase()) || null
    : null;
  const lp = num(row?.totalSwap);
  const statement = num(row?.statementSwap);

  if (type === "Manager") {
    return statement !== null
      ? { value: statement, source: "statement", type, reason: null }
      : { value: null, source: null, type, reason: "Manager LP with no statement uploaded for this period. Manager LPs use our statement only, so there is no figure — not zero." };
  }
  if (type === "Terminal") {
    return lp !== null
      ? { value: lp, source: "lp", type, reason: null }
      : { value: null, source: null, type, reason: "Terminal LP that sent no swap figure. Terminal LPs use the LP's own figure only, so there is no figure — not zero." };
  }
  if (type === "Api") {
    if (lp !== null) return { value: lp, source: "lp", type, reason: null };
    if (statement !== null) return { value: statement, source: "statement-fallback", type, reason: null };
    return { value: null, source: null, type, reason: "Api LP with no LP record and no statement to fall back on, so there is no figure — not zero." };
  }
  const shown = rawType === null || rawType === undefined || String(rawType).trim() === ""
    ? "LP type is missing"
    : `Unknown LP type "${String(rawType)}"`;
  return { value: null, source: null, type: null, reason: `${shown}. No rule covers it, so no figure is chosen.` };
}

/**
 * The LP headline: the sum of every LP's rule-4 figure, ALL OR NOTHING.
 *
 * If any LP is unresolved the total is null, never the sum of the ones that did
 * resolve. A partial sum looks exactly like a real total — it is a plausible
 * number with no visible hole in it — which is why sumOrNull in
 * reports/volumeSection.js refuses to produce one either. An empty LP list is
 * also null: there is nothing to total, and 0.00 would claim there was.
 */
export function lpSwapTotal(lps) {
  const resolved = lps.map(effectiveLpSwap);
  const unresolved = resolved.filter((r) => r.value === null).length;
  if (!lps.length || unresolved > 0) return { value: null, count: lps.length, unresolved };
  return { value: resolved.reduce((sum, r) => sum + r.value, 0), count: lps.length, unresolved: 0 };
}

/**
 * LP table order: unresolved LPs first, then by the size of the rule-4 figure.
 *
 * Unresolved rows lead because they need someone to act and because they are
 * what makes the LP total unavailable; if the row cap drops anything it drops
 * the smallest resolved figures, never the reason the headline is a dash.
 */
export function orderLpRows(lps) {
  const shaped = lps.map((row) => ({
    row,
    label: accountLabel(row),
    swap: effectiveLpSwap(row),
  }));
  const unresolved = shaped.filter((r) => r.swap.value === null);
  const resolved = shaped
    .filter((r) => r.swap.value !== null)
    .sort((a, b) => Math.abs(b.swap.value) - Math.abs(a.swap.value));
  return [...unresolved, ...resolved];
}

/**
 * Client movers, biggest absolute swap first. Absolute, because a large credit
 * is as worth seeing as a large charge, and ranking by the signed value would
 * bury every credit at the bottom of a table that gets truncated.
 */
export function orderMovers(rows) {
  return rows
    .map((row) => ({
      label: accountLabel(row),
      login: row?.login,
      swap: num(row?.totalSwap),
      unrealized: num(row?.unrealizedSwap),
    }))
    .sort((a, b) => (b.swap === null ? -1 : Math.abs(b.swap)) - (a.swap === null ? -1 : Math.abs(a.swap)));
}

/**
 * The client headline: the backend's own clientTotals, less any rows rule 6
 * excluded. Not a sum of the rows — the rows are the accounts the backend chose
 * to return, the total is what it measured. If an excluded row has no swap
 * figure there is nothing to subtract, so the total is unavailable rather than
 * quietly still containing it.
 */
function clientHeadline(report) {
  const totals = report.clientTotals;
  if (!totals) return { value: null, reason: "Backend sent no clientTotals; rows are not summed here" };
  const excluded = report.excludedClients.map((r) => num(r?.totalSwap));
  if (excluded.some((v) => v === null)) {
    return { value: null, reason: "An excluded account had no swap figure to remove from the backend total" };
  }
  return {
    value: totals.totalSwap - excluded.reduce((a, b) => a + b, 0),
    accounts: totals.accountCount - excluded.length,
    excluded: excluded.length,
  };
}

// ── cells ────────────────────────────────────────────────────────────────────

// What a NEGATIVE swap means on each side of the book, from Skylinks' point of
// view. Positive is always the other one.
//
// The two sides are deliberately OPPOSITE, and this table is the only place
// that says so:
//   lp      negative = the LP charged us                    -> cost
//           (backend team, rule 1, 2026-09-16)
//   client  negative = charged to the client, we keep it    -> revenue
//           positive = given to the client, we pay it       -> cost
//           (confirmed by the user, Abbas, 2026-09-16)
// Writing the mapping once, as data, is what stops a later edit flipping one
// side's ternary and not the other's.
const NEGATIVE_SWAP_MEANS = { lp: "cost", client: "revenue" };
const OPPOSITE_EFFECT = { cost: "revenue", revenue: "cost" };

/**
 * Rule 1 — the ONE place a signed swap becomes a cost or a revenue.
 *
 * @param {number|null} value  the signed figure as the backend sent it
 * @param {"client"|"lp"} side which half of the book the figure belongs to
 * @returns {"cost"|"revenue"|null}
 *
 * ZERO is null, and so is anything that prints as $0.00. Nothing moved, so
 * calling it a cost or a revenue would be false either way; and a figure like
 * -0.004 printed as "-$0.00 (revenue)" would claim money the page cannot show.
 * The rendered text for such a figure is a bare "$0.00", muted.
 *
 * An unknown side throws rather than defaulting to one convention: guessing
 * here would silently invert half the email.
 */
export function swapEffect(value, side) {
  if (!Object.hasOwn(NEGATIVE_SWAP_MEANS, side)) throw new Error(`swapEffect: unknown side "${side}"`);
  if (value === null || !Number.isFinite(value) || roundsToZero(value)) return null;
  const negativeMeans = NEGATIVE_SWAP_MEANS[side];
  return value < 0 ? negativeMeans : OPPOSITE_EFFECT[negativeMeans];
}

function roundsToZero(value) {
  return Math.abs(value) < 0.005;
}

// Colour follows the effect, not the sign. A client charge is negative AND our
// revenue; painting it red would contradict the word printed beside it.
function effectCls(value, side) {
  const effect = swapEffect(value, side);
  if (effect === "revenue") return "pos";
  if (effect === "cost") return "neg";
  return "muted";
}

// Every swap figure on the page, either side: signed, and named.
function swapText(value, side) {
  if (value === null) return DASH;
  const effect = swapEffect(value, side);
  // money(-0.004) prints "-$0.00"; a figure that is zero on the page is shown
  // as zero, without a sign that implies a direction.
  return effect === null ? money(0) : `${money(value)} (${effect})`;
}

// A labelled cell that is allowed to run the full width of its card.
//
// table.data caps every cell at 156px so a row of numbers lines up on a desktop.
// A sentence in a 156px column is a column of single words, so prose overrides
// the cap inline — the same technique volumeSection.js uses for its explanation
// lines. It introduces no class: `txt`, `lbl` and `val` are all declared by the
// shell, so the class-coverage guard stays meaningful.
function proseCell(label, value, { colspan = 1 } = {}) {
  return `<td class="txt" data-label="${escapeHtml(label)}" colspan="${colspan}" style="max-width:none;width:100%;"><span class="lbl">${escapeHtml(label)}</span><span class="val">${value}</span></td>`;
}

// An unlabelled full-width line inside a row's card, for the reason beside a
// dash. It rides in the row it explains rather than sitting in a <tr> of its
// own: table.data gives every <tr> a zebra stripe and a rule, so a separate row
// would read as twice as many LPs.
function reasonCell(text, { colspan = 1 } = {}) {
  return `<td class="txt" colspan="${colspan}" style="max-width:none;width:100%;padding:0 8px 4px;font-size:11px;line-height:1.45;color:${MUTED};">${text}</td>`;
}

// ── sections (pure) ──────────────────────────────────────────────────────────

// Rule 5 leaves one thing the email cannot fix: an API LP the backend counted
// as skipped but did not put in lps[] at all has no row to apply the statement
// fallback to. The payload does not say which LPs were skipped, only how many,
// so the count of absent ones is inferred: skipped API LPs that DID come back
// show up as Api rows with no LP record (rule 4 then falls back for them), and
// whatever the skipped count exceeds that by is what never arrived.
function absentSkippedApiLps(report) {
  if (report.skippedApiLpCount <= 0) return 0;
  const present = [...report.lps, ...report.excludedLps].filter((row) => {
    const type = typeof row?.source === "string" ? row.source.trim().toLowerCase() : "";
    return type === "api" && num(row?.totalSwap) === null;
  }).length;
  return Math.max(0, report.skippedApiLpCount - present);
}

/**
 * Notes that qualify the figures, rendered before them.
 *
 * Skipped API LPs are no longer a completeness failure (rule 5): they are shown
 * with the statement fallback. The only skipped-LP note left is for LPs the
 * endpoint did not return at all, and it says exactly that. Genuine LP errors
 * and a failed client panel still mark the figures as affected.
 *
 * The all-clear is stated explicitly. An absent warning is indistinguishable
 * from a warning that failed to render, and this reader has lost a section to a
 * rendering bug before.
 */
function renderNotes(report) {
  const notes = [];
  const absent = absentSkippedApiLps(report);
  // Worded without the LP's type or where its figure would have come from: the
  // reader asked for neither, and the only fact they can act on is that some
  // LPs are missing from the table and the total.
  if (absent > 0) {
    notes.push({
      label: "LPs not returned",
      detail: `${fmtNum(absent, 0)} LP(s) were not returned by the endpoint, so no swap figure could be shown for them. They are not in the LP table or the LP total below.`,
      failure: false,
    });
  }
  if (report.lpErrors.length > 0) {
    notes.push({
      label: "LP queries failed",
      detail: `${fmtNum(report.lpErrors.length, 0)} LP(s) failed: ${escapeHtml(report.lpErrors.join("; "))}`,
      failure: true,
    });
  }
  if (report.clientPanelError) {
    notes.push({
      label: "Client panel failed",
      detail: `${escapeHtml(report.clientPanelError)} &mdash; the client figures below are missing or incomplete.`,
      failure: true,
    });
  }

  const title = `<p class="section-title" style="margin-top:0;">Report Notes</p>`;
  if (!notes.length) {
    return `${title}
          <p class="note">No LP errors, the client panel returned, and every LP the backend counted is in the table below.</p>`;
  }

  const bodyRows = notes
    .map(
      (n) => `<tr>
        ${dataCell("Note", escapeHtml(n.label), { nowrap: true, cls: n.failure ? "neg" : "" })}
        ${proseCell("Detail", n.detail)}
      </tr>`,
    )
    .join("");

  const lead = notes.some((n) => n.failure)
    ? `<p class="note">Some figures below are affected by the failures listed here.</p>`
    : "";

  return `${title}
          ${lead}
          ${dataTable({
            headers: [
              { label: "Note", width: "28%" },
              { label: "Detail", width: "72%" },
            ],
            bodyRows,
            narrow: true,
          })}`;
}

function renderTotals(report) {
  const client = clientHeadline(report);
  const clientCard = client.value === null
    ? { label: "Client Swap (period)", value: "Unavailable", cls: "muted", note: client.reason }
    : {
        label: "Client Swap (period)",
        value: swapText(client.value, "client"),
        cls: effectCls(client.value, "client"),
        note: `${fmtNum(client.accounts, 0)} accounts${client.excluded ? `, after removing ${fmtNum(client.excluded, 0)} excluded` : ""}`,
      };

  const lp = lpSwapTotal(report.lps);
  let lpCard;
  if (lp.value !== null) {
    lpCard = { label: "LP Swap (period)", value: swapText(lp.value, "lp"), cls: effectCls(lp.value, "lp"), note: `${fmtNum(lp.count, 0)} LPs` };
  } else if (lp.count === 0) {
    lpCard = { label: "LP Swap (period)", value: DASH, cls: "muted", note: "No LP rows to total" };
  } else {
    lpCard = {
      label: "LP Swap (period)",
      value: DASH,
      cls: "muted",
      note: `${fmtNum(lp.unresolved, 0)} of ${fmtNum(lp.count, 0)} LP(s) unresolved; no partial sum`,
    };
  }

  return kpiGrid([clientCard, lpCard], { maxWidth: 260 });
}

/**
 * Every LP, each with exactly one swap figure: the one rule 4 chose.
 *
 * Two columns and nothing else, at the user's request (2026-09-16): the LP's
 * type, where its figure came from, a second figure to cross-check it against,
 * and the unrealized snapshot were all judged noise for this reader. Rule 4
 * still decides the figure; it just no longer explains itself on the page,
 * which is why the tests pin the number each type displays.
 */
function renderLpTable(report, periodNoun) {
  const all = orderLpRows(report.lps);
  const shown = all.slice(0, SWAPS_ROW_CAP);
  const dropped = all.length - shown.length;

  const headers = [
    { label: "LP", width: "50%" },
    { label: "LP Swap (period)", width: "50%" },
  ];

  const bodyRows = shown
    .map((r) => {
      const { swap } = r;
      return `<tr>
        ${dataCell("LP", escapeHtml(r.label), { nowrap: true })}
        ${dataCell("LP Swap (period)", swapText(swap.value, "lp"), { align: "right", cls: effectCls(swap.value, "lp") })}
        ${swap.value === null ? reasonCell(unresolvedLpReason(swap), { colspan: headers.length }) : ""}
      </tr>`;
    })
    .join("");

  const unresolved = all.filter((r) => r.swap.value === null).length;
  const excluded = report.excludedLps.length;

  return `<p class="section-title">LP Swap &mdash; All LPs</p>
          <p class="note">
            One swap figure per LP for this ${escapeHtml(periodNoun)}.
            Negative LP swap is a cost (the LP charged us); positive is revenue (we received swap).
          </p>
          ${dataTable({
            headers,
            bodyRows,
            emptyText: `No LP rows for this ${escapeHtml(periodNoun)}.`,
          })}
          <p class="note">
            ${unresolved > 0
              ? `<strong>${fmtNum(unresolved, 0)} of ${fmtNum(all.length, 0)} LP(s) have no figure</strong>, so the LP total is unavailable.`
              : `All ${fmtNum(all.length, 0)} LP(s) have a figure.`}
            ${dropped > 0 ? ` Showing ${fmtNum(shown.length, 0)} of ${fmtNum(all.length, 0)} LPs; ${fmtNum(dropped, 0)} LP(s) omitted.` : ""}
            ${excluded > 0 ? ` ${fmtNum(excluded, 0)} LP(s) marked excluded from swaps are left out of this table and the LP total.` : ""}
          </p>`;
}

// The line under a dash, in the reader's terms. effectiveLpSwap's own reason
// names the LP type and which book it reads, which is what an operator
// debugging the mapping needs and exactly what this reader asked not to see.
// Two cases survive translation: rule 4 knew where to look and found nothing,
// or the LP is not classified, so no rule applies to it at all.
function unresolvedLpReason(swap) {
  return swap.type
    ? "No swap record for this period, so there is no figure &mdash; not zero."
    : "This LP is not set up for swap reporting, so there is no figure &mdash; not zero.";
}

/**
 * Top client movers. The Unrealized column sits beside a period figure without
 * ever being added to one, and its label says "at send time" in full. Both
 * columns carry the client sign convention, so a charge reads as revenue.
 */
function renderClientMovers(report, periodNoun) {
  const all = orderMovers(report.clients);
  const shown = all.slice(0, SWAPS_ROW_CAP);
  const dropped = all.length - shown.length;
  const excluded = report.excludedClients.length;

  const headers = [
    { label: "Account", width: "30%" },
    { label: "Login", width: "16%" },
    { label: "Swap (period)", width: "27%" },
    { label: "Unrealized (at send time)", width: "27%" },
  ];

  const bodyRows = shown
    .map(
      (r) => `<tr>
        ${dataCell("Account", escapeHtml(r.label), { nowrap: true })}
        ${dataCell("Login", r.login === null || r.login === undefined || r.login === "" ? DASH : escapeHtml(String(r.login)), { nowrap: true })}
        ${dataCell("Swap (period)", swapText(r.swap, "client"), { align: "right", cls: effectCls(r.swap, "client") })}
        ${dataCell("Unrealized (at send time)", swapText(r.unrealized, "client"), { align: "right", cls: effectCls(r.unrealized, "client") })}
      </tr>`,
    )
    .join("");

  return `<p class="section-title">Top Movers &mdash; Client Accounts</p>
          ${dataTable({ headers, bodyRows, emptyText: `No client swap rows for this ${escapeHtml(periodNoun)}.` })}
          <p class="note">
            Ranked by the size of Swap (period), either sign.
            Negative client swap is charged to the client (revenue); positive is given to the client (cost).
            ${dropped > 0 ? `Showing ${fmtNum(shown.length, 0)} of ${fmtNum(all.length, 0)} accounts; ${fmtNum(dropped, 0)} omitted.` : `All ${fmtNum(all.length, 0)} account(s) shown.`}
            ${excluded > 0 ? `${fmtNum(excluded, 0)} account(s) marked excluded from swaps are left out of this table and the client total.` : ""}
            Unrealized is a live snapshot of accrued swap on positions open when this email was built &mdash; it belongs to no ${escapeHtml(periodNoun)} and is never added into the period figures above.
          </p>`;
}

// ── the renderer ─────────────────────────────────────────────────────────────

/**
 * The Swaps email, as HTML. Pure: no fetching, no clock, no formatting left to
 * the caller. Hand it a parsed payload (or a fixture) and it renders.
 *
 * @param {object} args
 * @param {object} args.report  A payload from `parseSwapsReport`.
 * @param {{fromYmd: string, toYmd: string}} args.period
 * @param {"daily"|"weekly"|"monthly"} args.cadence
 */
export function buildSwapsEmailHtml({ report, period, cadence = "weekly" }) {
  const spec = CADENCES[cadence] || CADENCES.weekly;
  const noun = spec.noun;
  const { fromYmd, toYmd } = period;
  const absent = absentSkippedApiLps(report);

  const body = `
          ${renderNotes(report)}

          <p class="section-title">Headline Totals</p>
          ${renderTotals(report)}
          <p class="note">
            Client Swap is the backend&rsquo;s own total for this ${escapeHtml(noun)}, not a sum of the rows below. Negative client swap is charged to the client, so it is our revenue; positive is given to the client, so it is our cost.
            LP Swap is the sum of each LP&rsquo;s figure from the table below, and is shown only when every LP has one.
            ${absent > 0 ? `It does not include the ${fmtNum(absent, 0)} LP(s) the endpoint did not return.` : ""}
          </p>

          ${renderLpTable(report, noun)}

          ${renderClientMovers(report, noun)}`;

  return emailShell({
    theme: "light",
    title: `${spec.subjectWord} Swaps Report`,
    // Plain text, no entities: emailShell runs the subtitle through escapeHtml,
    // so an "&amp;" written here would reach the reader as "&amp;amp;".
    subtitle: "Management Reporting | Client and LP Swap",
    metaLines: [
      `Period: <strong>${escapeHtml(fromYmd)}</strong> to <strong>${escapeHtml(toYmd)}</strong>`,
      "Scope: all client accounts and all configured LP accounts",
      "Finalto costs read from cache (no live vendor pull)",
    ],
    body,
    footerLines: [
      "Automated report generated by the Swaps Reporting pipeline.",
      "Sign, from our side of the book: negative LP swap is a cost and positive is revenue; negative client swap is our revenue and positive is our cost.",
      "Unrealized is accrued swap on open positions at the moment this email was built. It is a snapshot, it covers no period, and it is never included in any total above.",
    ],
  });
}

// ── the one fetch ────────────────────────────────────────────────────────────

/**
 * `/api/SwapsReport` for one window. The only function here that touches the
 * network.
 *
 * Throws on any failure, naming the range. A half-empty Swaps email is worse
 * than no email: every LP would show a dash and read as "no statements
 * uploaded" rather than "the call died", and the reader would go chasing the LP
 * Statements page for a problem that is not there. So there is no fallback
 * payload and no partial result — the caller does not catch, the run fails, and
 * the failure names the window.
 */
export async function fetchSwapsReport(fromDate, toDate, { liveFinalto = SCHEDULED_LIVE_FINALTO } = {}) {
  const { from, to } = toUnixRange(fromDate, toDate);
  const range = `${toYmdUtc(fromDate)}..${toYmdUtc(toDate)}`;
  const params = new URLSearchParams({
    from: String(from),
    to: String(to),
    liveFinalto: String(liveFinalto),
  });

  let resp;
  try {
    resp = await backendFetch(`/api/SwapsReport?${params.toString()}`, { timeoutMs: SWAPS_RUN_TIMEOUT_MS });
  } catch (error) {
    // AbortSignal.timeout rejects with a bare TimeoutError that names neither
    // the endpoint nor the window, and "the operation was aborted" in a log is
    // indistinguishable from a network blip. The range is the diagnosis here:
    // this endpoint is slow, so knowing it was a month is most of the answer.
    const message = error?.message || String(error);
    throw new Error(
      `SwapsReport ${range} failed after up to ${SWAPS_RUN_TIMEOUT_MS / 1000}s: ${message}`,
    );
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`SwapsReport ${range} HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return parseSwapsReport(await resp.json());
}

// ── orchestration ────────────────────────────────────────────────────────────

/**
 * Fetch, build, send. Nothing schedules this yet; reports/schedulers.js is
 * deliberately untouched until the rendered email has been approved.
 */
export async function runSwapsEmailReport({
  cadence = "weekly",
  fromDate,
  toDate,
  recipients: recipientsOverride,
} = {}) {
  const spec = CADENCES[cadence];
  if (!spec) throw new Error(`Unknown cadence "${cadence}"`);
  const label = `Swaps${cadence[0].toUpperCase()}${cadence.slice(1)}`;

  const period = fromDate && toDate ? { start: fromDate, end: toDate } : spec.period();
  const fromYmd = toYmdUtc(period.start);
  const toYmd = toYmdUtc(period.end);

  // Recipients and the send guard are settled BEFORE the fetch, unlike the
  // sibling reports. Those call endpoints that answer in under a minute; this
  // one has been measured at 67 seconds for a single day and is budgeted for
  // three minutes. Spending that on a window that already went out, or on an
  // email with nowhere to go, is three minutes of a shared backend for nothing.
  const isScheduledRun = !(Array.isArray(recipientsOverride) && recipientsOverride.length);
  const recipients = isScheduledRun
    ? resolveRecipients(SWAPS_RECIPIENT_VARS[cadence])
    : recipientsOverride.map((e) => String(e).trim()).filter(Boolean);
  if (!recipients.length) {
    console.warn(`[${label}] No recipients configured. Skipping.`);
    return { ok: false, reason: "no-recipients", fromYmd, toYmd };
  }

  const windowKey = spec.windowKey(fromYmd, toYmd);
  if (isScheduledRun && (await alreadySentFor(SWAPS_GUARD_KEYS[cadence], windowKey))) {
    console.log(`[${label}] ${windowKey} already sent; skipping (restart, not a new ${spec.noun}).`);
    return { ok: false, reason: "already-sent", fromYmd, toYmd };
  }

  // No try/catch. A failed fetch must take the whole run down with a message
  // naming the range — see fetchSwapsReport.
  const report = await fetchSwapsReport(period.start, period.end);

  const subject = swapsSubject(cadence, fromYmd, toYmd);
  const html = buildSwapsEmailHtml({ report, period: { fromYmd, toYmd }, cadence });
  await sendBrevoEmail({ subject, html, recipients, senderName: "Swaps Reporter" });

  if (isScheduledRun) await recordSentFor(SWAPS_GUARD_KEYS[cadence], windowKey);

  console.log(
    `[${label}] Sent to ${recipients.join(", ")} | lps=${report.lps.length} clients=${report.clients.length} | period=${fromYmd}..${toYmd}`,
  );
  return { ok: true, lps: report.lps.length, clients: report.clients.length, fromYmd, toYmd };
}
