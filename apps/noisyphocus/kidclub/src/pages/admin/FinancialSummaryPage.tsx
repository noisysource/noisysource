import { useState, useEffect, useMemo, useRef } from 'react';
import { getDocs, getDoc, query, orderBy, limit, setDoc } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { col, docRef } from '../../lib/db';
import { TransportationConfig } from '@shared/models/Transportation';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import { normalizeSubStatus, SubStatus } from '../../lib/utils';

interface TransportSub {
  id: string;
  status: SubStatus;
  monthlyFee: number;
  scheduleLength: number;
  familyId: string;
  childName: string;
  startDate: Date | null;
  endDate: Date | null;
}

interface StudySub {
  id: string;
  status: SubStatus;
  daysCount: number;
  familyId: string;
  childName: string;
  startDate: Date | null;
  endDate: Date | null;
}

interface RouteSnapshot {
  driverCost: number;
  vanCost: number;
  electricityCost: number;
  monthlyCost: number;
  monthlyRevenue: number;
  monthlyRevenueActive: number;
}

type ServiceFilter = 'both' | 'transport' | 'study';

const ALL_STATUSES: SubStatus[] = ['active', 'pending', 'cancelled'];

const STATUS_LABEL: Record<SubStatus, string> = {
  active: 'Ativo',
  pending: 'Pendente',
  cancelled: 'Cancelado',
};

const STATUS_PILL_CLASS: Record<SubStatus, string> = {
  active: 'bg-green-100 text-green-700',
  pending: 'bg-yellow-100 text-yellow-700',
  cancelled: 'bg-gray-100 text-gray-500',
};

const PRESETS: { label: string; statuses: SubStatus[] }[] = [
  { label: 'Apenas ativos', statuses: ['active'] },
  { label: 'Ativos + pendentes', statuses: ['active', 'pending'] },
  { label: 'Tudo (incl. cancelados)', statuses: ['active', 'pending', 'cancelled'] },
];

function eur(n: number) {
  const abs = Math.abs(Math.round(n));
  return (n < 0 ? '−' : '') + '€' + abs.toLocaleString('pt-PT');
}

function sign(n: number) { return n >= 0 ? '+' : '−'; }

function samePreset(a: SubStatus[], b: SubStatus[]) {
  return a.length === b.length && a.every(s => b.includes(s));
}

// Firestore may hand back a Timestamp, an ISO/YYYY-MM-DD string, or (rarely)
// a plain Date, depending on which form wrote the doc — normalize all three.
function toJsDate(raw: any): Date | null {
  if (!raw) return null;
  if (typeof raw?.toDate === 'function') return raw.toDate();
  if (raw instanceof Date) return raw;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

// month is 'all' or 'YYYY-MM'. A sub with no start/end on the relevant side
// is treated as open-ended (always overlaps) rather than excluded, since
// incomplete legacy data shouldn't silently vanish from the numbers.
function overlapsMonth(startDate: Date | null, endDate: Date | null, month: string): boolean {
  if (month === 'all') return true;
  const [y, m] = month.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 0, 23, 59, 59, 999);
  const startsBeforeMonthEnds = !startDate || startDate <= monthEnd;
  const endsAfterMonthStarts = !endDate || endDate >= monthStart;
  return startsBeforeMonthEnds && endsAfterMonthStarts;
}

function currentMonthStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
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

function ScenarioRow({ label, revenue, cost, color }: {
  label: string; revenue: number; cost: number; color: string;
}) {
  const profit = revenue - cost;
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0 text-sm">
      <span className={`w-40 shrink-0 ${color}`}>{label}</span>
      <span className="font-mono text-blue-600 w-20 text-right">{eur(revenue)}</span>
      <span className="font-mono text-red-500 w-20 text-right">−{eur(cost)}</span>
      <span className={`font-mono font-semibold w-24 text-right ${profit >= 0 ? 'text-green-600' : 'text-red-500'}`}>
        {sign(profit)}{eur(Math.abs(profit))}
      </span>
    </div>
  );
}

