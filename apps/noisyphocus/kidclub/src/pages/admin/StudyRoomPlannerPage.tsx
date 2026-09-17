import { useState, useEffect, useMemo } from 'react';
import { getDocs, getDoc, setDoc } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import { WeekPattern } from '@shared/models/weekPattern';
import { normalizeSubStatus } from '../../lib/utils';

const WEEKDAYS = [
  { value: 'monday', label: 'Segunda' },
  { value: 'tuesday', label: 'Terça' },
  { value: 'wednesday', label: 'Quarta' },
  { value: 'thursday', label: 'Quinta' },
  { value: 'friday', label: 'Sexta' },
];

type StudyStatus = 'pending' | 'active' | 'cancelled';
const ACTIVE: StudyStatus[] = ['pending', 'active'];

interface StudyEntry {
  id: string;
  childName: string;
  schoolName?: string;
  schoolYear?: string;
  familyId?: string;
  contactEmail?: string;
  status: StudyStatus;
  days: { day: string; hour: string }[];
  monthlyPrice: number;
  weekPattern: WeekPattern;
}

function getMonthWeekRanges(date: Date): { label: string; weekNum: number; start: Date }[] {
  const year = date.getFullYear(), month = date.getMonth();
  const ranges: { label: string; weekNum: number; start: Date }[] = [];
  let occ = 0;
  const d = new Date(year, month, 1);
  while (d.getMonth() === month) {
    if (d.getDay() === 1) { // Monday
      occ++;
      const end = new Date(d); end.setDate(end.getDate() + 4);
      const fmt = (dt: Date) => dt.toLocaleDateString('pt-PT', { day: 'numeric', month: 'short' });
      ranges.push({ weekNum: occ, label: `${fmt(d)}–${fmt(end)}`, start: new Date(d) });
    }
    d.setDate(d.getDate() + 1);
    if (occ === 4) break;
  }
  return ranges;
}

function currentWeekOfMonth(): number {
  const today = new Date();
  const year = today.getFullYear(), month = today.getMonth();
  let occ = 0;
  const d = new Date(year, month, 1);
  while (d <= today && d.getMonth() === month) {
    if (d.getDay() === 1) occ++;
    d.setDate(d.getDate() + 1);
  }
  return Math.max(1, occ);
}

function isEntryActiveInWeek(entry: StudyEntry, weekNum: number): boolean {
  if (entry.weekPattern === 'all') return true;
  if (entry.weekPattern === 'odd') return weekNum === 1 || weekNum === 3;
  return weekNum === 2 || weekNum === 4;
}

interface SlotEntry {
  hour: string;
  entries: StudyEntry[];
}

const DEFAULT_CONFIG: StudyCenterConfig = {
  monthlyPricePerWeekday: 24,
  registrationFee: 0,
  insuranceFee: 0,
  monthlyTransportFeePerWeekday: 32.5,
  returningStudentDiscountPercentage: 0,
  teacherMonthlyCost: 900,
  rentMonthlyCost: 750,
  pricePerDayPerWeek: 6,
  weeksPerMonth: 4,
};

function entryMonthlyPrice(entry: StudyEntry, cfg: StudyCenterConfig): number {
  const days = entry.days.filter(d => d.day).length;
  if (cfg.pricePerDayPerWeek != null && cfg.weeksPerMonth != null) {
    return days * cfg.pricePerDayPerWeek * cfg.weeksPerMonth;
  }
  return days * cfg.monthlyPricePerWeekday;
}

function eur(n: number) {
  return '€' + Math.abs(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// ─── Field ────────────────────────────────────────────────────────────────────
function Field({ label, value, step, onChange, width = 'w-14' }: {
  label: string; value: number; step: number; onChange: (v: number) => void; width?: string;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-xs text-gray-400 whitespace-nowrap">{label}</span>
      <input
        type="number" value={value} step={step} min={0}
        onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v); }}
        className={`${width} border border-gray-300 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400`}
      />
    </label>
  );
}

