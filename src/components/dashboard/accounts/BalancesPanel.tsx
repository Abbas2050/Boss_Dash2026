import type { WalletWidgetEntry } from "@/lib/walletApi";

// The Balances panel: the ledger of payment-provider and bank balances,
// grouped crypto-then-bank with a subtotal closing the crypto group and a
// heavier total row at the bottom.
//
// Why `failed` exists: wallet/walletMonitor.js returns `balance: 0,
// status: 'error'` when a provider's balance check fails. Rendered as a plain
// $0.00 row that is indistinguishable from a genuine zero -- which is exactly
// how $11,840.66 silently left Total Combined when Tronscan rate-limited two
// TRON wallets on 2026-09-01, with nothing on screen to say so. The row keeps
// showing whatever the API reported (never invents a value) but is flagged so
// the panel can mark it visibly failed.
//
// Design: the published Balances mockup (see task-2-brief.md).

export interface BalancesRow {
  id: string;
  label: string;
  value: string;
  failed: boolean;
  kind: "row" | "subtotal" | "total";
  // Names what `value` includes at our own rate (e.g. "includes 0.00288773
  // ETH at $2,367.12") and what it still leaves out ("excludes 0.5 BTC"), so a
  // provider figure that disagrees with the provider's own screen explains
  // itself instead of reading as a discrepancy. Undefined -- never an empty
  // string -- when the widget carried neither, so the row renders no extra
  // line at all.
  note?: string;
}

export interface BalancesPanelProps {
  widgets: readonly WalletWidgetEntry[];
  totalBalance: number;
  reportDate: string | null;
  // Passed in rather than imported (it will be PSP_ORDER from
  // AccountsDepartment.tsx) so this panel stays presentational and its test
  // can supply its own order without reaching into that file.
  order: readonly { key: string; label: string; group: "crypto" | "bank" }[];
}

function money(value: number): string {
  const text = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value < 0 ? `-$${text}` : `$${text}`;
}

