interface SymbolActivity {
  symbol: string;
  positions: number;
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

  return (
    <div className="grid grid-cols-2 gap-2">
      {topSymbols.length === 0 && !isLoading && (
        <div className="col-span-2 text-center text-xs text-muted-foreground py-4">
          No open positions
        </div>
      )}
      {topSymbols.map((item, index) => {
        const color = palette[index % palette.length];
        const share = totalPositions > 0 ? (item.positions / totalPositions) * 100 : 0;
        return (
        <div 
          key={item.symbol}
          className="flex flex-col gap-2 p-2 rounded border border-border/40 transition-colors"
          style={{
            background: `linear-gradient(135deg, ${color}22, transparent)`,
            boxShadow: `inset 0 0 0 1px ${color}20`,
          }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                style={{ backgroundColor: `${color}22`, color }}
              >
                #{index + 1}
              </span>
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
              <span className="text-xs font-mono font-semibold" style={{ color }}>
                {item.symbol}
              </span>
            </div>
            <div className="text-right">
              <div className="text-xs font-mono">
                {item.positions}
                <span className="text-muted-foreground"> pos</span>
              </div>
              <div className="text-[10px] text-muted-foreground">{share.toFixed(1)}%</div>
            </div>
          </div>
          <div className="h-1.5 bg-secondary/40 rounded-full overflow-hidden">
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
