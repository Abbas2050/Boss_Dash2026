// The MT5 volume section — one section, mounted by all three report families.
//
// WHY IT EXISTS: the ten lot metrics on the Deal Matching tab appear nowhere in
// the emails, and the single most useful fact about the week's volume is
// invisible without them: roughly 2% of deal volume reaches an LP. Read without
// that, "we traded 203k lots and made $40k" looks like a bad week rather than an
// ordinary one.
//
// WHY IT IS ITS OWN MODULE: three reports need identical markup, and `dataCell`
// is already hand-copied three times across those same files. A fourth copy of
// this section would drift the way the Net Revenue arithmetic once drifted
// between the tab and the email.
//
// WHY THE THREE CONCERNS ARE SEPARATE: extraction is pure, rendering is pure,
// and exactly one function touches the network. Every degradation case —
// a missing scalar, a zero denominator, a failed fetch — is then testable
// without a network stub.
//
// Design: docs/superpowers/specs/2026-09-04-report-volume-section-design.md
import { backendFetch, dataCell, escapeHtml, fmtNum, toUnixRange } from "./reportShared.js";

const DASH = "&mdash;";

// Same budget the Deal Match report proved it needs. DealMatch/Run costs ~40s
// whatever window it is asked for — 41.8s for one day, 40.4s for a month,
// measured 2026-08-31 — because the cost is in starting the match, not in the
// deals matched. The 45s default in reportShared would leave under four seconds
// of headroom.
export const VOLUME_RUN_TIMEOUT_MS = 180_000;

// ── extraction ───────────────────────────────────────────────────────────────

