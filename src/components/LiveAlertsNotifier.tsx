import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/sonner";
import { SignalRConnectionManager } from "@/lib/signalRConnectionManager";
import { getCurrentUser, hasAccess } from "@/lib/auth";
import { Activity, AlertTriangle, CheckCircle, Info, ShoppingCart, X, XCircle } from "lucide-react";
import {
  ALERT_EVENT_KEYS,
  ALERT_EVENT_META,
  AlertEventKey,
  AlertPreferences,
  onAlertPreferencesChanged,
  readAlertPreferences,
} from "@/lib/alertPreferences";
import {
  declineCrmApplication,
  getApproverRoutingForRecord,
  listCrmApplicationsPage,
  resolveCrmManagerIdFromSession,
  updateCrmApplicationStatus,
  type ApplicationRecord,
} from "@/lib/applicationsApi";

const APPROVER_EMAIL_TO_MANAGER_ID: Record<string, number> = {
  "elias@skylinkscapital.com": 11,
  "dealing@skylinkscapital.com": 24,
  "d.takieddine@gmail.com": 4,
  "d.takieddine@skylinkscapital.com": 4,
  "dtakieddine@skylinkscapital.com": 4,
  "backoffice@skylinkscapital.com": 7,
};

const APPROVER_RULES: Record<number, number> = {
  61: 4,  // Change Entity -> Daniel
  62: 11, // Create Account Type -> Elias
  63: 4,  // Create New IB Structure -> Daniel
  64: 11, // Change IB -> Elias
  65: 11, // Change Account Type -> Elias
  66: 4,  // Change IB Commission -> Daniel
  67: 11, // Change Leverage -> Elias
};
const FINAL_APPROVER_RULES: Record<number, number> = {
  61: 7,  // Change Entity -> Backoffice
  62: 7,  // Create Account Type -> Backoffice
  63: 3,  // Create New IB Structure -> Abbas
  64: 7,  // Change IB -> Backoffice
  65: 7,  // Change Account Type -> Backoffice
  66: 3,  // Change IB Commission -> Abbas
  67: 3,  // Change Leverage -> Abbas
};

const ACTION_APPROVER_EMAILS = new Set<string>([
  "elias@skylinkscapital.com",
  "d.takieddine@gmail.com",
]);
const BACKOFFICE_MANAGER_ID = 7;

function appTypeLabel(configId: number, fallback: string): string {
  const map: Record<number, string> = {
    61: "Change Entity",
    62: "Create Account Type",
    63: "Create New IB Structure",
    64: "Change IB",
    65: "Change Account Type",
    66: "Change IB commission",
    67: "Change Leverage",
  };
  return map[Number(configId)] || fallback || `Config ${configId}`;
}

function deriveWorkflowStatus(row: ApplicationRecord): string {
  const status = String(row.status || "").trim().toLowerCase();
  const routing = getApproverRoutingForRecord(row);
  const owner = routing.firstApproverId;
  const finalOwner = routing.finalApproverId;
  let acceptedBy = Number(row.acceptedBy || 0);
  if (!(Number.isFinite(acceptedBy) && acceptedBy > 0)) {
    const processedByRaw = String(row.processedBy || "").trim().toLowerCase();
    const processedByDigits = Number((processedByRaw.match(/\d+/)?.[0] || ""));
    acceptedBy = APPROVER_EMAIL_TO_MANAGER_ID[processedByRaw] || (Number.isFinite(processedByDigits) ? processedByDigits : 0);
  }
  if (status === "approved") {
    if (acceptedBy > 0 && finalOwner > 0 && acceptedBy === finalOwner) return "approved";
    if (acceptedBy > 0 && owner > 0 && acceptedBy === owner) return "approved by manager";
    if (acceptedBy > 0) return "approved";
  }
  return status;
}

function eventPulseClass(eventName: AlertEventKey): string {
  if (eventName === "AccountAlert") return "from-red-500/30 to-red-500/5";
  if (eventName === "UserChangeAlert") return "from-emerald-500/30 to-emerald-500/5";
  if (eventName === "TransactionAlert") return "from-amber-500/30 to-amber-500/5";
  if (eventName === "PositionMatchTableUpdate") return "from-cyan-500/30 to-cyan-500/5";
  if (eventName === "DealUpdate") return "from-blue-500/30 to-blue-500/5";
  if (eventName === "PositionUpdate") return "from-lime-500/30 to-lime-500/5";
  if (eventName === "OrderUpdate") return "from-orange-500/30 to-orange-500/5";
  return "from-slate-500/30 to-slate-500/5";
}

