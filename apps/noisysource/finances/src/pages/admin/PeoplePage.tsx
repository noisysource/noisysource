import { useEffect, useMemo, useState } from "react";
import type { Person } from "@shared/models/Entities"; // or your Person type
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { api } from "../../lib/api";

function PersonForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial: Person | null;
  onSaved?: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (!initial) {
      setEditingId(null);
      setName("");
      setEmail("");
      return;
    }
    setEditingId(initial.id);
    setName(initial.name || "");
    setEmail((initial as any).email || "");
  }, [initial]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await api.people.save({
      id: editingId || undefined,
      name: name.trim(),
      email: email.trim() || undefined,
    } as any);
    await onSaved?.();
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <div>
        <div className="text-xs text-zinc-400 mb-1">Full name</div>
        <Input value={name} onChange={(e)=>setName(e.target.value)} required />
      </div>
      <div>
        <div className="text-xs text-zinc-400 mb-1">Email (optional)</div>
        <Input type="email" value={email} onChange={(e)=>setEmail(e.target.value)} />
      </div>

      <div className="flex gap-2">
        <Button type="submit" className="flex-1">
          {editingId ? "Update" : "Create"}
        </Button>
        {editingId && (
          <Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

export default function PeoplePage() {
  const [rows, setRows] = useState<Person[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [formOpen, setFormOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);

  async function reload() {
    setBusy(true); setMsg(null);
    try {
      const list = await api.people.list();
      setRows(list as Person[]);
    } catch (e: any) {
      setMsg(e?.message ?? "Failed to load people");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void reload(); }, []);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter(p =>
      (p.name || "").toLowerCase().includes(t) ||
      ((p as any).email || "").toLowerCase().includes(t)
    );
  }, [rows, q]);

  const allFilteredSelected =
    filtered.length > 0 &&
    filtered.every((r) => !!selected[r.id]) &&
    filtered.some(Boolean);
  const anySelected = Object.values(selected).some(Boolean);
  const selectedIds = Object.entries(selected).filter(([, v]) => !!v).map(([k]) => k);

  function startCreate() { setEditingId(null); setFormOpen(true); }
  function startEdit(id: string) { setEditingId(id); setFormOpen(true); }

  async function deleteOne(id: string) {
    if (!confirm("Delete this person?")) return;
    setBusy(true); setMsg(null);
    try {
      await api.people.delete(id);
      await reload();
      setMsg("Deleted ✔");
    } catch (e: any) {
      setMsg(e?.message ?? "Delete failed");
    } finally {
      setBusy(false);
    }
  }
  async function deleteSelected() {
    if (!selectedIds.length) return;
    if (!confirm(`Delete ${selectedIds.length} selected person(s)?`)) return;
    setBusy(true); setMsg(null);
    try {
      await Promise.all(selectedIds.map(id => api.people.delete(id)));
      setSelected({});
      await reload();
      setMsg("Deleted selected ✔");
    } catch (e: any) {
      setMsg(e?.message ?? "Bulk delete failed");
    } finally {
      setBusy(false);
    }
  }
  async function deleteAllFiltered() {
    if (!filtered.length) return;
    if (!confirm(`Delete ALL ${filtered.length} filtered person(s)?`)) return;
    setBusy(true); setMsg(null);
    try {
      await Promise.all(filtered.map(p => api.people.delete(p.id)));
      setSelected({});
      await reload();
      setMsg("Deleted all filtered ✔");
    } catch (e: any) {
      setMsg(e?.message ?? "Bulk delete failed");
    } finally {
      setBusy(false);
    }
  }

  const editing = useMemo(
    () => (editingId ? rows.find(r => r.id === editingId) ?? null : null),
    [rows, editingId]
  );

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-6">
      {/* LEFT: list */}
      <div className="space-y-4">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <h2 className="text-xl font-semibold">People</h2>
          <div className="flex gap-2 items-center">
            <Input placeholder="Search…" value={q} onChange={(e)=>setQ(e.target.value)} />
            <Button variant="secondary" onClick={() => {
              const map: Record<string, boolean> = {};
              for (const r of filtered) map[r.id] = true;
              setSelected(map);
            }} disabled={busy || !filtered.length}>
              Select all (filtered)
            </Button>
            <Button variant="destructive" onClick={deleteSelected} disabled={busy || !anySelected}>
              Delete selected
            </Button>
            <Button variant="destructive" onClick={deleteAllFiltered} disabled={busy || !filtered.length}>
              Delete ALL filtered
            </Button>
            <Button onClick={startCreate} disabled={busy}>New person</Button>
          </div>
        </div>

        {msg && <div className="text-sm text-emerald-400">{msg}</div>}

        <Card className="overflow-x-auto">
          <table className="min-w-full text-sm text-left">
            <thead>
              <tr className="border-b border-zinc-700 text-zinc-300">
                <th className="px-2 py-2 w-8">
                  <input
                    type="checkbox"
                    onChange={(e)=>{
                      const on = e.target.checked;
                      const map: Record<string, boolean> = {};
                      for (const r of filtered) map[r.id] = on;
                      setSelected(map);
                    }}
                    checked={allFilteredSelected}
                  />
                </th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id} className="border-b border-zinc-800">
                  <td className="px-2 py-2">
                    <input
                      type="checkbox"
                      checked={!!selected[p.id]}
                      onChange={(e)=>setSelected(s=>({ ...s, [p.id]: e.target.checked }))}
                    />
                  </td>
                  <td className="px-3 py-2">{p.name}</td>
                  <td className="px-3 py-2">{(p as any).email || "—"}</td>
                  <td className="px-3 py-2 space-x-3">
                    <button className="text-blue-400 underline" onClick={()=>startEdit(p.id)} disabled={busy}>Edit</button>
                    <button className="text-red-400 underline" onClick={()=>deleteOne(p.id)} disabled={busy}>Delete</button>
                  </td>
                </tr>
              ))}
              {!filtered.length && (
                <tr><td colSpan={4} className="px-3 py-6 text-zinc-500">No people.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>

      {/* RIGHT: form */}
      <div className="xl:sticky xl:top-4 h-fit space-y-3">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="text-lg font-medium">{editing ? "Edit person" : "New person"}</div>
            <button
              onClick={() => setFormOpen(v=>!v)}
              className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700"
            >
              {formOpen ? "Collapse" : "Expand"}
            </button>
          </div>
          {formOpen && (
            <div className="mt-3">
              <PersonForm
                initial={editing}
                onSaved={async ()=>{ setEditingId(null); await reload(); }}
                onCancel={()=> setEditingId(null)}
              />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}