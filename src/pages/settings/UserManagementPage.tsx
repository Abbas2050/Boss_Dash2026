import React, { useEffect, useMemo, useState } from "react";
import { Shield, UserPlus, Search, Trash2, Pencil, CheckCircle2, History, Filter } from "lucide-react";
import { AuthAuditEvent, AuthUser, deleteUser, fetchAuthAuditEvents, getCurrentUser, getUsers, refreshUsers, upsertUser } from "@/lib/auth";
import { ADMIN_ACCESS_KEYS, DASHBOARD_ACCESS_KEYS, DEALING_TAB_KEYS, DEPARTMENT_KEYS, NOTIFICATION_KEYS, USER_ROLE_TEMPLATES } from "@/lib/permissions";

const dashboardKeys = DASHBOARD_ACCESS_KEYS;
const departmentKeys = DEPARTMENT_KEYS;
const dealingTabKeys = DEALING_TAB_KEYS;
const notificationKeys = NOTIFICATION_KEYS;
const adminKeys = ADMIN_ACCESS_KEYS;

type UserForm = {
  name: string;
  email: string;
  role: "Super Admin" | "Manager" | "Analyst" | "Support";
  status: "active" | "suspended";
  access: string[];
  password: string;
};

const blankForm: UserForm = {
  name: "",
  email: "",
  role: "Analyst",
  status: "active",
  access: [],
  password: "",
};