export default function FinancialSummaryPage() {
  const [tConfig, setTConfig] = useState<TransportationConfig | null>(null);
  const [sConfig, setSConfig] = useState<StudyCenterConfig | null>(null);
  const [tSubs, setTSubs] = useState<TransportSub[]>([]);
  const [sSubs, setSSubs] = useState<StudySub[]>([]);
  const [latestSnapshot, setLatestSnapshot] = useState<RouteSnapshot | null>(null);
  const [families, setFamilies] = useState<Record<string, string>>({});
  const [overrideInput, setOverrideInput] = useState('');
  const [savingOverride, setSavingOverride] = useState(false);
  const [loading, setLoading] = useState(true);
  const overrideRef = useRef<HTMLInputElement>(null);

  // Filters — drive every revenue/count figure on the page. Default mirrors
  // the old "Receita Estimada" scenario (active + pending).
  const [statusFilter, setStatusFilter] = useState<SubStatus[]>(['active', 'pending']);
  const [serviceFilter, setServiceFilter] = useState<ServiceFilter>('both');
  const [monthFilter, setMonthFilter] = useState<string>('all');
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const [tCfgSnap, sCfgSnap, tSnap, sSnap, routeSnap, familiesSnap] = await Promise.all([
        getDoc(docRef('config', 'transportation')),
        getDoc(docRef('config', 'studyCenter')),
        getDocs(col('transportationSubscriptions')),
        getDocs(col('studyroom')),
        getDocs(query(col('transportRoutes'), orderBy('savedAt', 'desc'), limit(1))),
        getDocs(col('families')),
      ]);

      let cfg: TransportationConfig | null = null;
      if (tCfgSnap.exists()) {
        cfg = tCfgSnap.data() as TransportationConfig;
        setTConfig(cfg);
        setOverrideInput(cfg.driverMonthlyCostOverride != null ? String(cfg.driverMonthlyCostOverride) : '');
      }
      if (sCfgSnap.exists()) setSConfig(sCfgSnap.data() as StudyCenterConfig);

      if (!routeSnap.empty) {
        const snap = routeSnap.docs[0].data().snapshot as RouteSnapshot | undefined;
        if (snap) setLatestSnapshot(snap);
      }

      const familyNames: Record<string, string> = {};
      for (const d of familiesSnap.docs) {
        const f = d.data();
        familyNames[d.id] = f.primaryContact?.name || '—';
      }
      setFamilies(familyNames);

      // Note: cancelled subs are now kept (not filtered out here) so the
      // status filter below can include them on request.
      setTSubs(tSnap.docs.map(d => {
        const x = d.data();
        return {
          id: d.id,
          status: normalizeSubStatus(x.status),
          monthlyFee: x.monthlyFee ?? 0,
          scheduleLength: (x.schedule ?? []).length,
          familyId: x.familyId ?? '',
          childName: x.childName ?? '',
          startDate: toJsDate(x.startDate),
          endDate: toJsDate(x.endDate),
        };
      }));
      setSSubs(sSnap.docs.map(d => {
        const x = d.data();
        return {
          id: d.id,
          status: normalizeSubStatus(x.status),
          daysCount: (x.days ?? []).filter((dd: any) => dd.day).length,
          familyId: x.familyId ?? '',
          childName: x.childName ?? '',
          startDate: toJsDate(x.startDate),
          endDate: toJsDate(x.endDate),
        };
      }));
      setLoading(false);
    };
    load();
  }, []);

  const tAmountFor = (s: TransportSub) => {
    const flatRate = tConfig?.flatRatePerTrip ?? 0;
    const weeks = tConfig?.weeksPerMonth ?? 4.33;
    return s.monthlyFee > 0 ? s.monthlyFee : s.scheduleLength * flatRate * weeks;
  };
  const tRevenueFor = (subs: TransportSub[]) => subs.reduce((sum, s) => sum + tAmountFor(s), 0);

  const sAmountFor = (s: StudySub) => {
    const dayRate = sConfig?.monthlyPricePerWeekday ?? 24;
    return s.daysCount * dayRate;
  };
  const sRevenueFor = (subs: StudySub[]) => subs.reduce((sum, s) => sum + sAmountFor(s), 0);

  const overrideParsed = overrideInput.trim() !== '' ? parseFloat(overrideInput) : null;
  const isOverrideValid = overrideParsed === null || (!isNaN(overrideParsed) && overrideParsed >= 0);

  const savedOverride = tConfig?.driverMonthlyCostOverride ?? null;
  const plannerDriverCost = latestSnapshot?.driverCost ?? null;
  const plannerElectricityCost = latestSnapshot?.electricityCost ?? 0;

  // Effective driver cost: override > planner snapshot > 0
  const effectiveDriverCost = savedOverride ?? plannerDriverCost ?? 0;

  const tByStatus = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of tSubs) m[s.status] = (m[s.status] ?? 0) + 1;
    return m;
  }, [tSubs]);
  const sByStatus = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of sSubs) m[s.status] = (m[s.status] ?? 0) + 1;
    return m;
  }, [sSubs]);

  const {
    tFiltered, sFiltered, tRevenue, sRevenue, activeOnlyRevenue,
    tCost, sCost, vanCost, driverCost, electricityCost,
  } = useMemo(() => {
    const tFiltered = tSubs.filter(s => statusFilter.includes(s.status) && overlapsMonth(s.startDate, s.endDate, monthFilter));
    const sFiltered = sSubs.filter(s => statusFilter.includes(s.status) && overlapsMonth(s.startDate, s.endDate, monthFilter));
    const tRevenue = tRevenueFor(tFiltered);
    const sRevenue = sRevenueFor(sFiltered);

    const activeOnlyRevenue =
      tRevenueFor(tSubs.filter(s => s.status === 'active' && overlapsMonth(s.startDate, s.endDate, monthFilter))) +
      sRevenueFor(sSubs.filter(s => s.status === 'active' && overlapsMonth(s.startDate, s.endDate, monthFilter)));

    const vanCost = tConfig?.vanMonthlyCost ?? 0;
    const driverCost = effectiveDriverCost;
    const electricityCost = plannerElectricityCost;
    const tCost = vanCost + driverCost + electricityCost;
    const sCost = (sConfig?.teacherMonthlyCost ?? 0) + (sConfig?.rentMonthlyCost ?? 0);

    return { tFiltered, sFiltered, tRevenue, sRevenue, activeOnlyRevenue, tCost, sCost, vanCost, driverCost, electricityCost };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tSubs, sSubs, tConfig, sConfig, effectiveDriverCost, plannerElectricityCost, statusFilter, monthFilter]);

  const showTransport = serviceFilter !== 'study';
  const showStudy = serviceFilter !== 'transport';

  const totalRevenue = (showTransport ? tRevenue : 0) + (showStudy ? sRevenue : 0);
  const totalCost = (showTransport ? tCost : 0) + (showStudy ? sCost : 0);
  const totalProfit = totalRevenue - totalCost;
  const deltaVsActive = totalRevenue - activeOnlyRevenue;
  const isActiveOnlyFilter = samePreset(statusFilter, ['active']);

  const filterLabel = statusFilter.length === 0
    ? 'nenhum estado selecionado'
    : statusFilter.map(s => STATUS_LABEL[s]).join(' + ');

  const periodLabel = monthFilter === 'all'
    ? 'todos os períodos'
    : new Date(Number(monthFilter.split('-')[0]), Number(monthFilter.split('-')[1]) - 1, 1)
        .toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' });

  interface DetailRow {
    key: string; parent: string; child: string; service: string; status: SubStatus; amount: number;
  }
  const detailRows = useMemo(() => {
    const rows: DetailRow[] = [];
    if (showTransport) {
      for (const s of tFiltered) {
        rows.push({
          key: `t-${s.id}`,
          parent: families[s.familyId] ?? '—',
          child: s.childName || '—',
          service: 'Transporte',
          status: s.status,
          amount: tAmountFor(s),
        });
      }
    }
    if (showStudy) {
      for (const s of sFiltered) {
        rows.push({
          key: `s-${s.id}`,
          parent: families[s.familyId] ?? '—',
          child: s.childName || '—',
          service: 'Sala de Estudo',
          status: s.status,
          amount: sAmountFor(s),
        });
      }
    }
    return rows.sort((a, b) => b.amount - a.amount);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tFiltered, sFiltered, families, showTransport, showStudy]);

  function toggleStatus(s: SubStatus) {
    setStatusFilter(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  }

  async function saveDriverOverride(valueOverride?: number | null) {
    if (!isOverrideValid && valueOverride === undefined) return;
    setSavingOverride(true);
    try {
      const value = valueOverride !== undefined ? valueOverride : (overrideInput.trim() === '' ? null : overrideParsed);
      await setDoc(docRef('config', 'transportation'), { driverMonthlyCostOverride: value ?? null }, { merge: true });
      setTConfig(prev => prev ? { ...prev, driverMonthlyCostOverride: value ?? undefined } : prev);
    } finally {
      setSavingOverride(false);
    }
  }

  async function clearDriverOverride() {
    setOverrideInput('');
    await saveDriverOverride(null);
  }

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-400">A carregar…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Resumo Financeiro</h1>
          <p className="text-sm text-gray-500 mt-0.5">Transporte + Sala de Estudo · todos os custos</p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Estado das inscrições</div>
            <div className="flex gap-1.5">
              {ALL_STATUSES.map(s => (
                <button
                  key={s}
                  onClick={() => toggleStatus(s)}
                  className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                    statusFilter.includes(s)
                      ? STATUS_PILL_CLASS[s] + ' border-transparent'
                      : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Serviço</div>
            <div className="flex gap-1.5">
              {(['both', 'transport', 'study'] as ServiceFilter[]).map(f => (
                <button
                  key={f}
                  onClick={() => setServiceFilter(f)}
                  className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                    serviceFilter === f
                      ? 'bg-indigo-100 text-indigo-700 border-transparent'
                      : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {f === 'both' ? 'Ambos' : f === 'transport' ? 'Transporte' : 'Sala de Estudo'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Atalhos</div>
            <div className="flex gap-1.5">
              {PRESETS.map(p => (
                <button
                  key={p.label}
                  onClick={() => setStatusFilter(p.statuses)}
                  className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                    samePreset(statusFilter, p.statuses)
                      ? 'bg-gray-900 text-white border-transparent'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {p.label}
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

      {/* Combined KPIs — all driven by the filter above */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KPI
          label="Receita (filtro atual)"
          value={eur(totalRevenue)}
          sub={`${filterLabel} · ${periodLabel}`}
          color="text-blue-600"
        />
        <KPI
          label="Custos fixos"
          value={eur(totalCost)}
          sub="van + motorista + professora + renda"
          color="text-red-600"
        />
        <KPI
          label="Lucro (filtro atual)"
          value={`${sign(totalProfit)}${eur(Math.abs(totalProfit))}`}
          sub={totalRevenue > 0 ? (totalProfit >= 0 ? `${Math.round(totalProfit / totalRevenue * 100)}% margem` : 'deficit') : '—'}
          color={totalProfit >= 0 ? 'text-green-600' : 'text-red-600'}
        />
        <KPI
          label="Δ vs. apenas ativos"
          value={`${sign(deltaVsActive)}${eur(Math.abs(deltaVsActive))}`}
          sub={isActiveOnlyFilter ? 'filtro atual = ativos' : 'receita adicional incluída pelo filtro'}
          color={deltaVsActive === 0 ? 'text-gray-500' : deltaVsActive > 0 ? 'text-indigo-600' : 'text-red-600'}
        />
      </div>

      {/* P&L table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700">Demonstração de resultados</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Nota: receita é calculada a partir do estado das inscrições (não confirma pagamento efetuado).
          </p>
        </div>
        <div className="px-5 py-3">
          <div className="flex items-center justify-between pb-2 border-b border-gray-200 text-xs font-semibold text-gray-400 uppercase tracking-wide">
            <span className="w-40">Cenário</span>
            <span className="w-20 text-right">Receita</span>
            <span className="w-20 text-right">Custos</span>
            <span className="w-24 text-right">Lucro</span>
          </div>
          <ScenarioRow label={`Filtro atual (${filterLabel})`} revenue={totalRevenue} cost={totalCost} color="text-blue-600" />
          {!isActiveOnlyFilter && (
            <ScenarioRow label="Referência: apenas ativos" revenue={activeOnlyRevenue} cost={totalCost} color="text-gray-400" />
          )}
          {deltaVsActive > 0 && (
            <div className="pt-2 text-xs text-gray-400">
              Face a "apenas ativos": <span className="font-semibold text-gray-600">{eur(deltaVsActive)}</span> de receita adicional incluída pelo filtro
            </div>
          )}
        </div>
      </div>

      {/* Revenue detail — collapsible, line-by-line origin of the "Receita (filtro atual)" figure */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <button
          onClick={() => setDetailOpen(o => !o)}
          className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-gray-50 transition-colors"
        >
          <div>
            <h2 className="text-sm font-semibold text-gray-700">Detalhe da receita</h2>
            <p className="text-xs text-gray-400 mt-0.5">{detailRows.length} inscrições — {filterLabel} · {periodLabel}</p>
          </div>
          <span className={`text-gray-400 transition-transform ${detailOpen ? 'rotate-180' : ''}`}>▾</span>
        </button>
        {detailOpen && (
          <div className="border-t border-gray-100 max-h-96 overflow-y-auto">
            {detailRows.length === 0 ? (
              <div className="px-5 py-6 text-center text-sm text-gray-400">Sem inscrições para este filtro.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-xs font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-200">
                    <th className="text-left px-5 py-2">Encarregado</th>
                    <th className="text-left px-5 py-2">Criança</th>
                    <th className="text-left px-5 py-2">Serviço</th>
                    <th className="text-left px-5 py-2">Estado</th>
                    <th className="text-right px-5 py-2">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map(row => (
                    <tr key={row.key} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                      <td className="px-5 py-2 text-gray-700">{row.parent}</td>
                      <td className="px-5 py-2 text-gray-500">{row.child}</td>
                      <td className="px-5 py-2 text-gray-500">{row.service}</td>
                      <td className="px-5 py-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_PILL_CLASS[row.status]}`}>
                          {STATUS_LABEL[row.status]}
                        </span>
                      </td>
                      <td className="px-5 py-2 text-right font-mono text-blue-600">{eur(row.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-gray-200 font-semibold">
                    <td className="px-5 py-2 text-gray-700" colSpan={4}>Total</td>
                    <td className="px-5 py-2 text-right font-mono text-blue-600">{eur(totalRevenue)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Service breakdown */}
      <div className={`grid grid-cols-1 gap-4 ${showTransport && showStudy ? 'md:grid-cols-2' : ''}`}>
        {/* Transport */}
        {showTransport && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">🚌 Transporte</h2>
            <Link to="/admin/transport-planner" className="text-xs text-indigo-600 hover:underline">Ver planeador →</Link>
          </div>
          <div className="px-5 py-4 space-y-3">
            <div>
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1">Receita (filtro atual)</div>
              <div className="text-xl font-bold text-blue-600">{eur(tRevenue)}</div>
              <div className="text-xs text-gray-400">{tFiltered.length} inscrições — {filterLabel}</div>
            </div>

            {/* Status pills */}
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(tByStatus).sort().map(([status, n]) => (
                <span key={status} className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_PILL_CLASS[status as SubStatus] ?? 'bg-gray-100 text-gray-500'}`}>
                  {n} {STATUS_LABEL[status as SubStatus] ?? status}
                </span>
              ))}
            </div>

            {/* Costs */}
            <div className="pt-2 border-t border-gray-100 text-xs text-gray-500 space-y-1">
              <div className="flex justify-between">
                <span>Van (fixo)</span>
                <span className="font-mono text-red-500">{eur(vanCost)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span>
                  Motorista
                  {savedOverride != null
                    ? <span className="ml-1 text-amber-600">(override)</span>
                    : plannerDriverCost != null
                    ? <span className="ml-1 text-gray-400">(do planeador)</span>
                    : <span className="ml-1 text-gray-300">(sem dados)</span>}
                </span>
                <span className="font-mono text-red-500">{eur(driverCost)}</span>
              </div>
              {electricityCost > 0 && (
                <div className="flex justify-between">
                  <span>Energia (do planeador)</span>
                  <span className="font-mono text-red-500">{eur(electricityCost)}</span>
                </div>
              )}
              <div className="flex justify-between font-semibold border-t border-gray-100 pt-1 mt-1">
                <span>Total transporte</span>
                <span className="font-mono text-red-500">{eur(tCost)}</span>
              </div>
            </div>

            {/* Driver override input */}
            <div className="pt-1 border-t border-gray-100">
              <div className="text-xs text-gray-400 mb-1.5">
                Custo motorista
                {plannerDriverCost != null && (
                  <span className="ml-1">· do planeador: <strong className="text-gray-600">{eur(plannerDriverCost)}</strong></span>
                )}
              </div>
              <div className="flex gap-2 items-center">
                <div className="relative flex-1">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">€</span>
                  <input
                    ref={overrideRef}
                    type="number"
                    min="0"
                    step="1"
                    placeholder={plannerDriverCost != null ? String(Math.round(plannerDriverCost)) : 'Override manual'}
                    value={overrideInput}
                    onChange={e => setOverrideInput(e.target.value)}
                    className={`w-full pl-6 pr-3 py-1.5 text-xs border rounded-lg outline-none focus:ring-1 ${
                      !isOverrideValid ? 'border-red-300 focus:ring-red-400' : 'border-gray-200 focus:ring-indigo-400'
                    }`}
                  />
                </div>
                <button
                  onClick={() => saveDriverOverride()}
                  disabled={savingOverride || !isOverrideValid}
                  className="text-xs px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 shrink-0"
                >
                  {savingOverride ? '…' : 'Guardar'}
                </button>
                {savedOverride != null && (
                  <button
                    onClick={clearDriverOverride}
                    className="text-xs px-2 py-1.5 border border-gray-200 text-gray-500 rounded-lg hover:bg-gray-50 shrink-0"
                    title="Limpar override"
                  >
                    ✕
                  </button>
                )}
              </div>
              {savedOverride != null && (
                <p className="text-xs text-amber-600 mt-1">Override activo — a ignorar valor do planeador.</p>
              )}
            </div>

            {tConfig?.flatRatePerTrip && (
              <div className="text-xs text-gray-400">
                €{tConfig.flatRatePerTrip}/viagem × {tConfig.weeksPerMonth} sem
              </div>
            )}
          </div>
        </div>
        )}

        {/* Study Room */}
        {showStudy && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">📚 Sala de Estudo</h2>
            <Link to="/admin/study-room-planner" className="text-xs text-indigo-600 hover:underline">Ver planeador →</Link>
          </div>
          <div className="px-5 py-4 space-y-3">
            <div>
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1">Receita (filtro atual)</div>
              <div className="text-xl font-bold text-blue-600">{eur(sRevenue)}</div>
              <div className="text-xs text-gray-400">{sFiltered.length} inscrições — {filterLabel}</div>
            </div>

            {/* Status pills */}
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(sByStatus).sort().map(([status, n]) => (
                <span key={status} className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_PILL_CLASS[status as SubStatus] ?? 'bg-gray-100 text-gray-500'}`}>
                  {n} {STATUS_LABEL[status as SubStatus] ?? status}
                </span>
              ))}
            </div>

            {/* Costs */}
            <div className="pt-2 border-t border-gray-100 text-xs text-gray-500 space-y-1">
              <div className="flex justify-between">
                <span>Professora</span>
                <span className="font-mono text-red-500">{eur(sConfig?.teacherMonthlyCost ?? 0)}</span>
              </div>
              <div className="flex justify-between">
                <span>Renda</span>
                <span className="font-mono text-red-500">{eur(sConfig?.rentMonthlyCost ?? 0)}</span>
              </div>
              <div className="flex justify-between font-semibold border-t border-gray-100 pt-1 mt-1">
                <span>Total sala</span>
                <span className="font-mono text-red-500">{eur(sCost)}</span>
              </div>
            </div>

            {sConfig?.pricePerDayPerWeek != null && (
              <div className="text-xs text-gray-400">
                €{sConfig.pricePerDayPerWeek}/dia × {sConfig.weeksPerMonth} sem
              </div>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
