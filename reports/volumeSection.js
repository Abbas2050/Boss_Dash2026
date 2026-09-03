// The MT5 Volume Funnel — one section, mounted by all three report families.
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
    // denominator for every percentage in the funnel.
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

// Only the text and track colours differ between the three shells; the bar fills
// are the same in both, because they are read as categories rather than as part
// of the surrounding palette.
const THEMES = {
  light: { muted: "#64748b", track: "#e8eef6" },
  dark: { muted: "#8ea4c6", track: "#1b2942" },
};

// One colour per funnel stage. Realized has none because it is not a stage: it
// is drawn as a headline figure with no bar at all (see renderVolumeSection).
const STAGE_COLORS = {
  total: "#0f766e",
  bridge: "#b45309",
  matched: "#15803d",
};

// The headline figure's accent. Deliberately not one of the STAGE_COLORS, so a
// reader does not group Realized with the bars below it by colour.
const REALIZED_COLOR = "#0891b2";

const lots = (value) => (value === null ? DASH : fmtNum(value, 2));

// Share of the denominator, or null when there is no denominator to divide by.
// A zero total must yield a dash rather than 0% or NaN: dividing by it is not a
// small number, it is an unanswerable question.
function shareOf(value, total) {
  if (value === null || total === null || !total) return null;
  return (value / total) * 100;
}

// One bar: a nested table split into a filled cell and the remaining track.
//
// NOT a pseudo-element, not flex, not a grid. Outlook drops all three, and these
// templates already avoid ::before and @media deliberately — the row labels are
// real text for the same reason. A percentage width on a <td> is the one bar
// technique every mail client still honours.
//
// A stage whose value is unavailable gets no table at all (see stageRow). A
// stage that is genuinely zero still gets its track, so an empty bar and an
// absent bar never look alike.
function bar(share, color, t) {
  const width = Math.max(0, Math.min(100, Number.isFinite(share) ? share : 0));
  const filled = width > 0
    ? `<td width="${width.toFixed(1)}%" style="width:${width.toFixed(1)}%;background:${color};font-size:0;line-height:12px;height:12px;">&nbsp;</td>`
    : "";
  const rest = 100 - width;
  const remainder = rest > 0
    ? `<td width="${rest.toFixed(1)}%" style="width:${rest.toFixed(1)}%;background:${t.track};font-size:0;line-height:12px;height:12px;">&nbsp;</td>`
    : "";
  return `<table role="presentation" width="100%" style="width:100%;border-collapse:collapse;table-layout:fixed;"><tr>${filled}${remainder}</tr></table>`;
}

// The vf-* classes are markers, not styling: no shell defines them. They name
// the four cells so a test can address one without parsing around the nested
// table a bar is made of. They are also what makes "is this a funnel stage?"
// a structural question rather than a question about wording: a figure carrying
// a vf-label cell is a stage, and nothing else in the section carries one.
function stageRow({ label, value, color, share, showPct }, t) {
  const pct = showPct ? (share === null ? DASH : `${Math.round(share)}%`) : "";
  return `<tr>
              <td class="vf-label" style="padding:3px 8px 3px 0;width:34%;font-size:12px;color:${t.muted};">${escapeHtml(label)}</td>
              <td class="vf-bar" style="padding:3px 0;width:24%;">${value === null ? "" : bar(share === null ? 0 : share, color, t)}</td>
              <td class="vf-value" style="padding:3px 0 3px 8px;width:27%;font-size:12px;font-weight:700;text-align:right;white-space:nowrap;">${lots(value)}</td>
              <td class="vf-pct" style="padding:3px 0 3px 8px;width:15%;font-size:12px;color:${t.muted};text-align:right;white-space:nowrap;">${pct}</td>
            </tr>`;
}

/**
 * The section's email HTML. Pure — no fetching, no formatting decisions left to
 * the caller. Pass `null` for `volume` to render the section as unavailable,
 * optionally naming why.
 */
