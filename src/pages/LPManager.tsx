import React, { useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { fetchLPAccounts, createLPAccount, LPAccount, LPAccountRequest } from "../lib/lpAccounts";

export default function LPManagerPage() {
  const [accounts, setAccounts] = useState<LPAccount[]>([]);
  const [form, setForm] = useState({
    name: "",
    login: "",
    password: "",
    server: "",
    source: "Manager",
    groupPattern: "",
    description: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchLPAccounts()
      .then(setAccounts)
      .catch((e) => setError(e.message || "Failed to load LP accounts"));
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const newAccount = await createLPAccount(form as LPAccountRequest);
      setAccounts((prev) => [...prev, newAccount]);
      setForm({ name: "", login: "", password: "", server: "", source: "Manager", groupPattern: "", description: "" });
    } catch (e: any) {
      setError(e.message || "Failed to create LP account");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="mr-6 text-2xl font-bold tracking-wide">LP Account Manager</h1>
        <Badge className="bg-primary/15 text-primary">LP Accounts: {accounts.length}</Badge>
        <Badge className="bg-secondary text-secondary-foreground">Manager: 0</Badge>
        <Badge className="bg-secondary text-secondary-foreground">Terminal: 0</Badge>
        <Button className="ml-auto" variant="secondary" size="sm">Refresh All</Button>
      </div>

      <div className="mb-8 grid grid-cols-1 gap-6 md:grid-cols-2">
        <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-card p-6">
          <div className="mb-3 text-lg font-semibold">Add LP Account</div>
          {error && <div className="mb-3 text-sm text-destructive">{error}</div>}
          <div className="space-y-3">
            <Input name="name" placeholder="LP Name e.g. ATFX, FXCM" value={form.name} onChange={handleChange} required className="bg-background" />
            <Input name="login" placeholder="MT5 Login e.g. 102001" value={form.login} onChange={handleChange} required className="bg-background" />
            <Input name="password" placeholder="Password" type="password" value={form.password} onChange={handleChange} required className="bg-background" />
            <Input name="server" placeholder="Server" value={form.server} onChange={handleChange} required className="bg-background" />
            <div className="flex gap-3">
              <select name="source" value={form.source} onChange={handleChange} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground">
                <option value="Manager">Manager</option>
                <option value="Terminal">Terminal</option>
              </select>
              <Input name="groupPattern" placeholder="Group Pattern (optional)" value={form.groupPattern} onChange={handleChange} className="bg-background" />
            </div>
            <Input name="description" placeholder="Description (optional)" value={form.description} onChange={handleChange} className="bg-background" />
            <Button type="submit" className="mt-2" disabled={submitting}>
              {submitting ? "Adding..." : "Add LP Account"}
            </Button>
          </div>
        </form>

        <div className="rounded-lg border border-border bg-card p-6">
          <div className="mb-2 text-lg font-semibold">Terminal Feed Status</div>
          <div className="text-sm text-muted-foreground">(Coming soon)</div>
        </div>
      </div>

      <div className="mb-8">
        <div className="mb-4 flex items-center justify-between">
          <div className="text-lg font-semibold">LP Accounts</div>
          <div className="text-sm text-muted-foreground">Showing {accounts.length} LPs</div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {accounts.map((acc) => (
            <div key={acc.id} className="rounded-lg border border-border bg-card p-4 shadow-sm transition hover:shadow-md">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-mono text-sm text-muted-foreground">ID: {acc.id}</div>
                  <div className="text-lg font-semibold">{acc.name}</div>
                  <div className="text-sm text-muted-foreground">Login: <span className="font-mono text-foreground">{acc.login}</span></div>
                </div>
                <div className="text-right">
                  <div className={acc.status === "connected" ? "inline-flex items-center gap-2 text-success" : "inline-flex items-center gap-2 text-destructive"}>
                    <span className={`h-2 w-2 rounded-full ${acc.status === "connected" ? "bg-success" : "bg-destructive"}`} />
                    <span className="text-xs font-semibold">{acc.status === "connected" ? "Active" : "Inactive"}</span>
                  </div>
                </div>
              </div>

              <div className="mt-3 text-sm text-muted-foreground">Server: {acc.server || "-"}</div>

              <div className="mt-4 flex items-center gap-2">
                <Button size="sm" variant="outline" className="px-2 py-1">Edit</Button>
                <Button size="sm" variant="destructive" className="px-2 py-1">Deactivate</Button>
                <Button size="sm" variant="secondary" className="px-2 py-1">Remove</Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 text-lg font-semibold">Coverage Dashboard (Live)</div>
        <div className="text-sm text-muted-foreground">(Coming soon)</div>
      </div>
    </div>
  );
}
