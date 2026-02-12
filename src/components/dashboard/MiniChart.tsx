import { useEffect, useState } from 'react';
import { AreaChart, Area, ResponsiveContainer, YAxis, BarChart, Bar, ComposedChart, Line, Tooltip, CartesianGrid } from 'recharts';

interface MiniChartProps {
  color?: string;
  value?: number;
  valueBuy?: number;
  valueSell?: number;
  height?: number;
  maxPoints?: number;
  variant?: 'area' | 'bar';
}

const generateData = () => {
  const data = [];
  let value = 50;
  for (let i = 0; i < 20; i++) {
    value = Math.max(10, Math.min(90, value + (Math.random() - 0.5) * 15));
    data.push({ value });
  }
  return data;
};

export function MiniChart({
  color = 'hsl(186 100% 50%)',
  height = 40,
  value,
  valueBuy,
  valueSell,
  maxPoints = 20,
  variant = 'area',
}: MiniChartProps) {
  const [data, setData] = useState(() => {
    if (typeof valueBuy === 'number' || typeof valueSell === 'number') {
      return Array.from({ length: maxPoints }, () => ({
        buy: valueBuy ?? 0,
        sell: valueSell ?? 0,
      }));
    }
    if (typeof value === 'number') {
      return Array.from({ length: maxPoints }, () => ({ value }));
    }
    return generateData();
  });

  useEffect(() => {
    if (typeof valueBuy === 'number' || typeof valueSell === 'number') {
      setData(prev => {
        const newData = [...prev.slice(1), { buy: valueBuy ?? 0, sell: valueSell ?? 0 }];
        return newData;
      });
      return;
    }

    if (typeof value === 'number') {
      setData(prev => {
        const newData = [...prev.slice(1), { value }];
        return newData;
      });
      return;
    }

    const interval = setInterval(() => {
      setData(prev => {
        const newData = [...prev.slice(1)];
        const lastValue = prev[prev.length - 1].value;
        const newValue = Math.max(10, Math.min(90, lastValue + (Math.random() - 0.5) * 10));
        newData.push({ value: newValue });
        return newData;
      });
    }, 3000);

    return () => clearInterval(interval);
  }, [value, maxPoints]);

  const dataMax = data.reduce((max, point) => {
    if (typeof point.value === 'number') {
      return Math.max(max, point.value);
    }
    const buy = typeof point.buy === 'number' ? point.buy : 0;
    const sell = typeof point.sell === 'number' ? point.sell : 0;
    return Math.max(max, buy, sell);
  }, 0);
  const yMax = Math.max(10, Math.ceil(dataMax * 1.2));

  const gradientId = `gradient-${color.replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        {variant === 'bar' ? (
          (typeof valueBuy === 'number' || typeof valueSell === 'number') ? (
            <ComposedChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <YAxis domain={[0, yMax]} hide />
              <Bar dataKey="buy" fill="hsl(198 100% 50%)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="sell" fill="hsl(0 85% 55%)" radius={[4, 4, 0, 0]} />
              <Line type="monotone" dataKey="buy" stroke="hsl(198 100% 60%)" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="sell" stroke="hsl(0 85% 65%)" strokeWidth={2} dot={false} />
            </ComposedChart>
          ) : (
            <BarChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.9} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.2} />
                </linearGradient>
              </defs>
              <YAxis domain={[0, yMax]} hide />
              <Bar dataKey="value" fill={`url(#${gradientId})`} radius={[4, 4, 0, 0]} />
            </BarChart>
          )
        ) : (
          (typeof valueBuy === 'number' || typeof valueSell === 'number') ? (
            <AreaChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />
              <YAxis domain={[0, yMax]} hide />
              <Tooltip
                cursor={{ stroke: 'rgba(255,255,255,0.12)', strokeWidth: 1 }}
                contentStyle={{
                  background: 'rgba(8, 12, 24, 0.9)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 8,
                  fontSize: 11,
                }}
                labelStyle={{ color: '#94a3b8' }}
                formatter={(val: number, name: string) => [val?.toFixed?.(2), name === 'buy' ? 'Buy lots' : 'Sell lots']}
              />
              <Area
                type="monotone"
                dataKey="buy"
                stroke="hsl(198 100% 60%)"
                strokeWidth={2}
                fill="none"
                activeDot={{ r: 3 }}
                isAnimationActive
              />
              <Area
                type="monotone"
                dataKey="sell"
                stroke="hsl(0 85% 65%)"
                strokeWidth={2}
                fill="none"
                activeDot={{ r: 3 }}
                isAnimationActive
              />
            </AreaChart>
          ) : (
            <AreaChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <YAxis domain={[0, yMax]} hide />
              <Area
                type="monotone"
                dataKey="value"
                stroke={color}
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                isAnimationActive
              />
            </AreaChart>
          )
        )}
      </ResponsiveContainer>
    </div>
  );
}
