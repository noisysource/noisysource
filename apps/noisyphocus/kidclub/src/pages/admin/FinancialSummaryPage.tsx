import { useState, useEffect, useMemo } from 'react';
import { getDocs, getDoc, setDoc, query, where, Timestamp } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';
import { TransportationConfig } from '@shared/models/Transportation';
import { FinancialEvent, FinancialEventTier } from '@shared/models/FinancialEvent';
import { financeCostSummaryService, CostSummary } from '../../services/financeCostSummaryService';

// ── FinancialSummaryPage ────────────────────────────────────────────────────
// Thin summary over `financialEvents` — the single source of truth for
// KidClub's own revenue (see eventService.ts's mappers for how these are
// generated). This page does NOT compute money independently anymore; it
// only sums/groups events for the selected period.
//
// Cost is split two ways:
//  - Van + electricity: KidClub's own fixed operational costs, edited here
//    directly and emitted as 'committed' expense financialEvents by
//    eventService.generateEvents() each month.
//  - Staff/software/VAT: owned by the Finances app's `costSummary` doc
//    (finances_entities/noisyphocus/costSummary/{yyyy-mm}) — read-only here.
//    Shows "not configured" (not €0) if that doc doesn't exist yet.

type ServiceGroup = 'all' | 'transport' | 'study' | 'party' | 'camp' | 'other';

const CATEGORY_SERVICE: Record<string, ServiceGroup> = {
  'Sala de Estudo': 'study',
  'Transporte (Estudo)': 'transport',
  'Transporte (Subscrição)': 'transport',
  'Festas': 'party',
  'Campos': 'camp',
  'Transporte - Van': 'transport',
  'Transporte - Eletricidade': 'transport',
};

function serviceOfCategory(category?: string): ServiceGroup {
  if (!category) return 'other';
  return CATEGORY_SERVICE[category] ?? 'other';
}

const SERVICE_LABEL: Record<ServiceGroup, string> = {
  all: 'Todos',
  transport: 'Transporte',
  study: 'Sala de Estudo',
  party: 'Festas',
  camp: 'Campos',
  other: 'Outro',
};

const TIER_LABEL: Record<FinancialEventTier, string> = {
  committed: 'Confirmado',
  pipeline: 'Pipeline (pendente)',
};

const TIER_PILL_CLASS: Record<FinancialEventTier, string> = {
  committed: 'bg-green-100 text-green-700',
  pipeline: 'bg-yellow-100 text-yellow-700',
};

function eur(n: number) {
  const abs = Math.abs(Math.round(n));
  return (n < 0 ? '−' : '') + '€' + abs.toLocaleString('pt-PT');
}

function sign(n: number) { return n >= 0 ? '+' : '−'; }

function currentMonthStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthRange(monthKey: string): { start: Date; end: Date } {
  const [y, m] = monthKey.split('-').map(Number);
  return {
    start: new Date(y, m - 1, 1),
    end: new Date(y, m, 0, 23, 59, 59, 999),
  };
}

