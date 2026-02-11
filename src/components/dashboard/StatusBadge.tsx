interface StatusBadgeProps {
  status: 'online' | 'warning' | 'error' | 'pending';
  label: string;
}

const statusStyles = {
  online: {
    bg: 'bg-success/20',
    text: 'text-success',
    dot: 'bg-success',
  },
  warning: {
    bg: 'bg-warning/20',
    text: 'text-warning',
    dot: 'bg-warning',
  },
  error: {
    bg: 'bg-destructive/20',
    text: 'text-destructive',
    dot: 'bg-destructive',
  },
  pending: {
    bg: 'bg-primary/20',
    text: 'text-primary',
    dot: 'bg-primary',
  },
};

export function StatusBadge({ status, label }: StatusBadgeProps) {
  const styles = statusStyles[status];
  
  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full ${styles.bg}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${styles.dot} ${status === 'online' ? 'animate-pulse' : ''}`} />
      <span className={`text-xs font-mono uppercase tracking-wider ${styles.text}`}>{label}</span>
    </div>
  );
}
