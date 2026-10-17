import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEntity } from "../hooks/EntityContext";
import { api } from "../lib/api";
import { formatEUR } from "@shared/lib/money";
import { vatCodeLabel } from "@shared/lib/vat";
import { Card } from "../components/ui/card";
import type { RecurringEntryDoc } from "@shared/models/RecurringEntry";
import type { CreditContractDoc } from "@shared/models/CreditContract";
import type { EmploymentContractDoc } from "@shared/models/Employment";
import type { PayrollRunDoc } from "@shared/models/PayrollRun";
import { generateKidclubEvents, kidclubVolumeByMonth } from "@shared/lib/eventGenerators";
import { buildMonthlyExpenses } from "../lib/monthlyExpenses";

/** FinHub's history starts on 2026-01-01 (the seed). */
const FIRST_YEAR = 2026;

const ymOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthName = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("pt-PT", { month: "long" });
};

type Loaded = {
  entries: RecurringEntryDoc[];
  credits: CreditContractDoc[];
  categories: Array<{ id: string; name: string; parentId?: string }>;
  contracts: EmploymentContractDoc[];
  runs: PayrollRunDoc[];
  peopleById: Record<string, string>;
  billing: Awaited<ReturnType<typeof api.kidclub.listBilling>>;
};

/**
 * Despesas do mês (HANDOFF-finhub-redesign.md step 2): every entity, a year at a time, January
 * first; each month expands into its groups and lines. Expected costs: recurring entries, credit
 * instalments, salaries (the processed payroll run when there is one, else the contract).
 *
 * NoisyPhocus: also keeps finances_entities/noisyphocus/costSummary/{yyyy-mm} current for the
 * months up to now (KidClub's future Resumo Financeiro reads it; CLAUDE.md Cross-App Data
 * Contracts), recomputed whenever this page is opened, as Custos do mês did.
 */
