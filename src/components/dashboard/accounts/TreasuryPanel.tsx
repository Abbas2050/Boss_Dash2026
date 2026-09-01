// The Treasury panel: the eight figures read directly from the finance
// spreadsheet -- what is owed in and out, the two net balances, the gap
// between actual and expected, and the LP credit.
//
// Why the notice exists: `netAllCurrentBalance` (the "Net all current
// balance" tile) is built from Total combined on the Balances panel, and that
// figure counts any wallet provider whose balance check failed as $0.00 --
// see BalancesPanel.tsx. On 2026-09-01 two TRON wallets were rate-limited by
// Tronscan and roughly $11,840.66 quietly left Total combined with nothing on
// screen to say so. `failedProviders` carries the display names of any
// widgets with `status: 'error'` so this panel can say the figure is
// understated.
//
// The notice REPORTS the caveat, it does not CORRECT the figure: no tile's
// value is touched when a provider fails. The finance team reconciles this
// sheet by eye against the source spreadsheet, and a dashboard that silently
// nudged a number to compensate would be a second, unverifiable source of
// truth -- worse than an honestly understated one with a flag on it.
//
// Design: the published Treasury mockup (see task-3-brief.md).

export interface TreasuryTile {
  label: string;
  value: string;
  tone: "positive" | "negative" | "neutral";
}

export interface TreasuryPanelProps {
  bankReceivable: number;
  cryptoReceivable: number;
  toLpsBank: number;
  toLpsCrypto: number;
  netAllCurrentBalance: number;
  netAfterExpectedFunds: number;
  differenceActualVsExpected: number;
  creditByLps: number;
  failedProviders: readonly string[];
}

function money(value: number): string {
  const text = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value < 0 ? `-$${text}` : `$${text}`;
}

function tone(value: number): TreasuryTile["tone"] {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "neutral";
}

export function treasuryTiles(props: TreasuryPanelProps): TreasuryTile[] {
  return [
    { label: "To be received in bank", value: money(props.bankReceivable), tone: tone(props.bankReceivable) },
    { label: "To be received in crypto", value: money(props.cryptoReceivable), tone: tone(props.cryptoReceivable) },
    { label: "To deposit into LPs, bank", value: money(props.toLpsBank), tone: tone(props.toLpsBank) },
    { label: "To deposit into LPs, crypto", value: money(props.toLpsCrypto), tone: tone(props.toLpsCrypto) },
    { label: "Net all current balance", value: money(props.netAllCurrentBalance), tone: tone(props.netAllCurrentBalance) },
    { label: "Net after expected funds", value: money(props.netAfterExpectedFunds), tone: tone(props.netAfterExpectedFunds) },
    { label: "Actual versus expected", value: money(props.differenceActualVsExpected), tone: tone(props.differenceActualVsExpected) },
    { label: "Credit by LPs", value: money(props.creditByLps), tone: tone(props.creditByLps) },
  ];
}

export function treasuryNotice(props: TreasuryPanelProps): string | null {
  if (props.failedProviders.length === 0) return null;
  const names = props.failedProviders.join(", ");
  return `Net all current balance understates the true total: ${names} could not be read and counted as $0.00.`;
}

export function TreasuryPanel(props: TreasuryPanelProps) {
  const tiles = treasuryTiles(props);
  const notice = treasuryNotice(props);

  const toneClass = (t: TreasuryTile["tone"]) =>
    t === "negative" ? "text-destructive" : t === "positive" ? "text-success" : "text-foreground";

  return (
    <div className="rounded-lg border border-border/60 bg-card">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/40">
        <h2 className="text-sm font-semibold text-foreground">Treasury</h2>
        <span className="text-[10px] text-muted-foreground">Read from the finance sheet</span>
      </div>
      <div className="grid grid-cols-2 gap-px bg-border/40">
        {tiles.map((tile) => (
          <div key={tile.label} className="bg-card px-3 py-2.5">
            <div className="text-[11px] leading-snug text-muted-foreground">{tile.label}</div>
            <div className={`mt-0.5 text-sm font-medium font-mono tabular-nums ${toneClass(tile.tone)}`}>
              {tile.value}
            </div>
          </div>
        ))}
      </div>
      {notice && (
        <div className="flex items-center gap-1.5 px-3 py-2.5 text-xs text-warning">
          <span className="h-1.5 w-1.5 rounded-full flex-none bg-warning" />
          <span>{notice}</span>
        </div>
      )}
    </div>
  );
}
