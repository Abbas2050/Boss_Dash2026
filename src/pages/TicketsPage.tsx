import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Loader2, RefreshCcw, Send, UserRound } from "lucide-react";
import { getCurrentUser, hasAccess } from "@/lib/auth";
import { useLocation } from "react-router-dom";
import {
  type ApplicationConfigDefinition,
  type ApplicationRecord,
  approveCrmApplication,
  createCrmApplication,
  getCrmApplicationConfig,
  getCurrentActorEmail,
  listCrmApplicationsPage,
  listCrmApplicationsForActor,
  resolveCrmManagerIdFromSession,
  resolveUserIdByAccountNumber,
  searchAccountsByLogin,
  searchClientsByClientId,
  type ApplicationSectionRequest,
} from "@/lib/applicationsApi";

type RequestTypeKey =
  | "create-account-type"
  | "create-new-ib-structure"
  | "change-ib"
  | "change-account-type"
  | "change-ib-commission"
  | "change-leverage";

type RequestTypeConfig = {
  key: RequestTypeKey;
  label: string;
  configId: number;
};

type DynamicField = {
  id: string;
  sectionTitle: string;
  question: string;
  type: "text" | "date" | "country" | "checkbox";
  options: string[];
  required: boolean;
};

type LookupSuggestion = {
  label: string;
  value: string;
  userId?: number | null;
};

const REQUEST_TYPES: RequestTypeConfig[] = [
  { key: "create-account-type", label: "Create Account Type", configId: 54 },
  { key: "create-new-ib-structure", label: "Create New IB Structure", configId: 55 },
  { key: "change-ib", label: "Change IB", configId: 56 },
  { key: "change-account-type", label: "Change Account Type", configId: 57 },
  { key: "change-ib-commission", label: "Change IB commission", configId: 58 },
  { key: "change-leverage", label: "Change Leverage", configId: 59 },
];

const MANAGER_ID_TO_EMAIL: Record<number, string> = {
  11: "dealing@skylinkscapital.com",
  7: "backoffice@skylinkscapital.com",
  4: "d.takieddine@gmail.com",
  3: "abbas@skylinkscapital.com",
  16: "irungbam@skylinkscapital.com",
};

const REQUEST_TYPE_BY_CONFIG_ID: Record<number, string> = {
  54: "Create Account Type",
  55: "Create New IB Structure",
  56: "Change IB",
  57: "Change Account Type",
  58: "Change IB commission",
  59: "Change Leverage",
};

const APPROVER_RULES: Record<number, number> = {
  54: 11,
  57: 11,
  59: 11,
  55: 4,
  56: 4,
  58: 4,
};

const APPROVER_EMAIL_TO_MANAGER_ID: Record<string, number> = {
  "elias@skylinkscapital.com": 11,
  "d.takieddine@gmail.com": 4,
};

const INITIAL_FORM = {
  requestType: "create-account-type" as RequestTypeKey,
};

function toDubaiDisplayDate(value: string): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusBadgeClass(status: string): string {
  const v = String(status || "").trim().toLowerCase();
  if (v === "approved") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (v === "pending") return "border-blue-500/35 bg-blue-500/10 text-blue-700 dark:text-blue-300";
  if (v === "rejected" || v === "declined") return "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  return "border-primary/25 bg-primary/10 text-primary";
}

function managerLabel(managerId: number | null | undefined): string {
  const id = Number(managerId);
  if (!Number.isFinite(id) || id <= 0) return "-";
  return MANAGER_ID_TO_EMAIL[id] || `manager-${id}@skylinkscapital.com`;
}

function normalizeFieldType(rawType: unknown): DynamicField["type"] {
  const t = String(rawType || "").toLowerCase();
  if (t.includes("checkbox")) return "checkbox";
  if (t.includes("country")) return "country";
  if (t.includes("date")) return "date";
  return "text";
}

function extractOptions(raw: any): string[] {
  const src = raw?.options ?? raw?.values ?? raw?.choices ?? raw?.items;
  if (!Array.isArray(src)) return [];
  return src
    .map((item) => {
      if (typeof item === "string") return item.trim();
      const value = String(item?.label ?? item?.value ?? item?.title ?? item?.name ?? "").trim();
      return value;
    })
    .filter(Boolean);
}

