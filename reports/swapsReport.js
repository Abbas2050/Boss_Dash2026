// The Swaps report — the fourth email in the dealing family.
//
// WHY IT EXISTS: we pay swap three times over in three different ledgers and
// nobody reads all three. MT5 books Storage on every closed deal. The LP's own
// statement, uploaded as a PDF on the LP Statements page, says what the LP
// thinks we owe. And the terminal shows accrued swap on whatever is open right
// now. Those three numbers disagree, and the disagreement IS the report: a gap
// between MT5 and the statement is money we are either not being billed for or
// being billed twice for, and it is invisible unless the two are put on one row.
//
// WHY THE THREE FIGURES ARE NEVER ADDED TOGETHER: they measure the same cost on
// three different axes.
//
//   totalSwap       MT5 Storage on deals CLOSED INSIDE THE WINDOW. A true
//                   period figure: ask for last week and you get last week.
//   statementSwap   The LP's TotalSwaps, summed over statement rows dated
//                   inside the window. Also a period figure, from a different
//                   book, which is why subtracting it from totalSwap is a
//                   meaningful reconciliation.
//   unrealizedSwap  Accrued swap on positions that are open AT THE MOMENT THIS
//                   EMAIL IS BUILT. It is a snapshot. It belongs to no date
//                   range, it will be different an hour later, and adding it to
//                   either of the two above produces a number that describes no
//                   period at all.
//
// The last one has a history in this repo. A "Realized" row was once placed in
// the volume funnel as though it were a downstream stage of deal flow, and the
// funnel widened as you read down it, because Realized is the same flow counted
// on a different axis (see the note above renderVolumeSection). unrealizedSwap
// is exactly the same trap wearing different clothes. So it is rendered in its
// own labelled column, the label says "at send time" in every place it appears,
// and nothing in this file ever sums it into a period total. There is a test on
// that, on a fixture where folding it in would visibly change the figure.
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

// A dash means "could not read". 0.00 means "the value is zero". The whole
// reconciliation below turns on the difference between those two statements.
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
// Swaps report is already impossible on the default budget. A week or a month
// costs more, and unlike DealMatch/Run (whose ~40s is the cost of starting the
// match, not of the deals matched) nothing has established where SwapsReport
// settles as the window grows. So this is not a measured ceiling, it is the
// house long-route budget, chosen because inventing a bespoke number from one
// data point would be guessing with extra steps.
//
// If a monthly run still aborts at 180s, the answer is not a bigger number
// here: it is 180s at the proxy too, so anything longer would only move the
// failure. The report would then need to be built from narrower sub-windows.
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

// How many rows a mover table may print. A month has hundreds of accounts with
// a non-zero swap and the reader is on a phone, where table.data stacks every
// row into a card — three hundred cards is not a report. The cap is on the
// MOVERS, which are a ranked sample by construction; the reconciliation uses it
// too but says how many LPs it dropped, because there a missing row is a
// missing answer rather than a shorter tail.
export const SWAPS_ROW_CAP = 15;

export function swapsSubject(cadence, fromYmd, toYmd) {
  const word = CADENCES[cadence].subjectWord;
  // A single day rendered as "2026-08-31 to 2026-08-31" reads like a bug.
  const period = fromYmd === toYmd ? fromYmd : `${fromYmd} to ${toYmd}`;
  return `${word} Swaps Report (${period})`;
}

// ── parsing ──────────────────────────────────────────────────────────────────

// A figure the backend did not send is null, never zero. `Number(undefined) || 0`
// collapses "absent" and "genuinely zero" into one confident 0.00 and the reader
// cannot tell them apart — which is precisely the failure the statement column
// exists to avoid.
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The backend computes the totals. Returning null when they are missing lets the
// email say "unavailable"; summing the rows here would create a second answer to
// what we paid in swaps, and a reader comparing the email with the tab would
// have no way to tell which of the two was the real one.
//
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

/**
 * A raw `/api/SwapsReport` payload, normalised. Pure — hand it a fixture.
 *
 * Deliberately lenient about the ENVELOPE and strict about the FIGURES: an
 * absent `clients` array becomes [], which renders as "no rows", while an
 * absent `clientTotals` stays null and renders as "unavailable". The browser
 * client throws on a missing array because an operator is watching and can
 * retry; a scheduled email has nobody to retry it, and a report that says
 * "no client swaps" is less wrong than no report at all — the completeness
 * section says whether the panel actually failed.
 */
