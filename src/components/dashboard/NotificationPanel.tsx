import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, Info, XCircle, X } from 'lucide-react';

interface Notification {
  id: string;
  type: 'success' | 'warning' | 'error' | 'info';
  title: string;
  message: string;
  time: Date;
}

interface NotificationPanelProps {
  selectedEntity: string;
  fromDate?: Date;
  toDate?: Date;
  refreshKey: number;
}

const iconMap = {
  success: CheckCircle,
  warning: AlertTriangle,
  error: XCircle,
  info: Info,
};

const colorMap = {
  success: 'text-success border-success/30 bg-success/10',
  warning: 'text-warning border-warning/30 bg-warning/10',
  error: 'text-destructive border-destructive/30 bg-destructive/10',
  info: 'text-primary border-primary/30 bg-primary/10',
};

const initialNotifications: Notification[] = [
  { id: '1', type: 'success', title: 'Trade Executed', message: 'EUR/USD Buy order filled at 1.0847', time: new Date() },
  { id: '2', type: 'warning', title: 'Margin Alert', message: 'Account #4521 approaching margin call', time: new Date(Date.now() - 120000) },
  { id: '3', type: 'info', title: 'System Update', message: 'Scheduled maintenance in 4 hours', time: new Date(Date.now() - 300000) },
];

export function NotificationPanel({ selectedEntity, fromDate, toDate, refreshKey }: NotificationPanelProps) {
  const [notifications, setNotifications] = useState<Notification[]>(initialNotifications);

  useEffect(() => {
    const interval = setInterval(() => {
      const types: Notification['type'][] = ['success', 'warning', 'info', 'error'];
      const messages = [
        { type: 'success' as const, title: 'Trade Completed', message: 'GBP/USD position closed with +$2,450' },
        { type: 'warning' as const, title: 'High Volatility', message: 'USD/JPY experiencing unusual movement' },
        { type: 'info' as const, title: 'New Client', message: 'Account #7892 verified and activated' },
        { type: 'success' as const, title: 'Deposit Received', message: '$15,000 credited to account #3421' },
      ];
      
      const newNotif = messages[Math.floor(Math.random() * messages.length)];
      
      if (Math.random() > 0.7) {
        setNotifications(prev => [
          { ...newNotif, id: Date.now().toString(), time: new Date() },
          ...prev.slice(0, 4)
        ]);
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [selectedEntity, fromDate, toDate, refreshKey]);

  const formatTime = (date: Date) => {
    const diff = Date.now() - date.getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };

  const removeNotification = (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  return (
    <div className="cyber-card p-4 h-full">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display text-sm tracking-wider text-primary uppercase">
          Live Alerts
        </h3>
        <span className="text-xs text-muted-foreground font-mono">{notifications.length} active</span>
      </div>
      
      <div className="space-y-2 max-h-[300px] overflow-y-auto">
        {notifications.map((notif) => {
          const Icon = iconMap[notif.type];
          return (
            <div 
              key={notif.id}
              className={`p-3 rounded-lg border ${colorMap[notif.type]} animate-slide-up relative group`}
            >
              <button 
                onClick={() => removeNotification(notif.id)}
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-3 h-3" />
              </button>
              <div className="flex items-start gap-2">
                <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm">{notif.title}</span>
                    <span className="text-xs opacity-70 font-mono flex-shrink-0">{formatTime(notif.time)}</span>
                  </div>
                  <p className="text-xs opacity-80 mt-0.5 truncate">{notif.message}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
