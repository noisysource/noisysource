import { useState, useEffect, useMemo } from 'react';
import { getDocs, getDoc, setDoc } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { col, docRef } from '../../lib/db';
import { TransportationConfig } from '@shared/models/Transportation';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import { normalizeSubStatus, SubStatus } from '../../lib/utils';

interface AppliedDiscountLite { ruleId: string; name: string; percentage: number }

interface TransportSub {
  id: string;
  status: SubStatus;
  monthlyFee: number;
  appliedDiscounts: AppliedDiscountLite[];
  scheduleLength: number;
  familyId: string;
  childName: string;
  startDate: Date | null;
  endDate: Date | null;
}

interface StudySub {
  id: string;
  status: SubStatus;
  monthlyPrice: number;
  appliedDiscounts: AppliedDiscountLite[];
  daysCount: number;
  familyId: string;
  childName: string;
  startDate: Date | null;
  endDate: Date | null;
}

type ServiceFilter = 'both' | 'transport' | 'study';

type CostFieldKey =
  | 'transport.vanMonthlyCost'
  | 'transport.driverMonthlyCost'
  | 'transport.electricityMonthlyCost'
  | 'study.teacherMonthlyCost'
  | 'study.rentMonthlyCost';

const COST_FIELD_META: Record<CostFieldKey, { configDoc: 'transportation' | 'studyCenter'; field: string }> = {
  'transport.vanMonthlyCost': { configDoc: 'transportation', field: 'vanMonthlyCost' },
  'transport.driverMonthlyCost': { configDoc: 'transportation', field: 'driverMonthlyCost' },
  'transport.electricityMonthlyCost': { configDoc: 'transportation', field: 'electricityMonthlyCost' },
  'study.teacherMonthlyCost': { configDoc: 'studyCenter', field: 'teacherMonthlyCost' },
  'study.rentMonthlyCost': { configDoc: 'studyCenter', field: 'rentMonthlyCost' },
};

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
  const [tConfig, setTConfig] = useState<TransportationConfig | null>(null);
  const [sConfig, setSConfig] = useState<StudyCenterConfig | null>(null);
  const [tSubs, setTSubs] = useState<TransportSub[]>([]);
  const [sSubs, setSSubs] = useState<StudySub[]>([]);
  const [families, setFamilies] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  // Fixed-cost inputs — edited directly here, not derived from a planned
  // route snapshot. Keyed the same as CostFieldKey so one generic save
  // handler covers all five fields.
  const [costInputs, setCostInputs] = useState<Record<CostFieldKey, string>>({
    'transport.vanMonthlyCost': '',
    'transport.driverMonthlyCost': '',
    'transport.electricityMonthlyCost': '',
    'study.teacherMonthlyCost': '',
    'study.rentMonthlyCost': '',
  });
  const [savingCostField, setSavingCostField] = useState<CostFieldKey | null>(null);

  // Filters — drive every revenue/count figure on the page. Default mirrors
  // the old "Receita Estimada" scenario (active + pending).
  const [statusFilter, setStatusFilter] = useState<SubStatus[]>(['active', 'pending']);
  const [serviceFilter, setServiceFilter] = useState<ServiceFilter>('both');
  const [monthFilter, setMonthFilter] = useState<string>('all');
  const [detailOpen, setDetailOpen] = useState(false);
  // Discount scenario: rule ids switched OFF for simulation only. Nothing here
  // is ever written — it re-prices the displayed figures so "what if we dropped
  // this discount" can be answered without touching a single subscription.
  const [offRules, setOffRules] = useState<Set<string>>(new Set());

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const [tCfgSnap, sCfgSnap, tSnap, sSnap, familiesSnap] = await Promise.all([
        getDoc(docRef('config', 'transportation')),
        getDoc(docRef('config', 'studyCenter')),
        getDocs(col('transportationSubscriptions')),
        getDocs(col('studyroom')),
        getDocs(col('families')),
      ]);

      let cfg: TransportationConfig | null = null;
      let sCfg: StudyCenterConfig | null = null;
      if (tCfgSnap.exists()) {
        cfg = tCfgSnap.data() as TransportationConfig;
        setTConfig(cfg);
      }
      if (sCfgSnap.exists()) {
        sCfg = sCfgSnap.data() as StudyCenterConfig;
        setSConfig(sCfg);
      }
      setCostInputs({
        'transport.vanMonthlyCost': cfg?.vanMonthlyCost != null ? String(cfg.vanMonthlyCost) : '',
        'transport.driverMonthlyCost': cfg?.driverMonthlyCost != null ? String(cfg.driverMonthlyCost) : '',
        'transport.electricityMonthlyCost': cfg?.electricityMonthlyCost != null ? String(cfg.electricityMonthlyCost) : '',
        'study.teacherMonthlyCost': sCfg?.teacherMonthlyCost != null ? String(sCfg.teacherMonthlyCost) : '',
        'study.rentMonthlyCost': sCfg?.rentMonthlyCost != null ? String(sCfg.rentMonthlyCost) : '',
      });

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
          appliedDiscounts: (x.appliedDiscounts ?? []) as AppliedDiscountLite[],
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
          appliedDiscounts: (x.appliedDiscounts ?? []) as AppliedDiscountLite[],
          monthlyPrice: x.monthlyPrice ?? 0,
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
    // Mirrors tAmountFor above: prefer the stored price, which is NET of
    // sibling / returning-student discounts, and only fall back to the
    // computed gross when there isn't one. This used to return the gross
    // unconditionally, so every study-room discount was invisible here and
    // the page overstated revenue (and therefore profit) by exactly the
    // discounts it had given away — while transport, right above, had always
    // reported net.
    return s.monthlyPrice > 0 ? s.monthlyPrice : s.daysCount * dayRate;
  };
  const sRevenueFor = (subs: StudySub[]) => subs.reduce((sum, s) => sum + sAmountFor(s), 0);

  // ── Discount scenarios ────────────────────────────────────────────────────
  // Gross is derived from the stored NET and the discounts actually on the
  // document, rather than recomputed from the schedule. That makes the
  // baseline exact by construction: with nothing toggled off the scenario
  // total equals the real total to the cent, even for a subscription whose
  // stored fee has drifted from what the formula would produce. Recomputing
  // gross from trips/days would quietly "correct" such a row and the baseline
  // would no longer match the page above it.
  const pctOf = (ds: AppliedDiscountLite[], skip: Set<string>) =>
    Math.min(ds.reduce((n, d) => n + (skip.has(d.ruleId) ? 0 : d.percentage), 0), 1);

  const grossOf = (net: number, ds: AppliedDiscountLite[]) => {
    const all = pctOf(ds, new Set());
    return all > 0 && all < 1 ? net / (1 - all) : net;
  };

  const scenarioAmount = (net: number, ds: AppliedDiscountLite[], off: Set<string>) =>
    Math.round(grossOf(net, ds) * (1 - pctOf(ds, off)) * 100) / 100;

  /** Every discount rule actually in use, with what it currently costs. */
  const rulesInUse = useMemo(() => {
    const m = new Map<string, { ruleId: string; name: string; percentage: number; subs: number; worth: number }>();
    const add = (ds: AppliedDiscountLite[], net: number) => {
      for (const d of ds) {
        const e = m.get(d.ruleId) ?? { ruleId: d.ruleId, name: d.name, percentage: d.percentage, subs: 0, worth: 0 };
        e.subs += 1;
        // What this one rule gives away on this subscription, holding the others.
        e.worth += scenarioAmount(net, ds, new Set([d.ruleId])) - net;
        m.set(d.ruleId, e);
      }
    };
    for (const s of tSubs) if (s.status !== 'cancelled') add(s.appliedDiscounts, tAmountFor(s));
    for (const s of sSubs) if (s.status !== 'cancelled') add(s.appliedDiscounts, sAmountFor(s));
    return [...m.values()].sort((a, b) => b.worth - a.worth);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tSubs, sSubs]);

  const toggleRule = (id: string) => setOffRules(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

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
    const driverCost = tConfig?.driverMonthlyCost ?? 0;
    const electricityCost = tConfig?.electricityMonthlyCost ?? 0;
    const tCost = vanCost + driverCost + electricityCost;
    const sCost = (sConfig?.teacherMonthlyCost ?? 0) + (sConfig?.rentMonthlyCost ?? 0);

    return { tFiltered, sFiltered, tRevenue, sRevenue, activeOnlyRevenue, tCost, sCost, vanCost, driverCost, electricityCost };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tSubs, sSubs, tConfig, sConfig, statusFilter, monthFilter]);

  const showTransport = serviceFilter !== 'study';
  const showStudy = serviceFilter !== 'transport';

  const totalRevenue = (showTransport ? tRevenue : 0) + (showStudy ? sRevenue : 0);

  // Same filtered sets, re-priced with offRules removed. Equals totalRevenue
  // exactly when nothing is toggled off.
  const scenarioRevenue = useMemo(() => {
    const t = showTransport ? tFiltered.reduce((n, x) => n + scenarioAmount(tAmountFor(x), x.appliedDiscounts, offRules), 0) : 0;
    const st = showStudy ? sFiltered.reduce((n, x) => n + scenarioAmount(sAmountFor(x), x.appliedDiscounts, offRules), 0) : 0;
    return Math.round((t + st) * 100) / 100;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tFiltered, sFiltered, offRules, showTransport, showStudy, tConfig, sConfig]);

  const scenarioDelta = Math.round((scenarioRevenue - totalRevenue) * 100) / 100;
  const scenarioOn = offRules.size > 0;
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

  async function saveCostField(key: CostFieldKey) {
    const raw = costInputs[key].trim();
    const value = raw === '' ? 0 : parseFloat(raw);
    if (isNaN(value) || value < 0) return;
    const { configDoc, field } = COST_FIELD_META[key];
    setSavingCostField(key);
    try {
      await setDoc(docRef('config', configDoc), { [field]: value }, { merge: true });
      if (configDoc === 'transportation') {
        setTConfig(prev => prev ? { ...prev, [field]: value } : prev);
      } else {
        setSConfig(prev => prev ? { ...prev, [field]: value } : prev);
      }
      setCostInputs(prev => ({ ...prev, [key]: String(value) }));
    } finally {
      setSavingCostField(null);
    }
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

      {/* Fixed costs — edited here directly, independent of the Transport Planner.
          The planner only estimates cost while planning a route; it never feeds
          these numbers, so the P&L stays correct even with no route ever saved. */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700">Custos Fixos</h2>
          <p className="text-xs text-gray-400 mt-0.5">Editar diretamente aqui — não depende do planeador de rotas.</p>
        </div>
        <div className="px-5 py-3 grid grid-cols-1 sm:grid-cols-2 gap-x-8 divide-y sm:divide-y-0 divide-gray-100">
          <div className="divide-y divide-gray-100">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide pt-2 pb-1">🚌 Transporte</div>
            <EditableCostRow
              label="Van"
              value={costInputs['transport.vanMonthlyCost']}
              saving={savingCostField === 'transport.vanMonthlyCost'}
              onChange={v => setCostInputs(prev => ({ ...prev, 'transport.vanMonthlyCost': v }))}
              onSave={() => saveCostField('transport.vanMonthlyCost')}
            />
            <EditableCostRow
              label="Motorista"
              value={costInputs['transport.driverMonthlyCost']}
              saving={savingCostField === 'transport.driverMonthlyCost'}
              onChange={v => setCostInputs(prev => ({ ...prev, 'transport.driverMonthlyCost': v }))}
              onSave={() => saveCostField('transport.driverMonthlyCost')}
            />
            <EditableCostRow
              label="Eletricidade"
              value={costInputs['transport.electricityMonthlyCost']}
              saving={savingCostField === 'transport.electricityMonthlyCost'}
              onChange={v => setCostInputs(prev => ({ ...prev, 'transport.electricityMonthlyCost': v }))}
              onSave={() => saveCostField('transport.electricityMonthlyCost')}
            />
          </div>
          <div className="divide-y divide-gray-100">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide pt-2 pb-1">📚 Sala de Estudo</div>
            <EditableCostRow
              label="Professora"
              value={costInputs['study.teacherMonthlyCost']}
              saving={savingCostField === 'study.teacherMonthlyCost'}
              onChange={v => setCostInputs(prev => ({ ...prev, 'study.teacherMonthlyCost': v }))}
              onSave={() => saveCostField('study.teacherMonthlyCost')}
            />
            <EditableCostRow
              label="Renda"
              value={costInputs['study.rentMonthlyCost']}
              saving={savingCostField === 'study.rentMonthlyCost'}
              onChange={v => setCostInputs(prev => ({ ...prev, 'study.rentMonthlyCost': v }))}
              onSave={() => saveCostField('study.rentMonthlyCost')}
            />
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
          sub="van + motorista + eletricidade + professora + renda"
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

      {/* Discount scenarios — simulation only, nothing is written */}
      {rulesInUse.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold text-gray-700">Simular descontos</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                Desligue um ou mais descontos para ver o efeito na receita. Simulação apenas — nenhuma inscrição é alterada.
              </p>
            </div>
            {scenarioOn && (
              <button
                onClick={() => setOffRules(new Set())}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:border-gray-400 hover:text-gray-700 transition-colors"
              >
                Repor
              </button>
            )}
          </div>

          <div className="px-5 py-3 flex flex-wrap gap-2">
            {rulesInUse.map(r => {
              const off = offRules.has(r.ruleId);
              return (
                <button
                  key={r.ruleId}
                  onClick={() => toggleRule(r.ruleId)}
                  aria-pressed={off}
                  className={`text-xs px-3 py-2 rounded-lg border text-left transition-colors ${
                    off
                      ? 'bg-amber-50 border-amber-300 text-amber-900'
                      : 'bg-white border-gray-200 text-gray-600 hover:border-gray-400'
                  }`}
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    <span className={`inline-block w-2 h-2 rounded-full ${off ? 'bg-amber-500' : 'bg-green-500'}`} />
                    {r.name}
                    <span className="text-gray-400 font-normal">{Math.round(r.percentage * 100)}%</span>
                  </span>
                  <span className="block mt-0.5 text-[11px] text-gray-400">
                    {r.subs} inscriç{r.subs === 1 ? 'ão' : 'ões'} · vale {eur(Math.abs(r.worth))}/mês
                    {off && <span className="text-amber-700 font-medium"> · desligado</span>}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="px-5 py-3 border-t border-gray-100 bg-gray-50 flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <span className="text-xs text-gray-400 uppercase tracking-wide font-semibold">Receita simulada</span>
            <span className="font-mono text-lg font-semibold text-gray-900">{eur(scenarioRevenue)}</span>
            {scenarioOn ? (
              <>
                <span className={`font-mono text-sm font-semibold ${scenarioDelta >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {scenarioDelta >= 0 ? '+' : ''}{eur(scenarioDelta)}
                </span>
                <span className="text-xs text-gray-400">
                  face a {eur(totalRevenue)} ({filterLabel})
                  {totalRevenue > 0 && ` · ${scenarioDelta >= 0 ? '+' : ''}${(scenarioDelta / totalRevenue * 100).toFixed(1)}%`}
                </span>
              </>
            ) : (
              <span className="text-xs text-gray-400">igual à receita atual — nada desligado</span>
            )}
          </div>
        </div>
      )}

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

            {/* Costs — read-only here; edited in the "Custos Fixos" panel above */}
            <div className="pt-2 border-t border-gray-100 text-xs text-gray-500 space-y-1">
              <div className="flex justify-between">
                <span>Van</span>
                <span className="font-mono text-red-500">{eur(vanCost)}</span>
              </div>
              <div className="flex justify-between">
                <span>Motorista</span>
                <span className="font-mono text-red-500">{eur(driverCost)}</span>
              </div>
              <div className="flex justify-between">
                <span>Eletricidade</span>
                <span className="font-mono text-red-500">{eur(electricityCost)}</span>
              </div>
              <div className="flex justify-between font-semibold border-t border-gray-100 pt-1 mt-1">
                <span>Total transporte</span>
                <span className="font-mono text-red-500">{eur(tCost)}</span>
              </div>
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
