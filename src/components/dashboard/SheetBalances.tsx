import { useState, useEffect } from 'react';
import { fetchSheetBalances, SheetBalance } from '@/lib/googleSheets';
import { DollarSign, TrendingUp, Loader2, AlertCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';

export function SheetBalances() {
  const [balances, setBalances] = useState<SheetBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadBalances();
    
    // Refresh every 30 seconds
    const interval = setInterval(loadBalances, 30000);
    return () => clearInterval(interval);
  }, []);

  const loadBalances = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchSheetBalances();
      setBalances(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load balances');
    } finally {
      setLoading(false);
    }
  };

  if (loading && balances.length === 0) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {[1, 2].map(i => (
          <Card key={i} className="p-6 bg-card/50 backdrop-blur-sm border-border/50">
            <div className="flex items-center justify-between">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              <div className="h-8 w-24 bg-muted/20 rounded animate-pulse" />
            </div>
          </Card>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-6 bg-destructive/5 border-destructive/20">
        <div className="flex items-center gap-3 text-destructive">
          <AlertCircle className="w-5 h-5" />
          <div>
            <div className="font-semibold">Error loading balances</div>
            <div className="text-sm text-muted-foreground">{error}</div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {balances.slice(0, 2).map((balance, index) => (
        <Card 
          key={index}
          className="p-6 bg-gradient-to-br from-card/80 via-card/60 to-card/40 backdrop-blur-sm border-border/50 hover:border-primary/30 transition-all duration-300 group"
        >
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-3">
                <div className="p-2.5 rounded-xl bg-primary/10 group-hover:bg-primary/20 transition-colors">
                  {index === 0 ? (
                    <DollarSign className="w-5 h-5 text-primary" />
                  ) : (
                    <TrendingUp className="w-5 h-5 text-accent" />
                  )}
                </div>
                <span className="text-sm font-medium text-muted-foreground">
                  {balance.label}
                </span>
              </div>
              
              <div className="space-y-1">
                <div className="text-3xl font-bold font-mono tracking-tight">
                  {balance.currency === 'USD' || balance.currency === '$' ? '$' : balance.currency}{' '}
                  {balance.value.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  Last updated: {new Date().toLocaleTimeString()}
                </div>
              </div>
            </div>
            
            {loading && (
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}
