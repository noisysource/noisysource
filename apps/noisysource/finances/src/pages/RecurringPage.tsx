import { useEffect, useMemo, useState } from "react";
import type { RecurringEntryDoc, RecurringType, RecurringFrequency } from "@shared/models/RecurringEntry";
import { formatEUR } from "@shared/lib/money";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api } from "../lib/api";
import { useEntity } from "../hooks/EntityContext";

type AccountOpt = { id: string; name: string };
type CategoryOpt = { id: string; name: string };

const TYPE_LABELS: Record<RecurringType, string> = {
  income: "Income",
  expense: "Expense",
  transfer: "Transfer",
};
const FREQ_LABELS: Record<RecurringFrequency, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
  once: "Once",
};
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

type Form = {
  type: RecurringType;
  description: string;
  amountEUR: string;
  accountId: string;
  toAccountId: string;
  categoryId: string;
  frequency: RecurringFrequency;
  dayOfMonth: string;
  monthOfYear: string;
  startYearMonth: string;
  endYearMonth: string;
  onceYearMonth: string;
  active: boolean;
};

const emptyForm = (): Form => ({
  type: "expense",
  description: "",
  amountEUR: "",
  accountId: "",
  toAccountId: "",
  categoryId: "",
  frequency: "monthly",
  dayOfMonth: "1",
  monthOfYear: "1",
  startYearMonth: "",
  endYearMonth: "",
  onceYearMonth: "",
  active: true,
});

function fromDoc(d: RecurringEntryDoc): Form {
  return {
    type: d.type,
    description: d.description,
    amountEUR: (d.amountCents / 100).toFixed(2),
    accountId: d.accountId ?? "",
    toAccountId: d.toAccountId ?? "",
    categoryId: d.categoryId ?? "",
    frequency: d.frequency,
    dayOfMonth: String(d.dayOfMonth),
    monthOfYear: String(d.monthOfYear ?? 1),
    startYearMonth: d.startYearMonth ?? "",
    endYearMonth: d.endYearMonth ?? "",
    onceYearMonth: d.onceYearMonth ?? "",
    active: d.active,
  };
}

