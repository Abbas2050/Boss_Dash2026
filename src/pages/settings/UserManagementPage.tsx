import React, { useMemo, useState } from "react";
import { Shield, UserPlus, Search, Trash2, Pencil, CheckCircle2 } from "lucide-react";
import { AuthUser, deleteUser, getCurrentUser, getUsers, upsertUser } from "@/lib/auth";

const pages = ["Dealing", "Backoffice", "HR", "Marketing", "Accounts", "Settings", "Alerts"];

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
  access: ["Alerts"],
  password: "",
};

export const UserManagementPage: React.FC = () => {
  const [users, setUsers] = useState<AuthUser[]>(() => getUsers());
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<UserForm>(blankForm);
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const currentUser = getCurrentUser();

  const reload = () => setUsers(getUsers());

  const visibleUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q)
    );
  }, [users, query]);

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

  const submit = () => {
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

    if (editId) {
      const old = users.find((u) => u.id === editId);
      if (!old) return;
      upsertUser({
        ...old,
        ...form,
        password: form.password.trim() ? form.password : old.password,
      });
      setEditId(null);
    } else {
      upsertUser({
        id: String(Date.now()),
        ...form,
      });
    }

    resetForm();
    reload();
  };

  const remove = (id: string) => {
    if (currentUser?.id === id) {
      setError("You cannot delete your currently logged-in account.");
      return;
    }
    deleteUser(id);
    reload();
  };

  const toggleAccess = (page: string) => {
    setForm((prev) => ({
      ...prev,
      access: prev.access.includes(page)
        ? prev.access.filter((p) => p !== page)
        : [...prev.access, page],
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

          <div className="mt-3 flex flex-wrap gap-2">
            {pages.map((page) => (
              <button
                key={page}
                onClick={() => toggleAccess(page)}
                className={`rounded-md px-2 py-1 text-xs border ${
                  form.access.includes(page)
                    ? "border-primary/40 bg-primary/15 text-primary"
                    : "border-border/50 bg-secondary/30 text-muted-foreground"
                }`}
              >
                {page}
              </button>
            ))}
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
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-lg font-semibold text-foreground">Users</h2>
            <label className="relative">
              <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, email, role"
                className="rounded-lg bg-background/70 border border-border pl-8 pr-3 py-2 text-sm min-w-[230px]"
              />
            </label>
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
                {visibleUsers.map((u) => (
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
                {visibleUsers.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-muted-foreground">
                      No users found.
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
