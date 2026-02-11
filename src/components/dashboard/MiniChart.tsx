import { useEffect, useState } from 'react';
import { AreaChart, Area, ResponsiveContainer, YAxis, BarChart, Bar } from 'recharts';

interface MiniChartProps {
  color?: string;
  value?: number;
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

export function MiniChart({ color = 'hsl(186 100% 50%)', height = 40, value, maxPoints = 20, variant = 'area' }: MiniChartProps) {
  const [data, setData] = useState(() => {
    if (typeof value === 'number') {
      return Array.from({ length: maxPoints }, () => ({ value }));
    }
    return generateData();
  });

  useEffect(() => {
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

  const dataMax = data.reduce((max, point) => Math.max(max, point.value), 0);
  const yMax = Math.max(10, Math.ceil(dataMax * 1.2));

  const gradientId = `gradient-${color.replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        {variant === 'bar' ? (
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
        )}
      </ResponsiveContainer>
    </div>
  );
}
