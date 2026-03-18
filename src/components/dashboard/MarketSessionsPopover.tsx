import { useMemo, useState } from "react";
import { Clock3 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type SessionDef = {
  key: string;
  name: string;
  timezone: string;
  openUtcHour: number;
  closeUtcHour: number;
  colorClass: string;
  bgClass: string;
};

const SESSIONS: SessionDef[] = [
  {
    key: "dubai",
    name: "Dubai",
    timezone: "Asia/Dubai",
    openUtcHour: 6,
    closeUtcHour: 14,
    colorClass: "text-orange-600 dark:text-orange-300",
    bgClass: "bg-orange-500/25 dark:bg-orange-400/35",
  },
  {
    key: "london",
    name: "London",
    timezone: "Europe/London",
    openUtcHour: 8,
    closeUtcHour: 17,
    colorClass: "text-cyan-600 dark:text-cyan-300",
    bgClass: "bg-cyan-500/25 dark:bg-cyan-400/35",
  },
  {
    key: "new-york",
    name: "New York",
    timezone: "America/New_York",
    openUtcHour: 13,
    closeUtcHour: 22,
    colorClass: "text-emerald-600 dark:text-emerald-300",
    bgClass: "bg-emerald-500/25 dark:bg-emerald-400/35",
  },
  {
    key: "tokyo",
    name: "Tokyo",
    timezone: "Asia/Tokyo",
    openUtcHour: 0,
    closeUtcHour: 9,
    colorClass: "text-amber-600 dark:text-amber-300",
    bgClass: "bg-amber-500/25 dark:bg-amber-400/35",
  },
  {
    key: "sydney",
    name: "Sydney",
    timezone: "Australia/Sydney",
    openUtcHour: 22,
    closeUtcHour: 7,
    colorClass: "text-fuchsia-600 dark:text-fuchsia-300",
    bgClass: "bg-fuchsia-500/25 dark:bg-fuchsia-400/35",
  },
];

const formatClock = (date: Date, timezone: string) => {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(date);
};

const sessionIsOpen = (minuteUtc: number, session: SessionDef) => {
  const start = session.openUtcHour * 60;
  const end = session.closeUtcHour * 60;
  if (start < end) return minuteUtc >= start && minuteUtc < end;
  return minuteUtc >= start || minuteUtc < end;
};

const minutesUntil = (fromMinute: number, targetMinute: number) => {
  const delta = (targetMinute - fromMinute + 24 * 60) % (24 * 60);
  return delta;
};

const sessionSegments = (session: SessionDef) => {
  const start = session.openUtcHour * 60;
  const end = session.closeUtcHour * 60;
  if (start < end) {
    return [{ start, end }];
  }
  return [
    { start, end: 24 * 60 },
    { start: 0, end },
  ];
};

export function MarketSessionsPopover({ now }: { now: Date }) {
  const [open, setOpen] = useState(false);

  const utcMinute = now.getUTCHours() * 60 + now.getUTCMinutes();

  const clocks = useMemo(
    () => SESSIONS.map((s) => ({ ...s, time: formatClock(now, s.timezone), isOpen: sessionIsOpen(utcMinute, s) })),
    [now, utcMinute],
  );

  const activeCount = clocks.filter((c) => c.isOpen).length;
  const liquidityLabel = activeCount >= 3 ? "High" : activeCount === 2 ? "Medium" : "Low";
  const liquidityClass = activeCount >= 3 ? "text-emerald-600 dark:text-emerald-300" : activeCount === 2 ? "text-amber-600 dark:text-amber-300" : "text-muted-foreground";

  const nextEvent = useMemo(() => {
    let best: { label: string; minutes: number } | null = null;
    for (const s of SESSIONS) {
      const isOpen = sessionIsOpen(utcMinute, s);
      const target = isOpen ? s.closeUtcHour * 60 : s.openUtcHour * 60;
      const delta = minutesUntil(utcMinute, target);
      const label = `${s.name} ${isOpen ? "closes" : "opens"}`;
      if (!best || delta < best.minutes) {
        best = { label, minutes: delta };
      }
    }
    if (!best) return "-";
    if (best.minutes < 60) return `${best.label} in ${best.minutes}m`;
    const h = Math.floor(best.minutes / 60);
    const m = best.minutes % 60;
    return `${best.label} in ${h}h ${m}m`;
  }, [utcMinute]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-secondary/20 px-2 py-1 text-muted-foreground hover:text-foreground"
            aria-label="Open market session timeline"
          >
            {/* Desktop: city clock chips */}
            <span className="hidden lg:contents">
              {clocks.map((clock) => (
                <span
                  key={clock.key}
                  className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] ${clock.isOpen ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200" : "bg-muted/50 text-muted-foreground"}`}
                >
                  <span className="font-semibold tracking-wide">{clock.name.slice(0, 2).toUpperCase()}</span>
                  <span>{clock.time}</span>
                </span>
              ))}
            </span>
            {/* Mobile: icon + label */}
            <span className="flex items-center gap-1 text-xs lg:hidden">
              <Clock3 className="h-3.5 w-3.5" />
              Sessions
            </span>
          </button>
        </PopoverTrigger>
      </div>

      <PopoverContent side="bottom" align="center" className="w-[min(94vw,820px)] border-border/70 bg-background/95 p-4 text-foreground backdrop-blur-xl">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold tracking-wide text-foreground">Global Session Pulse</div>
            <div className="text-[11px] text-muted-foreground">UTC timeline · hover chips in header for instant context</div>
          </div>
          <div className="text-right text-xs">
            <div className={`font-semibold ${liquidityClass}`}>Liquidity: {liquidityLabel}</div>
            <div className="text-muted-foreground">{nextEvent}</div>
          </div>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
          {clocks.map((clock) => (
            <div key={clock.key} className="rounded-lg border border-border/70 bg-card/60 px-2.5 py-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{clock.name}</div>
              <div className="mt-1 font-mono text-sm font-semibold text-foreground">{clock.time}</div>
              <div className={`mt-1 text-[10px] ${clock.isOpen ? "text-emerald-600 dark:text-emerald-300" : "text-muted-foreground/60"}`}>
                {clock.isOpen ? "Open" : "Closed"}
              </div>
            </div>
          ))}
        </div>

        <div className="relative overflow-hidden rounded-xl border border-border/70 bg-muted/30 px-3 py-4">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.06),transparent_40%),radial-gradient(circle_at_bottom_right,rgba(16,185,129,0.06),transparent_40%)]" />
          <div className="relative space-y-2">
            {SESSIONS.map((session) => (
              <div key={session.key} className="grid grid-cols-[72px_1fr] items-center gap-2">
                <div className="text-[11px] font-semibold text-foreground/70">{session.name}</div>
                <div className="relative h-6 rounded-md border border-border/60 bg-background/60">
                  {sessionSegments(session).map((segment, idx) => {
                    const left = (segment.start / (24 * 60)) * 100;
                    const width = ((segment.end - segment.start) / (24 * 60)) * 100;
                    return (
                      <div
                        key={`${session.key}-${idx}`}
                        className={`absolute top-0.5 h-5 rounded-sm ${session.bgClass}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      />
                    );
                  })}
                </div>
              </div>
            ))}

            <div className="relative mt-1 h-5">
              {[0, 4, 8, 12, 16, 20, 24].map((hour) => (
                <div
                  key={hour}
                  className="absolute -translate-x-1/2 text-[10px] text-muted-foreground/70"
                  style={{ left: `${(hour / 24) * 100}%` }}
                >
                  {hour.toString().padStart(2, "0")}:00
                </div>
              ))}

              <div
                className="pointer-events-none absolute -top-[126px] h-[128px] w-px bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.85)]"
                style={{ left: `${(utcMinute / (24 * 60)) * 100}%` }}
              />
              <div
                className="absolute top-4 -translate-x-1/2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300"
                style={{ left: `${(utcMinute / (24 * 60)) * 100}%` }}
              >
                {String(now.getUTCHours()).padStart(2, "0")}:{String(now.getUTCMinutes()).padStart(2, "0")} UTC
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
