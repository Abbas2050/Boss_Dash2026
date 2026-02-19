import React, { useEffect, useMemo, useRef, useState } from "react";
import { SignalRConnectionManager, SignalRStatus } from "@/lib/signalRConnectionManager";

type StreamEvent = {
  id: string;
  time: string;
  eventName: string;
  payload: unknown;
};

const TRACKED_EVENTS = [
  "PositionMatchTableUpdate",
  "DealUpdate",
  "PositionUpdate",
  "OrderUpdate",
  "AccountAlert",
  "TransactionAlert",
];

function getStatusClass(status: SignalRStatus): string {
  if (status === "connected") return "text-success";
  if (status === "connecting" || status === "reconnecting") return "text-warning";
  return "text-destructive";
}

export const WSTestPage: React.FC = () => {
  const managerRef = useRef<SignalRConnectionManager | null>(null);
  const [status, setStatus] = useState<SignalRStatus>("disconnected");
  const [lastError, setLastError] = useState<string | null>(null);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [eventFilter, setEventFilter] = useState<string>("all");

  const backendBaseUrl = (import.meta as any).env?.VITE_BACKEND_BASE_URL || "";
  const hubUrl = backendBaseUrl
    ? `${String(backendBaseUrl).replace(/\/+$/, "")}/ws/dashboard`
    : "/ws/dashboard";

  useEffect(() => {
    const manager = new SignalRConnectionManager({
      hubUrl,
      trackedEvents: TRACKED_EVENTS,
      accessTokenFactory: async () => {
        try {
          const tokenUrl = backendBaseUrl
            ? `${String(backendBaseUrl).replace(/\/+$/, "")}/api/signalr/token`
            : "/api/signalr/token";
          const res = await fetch(tokenUrl);
          if (!res.ok) return null;
          const json = await res.json();
          return json.token || null;
        } catch {
          return null;
        }
      },
    });
    managerRef.current = manager;

    const unsubStatus = manager.onStatusChange((nextStatus) => {
      setStatus(nextStatus);
    });
    const unsubError = manager.onError((message) => {
      setLastError(message);
    });
    const unsubEvents = manager.onEvent((payload, eventName) => {
      setEvents((prev) => [
        {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          time: new Date().toLocaleTimeString(),
          eventName,
          payload,
        },
        ...prev,
      ].slice(0, 500));
    });

    return () => {
      unsubStatus();
      unsubError();
      unsubEvents();
      manager.disconnect().catch(() => undefined);
    };
  }, [hubUrl, backendBaseUrl]);

  const filteredEvents = useMemo(() => {
    if (eventFilter === "all") return events;
    return events.filter((e) => e.eventName === eventFilter);
  }, [events, eventFilter]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const name of TRACKED_EVENTS) map[name] = 0;
    for (const e of events) {
      map[e.eventName] = (map[e.eventName] || 0) + 1;
    }
    return map;
  }, [events]);

  const handleConnect = async () => {
    setLastError(null);
    try {
      await managerRef.current?.connect();
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDisconnect = async () => {
    await managerRef.current?.disconnect();
  };

  const handleClear = () => {
    setEvents([]);
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="p-8">
        <h1 className="text-2xl font-bold text-foreground mb-6">SignalR Stream Test</h1>
        <div className="text-sm text-muted-foreground mb-3">Hub: {hubUrl}</div>

        <div className="bg-card/80 border border-border/40 rounded-lg shadow p-6 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={handleConnect} className="bg-primary hover:opacity-90 text-primary-foreground px-4 py-2 rounded">
              Connect
            </button>
            <button onClick={handleDisconnect} className="bg-destructive hover:opacity-90 text-destructive-foreground px-4 py-2 rounded">
              Disconnect
            </button>
            <button onClick={handleClear} className="bg-secondary hover:bg-secondary/80 text-secondary-foreground px-4 py-2 rounded">
              Clear
            </button>
            <span className={`text-sm font-semibold ${getStatusClass(status)}`}>
              Status: {status.toUpperCase()}
            </span>
          </div>

          {lastError && (
            <div className="text-sm text-destructive">Last error: {lastError}</div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            {TRACKED_EVENTS.map((name) => (
              <div key={name} className="bg-background/60 border border-border/40 rounded p-3">
                <div className="text-xs text-muted-foreground">{name}</div>
                <div className="text-xl font-bold text-primary">{counts[name] || 0}</div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <label className="text-sm text-muted-foreground">Filter:</label>
            <select
              value={eventFilter}
              onChange={(e) => setEventFilter(e.target.value)}
              className="bg-background/60 border border-border text-foreground px-3 py-2 rounded"
            >
              <option value="all">All events</option>
              {TRACKED_EVENTS.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>

          <div className="max-h-[520px] overflow-y-auto border border-border/40 rounded">
            {filteredEvents.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">No events received yet.</div>
            ) : (
              filteredEvents.map((event) => (
                <div key={event.id} className="border-b border-border/30 p-3">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-xs text-muted-foreground">{event.time}</span>
                    <span className="text-sm font-semibold text-primary">{event.eventName}</span>
                  </div>
                  <pre className="text-xs text-foreground whitespace-pre-wrap break-words">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                </div>
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  );
};
