import { computeExcessFunds, type ExcessFundsInputs } from "@/lib/excessFunds";

// The Excess Funds section: seven inputs and the two figures they produce.
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
  // traced to the cell it came from without opening the server.
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

export interface ExcessCard {
  label: string;
  value: string;
  tone: "positive" | "negative" | "neutral";
  note?: string;
  emphasis?: boolean;
}

const DASH = "—";

function money(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  const text = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value < 0 ? `-$${text}` : `$${text}`;
}

function tone(value: number | null): ExcessCard["tone"] {
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

// "Sheet1!B2". Shown on the two FAB cards so a figure that looks wrong can be
// checked against the cell it was read from.
function cellRef(source: ExcessFundsSectionProps["fabSource"], key: string): string | undefined {
  const cell = source?.cells?.[key];
  if (!source?.tab || !cell) return undefined;
  return `${source.tab}!${cell}`;
}

// The time part only: the section is read on a phone, where a full ISO stamp
// wraps and buys nothing.
function clockTime(iso?: string): string | null {
  if (!iso) return null;
  const dt = new Date(iso);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function excessFundsCards({ inputs, lpEquity, clientEquity, fabSource }: ExcessFundsSectionProps): ExcessCard[] {
  const { gross, net } = computeExcessFunds(inputs);
  const unavailable = (missing: string[]) => `Unavailable — could not read ${missing.join(", ")}.`;

  return [
    { label: "Net LP Equity", value: money(lpEquity), tone: tone(lpEquity) },
    { label: "Net Client Equity", value: money(clientEquity), tone: tone(clientEquity) },
    { label: "Net Crypto", value: money(inputs.netCrypto), tone: tone(inputs.netCrypto) },
    { label: "Net FAB & MBME", value: money(inputs.fabAndMbme), tone: tone(inputs.fabAndMbme) },
    { label: "Gold Souq", value: money(inputs.goldSouq), tone: tone(inputs.goldSouq) },
    {
      label: "FAB Operating Balance",
      value: money(inputs.fabOperating),
      tone: tone(inputs.fabOperating),
      note: cellRef(fabSource, "fabOperating"),
    },
    {
      label: "FAB Holding Balance",
      value: money(inputs.fabHolding),
      tone: tone(inputs.fabHolding),
      note: cellRef(fabSource, "fabHolding"),
    },
    {
      label: "Gross Excess Fund",
      value: money(gross.value),
      tone: tone(gross.value),
      emphasis: true,
      // Says what it counts because the page also carries "Equity Difference +
      // PSPs", which counts every PSP plus receivables and will disagree.
      note: gross.missing.length
        ? unavailable(gross.missing)
        : "LP less client equity, plus crypto, FAB & MBME and Gold Souq only",
    },
    {
      label: "Net Excess Fund",
      value: money(net.value),
      tone: tone(net.value),
      emphasis: true,
      note: net.missing.length ? unavailable(net.missing) : "Gross Excess Fund plus both FAB accounts",
    },
  ];
}

export function ExcessFundsSection(props: ExcessFundsSectionProps) {
  const cards = excessFundsCards(props);
  const toneClass = (t: ExcessCard["tone"]) =>
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
      <div className="text-xs font-semibold text-foreground mb-2">Excess Funds</div>
      {stale.length ? (
        <div className="text-[10px] text-destructive mb-1.5">
          Figures below may be stale — last refresh failed for {stale.join(" and ")}.
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-1.5">
        {cards.map((card) => (
          <div
            key={card.label}
            className={`p-2 rounded-md border ${card.emphasis ? "bg-primary/10 border-primary/20 col-span-2" : "bg-muted/30 border-border/30"}`}
          >
            <div className="text-[10px] text-muted-foreground mb-0.5">{card.label}</div>
            <div className={`font-mono font-semibold text-sm ${toneClass(card.tone)}`}>{card.value}</div>
            {card.note ? <div className="text-[10px] text-muted-foreground mt-0.5">{card.note}</div> : null}
          </div>
        ))}
      </div>
      {asOf.length ? (
        <div className="text-[10px] text-muted-foreground mt-1.5">Sources read: {asOf.join(" · ")}</div>
      ) : null}
    </div>
  );
}
