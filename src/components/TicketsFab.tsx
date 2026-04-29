import { Plus, Ticket } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { hasAccess } from "@/lib/auth";

const FAB_WIDTH = 180;
const FAB_HEIGHT = 56;
const FAB_MARGIN = 16;
const CLICK_DRAG_THRESHOLD = 5;
const STORAGE_KEY = "tickets_fab_position_v1";

export function TicketsFab() {
  const navigate = useNavigate();
  const suppressClickRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number }>(() => {
    const fallback = { x: 24, y: 0 };
    if (typeof window === "undefined") return fallback;
    const defaultY = window.innerHeight - FAB_HEIGHT - 24;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...fallback, y: defaultY };
      const parsed = JSON.parse(raw);
      if (typeof parsed?.x !== "number" || typeof parsed?.y !== "number") return { ...fallback, y: defaultY };
      return { x: parsed.x, y: parsed.y };
    } catch {
      return { ...fallback, y: defaultY };
    }
  });

  if (!hasAccess("Tickets:Own")) return null;

  const clampPosition = (x: number, y: number) => {
    const maxX = Math.max(FAB_MARGIN, window.innerWidth - FAB_WIDTH - FAB_MARGIN);
    const maxY = Math.max(FAB_MARGIN, window.innerHeight - FAB_HEIGHT - FAB_MARGIN);
    return {
      x: Math.min(Math.max(FAB_MARGIN, x), maxX),
      y: Math.min(Math.max(FAB_MARGIN, y), maxY),
    };
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => {
      setPosition((prev) => clampPosition(prev.x, prev.y));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(position));
  }, [position]);

  return (
    <div
      className="fixed z-[60] touch-none"
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      onPointerDown={(e) => {
        suppressClickRef.current = false;
        dragRef.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          originX: position.x,
          originY: position.y,
          moved: false,
        };
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== e.pointerId) return;
        const deltaX = e.clientX - drag.startX;
        const deltaY = e.clientY - drag.startY;
        if (!drag.moved && Math.hypot(deltaX, deltaY) > CLICK_DRAG_THRESHOLD) {
          drag.moved = true;
          suppressClickRef.current = true;
        }
        const next = clampPosition(drag.originX + deltaX, drag.originY + deltaY);
        setPosition(next);
      }}
      onPointerUp={(e) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== e.pointerId) return;
        (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
        dragRef.current = null;
      }}
      onPointerCancel={(e) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== e.pointerId) return;
        (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
        dragRef.current = null;
      }}
    >
      <button
        type="button"
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          navigate("/tickets");
        }}
        className="group inline-flex items-center gap-2 rounded-full border border-primary/45 bg-gradient-to-r from-primary to-cyan-500 px-4 py-3 text-white shadow-lg shadow-cyan-900/25"
        aria-label="Open Tickets"
        title="Add Request"
      >
        <Plus className="h-4 w-4" />
        <span className="text-sm font-semibold">Add Request</span>
        <Ticket className="h-4 w-4 opacity-80" />
      </button>
    </div>
  );
}
