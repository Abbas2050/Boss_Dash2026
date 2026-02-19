import React from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "../components/ui/card";
// ...existing code...
// ...existing code...
// ...existing code...
// ...existing code...
import { fetchLPAccounts, createLPAccount, LPAccount, LPAccountRequest } from "../lib/lpAccounts";
// ...existing code...
// ...existing code...
// ...existing code...
// ...existing code...
// ...existing code...


export default function LPManagerPage() {
  // State for header stats
  const [accounts, setAccounts] = useState<LPAccount[]>([]);
  const [form, setForm] = useState({
    name: "",
    login: "",
    password: "",
    server: "",
    source: "Manager",
    groupPattern: "",
    description: ""
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // TODO: Add state for terminal feed status, coverage dashboard, etc.

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
    <div className="min-h-screen bg-card/40 p-6">
      {/* Header Section */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold text-foreground tracking-wide mr-6">LP Account Manager</h1>
        <Badge className="bg-primary/20 text-primary font-mono">LP Accounts: {accounts.length}</Badge>
        <Badge className="bg-card/30 text-foreground font-mono">Manager: 0</Badge>
        <Badge className="bg-card/30 text-foreground font-mono">Terminal: 0</Badge>
        <Button className="ml-auto bg-muted text-foreground px-4 py-1 rounded" size="sm">Refresh All</Button>
      </div>

      {/* Add LP Account Form & Terminal Feed Status */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <form onSubmit={handleSubmit} className="bg-card/20 rounded-lg p-6 flex flex-col gap-3">
          <div className="text-lg font-semibold text-foreground mb-2">Add LP Account</div>
          {error && <div className="text-destructive text-sm mb-2">{error}</div>}
          <Input name="name" placeholder="LP Name e.g. ATFX, FXCM" value={form.name} onChange={handleChange} required className="bg-card/10 text-foreground placeholder:text-foreground/60" />
          <Input name="login" placeholder="MT5 Login e.g. 102001" value={form.login} onChange={handleChange} required className="bg-card/10 text-foreground placeholder:text-foreground/60" />
          <Input name="password" placeholder="Password" type="password" value={form.password} onChange={handleChange} required className="bg-card/10 text-foreground placeholder:text-foreground/60" />
          <Input name="server" placeholder="Server" value={form.server} onChange={handleChange} required className="bg-card/10 text-foreground placeholder:text-foreground/60" />
          <div className="flex gap-3">
            <Select name="source" value={form.source} onChange={handleChange} className="bg-white/10 text-white">
              <option value="Manager">Manager</option>
              <option value="Terminal">Terminal</option>
            </Select>
            <Input name="groupPattern" placeholder="Group Pattern (optional)" value={form.groupPattern} onChange={handleChange} className="bg-white/10 text-white placeholder:text-white/50" />
          </div>
          <Input name="description" placeholder="Description (optional)" value={form.description} onChange={handleChange} className="bg-white/10 text-white placeholder:text-white/50" />
          <Button type="submit" className="mt-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold" disabled={submitting}>
            {submitting ? "Adding..." : "Add LP Account"}
          </Button>
        </form>
        {/* Terminal Feed Status placeholder */}
        <div className="bg-card/20 rounded-lg p-6">
          <div className="text-lg font-semibold text-foreground mb-2">Terminal Feed Status</div>
          <div className="text-foreground/70 text-sm">(Coming soon)</div>
        </div>
      </div>

      {/* LP Accounts Table */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div className="text-lg font-semibold text-foreground">LP Accounts</div>
          <div className="text-sm text-muted">Showing {accounts.length} LPs</div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {accounts.map((acc) => (
            <div key={acc.id} className="bg-card/30 rounded-lg p-4 shadow-sm hover:shadow-md transition">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm text-muted font-mono">ID: {acc.id}</div>
                  <div className="text-lg font-semibold text-foreground">{acc.name}</div>
                  <div className="text-sm text-foreground/80">Login: <span className="font-mono">{acc.login}</span></div>
                </div>
                <div className="text-right">
                  <div className={acc.status === 'connected' ? 'inline-flex items-center gap-2 text-success' : 'inline-flex items-center gap-2 text-destructive'}>
                    <span className={`w-2 h-2 rounded-full ${acc.status === 'connected' ? 'bg-success' : 'bg-destructive'}`} />
                    <span className="text-xs font-semibold">{acc.status === 'connected' ? 'Active' : 'Inactive'}</span>
                  </div>
                </div>
              </div>

              <div className="mt-3 text-sm text-foreground/70">Source: {acc.source || '-'}</div>
              <div className="text-sm text-foreground/70">Group: {acc.groupPattern || '-'}</div>
              {acc.description && <div className="mt-2 text-sm text-foreground/60">{acc.description}</div>}

              <div className="mt-4 flex items-center gap-2">
                <Button size="xs" className="bg-yellow-400/80 text-black px-2 py-1 rounded">Edit</Button>
                <Button size="xs" className="bg-red-500/80 text-white px-2 py-1 rounded">Deactivate</Button>
                <Button size="xs" className="bg-pink-500/80 text-white px-2 py-1 rounded">Remove</Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Coverage Dashboard (Live) placeholder */}
      <div className="bg-card/20 rounded-lg p-4">
        <div className="text-lg font-semibold text-foreground mb-2">Coverage Dashboard (Live)</div>
        <div className="text-foreground/70 text-sm">(Coming soon)</div>
      </div>
    </div>
  );
}