function looksLikeQuestionNode(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  const hasLabel = Boolean(String(node.question ?? node.label ?? node.title ?? node.name ?? "").trim());
  const hasType = Boolean(String(node.type ?? node.inputType ?? node.fieldType ?? "").trim());
  return hasLabel && hasType;
}

function extractDynamicFieldsFromConfig(config: ApplicationConfigDefinition | null): DynamicField[] {
  if (!config?.config || typeof config.config !== "object") return [];
  const fields: DynamicField[] = [];
  const seen = new Set<string>();

  const walk = (node: any, sectionTitle: string, path: string[]) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, sectionTitle, [...path, String(idx)]));
      return;
    }
    if (typeof node !== "object") return;

    if (looksLikeQuestionNode(node)) {
      const question = String(node.question ?? node.label ?? node.title ?? node.name).trim();
      const type = normalizeFieldType(node.type ?? node.inputType ?? node.fieldType);
      const idBase = String(node.name ?? node.key ?? question).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const id = `${sectionTitle.toLowerCase().replace(/[^a-z0-9]+/g, "_")}__${idBase || path.join("_")}`;
      if (!seen.has(id)) {
        seen.add(id);
        fields.push({
          id,
          sectionTitle: sectionTitle || "General",
          question,
          type,
          options: extractOptions(node),
          required: Boolean(node.required),
        });
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "options" || key === "values" || key === "items" || key === "choices") continue;
      const nextSection = key.toLowerCase().includes("section")
        ? String((value as any)?.title || key)
        : sectionTitle;
      walk(value, nextSection, [...path, key]);
    }
  };

  walk(config.config, config.title || "General", []);
  return fields.filter((field) => !/request\s*type/i.test(field.question));
}

function shouldHideDynamicField(field: DynamicField, selectedTypeLabel: string): boolean {
  const rawQ = String(field.question || "").trim();
  const q = rawQ.toLowerCase();
  if (!q) return true;
  if (/request\s*type/.test(q)) return true;
  const selected = String(selectedTypeLabel || "").trim().toLowerCase();
  const normalize = (s: string) => s.replace(/[^a-z0-9]+/g, "");
  const qNorm = normalize(q);
  const selectedNorm = normalize(selected);
  if (selectedNorm && qNorm === selectedNorm) {
    return true;
  }
  return false;
}

function buildSectionsPayload(fields: DynamicField[], values: Record<string, string | string[]>): ApplicationSectionRequest[] {
  const grouped = new Map<string, ApplicationSectionRequest>();
  for (const field of fields) {
    const value = values[field.id];
    const hasValue = Array.isArray(value) ? value.length > 0 : String(value || "").trim().length > 0;
    if (!hasValue) continue;

    if (!grouped.has(field.sectionTitle)) {
      grouped.set(field.sectionTitle, { title: field.sectionTitle, answers: [] });
    }
    grouped.get(field.sectionTitle)!.answers.push({
      question: field.question,
      answer: {
        type: field.type,
        value: field.type === "checkbox" ? (Array.isArray(value) ? value : [String(value)]) : String(value),
      },
    });
  }
  return Array.from(grouped.values());
}