export function parseSwapsReport(payload) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const skipped = Number(source.skippedApiLpCount);
  const panelError = typeof source.clientPanelError === "string" ? source.clientPanelError.trim() : "";
  return {
    clients: readRows(source, "clients"),
    clientTotals: readTotals(source, "clientTotals"),
    lps: readRows(source, "lps"),
    lpTotals: readTotals(source, "lpTotals"),
    skippedApiLpCount: Number.isFinite(skipped) && skipped > 0 ? skipped : 0,
    clientPanelError: panelError || null,
    lpErrors: Array.isArray(source.lpErrors)
      ? source.lpErrors.map((e) => String(e)).filter((e) => e.trim().length > 0)
      : [],
  };
}

// ── row shaping (pure) ───────────────────────────────────────────────────────

function accountLabel(row) {
  const named = String(row?.lpName || row?.name || "").trim();
  if (named) return named;
  if (row?.login !== null && row?.login !== undefined && row.login !== "") return `login ${row.login}`;
  if (row?.id !== null && row?.id !== undefined) return `id ${row.id}`;
  return "Unidentified account";
}

/**
 * One LP's reconciliation line.
 *
 * `difference` is null whenever either side is missing. That is not a defensive
 * nicety: an LP with no uploaded statement has an UNKNOWN difference, and
 * rendering it as 0.00 would assert that MT5 and the LP agree, which is the
 * single most expensive lie this report could tell. An LP whose statement
 * genuinely totals zero keeps its 0.00 and gets a real difference.
 */
export function reconcileLp(row) {
  const mt5 = num(row?.totalSwap);
  const statement = num(row?.statementSwap);
  return {
    label: accountLabel(row),
    mt5,
    statement,
    statementRows: num(row?.statementRowCount),
    difference: mt5 === null || statement === null ? null : mt5 - statement,
    // Carried so the mover table can read one shaped row, never summed.
    unrealized: num(row?.unrealizedSwap),
    login: row?.login,
  };
}

/**
 * Reconciliation order: LPs whose difference is UNKNOWN first, then the rest by
 * the size of the gap.
 *
 * Unknowns lead because they are the rows that need someone to do something —
 * upload the statement — and because they are few, so they cannot push the
 * material discrepancies off the bottom. If the cap has to drop rows it drops
 * the smallest known gaps, which is the tail a reader would skip anyway; an
 * unknown falling off would silently convert "we cannot check this LP" into
 * "this LP was not worth mentioning".
 */
export function orderReconciliation(rows) {
  const magnitude = (v) => (v === null ? -1 : Math.abs(v));
  const unknown = rows.filter((r) => r.difference === null).sort((a, b) => magnitude(b.mt5) - magnitude(a.mt5));
  const known = rows.filter((r) => r.difference !== null).sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
  return [...unknown, ...known];
}

/**
 * Movers, biggest absolute swap first.
 *
 * Absolute, not most-negative-first: swap is a cost on most instruments and a
 * credit on some, and an account earning $4,000 of swap is exactly as worth
 * seeing as one paying it. Ranking by the signed value would bury every credit
 * at the bottom of a table that gets truncated.
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

// ── cells ────────────────────────────────────────────────────────────────────

function signCls(value) {
  if (value === null) return "muted";
  if (value > 0) return "pos";
  if (value < 0) return "neg";
  return "muted";
}

const swapText = (value) => (value === null ? DASH : money(value));
const countText = (value) => (value === null ? DASH : fmtNum(value, 0));

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

/**
 * Partial success, rendered before the figures rather than after them.
 *
 * The backend answers 200 with these set when part of the report could not be
 * built. Every figure below is then a figure over an incomplete set of LPs, so
 * the caveat has to arrive before the numbers it qualifies, not in a footnote
 * under them. "No swaps for that LP" and "we never asked that LP" are the same
 * dash-versus-zero distinction the statement column makes, moved up to the
 * level of the whole report.
 *
 * The all-clear is stated explicitly. An absent warning is indistinguishable
 * from a warning that failed to render, and this reader has lost a section to a
 * rendering bug before.
 */
