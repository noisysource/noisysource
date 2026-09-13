import { useState, useEffect, useMemo, useRef } from 'react';
import { getDocs, getDoc, query, orderBy, limit, setDoc } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { col, docRef } from '../../lib/db';
import { TransportationConfig } from '@shared/models/Transportation';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';

interface TransportSub {
  id: string;
  status: string;
  monthlyFee: number;
  scheduleLength: number;
}

interface StudySub {
  id: string;
  status: string;
  daysCount: number;
}

interface RouteSnapshot {
  driverCost: number;
  vanCost: number;
  electricityCost: number;
  monthlyCost: number;
  monthlyRevenue: number;
  monthlyRevenueActive: number;
}

const T_ACTIVE = ['active'];
const T_PIPELINE = ['active', 'planned', 'offered', 'pending'];
const S_ACTIVE = ['confirmed'];
const S_PIPELINE = ['confirmed', 'pending'];

function eur(n: number) {
  const abs = Math.abs(Math.round(n));
  return (n < 0 ? '−' : '') + '€' + abs.toLocaleString('pt-PT');
}

function sign(n: number) { return n >= 0 ? '+' : '−'; }

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
      <span className="text-gray-500 w-28 shrink-0">{label}</span>
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
  const [overrideInput, setOverrideInput] = useState('');
  const [savingOverride, setSavingOverride] = useState(false);
  const [loading, setLoading] = useState(true);
  const overrideRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const [tCfgSnap, sCfgSnap, tSnap, sSnap, routeSnap] = await Promise.all([
        getDoc(docRef('config', 'transportation')),
        getDoc(docRef('config', 'studyCenter')),
        getDocs(col('transportationSubscriptions')),
        getDocs(col('studyroom')),
        getDocs(query(col('transportRoutes'), orderBy('savedAt', 'desc'), limit(1))),
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

      setTSubs(tSnap.docs
        .map(d => { const x = d.data(); return { id: d.id, status: x.status ?? 'pending', monthlyFee: x.monthlyFee ?? 0, scheduleLength: (x.schedule ?? []).length }; })
        .filter(s => s.status !== 'cancelled' && s.status !== 'canceled')
      );
      setSSubs(sSnap.docs
        .map(d => { const x = d.data(); return { id: d.id, status: x.status ?? 'pending', daysCount: (x.days ?? []).filter((dd: any) => dd.day).length }; })
        .filter(s => s.status !== 'canceled' && s.status !== 'archived')
      );
      setLoading(false);
    };
    load();
  }, []);

  const tRevenue = (subs: TransportSub[], statuses: string[]) => {
    const pool = subs.filter(s => statuses.includes(s.status));
    const flatRate = tConfig?.flatRatePerTrip ?? 0;
    const weeks = tConfig?.weeksPerMonth ?? 4.33;
    return pool.reduce((sum, s) => sum + (s.monthlyFee > 0 ? s.monthlyFee : s.scheduleLength * flatRate * weeks), 0);
  };

  const sRevenue = (subs: StudySub[], statuses: string[]) => {
    const pool = subs.filter(s => statuses.includes(s.status));
    const dayRate = sConfig?.monthlyPricePerWeekday ?? 24;
    return pool.reduce((sum, s) => sum + s.daysCount * dayRate, 0);
  };

  const overrideParsed = overrideInput.trim() !== '' ? parseFloat(overrideInput) : null;
  const isOverrideValid = overrideParsed === null || (!isNaN(overrideParsed) && overrideParsed >= 0);

  const savedOverride = tConfig?.driverMonthlyCostOverride ?? null;
  const plannerDriverCost = latestSnapshot?.driverCost ?? null;
  const plannerElectricityCost = latestSnapshot?.electricityCost ?? 0;

  // Effective driver cost: override > planner snapshot > 0
  const effectiveDriverCost = savedOverride ?? plannerDriverCost ?? 0;

  const { tReal, tForecast, sReal, sForecast, tCost, sCost, tCount, sCount, vanCost, driverCost, electricityCost } = useMemo(() => {
    const tReal = tRevenue(tSubs, T_ACTIVE);
    const tForecast = tRevenue(tSubs, T_PIPELINE);
    const sReal = sRevenue(sSubs, S_ACTIVE);
    const sForecast = sRevenue(sSubs, S_PIPELINE);
    const vanCost = tConfig?.vanMonthlyCost ?? 0;
    const driverCost = effectiveDriverCost;
    const electricityCost = plannerElectricityCost;
    const tCost = vanCost + driverCost + electricityCost;
    const sCost = (sConfig?.teacherMonthlyCost ?? 0) + (sConfig?.rentMonthlyCost ?? 0);
    const tCount = { real: tSubs.filter(s => T_ACTIVE.includes(s.status)).length, forecast: tSubs.filter(s => T_PIPELINE.includes(s.status)).length };
    const sCount = { real: sSubs.filter(s => S_ACTIVE.includes(s.status)).length, forecast: sSubs.filter(s => S_PIPELINE.includes(s.status)).length };
    return { tReal, tForecast, sReal, sForecast, tCost, sCost, tCount, sCount, vanCost, driverCost, electricityCost };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tSubs, sSubs, tConfig, sConfig, effectiveDriverCost, plannerElectricityCost]);

  const totalCost = tCost + sCost;
  const totalForecastRevenue = tForecast + sForecast;
  const totalRealRevenue = tReal + sReal;
  const totalForecastProfit = totalForecastRevenue - totalCost;
  const totalRealProfit = totalRealRevenue - totalCost;

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

      {/* Combined KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KPI
          label="Receita estimada"
          value={eur(totalForecastRevenue)}
          sub={`${tCount.forecast} transp. + ${sCount.forecast} sala`}
          color="text-indigo-600"
        />
        <KPI
          label="Receita realidade"
          value={eur(totalRealRevenue)}
          sub={`${tCount.real} transp. + ${sCount.real} sala`}
          color="text-blue-600"
        />
        <KPI
          label="Custos fixos"
          value={eur(totalCost)}
          sub="van + motorista + professora + renda"
          color="text-red-600"
        />
        <KPI
          label="Lucro estimado"
          value={`${sign(totalForecastProfit)}${eur(Math.abs(totalForecastProfit))}`}
          sub={totalForecastRevenue > 0 ? (totalForecastProfit >= 0 ? `${Math.round(totalForecastProfit / totalForecastRevenue * 100)}% margem` : 'deficit') : '—'}
          color={totalForecastProfit >= 0 ? 'text-green-600' : 'text-red-600'}
        />
      </div>

      {/* P&L table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700">Demonstração de resultados</h2>
        </div>
        <div className="px-5 py-3">
          <div className="flex items-center justify-between pb-2 border-b border-gray-200 text-xs font-semibold text-gray-400 uppercase tracking-wide">
            <span className="w-28">Cenário</span>
            <span className="w-20 text-right">Receita</span>
            <span className="w-20 text-right">Custos</span>
            <span className="w-24 text-right">Lucro</span>
          </div>
          <ScenarioRow label="Realidade" revenue={totalRealRevenue} cost={totalCost} color="text-blue-600" />
          <ScenarioRow label="Estimado" revenue={totalForecastRevenue} cost={totalCost} color="text-indigo-600" />
          {totalForecastRevenue > totalRealRevenue && (
            <div className="pt-2 text-xs text-gray-400">
              Pipeline por converter: <span className="font-semibold text-gray-600">{eur(totalForecastRevenue - totalRealRevenue)}</span> de receita adicional possível
            </div>
          )}
        </div>
      </div>

      {/* Service breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Transport */}
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">🚌 Transporte</h2>
            <Link to="/admin/transport-planner" className="text-xs text-indigo-600 hover:underline">Ver planeador →</Link>
          </div>
          <div className="px-5 py-4 space-y-3">
            <div className="flex gap-4">
              <div className="flex-1">
                <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1">Estimado</div>
                <div className="text-xl font-bold text-indigo-600">{eur(tForecast)}</div>
                <div className="text-xs text-gray-400">{tCount.forecast} inscrições</div>
              </div>
              <div className="flex-1">
                <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1">Realidade</div>
                <div className="text-xl font-bold text-blue-600">{eur(tReal)}</div>
                <div className="text-xs text-gray-400">{tCount.real} ativas</div>
              </div>
            </div>

            {/* Status pills */}
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(tByStatus).sort().map(([status, n]) => (
                <span key={status} className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  status === 'active' ? 'bg-green-100 text-green-700' :
                  status === 'planned' ? 'bg-blue-100 text-blue-700' :
                  status === 'offered' ? 'bg-purple-100 text-purple-700' :
                  'bg-yellow-100 text-yellow-700'
                }`}>{n} {status}</span>
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
                  onClick={saveDriverOverride}
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

        {/* Study Room */}
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">📚 Sala de Estudo</h2>
            <Link to="/admin/study-room-planner" className="text-xs text-indigo-600 hover:underline">Ver planeador →</Link>
          </div>
          <div className="px-5 py-4 space-y-3">
            <div className="flex gap-4">
              <div className="flex-1">
                <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1">Estimado</div>
                <div className="text-xl font-bold text-indigo-600">{eur(sForecast)}</div>
                <div className="text-xs text-gray-400">{sCount.forecast} inscrições</div>
              </div>
              <div className="flex-1">
                <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1">Realidade</div>
                <div className="text-xl font-bold text-blue-600">{eur(sReal)}</div>
                <div className="text-xs text-gray-400">{sCount.real} confirmadas</div>
              </div>
            </div>

            {/* Status pills */}
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(sByStatus).sort().map(([status, n]) => (
                <span key={status} className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  status === 'confirmed' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                }`}>{n} {status}</span>
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
      </div>
    </div>
  );
}
