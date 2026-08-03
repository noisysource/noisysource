import { useEffect, useMemo, useState } from "react";
import type { Account } from "@shared/models/Account";
import { formatEUR } from "@shared/lib/money";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api } from "../lib/api";
import { AccountForm } from "../components/forms/AccountsForm";
import { useEntity } from "../hooks/EntityContext";

export default function AccountsPage() {
  const { selectedEntity } = useEntity();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [eventBalances, setEventBalances] = useState<Map<string, number>>(new Map());

  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [formOpen, setFormOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);

  async function reload() {
    if (!selectedEntity.id) return;
    setBusy(true); setMsg(null);
    try {
      const [as, events] = await Promise.all([
        api.accounts.list(),
        api.financeEvents.listByEntity(selectedEntity.id as any),
      ]);
      setAccounts(as as Account[]);
      const balMap = new Map<string, number>();
      for (const e of events) {
        if (e.status === 'confirmed' && e.accountId) {
          balMap.set(e.accountId, (balMap.get(e.accountId) ?? 0) + e.amountCents);
        }
      }
      setEventBalances(balMap);
    } catch (e: any) {
      setMsg(e?.message ?? "Erro ao carregar");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void reload(); }, [selectedEntity.id]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return accounts;
    return accounts.filter(a =>
      (a.name || "").toLowerCase().includes(t) ||
      (a.type || "").toLowerCase().includes(t) ||
      ((a as any).code || "").toLowerCase().includes(t)
    );
  }, [accounts, q]);

  const anySelected = Object.values(selected).some(Boolean);
  const selectedIds = Object.entries(selected).filter(([, v]) => !!v).map(([k]) => k);
  const allFilteredSelected = filtered.length > 0 && filtered.every(r => !!selected[(r as any).id]);

  const toggleAllFiltered = (on: boolean) => {
    const map: Record<string, boolean> = {};
    for (const r of filtered) map[(r as any).id] = on;
    setSelected(map);
  };

  function startEdit(id: string) { setEditingId(id); setFormOpen(true); }

  async function deleteOne(id: string) {
    if (!confirm("Eliminar esta conta?")) return;
    setBusy(true); setMsg(null);
    try {
      await api.accounts.delete(id);
      await reload();
      setMsg("Eliminado ✔");
    } catch (e: any) { setMsg(e?.message ?? "Erro ao eliminar"); }
    finally { setBusy(false); }
  }

  async function deleteSelected() {
    if (!selectedIds.length || !confirm(`Eliminar ${selectedIds.length} conta(s)?`)) return;
    setBusy(true); setMsg(null);
    try {
      await Promise.all(selectedIds.map(id => api.accounts.delete(id)));
      setSelected({});
      await reload();
      setMsg("Eliminados ✔");
    } catch (e: any) { setMsg(e?.message ?? "Erro"); }
    finally { setBusy(false); }
  }

  const editing = useMemo(
    () => (editingId ? accounts.find(a => (a as any).id === editingId) ?? null : null),
    [accounts, editingId],
  );

  const typeLabel: Record<string, string> = {
    bank: 'Banco', credit: 'Crédito', voucher: 'Voucher', bonds: 'Obrigações', wallet: 'Wallet', cash: 'Dinheiro',
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-6">
      {/* Left: list */}
      <div className="space-y-4">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <h2 className="text-xl font-semibold">Contas — {selectedEntity.name}</h2>
          <div className="flex gap-2 items-center flex-wrap">
            <Input placeholder="Pesquisar…" value={q} onChange={e => setQ(e.target.value)} />
            <Button variant="secondary" onClick={() => toggleAllFiltered(true)} disabled={busy || !filtered.length}>
              Selecionar tudo
            </Button>
            <Button variant="destructive" onClick={deleteSelected} disabled={busy || !anySelected}>
              Eliminar selecionados
            </Button>
            <Button onClick={() => { setEditingId(null); setFormOpen(true); }} disabled={busy}>
              Nova conta
            </Button>
          </div>
        </div>

        {msg && <div className="text-sm text-emerald-400">{msg}</div>}

        <Card className="overflow-x-auto">
          <table className="min-w-full text-sm text-left">
            <thead>
              <tr className="border-b border-zinc-700 text-zinc-300">
                <th className="px-2 py-2 w-8">
                  <input type="checkbox" onChange={e => toggleAllFiltered(e.target.checked)} checked={allFilteredSelected} />
                </th>
                <th className="px-3 py-2">Código</th>
                <th className="px-3 py-2">Nome</th>
                <th className="px-3 py-2">Tipo</th>
                <th className="px-3 py-2">Saldo</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(a => {
                const id = (a as any).id as string;
                const baseBal = a.balanceCents ?? 0;
                const eventDelta = eventBalances.get(id) ?? 0;
                const bal = baseBal + eventDelta;
                return (
                  <tr key={id} className="border-b border-zinc-800 hover:bg-zinc-800/30">
                    <td className="px-2 py-2">
                      <input type="checkbox" checked={!!selected[id]} onChange={e => setSelected(s => ({ ...s, [id]: e.target.checked }))} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-400">{(a as any).code || '—'}</td>
                    <td className="px-3 py-2 font-medium text-zinc-100">{a.name}</td>
                    <td className="px-3 py-2 text-zinc-400">
                      {typeLabel[a.type] ?? a.type}
                      {a.type === 'voucher' && ` · ${(a as any).voucherType ?? ''}`}
                    </td>
                    <td className="px-3 py-2">
                      <span className={bal !== 0 ? 'text-emerald-400 font-medium' : 'text-zinc-500'}>{formatEUR(bal)}</span>
                      {eventDelta !== 0 && a.balanceCents != null && (
                        <span className="text-xs text-zinc-600 ml-1">(base {formatEUR(baseBal)})</span>
                      )}
                    </td>
                    <td className="px-3 py-2 space-x-3">
                      <button className="text-blue-400 hover:underline" onClick={() => startEdit(id)} disabled={busy}>Editar</button>
                      <button className="text-red-400 hover:underline" onClick={() => deleteOne(id)} disabled={busy}>Eliminar</button>
                    </td>
                  </tr>
                );
              })}
              {!filtered.length && (
                <tr><td colSpan={6} className="px-3 py-8 text-zinc-500 text-center">Sem contas.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>

      {/* Right: form */}
      <div className="xl:sticky xl:top-4 h-fit">
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-base font-medium">{editing ? "Editar conta" : "Nova conta"}</div>
            <button onClick={() => setFormOpen(v => !v)} className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400">
              {formOpen ? "Recolher" : "Expandir"}
            </button>
          </div>
          {formOpen && (
            <AccountForm
              initial={editing}
              onSaved={async () => { setEditingId(null); await reload(); }}
              onCancel={() => setEditingId(null)}
            />
          )}
        </Card>
      </div>
    </div>
  );
}
