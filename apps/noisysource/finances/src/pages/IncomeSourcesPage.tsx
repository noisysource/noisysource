import { useEffect, useMemo, useState } from "react";
import type { BenefitConfig, IncomeSourceDoc } from "@shared/models/IncomeSource";
import type { Account } from "@shared/models/Account";
import { formatEUR } from "@shared/lib/money";
import { api } from "../lib/api";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { BenefitsEditor } from "../components/BenefitsEditor";

function toEUR(cents: number) { return cents > 0 ? (cents / 100).toFixed(2) : ""; }
function fromEUR(s: string) { return Math.round((parseFloat(s) || 0) * 100); }
function pct(s: string) { return parseFloat(s) || 0; }

const EMPTY_FORM = {
  personName: "",
  employerName: "",
  grossEUR: "",
  irsPct: "",
  ssEmpPct: "11",
  payDay: "25",
  netPayAccountId: "",
  startDate: "",
  notes: "",
  active: true,
  benefits: [] as BenefitConfig[],
};

export default function IncomeSourcesPage() {
  const [sources, setSources]   = useState<IncomeSourceDoc[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const set = <K extends keyof typeof EMPTY_FORM>(k: K, v: (typeof EMPTY_FORM)[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  const bankAccounts = useMemo(() => accounts.filter(a => a.type === "bank"), [accounts]);

  async function reload() {
    const [srcs, accs] = await Promise.all([
      api.incomeSources.list(),
      api.accounts.list(),
    ]);
    setSources(srcs as IncomeSourceDoc[]);
    setAccounts(accs as Account[]);
  }

  useEffect(() => { void reload(); }, []);

  function startNew() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setMsg(null);
  }

  function startEdit(src: IncomeSourceDoc) {
    setMsg(null);
    setEditingId(src.id);
    setForm({
      personName: src.personName,
      employerName: src.employerName,
      grossEUR: toEUR(src.grossMonthlyCents),
      irsPct: String(src.irsRatePct ?? ""),
      ssEmpPct: String(src.ssEmpPct ?? "11"),
      payDay: String(src.payDay ?? "25"),
      netPayAccountId: src.netPayAccountId ?? "",
      startDate: src.startDate ?? "",
      notes: src.notes ?? "",
      active: src.active !== false,
      benefits: Array.isArray(src.benefits) ? src.benefits : [],
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.personName.trim() || !form.employerName.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const payload = {
        id: editingId ?? undefined,
        personName: form.personName.trim(),
        employerName: form.employerName.trim(),
        grossMonthlyCents: fromEUR(form.grossEUR),
        irsRatePct: pct(form.irsPct),
        ssEmpPct: pct(form.ssEmpPct),
        payDay: Math.max(1, Math.min(31, parseInt(form.payDay || "25", 10))),
        netPayAccountId: form.netPayAccountId || "",
        startDate: form.startDate || undefined,
        notes: form.notes || undefined,
        active: form.active,
        benefits: form.benefits,
      };
      const id = await api.incomeSources.save(payload as any);
      setEditingId(id);
      await reload();
      setMsg("Guardado ✔");
    } catch (e: any) {
      setMsg(e?.message ?? "Erro ao guardar");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSource(id: string) {
    if (!confirm("Eliminar esta fonte de rendimento?")) return;
    setBusy(true);
    try {
      await api.incomeSources.delete(id);
      if (editingId === id) startNew();
      await reload();
    } catch (e: any) {
      setMsg(e?.message ?? "Erro ao eliminar");
    } finally {
      setBusy(false);
    }
  }

  // Net income breakdown shown while filling in the form
  const breakdown = useMemo(() => {
    const gross = fromEUR(form.grossEUR);
    if (!gross) return null;
    const irs = Math.round(gross * pct(form.irsPct) / 100);
    const ss = Math.round(gross * pct(form.ssEmpPct) / 100);
    return { gross, irs, ss, net: gross - irs - ss };
  }, [form.grossEUR, form.irsPct, form.ssEmpPct]);

  // Group sources by person for the right panel
  const byPerson = useMemo(() => {
    const map = new Map<string, IncomeSourceDoc[]>();
    for (const s of sources) {
      const list = map.get(s.personName) ?? [];
      list.push(s);
      map.set(s.personName, list);
    }
    return map;
  }, [sources]);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-6">
      {/* LEFT: form */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Fontes de Rendimento</h2>
        <p className="text-sm text-zinc-500">
          Empregadores externos — o processamento é feito pela entidade patronal; aqui configura-se apenas o fluxo para as contas privadas.
        </p>

        <Card className="p-4">
          <form onSubmit={save} className="space-y-4">

            {/* Person + employer */}
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-zinc-400 mb-1">Pessoa</div>
                <input
                  list="persons-list"
                  className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1 text-sm"
                  placeholder="Renato / Marisa"
                  value={form.personName}
                  onChange={e => set("personName", e.target.value)}
                  required
                />
                <datalist id="persons-list">
                  <option value="Renato" />
                  <option value="Marisa" />
                </datalist>
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">Empregador</div>
                <Input
                  placeholder="Exquisite Talent / ASFD"
                  value={form.employerName}
                  onChange={e => set("employerName", e.target.value)}
                  required
                />
              </div>
            </div>

            {/* Gross + pay day */}
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-zinc-400 mb-1">Vencimento bruto (€)</div>
                <Input
                  type="number" step="0.01" placeholder="0.00"
                  value={form.grossEUR}
                  onChange={e => set("grossEUR", e.target.value)}
                />
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">Dia de pagamento</div>
                <Input
                  type="number" min={1} max={31}
                  value={form.payDay}
                  onChange={e => set("payDay", e.target.value)}
                />
              </div>
            </div>

            {/* IRS + SS */}
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-zinc-400 mb-1">IRS retido %</div>
                <Input
                  type="number" step="0.1" placeholder="15"
                  value={form.irsPct}
                  onChange={e => set("irsPct", e.target.value)}
                />
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">SS trabalhador %</div>
                <Input
                  type="number" step="0.01"
                  value={form.ssEmpPct}
                  onChange={e => set("ssEmpPct", e.target.value)}
                />
              </div>
            </div>

            {/* Breakdown */}
            {breakdown && (
              <div className="rounded bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm space-y-1">
                <div className="flex justify-between text-zinc-300">
                  <span>Bruto</span>
                  <span>{formatEUR(breakdown.gross)}</span>
                </div>
                <div className="flex justify-between text-red-400/80">
                  <span>IRS ({form.irsPct || 0}%)</span>
                  <span>− {formatEUR(breakdown.irs)}</span>
                </div>
                <div className="flex justify-between text-red-400/80">
                  <span>SS ({form.ssEmpPct || 0}%)</span>
                  <span>− {formatEUR(breakdown.ss)}</span>
                </div>
                <div className="flex justify-between font-semibold text-emerald-400 border-t border-zinc-800 pt-1">
                  <span>Líquido estimado</span>
                  <span>{formatEUR(breakdown.net)}</span>
                </div>
              </div>
            )}

            {/* Net pay account */}
            <div>
              <div className="text-xs text-zinc-400 mb-1">Conta de destino (líquido)</div>
              <select
                value={form.netPayAccountId}
                onChange={e => set("netPayAccountId", e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
              >
                <option value="">— selecionar —</option>
                {bankAccounts.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>

            {/* Benefits */}
            <div>
              <div className="text-sm font-medium mb-2">Benefícios</div>
              <BenefitsEditor
                benefits={form.benefits}
                accountsForPerson={accounts}
                onChange={v => set("benefits", v)}
              />
            </div>

            {/* Start date + notes */}
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-zinc-400 mb-1">Data de início</div>
                <Input type="date" value={form.startDate} onChange={e => set("startDate", e.target.value)} />
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">Notas</div>
                <Input placeholder="opcional" value={form.notes} onChange={e => set("notes", e.target.value)} />
              </div>
            </div>

            <div className="flex items-center gap-4 pt-1 flex-wrap">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)} />
                Ativo
              </label>
              <Button
                type="submit"
                disabled={busy || !form.personName.trim() || !form.employerName.trim()}
              >
                {editingId ? "Guardar alterações" : "Criar"}
              </Button>
              {editingId && (
                <Button type="button" variant="secondary" onClick={startNew}>Cancelar</Button>
              )}
              {msg && <span className="text-sm text-emerald-400">{msg}</span>}
            </div>
          </form>
        </Card>
      </div>

      {/* RIGHT: list */}
      <div className="xl:sticky xl:top-4 h-fit">
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-medium text-zinc-300">Fontes configuradas</div>
            <Button variant="secondary" onClick={startNew} type="button" disabled={!editingId}>Nova</Button>
          </div>

          {sources.length === 0 ? (
            <div className="text-sm text-zinc-500">Nenhuma fonte configurada.</div>
          ) : (
            <div className="space-y-4">
              {Array.from(byPerson.entries()).map(([person, srcs]) => (
                <div key={person}>
                  <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">{person}</div>
                  <div className="space-y-2">
                    {srcs.map(s => (
                      <div
                        key={s.id}
                        className={`rounded border px-3 py-2 ${editingId === s.id ? "border-emerald-600 bg-emerald-950/30" : "border-zinc-800 bg-zinc-900"}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">{s.employerName}</div>
                            <div className="text-xs text-zinc-500 mt-0.5">
                              {formatEUR(s.grossMonthlyCents)}/mês · dia {s.payDay}
                              {s.active === false && " · inativo"}
                            </div>
                            {s.benefits.length > 0 && (
                              <div className="text-xs text-zinc-600 mt-0.5">
                                {s.benefits.length} benefício{s.benefits.length > 1 ? "s" : ""}
                              </div>
                            )}
                          </div>
                          <div className="flex gap-2 text-xs shrink-0">
                            <button className="text-blue-400 underline" onClick={() => startEdit(s)}>Editar</button>
                            <button className="text-red-400 underline" onClick={() => deleteSource(s.id)}>Eliminar</button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
