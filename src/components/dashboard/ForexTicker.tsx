import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';

interface SymbolActivity {
  symbol: string;
  positions: number;
  netExposureLots: number;
  subSymbols: Array<{ symbol: string; netExposureLots: number }>;
}

interface ForexTickerProps {
  items: SymbolActivity[];
  isLoading?: boolean;
}

export function ForexTicker({ items, isLoading = false }: ForexTickerProps) {
  const topSymbols = items;
  const palette = [
    'hsl(186 100% 50%)',
    'hsl(142 76% 45%)',
    'hsl(38 92% 50%)',
    'hsl(0 85% 55%)',
    'hsl(262 83% 58%)',
    'hsl(199 89% 48%)',
  ];

  const totalPositions = topSymbols.reduce((sum, item) => sum + item.positions, 0);
  const totalExposure = topSymbols.reduce((sum, item) => sum + Math.abs(item.netExposureLots), 0);

  return (
    <div className="grid grid-cols-2 gap-3">
      {topSymbols.length === 0 && !isLoading && (
        <div className="col-span-2 text-center text-xs text-muted-foreground py-4">
          No open positions
        </div>
      )}
      {topSymbols.map((item, index) => {
        const color = palette[index % palette.length];
        const share = totalExposure > 0
          ? (Math.abs(item.netExposureLots) / totalExposure) * 100
          : totalPositions > 0
            ? (item.positions / totalPositions) * 100
            : 0;
        return (
        <div
          key={item.symbol}
          className="flex flex-col gap-3 rounded-xl border border-border/50 bg-background/60 p-3 shadow-sm transition-colors"
          style={{
            boxShadow: `inset 0 0 0 1px ${color}14`,
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span
                className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                style={{ backgroundColor: `${color}18`, color }}
              >
                #{index + 1}
              </span>
              <HoverCard openDelay={200} closeDelay={100}>
                <HoverCardTrigger asChild>
                  <span className="text-xs font-semibold tracking-wide cursor-help" style={{ color }}>
                    {item.symbol}
                  </span>
                </HoverCardTrigger>
                <HoverCardContent className="w-56 p-3">
                  <div className="text-xs font-semibold mb-2">Sub-symbol exposure</div>
                  <div className="space-y-1">
                    {item.subSymbols.length === 0 && (
                      <div className="text-[11px] text-muted-foreground">No sub-symbols</div>
                    )}
                    {item.subSymbols.map((sub) => (
                      <div key={sub.symbol} className="flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground">{sub.symbol}</span>
                        <span className={sub.netExposureLots >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                          {sub.netExposureLots >= 0 ? '+' : ''}{sub.netExposureLots.toFixed(2)} lots
                        </span>
                      </div>
                    ))}
                  </div>
                </HoverCardContent>
              </HoverCard>
            </div>
            <div className="text-right">
              <div className={
                `text-sm font-semibold ${item.netExposureLots >= 0 ? 'text-emerald-400' : 'text-rose-400'}`
              }>
                {item.netExposureLots >= 0 ? '+' : ''}{item.netExposureLots.toFixed(2)} lots
              </div>
            </div>
          </div>
          <div className="h-1.5 rounded-full bg-secondary/30 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.min(100, share)}%`, backgroundColor: color }}
            />
          </div>
        </div>
      );
      })}
    </div>
  );
}
