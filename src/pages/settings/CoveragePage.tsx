import React, { useEffect, useState } from "react";

type Row = any;

export const CoveragePage: React.FC = () => {
  const [data, setData] = useState<any | null>(null);
  const [status, setStatus] = useState<{ connected: boolean; last?: string }>({ connected: false });

  useEffect(() => {
    refreshFromApi();
    const poll = setInterval(refreshFromApi, 4000);
    return () => clearInterval(poll);
  }, []);

  async function refreshFromApi() {
    try {
      const resp = await fetch("/Coverage/position-match-table");
      const json = await resp.json();
      setData(json);
      setStatus({ connected: true, last: new Date().toLocaleTimeString() });
    } catch {
      setStatus({ connected: false, last: status.last });
    }
  }

  function formatVal(v: number) {
    if (v === 0) return <span className="text-muted-foreground">0.00</span>;
    const cls = v > 0 ? "text-success" : "text-destructive";
    return <span className={cls}>{v.toFixed(2)}</span>;
  }

  return (
    <div className="min-h-screen bg-background">
      <main className="p-3 sm:p-4 md:p-6 lg:p-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">Position Match Table</h1>
          <div className="flex items-center gap-4 mt-2">
            <span className={`${status.connected ? "text-success" : "text-destructive"} text-sm`}>
              {status.connected ? "SYSTEM ONLINE" : "DISCONNECTED"}
            </span>
            <span className="text-muted-foreground text-xs">Last sync: {status.last || "-"}</span>
            <div className="ml-auto">
              <button onClick={refreshFromApi} className="bg-secondary hover:bg-secondary/80 px-3 py-1 rounded">
                Refresh
              </button>
            </div>
          </div>
        </div>

        <div className="bg-card/80 border border-border/40 rounded p-4">
          {!data || !data.rows ? (
            <div className="text-muted-foreground p-12 text-center">No data available</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full table-auto">
                <thead>
                  <tr>
                    <th className="text-left px-4 py-2 text-primary">Symbol</th>
                    <th className="text-left px-4 py-2 text-primary">Buy/Sell</th>
                    <th className="text-right px-4 py-2 text-primary">Client Net</th>
                    <th className="text-right px-4 py-2 text-primary">Uncovered</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row: Row, idx: number) => (
                    <tr key={idx} className="hover:bg-secondary/40">
                      <td className="px-4 py-2 text-foreground font-semibold">{row.symbol}</td>
                      <td className="px-4 py-2">
                        {row.direction === "BUY" ? (
                          <span className="text-success">BUY</span>
                        ) : row.direction === "SELL" ? (
                          <span className="text-destructive">SELL</span>
                        ) : (
                          ""
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">{formatVal(row.clientNet)}</td>
                      <td className="px-4 py-2 text-right">{formatVal(row.uncovered)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="text-left px-4 py-2 text-primary">TOTAL</td>
                    <td />
                    <td className="text-right px-4 py-2">{data.totals ? formatVal(data.totals.clientNet) : ""}</td>
                    <td className="text-right px-4 py-2">{data.totals ? formatVal(data.totals.uncovered) : ""}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