export function renderVolumeSection(volume, { theme = "light", unavailableReason = null } = {}) {
  const t = THEMES[theme] || THEMES.light;
  const title = `<p class="section-title" style="margin-top:18px;">MT5 Volume Funnel</p>`;

  if (!volume) {
    const why = unavailableReason ? ` &mdash; ${escapeHtml(unavailableReason)}` : "";
    return `${title}
          <p style="font-size:12px;color:${t.muted};margin:0 0 10px;">Volume data was unavailable when this report was generated${why}.</p>`;
  }

  const total = volume.totalDeals;
  // Three stages, each a share of Total MT5 Deals, and every one of them about
  // where the deal flow was ROUTED. That is what makes the sequence real: deals
  // arrive, some reach the bridge, and some of those pair with an LP order. The
  // shares can only fall as you go down.
  //
  // Realized used to sit here as a second stage and it broke the shape. On
  // 2026-09-02 the live figures were 497.10 total, 149.70 realized, 356.84
  // bridge — a funnel that narrowed to 30% and then widened back to 72%.
  // Realized is not downstream of anything: it is the SAME deal flow counted
  // once per round trip instead of twice, a different unit on a different axis.
  // It is now a headline figure beside the funnel rather than a stage in it.
  //
  // Internal lots are absent for a different reason: they are a parallel bucket,
  // not a subset, so drawing them here would assert a containment that does not
  // hold. They belong to the breakdown below.
  const stages = [
    { label: "Total MT5 Deals", value: total, color: STAGE_COLORS.total, share: shareOf(total, total), showPct: false },
    { label: "Bridge Lots", value: volume.bridgeLots, color: STAGE_COLORS.bridge, share: shareOf(volume.bridgeLots, total), showPct: true },
    { label: "Matched Lots", value: volume.matchedLots, color: STAGE_COLORS.matched, share: shareOf(volume.matchedLots, total), showPct: true },
  ];

  const cfdEquity = volume.realizedCfd === null && volume.realizedEquity === null
    ? DASH
    : `${lots(volume.realizedCfd)} / ${lots(volume.realizedEquity)}`;

  // Realized as its own headline, above the funnel and at the funnel's own type
  // size, because it is one of the two numbers this section exists to report —
  // and the only one that reconciles with ClientVolume/Run. Demoting it to a
  // footnote would lose the figure a reader most often needs to quote. The
  // vr-* markers keep it addressable; it carries no vf-label, so it is not a
  // stage by the same structural test the funnel rows answer to.
  const realized = `<table role="presentation" width="100%" style="width:100%;border-collapse:collapse;margin:0 0 10px;">
            <tr>
              <td class="vr-label" style="padding:3px 8px 3px 0;font-size:12px;font-weight:700;color:${REALIZED_COLOR};">Realized</td>
              <td class="vr-value" style="padding:3px 0 3px 8px;font-size:14px;font-weight:700;text-align:right;white-space:nowrap;">${lots(volume.realizedTotal)}</td>
            </tr>
            <tr>
              <td style="padding:0 8px 0 0;font-size:12px;color:${t.muted};">CFD / Equity</td>
              <td class="vr-split" style="padding:0 0 0 8px;font-size:12px;color:${t.muted};text-align:right;white-space:nowrap;">${cfdEquity}</td>
            </tr>
          </table>
          <p style="font-size:11px;color:${t.muted};margin:0 0 12px;">
            Realized is the same deal flow counted once per round trip rather than twice &mdash;
            a parallel measure of the volume below, not a smaller part of it. It is the figure
            that reconciles with client volume. Equity lots are share-based and dwarf CFD lots,
            which is why the split is shown beside the total.
          </p>`;

  const breakdownRow = (bucket, deals, realized) => `<tr>
                ${dataCell("Bucket", escapeHtml(bucket), { nowrap: true })}
                ${dataCell("Deals", deals, { align: "right" })}
                ${dataCell("Realized", realized, { align: "right" })}
              </tr>`;

  return `${title}
          ${realized}
          <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;margin:0 0 6px;">
            ${stages.map((s) => stageRow(s, t)).join("\n            ")}
          </table>
          <p style="font-size:11px;color:${t.muted};margin:0 0 12px;">
            Percentages are of deal volume. The three rows follow one path: every MT5 deal
            lot, the part of it that reached the bridge, and the part of that which paired
            with an LP order. Only Matched Lots reached an LP.
          </p>

          <p class="section-title" style="margin-top:14px;">Volume Breakdown</p>
          <p style="font-size:11px;color:${t.muted};margin:0 0 8px;">
            Internal accounts are a separate bucket rather than part of client flow, which
            is why they are listed here and not drawn as a stage of the funnel above.
          </p>
          <table class="data narrow">
            <thead>
              <tr><th width="40%">Bucket</th><th width="30%">Deals</th><th width="30%">Realized</th></tr>
            </thead>
            <tbody>
              ${breakdownRow("Client", lots(volume.clientDeals), lots(volume.realizedTotal))}
              ${breakdownRow("Shifting", lots(volume.shiftingDeals), lots(volume.shiftingRealized))}
              ${breakdownRow("Internal", lots(volume.internalDeals), lots(volume.internalRealized))}
              <tr>
                ${dataCell("Bucket", "CFD / Equity split", { nowrap: true })}
                ${dataCell("Deals", DASH, { align: "right" })}
                ${dataCell("Realized", cfdEquity, { align: "right" })}
              </tr>
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