export default function RecurringPage() {
  const { selectedEntity } = useEntity();

  const [rows, setRows] = useState<RecurringEntryDoc[]>([]);
  const [accounts, setAccounts] = useState<AccountOpt[]>([]);
  const [categories, setCategories] = useState<CategoryOpt[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm());
  const [formOpen, setFormOpen] = useState(true);

  async function reload() {
    setBusy(true);
    setMsg(null);
    try {
      const [rs, as, cs] = await Promise.all([
        api.recurring.list(),
        api.accounts.list(),
        api.categories.list(),
      ]);
      setRows(rs);
      setAccounts(as.map(a => ({ id: a.id, name: a.name })));
      setCategories(cs.map(c => ({ id: c.id, name: c.name })));
    } catch (e: any) {
      setMsg(e?.message ?? "Failed to load");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void reload(); }, [selectedEntity.id]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => ({ ...f, [k]: v }));

  function startCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setFormOpen(true);
  }

  function startEdit(d: RecurringEntryDoc) {
    setEditingId(d.id);
    setForm(fromDoc(d));
    setFormOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.description.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.recurring.save({
        id: editingId ?? undefined,
        type: form.type,
        description: form.description.trim(),
        amountCents: Math.round(parseFloat(form.amountEUR || "0") * 100),
        accountId: form.accountId || undefined,
        toAccountId: form.type === "transfer" ? (form.toAccountId || undefined) : undefined,
        categoryId: form.categoryId || undefined,
        frequency: form.frequency,
        dayOfMonth: parseInt(form.dayOfMonth || "1", 10),
        monthOfYear: form.frequency === "annual" ? parseInt(form.monthOfYear || "1", 10) : undefined,
        startYearMonth: form.startYearMonth || undefined,
        endYearMonth: form.endYearMonth || undefined,
        onceYearMonth: form.frequency === "once" ? form.onceYearMonth || undefined : undefined,
        active: form.active,
      });
      setEditingId(null);
      setForm(emptyForm());
      await reload();
      setMsg("Saved ✔");
    } catch (e: any) {
      setMsg(e?.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function deleteOne(id: string) {
    if (!confirm("Delete this recurring entry?")) return;
    setBusy(true);
    try {
      await api.recurring.delete(id);
      await reload();
    } catch (e: any) {
      setMsg(e?.message ?? "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  const totals = useMemo(() => {
    const active = rows.filter(r => r.active && r.frequency === "monthly");
    const income = active.filter(r => r.type === "income").reduce((s, r) => s + r.amountCents, 0);
    const expense = active.filter(r => r.type === "expense").reduce((s, r) => s + r.amountCents, 0);
    return { income, expense, net: income - expense };
  }, [rows]);

  const typeColor = (t: RecurringType) =>
    t === "income" ? "text-emerald-400" : t === "expense" ? "text-red-400" : "text-blue-400";

  const accountName = (id?: string) => accounts.find(a => a.id === id)?.name ?? id ?? "—";

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-6">
      {/* LEFT: list */}
      <div className="space-y-4">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-xl font-semibold">Recurring Entries</h2>
            {rows.length > 0 && (
              <div className="text-xs text-zinc-400 mt-1 space-x-4">
                <span>Monthly in: <span className="text-emerald-400">{formatEUR(totals.income)}</span></span>
                <span>Monthly out: <span className="text-red-400">{formatEUR(totals.expense)}</span></span>
                <span>Net: <span className={totals.net >= 0 ? "text-emerald-400" : "text-red-400"}>{formatEUR(totals.net)}</span></span>
              </div>
            )}
          </div>
          <Button onClick={startCreate} disabled={busy}>New entry</Button>
        </div>

        {msg && <div className="text-sm text-emerald-400">{msg}</div>}

        <Card className="overflow-x-auto">
          <table className="min-w-full text-sm text-left">
            <thead>
              <tr className="border-b border-zinc-700 text-zinc-300">
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2">Amount</th>
                <th className="px-3 py-2">Frequency</th>
                <th className="px-3 py-2">Day</th>
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2">Period</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className={`border-b border-zinc-800 ${!r.active ? "opacity-40" : ""}`}>
                  <td className={`px-3 py-2 font-medium ${typeColor(r.type)}`}>{TYPE_LABELS[r.type]}</td>
                  <td className="px-3 py-2">{r.description}</td>
                  <td className="px-3 py-2">{formatEUR(r.amountCents)}</td>
                  <td className="px-3 py-2">{FREQ_LABELS[r.frequency]}</td>
                  <td className="px-3 py-2">
                    {r.frequency === "annual"
                      ? `${MONTHS[(r.monthOfYear ?? 1) - 1]} ${r.dayOfMonth}`
                      : r.frequency === "once"
                      ? r.onceYearMonth
                      : r.dayOfMonth}
                  </td>
                  <td className="px-3 py-2 text-zinc-400 text-xs">
                    {accountName(r.accountId)}
                    {r.type === "transfer" && r.toAccountId ? ` → ${accountName(r.toAccountId)}` : ""}
                  </td>
                  <td className="px-3 py-2 text-zinc-500 text-xs">
                    {r.startYearMonth || "—"} → {r.endYearMonth || "∞"}
                  </td>
                  <td className="px-3 py-2 space-x-3">
                    <button className="text-blue-400 underline" onClick={() => startEdit(r)} disabled={busy}>Edit</button>
                    <button className="text-red-400 underline" onClick={() => deleteOne(r.id)} disabled={busy}>Delete</button>
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={8} className="px-3 py-6 text-zinc-500">No recurring entries yet.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>

      {/* RIGHT: form */}
      <div className="xl:sticky xl:top-4 h-fit">
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-lg font-medium">{editingId ? "Edit entry" : "New entry"}</div>
            <button onClick={() => setFormOpen(v => !v)} className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">
              {formOpen ? "Collapse" : "Expand"}
            </button>
          </div>

          {formOpen && (
            <form onSubmit={save} className="space-y-3">
              {/* Type */}
              <div className="grid grid-cols-3 gap-1">
                {(["expense", "income", "transfer"] as RecurringType[]).map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => set("type", t)}
                    className={`py-1.5 rounded text-sm font-medium border transition-colors ${
                      form.type === t
                        ? t === "income" ? "border-emerald-500 bg-emerald-900 text-emerald-200"
                          : t === "expense" ? "border-red-500 bg-red-900 text-red-200"
                          : "border-blue-500 bg-blue-900 text-blue-200"
                        : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
                    }`}
                  >
                    {TYPE_LABELS[t]}
                  </button>
                ))}
              </div>

              {/* Description */}
              <div>
                <div className="text-xs text-zinc-400 mb-1">Description</div>
                <Input
                  placeholder="e.g. NOS Internet, Salary Renato…"
                  value={form.description}
                  onChange={e => set("description", e.target.value)}
                  required
                />
              </div>

              {/* Amount */}
              <div>
                <div className="text-xs text-zinc-400 mb-1">Amount (€)</div>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={form.amountEUR}
                  onChange={e => set("amountEUR", e.target.value)}
                  required
                />
              </div>

              {/* Accounts */}
              <div>
                <div className="text-xs text-zinc-400 mb-1">{form.type === "transfer" ? "From account" : "Account"}</div>
                <select
                  value={form.accountId}
                  onChange={e => set("accountId", e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
                >
                  <option value="">— none —</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>

              {form.type === "transfer" && (
                <div>
                  <div className="text-xs text-zinc-400 mb-1">To account</div>
                  <select
                    value={form.toAccountId}
                    onChange={e => set("toAccountId", e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
                  >
                    <option value="">— none —</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              )}

              {/* Category */}
              <div>
                <div className="text-xs text-zinc-400 mb-1">Category (optional)</div>
                <select
                  value={form.categoryId}
                  onChange={e => set("categoryId", e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
                >
                  <option value="">— none —</option>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>

              {/* Frequency + Day */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Frequency</div>
                  <select
                    value={form.frequency}
                    onChange={e => set("frequency", e.target.value as RecurringFrequency)}
                    className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
                  >
                    {(Object.keys(FREQ_LABELS) as RecurringFrequency[]).map(f => (
                      <option key={f} value={f}>{FREQ_LABELS[f]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Day of month</div>
                  <Input
                    type="number"
                    min="1"
                    max="31"
                    value={form.dayOfMonth}
                    onChange={e => set("dayOfMonth", e.target.value)}
                  />
                </div>
              </div>

              {/* Annual: month of year */}
              {form.frequency === "annual" && (
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Month</div>
                  <select
                    value={form.monthOfYear}
                    onChange={e => set("monthOfYear", e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
                  >
                    {MONTHS.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
                  </select>
                </div>
              )}

              {/* Once: specific year-month */}
              {form.frequency === "once" && (
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Month (YYYY-MM)</div>
                  <Input
                    type="month"
                    value={form.onceYearMonth}
                    onChange={e => set("onceYearMonth", e.target.value)}
                  />
                </div>
              )}

              {/* Period */}
              {form.frequency !== "once" && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="text-xs text-zinc-400 mb-1">From (YYYY-MM)</div>
                    <Input
                      type="month"
                      value={form.startYearMonth}
                      onChange={e => set("startYearMonth", e.target.value)}
                    />
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400 mb-1">Until (blank = ∞)</div>
                    <Input
                      type="month"
                      value={form.endYearMonth}
                      onChange={e => set("endYearMonth", e.target.value)}
                    />
                  </div>
                </div>
              )}

              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)} />
                Active
              </label>

              <div className="flex gap-2">
                <Button type="submit" className="flex-1" disabled={busy || !form.description.trim()}>
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
