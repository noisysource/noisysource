import { useEffect, useMemo, useState } from "react";
import { useEntity } from "../hooks/EntityContext";
import { api } from "../lib/api";
import { formatEUR } from "@shared/lib/money";
import { Card } from "../components/ui/card";
import type { ComputedCostSummary } from "../lib/api/domains/costSummary";
import type { CostSummaryDoc } from "@shared/models/CostSummary";
import { vatCodeLabel } from "@shared/lib/vat";

function currentYearMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function lastMonths(n = 6): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

function formatYM(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("pt-PT", { month: "long", year: "numeric" });
}

/**
 * NoisyPhocus-only page. Computes (and stores) the monthly cost total that
 * KidClub's "Resumo Financeiro" reads cross-app — see root CLAUDE.md
 * "Cross-App Data Contracts" and finances/STATUS.md.
 *
 * Design choice: recompute + overwrite finances_entities/noisyphocus/costSummary/{ym}
 * every time this page is opened for a month, rather than requiring a
 * separate "publish" step. At this scale (2 contracts, a handful of
 * recurring entries) the read is cheap, and it avoids the staleness risk of
 * a stored snapshot silently drifting from an edited contract/recurring
 * entry. See STATUS.md for the fuller reasoning.
 */
export default function CostSummaryPage() {
  const { selectedEntity } = useEntity();
  const isNoisyphocus = selectedEntity.id === "noisyphocus";

  const months = useMemo(() => lastMonths(6), []);
  const [yearMonth, setYearMonth] = useState<string>(currentYearMonth());
  const [summary, setSummary] = useState<ComputedCostSummary | null>(null);
  const [stored, setStored] = useState<CostSummaryDoc | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isNoisyphocus) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setMsg(null);
      try {
        api.setEntity("noisyphocus");
        // Both salaried and green-receipt/freelance NoisyPhocus workers come
        // from api.contracts (employmentContracts) — see costSummary.ts for
        // why EC-contracts (a different, income-direction model) isn't used.
        const [contracts, recurring, people, volumeCents] = await Promise.all([
          api.contracts.list(),
          api.recurring.list(),
          api.people.list(),
          api.kidclub.monthlyProcessedVolumeCents(yearMonth),
        ]);

        const peopleById: Record<string, string> = {};
        for (const p of people as { id: string; name?: string }[]) peopleById[p.id] = p.name ?? p.id;

        const computed = await api.costSummary.computeAndSave({
          yearMonth,
          contracts,
          recurring,
          kidclubVolumeCentsForMonth: volumeCents,
          peopleById,
        });

        if (cancelled) return;
        setSummary(computed);
        const savedDoc = await api.costSummary.get(yearMonth);
        if (!cancelled) setStored(savedDoc);
      } catch (e: any) {
        if (!cancelled) setMsg(e?.message ?? "Erro ao calcular custos");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [isNoisyphocus, yearMonth]);

  if (!isNoisyphocus) {
    return (
      <div className="max-w-xl mx-auto pt-12 text-center text-zinc-500">
        <div className="text-3xl mb-3">📊</div>
        <div>Resumo de custos disponível apenas para NoisyPhocus.</div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold">Custos — NoisyPhocus</h1>
        <p className="text-xs text-zinc-500 mt-0.5">
          Total mensal (payroll + software), com e sem IVA, usado pelo KidClub no Resumo Financeiro.
        </p>
      </div>

      <div className="flex gap-1 flex-wrap">
        {months.map(ym => (
          <button key={ym} onClick={() => setYearMonth(ym)}
            className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors capitalize ${
              ym === yearMonth
                ? "border-blue-500 bg-blue-900/40 text-blue-200"
                : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
            }`}>
            {formatYM(ym)}
          </button>
        ))}
      </div>

      {loading && <div className="text-zinc-500 text-sm">A calcular...</div>}
      {msg && <div className="text-red-400 text-xs bg-red-950/30 px-3 py-2 rounded">{msg}</div>}

      {summary && !loading && (
        <>
          {!!summary.unconfirmedVatCount && (
            <div className="text-amber-300 text-xs bg-amber-950/30 border border-amber-800/50 px-3 py-2 rounded">
              {summary.unconfirmedVatCount === 1
                ? "1 custo tem IVA por confirmar e entra"
                : `${summary.unconfirmedVatCount} custos têm IVA por confirmar e entram`} pelo valor guardado nas duas
              colunas, por isso os totais são aproximados. Corrige em Recorrentes (escolhe a taxa e guarda).
            </div>
          )}

          <Card className="p-4">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <div className="text-xs text-zinc-400 mb-1">Payroll</div>
                <div className="text-base font-bold text-zinc-100">{formatEUR(summary.payrollCostCents)}</div>
                <div className="text-[10px] text-zinc-600 mt-0.5">sem IVA aplicável</div>
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">Software</div>
                <div className="text-base font-bold text-zinc-100">{formatEUR(summary.softwareCostCents)}</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">
                  sem IVA {formatEUR(summary.softwareNetCents ?? summary.softwareCostCents)} · IVA {formatEUR(summary.vatCents)}
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">Total</div>
                <div className="text-base font-bold text-amber-300">{formatEUR(summary.totalCostCents)}</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">
                  sem IVA {formatEUR(summary.totalNetCents ?? summary.totalCostCents)}
                </div>
              </div>
            </div>
          </Card>

          <Card className="p-4 space-y-1.5">
            <div className="flex items-center justify-between text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-2">
              <span>Detalhe</span>
              <span className="flex gap-3 normal-case tracking-normal font-medium">
                <span className="w-24 text-right">com IVA</span>
                <span className="w-24 text-right">sem IVA</span>
              </span>
            </div>
            {(summary.breakdown ?? []).length === 0 && (
              <div className="text-xs text-zinc-600 italic">
                Sem dados — falta configurar contratos/recorrentes de NoisyPhocus (ver STATUS.md).
              </div>
            )}
            {(summary.breakdown ?? []).map((line, i) => (
              <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-zinc-800/50">
                <span className="text-zinc-400 min-w-0 truncate pr-2">
                  {line.label}
                  {line.vatCode !== undefined && (
                    <span className={`ml-1.5 ${line.vatCode === "por_confirmar" ? "text-amber-400" : "text-zinc-600"}`}>
                      {vatCodeLabel(line.vatCode)}
                    </span>
                  )}
                </span>
                <span className="flex gap-3 shrink-0">
                  <span className="w-24 text-right text-zinc-200 tabular-nums">{formatEUR(line.amountCents)}</span>
                  <span className="w-24 text-right text-zinc-400 tabular-nums">{formatEUR(line.netCents ?? line.amountCents)}</span>
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between text-xs pt-1 font-semibold">
              <span className="text-zinc-300">Total</span>
              <span className="flex gap-3">
                <span className="w-24 text-right text-amber-300 tabular-nums">{formatEUR(summary.totalCostCents)}</span>
                <span className="w-24 text-right text-zinc-300 tabular-nums">{formatEUR(summary.totalNetCents ?? summary.totalCostCents)}</span>
              </span>
            </div>
          </Card>

          <div className="text-xs text-zinc-600">
            Guardado em <code className="text-zinc-500">finances_entities/noisyphocus/costSummary/{yearMonth}</code>
            {stored?.computedAt && (
              <> · calculado {(stored.computedAt as any)?.toDate?.()?.toLocaleString?.("pt-PT") ?? ""}</>
            )}
            <span className="block mt-0.5">Recalculado automaticamente sempre que esta página é aberta para este mês.</span>
          </div>
        </>
      )}
    </div>
  );
}
