import { useEffect, useMemo, useState } from "react";
import { Loader2, Paperclip, RefreshCcw, Send, Ticket, UserRound } from "lucide-react";
import { getCurrentUser, hasAccess } from "@/lib/auth";
import {
  addCrmTicketComment,
  approveCrmTicket,
  closeCrmTicket,
  type CrmAccountSuggestion,
  createCrmTicket,
  type CrmClientSuggestion,
  type HelpDeskCategory,
  listHelpDeskCategories,
  listCrmTicketsAll,
  listCrmTicketComments,
  listCrmTicketsForActor,
  resolveCrmManagerIdFromSession,
  resolveUserIdByAccountNumber,
  searchAccountsByLogin,
  searchClientsByClientId,
  searchClientsByIbId,
  type TicketRecord,
  type TicketComment,
} from "@/lib/ticketsApi";

type RequestTypeKey =
  | "create-account-type"
  | "ib-rebate"
  | "create-new-ib-structure"
  | "change-ib"
  | "change-leverage"
  | "change-account-type"
  | "other";

type RequestTypeConfig = {
  key: RequestTypeKey;
  label: string;
  category: string;
  templateHint: string;
  defaultPriority: number;
};

const REQUEST_TYPES: RequestTypeConfig[] = [
  {
    key: "create-account-type",
    label: "Create Account Type",
    category: "Account Type",
    templateHint: "Name, Path, Leverage",
    defaultPriority: 6,
  },
  {
    key: "ib-rebate",
    label: "IB Rebate",
    category: "IB",
    templateHint: "Client ID, IB ID, Commission details",
    defaultPriority: 5,
  },
  {
    key: "create-new-ib-structure",
    label: "Create New IB Structure",
    category: "IB",
    templateHint: "Client ID, IB ID, Commission Structure",
    defaultPriority: 0,
  },
  {
    key: "change-ib",
    label: "Change IB",
    category: "IB",
    templateHint: "Client ID, New IB ID",
    defaultPriority: 0,
  },
  {
    key: "change-leverage",
    label: "Change Leverage",
    category: "Leverage",
    templateHint: "Account Number, New Leverage",
    defaultPriority: 0,
  },
  {
    key: "change-account-type",
    label: "Change Account Type",
    category: "Account Type",
    templateHint: "Account Number, New Account Type",
    defaultPriority: 0,
  },
  {
    key: "other",
    label: "Other",
    category: "Other",
    templateHint: "Free format details",
    defaultPriority: 0,
  },
];

const FALLBACK_CATEGORIES: HelpDeskCategory[] = [
  { value: "Other", label: "Other" },
  { value: "IB", label: "IB" },
  { value: "Leverage", label: "Leverage" },
  { value: "Account Type", label: "Account Type" },
];

const MANAGER_ID_TO_EMAIL: Record<number, string> = {
  11: "dealing@skylinkscapital.com",
  7: "backoffice@skylinkscapital.com",
  4: "d.takieddine@gmail.com",
  3: "abbas@skylinkscapital.com",
  16: "irungbam@skylinkscapital.com",
};

