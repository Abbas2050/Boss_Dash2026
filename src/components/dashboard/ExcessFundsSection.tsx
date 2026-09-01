import { computeExcessFunds, type ExcessFundsInputs } from "@/lib/excessFunds";

// The Excess Funds section: a header row, the two headline figures side by
// side, and the seven inputs that feed them grouped by where each one came
// from.
//
// Its own component rather than a tenth of AccountsDepartment.tsx, which is
// already 964 lines.
//
// Design: docs/superpowers/specs/2026-09-01-excess-funds-cards-design.md

export interface ExcessFundsSectionProps {
  inputs: ExcessFundsInputs;
  // Display only. The arithmetic uses inputs.netDifference, which is the
  // backend's own field -- subtracting these two here would create a second
  // answer to a question already answered upstream.
  lpEquity: number | null;
  clientEquity: number | null;
  // Where the two FAB balances were actually read from, so a wrong figure can be
  // traced to the cell it came from without opening the server. Kept in the API
  // response for diagnostics; the cell address itself never reaches the UI.
  fabSource?: { tab: string; cells: Record<string, string> } | null;
  // Staleness. An arithmetically complete figure says nothing about how old its
  // inputs are: a failed wallet refresh leaves the widgets at the last good
  // read, and a failed equity fetch leaves netDifference frozen with the section
  // none the wiser. Both must be visible ON this section -- an error message in
  // a different block a page away is not a signal a reader will connect.
  walletError?: string | null;
  equityError?: string | null;
  // The wallet's own "Updated:" timestamp, and when the FAB workbook was read.
  walletUpdated?: string;
  fabFetchedAt?: string;
}

type Tone = "positive" | "negative" | "neutral";

export interface ExcessHeadline {
  label: string;
  value: string;
  tone: Tone;
  why: string;
  unavailable: boolean;
}

export interface ExcessSourceRow {
  label: string;
  value: string;
  tone: Tone;
}

export interface ExcessSourceGroup {
  title: string;
  rows: ExcessSourceRow[];
}

const DASH = "—";

function money(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  const text = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value < 0 ? `-$${text}` : `$${text}`;
}

function tone(value: number | null): Tone {
  if (value === null || !Number.isFinite(value)) return "neutral";
  // Zero is neither. Break-even excess funds is not a surplus and must not
  // render green, which is read across this dashboard as "there is money here to
  // move".
  //
  // Rounded to cents rather than tested against literal 0, because these figures
  // are sums of floats: -1,190,369.63 + 500,000 + 590,369.63 + 100,000 is zero
  // in arithmetic and 2.3e-10 in IEEE 754. money() prints that as "$0.00", so a
  // literal `=== 0` would leave the card reading $0.00 in green -- the exact
  // impression this rule exists to prevent.
  if (Math.round(value * 100) === 0) return "neutral";
  return value < 0 ? "negative" : "positive";
}