function renderCompleteness(report) {
  const notes = [];
  if (report.skippedApiLpCount > 0) {
    notes.push({
      label: "API LPs skipped",
      detail: `${fmtNum(report.skippedApiLpCount, 0)} API LP(s) were never queried &mdash; only Xtb and Finalto are wired. Their swap is MISSING from every figure below; it is not zero.`,
    });
  }
  if (report.lpErrors.length > 0) {
    notes.push({
      label: "LP queries failed",
      detail: `${fmtNum(report.lpErrors.length, 0)} LP(s) failed: ${escapeHtml(report.lpErrors.join("; "))}`,
    });
  }
  if (report.clientPanelError) {
    notes.push({
      label: "Client panel failed",
      detail: `${escapeHtml(report.clientPanelError)} &mdash; the client figures below are missing or incomplete.`,
    });
  }

  const title = `<p class="section-title" style="margin-top:0;">Report Completeness</p>`;
  if (!notes.length) {
    return `${title}
          <p class="note">Every LP was queried and both panels returned. The figures below cover the whole book.</p>`;
  }

  const bodyRows = notes
    .map(
      (n) => `<tr>
        ${dataCell("Issue", escapeHtml(n.label), { nowrap: true, cls: "neg" })}
        ${proseCell("Detail", n.detail)}
      </tr>`,
    )
    .join("");

  return `${title}
          <p class="note">This report is incomplete. Read every figure below as covering only the LPs that answered.</p>
          ${dataTable({
            headers: [
              { label: "Issue", width: "28%" },
              { label: "Detail", width: "72%" },
            ],
            bodyRows,
            narrow: true,
          })}`;
}

/**
 * The headline totals, taken from the backend's own clientTotals / lpTotals.
 *
 * When one is null the card says Unavailable and the note says why. It is NOT
 * recomputed from the rows: the rows are the accounts the backend chose to
 * return, the total is what the backend actually measured, and a sum of the
 * former presented as the latter would be a second, quieter answer to "what did
 * we pay in swaps" that nobody could reconcile against the tab.
 */
function renderTotals(report) {
  const card = (label, totals, missingVar) =>
    totals
      ? {
          label,
          value: money(totals.totalSwap),
          cls: signCls(totals.totalSwap),
          note: `${fmtNum(totals.accountCount, 0)} accounts`,
        }
      : {
          label,
          value: "Unavailable",
          cls: "muted",
          note: `Backend sent no ${missingVar}; rows are not summed here`,
        };

  return kpiGrid(
    [
      card("Client Swap (period)", report.clientTotals, "clientTotals"),
      card("LP Swap (period)", report.lpTotals, "lpTotals"),
    ],
    { maxWidth: 260 },
  );
}

function renderReconciliation(report, periodNoun) {
  const all = orderReconciliation(report.lps.map(reconcileLp));
  const shown = all.slice(0, SWAPS_ROW_CAP);
  const dropped = all.length - shown.length;

  const headers = [
    { label: "LP", width: "24%" },
    { label: "MT5 Swap", width: "19%" },
    { label: "Statement Swap", width: "19%" },
    { label: "Difference", width: "19%" },
    { label: "Statement Rows", width: "19%" },
  ];

  const bodyRows = shown
    .map((r) => {
      // The reason travels with the dash. A dash on its own says "unknown" and
      // stops there; the reader's next question is always which of the two
      // books is missing, and the answer costs one line.
      let reason = "";
      if (r.statement === null) {
        reason = "No LP statement has been uploaded for this period, so the difference is <strong>unknown</strong> &mdash; not zero.";
      } else if (r.mt5 === null) {
        reason = "The backend sent no MT5 swap figure for this LP, so the difference is <strong>unknown</strong> &mdash; not zero.";
      }
      return `<tr>
        ${dataCell("LP", escapeHtml(r.label), { nowrap: true })}
        ${dataCell("MT5 Swap", swapText(r.mt5), { align: "right", cls: signCls(r.mt5) })}
        ${dataCell("Statement Swap", swapText(r.statement), { align: "right", cls: signCls(r.statement) })}
        ${dataCell("Difference", swapText(r.difference), { align: "right", cls: signCls(r.difference) })}
        ${dataCell("Statement Rows", countText(r.statementRows), { align: "right" })}
        ${reason ? reasonCell(reason, { colspan: headers.length }) : ""}
      </tr>`;
    })
    .join("");

  const unknownCount = all.filter((r) => r.difference === null).length;

  return `<p class="section-title">LP Reconciliation &mdash; MT5 vs Statement</p>
          <p class="note">
            Difference = MT5 Swap &minus; Statement Swap, over the same ${escapeHtml(periodNoun)}.
            An LP with no uploaded statement shows ${DASH}, never 0.00: the two books cannot be compared, which is not the same as their agreeing.
          </p>
          ${dataTable({
            headers,
            bodyRows,
            emptyText: `No LP rows for this ${escapeHtml(periodNoun)}.`,
          })}
          <p class="note">
            ${unknownCount > 0
              ? `<strong>${fmtNum(unknownCount, 0)} of ${fmtNum(all.length, 0)} LP(s) cannot be reconciled</strong> because no statement covers this ${escapeHtml(periodNoun)}.`
              : `All ${fmtNum(all.length, 0)} LP(s) have a statement covering this ${escapeHtml(periodNoun)}.`}
            ${dropped > 0 ? ` Showing the ${fmtNum(shown.length, 0)} most material; ${fmtNum(dropped, 0)} smaller LP(s) omitted.` : ""}
          </p>`;
}

