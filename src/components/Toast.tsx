import React, { useEffect } from 'react';

type ToastProps = {
  id: string;
  message: string;
  onClose: (id: string) => void;
  duration?: number;
};

export const Toast: React.FC<ToastProps> = ({ id, message, onClose, duration = 4000 }) => {
  useEffect(() => {
    const t = setTimeout(() => onClose(id), duration);
    return () => clearTimeout(t);
  }, [id, onClose, duration]);

  return (
    <div className="max-w-sm w-full bg-card/95 border border-border/60 text-foreground px-4 py-2 rounded shadow-md backdrop-blur">
      <div className="text-sm">{message}</div>
    </div>
  );
};

export default Toast;