const INITIAL_FORM = {
  requestType: "create-account-type" as RequestTypeKey,
  title: "",
  priority: 0,
  clientId: "",
  accountNumber: "",
  accountTypeName: "",
  accountTypePath: "",
  leverage: "",
  ibId: "",
  newIbId: "",
  commissionStructure: "",
  commissionSymbols: "",
  newAccountType: "",
  newLeverage: "",
  note: "",
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

function inferTitle(form: typeof INITIAL_FORM, requestLabel: string) {
  if (form.title.trim()) return form.title.trim();
  const idPart = form.clientId.trim() || form.accountNumber.trim();
  return idPart ? `${requestLabel} - ${idPart}` : requestLabel;
}

function managerLabel(managerId: number | null | undefined): string {
  const id = Number(managerId);
  if (!Number.isFinite(id) || id <= 0) return "-";
  return MANAGER_ID_TO_EMAIL[id] || `manager-${id}@skylinkscapital.com`;
}

function buildTicketText(form: typeof INITIAL_FORM, requestLabel: string) {
  const lines: string[] = [`Request Type: ${requestLabel}`, `Priority: ${form.priority}`];

  if (form.clientId.trim()) lines.push(`Client ID: ${form.clientId.trim()}`);
  if (form.accountNumber.trim()) lines.push(`Account Number: ${form.accountNumber.trim()}`);
  if (form.accountTypeName.trim()) lines.push(`Name: ${form.accountTypeName.trim()}`);
  if (form.accountTypePath.trim()) lines.push(`Path: ${form.accountTypePath.trim()}`);
  if (form.leverage.trim()) lines.push(`Leverage: ${form.leverage.trim()}`);
  if (form.ibId.trim()) lines.push(`IB ID: ${form.ibId.trim()}`);
  if (form.newIbId.trim()) lines.push(`New IB ID: ${form.newIbId.trim()}`);
  if (form.commissionStructure.trim()) lines.push(`Commission Structure: ${form.commissionStructure.trim()}`);
  if (form.commissionSymbols.trim()) lines.push(`Commission on specific symbols: ${form.commissionSymbols.trim()}`);
  if (form.newAccountType.trim()) lines.push(`New Account Type: ${form.newAccountType.trim()}`);
  if (form.newLeverage.trim()) lines.push(`New Leverage: ${form.newLeverage.trim()}`);
  if (form.note.trim()) lines.push(`Details: ${form.note.trim()}`);

  return lines.join("\n");
}

async function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Unable to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export default function TicketsPage() {
  const currentUser = getCurrentUser();
  const [form, setForm] = useState(INITIAL_FORM);
  const [files, setFiles] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [records, setRecords] = useState<TicketRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [clientMatches, setClientMatches] = useState<CrmClientSuggestion[]>([]);
  const [ibMatches, setIbMatches] = useState<CrmClientSuggestion[]>([]);
  const [clientLookupLoading, setClientLookupLoading] = useState(false);
  const [ibLookupLoading, setIbLookupLoading] = useState(false);
  const [accountMatches, setAccountMatches] = useState<CrmAccountSuggestion[]>([]);
  const [accountLookupLoading, setAccountLookupLoading] = useState(false);
  const [helpdeskCategories, setHelpdeskCategories] = useState<HelpDeskCategory[]>([]);
  const [selectedCategory, setSelectedCategory] = useState("");
  const [activeCommentTicketId, setActiveCommentTicketId] = useState<number | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [rowBusyId, setRowBusyId] = useState<number | null>(null);
  const [selectedTicket, setSelectedTicket] = useState<TicketRecord | null>(null);
  const [ticketComments, setTicketComments] = useState<TicketComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [detailComment, setDetailComment] = useState("");
  const canSeeAllTickets = hasAccess("Tickets:All");

  const selectedType = useMemo(
    () => REQUEST_TYPES.find((t) => t.key === form.requestType) || REQUEST_TYPES[0],
    [form.requestType]
  );

  const managerId = useMemo(() => {
    try {
      return resolveCrmManagerIdFromSession();
    } catch {
      return null;
    }
  }, []);

  const currentUserId = useMemo(() => {
    const id = Number(currentUser?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  }, [currentUser?.id]);

  const loadTickets = async () => {
    if (!managerId && !currentUserId) return;
    setIsLoading(true);
    try {
      const rows = canSeeAllTickets
        ? await listCrmTicketsAll()
        : await listCrmTicketsForActor({ managerId, userId: currentUserId });
      setRecords(rows);
    } catch (e: any) {
      setError(e?.message || "Failed to load tickets.");
    } finally {
      setIsLoading(false);
    }
  };

  const openTicketHistory = async (ticket: TicketRecord) => {
    setSelectedTicket(ticket);
    setCommentsLoading(true);
    setTicketComments([]);
    setDetailComment("");
    try {
      const rows = await listCrmTicketComments(ticket.id);
      setTicketComments(rows);
    } catch (e: any) {
      setError(e?.message || "Failed to load ticket comments.");
    } finally {
      setCommentsLoading(false);
    }
  };

  useEffect(() => {
    void loadTickets();
  }, [managerId, currentUserId, canSeeAllTickets]);

  useEffect(() => {
    if (!managerId && !currentUserId) return;
    const iv = setInterval(() => {
      void loadTickets();
    }, 30000);
    return () => clearInterval(iv);
  }, [managerId, currentUserId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rows = await listHelpDeskCategories();
        if (alive) {
          const finalRows = rows.length ? rows : FALLBACK_CATEGORIES;
          setHelpdeskCategories(finalRows);
          setSelectedCategory((prev) => prev || finalRows[0]?.value || "");
        }
      } catch (e: any) {
        if (alive) {
          setHelpdeskCategories(FALLBACK_CATEGORIES);
          setSelectedCategory((prev) => prev || FALLBACK_CATEGORIES[0].value);
          setError(e?.message || "Failed to load categories. Using fallback list.");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setForm((prev) => {
      if (prev.requestType !== selectedType.key) return prev;
      if (prev.priority === selectedType.defaultPriority) return prev;
      return { ...prev, priority: selectedType.defaultPriority };
    });
  }, [selectedType.key, selectedType.defaultPriority]);

  useEffect(() => {
    const input = form.clientId.trim();
    if (!input) {
      setClientMatches([]);
      return;
    }
    const timer = setTimeout(async () => {
      setClientLookupLoading(true);
      try {
        const rows = await searchClientsByClientId(input);
        setClientMatches(rows);
      } finally {
        setClientLookupLoading(false);
      }
    }, 280);
    return () => clearTimeout(timer);
  }, [form.clientId]);

  useEffect(() => {
    const input = form.ibId.trim();
    if (!input) {
      setIbMatches([]);
      return;
    }
    const timer = setTimeout(async () => {
      setIbLookupLoading(true);
      try {
        const rows = await searchClientsByIbId(input);
        setIbMatches(rows);
      } finally {
        setIbLookupLoading(false);
      }
    }, 280);
    return () => clearTimeout(timer);
  }, [form.ibId]);

  useEffect(() => {
    const input = form.accountNumber.trim();
    if (!input) {
      setAccountMatches([]);
      return;
    }
    const timer = setTimeout(async () => {
      setAccountLookupLoading(true);
      try {
        const rows = await searchAccountsByLogin(input);
        setAccountMatches(rows);
      } finally {
        setAccountLookupLoading(false);
      }
    }, 280);
    return () => clearTimeout(timer);
  }, [form.accountNumber]);

  useEffect(() => {
    if (!selectedTicket) return;
    const iv = setInterval(async () => {
      try {
        const [latestTickets, latestComments] = await Promise.all([
          canSeeAllTickets ? listCrmTicketsAll() : listCrmTicketsForActor({ managerId, userId: currentUserId }),
          listCrmTicketComments(selectedTicket.id),
        ]);
        if (managerId || currentUserId) {
          setRecords(latestTickets);
          const refreshed = latestTickets.find((t) => t.id === selectedTicket.id);
          if (refreshed) setSelectedTicket(refreshed);
        }
        setTicketComments(latestComments);
      } catch {
        // silent polling failure
      }
    }, 20000);
    return () => clearInterval(iv);
  }, [selectedTicket, managerId, currentUserId, canSeeAllTickets]);

  useEffect(() => {
    if (!helpdeskCategories.length) return;
    const requestedCategory = selectedType.category.trim().toLowerCase();
    const matched =
      helpdeskCategories.find((c) => c.value.trim().toLowerCase() === requestedCategory) ||
      helpdeskCategories.find((c) => c.label.trim().toLowerCase() === requestedCategory) ||
      helpdeskCategories.find((c) => c.value.trim().toLowerCase().includes(requestedCategory)) ||
      helpdeskCategories.find((c) => c.label.trim().toLowerCase().includes(requestedCategory)) ||
      helpdeskCategories[0];
    if (matched) setSelectedCategory(matched.value);
  }, [selectedType.category, helpdeskCategories]);

  const renderMatchDropdown = (
    rows: CrmClientSuggestion[],
    loading: boolean,
    onPick: (row: CrmClientSuggestion) => void
  ) => {
    if (!loading && rows.length === 0) return null;
    return (
      <div className="mt-1 max-h-44 overflow-auto rounded-lg border border-border/60 bg-popover">
        {loading ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">Searching...</div>
        ) : (
          rows.map((row) => (
            <button
              key={`${row.id}-${row.cid}`}
              type="button"
              onClick={() => onPick(row)}
              className="flex w-full items-start justify-between gap-2 border-b border-border/40 px-3 py-2 text-left text-xs hover:bg-secondary/40 last:border-b-0"
            >
              <span className="font-mono text-foreground">ID {row.id}</span>
              <span className="truncate text-muted-foreground">
                {`${row.firstName} ${row.lastName}`.trim() || row.email || "-"}
              </span>
            </button>
          ))
        )}
      </div>
    );
  };

  const renderAccountDropdown = (
    rows: CrmAccountSuggestion[],
    loading: boolean,
    onPick: (row: CrmAccountSuggestion) => void
  ) => {
    if (!loading && rows.length === 0) return null;
    return (
      <div className="mt-1 max-h-44 overflow-auto rounded-lg border border-border/60 bg-popover">
        {loading ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">Searching accounts...</div>
        ) : (
          rows.map((row) => (
            <button
              key={`${row.serverId ?? "s"}-${row.login}-${row.userId ?? "u"}`}
              type="button"
              onClick={() => onPick(row)}
              className="flex w-full items-start justify-between gap-2 border-b border-border/40 px-3 py-2 text-left text-xs hover:bg-secondary/40 last:border-b-0"
            >
              <span className="font-mono text-foreground">{row.login}</span>
              <span className="truncate text-muted-foreground">
                U:{row.userId ?? "-"} {row.groupName ? `| ${row.groupName}` : ""}
              </span>
            </button>
          ))
        )}
      </div>
    );
  };

  const validate = () => {
    const type = form.requestType;
    if (type === "create-account-type") {
      if (!form.accountTypeName.trim() || !form.accountTypePath.trim() || !form.leverage.trim()) {
        return "Create Account Type needs Name, Path and Leverage.";
      }
      return null;
    }
    if (type === "change-leverage") {
      if (!form.accountNumber.trim() || !form.newLeverage.trim()) {
        return "Change Leverage needs Account Number and New Leverage.";
      }
      return null;
    }
    if (type === "change-account-type") {
      if (!form.accountNumber.trim() || !form.newAccountType.trim()) {
        return "Change Account Type needs Account Number and New Account Type.";
      }
      return null;
    }
    if (type === "change-ib") {
      if (!form.clientId.trim() || !form.newIbId.trim()) {
        return "Change IB needs Client ID and New IB ID.";
      }
      return null;
    }
    if (type === "create-new-ib-structure" || type === "ib-rebate") {
      if (!form.clientId.trim()) {
        return `${selectedType.label} needs Client ID.`;
      }
      return null;
    }
    if (type === "other" && !form.note.trim()) {
      return "Please add details for Other request.";
    }
    if (!selectedCategory.trim()) {
      return "Please select a valid CRM category.";
    }
    return null;
  };

  const resolveTicketUser = async (): Promise<number> => {
    if (form.requestType === "create-account-type") return 13358;
    const clientId = Number(form.clientId.trim());
    if (Number.isFinite(clientId) && clientId > 0) return clientId;
    const account = form.accountNumber.trim();
    if (account) {
      const resolved = await resolveUserIdByAccountNumber(account);
      if (resolved) return resolved;
      throw new Error(`No CRM client found for account number ${account}.`);
    }
    throw new Error("Unable to resolve CRM user. Provide Client ID or Account Number.");
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    if (!managerId) {
      setError("Logged-in user is not mapped to a CRM manager.");
      return;
    }

    setIsSubmitting(true);
    try {
      const user = await resolveTicketUser();
      const attachments = await Promise.all(
        files.map(async (f) => ({
          name: f.name,
          file: await toBase64(f),
        }))
      );
      const title = inferTitle(form, selectedType.label);
      const text = buildTicketText(form, selectedType.label);
      const matchedCategory =
        helpdeskCategories.find((c) => c.value === selectedCategory)?.value ||
        selectedCategory;

      const created = await createCrmTicket({
        user,
        manager: managerId,
        status: "pending support",
        title,
        text,
        category: matchedCategory,
        attachments,
      });

      setRecords((prev) => [created, ...prev.filter((r) => r.id !== created.id)]);
      setSuccess(`Ticket #${created.id} created and sent to CRM.`);
      setFiles([]);
      setForm((prev) => ({
        ...INITIAL_FORM,
        requestType: prev.requestType,
        priority: REQUEST_TYPES.find((t) => t.key === prev.requestType)?.defaultPriority || 0,
      }));
    } catch (err: any) {
      setError(err?.message || "Failed to create ticket.");
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
                <Ticket className="h-3.5 w-3.5" />
                Help Desk
              </div>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">Tickets</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Submit structured requests to CRM and track records in one place.
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-border/50 bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
              <UserRound className="h-4 w-4 text-primary" />
              <span>{currentUser?.email || "Unknown user"}</span>
              <span className="text-foreground">{managerLabel(managerId)}</span>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-5 xl:grid-cols-5">
          <div className="xl:col-span-1">
            <form onSubmit={onSubmit} className="rounded-2xl border border-border/50 bg-card p-4 shadow-sm sm:p-5">
              <div className="mb-4">
                <h2 className="text-base font-semibold text-foreground">Create Request</h2>
                <p className="mt-1 text-xs text-muted-foreground">Template: {selectedType.templateHint}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Scope: {canSeeAllTickets ? "All tickets access" : "Own/assigned tickets only"}
                </p>
              </div>

              <div className="space-y-3">
                <label className="block text-xs font-medium text-muted-foreground">
                  Request Type
                  <select
                    value={form.requestType}
                    onChange={(e) => setForm((prev) => ({ ...prev, requestType: e.target.value as RequestTypeKey }))}
                    className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                  >
                    {REQUEST_TYPES.map((type) => (
                      <option key={type.key} value={type.key}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block text-xs font-medium text-muted-foreground">
                  Title (optional)
                  <input
                    value={form.title}
                    onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                    placeholder={`Auto: ${selectedType.label}`}
                    className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                  />
                </label>

                <label className="block text-xs font-medium text-muted-foreground">
                  Priority
                  <input
                    type="number"
                    value={form.priority}
                    onChange={(e) => setForm((prev) => ({ ...prev, priority: Number(e.target.value || 0) }))}
                    className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                  />
                </label>

                {(form.requestType === "ib-rebate" ||
                  form.requestType === "create-new-ib-structure" ||
                  form.requestType === "change-ib" ||
                  form.requestType === "other") && (
                  <label className="block text-xs font-medium text-muted-foreground">
                    Client ID
                    <input
                      value={form.clientId}
                      onChange={(e) => setForm((prev) => ({ ...prev, clientId: e.target.value }))}
                      placeholder="e.g. 14583"
                      className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                    />
                    {renderMatchDropdown(clientMatches, clientLookupLoading, (row) => {
                      setForm((prev) => ({ ...prev, clientId: String(row.id) }));
                      setClientMatches([]);
                    })}
                  </label>
                )}

                {(form.requestType === "change-leverage" ||
                  form.requestType === "change-account-type" ||
                  form.requestType === "other") && (
                  <label className="block text-xs font-medium text-muted-foreground">
                    Account Number
                    <input
                      value={form.accountNumber}
                      onChange={(e) => setForm((prev) => ({ ...prev, accountNumber: e.target.value }))}
                      placeholder="MT5 Login / Account Number"
                      className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                    />
                    {renderAccountDropdown(accountMatches, accountLookupLoading, (row) => {
                      setForm((prev) => ({
                        ...prev,
                        accountNumber: row.login,
                        clientId: row.userId ? String(row.userId) : prev.clientId,
                      }));
                      setAccountMatches([]);
                    })}
                  </label>
                )}

                {form.requestType === "create-account-type" && (
                  <>
                    <label className="block text-xs font-medium text-muted-foreground">
                      Name
                      <input
                        value={form.accountTypeName}
                        onChange={(e) => setForm((prev) => ({ ...prev, accountTypeName: e.target.value }))}
                        placeholder="Account Type Name"
                        className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="block text-xs font-medium text-muted-foreground">
                      Path
                      <input
                        value={form.accountTypePath}
                        onChange={(e) => setForm((prev) => ({ ...prev, accountTypePath: e.target.value }))}
                        placeholder="Group path"
                        className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="block text-xs font-medium text-muted-foreground">
                      Leverage
                      <input
                        value={form.leverage}
                        onChange={(e) => setForm((prev) => ({ ...prev, leverage: e.target.value }))}
                        placeholder="e.g. 1:200"
                        className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                      />
                    </label>
                  </>
                )}

                {(form.requestType === "ib-rebate" || form.requestType === "create-new-ib-structure") && (
                  <>
                    <label className="block text-xs font-medium text-muted-foreground">
                      IB ID
                      <input
                        value={form.ibId}
                        onChange={(e) => setForm((prev) => ({ ...prev, ibId: e.target.value }))}
                        placeholder="IB reference ID"
                        className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                      />
                      {renderMatchDropdown(ibMatches, ibLookupLoading, (row) => {
                        setForm((prev) => ({ ...prev, clientId: String(row.id), ibId: prev.ibId || String(row.cid || row.id) }));
                        setIbMatches([]);
                      })}
                    </label>
                    <label className="block text-xs font-medium text-muted-foreground">
                      Commission Structure
                      <input
                        value={form.commissionStructure}
                        onChange={(e) => setForm((prev) => ({ ...prev, commissionStructure: e.target.value }))}
                        placeholder="Structure details"
                        className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="block text-xs font-medium text-muted-foreground">
                      Commission on specific symbols
                      <input
                        value={form.commissionSymbols}
                        onChange={(e) => setForm((prev) => ({ ...prev, commissionSymbols: e.target.value }))}
                        placeholder="Optional symbol-based commissions"
                        className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                      />
                    </label>
                  </>
                )}

                {form.requestType === "change-ib" && (
                  <label className="block text-xs font-medium text-muted-foreground">
                    New IB ID
                    <input
                      value={form.newIbId}
                      onChange={(e) => setForm((prev) => ({ ...prev, newIbId: e.target.value }))}
                      placeholder="New IB ID"
                      className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                    />
                  </label>
                )}

                {form.requestType === "change-leverage" && (
                  <label className="block text-xs font-medium text-muted-foreground">
                    New Leverage
                    <input
                      value={form.newLeverage}
                      onChange={(e) => setForm((prev) => ({ ...prev, newLeverage: e.target.value }))}
                      placeholder="e.g. 1:100"
                      className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                    />
                  </label>
                )}

                {form.requestType === "change-account-type" && (
                  <label className="block text-xs font-medium text-muted-foreground">
                    New Account Type
                    <input
                      value={form.newAccountType}
                      onChange={(e) => setForm((prev) => ({ ...prev, newAccountType: e.target.value }))}
                      placeholder="Path or group name"
                      className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                    />
                  </label>
                )}

                <label className="block text-xs font-medium text-muted-foreground">
                  Details
                  <textarea
                    value={form.note}
                    onChange={(e) => setForm((prev) => ({ ...prev, note: e.target.value }))}
                    rows={4}
                    placeholder="Any additional details"
                    className="mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                  />
                </label>

                <label className="block text-xs font-medium text-muted-foreground">
                  Attachments
                  <div className="mt-1 rounded-lg border border-dashed border-border/70 bg-background p-3">
                    <input
                      type="file"
                      multiple
                      onChange={(e) => setFiles(Array.from(e.target.files || []))}
                      className="w-full text-xs"
                    />
                    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {files.length === 0 ? (
                        <div>No files selected.</div>
                      ) : (
                        files.map((f) => (
                          <div key={`${f.name}-${f.size}`} className="flex items-center gap-1">
                            <Paperclip className="h-3.5 w-3.5" />
                            <span>{f.name}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </label>

                {error && <div className="rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
                {success && <div className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">{success}</div>}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-primary to-cyan-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {isSubmitting ? "Submitting..." : "Submit Ticket"}
                </button>
              </div>
            </form>
          </div>

          <div className="xl:col-span-4">
            <div className="rounded-2xl border border-border/50 bg-card p-4 shadow-sm sm:p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold text-foreground">Recent Tickets</h2>
                <button
                  type="button"
                  onClick={() => void loadTickets()}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-70"
                >
                  <RefreshCcw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
                  Refresh
                </button>
              </div>

              <div className="overflow-hidden rounded-xl border border-border/50">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left">ID</th>
                        <th className="px-3 py-2 text-left">Title</th>
                        <th className="px-3 py-2 text-left">Status</th>
                        <th className="px-3 py-2 text-left">Category</th>
                        <th className="px-3 py-2 text-left">Created By</th>
                        <th className="px-3 py-2 text-left">Assigned</th>
                        <th className="px-3 py-2 text-left">Created</th>
                        <th className="px-3 py-2 text-left">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.length === 0 && !isLoading ? (
                        <tr>
                          <td colSpan={8} className="px-3 py-5 text-center text-xs text-muted-foreground">
                            No ticket records found.
                          </td>
                        </tr>
                      ) : (
                        records.map((row) => (
                          <tr key={row.id} className="border-t border-border/40">
                            <td className="px-3 py-2 font-mono text-xs">{row.id}</td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={() => void openTicketHistory(row)}
                                className="text-left font-medium text-primary underline-offset-2 hover:underline"
                              >
                                {row.title}
                              </button>
                              <div className="line-clamp-2 text-xs text-muted-foreground">{row.text || "-"}</div>
                            </td>
                            <td className="px-3 py-2">
                              <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-xs text-primary">
                                {row.status}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-xs">{row.category}</td>
                            <td className="px-3 py-2 font-mono text-xs">{row.user ?? "-"}</td>
                            <td className="px-3 py-2 text-xs">{managerLabel(row.manager)}</td>
                            <td className="px-3 py-2 text-xs">{toDubaiDisplayDate(row.createdAt)}</td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <button
                                  type="button"
                                  hidden={!canSeeAllTickets}
                                  disabled={rowBusyId === row.id}
                                  onClick={async () => {
                                    setError(null);
                                    setSuccess(null);
                                    setRowBusyId(row.id);
                                    try {
                                      const updated = await approveCrmTicket(row.id);
                                      setRecords((prev) => prev.map((it) => (it.id === row.id ? { ...it, ...updated } : it)));
                                      setSuccess(`Ticket #${row.id} moved to pending client.`);
                                    } catch (e: any) {
                                      setError(e?.message || "Approve failed.");
                                    } finally {
                                      setRowBusyId(null);
                                    }
                                  }}
                                  className="rounded border border-emerald-500/35 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-700 disabled:opacity-50 dark:text-emerald-300"
                                >
                                  Approve
                                </button>
                                <button
                                  type="button"
                                  hidden={!canSeeAllTickets}
                                  disabled={rowBusyId === row.id}
                                  onClick={async () => {
                                    setError(null);
                                    setSuccess(null);
                                    setRowBusyId(row.id);
                                    try {
                                      const updated = await closeCrmTicket(row.id);
                                      setRecords((prev) => prev.map((it) => (it.id === row.id ? { ...it, ...updated } : it)));
                                      setSuccess(`Ticket #${row.id} closed.`);
                                    } catch (e: any) {
                                      setError(e?.message || "Close failed.");
                                    } finally {
                                      setRowBusyId(null);
                                    }
                                  }}
                                  className="rounded border border-rose-500/35 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-700 disabled:opacity-50 dark:text-rose-300"
                                >
                                  Close
                                </button>
                              </div>
                              {activeCommentTicketId === row.id && (
                                <div className="mt-2 flex items-center gap-1.5">
                                  <input
                                    value={commentDraft}
                                    onChange={(e) => setCommentDraft(e.target.value)}
                                    placeholder="Type comment..."
                                    className="w-44 rounded border border-border/60 bg-background px-2 py-1 text-xs"
                                  />
                                  <button
                                    type="button"
                                    disabled={!commentDraft.trim() || rowBusyId === row.id}
                                    onClick={async () => {
                                      const text = commentDraft.trim();
                                      if (!text) return;
                                      setError(null);
                                      setSuccess(null);
                                      setRowBusyId(row.id);
                                      try {
                                        await addCrmTicketComment(row.id, text, {
                                          manager: managerId,
                                          user: row.user,
                                        });
                                        setSuccess(`Comment added to ticket #${row.id}.`);
                                        if (selectedTicket?.id === row.id) {
                                          const rows = await listCrmTicketComments(row.id);
                                          setTicketComments(rows);
                                        }
                                        setActiveCommentTicketId(null);
                                        setCommentDraft("");
                                      } catch (e: any) {
                                        setError(e?.message || "Add comment failed.");
                                      } finally {
                                        setRowBusyId(null);
                                      }
                                    }}
                                    className="rounded border border-border/60 px-2 py-1 text-[11px] text-foreground disabled:opacity-50"
                                  >
                                    Send
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-border/50 bg-secondary/20 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-semibold text-foreground">
                    {selectedTicket ? `Ticket #${selectedTicket.id} History` : "Ticket History"}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {selectedTicket ? (
                      <button
                        type="button"
                        onClick={() => void openTicketHistory(selectedTicket)}
                        className="rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        Refresh
                      </button>
                    ) : null}
                    {selectedTicket ? (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedTicket(null);
                          setTicketComments([]);
                          setDetailComment("");
                        }}
                        className="rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        Hide
                      </button>
                    ) : null}
                  </div>
                </div>
                {!selectedTicket ? (
                  <div className="text-xs text-muted-foreground">Click any ticket title to view full conversation timeline.</div>
                ) : commentsLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading history...
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                      <div className="rounded-lg border border-border/50 bg-card p-3">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Status</div>
                        <div className="mt-1 text-sm font-medium text-primary">{selectedTicket.status}</div>
                      </div>
                      <div className="rounded-lg border border-border/50 bg-card p-3">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Category</div>
                        <div className="mt-1 text-sm text-foreground">{selectedTicket.category}</div>
                      </div>
                      <div className="rounded-lg border border-border/50 bg-card p-3">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Client</div>
                        <div className="mt-1 font-mono text-sm text-foreground">{selectedTicket.user ?? "-"}</div>
                      </div>
                      <div className="rounded-lg border border-border/50 bg-card p-3">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Manager</div>
                        <div className="mt-1 text-sm text-foreground">{managerLabel(selectedTicket.manager)}</div>
                      </div>
                    </div>

                    <div className="rounded-lg border border-primary/25 bg-primary/10 p-3">
                      <div className="mb-1 flex items-center justify-between text-[11px]">
                        <span className="font-semibold text-primary">Initial Request</span>
                        <span className="text-muted-foreground">{toDubaiDisplayDate(selectedTicket.createdAt)}</span>
                      </div>
                      <div className="text-xs font-medium text-foreground">{selectedTicket.title}</div>
                      <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{selectedTicket.text || "-"}</div>
                    </div>

                    <div className="space-y-2">
                      {ticketComments.length === 0 ? (
                        <div className="text-xs text-muted-foreground">No comments yet.</div>
                      ) : (
                        ticketComments.map((comment) => {
                          const from = comment.manager ? managerLabel(comment.manager) : comment.user ? `Client ${comment.user}` : "User";
                          const isManager = Boolean(comment.manager);
                          return (
                            <div
                              key={comment.id}
                              className={`rounded-lg border p-3 ${isManager ? "border-cyan-500/30 bg-cyan-500/10" : "border-emerald-500/30 bg-emerald-500/10"}`}
                            >
                              <div className="mb-1 flex items-center justify-between text-[11px]">
                                <span className={`font-semibold ${isManager ? "text-cyan-700 dark:text-cyan-300" : "text-emerald-700 dark:text-emerald-300"}`}>
                                  {from}
                                </span>
                                <span className="text-muted-foreground">{toDubaiDisplayDate(comment.createdAt)}</span>
                              </div>
                              <div className="whitespace-pre-wrap text-xs text-foreground">{comment.text || "-"}</div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    <div className="rounded-lg border border-border/50 bg-background p-3">
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add New Comment</div>
                      <textarea
                        value={detailComment}
                        onChange={(e) => setDetailComment(e.target.value)}
                        rows={4}
                        placeholder="Write your response here..."
                        className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                      />
                      <div className="mt-2 flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setDetailComment("")}
                          className="rounded border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                        >
                          Clear
                        </button>
                        <button
                          type="button"
                          disabled={!detailComment.trim() || !selectedTicket || rowBusyId === selectedTicket?.id}
                          onClick={async () => {
                            const text = detailComment.trim();
                            if (!text || !selectedTicket) return;
                            setRowBusyId(selectedTicket.id);
                            setError(null);
                            setSuccess(null);
                            try {
                              await addCrmTicketComment(selectedTicket.id, text, {
                                manager: managerId,
                                user: selectedTicket.user,
                              });
                              const rows = await listCrmTicketComments(selectedTicket.id);
                              setTicketComments(rows);
                              setDetailComment("");
                              setSuccess(`Comment added to ticket #${selectedTicket.id}.`);
                            } catch (e: any) {
                              setError(e?.message || "Add comment failed.");
                            } finally {
                              setRowBusyId(null);
                            }
                          }}
                          className="rounded bg-gradient-to-r from-primary to-cyan-500 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                        >
                          Post Comment
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
