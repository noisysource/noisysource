import { useEffect, useMemo, useState } from "react";
import type { EcContractDoc } from "@shared/models/EcContract";
import { estimatedMonthlyInvoiceCents } from "@shared/models/EcContract";
import { formatEUR } from "@shared/lib/money";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api } from "../lib/api";
import { useEntity } from "../hooks/EntityContext";
import { syncEcContractRecurring, deactivateEcContractRecurring } from "../lib/contractSync";

type FormState = {
  clientName: string;
  projectName: string;
  dailyRateEUR: string;
  totalDays: string;
  expectedDays: string;
  startDate: string;
  endDate: string;
  active: boolean;
};

const empty = (): FormState => ({
  clientName: "",
  projectName: "",
  dailyRateEUR: "",
  totalDays: "",
  expectedDays: "",
  startDate: "",
  endDate: "",
  active: true,
});

function fromDoc(d: EcContractDoc): FormState {
  return {
    clientName: d.clientName,
    projectName: d.projectName ?? "",
    dailyRateEUR: (d.dailyRateCents / 100).toFixed(2),
    totalDays: d.totalDays ? String(d.totalDays) : "",
    expectedDays: String(d.expectedDaysPerMonth),
    startDate: d.startDate ? d.startDate.toISOString().slice(0, 10) : "",
    endDate: d.endDate ? d.endDate.toISOString().slice(0, 10) : "",
    active: d.active,
  };
}

