import { useEffect, useState } from 'react';
import { Megaphone, UserPlus, Target, MousePointer, TrendingUp, DollarSign } from 'lucide-react';
import { DepartmentCard } from './DepartmentCard';
import { MetricRow } from './MetricRow';
import { MiniChart } from './MiniChart';
import { ProgressBar } from './ProgressBar';

export function MarketingDepartment({ selectedEntity, fromDate, toDate, refreshKey }: { selectedEntity: string; fromDate?: Date; toDate?: Date; refreshKey: number }) {
  const [metrics, setMetrics] = useState({
    newClientsToday: 47,
    newClientsWeek: 312,
    leadsGenerated: 892,
    leadsConverted: 234,
    websiteVisitors: 15420,
    pageViews: 48250,
    bounceRate: 42.3,
    avgSessionDuration: 245,
    campaignSpend: 24.5,
    campaignROI: 312,
  });

  useEffect(() => {
    console.log('📢 MarketingDepartment filters:', { selectedEntity, fromDate, toDate, refreshKey });
    const interval = setInterval(() => {
      setMetrics(prev => ({
        newClientsToday: prev.newClientsToday + Math.floor(Math.random() * 3),
        newClientsWeek: prev.newClientsWeek + Math.floor(Math.random() * 5),
        leadsGenerated: prev.leadsGenerated + Math.floor(Math.random() * 10),
        leadsConverted: prev.leadsConverted + Math.floor(Math.random() * 3),
        websiteVisitors: prev.websiteVisitors + Math.floor(Math.random() * 50),
        pageViews: prev.pageViews + Math.floor(Math.random() * 100),
        bounceRate: Math.min(80, Math.max(20, prev.bounceRate + (Math.random() - 0.5) * 2)),
        avgSessionDuration: Math.max(60, prev.avgSessionDuration + Math.floor(Math.random() * 10 - 5)),
        campaignSpend: prev.campaignSpend + Math.random() * 0.1,
        campaignROI: Math.max(100, prev.campaignROI + Math.floor(Math.random() * 20 - 10)),
      }));
    }, 4500);

    return () => clearInterval(interval);
  }, [selectedEntity, fromDate, toDate, refreshKey]);

  const conversionRate = ((metrics.leadsConverted / metrics.leadsGenerated) * 100);

  const campaignPerformance = [
    { name: 'Google Ads', spend: 8.2, conversions: 89, roi: 245 },
    { name: 'Facebook', spend: 6.4, conversions: 67, roi: 312 },
    { name: 'LinkedIn', spend: 5.1, conversions: 45, roi: 198 },
    { name: 'Email', spend: 4.8, conversions: 33, roi: 420 },
  ];

  return (
    <DepartmentCard title="Marketing" icon={Megaphone} accentColor="destructive">
      <div className="grid grid-cols-2 gap-3">
        <div className="p-2 rounded-lg bg-success/10 border border-success/20">
          <div className="flex items-center gap-1 text-success mb-1">
            <UserPlus className="w-3.5 h-3.5" />
            <span className="text-xs">New Clients</span>
          </div>
          <div className="font-mono font-semibold text-lg">+{metrics.newClientsToday}</div>
          <div className="text-xs text-muted-foreground">Today</div>
        </div>
        <div className="p-2 rounded-lg bg-primary/10 border border-primary/20">
          <div className="flex items-center gap-1 text-primary mb-1">
            <Target className="w-3.5 h-3.5" />
            <span className="text-xs">Leads</span>
          </div>
          <div className="font-mono font-semibold text-lg">{metrics.leadsGenerated.toLocaleString()}</div>
          <div className="text-xs text-muted-foreground">This Month</div>
        </div>
      </div>

      <div className="pt-2 border-t border-border/30">
        <ProgressBar 
          value={conversionRate} 
          color={conversionRate > 25 ? 'success' : conversionRate > 15 ? 'warning' : 'destructive'} 
          label="Lead Conversion Rate"
        />
      </div>

      <div className="pt-2 border-t border-border/30">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">Website Traffic</span>
          <span className="text-xs font-mono text-primary">{metrics.websiteVisitors.toLocaleString()} visitors</span>
        </div>
        <MiniChart color="hsl(0 85% 55%)" />
      </div>

      <div className="space-y-1 pt-2 border-t border-border/30">
        <MetricRow 
          label="Page Views" 
          value={metrics.pageViews.toLocaleString()}
          change={8.4}
          icon={<MousePointer className="w-3.5 h-3.5" />}
        />
        <MetricRow 
          label="Bounce Rate" 
          value={metrics.bounceRate.toFixed(1)}
          suffix="%"
          change={-2.1}
        />
        <MetricRow 
          label="Avg. Session" 
          value={`${Math.floor(metrics.avgSessionDuration / 60)}:${(metrics.avgSessionDuration % 60).toString().padStart(2, '0')}`}
          suffix=" min"
        />
      </div>

      <div className="pt-2 border-t border-border/30">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">Campaign Performance</span>
          <div className="flex items-center gap-1 text-success text-xs font-mono">
            <TrendingUp className="w-3 h-3" />
            {metrics.campaignROI}% ROI
          </div>
        </div>
        <div className="space-y-1.5">
          {campaignPerformance.map(campaign => (
            <div key={campaign.name} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{campaign.name}</span>
              <div className="flex items-center gap-3">
                <span className="font-mono">${campaign.spend}K</span>
                <span className="font-mono text-success">{campaign.conversions}</span>
                <span className="font-mono w-12 text-right">{campaign.roi}%</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </DepartmentCard>
  );
}
