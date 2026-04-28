import { Plus, Ticket } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { hasAccess } from "@/lib/auth";

export function TicketsFab() {
  const navigate = useNavigate();

  if (!hasAccess("Tickets:Own")) return null;

  return (
    <div className="fixed bottom-6 left-6 z-[60]">
      <button
        type="button"
        onClick={() => navigate("/tickets")}
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