function KPI({ label, value, sub, color = 'text-gray-900' }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function EditableCostRow({ label, value, saving, onChange, onSave }: {
  label: string; value: string; saving: boolean; onChange: (v: string) => void; onSave: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-sm text-gray-600">{label}</span>
      <div className="flex items-center gap-1.5">
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">€</span>
          <input
            type="number"
            min="0"
            step="1"
            value={value}
            onChange={e => onChange(e.target.value)}
            onBlur={onSave}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className="w-28 pl-6 pr-2 py-1 text-sm border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-indigo-400"
          />
        </div>
        {saving && <span className="text-xs text-gray-400">…</span>}
      </div>
    </div>
  );
}

export default function FinancialSummaryPage() {
  const [events, setEvents] = useState<FinancialEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [tConfig, setTConfig] = useState<TransportationConfig | null>(null);
  const [costInputs, setCostInputs] = useState({ vanMonthlyCost: '', electricityMonthlyCost: '' });
  const [savingCostField, setSavingCostField] = useState<'vanMonthlyCost' | 'electricityMonthlyCost' | null>(null);
  const [costSummary, setCostSummary] = useState<CostSummary | null>(null);
  const [costSummaryLoaded, setCostSummaryLoaded] = useState(false);

  const [monthFilter, setMonthFilter] = useState<string>(currentMonthStr());
  const [serviceFilter, setServiceFilter] = useState<ServiceGroup>('all');
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setCostSummaryLoaded(false);

      const eventsQuery = monthFilter === 'all'
        ? col('financialEvents')
        : (() => {
            const { start, end } = monthRange(monthFilter);
            return query(
              col('financialEvents'),
              where('date', '>=', Timestamp.fromDate(start)),
              where('date', '<=', Timestamp.fromDate(end)),
            );
          })();

      const [eventsSnap, tCfgSnap, summary] = await Promise.all([
        getDocs(eventsQuery),
        getDoc(docRef('config', 'transportation')),
        financeCostSummaryService.get(monthFilter === 'all' ? currentMonthStr() : monthFilter),
      ]);

      setEvents(eventsSnap.docs.map(d => d.data() as FinancialEvent));

      if (tCfgSnap.exists()) {
        const cfg = tCfgSnap.data() as TransportationConfig;
        setTConfig(cfg);
        setCostInputs({
          vanMonthlyCost: cfg.vanMonthlyCost != null ? String(cfg.vanMonthlyCost) : '',
          electricityMonthlyCost: cfg.electricityMonthlyCost != null ? String(cfg.electricityMonthlyCost) : '',
        });
      }

      setCostSummary(summary);
      setCostSummaryLoaded(true);
      setLoading(false);
    };
    load();
  }, [monthFilter]);

  const filteredEvents = useMemo(() => {
    if (serviceFilter === 'all') return events;
    return events.filter(e => serviceOfCategory(e.category) === serviceFilter);
  }, [events, serviceFilter]);

  const {
    effectiveRevenue, plannedCommittedRevenue, committedRevenueTotal,
    pipelineRevenue, vanElectricityCost,
  } = useMemo(() => {
    let effectiveRevenue = 0, plannedCommittedRevenue = 0, pipelineRevenue = 0, vanElectricityCost = 0;
    for (const e of filteredEvents) {
      if (e.type === 'income') {
        if (e.tier === 'pipeline') {
          pipelineRevenue += e.amount;
        } else if (e.eventKind === 'effective') {
          effectiveRevenue += e.amount;
        } else {
          // tier === 'committed' (or unset, treated as committed for legacy
          // events written before `tier` existed) and not yet effective
          plannedCommittedRevenue += e.amount;
        }
      } else if (e.type === 'expense' && e.tier === 'committed') {
        vanElectricityCost += e.amount;
      }
    }
    return {
      effectiveRevenue,
      plannedCommittedRevenue,
      committedRevenueTotal: effectiveRevenue + plannedCommittedRevenue,
      pipelineRevenue,
      vanElectricityCost,
    };
  }, [filteredEvents]);

  const financesCostTotal = costSummary ? costSummary.totalCostCents / 100 : null;
  const totalCommittedCost = vanElectricityCost + (financesCostTotal ?? 0);

  const profitEffective = effectiveRevenue - totalCommittedCost;
  const profitCommitted = committedRevenueTotal - totalCommittedCost;
  const marginEffective = effectiveRevenue > 0 ? Math.round((profitEffective / effectiveRevenue) * 100) : null;
  const marginCommitted = committedRevenueTotal > 0 ? Math.round((profitCommitted / committedRevenueTotal) * 100) : null;

  const periodLabel = monthFilter === 'all'
    ? 'todos os períodos'
    : new Date(Number(monthFilter.split('-')[0]), Number(monthFilter.split('-')[1]) - 1, 1)
        .toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' });

  async function saveCostField(key: 'vanMonthlyCost' | 'electricityMonthlyCost') {
    const raw = costInputs[key].trim();
    const value = raw === '' ? 0 : parseFloat(raw);
    if (isNaN(value) || value < 0) return;
    setSavingCostField(key);
    try {
      await setDoc(docRef('config', 'transportation'), { [key]: value }, { merge: true });
      setTConfig(prev => prev ? { ...prev, [key]: value } : prev);
      setCostInputs(prev => ({ ...prev, [key]: String(value) }));
    } finally {
      setSavingCostField(null);
    }
  }

  const incomeRows = useMemo(
    () => filteredEvents.filter(e => e.type === 'income').sort((a, b) => b.amount - a.amount),
    [filteredEvents]
  );

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-400">A carregar…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Resumo Financeiro</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Baseado em <code className="text-xs">financialEvents</code> — fonte única de verdade para receita do KidClub.
          </p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Serviço</div>
            <div className="flex gap-1.5 flex-wrap">
              {(['all', 'transport', 'study', 'party', 'camp'] as ServiceGroup[]).map(f => (
                <button
                  key={f}
                  onClick={() => setServiceFilter(f)}
                  className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                    serviceFilter === f
                      ? 'bg-indigo-100 text-indigo-700 border-transparent'
                      : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {SERVICE_LABEL[f]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Período</div>
            <div className="flex gap-1.5 items-center">
              <button
                onClick={() => setMonthFilter('all')}
                className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                  monthFilter === 'all'
                    ? 'bg-gray-900 text-white border-transparent'
                    : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                }`}
              >
                Todos os períodos
              </button>
              <button
                onClick={() => setMonthFilter(currentMonthStr())}
                className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                  monthFilter === currentMonthStr()
                    ? 'bg-indigo-100 text-indigo-700 border-transparent'
                    : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                }`}
              >
                Este mês
              </button>
              <input
                type="month"
                value={monthFilter === 'all' ? '' : monthFilter}
                onChange={e => setMonthFilter(e.target.value || 'all')}
                className="text-xs px-2 py-1 border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-indigo-400"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Fixed costs — van + electricity only. Driver/teacher payroll and
          rent moved to the Finances app's cost summary (below); this page
          no longer edits or shows them. */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700">Custos Fixos — Van + Eletricidade</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Editar aqui gera um evento de despesa 'committed' em <code>financialEvents</code> na próxima geração mensal.
            Motorista, professora e renda passaram para a app Finanças.
          </p>
        </div>
        <div className="px-5 py-3 divide-y divide-gray-100">
          <EditableCostRow
            label="Van"
            value={costInputs.vanMonthlyCost}
            saving={savingCostField === 'vanMonthlyCost'}
            onChange={v => setCostInputs(prev => ({ ...prev, vanMonthlyCost: v }))}
            onSave={() => saveCostField('vanMonthlyCost')}
          />
          <EditableCostRow
            label="Eletricidade"
            value={costInputs.electricityMonthlyCost}
            saving={savingCostField === 'electricityMonthlyCost'}
            onChange={v => setCostInputs(prev => ({ ...prev, electricityMonthlyCost: v }))}
            onSave={() => saveCostField('electricityMonthlyCost')}
          />
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <KPI
          label="Receita Efetiva (real)"
          value={eur(effectiveRevenue)}
          sub={`paga/faturada · ${periodLabel}`}
          color="text-green-600"
        />
        <KPI
          label="Receita Confirmada (esperada)"
          value={eur(committedRevenueTotal)}
          sub="ativos/confirmados, incl. já efetivos"
          color="text-blue-600"
        />
        <KPI
          label="Pipeline (pendente)"
          value={eur(pipelineRevenue)}
          sub="NÃO incluído nos totais acima"
          color="text-yellow-600"
        />
      </div>

      {/* Cost + profit */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700">Custos Confirmados & Lucro</h2>
        </div>
        <div className="px-5 py-4 space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500">Van + Eletricidade (KidClub)</span>
            <span className="font-mono text-red-500">{eur(vanElectricityCost)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-gray-500">Pessoal + Software + IVA (app Finanças)</span>
            {costSummaryLoaded && financesCostTotal === null ? (
              <span className="text-xs text-gray-400 italic">ainda não configurado na app Finanças</span>
            ) : (
              <span className="font-mono text-red-500">{eur(financesCostTotal ?? 0)}</span>
            )}
          </div>
          <div className="flex justify-between font-semibold border-t border-gray-100 pt-2">
            <span>Custo Confirmado Total</span>
            <span className="font-mono text-red-500">{eur(totalCommittedCost)}</span>
          </div>

          <div className="border-t border-gray-100 pt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1">Lucro (Efetivo vs. Confirmado custo)</div>
              <div className={`text-lg font-bold ${profitEffective >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {sign(profitEffective)}{eur(Math.abs(profitEffective))}
              </div>
              <div className="text-xs text-gray-400">{marginEffective != null ? `${marginEffective}% margem` : '—'}</div>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1">Lucro (Confirmado vs. Confirmado custo)</div>
              <div className={`text-lg font-bold ${profitCommitted >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {sign(profitCommitted)}{eur(Math.abs(profitCommitted))}
              </div>
              <div className="text-xs text-gray-400">{marginCommitted != null ? `${marginCommitted}% margem` : '—'}</div>
            </div>
          </div>

          {costSummary?.breakdown?.length ? (
            <div className="border-t border-gray-100 pt-3">
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1.5">Detalhe (app Finanças)</div>
              <div className="space-y-1">
                {costSummary.breakdown.map((b, i) => (
                  <div key={i} className="flex justify-between text-xs text-gray-500">
                    <span>{b.label}</span>
                    <span className="font-mono">{eur(b.amountCents / 100)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Revenue detail — collapsible */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <button
          onClick={() => setDetailOpen(o => !o)}
          className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-gray-50 transition-colors"
        >
          <div>
            <h2 className="text-sm font-semibold text-gray-700">Detalhe de eventos financeiros (receita)</h2>
            <p className="text-xs text-gray-400 mt-0.5">{incomeRows.length} eventos — {SERVICE_LABEL[serviceFilter]} · {periodLabel}</p>
          </div>
          <span className={`text-gray-400 transition-transform ${detailOpen ? 'rotate-180' : ''}`}>▾</span>
        </button>
        {detailOpen && (
          <div className="border-t border-gray-100 max-h-96 overflow-y-auto">
            {incomeRows.length === 0 ? (
              <div className="px-5 py-6 text-center text-sm text-gray-400">Sem eventos para este filtro.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-xs font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-200">
                    <th className="text-left px-5 py-2">Label</th>
                    <th className="text-left px-5 py-2">Categoria</th>
                    <th className="text-left px-5 py-2">Tier</th>
                    <th className="text-left px-5 py-2">Estado</th>
                    <th className="text-right px-5 py-2">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {incomeRows.map((row, i) => (
                    <tr key={`${row.id}-${i}`} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                      <td className="px-5 py-2 text-gray-700">{row.label}</td>
                      <td className="px-5 py-2 text-gray-500">{row.category ?? '—'}</td>
                      <td className="px-5 py-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TIER_PILL_CLASS[row.tier ?? 'committed']}`}>
                          {TIER_LABEL[row.tier ?? 'committed']}
                        </span>
                      </td>
                      <td className="px-5 py-2 text-gray-500">{row.eventKind === 'effective' ? 'Efetivo' : 'Planeado'}</td>
                      <td className="px-5 py-2 text-right font-mono text-blue-600">{eur(row.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
