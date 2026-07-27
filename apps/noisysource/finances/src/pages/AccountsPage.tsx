import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Account } from "@shared/models/Account";
import { formatEUR } from "@shared/lib/money";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api } from "../lib/api";
import { AccountForm } from "../components/forms/AccountsForm";
import { useEntity } from "../hooks/EntityContext";

type Company = { id: string; name: string };
type Person  = { id: string; name: string };

export default function AccountsPage() {
  const { selectedEntity } = useEntity();

  // data
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [people, setPeople] = useState<Person[]>([]);

  // ui
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // selection + edit
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [formOpen, setFormOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);

  // load
  async function reload() {
    if (!selectedEntity.id) return;
    setBusy(true); setMsg(null);
    try {
      // API calls are now automatically scoped to the selectedEntity.id via the api object
      const [as, cs, ps] = await Promise.all([
        api.accounts.list(),
        api.companies.list(),
        api.people.list(),
      ]);
      setAccounts(as as Account[]);
      setCompanies((cs as any[]).map(c => ({ id: c.id, name: c.name })).sort((a,b)=>a.name.localeCompare(b.name)));
      setPeople((ps as any[]).map(p => ({ id: p.id, name: p.name })).sort((a,b)=>a.name.localeCompare(b.name)));
    } catch (e: any) {
      setMsg(e?.message ?? "Failed to load");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void reload(); }, [selectedEntity.id]);

  // helpers
  const ownerName = (ot?: string, oid?: string) =>
    ot === "company"
      ? (companies.find(c => c.id === oid)?.name ?? oid ?? "—")
      : ot === "person"
      ? (people.find(p => p.id === oid)?.name ?? oid ?? "—")
      : "—";

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return accounts;
    return accounts.filter(a =>
      (a.name || "").toLowerCase().includes(t) ||
      (a.type || "").toLowerCase().includes(t) ||
      (a.currency || "").toLowerCase().includes(t) ||
      ((a as any).code || "").toLowerCase().includes(t) ||
      ((a as any).ownerType || "").toLowerCase().includes(t)
    );
  }, [accounts, q]);

  const allFilteredSelected =
    filtered.length > 0 &&
    filtered.every((r) => !!selected[(r as any).id]) &&
    filtered.some(Boolean);
  const anySelected = Object.values(selected).some(Boolean);
  const selectedIds = Object.entries(selected).filter(([, v]) => !!v).map(([k]) => k);

  const toggleAllFiltered = (on: boolean) => {
    const map: Record<string, boolean> = {};
    for (const r of filtered) map[(r as any).id] = on;
    setSelected(map);
  };

  function startCreate() {
    setEditingId(null);
    setFormOpen(true);
  }
  function startEdit(id: string) {
    setEditingId(id);
    setFormOpen(true);
  }

  async function deleteOne(id: string) {
    if (!confirm("Delete this account?")) return;
    setBusy(true); setMsg(null);
    try {
      await api.accounts.delete(id);
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
    if (!confirm(`Delete ${selectedIds.length} selected account(s)?`)) return;
    setBusy(true); setMsg(null);
    try {
      await Promise.all(selectedIds.map(id => api.accounts.delete(id)));
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
    if (!confirm(`Delete ALL ${filtered.length} filtered account(s)?`)) return;
    setBusy(true); setMsg(null);
    try {
      await Promise.all(filtered.map(a => api.accounts.delete((a as any).id)));
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
    () => (editingId ? accounts.find(a => (a as any).id === editingId) ?? null : null),
    [accounts, editingId]
  );

  const noOwners = !busy && companies.length === 0 && people.length === 0;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-6">
      {/* LEFT: list */}
      <div className="space-y-4">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <h2 className="text-xl font-semibold">Accounts</h2>
          <div className="flex gap-2 items-center">
            <Input placeholder="Search…" value={q} onChange={(e)=>setQ(e.target.value)} />
            <Button variant="secondary" onClick={() => toggleAllFiltered(true)} disabled={busy || !filtered.length}>
              Select all (filtered)
            </Button>
            <Button variant="destructive" onClick={deleteSelected} disabled={busy || !anySelected}>
              Delete selected
            </Button>
            <Button variant="destructive" onClick={deleteAllFiltered} disabled={busy || !filtered.length}>
              Delete ALL filtered
            </Button>
            <Button onClick={startCreate} disabled={busy}>New account</Button>
          </div>
        </div>

        {msg && <div className="text-sm text-emerald-400">{msg}</div>}

        {noOwners && (
          <Card className="p-6 text-center space-y-2">
            <div className="text-zinc-400 text-sm">No people or companies found in this entity.</div>
            <div className="text-zinc-500 text-xs">
              Accounts need an owner. Go to{" "}
              <Link to="/setup/people" className="text-blue-400 underline">Setup → People</Link>
              {" "}or{" "}
              <Link to="/setup/companies" className="text-blue-400 underline">Setup → Companies</Link>
              {" "}to create them first.
            </div>
          </Card>
        )}

        <Card className="overflow-x-auto">
          <table className="min-w-full text-sm text-left">
            <thead>
              <tr className="border-b border-zinc-700 text-zinc-300">
                <th className="px-2 py-2 w-8">
                  <input
                    type="checkbox"
                    onChange={(e)=>toggleAllFiltered(e.target.checked)}
                    checked={allFilteredSelected}
                  />
                </th>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Owner</th>
                <th className="px-3 py-2">Currency</th>
                <th className="px-3 py-2">Balance</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => {
                const id = (a as any).id as string;
                const code = (a as any).code as string | undefined;
                const bal = (a as any).balance as number | undefined; // cents if present
                return (
                  <tr key={id} className="border-b border-zinc-800">
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        checked={!!selected[id]}
                        onChange={(e)=>setSelected(s=>({ ...s, [id]: e.target.checked }))}
                      />
                    </td>
                    <td className="px-3 py-2">{code || "—"}</td>
                    <td className="px-3 py-2">{a.name}</td>
                    <td className="px-3 py-2 capitalize">
                      {a.type === "voucher"
                        ? `voucher · ${(a as any).voucherType ?? ""}`
                        : a.type}
                    </td>
                    <td className="px-3 py-2">{ownerName((a as any).ownerType, (a as any).ownerId)}</td>
                    <td className="px-3 py-2">{a.currency || "EUR"}</td>
                    <td className="px-3 py-2">{bal != null ? formatEUR(bal) : "—"}</td>
                    <td className="px-3 py-2 space-x-3">
                      <button className="text-blue-400 underline" onClick={()=>startEdit(id)} disabled={busy}>Edit</button>
                      <button className="text-red-400 underline" onClick={()=>deleteOne(id)} disabled={busy}>Delete</button>
                    </td>
                  </tr>
                );
              })}
              {!filtered.length && (
                <tr><td colSpan={8} className="px-3 py-6 text-zinc-500">No accounts.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>

      {/* RIGHT: collapsible AccountForm */}
      <div className="xl:sticky xl:top-4 h-fit space-y-3">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="text-lg font-medium">
              {editing ? "Edit account" : "New account"}
            </div>
            <button
              onClick={() => setFormOpen(v=>!v)}
              className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700"
            >
              {formOpen ? "Collapse" : "Expand"}
            </button>
          </div>

          {formOpen && (
            <div className="mt-3">
              <AccountForm
                initial={editing}
                onSaved={async () => { setEditingId(null); await reload(); }}
                onCancel={() => setEditingId(null)}
              />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}