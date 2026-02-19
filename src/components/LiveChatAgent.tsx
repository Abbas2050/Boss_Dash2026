import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, CircleDot, MessageSquare, SendHorizontal, X } from "lucide-react";
import { AgentChatMessage, AgentLiveSnapshot, fetchAgentCapabilities, sendAgentChat } from "@/lib/agentApi";

const quickPrompts = [
  "What is my current equity?",
  "Show coverage and uncovered exposure.",
  "How many swaps are due tonight?",
  "Give me marketing sessions for current date range.",
];

const toYmd = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export function LiveChatAgent() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AgentChatMessage[]>([
    {
      role: "assistant",
      content: "Sky Links Agent is online. Ask about Dealing, LP, Backoffice, Accounts, or Marketing metrics.",
    },
  ]);
  const [loading, setLoading] = useState(false);
  const [capabilityLabel, setCapabilityLabel] = useState("loading...");
  const [live, setLive] = useState<AgentLiveSnapshot | null>(null);
  const [liveStatus, setLiveStatus] = useState<"connecting" | "live" | "error">("connecting");
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const fromDate = useMemo(() => toYmd(new Date()), []);
  const toDate = useMemo(() => toYmd(new Date()), []);

  useEffect(() => {
    fetchAgentCapabilities()
      .then((c) => setCapabilityLabel(c.model))
      .catch(() => setCapabilityLabel("fallback"));
  }, []);

  useEffect(() => {
    const es = new EventSource(`/api/agent/live?fromDate=${fromDate}&toDate=${toDate}`);
    es.addEventListener("snapshot", (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as AgentLiveSnapshot;
        setLive(parsed);
        setLiveStatus("live");
      } catch {
        setLiveStatus("error");
      }
    });
    es.addEventListener("error", () => setLiveStatus("error"));
    return () => es.close();
  }, [fromDate, toDate]);

  useEffect(() => {
    if (!scrollerRef.current) return;
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [messages, open, loading]);

  const send = async (question: string) => {
    const content = question.trim();
    if (!content || loading) return;
    const nextMessages = [...messages, { role: "user", content } as AgentChatMessage];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    try {
      const resp = await sendAgentChat({
        message: content,
        fromDate,
        toDate,
        history: nextMessages.slice(-8),
      });
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `${resp.answer || "No response"}${resp.toolsUsed?.length ? `\n\nTools: ${resp.toolsUsed.join(", ")}` : ""}`,
        },
      ]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Agent error: ${e?.message || "request failed"}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed bottom-5 right-5 z-[80]">
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="group inline-flex items-center gap-2 rounded-full border border-cyan-500/50 bg-gradient-to-r from-cyan-600 to-emerald-600 px-4 py-3 text-white shadow-lg shadow-cyan-900/25"
        >
          <Bot className="h-4 w-4" />
          <span className="text-sm font-semibold">Live Agent</span>
          <span className={`h-2 w-2 rounded-full ${liveStatus === "live" ? "bg-emerald-300" : liveStatus === "connecting" ? "bg-amber-300" : "bg-rose-300"}`} />
        </button>
      )}

      {open && (
        <div className="w-[min(92vw,460px)] overflow-hidden rounded-2xl border border-cyan-500/30 bg-white/95 text-slate-900 shadow-2xl shadow-cyan-900/20 backdrop-blur dark:bg-slate-950/95 dark:text-slate-100">
          <div className="border-b border-cyan-500/20 bg-gradient-to-r from-slate-900 via-cyan-900 to-emerald-900 px-4 py-3 text-white">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-cyan-200" />
                <div>
                  <div className="text-sm font-semibold">Sky Links Live Agent</div>
                  <div className="text-[11px] text-cyan-100/90">Model: {capabilityLabel}</div>
                </div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded border border-white/30 p-1 text-white/90 hover:bg-white/10">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-[11px] dark:border-slate-800 dark:bg-slate-900/40">
            <div>
              <div className="text-slate-500 dark:text-slate-400">Equity</div>
              <div className="font-mono text-slate-900 dark:text-slate-100">{live?.dealing?.totalEquity?.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? "-"}</div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Coverage %</div>
              <div className="font-mono text-slate-900 dark:text-slate-100">{live?.coverage?.coveragePct?.toFixed(2) ?? "-"}%</div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">LP Accounts</div>
              <div className="font-mono text-slate-900 dark:text-slate-100">{live?.lpMetrics?.accountCount?.toLocaleString() ?? "-"}</div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Swap Due Tonight</div>
              <div className="font-mono text-slate-900 dark:text-slate-100">{live?.swap?.dueTonight?.toLocaleString() ?? "-"}</div>
            </div>
          </div>

          <div ref={scrollerRef} className="max-h-[48vh] space-y-3 overflow-y-auto px-4 py-3">
            {messages.map((m, idx) => (
              <div key={`${idx}-${m.role}`} className={`max-w-[92%] rounded-xl border px-3 py-2 text-sm ${
                m.role === "user"
                  ? "ml-auto border-cyan-500/30 bg-cyan-500/10 text-slate-900 dark:text-slate-100"
                  : "border-slate-200 bg-slate-100 text-slate-800 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
              }`}>
                <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {m.role === "user" ? "You" : "Agent"} {m.role === "assistant" && <CircleDot className="h-3 w-3" />}
                </div>
                <div className="whitespace-pre-wrap">{m.content}</div>
              </div>
            ))}
            {loading && (
              <div className="max-w-[92%] rounded-xl border border-slate-200 bg-slate-100 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-300">
                Agent is calculating...
              </div>
            )}
          </div>

          <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
            <div className="mb-2 flex flex-wrap gap-2">
              {quickPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => send(prompt)}
                  className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-[11px] text-slate-600 hover:border-cyan-500/40 hover:text-cyan-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:text-cyan-300"
                >
                  {prompt}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") send(input);
                }}
                placeholder="Ask anything about your live operations..."
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-cyan-500/40 placeholder:text-slate-400 focus:ring dark:border-slate-700 dark:bg-slate-900 dark:placeholder:text-slate-500"
              />
              <button
                type="button"
                onClick={() => send(input)}
                disabled={loading || !input.trim()}
                className="inline-flex items-center gap-1 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40 dark:text-cyan-200"
              >
                <SendHorizontal className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
