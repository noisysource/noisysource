import { useEffect, useMemo, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import type { BenefitConfig, IncomeSourceDoc } from "@shared/models/IncomeSource";
import type { EmploymentContractDoc } from "@shared/models/Employment";
import type { Account } from "@shared/models/Account";
import { formatEUR } from "@shared/lib/money";
import { db } from "../lib/firebase";
import { api } from "../lib/api";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { BenefitsEditor } from "../components/BenefitsEditor";
import { syncIncomeSourceRecurring } from "../lib/contractSync";
import { Plus, Pencil, Trash2, Lock } from "lucide-react";
import type { BenefitConfig } from "@shared/models/Employment";

// ── benefit helpers ───────────────────────────────────────────────────────────
const MEAL_TYPES = new Set(['MEAL', 'MEAL_CARD', 'MEAL_VOUCHER']);

function benefitMonthlyCents(b: BenefitConfig): number {
  if (MEAL_TYPES.has((b.type ?? '').toUpperCase())) {
    return (b.perDayCents ?? 0) * (b.daysPerMonth ?? 22);
  }
  return b.perMonthCents ?? 0;
}

function netCents(gross: number, irsPct: number, ssPct: number) {
  return gross - Math.round(gross * irsPct / 100) - Math.round(gross * ssPct / 100);
}

// ── helpers ───────────────────────────────────────────────────────────────────
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
  endDate: "",
  notes: "",
  active: true,
  benefits: [] as BenefitConfig[],
};

type FlowingContract = EmploymentContractDoc & { personName: string; companyName: string };

// ── Breakdown row component ───────────────────────────────────────────────────
type Breakdown = { gross: number; irs: number; ss: number; net: number; meal: number; childcare: number; education: number; allowance: number };