// A scalar the backend did not send is null, never zero.
//
// `Number(undefined) || 0` collapses "absent" and "genuinely zero" into the same
// confident 0.00, and a reader cannot tell them apart. A dash says "could not
// read"; 0.00 says "the value is zero". Only one of those can be wrong silently.
//
// All ten scalars are now confirmed present under `lite=true` -- including
// `totalShiftingRealizedLots` and `totalInternalAccountRealizedLots`, which were
// unverified when this file was written and were checked live on 2026-09-04 (see
// docs/dealing-reporting.md). So no cell is expected to read "—" today. This
// guard stays anyway: the payload is the backend's to change, and the failure it
// prevents -- a dropped field silently becoming a real-looking 0.00 in a volume
// report -- is exactly the kind that goes unnoticed for months.
function scalar(report, key) {
  const raw = report?.[key];
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// A sum is only as trustworthy as its parts. If either side is missing the total
// is unknown, not the half that happened to arrive — reporting client deals as
// "total deals" because shifting was absent would understate the denominator
// every percentage below is measured against.
function sumOrNull(...parts) {
  return parts.some((p) => p === null) ? null : parts.reduce((a, b) => a + b, 0);
}

/**
 * The ten figures, each a number or null, from a `DealMatch/Run` response.
 * Pure: hand it a parsed payload, a fixture, or nothing at all.
 */
export function extractVolume(report) {
  if (!report || typeof report !== "object") return null;

  const clientDeals = scalar(report, "totalMt5DealLots");
  const shiftingDeals = scalar(report, "totalShiftingMt5DealLots");
  const realizedCfd = scalar(report, "totalRealizedLotsCfd");
  const realizedEquity = scalar(report, "totalRealizedLotsEquity");

  return {
    // Deal lots count every MT5 deal, so a round trip appears twice. This is the
    // denominator for every percentage in the flow table.
    totalDeals: sumOrNull(clientDeals, shiftingDeals),
    clientDeals,
    shiftingDeals,
    shiftingRealized: scalar(report, "totalShiftingRealizedLots"),
    // A parallel bucket, not a subset of client lots (docs/dealing-reporting.md
    // §4): internal logins do not appear in clientRevenueSummaries at all.
    internalDeals: scalar(report, "totalInternalAccountLots"),
    internalRealized: scalar(report, "totalInternalAccountRealizedLots"),
    realizedCfd,
    realizedEquity,
    // The backend sums these two itself — CFD + equity equals ClientVolume/Run's
    // totalLots exactly — so the combined figure is established, not invented.
    realizedTotal: sumOrNull(realizedCfd, realizedEquity),
    bridgeLots: scalar(report, "totalBridgeLots"),
    matchedLots: scalar(report, "totalMatchedLots"),
  };
}

// ── rendering ────────────────────────────────────────────────────────────────

// Only the muted text colour differs between the three shells. Nothing else in
// the section needs a colour of its own any more: every figure now sits in a
// table.data cell, and all three shells already style those for their theme.
//
// There used to be a track colour and a palette of stage colours here, for bars
// drawn as nested tables. They are gone — see the note above renderVolumeSection.
const THEMES = {
  light: { muted: "#64748b" },
  dark: { muted: "#8ea4c6" },
};

// One line per figure: what it means, and the arithmetic where there is any.
//
// WHY THE TEXT IS VISIBLE RATHER THAN A TOOLTIP: the dealing tab explains these
// same ten numbers with `title` attributes
// (src/pages/departments/dealing/DealMatchingTab.tsx:1316). A `title` renders
// nowhere in a mail client, and nothing in these templates may depend on hover.
//
// WHY IT IS THE TAB'S WORDING: five of these sentences are lifted from those
// tooltips verbatim, so the email and the dashboard remain one explanation of
// one number rather than two that drift. Shifting Deals, Shifting Realized and
// Internal Realized had no tooltip; those three are written from
// docs/dealing-reporting.md §1 and §4, not invented.
//
// WHY THEY ARE SHORT: the reader is on a phone. These lines sit under ten
// figures they came for; a paragraph each would bury them. Each explanation
// also absorbs a caption that used to say the same thing further down — the
// flow table's "the three rows follow one path", the breakdown's "internal
// accounts are a separate bucket" — so the section carries the material once.
const EXPLAIN = {
  realized:
    "The same deal flow counted once per round trip rather than twice &mdash; a parallel measure of the volume below, not a part of it. It reconciles with client volume.",
  split: "Closed CFD and closed equity volume. Equity lots are share-based, so they dwarf CFD.",
  totalDeals: "Client deal lots plus shifting deal lots. Counts every MT5 deal, so an open and its close each count.",
  bridge: "Volume that reached the bridge to be hedged.",
  matched: "Client volume matched to an LP order &mdash; the only part of the flow that reached an LP.",
  client: "MT5 client deal lots (each leg counted), and the closed volume behind them.",
  shifting: "Shifting-account deal lots and their closed volume. Counted inside Total MT5 Deals above.",
  internal:
    "Internal-account deal lots and their closed volume &mdash; a separate bucket, not part of client flow, so not a funnel stage. Excluded from the Slippage report; included here.",
};

// The vx class and data-exp are markers, not styling: no shell defines them.
// They make "does this figure carry an explanation?" a structural question, so
// the coverage test never reads the prose and a copy edit cannot break it.
// data-exp pairs with the data-fig on the cell or row the line explains.
function explain(key, t, { colspan = 1, pad = "0 8px 4px" } = {}) {
  // max-width:none overrides table.data's 156px cell cap inline, so an
  // explanation runs the full width of its row instead of being squeezed into
  // the width of a fourth column.
  return `<td class="vx" data-exp="${key}" colspan="${colspan}" style="max-width:none;width:100%;padding:${pad};font-size:11px;line-height:1.45;color:${t.muted};">${EXPLAIN[key]}</td>`;
}

const lots = (value) => (value === null ? DASH : fmtNum(value, 2));

// Share of the denominator, or null when there is no denominator to divide by.
// A zero total must yield a dash rather than 0% or NaN: dividing by it is not a
// small number, it is an unanswerable question.
function shareOf(value, total) {
  if (value === null || total === null || !total) return null;
  return (value / total) * 100;
}

// The share cell of a flow row.
//
// The visible text is a whole number because that is how the figure is quoted —
// "about 2% of deal volume reaches an LP". data-share carries the same share to
// one decimal, and it exists for the monotonicity guard: 87.9% and 87.8% both
// print as 88%, so an inversion of less than a point would be invisible to a
// test that could only read the rounded text. This replaces the bar width the
// guard used to measure.
//
// The denominator row prints 100%, not an empty cell. When this was a bar chart
// a full-width bar said that on the total's behalf; in a table it does not, and
// table.data stacks each row into a card on a phone — so an empty cell there
// renders as the label "Share" with nothing beneath it, which reads as a figure
// that failed to load rather than as one that is self-evident. The reader has
// already lost this section once to a rendering problem; an empty labelled cell
// is not a risk worth taking to avoid stating the obvious.
//
// `show` therefore no longer suppresses the text, only the rounding path: the
// total is exactly 100 by construction, never 99.96 rounded up.
function shareCell(share, { show }) {
  const exact = share === null ? "" : share.toFixed(1);
  const text = share === null ? DASH : show ? `${Math.round(share)}%` : "100%";
  return dataCell("Share", `<span class="vs" data-share="${exact}">${text}</span>`, { align: "right" });
}

/**
 * The section's email HTML. Pure — no fetching, no formatting decisions left to
 * the caller. Pass `null` for `volume` to render the section as unavailable,
 * optionally naming why.
 */
export function renderVolumeSection(volume, { theme = "light", unavailableReason = null } = {}) {
  const t = THEMES[theme] || THEMES.light;
  const title = `<p class="section-title" style="margin-top:18px;">MT5 Volume Flow</p>`;

  if (!volume) {
    const why = unavailableReason ? ` &mdash; ${escapeHtml(unavailableReason)}` : "";
    return `${title}
          <p style="font-size:12px;color:${t.muted};margin:0 0 10px;">Volume data was unavailable when this report was generated${why}.</p>`;
  }

  const total = volume.totalDeals;
  // Three rows, each a share of Total MT5 Deals, and every one of them about
  // where the deal flow was ROUTED. That is what makes the sequence real: deals
  // arrive, some reach the bridge, and some of those pair with an LP order. The
  // shares can only fall as you go down.
  //
  // Realized used to sit here as a second stage and it broke the shape. On
  // 2026-09-02 the live figures were 497.10 total, 149.70 realized, 356.84
  // bridge — a sequence that narrowed to 30% and then widened back to 72%.
  // Realized is not downstream of anything: it is the SAME deal flow counted
  // once per round trip instead of twice, a different unit on a different axis.
  // It is therefore in the breakdown table below, not in this one.
  //
  // Internal lots are absent for a different reason: they are a parallel bucket,
  // not a subset, so listing them here would assert a containment that does not
  // hold. They belong to the breakdown too.
  const stages = [
    { key: "totalDeals", label: "Total MT5 Deals", value: total, share: shareOf(total, total), showPct: false },
    { key: "bridge", label: "Bridge Lots", value: volume.bridgeLots, share: shareOf(volume.bridgeLots, total), showPct: true },
    { key: "matched", label: "Matched Lots", value: volume.matchedLots, share: shareOf(volume.matchedLots, total), showPct: true },
  ];

  const cfdEquity = volume.realizedCfd === null && volume.realizedEquity === null
    ? DASH
    : `${lots(volume.realizedCfd)} / ${lots(volume.realizedEquity)}`;

  // WHY BOTH TABLES ARE table.data, AND WHY NOTHING HERE DRAWS A BAR.
  //
  // Until 2026-09-04 this section drew its flow rows and its Realized headline
  // as hand-rolled `<table role="presentation">` blocks, sized by inline <td>
  // widths and marked with vf-* / vr-* class names that no shell stylesheet
  // defines. The bars were nested tables inside those cells. On the morning of
  // 2026-09-04 the reader opened the Daily Digest on a phone in Zoho and saw the
  // two headings and nothing else — no figures at all. The one part of the
  // section that did render was the breakdown, which was already table.data.
  //
  // So the section is now built only out of the construction every other table
  // in every one of these reports uses: `table.data` rows of `dataCell()`. That
  // markup is styled by all three shells, and it is the markup that is known to
  // survive this reader's client. The bars are gone with it — they were always
  // the fragile element, and the reader asked for a table instead.
  //
  // The explanation is a fourth cell of the same row rather than a row of its
  // own. table.data renders every row as a stacked card with inline-block cells,
  // so a full-width cell simply wraps onto the next line inside the card — where
  // a separate <tr> would add a zebra stripe and a rule, and read as twice as
  // many rows.
  const flowRow = ({ key, label, value, share, showPct }) => `<tr data-fig="${key}">
                ${dataCell("Stage", escapeHtml(label), { nowrap: true })}
                ${dataCell("Lots", lots(value), { align: "right" })}
                ${shareCell(share, { show: showPct })}
                ${explain(key, t)}
              </tr>`;

  const breakdownRow = (key, bucket, deals, realized) => `<tr data-fig="${key}">
                ${dataCell("Bucket", escapeHtml(bucket), { nowrap: true })}
                ${dataCell("Deals", deals, { align: "right" })}
                ${dataCell("Realized", realized, { align: "right" })}
                ${explain(key, t)}
              </tr>`;

  // Realized leads the breakdown, immediately followed by its CFD / Equity
  // split, because it is one of the two numbers this section exists to report
  // and the only one that reconciles with ClientVolume/Run. It sits at the head
  // of a table of buckets rather than anywhere in the flow table, so it can be
  // read first without ever reading as a step the flow passes through.
  return `${title}
          <table class="data narrow">
            <thead>
              <tr><th width="40%">Stage</th><th width="30%">Lots</th><th width="30%">Share</th></tr>
            </thead>
            <tbody>
              ${stages.map(flowRow).join("\n              ")}
            </tbody>
          </table>
          <p style="font-size:11px;color:${t.muted};margin:0 0 12px;">
            Percentages are of deal volume.
          </p>

          <p class="section-title" style="margin-top:14px;">Volume Breakdown</p>
          <table class="data narrow">
            <thead>
              <tr><th width="40%">Bucket</th><th width="30%">Deals</th><th width="30%">Realized</th></tr>
            </thead>
            <tbody>
              ${breakdownRow("realized", "Realized", DASH, lots(volume.realizedTotal))}
              ${breakdownRow("split", "CFD / Equity split", DASH, cfdEquity)}
              ${breakdownRow("client", "Client", lots(volume.clientDeals), lots(volume.realizedTotal))}
              ${breakdownRow("shifting", "Shifting", lots(volume.shiftingDeals), lots(volume.shiftingRealized))}
              ${breakdownRow("internal", "Internal", lots(volume.internalDeals), lots(volume.internalRealized))}
            </tbody>
          </table>`;
}

// ── the one fetch ────────────────────────────────────────────────────────────

/**
 * `DealMatch/Run` for the Slippage report, which is the only one of the three
 * that does not already hold a response. Deal Match and the Business Summary
 * pass theirs to `extractVolume` directly — adding a call there would cost each
 * of them another ~40 seconds for a payload they already have.
 *
 * Throws on any failure. The caller is expected to catch: a new enrichment must
 * never be able to suppress a report that works today.
 */
export async function fetchVolumeReport(fromDate, toDate) {
  const { from, to } = toUnixRange(fromDate, toDate);
  const params = new URLSearchParams({
    group: "*",
    from: String(from),
    to: String(to),
    symbol: "",
    // Summary mode. Carries the total* scalars this section reads; lite=false
    // would additionally return every match row, ~45 MB for a month.
    lite: "true",
  });

  const resp = await backendFetch(`/DealMatch/Run?${params.toString()}`, { timeoutMs: VOLUME_RUN_TIMEOUT_MS });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`DealMatch/Run HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}