/**
 * Top movers, one table per side.
 *
 * The Unrealized column is the only place the snapshot figure appears, its
 * label says "at send time" in full, and it sits beside a period figure without
 * ever being added to one. The column is here rather than dropped because the
 * accounts with the largest accrued swap on open positions are next month's
 * cost, and the reader asked for the three measurements side by side.
 */
function renderMovers({ title, rows, idLabel, periodNoun, emptyText }) {
  const all = orderMovers(rows);
  const shown = all.slice(0, SWAPS_ROW_CAP);
  const dropped = all.length - shown.length;

  const headers = [
    { label: idLabel, width: "30%" },
    { label: "Login", width: "16%" },
    { label: "Swap (period)", width: "27%" },
    { label: "Unrealized (at send time)", width: "27%" },
  ];

  const bodyRows = shown
    .map(
      (r) => `<tr>
        ${dataCell(idLabel, escapeHtml(r.label), { nowrap: true })}
        ${dataCell("Login", r.login === null || r.login === undefined || r.login === "" ? DASH : escapeHtml(String(r.login)), { nowrap: true })}
        ${dataCell("Swap (period)", swapText(r.swap), { align: "right", cls: signCls(r.swap) })}
        ${dataCell("Unrealized (at send time)", swapText(r.unrealized), { align: "right", cls: signCls(r.unrealized) })}
      </tr>`,
    )
    .join("");

  return `<p class="section-title">${title}</p>
          ${dataTable({ headers, bodyRows, emptyText })}
          <p class="note">
            Ranked by the size of Swap (period), credits and costs alike.
            ${dropped > 0 ? `Showing ${fmtNum(shown.length, 0)} of ${fmtNum(all.length, 0)} accounts; ${fmtNum(dropped, 0)} omitted.` : `All ${fmtNum(all.length, 0)} account(s) shown.`}
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

  const body = `
          ${renderCompleteness(report)}

          <p class="section-title">Headline Totals</p>
          ${renderTotals(report)}
          <p class="note">
            Both totals are the backend&rsquo;s own figures for this ${escapeHtml(noun)}, not sums of the rows below.
            They count MT5 storage on deals closed inside the window only.
          </p>

          ${renderReconciliation(report, noun)}

          ${renderMovers({
            title: "Top Movers &mdash; LP Accounts",
            rows: report.lps,
            idLabel: "LP",
            periodNoun: noun,
            emptyText: `No LP swap rows for this ${escapeHtml(noun)}.`,
          })}

          ${renderMovers({
            title: "Top Movers &mdash; Client Accounts",
            rows: report.clients,
            idLabel: "Account",
            periodNoun: noun,
            emptyText: `No client swap rows for this ${escapeHtml(noun)}.`,
          })}`;

  return emailShell({
    theme: "light",
    title: `${spec.subjectWord} Swaps Report`,
    // Plain text, no entities: emailShell runs the subtitle through escapeHtml,
    // so an "&amp;" written here would reach the reader as "&amp;amp;".
    subtitle: "Management Reporting | Swap Cost and LP Reconciliation",
    metaLines: [
      `Period: <strong>${escapeHtml(fromYmd)}</strong> to <strong>${escapeHtml(toYmd)}</strong>`,
      "Scope: all client accounts and all configured LP accounts",
      "Finalto costs read from cache (no live vendor pull)",
    ],
    body,
    footerLines: [
      "Automated report generated by the Swaps Reporting pipeline.",
      "MT5 Swap = &Sigma; Storage on deals closed in the period. Statement Swap = &Sigma; TotalSwaps on LP statement rows dated in the period.",
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
 * than no email: the reconciliation would show dashes for every LP and read as
 * "no statements uploaded" rather than "the call died", and the reader would go
 * chasing the LP Statements page for a problem that is not there. So there is
 * no fallback payload and no partial result — the caller does not catch, the
 * run fails, and the failure names the window that was too wide.
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
    // this endpoint is slow in proportion to the window, so knowing it was a
    // month is most of the answer.
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
