import { useEffect, useMemo, useState } from "react";
import type { EcContractDoc } from "@shared/models/EcContract";
import { estimatedMonthlyInvoiceCents } from "@shared/models/EcContract";
import { formatEUR } from "@shared/lib/money";
import { computeEcProjection } from "@shared/lib/ecProjection";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api } from "../lib/api";
import { useEntity } from "../hooks/EntityContext";
import { syncEcContractRecurring, deactivateEcContractRecurring } from "../lib/contractSync";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Convert a Date to a local YYYY-MM-DD string (avoids UTC-offset issues). */
function dateToIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Format an ISO date as "sex., 25 de dez. de 2026" in pt-PT. */
function formatChipDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("pt-PT", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Format YYYY-MM as "mar. 2026" in pt-PT. */
function formatYearMonth(ym: string): string {
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("pt-PT", {
    month: "short",
    year: "numeric",
  });
}

/** Today as YYYY-MM */
function todayYearMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// ── types ─────────────────────────────────────────────────────────────────────

type FormState = {
  clientName: string;
  projectName: string;
  dailyRateEUR: string;
  totalDays: string;
  expectedDays: string;
  startDate: string;
  endDate: string;
  active: boolean;
  nonWorkingDays: string[];
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
  nonWorkingDays: [],
});

function fromDoc(d: EcContractDoc): FormState {
  return {
    clientName: d.clientName,
    projectName: d.projectName ?? "",
    dailyRateEUR: (d.dailyRateCents / 100).toFixed(2),
    totalDays: d.totalDays ? String(d.totalDays) : "",
    expectedDays: String(d.expectedDaysPerMonth),
    startDate: d.startDate ? dateToIso(d.startDate) : "",
    endDate: d.endDate ? dateToIso(d.endDate) : "",
    active: d.active,
    nonWorkingDays: d.nonWorkingDays ? [...d.nonWorkingDays].sort() : [],
  };
}

// ── component ─────────────────────────────────────────────────────────────────