// The time part only: the section is read on a phone, where a full ISO stamp
// wraps and buys nothing.
function clockTime(iso?: string): string | null {
  if (!iso) return null;
  const dt = new Date(iso);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// The two headline figures, in order. Both read their unavailable/why state
// from computeExcessFunds's own `missing` list -- that function already holds
// every rule about which inputs can go missing and why; re-deriving it here
// would risk disagreeing with it.
export function excessHeadlines({ inputs }: ExcessFundsSectionProps): [ExcessHeadline, ExcessHeadline] {
  const { gross, net } = computeExcessFunds(inputs);
  const unavailable = (missing: string[]) => `Unavailable — could not read ${missing.join(", ")}.`;

  return [
    {
      label: "Gross excess fund",
      value: money(gross.value),
      tone: tone(gross.value),
      unavailable: gross.missing.length > 0,
      why: gross.missing.length ? unavailable(gross.missing) : "Equity gap, plus crypto, bank and gold",
    },
    {
      label: "Net excess fund",
      value: money(net.value),
      tone: tone(net.value),
      unavailable: net.missing.length > 0,
      why: net.missing.length ? unavailable(net.missing) : "Gross, plus both company accounts",
    },
  ];
}

// The seven inputs, grouped by where each one came from -- Equity, Wallet and
// bank, Company accounts -- so a reader can see at a glance which source a
// figure is standing on.
export function excessSourceGroups({ inputs, lpEquity, clientEquity }: ExcessFundsSectionProps): ExcessSourceGroup[] {
  return [
    {
      title: "Equity",
      rows: [
        { label: "LP", value: money(lpEquity), tone: tone(lpEquity) },
        { label: "Client", value: money(clientEquity), tone: tone(clientEquity) },
        // The backend's own netDifference, not lpEquity - clientEquity computed
        // here. That value already answers this question upstream; subtracting
        // the two cards again would risk a second, disagreeing answer.
        { label: "Gap", value: money(inputs.netDifference), tone: tone(inputs.netDifference) },
      ],
    },
    {
      title: "Wallet and bank",
      rows: [
        { label: "Crypto", value: money(inputs.netCrypto), tone: tone(inputs.netCrypto) },
        { label: "FAB and MBME", value: money(inputs.fabAndMbme), tone: tone(inputs.fabAndMbme) },
        { label: "Gold Souq", value: money(inputs.goldSouq), tone: tone(inputs.goldSouq) },
      ],
    },
    {
      title: "Company accounts",
      rows: [
        // Named for the entity, not "FAB" -- "FAB Operating Balance" beside
        // "FAB and MBME" above read as the same account twice. These are
        // separate companies, from a different sheet.
        { label: "Skylinks Capital LLC", value: money(inputs.fabOperating), tone: tone(inputs.fabOperating) },
        { label: "Skylink holdings", value: money(inputs.fabHolding), tone: tone(inputs.fabHolding) },
      ],
    },
  ];
}

export function ExcessFundsSection(props: ExcessFundsSectionProps) {
  const [gross, net] = excessHeadlines(props);
  const groups = excessSourceGroups(props);

  const toneClass = (t: Tone) =>
    t === "negative" ? "text-destructive" : t === "positive" ? "text-success" : "text-muted-foreground";

  const stale = [
    props.walletError ? `wallet balances (${props.walletError})` : null,
    props.equityError ? `LP/client equity (${props.equityError})` : null,
  ].filter(Boolean) as string[];

  const asOf = [
    props.walletUpdated && props.walletUpdated !== "—" ? `wallet ${props.walletUpdated}` : null,
    clockTime(props.fabFetchedAt) ? `FAB ${clockTime(props.fabFetchedAt)}` : null,
  ].filter(Boolean) as string[];

  return (
    <div className="pt-2 border-t border-border/30">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className="text-xs font-semibold text-foreground">Excess Funds</div>
        {asOf.length ? <div className="text-[10px] text-muted-foreground">{asOf.join(" · ")}</div> : null}
      </div>

      {stale.length ? (
        <div className="text-[10px] text-destructive mb-1.5">
          Figures below may be stale — last refresh failed for {stale.join(" and ")}.
        </div>
      ) : null}

      {/* The two headline figures, side by side and large -- this is the answer
          most readers came for; everything below is where it came from. */}
      <div className="grid grid-cols-2 gap-1.5 mb-2">
        {[gross, net].map((h) => (
          <div key={h.label} className="p-2.5 rounded-md border bg-primary/10 border-primary/20">
            <div className="text-[10px] text-muted-foreground mb-0.5">{h.label}</div>
            <div className={`font-mono tabular-nums font-semibold text-xl ${toneClass(h.tone)}`}>{h.value}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">{h.why}</div>
          </div>
        ))}
      </div>

      {/* The seven inputs, grouped by source so it is obvious which figure came
          from where. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
        {groups.map((group) => (
          <div key={group.title} className="p-2 rounded-md border bg-muted/30 border-border/30">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">
              {group.title}
            </div>
            {group.rows.map((row) => (
              <div key={row.label} className="flex items-center justify-between gap-2 py-0.5 text-[11px]">
                <span className="text-muted-foreground">{row.label}</span>
                <span className={`font-mono tabular-nums ${toneClass(row.tone)}`}>{row.value}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
