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
  return value < 0 ? "negative" : "positive";
}

export function excessFundsCards({ inputs, lpEquity, clientEquity }: ExcessFundsSectionProps): ExcessCard[] {
  const { gross, net } = computeExcessFunds(inputs);
  const unavailable = (missing: string[]) => `Unavailable — could not read ${missing.join(", ")}.`;

  return [
    { label: "Net LP Equity", value: money(lpEquity), tone: tone(lpEquity) },
    { label: "Net Client Equity", value: money(clientEquity), tone: tone(clientEquity) },
    { label: "Net Crypto", value: money(inputs.netCrypto), tone: tone(inputs.netCrypto) },
    { label: "Net FAB & MBME", value: money(inputs.fabAndMbme), tone: tone(inputs.fabAndMbme) },
    { label: "Gold Souq", value: money(inputs.goldSouq), tone: tone(inputs.goldSouq) },
    { label: "FAB Operating Balance", value: money(inputs.fabOperating), tone: tone(inputs.fabOperating) },
    { label: "FAB Holding Balance", value: money(inputs.fabHolding), tone: tone(inputs.fabHolding) },
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

  return (
    <div className="pt-2 border-t border-border/30">
      <div className="text-xs font-semibold text-foreground mb-2">Excess Funds</div>
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
    </div>
  );
}