// ─── Settings modal ───────────────────────────────────────────────────────────
function StudySettingsModal({
  initial, onClose, onSave, saving,
}: {
  initial: StudyCenterConfig;
  onClose: () => void;
  onSave: (c: StudyCenterConfig) => Promise<void>;
  saving: boolean;
}) {
  const [cfg, setCfg] = useState<StudyCenterConfig>(initial);
  const set = (k: keyof StudyCenterConfig, v: number) => setCfg(prev => ({ ...prev, [k]: v }));

  const sectionTitle = (t: string) => (
    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{t}</p>
  );
  const hint = (t: string) => <p className="text-xs text-gray-400 mt-1">{t}</p>;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto py-6 px-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-bold text-gray-900">⚙ Configuração — Sala de Estudo</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
          {/* Custos operacionais */}
          <div>
            {sectionTitle('Custos operacionais')}
            <div className="space-y-2">
              <Field label="Professora (€/mês)" value={cfg.teacherMonthlyCost ?? 900} step={50} onChange={v => set('teacherMonthlyCost', v)} width="w-24" />
              <Field label="Renda (€/mês)" value={cfg.rentMonthlyCost ?? 750} step={50} onChange={v => set('rentMonthlyCost', v)} width="w-24" />
            </div>
            {hint('Custos fixos mensais imputados à sala de estudo')}
          </div>

          {/* Preços */}
          <div>
            {sectionTitle('Preços — Sala de Estudo')}
            <div className="space-y-2">
              <Field label="€/dia" value={cfg.pricePerDayPerWeek ?? 6} step={0.5} onChange={v => set('pricePerDayPerWeek', v)} width="w-16" />
              <Field label="semanas/mês" value={cfg.weeksPerMonth ?? 4} step={0.01} onChange={v => set('weeksPerMonth', v)} width="w-16" />
            </div>
            {hint(`= €${((cfg.pricePerDayPerWeek ?? 6) * (cfg.weeksPerMonth ?? 4) * 5).toFixed(0)}/mês plano 5 dias`)}
          </div>


          {/* Outras taxas */}
          <div>
            {sectionTitle('Outras taxas')}
            <div className="space-y-2">
              <Field label="Taxa de inscrição (€)" value={cfg.registrationFee} step={5} onChange={v => set('registrationFee', v)} width="w-20" />
              <Field label="Seguro (€/mês)" value={cfg.insuranceFee} step={5} onChange={v => set('insuranceFee', v)} width="w-20" />
              <Field label="Desconto aluno regresso (%)" value={Math.round(cfg.returningStudentDiscountPercentage * 100)} step={1} onChange={v => set('returningStudentDiscountPercentage', v / 100)} width="w-16" />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="text-sm px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
            Cancelar
          </button>
          <button
            onClick={() => onSave(cfg)}
            disabled={saving}
            className="text-sm px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 font-medium"
          >
            {saving ? '…' : '💾 Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function StudyRoomPlannerPage() {
  const [entries, setEntries] = useState<StudyEntry[]>([]);
  const [config, setConfig] = useState<StudyCenterConfig>(DEFAULT_CONFIG);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedSlot, setExpandedSlot] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'active' | 'pending' | 'all'>('all');
  const [capacityPerSlot, setCapacityPerSlot] = useState(15);
  const [editingCapacity, setEditingCapacity] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [selectedWeek, setSelectedWeek] = useState<number | null>(currentWeekOfMonth());
  const weekRanges = useMemo(() => getMonthWeekRanges(new Date()), []);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        const [snap, cfgSnap] = await Promise.all([
          getDocs(col('studyroom')),
          getDoc(docRef('config', 'studyCenter')),
        ]);
        if (cfgSnap.exists()) setConfig({ ...DEFAULT_CONFIG, ...(cfgSnap.data() as StudyCenterConfig) });
        setEntries(snap.docs.map(d => {
          const x = d.data();
          return {
            id: d.id,
            childName: x.childName || x.studentName || '—',
            schoolName: x.schoolName,
            schoolYear: x.schoolYear,
            familyId: x.familyId,
            contactEmail: x.email || x.contactEmail,
            status: normalizeSubStatus(x.status),
            days: (x.days || []).map((d: any) => ({ day: d.day, hour: d.hour })),
            monthlyPrice: x.monthlyPrice ?? 0,
            weekPattern: (x.weekPattern ?? 'all') as WeekPattern,
          };
        }));
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, []);

  const activeEntries = useMemo(() => entries.filter(e => ACTIVE.includes(e.status)), [entries]);

  const filtered = useMemo(() => {
    let pool = statusFilter === 'active' ? entries.filter(e => e.status === 'active')
      : statusFilter === 'pending' ? entries.filter(e => e.status === 'pending')
      : activeEntries;
    if (selectedWeek != null) {
      pool = pool.filter(e => isEntryActiveInWeek(e, selectedWeek));
    }
    return pool;
  }, [entries, activeEntries, statusFilter, selectedWeek]);

  // Financial summary — two scenarios regardless of the grid's status filter
  const confirmedRevenue = useMemo(() =>
    entries.filter(e => e.status === 'active').reduce((sum, e) => sum + entryMonthlyPrice(e, config), 0),
    [entries, config]);
  const forecastRevenue = useMemo(() =>
    activeEntries.reduce((sum, e) => sum + entryMonthlyPrice(e, config), 0),
    [activeEntries, config]);
  const monthlyCost = (config.teacherMonthlyCost ?? 900) + (config.rentMonthlyCost ?? 750);
  const confirmedProfit = confirmedRevenue - monthlyCost;
  const forecastProfit = forecastRevenue - monthlyCost;

  // Build slot map: day → hour → entries
  const slotMap = useMemo(() => {
    const map: Record<string, Record<string, StudyEntry[]>> = {};
    for (const day of WEEKDAYS.map(w => w.value)) map[day] = {};
    for (const entry of filtered) {
      for (const ds of entry.days) {
        if (!map[ds.day] || !ds.hour) continue;
        if (!map[ds.day][ds.hour]) map[ds.day][ds.hour] = [];
        map[ds.day][ds.hour].push(entry);
      }
    }
    return map;
  }, [filtered]);

  const allHours = useMemo(() => {
    const hours = new Set<string>();
    for (const entry of filtered) for (const ds of entry.days) if (ds.hour) hours.add(ds.hour);
    return Array.from(hours).sort();
  }, [filtered]);

  const dayTotals = useMemo(() =>
    Object.fromEntries(WEEKDAYS.map(({ value }) => [
      value,
      new Set(filtered.flatMap(e => e.days.filter(d => d.day === value).map(() => e.id))).size,
    ]))
  , [filtered]);

  const slotKey = (day: string, hour: string) => `${day}_${hour}`;

  const capacityColor = (count: number) => {
    const pct = count / capacityPerSlot;
    if (pct >= 1) return 'bg-red-100 border-red-300 text-red-800';
    if (pct >= 0.8) return 'bg-amber-100 border-amber-300 text-amber-800';
    if (count === 0) return 'bg-gray-50 border-gray-100 text-gray-400';
    return 'bg-green-50 border-green-200 text-green-800';
  };

  async function handleSaveConfig(cfg: StudyCenterConfig) {
    setSettingsSaving(true);
    try {
      // Keep monthlyPricePerWeekday in sync so enrollment forms stay consistent
      const synced: StudyCenterConfig = cfg.pricePerDayPerWeek != null && cfg.weeksPerMonth != null
        ? { ...cfg, monthlyPricePerWeekday: cfg.pricePerDayPerWeek * cfg.weeksPerMonth }
        : cfg;
      await setDoc(docRef('config', 'studyCenter'), synced, { merge: true });
      setConfig(synced);
      setSettingsOpen(false);
    } finally {
      setSettingsSaving(false);
    }
  }

  if (isLoading) return <div className="flex justify-center items-center h-64 text-gray-500">A carregar…</div>;

  const confirmedCount = activeEntries.filter(e => e.status === 'active').length;
  const pendingCount = activeEntries.filter(e => e.status === 'pending').length;

  return (
    <div className="flex flex-col h-full -m-6">
      {/* ── Summary bar ── */}
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="flex items-center gap-5 flex-wrap">
          <div className="flex items-center gap-5 divide-x divide-gray-200">
            {/* Costs */}
            <div>
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide">Custo mensal</div>
              <div className="text-lg font-bold text-red-600">{eur(monthlyCost)}</div>
              <div className="text-xs text-gray-400 space-x-1">
                <span>{eur(config.teacherMonthlyCost ?? 900)} prof.</span>
                <span>·</span>
                <span>{eur(config.rentMonthlyCost ?? 750)} renda</span>
              </div>
            </div>
            {/* Forecast — confirmed + pending */}
            <div className="pl-5">
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide">Estimado</div>
              <div className="text-lg font-bold text-indigo-600">{eur(forecastRevenue)}</div>
              <div className={`text-xs font-semibold ${forecastProfit >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                {forecastProfit >= 0 ? '+' : '−'}{eur(forecastProfit)} lucro · <span className="font-normal text-gray-400">
                  {config.pricePerDayPerWeek != null
                    ? `€${config.pricePerDayPerWeek}/dia × ${config.weeksPerMonth} sem`
                    : `€${config.monthlyPricePerWeekday}/dia`}
                </span>
              </div>
            </div>
            {/* Reality — confirmed only */}
            <div className="pl-5">
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide">Realidade</div>
              <div className="text-lg font-bold text-blue-600">{eur(confirmedRevenue)}</div>
              <div className={`text-xs font-semibold ${confirmedProfit >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                {confirmedProfit >= 0 ? '+' : '−'}{eur(confirmedProfit)} lucro · <span className="font-normal text-gray-400">{confirmedCount} confirm.</span>
              </div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setSettingsOpen(true)}
              className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-600 transition-colors"
            >
              ⚙ Definições
            </button>
          </div>
        </div>
      </div>

      {/* ── Main content ── */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* Header */}
        <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
          <h1 className="text-2xl font-bold">Planeador — Sala de Estudo</h1>
          <div className="flex items-center gap-3 flex-wrap">
            {/* Capacity */}
            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-500">Capacidade/slot:</span>
              {editingCapacity ? (
                <input
                  type="number"
                  value={capacityPerSlot}
                  onChange={e => setCapacityPerSlot(Number(e.target.value))}
                  onBlur={() => setEditingCapacity(false)}
                  autoFocus
                  className="w-16 border border-gray-300 rounded px-2 py-1 text-sm"
                />
              ) : (
                <button onClick={() => setEditingCapacity(true)} className="font-semibold text-gray-800 hover:text-blue-600">
                  {capacityPerSlot} alunos
                </button>
              )}
            </div>
            {/* Week filter */}
            <div className="flex gap-1 rounded-lg border border-gray-200 overflow-hidden text-sm">
              <button onClick={() => setSelectedWeek(null)}
                className={`px-3 py-1.5 font-medium transition-colors ${selectedWeek === null ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                Todas
              </button>
              {weekRanges.map(({ weekNum, label }) => (
                <button key={weekNum} onClick={() => setSelectedWeek(weekNum)}
                  className={`px-3 py-1.5 font-medium transition-colors whitespace-nowrap ${selectedWeek === weekNum ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                  {label}
                </button>
              ))}
            </div>
            {/* Status filter */}
            <div className="flex gap-1 rounded-lg border border-gray-200 overflow-hidden text-sm">
              {([['active', 'Confirmados'], ['pending', 'Pendentes'], ['all', 'Todos']] as const).map(([v, l]) => (
                <button key={v} onClick={() => setStatusFilter(v)}
                  className={`px-3 py-1.5 font-medium transition-colors ${statusFilter === v ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>

        {allHours.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">
            {statusFilter === 'active' ? 'Nenhum aluno confirmado.' : 'Nenhuma inscrição encontrada.'}
          </div>
        ) : (
          <>
            {/* Weekly grid */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
              <div className="grid border-b border-gray-200" style={{ gridTemplateColumns: '80px repeat(5, 1fr)' }}>
                <div className="p-3 text-xs text-gray-400 font-medium" />
                {WEEKDAYS.map(({ value, label }) => (
                  <div key={value} className="p-3 text-center border-l border-gray-100">
                    <p className="text-sm font-semibold text-gray-800">{label}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{dayTotals[value]} alunos</p>
                  </div>
                ))}
              </div>

              {allHours.map(hour => (
                <div key={hour} className="grid border-b border-gray-100 last:border-0" style={{ gridTemplateColumns: '80px repeat(5, 1fr)' }}>
                  <div className="p-3 flex items-center">
                    <span className="text-xs font-semibold text-gray-500">{hour}</span>
                  </div>
                  {WEEKDAYS.map(({ value: day }) => {
                    const slotEntries = slotMap[day]?.[hour] ?? [];
                    const count = slotEntries.length;
                    const key = slotKey(day, hour);
                    const isExpanded = expandedSlot === key;
                    return (
                      <div key={day} className="border-l border-gray-100 p-2">
                        {count > 0 ? (
                          <button
                            onClick={() => setExpandedSlot(isExpanded ? null : key)}
                            className={`w-full rounded-lg border px-2 py-2 text-center transition-colors ${capacityColor(count)} ${isExpanded ? 'ring-2 ring-blue-400' : ''}`}
                          >
                            <p className="text-sm font-bold">{count}</p>
                            <p className="text-[10px] leading-tight opacity-75">{count === 1 ? 'aluno' : 'alunos'}</p>
                            {count >= capacityPerSlot && <p className="text-[10px] font-bold mt-0.5">LOTADO</p>}
                          </button>
                        ) : (
                          <div className="w-full h-12 rounded-lg bg-gray-50 border border-gray-100" />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* Expanded slot detail */}
            {expandedSlot && (() => {
              const [day, hour] = expandedSlot.split('_');
              const dayLabel = WEEKDAYS.find(w => w.value === day)?.label ?? day;
              const slotEntries = slotMap[day]?.[hour] ?? [];
              return (
                <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="font-semibold text-gray-900">{dayLabel} · {hour}</h2>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${capacityColor(slotEntries.length)}`}>
                        {slotEntries.length}/{capacityPerSlot}
                      </span>
                      <button onClick={() => setExpandedSlot(null)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {slotEntries.map(entry => (
                      <div key={entry.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                        <div>
                          <p className="text-sm font-medium text-gray-900">{entry.childName}</p>
                          {(entry.schoolName || entry.schoolYear) && (
                            <p className="text-xs text-gray-500">{[entry.schoolName, entry.schoolYear].filter(Boolean).join(' · ')}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {entry.weekPattern !== 'all' && (
                            <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">
                              {entry.weekPattern === 'odd' ? 'ímp.' : 'par.'}
                            </span>
                          )}
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            entry.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                          }`}>
                            {entry.status === 'active' ? 'Confirmado' : 'Pendente'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Per-day lists */}
            <div className="mt-2">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Lista por dia</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {WEEKDAYS.map(({ value: day, label }) => {
                  const dayEntries = filtered.filter(e => e.days.some(d => d.day === day));
                  if (dayEntries.length === 0) return null;
                  const slots: SlotEntry[] = Object.entries(slotMap[day] ?? {})
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([hour, entries]) => ({ hour, entries }));
                  return (
                    <div key={day} className="bg-white rounded-xl border border-gray-200 p-4">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="font-semibold text-gray-800">{label}</h3>
                        <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{dayEntries.length} alunos</span>
                      </div>
                      <div className="space-y-3">
                        {slots.map(({ hour, entries: slotEs }) => (
                          <div key={hour}>
                            <p className="text-xs font-medium text-gray-400 mb-1">{hour}</p>
                            <div className="space-y-1">
                              {slotEs.map(e => (
                                <div key={e.id} className="flex items-center justify-between text-sm">
                                  <span className="text-gray-800">{e.childName}</span>
                                  <div className="flex gap-1 items-center">
                                    {e.weekPattern !== 'all' && (
                                      <span className="text-xs text-purple-600 font-medium">{e.weekPattern === 'odd' ? 'ímp.' : 'par.'}</span>
                                    )}
                                    {e.status === 'pending' && (
                                      <span className="text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">pend.</span>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Settings modal ── */}
      {settingsOpen && (
        <StudySettingsModal
          initial={config}
          onClose={() => setSettingsOpen(false)}
          onSave={handleSaveConfig}
          saving={settingsSaving}
        />
      )}
    </div>
  );
}