export default function MonthlyExpensesPage() {
  const { selectedEntity } = useEntity();
  const entityId = selectedEntity.id;
  const isPrivate = entityId === "private";
  const isNoisyphocus = entityId === "noisyphocus";
  const currentYM = ymOf(new Date());
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: Math.max(currentYear + 1, FIRST_YEAR) - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i);

  const [year, setYear] = useState(currentYear);
  const [data, setData] = useState<Loaded | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set([currentYM]));
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setMsg(null);
    (async () => {
      try {
        api.setEntity(entityId);
        const [entries, credits, categories, contracts, runs, people, billing] = await Promise.all([
          api.recurring.list(),
          api.credits.list(),
          api.categories.list(),
          api.contracts.list() as Promise<EmploymentContractDoc[]>,
          api.payrollRuns.list(),
          api.people.list() as Promise<Array<{ id: string; name: string }>>,
          isNoisyphocus ? api.kidclub.listBilling() : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setData({
          entries, credits, contracts, runs, billing,
          categories: categories.map(c => ({ id: c.id, name: c.name, parentId: c.parentId })),
          peopleById: Object.fromEntries(people.map(p => [p.id, p.name])),
        });
      } catch (e: any) {
        if (!cancelled) setMsg(e?.message ?? "Erro ao carregar");
      }
    })();
    return () => { cancelled = true; };
  }, [entityId, isNoisyphocus]);

  // Commission entries (EasyPay) are a % of KidClub's volume that month.
  const volumeByMonth = useMemo(
    () => (data && isNoisyphocus ? kidclubVolumeByMonth(generateKidclubEvents(data.billing, `${year}-01`, 12)) : {}),
    [data, isNoisyphocus, year],
  );

  const months = useMemo(() => {
    if (!data) return [];
    return buildMonthlyExpenses({
      year, entries: data.entries, credits: data.credits, categories: data.categories,
      contracts: data.contracts, payrollRuns: data.runs, peopleById: data.peopleById,
      volumeByMonth, withVat: !isPrivate,
    });
  }, [data, year, volumeByMonth, isPrivate]);

  // NoisyPhocus: KidClub's monthly summary for the months of this year up to now.
  useEffect(() => {
    if (!data || !isNoisyphocus) return;
    const due = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`).filter(ym => ym <= currentYM);
    (async () => {
      for (const yearMonth of due) {
        await api.costSummary.computeAndSave({
          yearMonth, contracts: data.contracts, recurring: data.entries,
          kidclubVolumeCentsForMonth: volumeByMonth[yearMonth], peopleById: data.peopleById, categories: data.categories,
        });
      }
    })().catch(e => setMsg(`Resumo do KidClub não guardado: ${e?.message ?? e}`));
  }, [data, isNoisyphocus, year, volumeByMonth, currentYM]);

  const yearTotal = months.reduce((s, m) => s + m.amountCents, 0);
  const yearNet = months.reduce((s, m) => s + m.netCents, 0);
  const toggle = (ym: string) => setOpen(s => { const x = new Set(s); if (x.has(ym)) x.delete(ym); else x.add(ym); return x; });
  const amounts = (gross: number, net: number, strong = false) => (
    <span className="flex gap-3 shrink-0 tabular-nums">
      <span className={`w-24 text-right ${strong ? "text-zinc-100 font-semibold" : "text-zinc-200"}`}>{formatEUR(gross)}</span>
      {!isPrivate && <span className="w-24 text-right text-zinc-500">{formatEUR(net)}</span>}
    </span>
  );

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold">Despesas do mês — {selectedEntity.name}</h1>
        <p className="text-xs text-zinc-500 mt-0.5">
          Previsto: recorrentes, prestações de créditos e salários (o recibo processado quando existe, senão o contrato).
          Os valores reais chegam com os Movimentos.
        </p>
      </div>

      <div className="flex items-center gap-1">
        {years.map(y => (
          <button key={y} onClick={() => setYear(y)}
            className={`px-3 py-1.5 rounded text-xs font-medium border ${y === year
              ? "border-blue-500 bg-blue-900/40 text-blue-200" : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800"}`}>
            {y}
          </button>
        ))}
      </div>

      {msg && <div className="text-red-400 text-xs bg-red-950/30 px-3 py-2 rounded">{msg}</div>}
      {!data && !msg && <div className="text-zinc-500 text-sm">A carregar…</div>}

      {data && (
        <>
          <Card className="p-4 grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="text-xs text-zinc-400 mb-1">Total {year}</div>
              <div className="text-base font-bold text-amber-300">{formatEUR(yearTotal)}</div>
              {!isPrivate && <div className="text-[10px] text-zinc-500 mt-0.5">sem IVA {formatEUR(yearNet)}</div>}
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Média por mês</div>
              <div className="text-base font-bold text-zinc-100">{formatEUR(Math.round(yearTotal / 12))}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Este mês</div>
              <div className="text-base font-bold text-zinc-100">
                {formatEUR(months.find(m => m.ym === currentYM)?.amountCents ?? 0)}
              </div>
            </div>
          </Card>

          <div className="flex justify-end gap-3 text-[10px] uppercase tracking-wider text-zinc-500 pr-3">
            <span className="w-24 text-right">com IVA</span>
            {!isPrivate && <span className="w-24 text-right">sem IVA</span>}
          </div>

          <div className="space-y-1.5">
            {months.map(m => {
              const isOpen = open.has(m.ym);
              return (
                <div key={m.ym} className={`rounded-lg border ${m.ym === currentYM ? "border-blue-800" : "border-zinc-800"} bg-zinc-900/60`}>
                  <button onClick={() => toggle(m.ym)} className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left">
                    <span className="flex items-center gap-2 text-sm font-medium capitalize">
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      {monthName(m.ym)}
                      {m.hasPayrollRuns && (
                        <span className="normal-case text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300">salários processados</span>
                      )}
                      {m.unconfirmedVatCount > 0 && (
                        <span className="normal-case text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300">
                          IVA por confirmar ({m.unconfirmedVatCount})
                        </span>
                      )}
                    </span>
                    {amounts(m.amountCents, m.netCents, true)}
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3 space-y-3">
                      {m.groups.length === 0 && <div className="text-xs text-zinc-600 pl-6">Sem despesas previstas.</div>}
                      {m.groups.map(g => (
                        <div key={g.name} className="pl-6">
                          <div className="flex items-center justify-between text-xs font-semibold text-zinc-300 py-1 border-b border-zinc-800">
                            <span>{g.name}</span>
                            {amounts(g.amountCents, g.netCents)}
                          </div>
                          {g.lines.map(l => (
                            <div key={l.key} className="flex items-center justify-between gap-3 text-xs py-1 pl-3">
                              <span className="min-w-0 text-zinc-400">
                                {l.label}
                                {l.vatCode !== undefined && (
                                  <span className={`ml-1.5 ${l.vatCode === "por_confirmar" ? "text-amber-400" : "text-zinc-600"}`}>
                                    {vatCodeLabel(l.vatCode)}
                                  </span>
                                )}
                                {l.detail && <span className="block text-[10px] text-zinc-600">{l.detail}</span>}
                              </span>
                              {amounts(l.amountCents, l.netCents)}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {isNoisyphocus && (
            <div className="text-xs text-zinc-600">
              O resumo para o KidClub (<code className="text-zinc-500">costSummary/{"{yyyy-mm}"}</code>) é recalculado e guardado
              para os meses até {currentYM} sempre que esta página abre.
            </div>
          )}
        </>
      )}
    </div>
  );
}
