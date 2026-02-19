import React from 'react';

interface RecordItem {
  id: string;
  pair: string;
  details: string;
}

export const RecentLPRecords: React.FC<{ items?: RecordItem[] }> = ({ items }) => {
  const list = items ?? [
    { id: '1001', pair: 'EUR/USD', details: 'Filled 0.5 lots @ 1.0847' },
    { id: '1002', pair: 'GBP/USD', details: 'Filled 1.0 lots @ 1.2450' },
    { id: '1003', pair: 'USD/JPY', details: 'Rejected margin check' },
  ];

  return (
    <div className="mb-6">
      <div className="bg-card/20 rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-lg font-semibold text-foreground">Recent LP fills and records (dummy)</div>
        </div>
        <ul className="space-y-2">
          {list.map((r) => (
            <li key={r.id} className="flex items-center justify-between bg-card/30 rounded-md p-3">
              <div>
                <div className="text-sm font-mono text-muted">LP# {r.id}</div>
                <div className="text-sm text-foreground/90">{r.pair} — {r.details}</div>
              </div>
              <div className="text-xs text-muted font-mono">{new Date().toLocaleString()}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