function IncomeBreakdownRow({ bd }: { bd: Breakdown }) {
  const hasVouchers = bd.meal + bd.childcare + bd.education + bd.allowance > 0;
  return (
    <div className="space-y-2">
      {/* Gross → taxes → net */}
      <div className="grid grid-cols-4 gap-2 text-xs">
        <div>
          <div className="text-zinc-500 mb-0.5">Bruto</div>
          <div className="font-mono font-semibold text-zinc-200">{formatEUR(bd.gross)}</div>
        </div>
        <div>
          <div className="text-zinc-500 mb-0.5">IRS</div>
          <div className="font-mono text-red-400">− {formatEUR(bd.irs)}</div>
        </div>
        <div>
          <div className="text-zinc-500 mb-0.5">SS</div>
          <div className="font-mono text-red-400">− {formatEUR(bd.ss)}</div>
        </div>
        <div>
          <div className="text-zinc-500 mb-0.5">💳 Líquido</div>
          <div className="font-mono font-semibold text-emerald-400">{formatEUR(bd.net)}</div>
        </div>
      </div>
      {/* Vouchers */}
      {hasVouchers && (
        <div className="flex flex-wrap gap-3 pt-1 border-t border-zinc-800/60 text-xs">
          {bd.meal > 0      && <span className="text-zinc-400">🍽 <span className="text-amber-400 font-mono">{formatEUR(bd.meal)}</span></span>}
          {bd.childcare > 0 && <span className="text-zinc-400">👶 <span className="text-amber-400 font-mono">{formatEUR(bd.childcare)}</span></span>}
          {bd.education > 0 && <span className="text-zinc-400">📚 <span className="text-amber-400 font-mono">{formatEUR(bd.education)}</span></span>}
          {bd.allowance > 0 && <span className="text-zinc-400">🧾 <span className="text-blue-400 font-mono">{formatEUR(bd.allowance)}</span></span>}
        </div>
      )}
    </div>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function IncomeSourceModal({
  editingId, initial, accounts, onSave, onClose,
}: {
  editingId: string | null;
  initial: typeof EMPTY_FORM;
  accounts: Account[];
  onSave: (form: typeof EMPTY_FORM, id: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = <K extends keyof typeof EMPTY_FORM>(k: K, v: (typeof EMPTY_FORM)[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  const bankAccounts = useMemo(() => accounts.filter(a => a.type === "bank"), [accounts]);

  const breakdown = useMemo(() => {
    const gross = fromEUR(form.grossEUR);
    if (!gross) return null;
    const irs = Math.round(gross * pct(form.irsPct) / 100);
    const ss  = Math.round(gross * pct(form.ssEmpPct) / 100);
    return { gross, irs, ss, net: gross - irs - ss };
  }, [form.grossEUR, form.irsPct, form.ssEmpPct]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.personName.trim() || !form.employerName.trim()) return;
    setBusy(true); setErr(null);
    try { await onSave(form, editingId); onClose(); }
    catch (e: any) { setErr(e?.message ?? 'Erro ao guardar'); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <Card className="w-full max-w-lg p-5 overflow-y-auto max-h-[90vh]">
        <div className="text-base font-semibold mb-4">
          {editingId ? 'Editar fonte de rendimento' : 'Nova fonte de rendimento'}
        </div>
        <form onSubmit={submit} className="space-y-4">

          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-zinc-400 mb-1">Pessoa</div>
              <input
                list="persons-list"
                className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1 text-sm"
                placeholder="Renato / Marisa"
                value={form.personName}
                onChange={e => set("personName", e.target.value)}
                required autoFocus
              />
              <datalist id="persons-list">
                <option value="Renato" /><option value="Marisa" />
              </datalist>
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Empregador</div>
              <Input placeholder="Exquisite Talent / ASFD"
                value={form.employerName} onChange={e => set("employerName", e.target.value)} required />
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-zinc-400 mb-1">Vencimento bruto (€)</div>
              <Input type="number" step="0.01" placeholder="0.00"
                value={form.grossEUR} onChange={e => set("grossEUR", e.target.value)} />
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Dia de pagamento</div>
              <Input type="number" min={1} max={31}
                value={form.payDay} onChange={e => set("payDay", e.target.value)} />
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-zinc-400 mb-1">IRS retido %</div>
              <Input type="number" step="0.1" placeholder="15"
                value={form.irsPct} onChange={e => set("irsPct", e.target.value)} />
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">SS trabalhador %</div>
              <Input type="number" step="0.01"
                value={form.ssEmpPct} onChange={e => set("ssEmpPct", e.target.value)} />
            </div>
          </div>

          {/* Live breakdown */}
          {breakdown && (
            <div className="rounded bg-zinc-900/80 border border-zinc-800 px-3 py-2 text-sm space-y-1">
              <div className="flex justify-between text-zinc-300">
                <span>Bruto</span><span>{formatEUR(breakdown.gross)}</span>
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
                <span>Líquido estimado</span><span>{formatEUR(breakdown.net)}</span>
              </div>
            </div>
          )}

          <div>
            <div className="text-xs text-zinc-400 mb-1">Conta de destino (líquido)</div>
            <select value={form.netPayAccountId} onChange={e => set("netPayAccountId", e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1 text-sm">
              <option value="">— selecionar —</option>
              {bankAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>

          <div>
            <div className="text-sm font-medium mb-2">Benefícios</div>
            <BenefitsEditor benefits={form.benefits} accountsForPerson={accounts}
              onChange={v => set("benefits", v)} />
          </div>

          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <div className="text-xs text-zinc-400 mb-1">Data de início</div>
              <Input type="date" value={form.startDate} onChange={e => set("startDate", e.target.value)} />
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Data de fim (opcional)</div>
              <Input type="date" value={form.endDate} onChange={e => set("endDate", e.target.value)} />
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Notas</div>
              <Input placeholder="opcional" value={form.notes} onChange={e => set("notes", e.target.value)} />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)} />
            Ativo
          </label>

          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex gap-2 pt-1">
            <Button type="submit" className="flex-1" disabled={busy}>
              {editingId ? 'Guardar' : 'Criar'}
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function IncomeSourcesPage() {
  const [sources, setSources]   = useState<IncomeSourceDoc[]>([]);
  const [flowing, setFlowing]   = useState<FlowingContract[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading]   = useState(true);
  const [modalOpen, setModalOpen]   = useState(false);
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [formInit, setFormInit]     = useState(EMPTY_FORM);

  async function reload() {
    const [srcs, accs, people, companies, contractsSnap] = await Promise.all([
      api.incomeSources.list(),
      api.accounts.list(),
      api.people.list() as Promise<{ id: string; name: string }[]>,
      api.companies.list() as Promise<{ id: string; name: string }[]>,
      getDocs(collection(db, 'finances_entities', 'noisysource', 'employmentContracts')),
    ]);
    setSources(srcs as IncomeSourceDoc[]);
    setAccounts(accs as Account[]);

    const peopleMap = Object.fromEntries(people.map(p => [p.id, p.name]));
    const companyMap = Object.fromEntries(companies.map(c => [c.id, c.name]));
    setFlowing(
      contractsSnap.docs
        .map(d => ({ id: d.id, ...d.data() } as EmploymentContractDoc))
        .filter(c => c.flowToPrivate && c.active !== false)
        .map(c => ({ ...c, personName: peopleMap[c.personId] ?? c.personId, companyName: companyMap[c.companyId] ?? c.companyId }))
    );
    setLoading(false);
  }

  useEffect(() => { void reload(); }, []);

  function openNew() {
    setEditingId(null);
    setFormInit(EMPTY_FORM);
    setModalOpen(true);
  }

  function openEdit(src: IncomeSourceDoc) {
    setEditingId(src.id);
    setFormInit({
      personName: src.personName,
      employerName: src.employerName,
      grossEUR: toEUR(src.grossMonthlyCents),
      irsPct: String(src.irsRatePct ?? ""),
      ssEmpPct: String(src.ssEmpPct ?? "11"),
      payDay: String(src.payDay ?? "25"),
      netPayAccountId: src.netPayAccountId ?? "",
      startDate: src.startDate ?? "",
      endDate: src.endDate ?? "",
      notes: src.notes ?? "",
      active: src.active !== false,
      benefits: Array.isArray(src.benefits) ? src.benefits : [],
    });
    setModalOpen(true);
  }

  async function handleSave(form: typeof EMPTY_FORM, id: string | null) {
    const payload = {
      id: id ?? undefined,
      personName: form.personName.trim(),
      employerName: form.employerName.trim(),
      grossMonthlyCents: fromEUR(form.grossEUR),
      irsRatePct: pct(form.irsPct),
      ssEmpPct: pct(form.ssEmpPct),
      payDay: Math.max(1, Math.min(31, parseInt(form.payDay || "25", 10))),
      netPayAccountId: form.netPayAccountId || "",
      startDate: form.startDate || undefined,
      endDate: form.endDate || undefined,
      notes: form.notes || undefined,
      active: form.active,
      benefits: form.benefits,
    };
    const savedId = await api.incomeSources.save(payload as any);
    await syncIncomeSourceRecurring({ ...payload, id: savedId } as IncomeSourceDoc);
    await reload();
  }

  async function deleteSource(id: string) {
    if (!confirm('Eliminar esta fonte de rendimento?')) return;
    await api.incomeSources.delete(id);
    await reload();
  }

  // Group all income by person
  const byPerson = useMemo(() => {
    const map = new Map<string, { sources: IncomeSourceDoc[]; contracts: FlowingContract[] }>();
    const get = (name: string) => {
      if (!map.has(name)) map.set(name, { sources: [], contracts: [] });
      return map.get(name)!;
    };
    for (const s of sources) get(s.personName).sources.push(s);
    for (const c of flowing) get(c.personName).contracts.push(c);
    return map;
  }, [sources, flowing]);

  // Monthly income breakdown by type
  const summary = useMemo(() => {
    let gross = 0, irs = 0, ss = 0, cash = 0;
    let meal = 0, childcare = 0, education = 0, allowance = 0;

    const addBenefits = (benefits: BenefitConfig[]) => {
      for (const b of benefits) {
        const t = (b.type ?? '').toUpperCase();
        const amt = benefitMonthlyCents(b);
        if (MEAL_TYPES.has(t))              meal      += amt;
        else if (t === 'CHILDCARE')         childcare += amt;
        else if (t === 'EDUCATION')         education += amt;
        else if (t === 'EXPENSE_ALLOWANCE') allowance += amt;
      }
    };

    const addSource = (g: number, irsPct: number, ssPct: number, benefits: BenefitConfig[]) => {
      const irsAmt = Math.round(g * irsPct / 100);
      const ssAmt  = Math.round(g * ssPct  / 100);
      gross += g;
      irs   += irsAmt;
      ss    += ssAmt;
      cash  += g - irsAmt - ssAmt;
      addBenefits(benefits);
    };

    for (const s of sources) {
      if (s.active === false) continue;
      addSource(s.grossMonthlyCents, s.irsRatePct ?? 0, s.ssEmpPct ?? 11, s.benefits ?? []);
    }
    for (const c of flowing) {
      addSource(c.grossMonthlyCents ?? 0, c.irsRatePct ?? 0, c.ssEmpPct ?? 11, c.benefits ?? []);
    }

    return { gross, irs, ss, cash, meal, childcare, education, allowance };
  }, [sources, flowing]);

  // Per-source breakdown helper
  function sourceBreakdown(gross: number, irsPct: number, ssPct: number, benefits: BenefitConfig[]) {
    const irs = Math.round(gross * irsPct / 100);
    const ss  = Math.round(gross * ssPct  / 100);
    let meal = 0, childcare = 0, education = 0, allowance = 0;
    for (const b of benefits) {
      const t = (b.type ?? '').toUpperCase();
      const amt = benefitMonthlyCents(b);
      if (MEAL_TYPES.has(t))              meal      += amt;
      else if (t === 'CHILDCARE')         childcare += amt;
      else if (t === 'EDUCATION')         education += amt;
      else if (t === 'EXPENSE_ALLOWANCE') allowance += amt;
    }
    return { gross, irs, ss, net: gross - irs - ss, meal, childcare, education, allowance };
  }

  if (loading) return <div className="text-zinc-500 text-sm p-4">A carregar…</div>;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Fontes de Rendimento</h1>
          <p className="text-xs text-zinc-500 mt-0.5">Empregadores externos — fluxo para contas privadas</p>
        </div>
        <Button onClick={openNew}>
          <Plus size={14} className="mr-1" /> Nova fonte
        </Button>
      </div>

      {/* Monthly breakdown */}
      {byPerson.size > 0 && (
        <Card className="p-4 space-y-4">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Rendimento mensal estimado</div>

          {/* Gross → taxes → net flow */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <div className="text-xs text-zinc-500 mb-0.5">Bruto total</div>
              <div className="text-base font-bold text-zinc-200">{formatEUR(summary.gross)}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-0.5">IRS retido</div>
              <div className="text-base font-bold text-red-400">− {formatEUR(summary.irs)}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-0.5">SS trabalhador</div>
              <div className="text-base font-bold text-red-400">− {formatEUR(summary.ss)}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-0.5">💳 Líquido bancário</div>
              <div className="text-base font-bold text-emerald-400">{formatEUR(summary.cash)}</div>
            </div>
          </div>

          {/* Restricted income (vouchers) */}
          {(summary.meal + summary.childcare + summary.education + summary.allowance) > 0 && (
            <div className="border-t border-zinc-800 pt-3">
              <div className="text-xs text-zinc-500 mb-2">Benefícios (uso restrito)</div>
              <div className="flex flex-wrap gap-4">
                {summary.meal > 0 && (
                  <div>
                    <div className="text-xs text-zinc-500 mb-0.5">🍽 Refeição</div>
                    <div className="text-sm font-semibold text-amber-400">{formatEUR(summary.meal)}</div>
                  </div>
                )}
                {summary.childcare > 0 && (
                  <div>
                    <div className="text-xs text-zinc-500 mb-0.5">👶 Creche</div>
                    <div className="text-sm font-semibold text-amber-400">{formatEUR(summary.childcare)}</div>
                  </div>
                )}
                {summary.education > 0 && (
                  <div>
                    <div className="text-xs text-zinc-500 mb-0.5">📚 Educação</div>
                    <div className="text-sm font-semibold text-amber-400">{formatEUR(summary.education)}</div>
                  </div>
                )}
                {summary.allowance > 0 && (
                  <div>
                    <div className="text-xs text-zinc-500 mb-0.5">🧾 Ajudas de custo</div>
                    <div className="text-sm font-semibold text-blue-400">{formatEUR(summary.allowance)}</div>
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Per-person sections */}
      {byPerson.size === 0 ? (
        <div className="text-center py-12 text-zinc-600">
          <div className="text-4xl mb-3">💼</div>
          <div>Sem fontes de rendimento configuradas.</div>
        </div>
      ) : (
        <div className="space-y-6">
          {Array.from(byPerson.entries()).map(([person, { sources: srcs, contracts: ctrs }]) => (
            <div key={person}>
              <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">{person}</div>
              <div className="space-y-2">

                {/* Flowing employment contracts — read-only */}
                {ctrs.map(c => {
                  const bd = sourceBreakdown(c.grossMonthlyCents ?? 0, c.irsRatePct ?? 0, c.ssEmpPct ?? 11, c.benefits ?? []);
                  return (
                    <Card key={c.id} className="px-4 py-3 space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{c.companyName}</span>
                          <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 flex items-center gap-1">
                            <Lock size={10} /> Contrato
                          </span>
                        </div>
                        <span className="text-xs text-zinc-500">dia {c.payDay}</span>
                      </div>
                      <IncomeBreakdownRow bd={bd} />
                    </Card>
                  );
                })}

                {/* Editable income sources */}
                {srcs.map(s => {
                  const bd = sourceBreakdown(s.grossMonthlyCents, s.irsRatePct ?? 0, s.ssEmpPct ?? 11, s.benefits ?? []);
                  return (
                    <Card key={s.id} className="px-4 py-3 space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{s.employerName}</span>
                          {(s.startDate || s.endDate) && (
                            <span className="text-xs text-zinc-500">
                              {s.startDate ?? "…"} → {s.endDate ?? "atual"}
                            </span>
                          )}
                          {s.active === false && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">inativo</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-zinc-500">dia {s.payDay}</span>
                          <button onClick={() => openEdit(s)}
                            className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
                            <Pencil size={13} />
                          </button>
                          <button onClick={() => deleteSource(s.id)}
                            className="p-1.5 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                      <IncomeBreakdownRow bd={bd} />
                    </Card>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {modalOpen && (
        <IncomeSourceModal
          editingId={editingId}
          initial={formInit}
          accounts={accounts}
          onSave={handleSave}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}