export default function EcContractsPage() {
  const { selectedEntity } = useEntity();

  const [rows, setRows] = useState<EcContractDoc[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(empty());
  const [formOpen, setFormOpen] = useState(true);

  async function reload() {
    setBusy(true);
    setMsg(null);
    try {
      setRows(await api.ecContracts.list());
    } catch (e: any) {
      setMsg(e?.message ?? "Failed to load");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void reload(); }, [selectedEntity.id]);

  function startCreate() {
    setEditingId(null);
    setForm(empty());
    setFormOpen(true);
  }

  function startEdit(d: EcContractDoc) {
    setEditingId(d.id);
    setForm(fromDoc(d));
    setFormOpen(true);
  }

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.clientName.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const dailyRateCents = Math.round(parseFloat(form.dailyRateEUR || "0") * 100);
      const totalDays = form.totalDays ? parseInt(form.totalDays, 10) : undefined;
      const expectedDaysPerMonth = parseFloat(form.expectedDays || "0");
      const id = await api.ecContracts.save({
        id: editingId ?? undefined,
        clientName: form.clientName.trim(),
        projectName: form.projectName.trim() || undefined,
        dailyRateCents,
        totalDays,
        expectedDaysPerMonth,
        startDate: form.startDate ? new Date(form.startDate) : undefined,
        endDate: form.endDate ? new Date(form.endDate) : undefined,
        active: form.active,
      });
      const saved = await api.ecContracts.get(id);
      if (saved) await syncEcContractRecurring(saved);
      setEditingId(null);
      setForm(empty());
      await reload();
      setMsg("Saved ✔  — Recurring updated");
    } catch (e: any) {
      setMsg(e?.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function deleteOne(id: string) {
    if (!confirm("Delete this contract?")) return;
    setBusy(true);
    try {
      await deactivateEcContractRecurring(id);
      await api.ecContracts.delete(id);
      await reload();
    } catch (e: any) {
      setMsg(e?.message ?? "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  const totalEstimated = useMemo(
    () => rows.filter(r => r.active).reduce((s, r) => s + estimatedMonthlyInvoiceCents(r), 0),
    [rows]
  );

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-6">
      {/* LEFT: list */}
      <div className="space-y-4">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-xl font-semibold">EC Contracts — Revenue</h2>
            {rows.length > 0 && (
              <div className="text-sm text-zinc-400 mt-1">
                Active estimated monthly: <span className="text-white font-medium">{formatEUR(totalEstimated)}</span>
              </div>
            )}
          </div>
          <Button onClick={startCreate} disabled={busy}>New contract</Button>
        </div>

        {msg && <div className="text-sm text-emerald-400">{msg}</div>}

        <Card className="overflow-x-auto">
          <table className="min-w-full text-sm text-left">
            <thead>
              <tr className="border-b border-zinc-700 text-zinc-300">
                <th className="px-3 py-2">Client</th>
                <th className="px-3 py-2">Project</th>
                <th className="px-3 py-2">Daily rate</th>
                <th className="px-3 py-2">Total days</th>
                <th className="px-3 py-2">Est. days/mo</th>
                <th className="px-3 py-2">Est. monthly</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className={`border-b border-zinc-800 ${!r.active ? "opacity-50" : ""}`}>
                  <td className="px-3 py-2 font-medium">{r.clientName}</td>
                  <td className="px-3 py-2 text-zinc-400">{r.projectName || "—"}</td>
                  <td className="px-3 py-2">{formatEUR(r.dailyRateCents)}</td>
                  <td className="px-3 py-2">
                    {r.totalDays ? (
                      <span title={`Total: ${formatEUR(r.dailyRateCents * r.totalDays)}`}>{r.totalDays}d</span>
                    ) : "—"}
                  </td>
                  <td className="px-3 py-2">{r.expectedDaysPerMonth}</td>
                  <td className="px-3 py-2 font-medium text-emerald-400">{formatEUR(estimatedMonthlyInvoiceCents(r))}</td>
                  <td className="px-3 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded ${r.active ? "bg-emerald-900 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}>
                      {r.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-3 py-2 space-x-3">
                    <button className="text-blue-400 underline" onClick={() => startEdit(r)} disabled={busy}>Edit</button>
                    <button className="text-red-400 underline" onClick={() => deleteOne(r.id)} disabled={busy}>Delete</button>
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={7} className="px-3 py-6 text-zinc-500">No EC contracts. Add one to start forecasting NoisySource revenue.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>

      {/* RIGHT: form */}
      <div className="xl:sticky xl:top-4 h-fit">
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-lg font-medium">{editingId ? "Edit contract" : "New contract"}</div>
            <button
              onClick={() => setFormOpen(v => !v)}
              className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700"
            >
              {formOpen ? "Collapse" : "Expand"}
            </button>
          </div>

          {formOpen && (
            <form onSubmit={save} className="space-y-3">
              <div>
                <div className="text-xs text-zinc-400 mb-1">Client</div>
                <Input
                  placeholder="Client name"
                  value={form.clientName}
                  onChange={e => set("clientName", e.target.value)}
                  required
                />
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">Project (optional)</div>
                <Input
                  placeholder="Project / framework"
                  value={form.projectName}
                  onChange={e => set("projectName", e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Daily rate (€)</div>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={form.dailyRateEUR}
                    onChange={e => set("dailyRateEUR", e.target.value)}
                    required
                  />
                </div>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Total days</div>
                  <Input
                    type="number"
                    placeholder="—"
                    value={form.totalDays}
                    onChange={e => set("totalDays", e.target.value)}
                  />
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">Est. days/month</div>
                <Input
                  type="number"
                  step="0.5"
                  placeholder="20"
                  value={form.expectedDays}
                  onChange={e => set("expectedDays", e.target.value)}
                  required
                />
              </div>

              {form.dailyRateEUR && (form.expectedDays || form.totalDays) && (
                <div className="text-sm text-zinc-300 bg-zinc-900 rounded px-3 py-2 space-y-0.5">
                  {form.expectedDays && (
                    <div>Est. monthly: <span className="text-emerald-400 font-semibold">
                      {formatEUR(Math.round(parseFloat(form.dailyRateEUR || "0") * 100) * parseFloat(form.expectedDays || "0"))}
                    </span></div>
                  )}
                  {form.totalDays && (
                    <div>Total contract value: <span className="text-emerald-400 font-semibold">
                      {formatEUR(Math.round(parseFloat(form.dailyRateEUR || "0") * 100) * parseInt(form.totalDays || "0", 10))}
                    </span></div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Start date</div>
                  <Input type="date" value={form.startDate} onChange={e => set("startDate", e.target.value)} />
                </div>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">End date</div>
                  <Input type="date" value={form.endDate} onChange={e => set("endDate", e.target.value)} />
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={e => set("active", e.target.checked)}
                />
                Active
              </label>

              <div className="flex gap-2">
                <Button type="submit" className="flex-1" disabled={busy || !form.clientName.trim()}>
                  {editingId ? "Update" : "Create"}
                </Button>
                {editingId && (
                  <Button type="button" variant="secondary" className="flex-1" onClick={startCreate}>
                    Cancel
                  </Button>
                )}
              </div>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