export default function EcContractsPage() {
  const { selectedEntity } = useEntity();

  const [rows, setRows] = useState<EcContractDoc[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(empty());
  const [formOpen, setFormOpen] = useState(true);

  // Non-working day date input
  const [nwdInput, setNwdInput] = useState("");

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
    setNwdInput("");
    setFormOpen(true);
  }

  function startEdit(d: EcContractDoc) {
    setEditingId(d.id);
    setForm(fromDoc(d));
    setNwdInput("");
    setFormOpen(true);
  }

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  function addNwd() {
    const iso = nwdInput.trim();
    if (!iso || form.nonWorkingDays.includes(iso)) return;
    set("nonWorkingDays", [...form.nonWorkingDays, iso].sort());
    setNwdInput("");
  }

  function removeNwd(iso: string) {
    set("nonWorkingDays", form.nonWorkingDays.filter(d => d !== iso));
  }

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
        nonWorkingDays: form.nonWorkingDays.length > 0 ? form.nonWorkingDays : undefined,
      });
      const saved = await api.ecContracts.get(id);
      if (saved) await syncEcContractRecurring(saved);
      setEditingId(null);
      setForm(empty());
      setNwdInput("");
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

  // Compute the projection live from form state (re-runs whenever form fields change)
  const projection = useMemo(() => {
    if (!form.startDate || !form.totalDays) return null;
    const dailyRateCents = Math.round(parseFloat(form.dailyRateEUR || "0") * 100);
    const totalDays = parseInt(form.totalDays, 10);
    if (!dailyRateCents || !totalDays || totalDays <= 0) return null;
    try {
      return computeEcProjection(
        { startDate: form.startDate, dailyRateCents, totalDays },
        form.nonWorkingDays,
        new Date(),
      );
    } catch {
      return null;
    }
  }, [form.startDate, form.dailyRateEUR, form.totalDays, form.nonWorkingDays]);

  const currentYM = todayYearMonth();

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-6">
      {/* LEFT: list */}
      <div className="space-y-4">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-xl font-semibold">EC Contracts — Revenue</h2>
            {rows.length > 0 && (
              <div className="text-sm text-zinc-400 mt-1">
                Active estimated monthly:{" "}
                <span className="text-white font-medium">{formatEUR(totalEstimated)}</span>
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
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-zinc-500">
                    No EC contracts. Add one to start forecasting NoisySource revenue.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>

      {/* RIGHT: form + projection */}
      <div className="xl:sticky xl:top-4 h-fit space-y-4">
        {/* Form card */}
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
                    <div>
                      Est. monthly:{" "}
                      <span className="text-emerald-400 font-semibold">
                        {formatEUR(Math.round(parseFloat(form.dailyRateEUR || "0") * 100) * parseFloat(form.expectedDays || "0"))}
                      </span>
                    </div>
                  )}
                  {form.totalDays && (
                    <div>
                      Total contract value:{" "}
                      <span className="text-emerald-400 font-semibold">
                        {formatEUR(Math.round(parseFloat(form.dailyRateEUR || "0") * 100) * parseInt(form.totalDays || "0", 10))}
                      </span>
                    </div>
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

              {/* Non-working days */}
              <div>
                <div className="text-xs text-zinc-400 mb-1">Dias não trabalhados</div>
                <div className="flex gap-2">
                  <Input
                    type="date"
                    value={nwdInput}
                    onChange={e => setNwdInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addNwd(); } }}
                    className="flex-1 min-w-0"
                  />
                  <button
                    type="button"
                    onClick={addNwd}
                    className="shrink-0 text-xs px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 whitespace-nowrap"
                  >
                    Adicionar
                  </button>
                </div>
                {form.nonWorkingDays.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {form.nonWorkingDays.map(iso => (
                      <span
                        key={iso}
                        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-950 text-red-300 border border-red-800"
                      >
                        {formatChipDate(iso)}
                        <button
                          type="button"
                          onClick={() => removeNwd(iso)}
                          className="ml-0.5 text-red-400 hover:text-red-200 leading-none"
                          aria-label={`Remove ${iso}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
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

        {/* Projection card — only rendered when there is enough data */}
        {projection && (
          <Card className="p-4 space-y-4">
            <div className="text-base font-medium text-zinc-100">Projeção do Contrato</div>

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="bg-zinc-900 rounded px-3 py-2">
                <div className="text-xs text-zinc-400 mb-0.5">Dias contratados</div>
                <div className="font-semibold text-white">{projection.totalContractWorkingDays}</div>
              </div>
              <div className="bg-zinc-900 rounded px-3 py-2">
                <div className="text-xs text-zinc-400 mb-0.5">Dias trabalhados</div>
                <div className="font-semibold text-white">{projection.workedDays}</div>
              </div>
              <div className="bg-zinc-900 rounded px-3 py-2">
                <div className="text-xs text-zinc-400 mb-0.5">Dias restantes</div>
                <div className="font-semibold text-white">{projection.remainingDays}</div>
              </div>
              <div className="bg-zinc-900 rounded px-3 py-2">
                <div className="text-xs text-zinc-400 mb-0.5">Fim previsto</div>
                <div className="font-semibold text-white">
                  {new Date(`${projection.contractEndDate}T12:00:00`).toLocaleDateString("pt-PT", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                  })}
                </div>
              </div>
            </div>

            {/* Earnings */}
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="bg-zinc-900 rounded px-3 py-2">
                <div className="text-xs text-zinc-400 mb-0.5">Ganhos até hoje</div>
                <div className="font-semibold text-emerald-400">{formatEUR(projection.earnedCents)}</div>
              </div>
              <div className="bg-zinc-900 rounded px-3 py-2">
                <div className="text-xs text-zinc-400 mb-0.5">Total previsto</div>
                <div className="font-semibold text-emerald-400">{formatEUR(projection.projectedTotalCents)}</div>
              </div>
            </div>

            {/* Month-by-month breakdown */}
            <div>
              <div className="text-xs text-zinc-400 mb-2">Mês a mês</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="border-b border-zinc-700 text-zinc-400 text-xs">
                      <th className="pb-1.5 pr-3 font-normal">Mês</th>
                      <th className="pb-1.5 pr-3 text-right font-normal">Dias úteis</th>
                      <th className="pb-1.5 text-right font-normal">Rendimento</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projection.monthBreakdown.map(mb => {
                      const isPast = mb.yearMonth < currentYM;
                      const isCurrent = mb.yearMonth === currentYM;
                      return (
                        <tr
                          key={mb.yearMonth}
                          className={[
                            "border-b border-zinc-800/60",
                            isPast ? "opacity-50" : "",
                            isCurrent ? "bg-zinc-800/40" : "",
                          ].join(" ")}
                        >
                          <td className={`py-1.5 pr-3 ${isCurrent ? "font-semibold text-zinc-100" : ""}`}>
                            {formatYearMonth(mb.yearMonth)}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{mb.workingDays}</td>
                          <td
                            className={[
                              "py-1.5 text-right tabular-nums",
                              isCurrent ? "text-emerald-400 font-semibold" : isPast ? "" : "text-zinc-200",
                            ].join(" ")}
                          >
                            {formatEUR(mb.incomeCents)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
