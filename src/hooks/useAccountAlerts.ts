import { useEffect, useRef, useState } from 'react';
import { SignalRConnectionManager, SignalRStatus } from '@/lib/signalRConnectionManager';

export type UserChangeEvent = any;
export type AccountAlertEvent = any;

const TRACKED_EVENTS = [
  'UserChangeAlert',
  'AccountAlert',
  'PositionMatchTableUpdate',
  'DealUpdate',
  'PositionUpdate',
  'OrderUpdate',
  'TransactionAlert',
];

function nowString() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function humanizeEvent(eventName: string, payload: any) {
  if (eventName === 'PositionMatchTableUpdate') {
    const symbols = Array.isArray(payload?.rows) ? payload.rows.length : 0;
    const lps = Array.isArray(payload?.lpNames) ? payload.lpNames.length : 0;
    return {
      type: 'PositionMatchTableUpdate',
      login: '-',
      nameGroup: 'Coverage',
      details: `Coverage updated for ${symbols} symbols across ${lps} LPs`,
    };
  }
  if (eventName === 'DealUpdate') {
    return {
      type: 'DealUpdate',
      login: payload?.login ?? '-',
      nameGroup: payload?.symbol ?? payload?.group ?? '-',
      details: `Deal ${payload?.deal ?? payload?.dealId ?? '-'} @ ${payload?.price ?? '-'} (${payload?.volume ?? '-'})`,
    };
  }
  if (eventName === 'PositionUpdate') {
    return {
      type: 'PositionUpdate',
      login: payload?.login ?? '-',
      nameGroup: payload?.symbol ?? payload?.group ?? '-',
      details: `Position ${payload?.position ?? payload?.positionId ?? '-'} changed. Profit: ${payload?.profit ?? '-'}`,
    };
  }
  if (eventName === 'OrderUpdate') {
    return {
      type: 'OrderUpdate',
      login: payload?.login ?? '-',
      nameGroup: payload?.symbol ?? payload?.group ?? '-',
      details: `Order ${payload?.order ?? payload?.orderId ?? '-'} status: ${payload?.state ?? payload?.status ?? 'updated'}`,
    };
  }
  if (eventName === 'TransactionAlert') {
    return {
      type: payload?.transactionType || 'TransactionAlert',
      login: payload?.login ?? '-',
      nameGroup: payload?.currency ?? payload?.group ?? '-',
      details: `Amount ${payload?.amount ?? '-'} | Comment: ${payload?.comment ?? '-'}`,
    };
  }
  return {
    type: eventName,
    login: payload?.login ?? payload?.account?.login ?? '-',
    nameGroup: payload?.group || '-',
    details: JSON.stringify(payload ?? {}),
  };
}

function toSignalRStatus(status: SignalRStatus): 'connected' | 'disconnected' | 'connecting' | 'reconnecting' {
  return status;
}

export function useAccountAlerts() {
  const [status, setStatus] = useState<'connected' | 'disconnected' | 'connecting' | 'reconnecting'>('disconnected');
  const [lastError, setLastError] = useState<string | null>(null);
  const [userEvents, setUserEvents] = useState<UserChangeEvent[]>([]);
  const [marginEvents, setMarginEvents] = useState<AccountAlertEvent[]>([]);
  const [allEvents, setAllEvents] = useState<any[]>([]);
  const countsRef = useRef<Record<string, number>>({
    Add: 0,
    Update: 0,
    Delete: 0,
    MarginCallEnter: 0,
    StopOutEnter: 0,
  });

  useEffect(() => {
    const backendBaseUrl = (import.meta as any).env?.VITE_BACKEND_BASE_URL || '';
    const hubUrl = backendBaseUrl
      ? `${String(backendBaseUrl).replace(/\/+$/, '')}/ws/dashboard`
      : '/ws/dashboard';

    const manager = new SignalRConnectionManager({
      hubUrl,
      trackedEvents: TRACKED_EVENTS,
      accessTokenFactory: async () => {
        try {
          const tokenUrl = backendBaseUrl
            ? `${String(backendBaseUrl).replace(/\/+$/, '')}/api/signalr/token`
            : '/api/signalr/token';
          const res = await fetch(tokenUrl);
          if (!res.ok) return null;
          const json = await res.json();
          return json.token || null;
        } catch {
          return null;
        }
      },
    });

    const unsubStatus = manager.onStatusChange((s) => {
      setStatus(toSignalRStatus(s));
    });

    const unsubError = manager.onError((message) => {
      setLastError(message);
    });

    const unsubEvent = manager.onEvent((payload: any, eventName) => {
      const time = payload?.time || nowString();

      if (eventName === 'UserChangeAlert') {
        const data = payload || {};
        setUserEvents((prev) => [data, ...prev].slice(0, 500));
        countsRef.current[data.eventType] = (countsRef.current[data.eventType] || 0) + 1;
        setAllEvents((prev) => [
          {
            time,
            type: data.eventType || eventName,
            login: data.login,
            nameGroup: `${data.name || ''} | ${data.group || ''}`,
            details: data.comment || '',
          },
          ...prev,
        ].slice(0, 1000));
        return;
      }

      if (eventName === 'AccountAlert') {
        const data = payload || {};
        const eventPayload = { ...data, time };
        setMarginEvents((prev) => [eventPayload, ...prev].slice(0, 500));
        countsRef.current[data.alertType] = (countsRef.current[data.alertType] || 0) + 1;
        setAllEvents((prev) => [
          {
            time,
            type: data.alertType || eventName,
            login: data.account?.login,
            nameGroup: data.group || '-',
            details: `Equity:${data.account?.equity ?? '-'} Balance:${data.account?.balance ?? '-'}`,
          },
          ...prev,
        ].slice(0, 1000));
        return;
      }

      const summary = humanizeEvent(eventName, payload);
      setAllEvents((prev) => [
        {
          time,
          ...summary,
        },
        ...prev,
      ].slice(0, 1000));
    });

    manager.connect().catch((e) => {
      setLastError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      unsubStatus();
      unsubError();
      unsubEvent();
      manager.disconnect().catch(() => undefined);
    };
  }, []);

  return {
    status,
    lastError,
    userEvents,
    marginEvents,
    allEvents,
    counts: countsRef.current,
  };
}