export const UserManagementPage: React.FC = () => {
  const [users, setUsers] = useState<AuthUser[]>(() => getUsers());
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<UserForm>(blankForm);
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [permissionQuery, setPermissionQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "suspended">("all");
  const [sortBy, setSortBy] = useState<"name" | "role" | "created">("name");
  const [page, setPage] = useState(1);
  const pageSize = 8;
  const [auditEvents, setAuditEvents] = useState<AuthAuditEvent[]>([]);
  const currentUser = getCurrentUser();

  const reload = async () => {
    const list = await refreshUsers();
    setUsers(list);
  };

  useEffect(() => {
    reload().catch((err) => setError(err?.message || "Failed to load users"));
    fetchAuthAuditEvents(80)
      .then(setAuditEvents)
      .catch(() => undefined);
  }, []);

  const visibleUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = users.filter((u) => {
      const qPass = !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || u.role.toLowerCase().includes(q);
      const statusPass = statusFilter === "all" ? true : u.status === statusFilter;
      return qPass && statusPass;
    });

    const sorted = [...filtered].sort((a, b) => {
      if (sortBy === "role") return a.role.localeCompare(b.role);
      if (sortBy === "created") return Number(b.id) - Number(a.id);
      return a.name.localeCompare(b.name);
    });

    return sorted;
  }, [users, query, statusFilter, sortBy]);

  const pagedUsers = useMemo(() => {
    const start = (page - 1) * pageSize;
    return visibleUsers.slice(start, start + pageSize);
  }, [visibleUsers, page]);

  const totalPages = Math.max(1, Math.ceil(visibleUsers.length / pageSize));

  useEffect(() => {
    setPage((prev) => Math.min(prev, totalPages));
  }, [totalPages]);

  const stats = useMemo(
    () => ({
      total: users.length,
      active: users.filter((u) => u.status === "active").length,
      suspended: users.filter((u) => u.status === "suspended").length,
      privileged: users.filter((u) => u.role === "Super Admin" || u.role === "Manager").length,
    }),
    [users]
  );

  const resetForm = () => setForm(blankForm);

  const submit = async () => {
    setError("");
    if (!form.name.trim() || !form.email.trim()) {
      setError("Name and email are required.");
      return;
    }
    if (!editId && !form.password.trim()) {
      setError("Password is required for new user.");
      return;
    }

    const exists = users.find((u) => u.email.toLowerCase() === form.email.toLowerCase() && u.id !== editId);
    if (exists) {
      setError("A user with this email already exists.");
      return;
    }

    try {
      if (editId) {
        const old = users.find((u) => u.id === editId);
        if (!old) return;
        await upsertUser({
          ...old,
          ...form,
          password: form.password.trim() ? form.password : undefined,
        });
        setEditId(null);
      } else {
        await upsertUser({
          ...form,
        });
      }
      resetForm();
      await reload();
      setPage(1);
      fetchAuthAuditEvents(80).then(setAuditEvents).catch(() => undefined);
    } catch (err: any) {
      setError(err?.message || "Unable to save user.");
    }
  };

  const remove = async (id: string) => {
    if (currentUser?.id === id) {
      setError("You cannot delete your currently logged-in account.");
      return;
    }

    const user = users.find((u) => u.id === id);
    const marker = String(user?.email || id);
    const typed = window.prompt(`Type ${marker} to confirm deletion.`);
    if (typed !== marker) {
      setError("Delete confirmation did not match. User not removed.");
      return;
    }

    try {
      await deleteUser(id);
      await reload();
      fetchAuthAuditEvents(80).then(setAuditEvents).catch(() => undefined);
    } catch (err: any) {
      setError(err?.message || "Unable to delete user.");
    }
  };

  const toggleAccess = (page: string) => {
    setForm((prev) => ({
      ...prev,
      access: prev.access.includes(page) ? prev.access.filter((p) => p !== page) : [...prev.access, page],
    }));
  };

  const enableAllDealingTabs = () => {
    setForm((prev) => {
      const next = new Set(prev.access);
      next.add("Dealing");
      dealingTabKeys.forEach((item) => next.add(item.key));
      return { ...prev, access: Array.from(next) };
    });
  };

  const clearAllDealingTabs = () => {
    setForm((prev) => ({
      ...prev,
      access: prev.access.filter((key) => !key.startsWith("Dealing:")),
    }));
  };

  const startEdit = (u: AuthUser) => {
    setEditId(u.id);
    setError("");
    setForm({
      name: u.name,
      email: u.email,
      role: u.role as UserForm["role"],
      status: u.status,
      access: [...u.access],
      password: "",
    });
  };

  const applyRoleTemplate = (role: UserForm["role"]) => {
    setForm((prev) => ({
      ...prev,
      role,
      access: Array.from(new Set(USER_ROLE_TEMPLATES[role] || [])),
    }));
  };

  const permissionVisible = (label: string, key: string) => {
    const q = permissionQuery.trim().toLowerCase();
    if (!q) return true;
    return label.toLowerCase().includes(q) || key.toLowerCase().includes(q);
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="p-6 md:p-8 space-y-5">
        <section className="rounded-2xl border border-border/40 bg-gradient-to-br from-card/90 to-card/60 p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-primary/20 text-primary border border-primary/30">
                <Shield className="h-5 w-5" />
              </span>
              <div>
                <h1 className="text-2xl font-semibold text-foreground">User Management</h1>
                <p className="text-sm text-muted-foreground">
                  Persisted users with login credentials and section-level access control.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 min-w-[260px]">
              <div className="rounded-lg border border-border/40 bg-background/60 p-2 text-center">
                <div className="text-xs text-muted-foreground">Total</div>
                <div className="font-mono text-lg">{stats.total}</div>
              </div>
              <div className="rounded-lg border border-success/30 bg-success/10 p-2 text-center">
                <div className="text-xs text-success">Active</div>
                <div className="font-mono text-lg">{stats.active}</div>
              </div>
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-center">
                <div className="text-xs text-destructive">Suspended</div>
                <div className="font-mono text-lg">{stats.suspended}</div>
              </div>
              <div className="rounded-lg border border-primary/30 bg-primary/10 p-2 text-center">
                <div className="text-xs text-primary">Privileged</div>
                <div className="font-mono text-lg">{stats.privileged}</div>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-border/40 bg-card/70 p-5">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h2 className="text-lg font-semibold text-foreground">
              {editId ? "Edit User" : "Create User"}
            </h2>
            {editId && (
              <button
                onClick={() => {
                  setEditId(null);
                  resetForm();
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Cancel edit
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <input
              value={form.name}
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
              placeholder="Full name"
              className="rounded-lg bg-background/70 border border-border px-3 py-2 text-sm"
            />
            <input
              value={form.email}
              onChange={(e) => setForm((s) => ({ ...s, email: e.target.value }))}
              placeholder="Email"
              className="rounded-lg bg-background/70 border border-border px-3 py-2 text-sm"
            />
            <input
              value={form.password}
              onChange={(e) => setForm((s) => ({ ...s, password: e.target.value }))}
              placeholder={editId ? "New password (optional)" : "Password"}
              type="password"
              className="rounded-lg bg-background/70 border border-border px-3 py-2 text-sm"
            />
            <select
              value={form.role}
              onChange={(e) => setForm((s) => ({ ...s, role: e.target.value as UserForm["role"] }))}
              className="rounded-lg bg-background/70 border border-border px-3 py-2 text-sm"
            >
              <option>Super Admin</option>
              <option>Manager</option>
              <option>Analyst</option>
              <option>Support</option>
            </select>
            <select
              value={form.status}
              onChange={(e) => setForm((s) => ({ ...s, status: e.target.value as UserForm["status"] }))}
              className="rounded-lg bg-background/70 border border-border px-3 py-2 text-sm"
            >
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
          </div>

          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Role Templates</span>
              {(Object.keys(USER_ROLE_TEMPLATES) as Array<UserForm["role"]>).map((roleName) => (
                <button
                  key={roleName}
                  type="button"
                  onClick={() => applyRoleTemplate(roleName)}
                  className={`rounded-md border px-2 py-1 text-xs ${
                    form.role === roleName ? "border-primary/40 bg-primary/15 text-primary" : "border-border/50 bg-secondary/30 text-muted-foreground"
                  }`}
                >
                  {roleName}
                </button>
              ))}
            </div>

            <label className="relative block">
              <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
              <input
                value={permissionQuery}
                onChange={(e) => setPermissionQuery(e.target.value)}
                placeholder="Filter permission chips"
                className="w-full rounded-lg bg-background/70 border border-border pl-8 pr-3 py-2 text-sm"
              />
            </label>
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dashboard Access</div>
              <div className="flex flex-wrap gap-2">
                {dashboardKeys.filter((item) => permissionVisible(item.label, item.key)).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => toggleAccess(item.key)}
                    className={`rounded-md px-2 py-1 text-xs border ${
                      form.access.includes(item.key)
                        ? "border-primary/40 bg-primary/15 text-primary"
                        : "border-border/50 bg-secondary/30 text-muted-foreground"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Department Access</div>
              <div className="flex flex-wrap gap-2">
                {departmentKeys.filter((item) => permissionVisible(item.label, item.key)).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => toggleAccess(item.key)}
                    className={`rounded-md px-2 py-1 text-xs border ${
                      form.access.includes(item.key)
                        ? "border-primary/40 bg-primary/15 text-primary"
                        : "border-border/50 bg-secondary/30 text-muted-foreground"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Admin Access</div>
              <div className="flex flex-wrap gap-2">
                {adminKeys.filter((item) => permissionVisible(item.label, item.key)).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => toggleAccess(item.key)}
                    className={`rounded-md px-2 py-1 text-xs border ${
                      form.access.includes(item.key)
                        ? "border-primary/40 bg-primary/15 text-primary"
                        : "border-border/50 bg-secondary/30 text-muted-foreground"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dealing Tab Access</div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={enableAllDealingTabs}
                    className="rounded-md border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-700"
                  >
                    Allow All Tabs
                  </button>
                  <button
                    type="button"
                    onClick={clearAllDealingTabs}
                    className="rounded-md border border-slate-400/40 bg-slate-500/10 px-2 py-1 text-xs text-slate-700"
                  >
                    Clear Tabs
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {dealingTabKeys.filter((item) => permissionVisible(item.label, item.key)).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => toggleAccess(item.key)}
                    className={`rounded-md px-2 py-1 text-xs border ${
                      form.access.includes(item.key)
                        ? "border-primary/40 bg-primary/15 text-primary"
                        : "border-border/50 bg-secondary/30 text-muted-foreground"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notification Access</div>
              <div className="flex flex-wrap gap-2">
                {notificationKeys.filter((item) => permissionVisible(item.label, item.key)).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => toggleAccess(item.key)}
                    className={`rounded-md px-2 py-1 text-xs border ${
                      form.access.includes(item.key)
                        ? "border-primary/40 bg-primary/15 text-primary"
                        : "border-border/50 bg-secondary/30 text-muted-foreground"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {error && <div className="mt-3 text-sm text-destructive">{error}</div>}

          <div className="mt-4">
            <button
              onClick={submit}
              className="inline-flex items-center gap-2 rounded-lg px-4 py-2 bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
            >
              {editId ? <CheckCircle2 className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}
              {editId ? "Update User" : "Add User"}
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-border/40 bg-card/70 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <h2 className="text-lg font-semibold text-foreground">Users</h2>
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative">
                <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Search name, email, role"
                  className="rounded-lg bg-background/70 border border-border pl-8 pr-3 py-2 text-sm min-w-[220px]"
                />
              </label>
              <div className="inline-flex items-center gap-2 rounded-lg border border-border px-2 py-1.5">
                <Filter className="h-4 w-4 text-muted-foreground" />
                <select
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value as "all" | "active" | "suspended");
                    setPage(1);
                  }}
                  className="bg-transparent text-sm"
                >
                  <option value="all">All status</option>
                  <option value="active">Active</option>
                  <option value="suspended">Suspended</option>
                </select>
              </div>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as "name" | "role" | "created")}
                className="rounded-lg bg-background/70 border border-border px-3 py-2 text-sm"
              >
                <option value="name">Sort: Name</option>
                <option value="role">Sort: Role</option>
                <option value="created">Sort: Newest</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border/50">
                  <th className="py-2">User</th>
                  <th className="py-2">Role</th>
                  <th className="py-2">Status</th>
                  <th className="py-2">Access</th>
                  <th className="py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagedUsers.map((u) => (
                  <tr key={u.id} className="border-b border-border/30 hover:bg-background/40">
                    <td className="py-2">
                      <div className="font-medium text-foreground">{u.name}</div>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                    </td>
                    <td className="py-2">{u.role}</td>
                    <td className="py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          u.status === "active"
                            ? "bg-success/15 text-success border border-success/30"
                            : "bg-destructive/15 text-destructive border border-destructive/30"
                        }`}
                      >
                        {u.status}
                      </span>
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        {u.access.slice(0, 3).map((a) => (
                          <span key={a} className="rounded bg-primary/10 text-primary px-2 py-0.5 text-xs">
                            {a}
                          </span>
                        ))}
                        {u.access.length > 3 && (
                          <span className="rounded bg-secondary/60 px-2 py-0.5 text-xs text-muted-foreground">
                            +{u.access.length - 3}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => startEdit(u)}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-secondary/60"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          Edit
                        </button>
                        <button
                          onClick={() => remove(u.id)}
                          className="inline-flex items-center gap-1 rounded-md border border-destructive/40 text-destructive px-2 py-1 hover:bg-destructive/10"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {pagedUsers.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-muted-foreground">
                      No users found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <div>
              Showing {pagedUsers.length} of {visibleUsers.length} matching users
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded-md border border-border px-2 py-1 disabled:opacity-50"
              >
                Prev
              </button>
              <span>
                Page {page} / {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="rounded-md border border-border px-2 py-1 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-border/40 bg-card/70 p-5">
          <div className="mb-3 flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-lg font-semibold text-foreground">Recent Auth Activity</h2>
          </div>
          <div className="max-h-72 overflow-auto rounded-lg border border-border/40">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card">
                <tr className="text-left text-muted-foreground border-b border-border/50">
                  <th className="py-2 px-3">When</th>
                  <th className="py-2 px-3">Action</th>
                  <th className="py-2 px-3">Actor</th>
                  <th className="py-2 px-3">Target</th>
                </tr>
              </thead>
              <tbody>
                {auditEvents.map((evt) => (
                  <tr key={evt.id} className="border-b border-border/30">
                    <td className="py-2 px-3 text-xs text-muted-foreground">{new Date(evt.createdAt).toLocaleString()}</td>
                    <td className="py-2 px-3 font-mono text-xs">{evt.action}</td>
                    <td className="py-2 px-3 text-xs">{evt.actorUserId || "-"}</td>
                    <td className="py-2 px-3 text-xs">{evt.targetUserId || "-"}</td>
                  </tr>
                ))}
                {auditEvents.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-muted-foreground">
                      No audit events found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
};