function eventItemClass(eventName: AlertEventKey): string {
  if (eventName === "AccountAlert") return "text-destructive border-destructive/30 bg-destructive/10";
  if (eventName === "UserChangeAlert") return "text-success border-success/30 bg-success/10";
  if (eventName === "TransactionAlert") return "text-warning border-warning/30 bg-warning/10";
  if (eventName === "PositionMatchTableUpdate") return "text-cyan-700 dark:text-cyan-300 border-cyan-400/40 bg-cyan-100/60 dark:bg-cyan-500/10";
  if (eventName === "DealUpdate") return "text-blue-700 dark:text-blue-300 border-blue-400/40 bg-blue-100/60 dark:bg-blue-500/10";
  if (eventName === "PositionUpdate") return "text-lime-700 dark:text-lime-300 border-lime-400/40 bg-lime-100/60 dark:bg-lime-500/10";
  if (eventName === "OrderUpdate") return "text-orange-700 dark:text-orange-300 border-orange-400/40 bg-orange-100/60 dark:bg-orange-500/10";
  return "text-primary border-primary/30 bg-primary/10";
}

function EventIcon(eventName: AlertEventKey) {
  if (eventName === "AccountAlert") return XCircle;
  if (eventName === "UserChangeAlert") return CheckCircle;
  if (eventName === "TransactionAlert") return AlertTriangle;
  if (eventName === "PositionMatchTableUpdate") return Activity;
  if (eventName === "DealUpdate") return ShoppingCart;
  if (eventName === "PositionUpdate") return Activity;
  if (eventName === "OrderUpdate") return ShoppingCart;
  return Info;
}

function getHubAndTokenUrls() {
  const backendBaseUrl = (import.meta as any).env?.VITE_BACKEND_BASE_URL || "";
  const explicitTokenUrl = (import.meta as any).env?.VITE_SIGNALR_TOKEN_URL || "";
  const base = String(backendBaseUrl).replace(/\/+$/, "");
  const tokenBase = String(explicitTokenUrl).trim();
  return {
    hubUrl: base ? `${base}/ws/dashboard` : "/ws/dashboard",
    tokenUrls: tokenBase
      ? [tokenBase]
      : [],
  };
}

function buildDescription(eventName: AlertEventKey, payload: any): string {
  if (eventName === "UserChangeAlert") {
    return `${payload?.eventType || "Update"}: ${payload?.name || "Client"} (Login ${payload?.login ?? "-"}) in ${payload?.group || "unknown group"}`;
  }
  if (eventName === "AccountAlert") {
    return `${payload?.alertType || "Risk"} for account ${payload?.account?.login ?? "-"} in ${payload?.group || "unknown group"} | Equity ${payload?.account?.equity ?? "-"} | Balance ${payload?.account?.balance ?? "-"}`;
  }
  if (eventName === "PositionMatchTableUpdate") {
    const symbols = Array.isArray(payload?.rows) ? payload.rows.length : 0;
    const lps = Array.isArray(payload?.lpNames) ? payload.lpNames.length : 0;
    return `Position match table refreshed for ${symbols} symbols across ${lps} LPs.`;
  }
  if (eventName === "DealUpdate") {
    return `Client ${payload?.login ?? "-"} deal ${payload?.deal ?? payload?.dealId ?? "-"} on ${payload?.symbol ?? "-"} at ${payload?.price ?? "-"}.`;
  }
  if (eventName === "PositionUpdate") {
    return `Client ${payload?.login ?? "-"} position ${payload?.position ?? payload?.positionId ?? "-"} on ${payload?.symbol ?? "-"}.`;
  }
  if (eventName === "OrderUpdate") {
    return `Order ${payload?.order ?? payload?.orderId ?? "-"} for client ${payload?.login ?? "-"} changed to ${payload?.state ?? payload?.status ?? "updated"}.`;
  }
  if (eventName === "TransactionAlert") {
    return `${payload?.transactionType || "Transaction"} for client ${payload?.login ?? "-"} amount ${payload?.amount ?? "-"} ${payload?.currency ?? ""}.`;
  }
  return JSON.stringify(payload ?? {});
}