export default function TicketsPage() {
  const location = useLocation();
  const currentUser = getCurrentUser();
  const [form, setForm] = useState(INITIAL_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [records, setRecords] = useState<ApplicationRecord[]>([]);
  const [approvalQueue, setApprovalQueue] = useState<ApplicationRecord[]>([]);
  const [appsPage, setAppsPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [clientNameById, setClientNameById] = useState<Record<number, string>>({});
  const [approveBusyId, setApproveBusyId] = useState<number | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [applicationConfig, setApplicationConfig] = useState<ApplicationConfigDefinition | null>(null);
  const [dynamicFields, setDynamicFields] = useState<DynamicField[]>([]);
  const [dynamicValues, setDynamicValues] = useState<Record<string, string | string[]>>({});
  const [lookupLoadingByField, setLookupLoadingByField] = useState<Record<string, boolean>>({});
  const [lookupRowsByField, setLookupRowsByField] = useState<Record<string, LookupSuggestion[]>>({});
  const lookupTimersRef = useRef<Record<string, ReturnType<typeof setTimeout> | undefined>>({});
  const canSeeAll = hasAccess("Applications:All");
  const highlightedAppId = useMemo(() => {
    const params = new URLSearchParams(location.search || "");
    const id = Number(params.get("appId") || "");
    return Number.isFinite(id) && id > 0 ? id : null;
  }, [location.search]);

  const selectedType = useMemo(() => REQUEST_TYPES.find((t) => t.key === form.requestType) || REQUEST_TYPES[0], [form.requestType]);
  const managerId = useMemo(() => {
    try {
      return resolveCrmManagerIdFromSession();
    } catch {
      return null;
    }
  }, []);
  const actorEmail = useMemo(() => getCurrentActorEmail(), []);
  const approverManagerId = useMemo(
    () => APPROVER_EMAIL_TO_MANAGER_ID[String(currentUser?.email || "").trim().toLowerCase()] ?? null,
    [currentUser?.email]
  );
  const currentUserId = useMemo(() => {
    const id = Number(currentUser?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  }, [currentUser?.id]);

  const loadApplications = async () => {
    if (!managerId && !currentUserId) return;
    setIsLoading(true);
    try {
      const offset = (appsPage - 1) * pageSize;
      const rows = canSeeAll
        ? await listCrmApplicationsPage({ limit: pageSize + 1, offset })
        : await listCrmApplicationsForActor({
            actorEmail,
            userId: currentUserId,
            managerId: approverManagerId,
            limit: pageSize + 1,
            offset,
          });
      setHasMore(rows.length > pageSize);
      const currentRows = rows.slice(0, pageSize);
      setRecords(currentRows);
    } catch (e: any) {
      setError(e?.message || "Failed to load applications.");
    } finally {
      setIsLoading(false);
    }
  };

  const loadApprovalQueue = async () => {
    if (!approverManagerId) {
      setApprovalQueue([]);
      return;
    }
    try {
      const rows = await listCrmApplicationsPage({ limit: 200, offset: 0 });
      const pendingRows = rows.filter((row) => {
        const status = String(row.status || "").trim().toLowerCase();
        if (status !== "pending") return false;
        const owner = APPROVER_RULES[Number(row.configId)];
        return owner === approverManagerId;
      });
      setApprovalQueue(pendingRows);
    } catch {
      setApprovalQueue([]);
    }
  };

  useEffect(() => {
    void loadApplications();
  }, [managerId, currentUserId, canSeeAll, actorEmail, approverManagerId, appsPage, pageSize]);

  useEffect(() => {
    void loadApprovalQueue();
  }, [approverManagerId]);

  useEffect(() => {
    const iv = setInterval(() => void loadApplications(), 30000);
    return () => clearInterval(iv);
  }, [managerId, currentUserId, canSeeAll, actorEmail, approverManagerId, appsPage, pageSize]);

  useEffect(() => {
    const iv = setInterval(() => void loadApprovalQueue(), 30000);
    return () => clearInterval(iv);
  }, [approverManagerId]);

  useEffect(() => {
    let alive = true;
    const userIds = Array.from(
      new Set(
        [...records, ...approvalQueue]
          .map((row) => Number(row.userId))
          .filter((id) => Number.isFinite(id) && id > 0)
      )
    );
    if (userIds.length === 0) return;

    (async () => {
      const entries = await Promise.all(
        userIds.map(async (id) => {
          try {
            const rows = await searchClientsByClientId(String(id));
            const first = rows[0];
            const name = `${first?.firstName || ""} ${first?.lastName || ""}`.trim() || first?.email || `Client ${id}`;
            return [id, name] as const;
          } catch {
            return [id, `Client ${id}`] as const;
          }
        })
      );
      if (!alive) return;
      setClientNameById((prev) => {
        const next = { ...prev };
        for (const [id, name] of entries) next[id] = name;
        return next;
      });
    })();

    return () => {
      alive = false;
    };
  }, [records, approvalQueue]);

  useEffect(() => {
    if (!highlightedAppId) return;
    const timer = setTimeout(() => {
      const el = document.getElementById(`app-row-${highlightedAppId}`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 250);
    return () => clearTimeout(timer);
  }, [highlightedAppId, records]);

  useEffect(() => {
    let alive = true;
    setConfigLoading(true);
    setError(null);
    (async () => {
      try {
        const cfg = await getCrmApplicationConfig(selectedType.configId);
        if (!alive) return;
        setApplicationConfig(cfg);
        const fields = extractDynamicFieldsFromConfig(cfg);
        setDynamicFields(fields);
        setDynamicValues({});
        setLookupLoadingByField({});
        setLookupRowsByField({});
      } catch (e: any) {
        if (!alive) return;
        setApplicationConfig(null);
        setDynamicFields([]);
        setDynamicValues({});
        setLookupLoadingByField({});
        setLookupRowsByField({});
        setError(e?.message || "Failed to load application config.");
      } finally {
        if (alive) setConfigLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedType.configId]);

  useEffect(() => {
    return () => {
      for (const key of Object.keys(lookupTimersRef.current)) {
        const t = lookupTimersRef.current[key];
        if (t) clearTimeout(t);
      }
    };
  }, []);

  const validate = () => {
    for (const field of dynamicFields) {
      if (!field.required) continue;
      const value = dynamicValues[field.id];
      const ok = Array.isArray(value) ? value.length > 0 : String(value || "").trim().length > 0;
      if (!ok) return `Please fill required field: ${field.question}`;
    }
    return null;
  };

  const getDynamicTextByQuestion = (matcher: RegExp): string => {
    const target = dynamicFields.find((field) => matcher.test(field.question));
    if (!target) return "";
    const value = dynamicValues[target.id];
    if (Array.isArray(value)) return value.join(",").trim();
    return String(value || "").trim();
  };

  const isClientIdField = (field: DynamicField) => /client\s*id/i.test(field.question);
  const isAccountIdField = (field: DynamicField) => /account\s*(id|number)|mt5\s*(id|login)?/i.test(field.question);

  const scheduleLookup = (field: DynamicField, value: string) => {
    const key = field.id;
    const text = value.trim();
    const current = lookupTimersRef.current[key];
    if (current) clearTimeout(current);

    if (!text) {
      setLookupRowsByField((prev) => ({ ...prev, [key]: [] }));
      setLookupLoadingByField((prev) => ({ ...prev, [key]: false }));
      return;
    }

    lookupTimersRef.current[key] = setTimeout(async () => {
      setLookupLoadingByField((prev) => ({ ...prev, [key]: true }));
      try {
        if (isClientIdField(field)) {
          const rows = await searchClientsByClientId(text);
          setLookupRowsByField((prev) => ({
            ...prev,
            [key]: rows.map((row) => ({
              label: `ID ${row.id} - ${`${row.firstName} ${row.lastName}`.trim() || row.email || "-"}`,
              value: String(row.id),
              userId: row.id,
            })),
          }));
          return;
        }
        if (isAccountIdField(field)) {
          const rows = await searchAccountsByLogin(text);
          setLookupRowsByField((prev) => ({
            ...prev,
            [key]: rows.map((row) => ({
              label: `${row.login} - U:${row.userId ?? "-"}`,
              value: String(row.login),
              userId: row.userId ?? null,
            })),
          }));
          return;
        }
      } finally {
        setLookupLoadingByField((prev) => ({ ...prev, [key]: false }));
      }
    }, 280);
  };

  const resolveApplicationUser = async (): Promise<number> => {
    const clientIdText = getDynamicTextByQuestion(/client\s*id/i);
    const clientId = Number(clientIdText);
    if (Number.isFinite(clientId) && clientId > 0) return clientId;
    const account = getDynamicTextByQuestion(/account\s*number|account/i);
    if (account) {
      const resolved = await resolveUserIdByAccountNumber(account);
      if (resolved) return resolved;
      throw new Error(`No CRM client found for account number ${account}.`);
    }
    throw new Error("Provide Client ID or Account Number.");
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const invalid = validate();
    if (invalid) return setError(invalid);
    if (!managerId) return setError("Logged-in user is not mapped to a CRM manager.");
    setIsSubmitting(true);
    try {
      const user = await resolveApplicationUser();
      const sections = buildSectionsPayload(dynamicFields, dynamicValues);
      const created = await createCrmApplication({
        user,
        configId: selectedType.configId,
        sections,
        createdBy: currentUser?.email || `manager-${managerId}@skylinkscapital.com`,
        uploadedByClient: false,
      });
      setRecords((prev) => [created, ...prev.filter((r) => r.id !== created.id)]);
      setSuccess(`Application #${created.id} submitted.`);
      setDynamicValues({});
    } catch (err: any) {
      setError(err?.message || "Failed to create application.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto w-full max-w-7xl space-y-6 px-3 py-4 sm:px-5 sm:py-6">
        <section className="rounded-2xl border border-border/50 bg-gradient-to-r from-card via-card to-card/90 p-4 shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
                <FileText className="h-3.5 w-3.5" /> CRM Applications
              </div>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">Applications</h1>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-border/50 bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
              <UserRound className="h-4 w-4 text-primary" />
              <span>{currentUser?.email || "Unknown user"}</span>
              <span className="text-foreground">{managerLabel(managerId)}</span>
            </div>
          </div>
        </section>

        {approverManagerId ? (
          <section className="rounded-2xl border border-border/50 bg-card p-4 shadow-sm sm:p-5">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-foreground">Pending Your Approval</h2>
                <p className="text-xs text-muted-foreground">
                  {approvalQueue.length} pending application{approvalQueue.length === 1 ? "" : "s"} assigned to you.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadApprovalQueue()}
                className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <RefreshCcw className="h-3.5 w-3.5" /> Refresh
              </button>
            </div>
            <div className="hidden md:block overflow-x-auto rounded-xl border border-border/50 bg-background/60">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-secondary/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">ID</th>
                    <th className="px-3 py-2 text-left">Application</th>
                    <th className="px-3 py-2 text-left">Client</th>
                    <th className="px-3 py-2 text-left">Created</th>
                    <th className="px-3 py-2 text-left">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {approvalQueue.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-5 text-center text-xs text-muted-foreground">
                        No pending approvals assigned to you.
                      </td>
                    </tr>
                  ) : (
                    approvalQueue.map((row) => (
                        <tr
                          id={`app-row-${row.id}`}
                          key={`approve-${row.id}`}
                          className={`border-t border-border/40 hover:bg-secondary/20 ${highlightedAppId === row.id ? "bg-blue-500/10 ring-1 ring-blue-400/40" : ""}`}
                        >
                        <td className="px-3 py-2 font-mono text-xs">{row.id}</td>
                        <td className="px-3 py-2 text-xs">{REQUEST_TYPE_BY_CONFIG_ID[Number(row.configId)] || row.type || "-"}</td>
                        <td className="px-3 py-2 text-xs">
                          {Number(row.userId) > 0 ? (clientNameById[Number(row.userId)] || `Client ${row.userId}`) : "-"}
                        </td>
                        <td className="px-3 py-2 text-xs">{toDubaiDisplayDate(row.createdAt)}</td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            disabled={approveBusyId === row.id}
                            onClick={async () => {
                              setError(null);
                              setSuccess(null);
                              setApproveBusyId(row.id);
                              try {
                                await approveCrmApplication(row.id, approverManagerId);
                                setSuccess(`Application #${row.id} approved successfully.`);
                                await Promise.all([loadApprovalQueue(), loadApplications()]);
                              } catch (e: any) {
                                setError(e?.message || "Failed to approve application.");
                              } finally {
                                setApproveBusyId(null);
                              }
                            }}
                            className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-700 disabled:opacity-60 dark:text-emerald-300"
                          >
                            {approveBusyId === row.id ? "Approving..." : "Approve"}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="md:hidden space-y-2">
              {approvalQueue.length === 0 ? (
                <div className="rounded-xl border border-border/50 bg-background/60 p-3 text-center text-xs text-muted-foreground">
                  No pending approvals assigned to you.
                </div>
              ) : (
                approvalQueue.map((row) => (
                  <div
                    id={`app-row-${row.id}`}
                    key={`approve-card-${row.id}`}
                    className={`rounded-xl border border-border/50 bg-background/60 p-3 ${highlightedAppId === row.id ? "ring-1 ring-blue-400/40" : ""}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-mono text-xs">#{row.id}</div>
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusBadgeClass(row.status)}`}>
                        {row.status || "-"}
                      </span>
                    </div>
                    <div className="mt-1 text-sm font-medium text-foreground">{REQUEST_TYPE_BY_CONFIG_ID[Number(row.configId)] || row.type || "-"}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Client: {Number(row.userId) > 0 ? (clientNameById[Number(row.userId)] || `Client ${row.userId}`) : "-"}
                    </div>
                    <div className="text-xs text-muted-foreground">Created: {toDubaiDisplayDate(row.createdAt)}</div>
                    <div className="mt-2">
                      <button
                        type="button"
                        disabled={approveBusyId === row.id}
                        onClick={async () => {
                          setError(null);
                          setSuccess(null);
                          setApproveBusyId(row.id);
                          try {
                            await approveCrmApplication(row.id, approverManagerId);
                            setSuccess(`Application #${row.id} approved successfully.`);
                            await Promise.all([loadApprovalQueue(), loadApplications()]);
                          } catch (e: any) {
                            setError(e?.message || "Failed to approve application.");
                          } finally {
                            setApproveBusyId(null);
                          }
                        }}
                        className="w-full rounded-full border border-emerald-500/35 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-700 disabled:opacity-60 dark:text-emerald-300"
                      >
                        {approveBusyId === row.id ? "Approving..." : "Approve"}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        ) : null}

        <section className="grid grid-cols-1 gap-5 xl:grid-cols-5">
          <div className="xl:col-span-2">
            <form onSubmit={onSubmit} className="rounded-2xl border border-border/50 bg-card p-4 shadow-sm sm:p-5">
              <div className="mb-4">
                <h2 className="text-base font-semibold text-foreground">Create Application</h2>
              </div>
              <div className="space-y-3">
                <label className="block text-xs font-medium text-muted-foreground">
                  Request Type
                  <select value={form.requestType} onChange={(e) => setForm((p) => ({ ...p, requestType: e.target.value as RequestTypeKey }))} className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm">
                    {REQUEST_TYPES.map((type) => <option key={type.key} value={type.key}>{type.label}</option>)}
                  </select>
                </label>

                {configLoading ? <div className="rounded-lg border border-border/60 bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">Loading config fields...</div> : null}
                {!configLoading && dynamicFields.length === 0 ? (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    No dynamic fields parsed from CRM config. Please verify config structure or endpoint access.
                  </div>
                ) : null}

                {dynamicFields
                  .filter((field) => !shouldHideDynamicField(field, selectedType.label))
                  .map((field) => (
                  <label key={field.id} className="block text-xs font-medium text-muted-foreground">
                    {field.question} {field.required ? <span className="text-destructive">*</span> : null}
                    {field.type === "checkbox" && field.options.length > 0 ? (
                      <div className="mt-1 space-y-1 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm">
                        {field.options.map((opt) => {
                          const selected = Array.isArray(dynamicValues[field.id]) ? (dynamicValues[field.id] as string[]) : [];
                          return (
                            <label key={opt} className="flex items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={selected.includes(opt)}
                                onChange={(e) => {
                                  setDynamicValues((prev) => {
                                    const cur = Array.isArray(prev[field.id]) ? [...(prev[field.id] as string[])] : [];
                                    const next = e.target.checked ? [...cur, opt] : cur.filter((x) => x !== opt);
                                    return { ...prev, [field.id]: next };
                                  });
                                }}
                              />
                              <span>{opt}</span>
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <>
                        <input
                          type={field.type === "date" ? "date" : "text"}
                          value={Array.isArray(dynamicValues[field.id]) ? "" : String(dynamicValues[field.id] || "")}
                          onChange={(e) => {
                            const nextValue = e.target.value;
                            setDynamicValues((prev) => ({ ...prev, [field.id]: nextValue }));
                            if (isClientIdField(field) || isAccountIdField(field)) {
                              scheduleLookup(field, nextValue);
                            }
                          }}
                          className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                        />
                        {lookupLoadingByField[field.id] ? (
                          <div className="mt-1 text-xs text-muted-foreground">Searching...</div>
                        ) : null}
                        {(lookupRowsByField[field.id] || []).length > 0 ? (
                          <div className="mt-1 max-h-40 overflow-auto rounded-lg border border-border/60 bg-popover">
                            {(lookupRowsByField[field.id] || []).map((row, idx) => (
                              <button
                                key={`${field.id}-${idx}-${row.value}`}
                                type="button"
                                onClick={() => {
                                  setDynamicValues((prev) => ({ ...prev, [field.id]: row.value }));
                                  setLookupRowsByField((prev) => ({ ...prev, [field.id]: [] }));
                                }}
                                className="flex w-full justify-between border-b border-border/40 px-3 py-2 text-left text-xs hover:bg-secondary/40 last:border-b-0"
                              >
                                <span>{row.value}</span>
                                <span className="truncate">{row.label}</span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </>
                    )}
                  </label>
                ))}

                {error ? <div className="rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div> : null}
                {success ? <div className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">{success}</div> : null}

                <button type="submit" disabled={isSubmitting || configLoading} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-primary to-cyan-500 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-70">
                  {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {isSubmitting ? "Submitting..." : "Submit Application"}
                </button>
              </div>
            </form>
          </div>

          <div className="xl:col-span-3">
            <div className="rounded-2xl border border-border/50 bg-gradient-to-b from-card to-card/80 p-4 shadow-sm sm:p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-foreground">Recent Applications</h2>
                <div className="flex items-center gap-2">
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value || 20));
                      setAppsPage(1);
                    }}
                    className="rounded-full border border-border/60 bg-background px-2.5 py-1.5 text-xs text-muted-foreground"
                  >
                    <option value={10}>10 / page</option>
                    <option value={20}>20 / page</option>
                    <option value={50}>50 / page</option>
                  </select>
                  <button type="button" onClick={() => void loadApplications()} disabled={isLoading} className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
                    <RefreshCcw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} /> Refresh
                  </button>
                </div>
              </div>
              <div className="hidden md:block overflow-x-auto rounded-xl border border-border/50 bg-background/60 backdrop-blur-sm">
                <table className="w-full min-w-[860px] text-sm">
                  <thead className="bg-secondary/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">ID</th>
                      <th className="px-3 py-2 text-left">Type</th>
                      <th className="px-3 py-2 text-left">Status</th>
                      <th className="px-3 py-2 text-left">Client Name</th>
                      <th className="px-3 py-2 text-left">Created</th>
                      <th className="px-3 py-2 text-left">Processed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.length === 0 && !isLoading ? (
                      <tr><td colSpan={6} className="px-3 py-5 text-center text-xs text-muted-foreground">No application records found.</td></tr>
                    ) : (
                      records.map((row) => (
                        <tr
                          id={`app-row-${row.id}`}
                          key={row.id}
                          className={`border-t border-border/40 hover:bg-secondary/20 ${highlightedAppId === row.id ? "bg-blue-500/10 ring-1 ring-blue-400/40" : ""}`}
                        >
                          <td className="px-3 py-2 font-mono text-xs">{row.id}</td>
                          <td className="px-3 py-2 text-xs">{row.type || "-"}</td>
                          <td className="px-3 py-2">
                            <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${statusBadgeClass(row.status)}`}>
                              {row.status || "-"}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {Number(row.userId) > 0
                              ? (clientNameById[Number(row.userId)] || `Client ${row.userId}`)
                              : "-"}
                          </td>
                          <td className="px-3 py-2 text-xs">{toDubaiDisplayDate(row.createdAt)}</td>
                          <td className="px-3 py-2 text-xs">{toDubaiDisplayDate(row.processedAt)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <div className="md:hidden space-y-2">
                {records.length === 0 && !isLoading ? (
                  <div className="rounded-xl border border-border/50 bg-background/60 p-3 text-center text-xs text-muted-foreground">
                    No application records found.
                  </div>
                ) : (
                  records.map((row) => (
                    <div
                      id={`app-row-${row.id}`}
                      key={`app-card-${row.id}`}
                      className={`rounded-xl border border-border/50 bg-background/60 p-3 ${highlightedAppId === row.id ? "ring-1 ring-blue-400/40" : ""}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="font-mono text-xs">#{row.id}</div>
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusBadgeClass(row.status)}`}>
                          {row.status || "-"}
                        </span>
                      </div>
                      <div className="mt-1 text-sm font-medium text-foreground">{row.type || "-"}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Client: {Number(row.userId) > 0 ? (clientNameById[Number(row.userId)] || `Client ${row.userId}`) : "-"}
                      </div>
                      <div className="text-xs text-muted-foreground">Created: {toDubaiDisplayDate(row.createdAt)}</div>
                      <div className="text-xs text-muted-foreground">Processed: {toDubaiDisplayDate(row.processedAt)}</div>
                    </div>
                  ))
                )}
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>Page {appsPage}</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={appsPage <= 1 || isLoading}
                    onClick={() => setAppsPage((p) => Math.max(1, p - 1))}
                    className="rounded-full border border-border/60 bg-background px-3 py-1.5 disabled:opacity-50"
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    disabled={!hasMore || isLoading}
                    onClick={() => setAppsPage((p) => p + 1)}
                    className="rounded-full border border-border/60 bg-background px-3 py-1.5 disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