function joinAnd(parts: string[]): string {
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// Rate text, not money text. money() pins two decimals, which is right for a
// balance and wrong for a price: a sub-dollar token would render "$0.00" and
// present an invented zero rate as fact. Two decimals above a dollar, up to
// eight below it.
function rateText(value: number): string {
  const maximumFractionDigits = Math.abs(value) >= 1 ? 2 : 8;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits })}`;
}

// The provider's API returns bare amounts for these holdings with no USD value
// attached, and (see wallet/cryptoRates.js) exposes no conversion endpoint we
// could ask. So `valued` holdings ARE in the row's total, priced at a Binance
// spot rate of our own, and `unvalued` ones still are not -- either because
// nothing lists that ticker or because the rate lookup failed.
//
// The note has to say WHICH, because the two have opposite meanings for
// anyone comparing this row against the provider's screen. "includes ... at
// $2,367.12" names the price as ours, so the remaining few cents of
// disagreement reads as two rate sources rather than as a broken figure;
// "excludes ..." still means money the total does not contain.
//
// A zero amount is neither included nor excluded -- nothing happened to it --
// so it is filtered rather than displayed as "excludes 0 ETH".
function holdingsNote(
  unvalued: WalletWidgetEntry["unvalued"],
  valued: WalletWidgetEntry["valued"],
): string | undefined {
  const parts: string[] = [];

  const priced = (valued ?? []).filter((entry) => entry.amount > 0 && entry.rate > 0);
  if (priced.length > 0) {
    parts.push(`includes ${joinAnd(priced.map((e) => `${e.amount} ${e.currency} at ${rateText(e.rate)}`))}`);
  }

  const held = (unvalued ?? []).filter((entry) => entry.amount > 0);
  if (held.length > 0) {
    parts.push(`excludes ${joinAnd(held.map((e) => `${e.amount} ${e.currency}`))}`);
  }

  return parts.length === 0 ? undefined : parts.join("; ");
}

function buildGroupRows(
  order: readonly { key: string; label: string; group: "crypto" | "bank" }[],
  group: "crypto" | "bank",
  widgetMap: Map<string, WalletWidgetEntry>,
): BalancesRow[] {
  const rows: BalancesRow[] = [];
  for (const entry of order) {
    if (entry.group !== group) continue;
    // A widget the response did not carry is omitted, not rendered as an
    // invented zero -- the backend simply hasn't reported on it this cycle.
    const widget = widgetMap.get(entry.key);
    if (!widget) continue;
    const failed = widget.status === "error";
    rows.push({
      id: entry.key,
      // The widget's own name wins over the configured label: it can carry
      // live annotations (e.g. "Gold Souq (-$30,000.00 deducted, J31)") that
      // the static PSP_ORDER label does not know about.
      label: widget.name || entry.label,
      value: money(Number(widget.balance) || 0),
      failed,
      kind: "row",
      note: holdingsNote(widget.unvalued, widget.valued),
    });
  }
  return rows;
}

export function balancesRows(
  props: BalancesPanelProps,
): { crypto: BalancesRow[]; bank: BalancesRow[]; total: BalancesRow } {
  const { widgets, totalBalance, order } = props;
  const widgetMap = new Map(widgets.map((widget) => [widget.id, widget]));

  const crypto = buildGroupRows(order, "crypto", widgetMap);
  const bank = buildGroupRows(order, "bank", widgetMap);

  // The subtotal IS summed from the crypto rows on screen -- it is a subtotal
  // *of those rows* and must always agree with what is displayed above it.
  //
  // `Number(x) || 0`, the same coercion buildGroupRows uses for the row
  // values: `Number(x ?? 0)` differs from it on exactly the input that matters,
  // a non-numeric balance. That reads $0.00 on the row and NaN in the sum, so
  // the rows said $0.00 and the subtotal beneath them said $NaN. Agreeing with
  // the rows it sums is this figure's whole contract.
  //
  // Pushed only when there are rows to subtotal. It used to be pushed
  // unconditionally, which made the `crypto.length > 0` guard below always
  // true, so a never-loaded panel rendered a "Crypto" heading over a lone
  // "Subtotal crypto $0.00" -- a subtotal of nothing, presented as a zero
  // balance. The guard was right and the push was wrong.
  if (crypto.length > 0) {
    const cryptoSubtotal = crypto.reduce((sum, row) => sum + (Number(widgetMap.get(row.id)?.balance) || 0), 0);
    crypto.push({
      id: "__crypto_subtotal",
      label: "Subtotal crypto",
      value: money(cryptoSubtotal),
      failed: false,
      kind: "subtotal",
    });
  }

  // The total comes from the totalBalance prop -- the backend's own figure.
  // Summing the rows here would create a second answer to the same question.
  const total: BalancesRow = {
    id: "__total",
    label: "Total combined",
    value: money(totalBalance),
    failed: false,
    kind: "total",
  };

  return { crypto, bank, total };
}

export function BalancesPanel(props: BalancesPanelProps) {
  const { crypto, bank, total } = balancesRows(props);

  const renderRow = (row: BalancesRow) => {
    const isSpecial = row.kind !== "row";
    return (
      <div
        key={row.id}
        className={
          row.kind === "total"
            ? "flex items-center justify-between gap-2 px-1 pt-3 mt-1 border-t border-border/60 text-sm"
            : row.kind === "subtotal"
              ? "flex items-center gap-2 px-1 py-1.5 rounded-md bg-secondary/40 text-xs font-medium"
              : `flex gap-2 px-1 py-1 text-xs ${row.note ? "items-start" : "items-center"}`
        }
      >
        {row.kind !== "total" && (
          <span
            className={`h-1.5 w-1.5 rounded-full flex-none ${row.note ? "mt-1" : ""} ${row.failed ? "bg-destructive" : "bg-success"}`}
            title={row.failed ? "Balance could not be read" : undefined}
          />
        )}
        <span className="flex-1 min-w-0 flex flex-col">
          <span className={`truncate ${isSpecial ? "text-foreground" : "text-muted-foreground"} ${row.kind === "total" ? "font-semibold" : ""}`}>
            {row.label}
          </span>
          {row.note && (
            // Compact by design: this is a dense ledger, not a card -- one
            // small line, not a callout.
            <span className="truncate text-[10px] leading-tight text-muted-foreground/70">{row.note}</span>
          )}
        </span>
        <span
          className={`font-mono tabular-nums flex-none ${row.kind === "total" ? "font-bold" : row.kind === "subtotal" ? "font-semibold" : ""}`}
          title={row.failed ? "Balance could not be read" : undefined}
        >
          {row.value}
        </span>
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-border/60 bg-card">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/40">
        <h2 className="text-sm font-semibold text-foreground">Balances</h2>
        {props.reportDate && <span className="text-[10px] text-muted-foreground">{props.reportDate}</span>}
      </div>
      <div className="px-2 py-2 space-y-0.5">
        {crypto.length > 0 && (
          <>
            <div className="px-1 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Crypto</div>
            {crypto.map(renderRow)}
          </>
        )}
        {bank.length > 0 && (
          <>
            <div className="px-1 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Bank</div>
            {bank.map(renderRow)}
          </>
        )}
        {renderRow(total)}
      </div>
    </div>
  );
}