function extractCreatorEmail(row: ApplicationRecord): string {
  const createdBy = String(row.createdBy || "").trim().toLowerCase();
  if (createdBy) return createdBy;
  const extract = (text: string): string => {
    if (!text) return "";
    const explicit = text.match(/created\s*by\s*:\s*([^\s]+@[^\s]+)/i);
    if (explicit?.[1]) return String(explicit[1]).trim().toLowerCase();
    const plain = text.match(/^[^\s]+@[^\s]+$/i);
    if (plain?.[0]) return String(plain[0]).trim().toLowerCase();
    const any = text.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
    return any?.[1] ? String(any[1]).trim().toLowerCase() : "";
  };
  const description = String((row as any).description || "").trim();
  const comment = String((row as any).comment || "").trim();
  return extract(description) || extract(comment);
}

export function LiveAlertsNotifier() {
  const managerRef = useRef<SignalRConnectionManager | null>(null);
  const prefsRef = useRef<AlertPreferences>(readAlertPreferences());
  const lastShownRef = useRef<Record<string, number>>({});
  const [prefs, setPrefs] = useState<AlertPreferences>(prefsRef.current);
  const seenPendingRef = useRef<Set<string>>(new Set());
  const seenApprovedRef = useRef<Set<string>>(new Set());
  const appsBaselineReadyRef = useRef(false);
  const lastReminderRef = useRef<Record<number, number>>({});
  const REMINDER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  const enabledEvents = useMemo(
    () =>
      ALERT_EVENT_KEYS.filter(
        (key) => prefs[key] && hasAccess(`Notifications:${key}`)
      ),
    [prefs]
  );

  useEffect(() => {
    const off = onAlertPreferencesChanged((next) => {
      prefsRef.current = next;
      setPrefs(next);
    });
    return off;
  }, []);

  useEffect(() => {
    if (enabledEvents.length === 0) {
      if (managerRef.current) {
        managerRef.current.disconnect().catch(() => undefined);
        managerRef.current = null;
      }
      return;
    }

    if (managerRef.current) {
      managerRef.current.disconnect().catch(() => undefined);
      managerRef.current = null;
    }

    const { hubUrl, tokenUrls } = getHubAndTokenUrls();
    const manager = new SignalRConnectionManager({
      hubUrl,
      trackedEvents: enabledEvents,
      accessTokenFactory: async () => {
        if (tokenUrls.length === 0) {
          // Tunnel hub can be public/no-token. Skip token probing unless explicitly configured.
          return null;
        }
        for (const tokenUrl of tokenUrls) {
          try {
            const res = await fetch(tokenUrl);
            if (!res.ok) continue;
            const j = await res.json();
            if (j?.token) return j.token;
          } catch {
            // Try the next token endpoint candidate.
          }
        }
        return null;
      },
    });

    manager.onEvent((payload: unknown, eventName: string) => {
      const key = eventName as AlertEventKey;
      if (!prefsRef.current[key]) return;

      // Small dedupe window to avoid duplicate popups from mirrored streams.
      const now = Date.now();
      const sig = `${eventName}:${JSON.stringify(payload ?? {})}`;
      const last = lastShownRef.current[sig] || 0;
      if (now - last < 800) return;
      lastShownRef.current[sig] = now;

      const meta = ALERT_EVENT_META[key];
      const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const title = meta?.title || eventName;
      const sub = meta?.description || "";
      const detail = buildDescription(key, payload as any);
      const Icon = EventIcon(key);

      toast.custom((toastId) => (
        <div className={`w-full max-w-full p-3 rounded-lg border ${eventItemClass(key)} relative overflow-hidden`}>
          <div className={`pointer-events-none absolute inset-0 bg-gradient-to-r ${eventPulseClass(key)}`} />
          <div className="relative">
            <div className="flex items-start gap-2">
              <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm truncate">{title}</span>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className="text-xs opacity-70 font-mono">{stamp}</span>
                    <button
                      type="button"
                      aria-label="Close alert"
                      onClick={() => toast.dismiss(toastId)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-foreground/30 bg-background/85 text-foreground hover:bg-background"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <div className="mt-0.5 text-xs opacity-80">{sub}</div>
                <p className="text-xs opacity-80 mt-1 leading-relaxed">{detail}</p>
              </div>
            </div>
          </div>
        </div>
      ), {
        className: "!border-0 !bg-transparent !shadow-none !p-0 !m-0",
        closeButton: false,
      });
    });

    manager.connect().catch(() => undefined);
    managerRef.current = manager;

    return () => {
      manager.disconnect().catch(() => undefined);
      if (managerRef.current === manager) managerRef.current = null;
    };
  }, [enabledEvents]);

  useEffect(() => {
    let mounted = true;

    const canPending = prefsRef.current.ApplicationPendingApproval;
    const canApproved = prefsRef.current.ApplicationApproved;
    if (!canPending && !canApproved) return;

    const poll = async () => {
      // Re-read user identity on every poll to avoid stale closure bugs.
      const currentUser = getCurrentUser();
      const currentEmail = String(currentUser?.email || "").trim().toLowerCase();
      const myApproverId = APPROVER_EMAIL_TO_MANAGER_ID[currentEmail] ?? null;
      const isActionApprover = ACTION_APPROVER_EMAILS.has(currentEmail);
      const isSuperAdmin = String(currentUser?.role || "") === "Super Admin";
      const actorManagerIdForActions = (() => {
        try {
          const id = Number(resolveCrmManagerIdFromSession());
          return Number.isFinite(id) && id > 0 ? id : null;
        } catch {
          const id = Number(myApproverId);
          return Number.isFinite(id) && id > 0 ? id : null;
        }
      })();

      try {
        const batchSize = 100;
        const maxPages = 4;
        const allRows: ApplicationRecord[] = [];
        for (let page = 0; page < maxPages; page += 1) {
          const pageRows = await listCrmApplicationsPage({
            limit: batchSize,
            offset: page * batchSize,
          });
          if (!Array.isArray(pageRows) || pageRows.length === 0) break;
          allRows.push(...pageRows);
          if (pageRows.length < batchSize) break;
        }
        const rows = Array.from(new Map(allRows.map((row) => [Number(row.id), row])).values())
          .sort((a, b) => {
            const byId = Number(b.id) - Number(a.id);
            if (Number.isFinite(byId) && byId !== 0) return byId;
            const at = new Date(String(a.createdAt || "")).getTime();
            const bt = new Date(String(b.createdAt || "")).getTime();
            return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
          });
        if (!mounted) return;

        if (!appsBaselineReadyRef.current) {
          for (const row of rows) {
            const id = Number(row.id);
            if (Number.isFinite(id) && id > 0) {
              const wf = deriveWorkflowStatus(row);
              // Seed approved/declined set so status-change alerts don't fire for pre-existing records.
              seenApprovedRef.current.add(`${id}:${wf}`);
              // Do NOT seed seenPendingRef — we want pending apps to show a notification on
              // the very first real poll (15s after load) so approvers know what needs action.
              // Set lastReminderRef to 0 so the first poll will show them, then reminders every 5 min.
              lastReminderRef.current[id] = 0;
            }
          }
          appsBaselineReadyRef.current = true;
          return;
        }

        if (canPending && (myApproverId || isSuperAdmin)) {
          const pendingMine = rows.filter((row) => {
            const createdBy = extractCreatorEmail(row);
            if (!isSuperAdmin && createdBy && createdBy === currentEmail) return false;
            const status = deriveWorkflowStatus(row);
            const routing = getApproverRoutingForRecord(row);
            const owner = routing.firstApproverId;
            const finalOwner = routing.finalApproverId;
            if (isSuperAdmin) {
              return status === "pending" || status === "approved by manager";
            }
            // Final approvers get informational alerts for their assigned configs.
            if (Number(myApproverId) > 0 && finalOwner === Number(myApproverId)) {
              return status === "pending" || status === "approved by manager";
            }
            if (!isActionApprover) return false;
            return status === "pending" && owner === myApproverId;
          });

          for (const row of pendingMine) {
            const appId = Number(row.id);
            if (!Number.isFinite(appId) || appId <= 0) continue;
            const wf = deriveWorkflowStatus(row);
            const pendingKey = `${appId}:${wf}`;
            const now = Date.now();
            const lastReminder = lastReminderRef.current[appId] || 0;
            const isNew = !seenPendingRef.current.has(pendingKey);
            const isDueForReminder = now - lastReminder >= REMINDER_INTERVAL_MS;
            if (!isNew && !isDueForReminder) continue;
            seenPendingRef.current.add(pendingKey);
            lastReminderRef.current[appId] = now;
            const isReminder = !isNew && isDueForReminder;
            const isBackoffice = myApproverId === BACKOFFICE_MANAGER_ID;
            const isFinalStage = wf === "approved by manager";
            const routing = getApproverRoutingForRecord(row);
            const owner = routing.firstApproverId;
            const finalOwner = routing.finalApproverId;
            const canTakeAction = Boolean(actorManagerIdForActions) && (
              isSuperAdmin ||
              (isActionApprover && wf === "pending" && owner === Number(myApproverId)) ||
              (wf === "approved by manager" && finalOwner === Number(myApproverId))
            );
            const header = isBackoffice
              ? (isFinalStage ? "Final Approval Needed" : "New Application Created")
              : (isReminder ? "Reminder: Application Pending Approval" : "Application Pending Approval");
            const hint = isBackoffice
              ? (isFinalStage ? "Approved by manager, waiting final approval" : "Newly created application needs review")
              : "Waiting manager approval";
            const approveStatus = (isSuperAdmin || (wf === "approved by manager" && finalOwner === Number(myApproverId)))
              ? "approved"
              : "Approved by manager";
            const approveLabel = approveStatus === "approved" ? "Final Approve" : "Approve";
            const approveSuccess = approveStatus === "approved"
              ? `Application #${appId} finally approved.`
              : `Application #${appId} approved by manager.`;
            toast.custom((toastId) => (
              <div className="w-full max-w-full p-3 rounded-lg border text-blue-700 dark:text-blue-300 border-blue-400/40 bg-blue-100/60 dark:bg-blue-500/10 relative overflow-hidden">
                <div className="relative">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-sm truncate">{header}</span>
                        <button
                          type="button"
                          aria-label="Close alert"
                          onClick={() => toast.dismiss(toastId)}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-foreground/30 bg-background/85 text-foreground hover:bg-background"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <p className="text-xs opacity-90 mt-1 leading-relaxed">
                        #{row.id} • {appTypeLabel(Number(row.configId), row.type)} • Client {row.userId ?? "-"} • {hint}
                      </p>
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() => {
                            window.location.assign(`/applications?appId=${appId}`);
                            toast.dismiss(toastId);
                          }}
                          className="rounded-md border border-blue-500/35 bg-blue-500/10 px-2 py-1 text-[11px] font-semibold text-blue-700 dark:text-blue-300"
                        >
                          Open Application
                        </button>
                      </div>
                      {canTakeAction ? (
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await updateCrmApplicationStatus(
                                  appId,
                                  approveStatus,
                                  Number(actorManagerIdForActions),
                                );
                                toast.dismiss(toastId);
                                toast.success(approveSuccess);
                              } catch (e: any) {
                                toast.error(e?.message || "Approve failed.");
                              }
                            }}
                            className="rounded-md border border-emerald-500/35 bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300"
                          >
                            {approveLabel}
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await declineCrmApplication(appId, Number(actorManagerIdForActions));
                                toast.dismiss(toastId);
                                toast.success(`Application #${appId} rejected.`);
                              } catch (e: any) {
                                toast.error(e?.message || "Reject failed.");
                              }
                            }}
                            className="rounded-md border border-rose-500/35 bg-rose-500/10 px-2 py-1 text-[11px] font-semibold text-rose-700 dark:text-rose-300"
                          >
                            Reject
                          </button>
                        </div>
                      ) : (
                        <p className="mt-2 text-[11px] opacity-80">You can view this alert, but approval actions are not available at your current stage.</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ), { duration: Infinity });
          }
        }

        if (canApproved && currentEmail) {
          const relevantMine = rows.filter((row) => {
            const wf = deriveWorkflowStatus(row);
            const createdBy = extractCreatorEmail(row);
            return (wf === "approved" || wf === "approved by manager" || wf === "declined") && createdBy === currentEmail;
          });
          for (const row of relevantMine) {
            const appId = Number(row.id);
            if (!Number.isFinite(appId) || appId <= 0) continue;
            const wf = deriveWorkflowStatus(row);
            const key = `${appId}:${wf}`;
            if (seenApprovedRef.current.has(key)) continue;
            seenApprovedRef.current.add(key);
            const label = appTypeLabel(Number(row.configId), row.type);
            if (wf === "approved by manager") {
              toast.success(`Application #${appId} approved by manager`, {
                description: `${label} is waiting final backoffice approval.`,
              });
            } else if (wf === "approved") {
              toast.success(`Application #${appId} fully approved`, {
                description: `${label} has been fully approved.`,
              });
            } else if (wf === "declined") {
              toast.error(`Application #${appId} declined`, {
                description: `${label}${row.declineReason ? ` — ${row.declineReason}` : ""}.`,
              });
            }
          }
        }
      } catch (err) {
        // Log to console so we can diagnose API failures — not surfaced as a toast to avoid noise.
        console.error("[LiveAlertsNotifier] poll error:", err);
      }
    };

    void poll();
    const iv = setInterval(() => void poll(), 15000);
    return () => {
      mounted = false;
      clearInterval(iv);
    };
  }, [prefs]);

  return null;
}

