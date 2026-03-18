import React, { useEffect, useState } from "react";

type LPAccount = any;

export const LPManagerPage: React.FC = () => {
  const [accounts, setAccounts] = useState<LPAccount[]>([]);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [lpName, setLpName] = useState("");
  const [mt5Login, setMt5Login] = useState("");
  const [source, setSource] = useState("Manager");
  const [groupPattern, setGroupPattern] = useState("");
  const [description, setDescription] = useState("");
  const [mt5TerminalPath, setMt5TerminalPath] = useState("");
  const [mt5Server, setMt5Server] = useState("");
  const [mt5Password, setMt5Password] = useState("");

  useEffect(() => {
    loadAll();
    const covInterval = setInterval(loadCoverage, 3000);
    const termInterval = setInterval(loadTerminalStatus, 5000);
    return () => {
      clearInterval(covInterval);
      clearInterval(termInterval);
    };
  }, []);

  // --- Edit modal state & handlers ---
  const [editing, setEditing] = useState<boolean>(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editLpName, setEditLpName] = useState("");
  const [editMt5Login, setEditMt5Login] = useState("");
  const [editGroupPattern, setEditGroupPattern] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editIsActive, setEditIsActive] = useState(true);
  const [editTerminalPath, setEditTerminalPath] = useState("");
  const [editMt5Server, setEditMt5Server] = useState("");
  const [editMt5Password, setEditMt5Password] = useState("");
  const [editSource, setEditSource] = useState<string>('Manager');
  const [editErrors, setEditErrors] = useState<Record<string,string>>({});
  const [editSaving, setEditSaving] = useState<boolean>(false);
  const [showPreview, setShowPreview] = useState<boolean>(false);

  function openEditModal(id: number) {
    const a = accounts.find(x => x.id === id);
    if (!a) return;
    setEditId(a.id);
    setEditLpName(a.lpName || '');
    setEditMt5Login(a.mt5Login || '');
    setEditGroupPattern(a.groupPattern || '');
    setEditDescription(a.description || '');
    setEditIsActive(!!a.isActive);
    setEditTerminalPath(a.mt5TerminalPath || '');
    setEditMt5Server(a.mt5Server || '');
    setEditMt5Password('');
    setEditSource((a.source === 'Terminal' || a.source === 1) ? 'Terminal' : 'Manager');
    setEditErrors({});
    setEditing(true);
  }

  function closeEditModal() {
    setEditing(false);
    setEditId(null);
  }

  async function saveEdit() {
    if (!editId) return;
    // client-side validation
    const errors: Record<string,string> = {};
    if (!editLpName.trim()) errors.lpName = 'LP Name is required';
    // if source is Terminal, ensure terminal connection info exists
    if (editSource === 'Terminal') {
      if (!editTerminalPath.trim()) errors.mt5TerminalPath = 'Terminal path is required for Terminal source';
      if (!editMt5Server.trim()) errors.mt5Server = 'MT5 server is required for Terminal source';
    }
    // validate mt5 login if present
    if (editMt5Login && String(editMt5Login).trim() !== '') {
      const v = Number(editMt5Login);
      if (isNaN(v) || v <= 0) errors.mt5Login = 'MT5 Login must be a valid positive number';
    }
    setEditErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setEditSaving(true);
    const body: any = {
      lpName: editLpName.trim() || null,
      groupPattern: editGroupPattern.trim() || null,
      description: editDescription.trim() || null,
      isActive: editIsActive
    };
    if (editTerminalPath.trim()) body.mt5TerminalPath = editTerminalPath.trim();
    if (editMt5Server.trim()) body.mt5Server = editMt5Server.trim();
    if (editMt5Password.trim()) body.mt5Password = editMt5Password.trim();

    try {
      const resp = await fetch(`/api/LpAccount/${editId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (resp.ok) {
        setMsg({ text: 'Account updated successfully', ok: true });
        closeEditModal();
        await loadAccounts(); loadCoverage();
      } else {
        const text = await resp.text();
        setMsg({ text: `Error: ${text}`, ok: false });
      }
    } catch (e: any) {
      setMsg({ text: `Failed: ${e.message}`, ok: false });
    }
    setEditSaving(false);
  }

  async function loadAccounts() {
    try {
      const resp = await fetch(`/api/LpAccount?all=true`);
      const data = await resp.json();
      setAccounts(data || []);
    } catch (e: any) {
      setAccounts([]);
      setMsg({ text: `Failed to load accounts: ${e.message}`, ok: false });
    }
  }

  async function loadCoverage() {
    try {
      const resp = await fetch(`/Coverage/dashboard`);
      // we don't fully render coverage here (separate UI), keep a noop or simple console for now
      await resp.json().catch(() => null);
    } catch (e: any) {
      // ignore for now
    }
  }

  async function loadTerminalStatus() {
    try {
      const resp = await fetch(`/api/TerminalPosition/status`);
      await resp.json().catch(() => null);
    } catch (e: any) {
      // ignore
    }
  }

  async function addAccount() {
    if (!lpName.trim() || !mt5Login.trim()) {
      setMsg({ text: 'LP Name and MT5 Login are required', ok: false });
      return;
    }
    // validate mt5Login numeric
    const parsedLogin = parseInt(mt5Login, 10);
    if (isNaN(parsedLogin) || parsedLogin <= 0) {
      setMsg({ text: 'MT5 Login must be a valid positive number', ok: false });
      return;
    }

    const body: any = {
      lpName: lpName.trim(),
      mt5Login: parseInt(mt5Login, 10),
      source,
      groupPattern: groupPattern || null,
      description: description || null
    };

    if (source === 'Terminal') {
      if (!mt5TerminalPath.trim() || !mt5Server.trim() || !mt5Password.trim()) {
        setMsg({ text: 'Terminal source requires Path, Server, and Password', ok: false });
        return;
      }
      body.mt5TerminalPath = mt5TerminalPath.trim();
      body.mt5Server = mt5Server.trim();
      body.mt5Password = mt5Password.trim();
    }

    try {
      const resp = await fetch(`/api/LpAccount`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (resp.ok) {
        const a = await resp.json().catch(() => null);
        setMsg({ text: `Added ${a?.lpName || body.lpName}`, ok: true });
        setLpName(''); setMt5Login(''); setGroupPattern(''); setDescription(''); setMt5TerminalPath(''); setMt5Server(''); setMt5Password('');
        await loadAccounts(); loadCoverage();
      } else {
        const text = await resp.text();
        setMsg({ text: `Error: ${text}`, ok: false });
      }
    } catch (e: any) {
      setMsg({ text: `Failed: ${e.message}`, ok: false });
    }
  }

  async function deactivate(id: number) {
    if (!confirm('Deactivate this LP account? It will stop tracking positions.')) return;
    try {
      const resp = await fetch(`/api/LpAccount/${id}`, { method: 'DELETE' });
      if (resp.ok) {
        setMsg({ text: 'Account deactivated', ok: true });
        loadAccounts(); loadCoverage();
      } else setMsg({ text: 'Failed to deactivate', ok: false });
    } catch (e: any) {
      setMsg({ text: `Failed: ${e.message}`, ok: false });
    }
  }

  async function removeAccount(id: number, name: string) {
    if (!confirm(`Permanently remove LP account "${name}" (#${id})? This cannot be undone.`)) return;
    try {
      const resp = await fetch(`/api/LpAccount/${id}?permanent=true`, { method: 'DELETE' });
      if (resp.ok) {
        setMsg({ text: `Account "${name}" permanently removed`, ok: true });
        loadAccounts(); loadCoverage();
      } else setMsg({ text: 'Failed to remove', ok: false });
    } catch (e: any) {
      setMsg({ text: `Failed: ${e.message}`, ok: false });
    }
  }

  async function activate(id: number) {
    try {
      const resp = await fetch(`/api/LpAccount/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: true })
      });
      if (resp.ok) {
        setMsg({ text: 'Account activated', ok: true });
        loadAccounts(); loadCoverage();
      } else setMsg({ text: 'Failed to activate', ok: false });
    } catch (e: any) {
      setMsg({ text: `Failed: ${e.message}`, ok: false });
    }
  }

  async function loadAll() {
    await Promise.all([loadAccounts(), loadCoverage(), loadTerminalStatus()]);
  }

  return (
    <>
    <div className="bg-background min-h-screen">
      <main className="p-3 sm:p-4 md:p-6 lg:p-8">
        <h1 className="text-2xl font-bold text-primary mb-6">LP Account Manager</h1>

        <div className="mb-4 text-sm text-foreground/80">
          <button onClick={loadAll} className="bg-secondary px-3 py-1 rounded">Refresh All</button>
        </div>

        <div className="grid grid-cols-1 gap-6">
          <div className="bg-card/80 border border-border/40 p-4 rounded">
            <h2 className="text-lg text-yellow-300 mb-3">Add LP Account</h2>
            <div className="flex flex-col gap-2">
              <input value={lpName} onChange={e => setLpName(e.target.value)} placeholder="LP Name" className="bg-background/70 border border-border p-2 rounded" />
              <input value={mt5Login} onChange={e => setMt5Login(e.target.value)} placeholder="MT5 Login" className="bg-background/70 border border-border p-2 rounded" />
              <select value={source} onChange={e => setSource(e.target.value)} className="bg-background/70 border border-border p-2 rounded">
                <option>Manager</option>
                <option>Terminal</option>
              </select>
              <input value={groupPattern} onChange={e => setGroupPattern(e.target.value)} placeholder="Group Pattern (optional)" className="bg-background/70 border border-border p-2 rounded" />
              <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Description (optional)" className="bg-background/70 border border-border p-2 rounded" />

              {source === 'Terminal' && (
                <div className="flex flex-col gap-2">
                  <input value={mt5TerminalPath} onChange={e => setMt5TerminalPath(e.target.value)} placeholder="Terminal Path" className="bg-background/70 border border-border p-2 rounded" />
                  <input value={mt5Server} onChange={e => setMt5Server(e.target.value)} placeholder="MT5 Server" className="bg-background/70 border border-border p-2 rounded" />
                  <input value={mt5Password} onChange={e => setMt5Password(e.target.value)} type="password" placeholder="MT5 Password" className="bg-background/70 border border-border p-2 rounded" />
                </div>
              )}

              <div className="mt-2">
                <button onClick={addAccount} className="bg-blue-400 px-4 py-2 rounded">Add LP Account</button>
              </div>
              <div id="msg" className="mt-2">{msg && <div className={msg.ok ? 'text-green-400' : 'text-red-400'}>{msg.text}</div>}</div>
            </div>
          </div>

          <div className="bg-card/80 border border-border/40 p-4 rounded">
            <h2 className="text-lg text-yellow-300 mb-3">LP Accounts</h2>
            <table className="w-full">
              <thead>
                <tr>
                  <th className="text-left">ID</th>
                  <th className="text-left">LP Name</th>
                  <th className="text-left">MT5 Login</th>
                  <th className="text-left">Source</th>
                  <th className="text-left">Group</th>
                  <th className="text-left">Description</th>
                  <th className="text-left">Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a: any) => (
                  <tr key={a.id} className="hover:bg-background/70 border border-border">
                    <td className="px-2 py-1">{a.id}</td>
                    <td className="px-2 py-1 font-semibold">{a.lpName}</td>
                    <td className="px-2 py-1">{a.mt5Login}</td>
                    <td className="px-2 py-1">{(a.source === 'Terminal' || a.source === 1) ? 'Terminal' : 'Manager'}</td>
                    <td className="px-2 py-1">{a.groupPattern || '-'}</td>
                    <td className="px-2 py-1">{a.description || '-'}</td>
                    <td className="px-2 py-1">{a.isActive ? 'Active' : 'Inactive'}</td>
                    <td className="px-2 py-1 text-right space-x-2">
                      <button onClick={() => openEditModal(a.id)} className="bg-yellow-400 px-2 py-1 rounded text-sm">Edit</button>
                      {a.isActive ? (
                        <button onClick={() => deactivate(a.id)} className="border px-2 py-1 rounded text-sm">Deactivate</button>
                      ) : (
                        <button onClick={() => activate(a.id)} className="bg-green-400 px-2 py-1 rounded text-sm">Activate</button>
                      )}
                      <button onClick={() => removeAccount(a.id, a.lpName)} className="bg-red-500 px-2 py-1 rounded text-sm">Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>

    {/* Edit Modal */}
    {editing && (
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
        <div className="bg-card/80 border border-border/40 border p-6 rounded w-[720px] max-w-[95%]">
          <h2 className="text-lg text-primary mb-2">Edit LP Account <span className="text-muted-foreground">#{editId}</span></h2>
          <div className="flex flex-col gap-2">
            <div>
              <input value={editLpName} onChange={e => setEditLpName(e.target.value)} placeholder="LP Name" className="bg-background/70 border border-border p-2 rounded w-full" />
              {editErrors.lpName && <div className="text-red-400 text-sm mt-1">{editErrors.lpName}</div>}
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <input value={editMt5Login} disabled className="bg-muted/40 border border-border p-2 rounded opacity-60 w-full" />
                {editErrors.mt5Login && <div className="text-red-400 text-sm mt-1">{editErrors.mt5Login}</div>}
              </div>
              <div className="w-40">
                <select value={editSource} onChange={e => setEditSource(e.target.value)} className="bg-background/70 border border-border p-2 rounded w-full">
                  <option>Manager</option>
                  <option>Terminal</option>
                </select>
              </div>
            </div>
            <input value={editGroupPattern} onChange={e => setEditGroupPattern(e.target.value)} placeholder="Group Pattern" className="bg-background/70 border border-border p-2 rounded" />
            <input value={editDescription} onChange={e => setEditDescription(e.target.value)} placeholder="Description" className="bg-background/70 border border-border p-2 rounded" />
            <div className="flex items-center gap-2">
              <label className="text-sm">Active</label>
              <select value={String(editIsActive)} onChange={e => setEditIsActive(e.target.value === 'true')} className="bg-background/70 border border-border p-2 rounded">
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </div>

            <div className="border-t pt-2">
              <div className="text-sm text-muted-foreground mb-2">Terminal connection settings</div>
              <div>
                <input value={editTerminalPath} onChange={e => setEditTerminalPath(e.target.value)} placeholder="Terminal Path" className="bg-background/70 border border-border p-2 rounded w-full" />
                {editErrors.mt5TerminalPath && <div className="text-red-400 text-sm mt-1">{editErrors.mt5TerminalPath}</div>}
              </div>
              <div className="mt-2">
                <input value={editMt5Server} onChange={e => setEditMt5Server(e.target.value)} placeholder="MT5 Server" className="bg-background/70 border border-border p-2 rounded w-full" />
                {editErrors.mt5Server && <div className="text-red-400 text-sm mt-1">{editErrors.mt5Server}</div>}
              </div>
              <div className="mt-2">
                <input value={editMt5Password} onChange={e => setEditMt5Password(e.target.value)} type="password" placeholder="MT5 Password (leave blank to keep)" className="bg-background/70 border border-border p-2 rounded w-full" />
              </div>
            </div>

            <div className="mt-3">
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={showPreview} onChange={e => setShowPreview(e.target.checked)} className="rounded" />
                <span className="text-sm text-foreground/80">Show preview of changes</span>
              </label>
            </div>

            {showPreview && (
              <div className="mt-3 bg-background/70 p-3 rounded border">
                <div className="text-sm text-foreground/80 mb-2">Preview</div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><strong>LP Name</strong><div className="text-foreground">{editLpName || '-'}</div></div>
                  <div><strong>MT5 Login</strong><div className="text-foreground">{editMt5Login || '-'}</div></div>
                  <div><strong>Source</strong><div className="text-foreground">{editSource}</div></div>
                  <div><strong>Active</strong><div className="text-foreground">{editIsActive ? 'Yes' : 'No'}</div></div>
                  <div><strong>Group Pattern</strong><div className="text-foreground">{editGroupPattern || '-'}</div></div>
                  <div><strong>Description</strong><div className="text-foreground">{editDescription || '-'}</div></div>
                  <div className="col-span-2"><strong>Terminal Path</strong><div className="text-foreground">{editTerminalPath || '-'}</div></div>
                  <div className="col-span-2"><strong>MT5 Server</strong><div className="text-foreground">{editMt5Server || '-'}</div></div>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button onClick={closeEditModal} className="bg-secondary px-4 py-2 rounded">Cancel</button>
              <button onClick={saveEdit} disabled={editSaving} className={`px-4 py-2 rounded ${editSaving ? 'bg-gray-500' : 'bg-blue-400'}`}>{editSaving ? 'Saving...' : 'Save Changes'}</button>
            </div>
            <div className="mt-2">{msg && <div className={msg.ok ? 'text-green-400' : 'text-red-400'}>{msg.text}</div>}</div>
          </div>
        </div>
      </div>
    )}
    </>
  );
};

