import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { getDocs, getDoc, deleteDoc, updateDoc } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';
import { solveRoutes, SolverKid, DEPOT_ADDRESS as SOLVER_DEPOT } from '../../lib/routeSolver';
import { TransportationConfig, SchoolDiscount } from '@shared/models/Transportation';
import { saveTransportationConfig, getActiveTransportationSubscriptions } from '../../services/transportationService';
import PlacesInput from '../../components/PlacesInput';

// ─── Types ────────────────────────────────────────────────────────────────────
type Day = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri';
type Period = 'morning' | 'lunch' | 'afternoon';

const DAYS: Day[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const DAY_PT: Record<Day, string> = { Mon: 'Segunda', Tue: 'Terça', Wed: 'Quarta', Thu: 'Quinta', Fri: 'Sexta' };
const DAY_SHORT: Record<Day, string> = { Mon: 'Seg', Tue: 'Ter', Wed: 'Qua', Thu: 'Qui', Fri: 'Sex' };
const DAY_NORM: Record<string, Day> = {
  monday: 'Mon', segunda: 'Mon',
  tuesday: 'Tue', 'terça': 'Tue', terca: 'Tue',
  wednesday: 'Wed', quarta: 'Wed',
  thursday: 'Thu', quinta: 'Thu',
  friday: 'Fri', sexta: 'Fri',
};
const PERIODS: { id: Period; label: string; emoji: string }[] = [
  { id: 'morning', label: 'Manhã', emoji: '🌅' },
  { id: 'lunch', label: 'Almoço', emoji: '🍽' },
  { id: 'afternoon', label: 'Tarde', emoji: '🌆' },
];
const PERIOD_EMOJI: Record<Period, string> = { morning: '🌅', lunch: '🍽', afternoon: '🌆' };

interface ScheduleSlot { day: Day; time: string; pickup: string; dropoff: string }
interface PlannerKid {
  id: string;
  source: 'db' | 'manual';
  name: string;
  familyId?: string;
  schoolName?: string;
  monthlyFee: number;
  requestedSchedule: ScheduleSlot[];
  notes?: string;
  status?: 'pending' | 'active';
  contactEmail?: string;
}
interface AutoStop { kidId: string; kidName: string; pickupAddr: string; dropoffAddr: string; requestedTime: number }
interface AutoRun {
  id: string; day: Day;
  direction: 'morning' | 'lunch' | 'afternoon';
  targetArrival: number;
  anchor: string;
  stops: AutoStop[];
}
interface RouteWaypoint { kidIds: string[]; kidNames: string[]; address: string; type: 'pickup' | 'dropoff'; eta: string }
interface OptimizedRoute {
  waypoints: RouteWaypoint[];
  driverStartTime: string;
  driverStartAddress: string;
  totalDurationMin: number;
  totalDistanceKm: number;
  unassigned: Array<{ name: string; reason: string }>;
}
interface AddressOverride { pickup?: string; dropoff?: string }
interface DriverOverride {
  departureOffsetMin: number;
  waypointOrder?: number[];
  // Extra dwell time (min) added after each waypoint (by display position), pushing subsequent ETAs forward.
  waypointExtraMin?: number[];
}
interface SavedPlan {
  manualKids: PlannerKid[];
  cellRoutes?: Record<string, OptimizedRoute | null>;
  runRemovals?: Record<string, string[]>;
  runAddressOverrides?: Record<string, Record<string, AddressOverride>>;
  driverOverrides?: Record<string, DriverOverride>;
  driverHourOverrides?: Record<string, number>;
  locked?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const HOURS_PER_RUN = 2;
const DEFAULT_CONFIG: TransportationConfig = {
  flatRatePerTrip: 0, pricePerTrip: 0, vatRate: 0.23,
  multiTripDiscountPercentage: 0, minTripsForDiscount: 2,
  siblingDiscountPercentage: 0, schoolDiscounts: [],
  driverRatePerHour: 7, vanCapacity: 8, weeksPerMonth: 4.33,
  vanMonthlyCost: 200, consumptionPer100km: 20, electricityPricePerKwh: 0.22,
};
const LS_KEY = 'transport_planner_v10';
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string;
const MORNING_DEADLINE_MIN = 8 * 60 + 50;
const LUNCH_CUTOFF_MIN = 15 * 60;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizeDay(d: string): Day | null {
  return DAY_NORM[d?.toLowerCase?.() ?? ''] ?? null;
}
function parseMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function slotPeriod(time: string): Period {
  const m = parseMinutes(time || '08:00');
  return m < 12 * 60 ? 'morning' : m < LUNCH_CUTOFF_MIN ? 'lunch' : 'afternoon';
}
function parseSchedule(raw: any[]): ScheduleSlot[] {
  return (raw || []).flatMap(s => {
    const day = normalizeDay(s.dayOfWeek ?? s.day ?? '');
    if (!day) return [];
    return [{
      day, time: s.pickupTime ?? '',
      pickup: typeof s.pickupLocation === 'string' ? s.pickupLocation : (s.pickupLocation?.address ?? ''),
      dropoff: typeof s.dropoffLocation === 'string' ? s.dropoffLocation : (s.dropoffLocation?.address ?? ''),
    }];
  });
}
function loadFromStorage(): SavedPlan {
  try { const r = localStorage.getItem(LS_KEY); if (r) return JSON.parse(r); } catch { /* ignore */ }
  return { manualKids: [] };
}
function saveToStorage(p: SavedPlan) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
function eur(n: number) {
  return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
}
function fmtHours(h: number): string {
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  if (hh === 0) return `${mm}min`;
  if (mm === 0) return `${hh}h`;
  return `${hh}h ${mm}min`;
}
function shiftTime(hhmm: string, offsetMin: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = ((h * 60 + m + offsetMin) % 1440 + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function formatTimeSec(seconds: number): string {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m < 0 ? 0 : m).padStart(2, '0')}`;
}
function normalizeAnchor(addr: string): string {
  return addr.split(',')[0].trim().toLowerCase();
}
function buildSchoolRuns(bySchool: Map<string, AutoStop[]>, direction: 'lunch' | 'afternoon', day: Day, prefix: string): AutoRun[] {
  const runs: AutoRun[] = [];
  let idx = 0;
  for (const [, entries] of bySchool) {
    const seen = new Set<string>();
    const stops = entries.filter(e => { if (seen.has(e.kidId)) return false; seen.add(e.kidId); return true; });
    if (!stops.length) continue;
    runs.push({
      id: `auto-${day}-${prefix}${idx++}`,
      day, direction,
      targetArrival: Math.min(...stops.map(e => e.requestedTime)),
      anchor: entries[0].pickupAddr,
      stops,
    });
  }
  return runs;
}
function computeAutoRuns(kids: PlannerKid[], day: Day): AutoRun[] {
  const morning: AutoStop[] = [];
  const byLunchSchool = new Map<string, AutoStop[]>();
  const byAfternoonSchool = new Map<string, AutoStop[]>();
  for (const kid of kids) {
    for (const slot of kid.requestedSchedule) {
      if (slot.day !== day) continue;
      const t = parseMinutes(slot.time || '08:00');
      if (t < 12 * 60) {
        if (slot.pickup.trim())
          morning.push({ kidId: kid.id, kidName: kid.name, pickupAddr: slot.pickup, dropoffAddr: slot.dropoff, requestedTime: t });
      } else {
        const bySchool = t < LUNCH_CUTOFF_MIN ? byLunchSchool : byAfternoonSchool;
        const school = normalizeAnchor(slot.pickup);
        if (!bySchool.has(school)) bySchool.set(school, []);
        if (slot.dropoff.trim())
          bySchool.get(school)!.push({ kidId: kid.id, kidName: kid.name, pickupAddr: slot.pickup, dropoffAddr: slot.dropoff, requestedTime: t });
      }
    }
  }
  const runs: AutoRun[] = [];
  if (morning.length > 0) {
    const seen = new Set<string>();
    const stops = morning.filter(e => { if (seen.has(e.kidId)) return false; seen.add(e.kidId); return true; });
    runs.push({ id: `auto-${day}-m0`, day, direction: 'morning', targetArrival: MORNING_DEADLINE_MIN, anchor: '', stops });
  }
  runs.push(...buildSchoolRuns(byLunchSchool, 'lunch', day, 'l'));
  runs.push(...buildSchoolRuns(byAfternoonSchool, 'afternoon', day, 'a'));
  return runs.sort((a, b) => a.targetArrival - b.targetArrival);
}
async function optimizeAutoRun(run: AutoRun, vanCapacity: number): Promise<OptimizedRoute | null> {
  if (!MAPS_KEY || !run.stops.length) return null;
  const isMorning = run.direction === 'morning';
  const kids: SolverKid[] = run.stops.filter(s => s.pickupAddr.trim()).map(s => ({
    kidId: s.kidId, kidName: s.kidName,
    pickupAddress: s.pickupAddr,
    dropoffAddress: s.dropoffAddr.trim() ? s.dropoffAddr : SOLVER_DEPOT,
    // Morning: must arrive at school by the deadline, max 60 min in van.
    // Afternoon/lunch: going home — no arrival deadline, no ride-time cap.
    deadlineMin: isMorning ? MORNING_DEADLINE_MIN : 23 * 60,
    maxRideMin: isMorning ? 60 : 180,
  }));
  if (!kids.length) return null;
  const result = await solveRoutes(kids, vanCapacity, MAPS_KEY, isMorning ? 'morning' : 'afternoon', isMorning ? undefined : run.targetArrival);
  const rawWaypoints: RouteWaypoint[] = result.stops.filter(s => s.type !== 'depot').map(s => ({
    kidIds: [s.kidId], kidNames: [s.kidName],
    address: s.address, type: s.type as 'pickup' | 'dropoff',
    eta: formatTimeSec(s.arrivalMin * 60),
  }));
  const merged: RouteWaypoint[] = [];
  for (const wp of rawWaypoints) {
    const last = merged[merged.length - 1];
    if (last && last.address === wp.address && last.type === wp.type) {
      last.kidIds.push(...wp.kidIds); last.kidNames.push(...wp.kidNames);
    } else merged.push({ ...wp });
  }
  const depotDepartMin = result.driverDepartMin - result.depotToStartMin;
  return {
    waypoints: merged,
    driverStartTime: formatTimeSec(depotDepartMin * 60),
    driverStartAddress: SOLVER_DEPOT,
    totalDurationMin: result.totalTimeMin + result.depotToStartMin,
    totalDistanceKm: Math.round((result.totalDistanceKm + result.depotToStartKm) * 10) / 10,
    unassigned: result.unassigned.map(u => ({
      name: u.kidName,
      reason: u.reason === 'capacity' ? 'capacidade' : u.reason === 'rideTime' ? 'tempo viagem' : u.reason === 'tooEarly' ? 'cedo demais' : 'desconhecido',
    })),
  };
}

// ─── Field & SettingsPanel ────────────────────────────────────────────────────
function Field({ label, value, step, onChange, width = 'w-14' }: { label: string; value: number; step: number; onChange: (v: number) => void; width?: string }) {
  return (
    <label className="flex items-center gap-1">
      <span className="text-xs text-gray-400 whitespace-nowrap">{label}</span>
      <input type="number" value={value} step={step} min={0} onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v); }}
        className={`${width} border border-gray-300 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400`} />
    </label>
  );
}
function SettingsModal({
  initial, allKids, onClose, onSave, onApply, saving, applying, applyResult,
}: {
  initial: TransportationConfig;
  allKids: PlannerKid[];
  onClose: () => void;
  onSave: (c: TransportationConfig) => Promise<void>;
  onApply: (c: TransportationConfig) => Promise<void>;
  saving: boolean;
  applying: boolean;
  applyResult: string | null;
}) {
  const [cfg, setCfg] = useState<TransportationConfig>(initial);
  const [previewOpen, setPreviewOpen] = useState(false);
  const set = (k: keyof TransportationConfig, v: any) => setCfg(prev => ({ ...prev, [k]: v }));
  const pct = (fraction: number) => Math.round(fraction * 100);
  const frac = (pct: number) => pct / 100;


  // Compute per-family price preview from current cfg + allKids
  const familyPreview = useMemo(() => {
    if (!previewOpen || allKids.length === 0) return [];
    const periodOrder: Record<Period, number> = { morning: 0, lunch: 1, afternoon: 2 };

    // Group and rank siblings
    const famGroups: Record<string, PlannerKid[]> = {};
    allKids.forEach(k => { const key = k.familyId ?? k.contactEmail; if (key) (famGroups[key] ??= []).push(k); });
    Object.values(famGroups).forEach(g => g.sort((a, b) => a.name.localeCompare(b.name)));
    const sibRank: Record<string, number> = {};
    Object.values(famGroups).forEach(group => group.forEach((k, i) => { sibRank[k.id] = i + 1; }));

    type KidRow = { kidId: string; name: string; schoolName?: string; siblingRank: number; slotsPerWeek: number; discounts: string[]; monthlyFee: number };
    type FamilyRow = { key: string; label: string; kids: KidRow[]; total: number };

    return Object.entries(famGroups).map(([key, kids]) => {
      const kidRows: KidRow[] = kids.map(kid => {
        const rank = sibRank[kid.id] ?? 1;
        const slotsByDay: Record<string, ScheduleSlot[]> = {};
        for (const slot of kid.requestedSchedule) (slotsByDay[slot.day] ??= []).push(slot);
        Object.values(slotsByDay).forEach(g => g.sort((a, b) => periodOrder[slotPeriod(a.time)] - periodOrder[slotPeriod(b.time)]));

        let fee = 0;
        const appliedDiscounts = new Set<string>();
        for (const [, slots] of Object.entries(slotsByDay)) {
          slots.forEach((slot, idx) => {
            const tripRank = idx + 1;
            let discount = 0;
            if (rank >= 2) { discount += cfg.siblingDiscountPercentage; if (cfg.siblingDiscountPercentage > 0) appliedDiscounts.add(`irmãos -${pct(cfg.siblingDiscountPercentage)}%`); }
            for (const sd of (cfg.schoolDiscounts ?? [])) {
              if (kid.schoolName && sd.schoolName && sd.schoolName.toLowerCase() === kid.schoolName.toLowerCase()) {
                discount += sd.discountPercentage;
                if (sd.discountPercentage > 0) appliedDiscounts.add(`escola -${pct(sd.discountPercentage)}%`);
              }
            }
            if (tripRank >= cfg.minTripsForDiscount) { discount += cfg.multiTripDiscountPercentage; if (cfg.multiTripDiscountPercentage > 0) appliedDiscounts.add(`2.ª viagem -${pct(cfg.multiTripDiscountPercentage)}%`); }
            discount = Math.min(1, discount);
            fee += cfg.flatRatePerTrip * (1 - discount) * cfg.weeksPerMonth;
          });
        }
        const slotsPerWeek = kid.requestedSchedule.length;
        return { kidId: kid.id, name: kid.name, schoolName: kid.schoolName, siblingRank: rank, slotsPerWeek, discounts: [...appliedDiscounts], monthlyFee: fee };
      });
      const total = kidRows.reduce((s, r) => s + r.monthlyFee, 0);
      const label = key.includes('@') ? key : kids[0]?.name ?? key;
      return { key, label, kids: kidRows, total } as FamilyRow;
    }).sort((a, b) => b.total - a.total);
  }, [previewOpen, cfg, allKids]);

  const schoolDiscounts = cfg.schoolDiscounts ?? [];
  const addSchool = () => setCfg(prev => ({ ...prev, schoolDiscounts: [...(prev.schoolDiscounts ?? []), { schoolName: '', discountPercentage: 0 }] }));
  const updSchool = (i: number, v: Partial<SchoolDiscount>) =>
    setCfg(prev => ({ ...prev, schoolDiscounts: (prev.schoolDiscounts ?? []).map((d, j) => j === i ? { ...d, ...v } : d) }));
  const delSchool = (i: number) =>
    setCfg(prev => ({ ...prev, schoolDiscounts: (prev.schoolDiscounts ?? []).filter((_, j) => j !== i) }));

  const sectionTitle = (t: string) => (
    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{t}</p>
  );
  const hint = (t: string) => <p className="text-xs text-gray-400 mt-1">{t}</p>;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto py-6 px-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-bold text-gray-900">⚙ Configuração de Transporte</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">

            {/* Preços */}
            <div>
              {sectionTitle('Preços')}
              <div className="space-y-2">
                <Field label="€/viagem" value={cfg.flatRatePerTrip} step={0.5} onChange={v => set('flatRatePerTrip', v)} width="w-20" />
                <Field label="IVA (%)" value={pct(cfg.vatRate)} step={1} onChange={v => set('vatRate', frac(v))} width="w-16" />
              </div>
              {hint('Preço base por viagem, antes de descontos')}
            </div>

            {/* Motorista */}
            <div>
              {sectionTitle('Motorista')}
              <div className="space-y-2">
                <Field label="€/hora" value={cfg.driverRatePerHour} step={0.5} onChange={v => set('driverRatePerHour', v)} width="w-16" />
                <Field label="semanas/mês" value={cfg.weeksPerMonth} step={0.01} onChange={v => set('weeksPerMonth', v)} width="w-16" />
              </div>
              {hint('Custo mensal = horas × tarifa × semanas')}
            </div>

            {/* Carrinha */}
            <div>
              {sectionTitle('Carrinha')}
              <div className="space-y-2">
                <Field label="lugares" value={cfg.vanCapacity} step={1} onChange={v => set('vanCapacity', v)} width="w-14" />
                <Field label="€/mês fixo" value={cfg.vanMonthlyCost} step={10} onChange={v => set('vanMonthlyCost', v)} width="w-20" />
              </div>
              {hint('"Lugares" afecta o algoritmo de rotas · custo fixo mensal (seguro, leasing…)')}
            </div>

            {/* Energia */}
            <div>
              {sectionTitle('Energia')}
              <div className="space-y-2">
                <Field label="kWh/100km" value={cfg.consumptionPer100km} step={0.5} onChange={v => set('consumptionPer100km', v)} width="w-16" />
                <Field label="€/kWh" value={cfg.electricityPricePerKwh} step={0.01} onChange={v => set('electricityPricePerKwh', v)} width="w-16" />
              </div>
              {hint('Custo calculado com base nos km reais das rotas optimizadas')}
            </div>
          </div>

          {/* Descontos */}
          <div className="border-t border-gray-100 pt-5 space-y-4">
            <div className="flex items-center justify-between">
              {sectionTitle('Descontos')}
              <button
                onClick={() => setPreviewOpen(v => !v)}
                className={`text-xs font-medium transition-colors ${previewOpen ? 'text-indigo-600' : 'text-gray-400 hover:text-indigo-500'}`}
              >
                {previewOpen ? '▲ Fechar preview' : '▼ Preview por família'}
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Multi-viagem */}
              <div className="bg-gray-50 rounded-lg p-3 space-y-2">
                <p className="text-xs font-medium text-gray-700">Viagem extra (mesmo dia)</p>
                <div className="flex items-center gap-3 flex-wrap">
                  <Field label="a partir da viagem n.º" value={cfg.minTripsForDiscount} step={1} onChange={v => set('minTripsForDiscount', v)} width="w-10" />
                  <Field label="desconto (%)" value={pct(cfg.multiTripDiscountPercentage)} step={1} onChange={v => set('multiTripDiscountPercentage', frac(v))} width="w-14" />
                </div>
                {hint('Ex: a partir da 2.ª viagem no dia, 30% de desconto')}
              </div>

              {/* Irmãos */}
              <div className="bg-gray-50 rounded-lg p-3 space-y-2">
                <p className="text-xs font-medium text-gray-700">Irmãos (2.º filho+)</p>
                <Field label="desconto (%)" value={pct(cfg.siblingDiscountPercentage)} step={1} onChange={v => set('siblingDiscountPercentage', frac(v))} width="w-14" />
                {hint('Aplica-se ao 2.º e 3.º filho da mesma família (por email ou familyId)')}
              </div>
            </div>

            {/* Por escola */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-gray-700">Por escola</p>
                <button onClick={addSchool} className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">+ Adicionar escola</button>
              </div>
              {schoolDiscounts.length === 0 && (
                <p className="text-xs text-gray-400">Nenhuma escola configurada.</p>
              )}
              <div className="space-y-2">
                {schoolDiscounts.map((sd, i) => (
                  <div key={i} className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                    <PlacesInput
                      placeholder="Nome da escola"
                      value={sd.schoolName}
                      onChange={v => updSchool(i, { schoolName: v })}
                      types={['school', 'primary_school', 'secondary_school']}
                      nameOnly
                      className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-xs text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                    <Field label="%" value={pct(sd.discountPercentage)} step={1} onChange={v => updSchool(i, { discountPercentage: frac(v) })} width="w-12" />
                    <button onClick={() => delSchool(i)} className="text-gray-400 hover:text-red-500 text-sm shrink-0">×</button>
                  </div>
                ))}
              </div>
              {hint('Correspondência exacta (sem maiúsculas/minúsculas) com o campo "Escola" da inscrição')}
            </div>

            {/* Family price preview */}
            {previewOpen && (
              <div className="border-t border-gray-100 pt-4 space-y-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Preview de preços {cfg.flatRatePerTrip > 0 ? `· €${cfg.flatRatePerTrip}/viagem × ${cfg.weeksPerMonth} sem` : '(configure o preço por viagem)'}
                </p>
                {familyPreview.length === 0 && (
                  <p className="text-xs text-gray-400">Sem alunos carregados.</p>
                )}
                <div className="space-y-2">
                  {familyPreview.map(fam => (
                    <div key={fam.key} className="bg-gray-50 rounded-lg px-3 py-2.5">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-gray-700 truncate">{fam.label}</span>
                        <span className="text-sm font-bold text-indigo-700 shrink-0 ml-2">€{fam.total.toFixed(2)}/mês</span>
                      </div>
                      <div className="space-y-1">
                        {fam.kids.map(kid => (
                          <div key={kid.kidId} className="text-xs text-gray-500 space-y-0.5">
                            <div className="flex items-center gap-2">
                              <span className="truncate flex-1 font-medium text-gray-700">{kid.name}</span>
                              <span className="text-gray-400">{kid.slotsPerWeek} viagem{kid.slotsPerWeek !== 1 ? 's' : ''}/sem</span>
                              {kid.discounts.map(d => (
                                <span key={d} className="bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded shrink-0">{d}</span>
                              ))}
                              <span className="font-semibold text-gray-700 tabular-nums shrink-0">€{kid.monthlyFee.toFixed(2)}</span>
                            </div>
                            <div className="pl-0.5">
                              {kid.schoolName
                                ? <span className="text-gray-400">🏫 {kid.schoolName}</span>
                                : <span className="text-amber-500">⚠ sem escola — editar na inscrição</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                {familyPreview.length > 0 && (
                  <p className="text-xs text-gray-400 pt-1">
                    Total previsto: <strong className="text-gray-600">€{familyPreview.reduce((s, f) => s + f.total, 0).toFixed(2)}/mês</strong>
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <button
              onClick={() => onApply(cfg)}
              disabled={applying || saving}
              className="text-sm px-4 py-2 rounded-lg border border-orange-300 text-orange-700 bg-orange-50 hover:bg-orange-100 disabled:opacity-50 transition font-medium"
            >
              {applying ? 'A aplicar…' : '↻ Aplicar a todas as inscrições'}
            </button>
            {applyResult && <p className="text-xs text-gray-500">{applyResult}</p>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-sm px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition">
              Cancelar
            </button>
            <button
              onClick={() => onSave(cfg)}
              disabled={saving || applying}
              className="text-sm px-5 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 transition"
            >
              {saving ? 'A guardar…' : '💾 Guardar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── KidCard ──────────────────────────────────────────────────────────────────
function KidCard({ kid, assignedSlots = new Set<string>() }: { kid: PlannerKid; assignedSlots?: Set<string> }) {
  const statusColor = kid.source === 'manual' ? 'bg-purple-100 text-purple-800'
    : kid.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800';
  const statusLabel = kid.source === 'manual' ? 'Email' : kid.status === 'active' ? 'Ativa' : 'Pendente';

  // Group schedule slots by period
  const periodGroups = useMemo(() => {
    const groups: Partial<Record<Period, Day[]>> = {};
    for (const s of kid.requestedSchedule) {
      const p = slotPeriod(s.time);
      if (!groups[p]) groups[p] = [];
      if (!groups[p]!.includes(s.day)) groups[p]!.push(s.day);
    }
    return groups;
  }, [kid.requestedSchedule]);

  const totalSlots = Object.values(periodGroups).reduce((n, days) => n + (days?.length ?? 0), 0);
  const assignedCount = Object.entries(periodGroups).reduce((n, [p, days]) =>
    n + (days ?? []).filter(d => assignedSlots.has(`${d}-${p}`)).length, 0);

  return (
    <div className="bg-white border rounded-lg p-3 hover:shadow-md hover:border-blue-200 transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-semibold text-gray-800 text-sm leading-tight">{kid.name}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0 ${statusColor}`}>{statusLabel}</span>
          </div>
          {kid.monthlyFee > 0 && <div className="text-xs font-semibold text-blue-600 mt-0.5">€{kid.monthlyFee.toFixed(0)}/mês</div>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {totalSlots > 0 && (
            <span className={`text-xs font-semibold ${assignedCount === totalSlots ? 'text-green-600' : assignedCount > 0 ? 'text-amber-500' : 'text-gray-300'}`}>
              {assignedCount}/{totalSlots}
            </span>
          )}
          <Link to={`/admin/subscriptions?highlight=${kid.id}`} onClick={e => e.stopPropagation()} className="text-gray-300 hover:text-blue-500 text-xs transition-colors" title="Ver inscrição">↗</Link>
        </div>
      </div>

      {Object.keys(periodGroups).length > 0 && (
        <div className="mt-2 space-y-0.5">
          {(Object.entries(periodGroups) as [Period, Day[]][]).map(([p, days]) => (
            <div key={p} className="flex items-center gap-1 flex-wrap">
              <span className="text-xs">{PERIOD_EMOJI[p]}</span>
              {days.map(d => {
                const assigned = assignedSlots.has(`${d}-${p}`);
                return (
                  <span key={d} className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                    assigned ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'
                  }`}>
                    {DAY_SHORT[d]}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {kid.notes && <p className="text-xs text-gray-400 mt-1.5 italic truncate">{kid.notes}</p>}
    </div>
  );
}

// ─── EditRunModal ─────────────────────────────────────────────────────────────
function EditRunModal({ run, removals, addressOverrides, onSave, onClose }: {
  run: AutoRun;
  removals: string[];
  addressOverrides: Record<string, AddressOverride>;
  onSave: (removals: string[], overrides: Record<string, AddressOverride>) => void;
  onClose: () => void;
}) {
  const [localRemovals, setLocalRemovals] = useState<string[]>([...removals]);
  const [localOverrides, setLocalOverrides] = useState<Record<string, AddressOverride>>({ ...addressOverrides });

  const visibleStops = run.stops.filter(s => !localRemovals.includes(s.kidId));
  const dirLabel = run.direction === 'morning' ? '🌅 Manhã' : run.direction === 'lunch' ? '🍽 Almoço' : '🌆 Tarde';

  function updateOverride(kidId: string, field: 'pickup' | 'dropoff', value: string) {
    setLocalOverrides(prev => ({ ...prev, [kidId]: { ...prev[kidId], [field]: value } }));
  }

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-[500px] max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-gray-800">{dirLabel} — {DAY_PT[run.day]}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {visibleStops.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-4">Sem alunos neste percurso.</p>
          )}
          {visibleStops.map(stop => (
            <div key={stop.kidId} className="border border-gray-200 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-sm text-gray-800">{stop.kidName}</span>
                <button onClick={() => setLocalRemovals(prev => [...prev, stop.kidId])} className="text-xs text-red-400 hover:text-red-600">
                  × Remover
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-500 mb-0.5 block">Embarque</label>
                  <input type="text" value={localOverrides[stop.kidId]?.pickup ?? stop.pickupAddr}
                    onChange={e => updateOverride(stop.kidId, 'pickup', e.target.value)}
                    className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-0.5 block">Destino</label>
                  <input type="text" value={localOverrides[stop.kidId]?.dropoff ?? stop.dropoffAddr}
                    onChange={e => updateOverride(stop.kidId, 'dropoff', e.target.value)}
                    className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400" />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex gap-2">
          <button onClick={() => onSave(localRemovals, localOverrides)}
            className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 font-medium flex-1">
            Guardar e recalcular
          </button>
          <button onClick={onClose} className="text-sm px-4 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-600">
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── DriverOverrideModal ──────────────────────────────────────────────────────
function DriverOverrideModal({ run, route, override, onSave, onClose }: {
  run: AutoRun;
  route: OptimizedRoute;
  override: DriverOverride;
  onSave: (o: DriverOverride) => void;
  onClose: () => void;
}) {
  const [offset, setOffset] = useState(override.departureOffsetMin);
  const [order, setOrder] = useState<number[]>(
    override.waypointOrder ?? route.waypoints.map((_, i) => i)
  );
  const [extraMin, setExtraMin] = useState<number[]>(
    override.waypointExtraMin ?? route.waypoints.map(() => 0)
  );

  const dirLabel = run.direction === 'morning' ? '🌅 Manhã' : run.direction === 'lunch' ? '🍽 Almoço' : '🌆 Tarde';
  const isDefaultOrder = order.every((v, i) => v === i);

  function moveUp(i: number) {
    if (i === 0) return;
    setOrder(prev => { const a = [...prev]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; return a; });
    setExtraMin(prev => { const a = [...prev]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; return a; });
  }
  function moveDown(i: number) {
    if (i === order.length - 1) return;
    setOrder(prev => { const a = [...prev]; [a[i], a[i + 1]] = [a[i + 1], a[i]]; return a; });
    setExtraMin(prev => { const a = [...prev]; [a[i], a[i + 1]] = [a[i + 1], a[i]]; return a; });
  }
  function adjustExtra(i: number, delta: number) {
    setExtraMin(prev => { const a = [...prev]; a[i] = Math.max(0, (a[i] ?? 0) + delta); return a; });
  }

  // Compute display ETAs with departure offset and cumulative per-waypoint extra time
  const displayEtas = (() => {
    let cum = offset;
    return order.map((wpIdx, i) => {
      const eta = shiftTime(route.waypoints[wpIdx].eta, cum);
      cum += extraMin[i] ?? 0;
      return eta;
    });
  })();

  const hasExtra = extraMin.some(v => v > 0);

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-[440px] max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-gray-800">🚗 Motorista — {dirLabel}, {DAY_PT[run.day]}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Departure offset */}
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Ajuste de partida</p>
            <div className="flex items-center gap-2">
              <button onClick={() => setOffset(v => v - 5)} className="w-8 h-8 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 font-mono">−</button>
              <span className="w-20 text-center font-mono text-sm font-semibold">
                {offset > 0 ? `+${offset}` : offset} min
              </span>
              <button onClick={() => setOffset(v => v + 5)} className="w-8 h-8 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 font-mono">+</button>
              {offset !== 0 && (
                <button onClick={() => setOffset(0)} className="text-xs text-gray-400 hover:text-gray-600 ml-1">reset</button>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-1.5">
              Partida: <span className="font-mono font-semibold">{shiftTime(route.driverStartTime, offset)}</span>
              {offset !== 0 && <span className="ml-1">(original {route.driverStartTime})</span>}
            </p>
          </div>

          {/* Stop reorder + per-waypoint buffer */}
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Paragens e folgas</p>
            <p className="text-xs text-gray-400 mb-3">Reordene as paragens e adicione tempo extra entre elas.</p>
            <div className="space-y-0">
              {order.map((wpIdx, i) => {
                const wp = route.waypoints[wpIdx];
                const extra = extraMin[i] ?? 0;
                return (
                  <div key={i}>
                    {/* Waypoint row */}
                    <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
                      <span className={`font-mono text-xs font-semibold shrink-0 ${wp.type === 'pickup' ? 'text-blue-600' : 'text-orange-600'}`}>
                        {(!isDefaultOrder || hasExtra) ? '~' : ''}{displayEtas[i]}
                      </span>
                      <span className={`text-xs shrink-0 ${wp.type === 'pickup' ? 'text-blue-400' : 'text-orange-400'}`}>
                        {wp.type === 'pickup' ? '↑' : '↓'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-gray-700 truncate">{wp.kidNames.map(n => n.split(' ')[0]).join(', ')}</div>
                        <div className="text-xs text-gray-400 truncate">{wp.address.split(',').slice(0, 2).join(',')}</div>
                      </div>
                      <div className="flex gap-0.5 shrink-0">
                        <button onClick={() => moveUp(i)} disabled={i === 0}
                          className="px-1 text-gray-300 hover:text-gray-600 disabled:opacity-20 text-sm">↑</button>
                        <button onClick={() => moveDown(i)} disabled={i === order.length - 1}
                          className="px-1 text-gray-300 hover:text-gray-600 disabled:opacity-20 text-sm">↓</button>
                      </div>
                    </div>
                    {/* Buffer between this stop and the next */}
                    {i < order.length - 1 && (
                      <div className="flex items-center gap-2 px-3 py-1">
                        <div className="flex-1 border-l-2 border-dashed border-gray-200 ml-2" style={{ height: 1 }} />
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => adjustExtra(i, -5)} disabled={extra === 0}
                            className="w-5 h-5 text-xs rounded border border-gray-200 text-gray-400 hover:text-gray-600 disabled:opacity-20 leading-none">−</button>
                          <span className={`text-xs font-mono w-12 text-center ${extra > 0 ? 'text-amber-600 font-semibold' : 'text-gray-300'}`}>
                            {extra > 0 ? `+${extra}min` : '—'}
                          </span>
                          <button onClick={() => adjustExtra(i, 5)}
                            className="w-5 h-5 text-xs rounded border border-gray-200 text-gray-400 hover:text-gray-600 leading-none">+</button>
                        </div>
                        <div className="flex-1 border-l-2 border-dashed border-gray-200 ml-2" style={{ height: 1 }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {!isDefaultOrder && (
              <button onClick={() => { setOrder(route.waypoints.map((_, i) => i)); setExtraMin(route.waypoints.map(() => 0)); }}
                className="text-xs text-gray-400 hover:text-gray-600 mt-2">
                Repor tudo
              </button>
            )}
            {(!isDefaultOrder || hasExtra) && (
              <p className="text-xs text-amber-500 mt-1">Os horários (~) são aproximados após ajustes.</p>
            )}
          </div>
        </div>

        <div className="px-5 py-4 border-t border-gray-100 flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancelar</button>
          <button
            onClick={() => onSave({
              departureOffsetMin: offset,
              waypointOrder: isDefaultOrder ? undefined : order,
              waypointExtraMin: hasExtra ? extraMin : undefined,
            })}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── RouteCell ────────────────────────────────────────────────────────────────
function RouteCell({ run, route, loading, onOptimize, onEdit, onDriverEdit, hasOverrides, driverOverride, locked }: {
  run: AutoRun;
  route?: OptimizedRoute | null;
  loading?: boolean;
  onOptimize: () => void;
  onEdit: () => void;
  onDriverEdit: () => void;
  hasOverrides?: boolean;
  driverOverride?: DriverOverride;
  locked?: boolean;
}) {
  const [showAddresses, setShowAddresses] = useState(false);
  const isMorning = run.direction === 'morning';
  const anchorShort = run.anchor.split(',')[0];
  const uniqueDestinations = [...new Set(run.stops.map(s => s.dropoffAddr.split(',')[0]).filter(Boolean))];

  const hasDriverOverride = !!(driverOverride && (
    driverOverride.departureOffsetMin !== 0 || driverOverride.waypointOrder || driverOverride.waypointExtraMin
  ));
  const displayedWaypoints = route
    ? (driverOverride?.waypointOrder
        ? driverOverride.waypointOrder.map(i => route.waypoints[i])
        : route.waypoints)
    : [];
  const displayedStartTime = route && driverOverride?.departureOffsetMin
    ? shiftTime(route.driverStartTime, driverOverride.departureOffsetMin)
    : route?.driverStartTime ?? '';
  const offsetMin = driverOverride?.departureOffsetMin ?? 0;

  // Compute per-waypoint ETAs with cumulative extra dwell time
  const displayEtas = (() => {
    let cum = offsetMin;
    return displayedWaypoints.map((wp, i) => {
      const eta = shiftTime(wp.eta, cum);
      cum += driverOverride?.waypointExtraMin?.[i] ?? 0;
      return eta;
    });
  })();
  const hasAnyOverride = !!(driverOverride?.waypointOrder || driverOverride?.waypointExtraMin);

  return (
    <div className={`bg-white rounded-lg border p-2.5 text-xs ${hasDriverOverride ? 'border-blue-200' : hasOverrides ? 'border-amber-200' : 'border-gray-200'}`}>
      {/* Header row */}
      <div className="flex items-center gap-1 mb-2 flex-wrap">
        {isMorning
          ? uniqueDestinations.slice(0, 2).map(d => <span key={d} className="bg-orange-50 text-orange-700 border border-orange-100 px-1.5 py-0.5 rounded truncate max-w-[90px]">{d}</span>)
          : <span className="text-gray-500 truncate flex-1 min-w-0">{anchorShort}</span>
        }
        <span className="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full shrink-0 ml-auto">
          {run.stops.length} {run.stops.length === 1 ? 'aluno' : 'alunos'}
        </span>
        {hasDriverOverride && <span className="text-xs" title="Ajuste motorista activo">🚗</span>}
        <button onClick={onEdit} className="text-gray-300 hover:text-blue-500 transition-colors shrink-0" title="Editar percurso">✏</button>
        {route && <button onClick={onDriverEdit} className="text-gray-300 hover:text-blue-500 transition-colors shrink-0" title="Ajuste motorista">🚗</button>}
      </div>

      {/* Kids chips — before route */}
      {!route && (
        <div className="flex flex-wrap gap-1 mb-2">
          {run.stops.map(s => (
            <span key={s.kidId} className="bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded">{s.kidName.split(' ')[0]}</span>
          ))}
        </div>
      )}

      {/* Route timeline — always visible after calculation */}
      {route && (
        <div className="space-y-1 mb-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-gray-400">
              <span className="font-mono font-semibold text-gray-700 shrink-0">{displayedStartTime}</span>
              <span>Sai Arco-Íris</span>
            </div>
            <button onClick={() => setShowAddresses(v => !v)} className="text-gray-300 hover:text-blue-500 transition-colors" title={showAddresses ? 'Mostrar nomes' : 'Mostrar moradas'}>
              {showAddresses ? '👤' : '📍'}
            </button>
          </div>
          {displayedWaypoints.map((wp, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <span className={`font-mono shrink-0 font-semibold ${wp.type === 'pickup' ? 'text-blue-600' : 'text-orange-600'}`}>
                {hasAnyOverride ? '~' : ''}{displayEtas[i]}
              </span>
              <span className={`shrink-0 ${wp.type === 'pickup' ? 'text-blue-400' : 'text-orange-400'}`}>{wp.type === 'pickup' ? '↑' : '↓'}</span>
              {showAddresses
                ? <span className="text-gray-500 truncate">{wp.address.split(',')[0]}</span>
                : <span className="text-gray-700 truncate">{wp.kidNames.map(n => n.split(' ')[0]).join(', ')}</span>
              }
            </div>
          ))}
          <div className="text-gray-400 pt-0.5 border-t border-gray-50">{route.totalDurationMin}min · {route.totalDistanceKm}km</div>
          {route.unassigned.length > 0 && (
            <div className="text-red-600 bg-red-50 border border-red-100 rounded px-1.5 py-1 space-y-0.5">
              <div className="font-medium">⚠ Sem encaixe:</div>
              {route.unassigned.map((u, i) => <div key={i}>{u.name} <span className="text-red-400">· {u.reason}</span></div>)}
            </div>
          )}
        </div>
      )}

      {locked ? (
        <div className="w-full py-1 text-center text-xs text-amber-500 border border-amber-100 rounded bg-amber-50">
          🔒 bloqueado
        </div>
      ) : (
        <button onClick={onOptimize} disabled={loading}
          className="w-full py-1 text-indigo-500 hover:text-indigo-700 border border-indigo-100 hover:border-indigo-300 rounded bg-indigo-50 hover:bg-indigo-100 transition-colors disabled:opacity-40">
          {loading ? '…' : route ? '↻ Recalcular' : '🗺 Calcular rota'}
        </button>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function TransportPlannerPage() {
  const saved = useMemo(loadFromStorage, []);

  const [dbKids, setDbKids] = useState<PlannerKid[]>([]);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<TransportationConfig>(DEFAULT_CONFIG);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsApplying, setSettingsApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  const [manualKids, setManualKids] = useState<PlannerKid[]>(saved.manualKids);
  const [cellRoutes, setCellRoutes] = useState<Record<string, OptimizedRoute | null>>(saved.cellRoutes ?? {});
  const [cellLoading, setCellLoading] = useState<Record<string, boolean>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showActiveKids, setShowActiveKids] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [locked, setLocked] = useState<boolean>(saved.locked ?? false);
  const [driverHourOverrides, setDriverHourOverrides] = useState<Record<string, number>>(saved.driverHourOverrides ?? {});
  const [driverBreakdownOpen, setDriverBreakdownOpen] = useState(false);
  const [energyBreakdownOpen, setEnergyBreakdownOpen] = useState(false);

  // Manual overrides
  const [runRemovals, setRunRemovals] = useState<Record<string, string[]>>(saved.runRemovals ?? {});
  const [runAddressOverrides, setRunAddressOverrides] = useState<Record<string, Record<string, AddressOverride>>>(saved.runAddressOverrides ?? {});
  const [driverOverrides, setDriverOverrides] = useState<Record<string, DriverOverride>>(saved.driverOverrides ?? {});
  const [editingRun, setEditingRun] = useState<AutoRun | null>(null);
  const [driverEditingRun, setDriverEditingRun] = useState<AutoRun | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [snap, childrenSnap, configSnap] = await Promise.all([
          getDocs(col('transportationSubscriptions')),
          getDocs(col('children')),
          getDoc(docRef('config', 'transportation')),
        ]);
        // Build childId → schoolName lookup from the children collection
        const childSchoolMap: Record<string, string> = {};
        childrenSnap.docs.forEach(d => {
          const s = d.data().schoolName;
          if (s) childSchoolMap[d.id] = s;
        });
        const kids: PlannerKid[] = snap.docs.map(d => {
          const x = d.data();
          if (x.status === 'cancelled') return null;
          return {
            id: d.id, source: (x.source === 'manual' ? 'manual' : 'db') as 'manual' | 'db',
            name: x.childName || '(sem nome)', monthlyFee: x.monthlyFee ?? 0,
            familyId: x.familyId || undefined,
            schoolName: childSchoolMap[x.childId] || x.schoolName || undefined,
            requestedSchedule: parseSchedule(x.schedule || []),
            contactEmail: x.contactEmail, notes: x.note || undefined,
            status: x.status === 'confirmed' ? 'active' : x.status === 'planned' ? 'pending' : (x.status as any) || 'pending',
          };
        }).filter(Boolean) as PlannerKid[];
        setDbKids(kids);
        if (configSnap.exists()) {
          const d = configSnap.data();
          setConfig({ ...DEFAULT_CONFIG, ...d });
        }
      } catch (e) {
        console.error('Failed to load transport data', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    saveToStorage({ manualKids, cellRoutes, runRemovals, runAddressOverrides, driverOverrides, driverHourOverrides, locked });
  }, [manualKids, cellRoutes, runRemovals, runAddressOverrides, driverOverrides, driverHourOverrides, locked]);

  const allKids = useMemo(() => {
    const dbIds = new Set(dbKids.map(k => k.id));
    return [...dbKids, ...manualKids.filter(k => !dbIds.has(k.id))];
  }, [dbKids, manualKids]);

  const pendingKids = useMemo(() => dbKids.filter(k => k.status === 'pending'), [dbKids]);
  const activeKids = useMemo(() => dbKids.filter(k => k.status === 'active'), [dbKids]);

  const allAutoRuns = useMemo(() => {
    const result: Partial<Record<Day, AutoRun[]>> = {};
    for (const day of DAYS) result[day] = computeAutoRuns(allKids, day);
    return result;
  }, [allKids]);

  function getEffectiveRun(run: AutoRun): AutoRun {
    const stops = run.stops
      .filter(s => !(runRemovals[run.id] ?? []).includes(s.kidId))
      .map(s => {
        const ov = runAddressOverrides[run.id]?.[s.kidId];
        return { ...s, pickupAddr: ov?.pickup ?? s.pickupAddr, dropoffAddr: ov?.dropoff ?? s.dropoffAddr };
      });
    return { ...run, stops };
  }

  async function runOptimization(runId: string, effectiveRun: AutoRun) {
    setCellLoading(p => ({ ...p, [runId]: true }));
    // Recalculation resets stop order (solver reoptimises) but keeps departure offset
    setDriverOverrides(prev => {
      const existing = prev[runId];
      if (!existing || !existing.waypointOrder) return prev;
      const next = { departureOffsetMin: existing.departureOffsetMin };
      if (next.departureOffsetMin === 0) { const { [runId]: _, ...rest } = prev; return rest; }
      return { ...prev, [runId]: next };
    });
    try {
      const result = await optimizeAutoRun(effectiveRun, config.vanCapacity);
      setCellRoutes(p => ({ ...p, [runId]: result }));
      if (result?.unassigned.length) console.warn(`[optimizeAutoRun] ${runId}: sem encaixe para`, result.unassigned);
    } catch (e) {
      console.error('[optimizeAutoRun] failed', runId, e);
      alert(`Erro ao calcular rota:\n${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCellLoading(p => ({ ...p, [runId]: false }));
    }
  }

  function handleOptimizeRun(run: AutoRun) {
    return runOptimization(run.id, getEffectiveRun(run));
  }

  async function handleOptimizeAll() {
    for (const run of allRuns) await handleOptimizeRun(run);
  }

  function handleEditSave(run: AutoRun, newRemovals: string[], newOverrides: Record<string, AddressOverride>) {
    setRunRemovals(prev => ({ ...prev, [run.id]: newRemovals }));
    setRunAddressOverrides(prev => ({ ...prev, [run.id]: newOverrides }));
    setCellRoutes(prev => ({ ...prev, [run.id]: null }));
    setEditingRun(null);
    // Build effective run from new values directly (state hasn't settled yet)
    const effectiveStops = run.stops
      .filter(s => !newRemovals.includes(s.kidId))
      .map(s => { const ov = newOverrides[s.kidId]; return { ...s, pickupAddr: ov?.pickup ?? s.pickupAddr, dropoffAddr: ov?.dropoff ?? s.dropoffAddr }; });
    runOptimization(run.id, { ...run, stops: effectiveStops });
  }

  async function removeManualKid(kidId: string) {
    try { await deleteDoc(docRef('transportationSubscriptions', kidId)); } catch { /* ignore */ }
    setDbKids(prev => prev.filter(k => k.id !== kidId));
    setManualKids(prev => prev.filter(k => k.id !== kidId));
  }

  const effectiveStopCount = (run: AutoRun) =>
    run.stops.filter(s => !(runRemovals[run.id] ?? []).includes(s.kidId)).length;

  const allRuns = useMemo(
    () => (Object.values(allAutoRuns).flat() as AutoRun[]).filter(r => effectiveStopCount(r) > 0),
    [allAutoRuns, runRemovals]
  );

  const effectiveRunHours = (run: AutoRun): number => {
    if (driverHourOverrides[run.id] != null) return driverHourOverrides[run.id];
    if (cellRoutes[run.id]) return cellRoutes[run.id]!.totalDurationMin / 60;
    return HOURS_PER_RUN;
  };

  const { driverCost, vanCost, electricityCost, monthlyCost, monthlyRevenue, monthlyDiscountTotal, monthlyProfit } = useMemo(() => {
    const driverCost = allRuns.reduce((sum, run) =>
      sum + effectiveRunHours(run) * config.driverRatePerHour, 0) * config.weeksPerMonth;
    const vanCost = config.vanMonthlyCost;

    const calculatedKms = allRuns.map(r => cellRoutes[r.id]?.totalDistanceKm).filter((km): km is number => km != null);
    const avgKmFallback = calculatedKms.length > 0
      ? calculatedKms.reduce((s, v) => s + v, 0) / calculatedKms.length
      : 0;

    const electricityCost = allRuns.reduce((sum, run) => {
      const km = cellRoutes[run.id]?.totalDistanceKm ?? avgKmFallback;
      return sum + (km / 100) * config.consumptionPer100km * config.electricityPricePerKwh;
    }, 0) * config.weeksPerMonth;
    const monthlyCost = driverCost + vanCost + electricityCost;

    // Sibling ranking: group allKids by familyId ?? contactEmail, sort alphabetically
    const familyGroups: Record<string, PlannerKid[]> = {};
    allKids.forEach(kid => { const key = kid.familyId ?? kid.contactEmail; if (key) (familyGroups[key] ??= []).push(kid); });
    Object.values(familyGroups).forEach(g => g.sort((a, b) => a.name.localeCompare(b.name)));
    const siblingRankMap: Record<string, number> = {};
    Object.values(familyGroups).forEach(group => group.forEach((kid, i) => { siblingRankMap[kid.id] = i + 1; }));

    const periodOrder: Record<Period, number> = { morning: 0, lunch: 1, afternoon: 2 };
    const pricePerTrip = config.flatRatePerTrip;

    let monthlyRevenue = 0;
    let monthlyRevenueGross = 0;
    for (const kid of allKids) {
      const siblingRank = siblingRankMap[kid.id] ?? 1;
      const slotsByDay: Record<string, ScheduleSlot[]> = {};
      for (const slot of kid.requestedSchedule) (slotsByDay[slot.day] ??= []).push(slot);
      Object.values(slotsByDay).forEach(g => g.sort((a, b) => periodOrder[slotPeriod(a.time)] - periodOrder[slotPeriod(b.time)]));

      for (const slot of kid.requestedSchedule) {
        const tripRank = (slotsByDay[slot.day].indexOf(slot) ?? 0) + 1;
        let totalDiscount = 0;
        // Sibling discount applies to 2nd+ child in the same family
        if (siblingRank >= 2) totalDiscount += config.siblingDiscountPercentage;
        // School discount: match by school name (case-insensitive)
        for (const sd of (config.schoolDiscounts ?? [])) {
          if (kid.schoolName && sd.schoolName && sd.schoolName.toLowerCase() === kid.schoolName.toLowerCase()) {
            totalDiscount += sd.discountPercentage;
          }
        }
        // Multi-trip discount: applies to 2nd+ trip on the same day
        if (tripRank >= config.minTripsForDiscount) totalDiscount += config.multiTripDiscountPercentage;
        totalDiscount = Math.min(1, totalDiscount);
        monthlyRevenue += pricePerTrip * (1 - totalDiscount) * config.weeksPerMonth;
        monthlyRevenueGross += pricePerTrip * config.weeksPerMonth;
      }
    }
    const monthlyDiscountTotal = monthlyRevenueGross - monthlyRevenue;

    return { driverCost, vanCost, electricityCost, monthlyCost, monthlyRevenue, monthlyRevenueGross, monthlyDiscountTotal, monthlyProfit: monthlyRevenue - monthlyCost };
  }, [allRuns, cellRoutes, config, allKids, driverHourOverrides, runRemovals]);

  // For each kid: which (day-period) slots are they actually in (respecting manual removals)
  const kidAssignments = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    for (const day of DAYS) {
      for (const run of (allAutoRuns[day] ?? [])) {
        for (const stop of run.stops) {
          if (runRemovals[run.id]?.includes(stop.kidId)) continue;
          if (!map[stop.kidId]) map[stop.kidId] = new Set();
          map[stop.kidId].add(`${day}-${run.direction}`);
        }
      }
    }
    return map;
  }, [allAutoRuns, runRemovals]);

  async function handleSaveConfig(cfg: TransportationConfig) {
    setSettingsSaving(true);
    try {
      await saveTransportationConfig(cfg);
      setConfig(cfg);
      setSettingsOpen(false);
    } finally {
      setSettingsSaving(false);
    }
  }

  async function handleApplyToSubscriptions(cfg: TransportationConfig) {
    setSettingsApplying(true);
    setApplyResult(null);
    try {
      await saveTransportationConfig(cfg);
      setConfig(cfg);
      const [subs, childrenSnap] = await Promise.all([
        getActiveTransportationSubscriptions(),
        getDocs(col('children')),
      ]);
      const childSchoolMap: Record<string, string> = {};
      childrenSnap.docs.forEach(d => { const s = d.data().schoolName; if (s) childSchoolMap[d.id] = s; });
      // Enrich subs with school name from children collection
      subs.forEach(s => { if (!s.schoolName && (s as any).childId) s.schoolName = childSchoolMap[(s as any).childId]; });
      // Rebuild sibling rank map from all subscriptions
      const famGroups: Record<string, typeof subs> = {};
      subs.forEach(s => { const k = s.familyId ?? s.contactEmail; if (k) (famGroups[k] ??= []).push(s); });
      Object.values(famGroups).forEach(g => g.sort((a, b) => a.childName.localeCompare(b.childName)));
      const sibRank: Record<string, number> = {};
      Object.values(famGroups).forEach(group => group.forEach((s, i) => { sibRank[s.id] = i + 1; }));

      const periodOrder: Record<string, number> = { morning: 0, lunch: 1, afternoon: 2 };
      const slotPeriodFrom = (time: string) => {
        const h = parseInt(time.split(':')[0], 10);
        return h < 12 ? 'morning' : h < 15 ? 'lunch' : 'afternoon';
      };

      let updated = 0;
      const batch: Array<{ id: string; monthlyFee: number }> = [];
      for (const sub of subs) {
        const rank = sibRank[sub.id] ?? 1;
        const slotsByDay: Record<string, typeof sub.schedule> = {};
        for (const slot of sub.schedule) (slotsByDay[slot.dayOfWeek] ??= []).push(slot);
        Object.values(slotsByDay).forEach(g =>
          g.sort((a, b) => (periodOrder[slotPeriodFrom(a.pickupTime)] ?? 0) - (periodOrder[slotPeriodFrom(b.pickupTime)] ?? 0))
        );

        let totalSlotFee = 0;
        for (const [, slots] of Object.entries(slotsByDay)) {
          slots.forEach((slot, idx) => {
            const tripRank = idx + 1;
            let discount = 0;
            if (rank >= 2) discount += cfg.siblingDiscountPercentage;
            for (const sd of (cfg.schoolDiscounts ?? [])) {
              if (sub.schoolName && sd.schoolName && sd.schoolName.toLowerCase() === sub.schoolName.toLowerCase()) {
                discount += sd.discountPercentage;
              }
            }
            if (tripRank >= cfg.minTripsForDiscount) discount += cfg.multiTripDiscountPercentage;
            discount = Math.min(1, discount);
            totalSlotFee += cfg.flatRatePerTrip * (1 - discount) * cfg.weeksPerMonth;
          });
        }
        if (Math.abs(totalSlotFee - sub.monthlyFee) > 0.01) {
          batch.push({ id: sub.id, monthlyFee: totalSlotFee });
          updated++;
        }
      }
      // Write updates
      for (const { id, monthlyFee } of batch) {
        await updateDoc(docRef('transportationSubscriptions', id), { monthlyFee, updatedAt: new Date() });
      }
      setApplyResult(`${updated} inscrições actualizadas de ${subs.length} no total.`);
    } catch (e) {
      setApplyResult(`Erro: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSettingsApplying(false);
    }
  }

  const totalRunCount = allRuns.length;
  const totalKidCount = useMemo(() => {
    const ids = new Set<string>();
    allRuns.forEach(run => run.stops.forEach(s => ids.add(s.kidId)));
    return ids.size;
  }, [allRuns]);

  const anyLoading = Object.values(cellLoading).some(Boolean);
  const profitColor = monthlyProfit >= 0 ? 'text-green-600' : 'text-red-600';

  return (
    <div className="flex flex-col h-full -m-6">
      {/* Summary bar */}
      <div className="bg-white border-b border-gray-200 px-6 pt-3 pb-3 overflow-y-auto max-h-[80vh]">
        <div className="flex items-center gap-5 flex-wrap">
          <div className="flex items-center gap-5 divide-x divide-gray-200">
            <div>
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide">Custo mensal</div>
              <div className="text-lg font-bold text-red-600">{eur(monthlyCost)}</div>
              <div className="text-xs text-gray-400 space-x-1.5">
                <button onClick={() => setDriverBreakdownOpen(v => !v)}
                  className={`underline decoration-dashed underline-offset-2 hover:text-gray-600 transition-colors ${driverBreakdownOpen ? 'text-gray-600' : ''}`}>
                  {eur(driverCost)} motorista
                </button><span>·</span>
                <span>{eur(vanCost)} van</span><span>·</span>
                <button onClick={() => setEnergyBreakdownOpen(v => !v)}
                  className={`underline decoration-dashed underline-offset-2 hover:text-gray-600 transition-colors ${energyBreakdownOpen ? 'text-gray-600' : ''}`}>
                  {eur(electricityCost)} energia
                </button>
              </div>
            </div>
            <div className="pl-5">
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide">Receita mensal</div>
              <div className="text-lg font-bold text-blue-600">{eur(monthlyRevenue)}</div>
              <div className="text-xs text-gray-400 space-x-1">
                {config.flatRatePerTrip > 0 && <span>€{config.flatRatePerTrip}/viagem</span>}
                {monthlyDiscountTotal > 0 && <span className="text-orange-500">· -{eur(monthlyDiscountTotal)} desc.</span>}
              </div>
            </div>
            <div className="pl-5">
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide">Lucro mensal</div>
              <div className={`text-lg font-bold ${profitColor}`}>{eur(monthlyProfit)}</div>
            </div>
          </div>
          <div className="text-sm text-gray-500">
            <span className="font-semibold text-gray-700">{totalRunCount}</span> viagens ·{' '}
            <span className="font-semibold text-gray-700">{totalKidCount}</span> alunos
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setSettingsOpen(true)}
              className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-600 transition-colors">
              ⚙ Definições
            </button>
            {!locked && (
              <button onClick={handleOptimizeAll} disabled={anyLoading}
                className="text-sm px-4 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-60 font-medium">
                {anyLoading ? '…' : '🗺 Calcular todas as rotas'}
              </button>
            )}
            <button
              onClick={() => setLocked(v => !v)}
              title={locked ? 'Desbloquear para recalcular rotas' : 'Bloquear setup — congela rotas e cálculos'}
              className={`text-sm px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                locked
                  ? 'bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100'
                  : 'border-gray-200 hover:bg-gray-50 text-gray-600'
              }`}
            >
              {locked ? '🔓 Desbloquear' : '🔒 Bloquear'}
            </button>
          </div>
        </div>
        {settingsOpen && (
          <SettingsModal
            initial={config}
            allKids={allKids}
            onClose={() => setSettingsOpen(false)}
            onSave={handleSaveConfig}
            onApply={handleApplyToSubscriptions}
            saving={settingsSaving}
            applying={settingsApplying}
            applyResult={applyResult}
          />
        )}
        {driverBreakdownOpen && (
          <div className="pt-3 border-t border-gray-100 mt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Horas motorista por viagem</span>
              {Object.keys(driverHourOverrides).length > 0 && (
                <button onClick={() => setDriverHourOverrides({})} className="text-xs text-gray-400 hover:text-gray-600">repor tudo</button>
              )}
            </div>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr>
                  <th className="w-10" />
                  {DAYS.map(d => (
                    <th key={d} className="text-center font-semibold text-gray-500 pb-1 px-1">{DAY_SHORT[d]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERIODS.map(period => (
                  <tr key={period.id}>
                    <td className="pr-2 text-right text-gray-400 py-1 align-middle">{period.emoji}</td>
                    {DAYS.map(day => {
                      const run = (allAutoRuns[day] ?? []).find(r => r.direction === period.id && effectiveStopCount(r) > 0);
                      if (!run) return <td key={day} className="px-1 py-1 text-center text-gray-200">—</td>;
                      const fromRoute = cellRoutes[run.id] != null ? cellRoutes[run.id]!.totalDurationMin / 60 : null;
                      const override = driverHourOverrides[run.id];
                      const hours = effectiveRunHours(run);
                      const isOverridden = override != null;
                      return (
                        <td key={day} className="px-1 py-1">
                          <div className={`rounded border px-1.5 py-1 flex flex-col items-center gap-0.5 ${isOverridden ? 'border-blue-200 bg-blue-50' : 'border-gray-100 bg-gray-50'}`}>
                            <span className={`font-mono font-semibold tabular-nums ${isOverridden ? 'text-blue-600' : 'text-gray-700'}`}>
                              {fmtHours(hours)}
                            </span>
                            <div className="flex items-center gap-0.5">
                              <button
                                onClick={() => setDriverHourOverrides(prev => ({ ...prev, [run.id]: Math.max(0.25, (prev[run.id] ?? hours) - 0.25) }))}
                                className="w-4 h-4 rounded border border-gray-200 bg-white text-gray-400 hover:text-gray-700 leading-none">−</button>
                              <button
                                onClick={() => setDriverHourOverrides(prev => ({ ...prev, [run.id]: (prev[run.id] ?? hours) + 0.25 }))}
                                className="w-4 h-4 rounded border border-gray-200 bg-white text-gray-400 hover:text-gray-700 leading-none">+</button>
                              {isOverridden && (
                                <button
                                  onClick={() => setDriverHourOverrides(prev => { const { [run.id]: _, ...rest } = prev; return rest; })}
                                  className="text-blue-300 hover:text-blue-600 leading-none" title="Repor">↺</button>
                              )}
                              {!isOverridden && fromRoute == null && (
                                <span className="text-gray-300 italic">est</span>
                              )}
                            </div>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                  {/* Totals row */}
                <tr className="border-t border-gray-200">
                  <td className="pr-2 text-right text-gray-400 py-1.5 font-semibold text-xs">Σ/dia</td>
                  {DAYS.map(day => {
                    const dayRuns = allRuns.filter(r => r.day === day);
                    if (!dayRuns.length) return <td key={day} className="px-1 py-1.5 text-center text-gray-200 text-xs">—</td>;
                    const total = dayRuns.reduce((s, r) => s + effectiveRunHours(r), 0);
                    return (
                      <td key={day} className="px-1 py-1.5 text-center">
                        <span className="font-mono font-semibold text-gray-700 text-xs">{fmtHours(total)}</span>
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>

            {/* Weekly / monthly summary */}
            {(() => {
              const weeklyH = allRuns.reduce((s, r) => s + effectiveRunHours(r), 0);
              const monthlyH = weeklyH * config.weeksPerMonth;
              return (
                <div className="flex items-center gap-5 mt-3 pt-2 border-t border-gray-100 text-xs">
                  <div>
                    <span className="text-gray-400">Por semana</span>
                    <span className="font-mono font-semibold text-gray-700 ml-1.5">{fmtHours(weeklyH)}</span>
                  </div>
                  <div>
                    <span className="text-gray-400">Por mês</span>
                    <span className="font-mono font-semibold text-gray-700 ml-1.5">{fmtHours(monthlyH)}</span>
                  </div>
                  <div>
                    <span className="text-gray-400">Custo motorista</span>
                    <span className="font-semibold text-red-600 ml-1.5">{eur(driverCost)}/mês</span>
                  </div>
                </div>
              );
            })()}

            <p className="text-xs text-gray-400 mt-2">Azul = manual · ↺ repõe o calculado · "est" = rota não calculada</p>
          </div>
        )}

        {energyBreakdownOpen && (
          <div className="pt-3 border-t border-gray-100 mt-3">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Detalhe energia por viagem</span>
            <table className="w-full text-xs border-collapse mt-2">
              <thead>
                <tr>
                  <th className="w-10" />
                  {DAYS.map(d => (
                    <th key={d} className="text-center font-semibold text-gray-500 pb-1 px-1">{DAY_SHORT[d]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERIODS.map(period => (
                  <tr key={period.id}>
                    <td className="pr-2 text-right text-gray-400 py-1 align-middle">{period.emoji}</td>
                    {DAYS.map(day => {
                      const run = (allAutoRuns[day] ?? []).find(r => r.direction === period.id && effectiveStopCount(r) > 0);
                      if (!run) return <td key={day} className="px-1 py-1 text-center text-gray-200">—</td>;
                      const km = cellRoutes[run.id]?.totalDistanceKm;
                      const hasRoute = km != null;
                      const kWh = hasRoute ? (km! / 100) * config.consumptionPer100km : null;
                      return (
                        <td key={day} className="px-1 py-1">
                          <div className={`rounded border px-1.5 py-1 flex flex-col items-center gap-0.5 ${hasRoute ? 'border-gray-100 bg-gray-50' : 'border-dashed border-gray-200 bg-white'}`}>
                            {hasRoute ? (
                              <>
                                <span className="font-mono font-semibold text-gray-700 tabular-nums">{km!.toFixed(1)}km</span>
                                <span className="text-gray-400 tabular-nums">{kWh!.toFixed(1)}kWh</span>
                              </>
                            ) : (
                              <span className="text-gray-300 italic">est</span>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {/* Totals row */}
                <tr className="border-t border-gray-200">
                  <td className="pr-2 text-right text-gray-400 py-1.5 font-semibold text-xs">Σ/dia</td>
                  {DAYS.map(day => {
                    const dayRuns = allRuns.filter(r => r.day === day);
                    if (!dayRuns.length) return <td key={day} className="px-1 py-1.5 text-center text-gray-200 text-xs">—</td>;
                    const totalKm = dayRuns.reduce((s, r) => s + (cellRoutes[r.id]?.totalDistanceKm ?? 0), 0);
                    return (
                      <td key={day} className="px-1 py-1.5 text-center">
                        <span className="font-mono font-semibold text-gray-700 text-xs tabular-nums">{totalKm.toFixed(1)}km</span>
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>

            {/* Energy summary footer */}
            {(() => {
              const weeklyKm = allRuns.reduce((s, r) => s + (cellRoutes[r.id]?.totalDistanceKm ?? 0), 0);
              const weeklyKwh = (weeklyKm / 100) * config.consumptionPer100km;
              const weeklyEnergyCost = weeklyKwh * config.electricityPricePerKwh;
              return (
                <div className="flex items-center gap-5 mt-3 pt-2 border-t border-gray-100 text-xs flex-wrap">
                  <div>
                    <span className="text-gray-400">km/semana</span>
                    <span className="font-mono font-semibold text-gray-700 ml-1.5 tabular-nums">{weeklyKm.toFixed(1)} km</span>
                  </div>
                  <div>
                    <span className="text-gray-400">kWh/semana</span>
                    <span className="font-mono font-semibold text-gray-700 ml-1.5 tabular-nums">{weeklyKwh.toFixed(1)} kWh</span>
                  </div>
                  <div>
                    <span className="text-gray-400">€/semana</span>
                    <span className="font-mono font-semibold text-gray-700 ml-1.5 tabular-nums">€{weeklyEnergyCost.toFixed(2)}</span>
                  </div>
                  <div>
                    <span className="text-gray-400">Custo energia</span>
                    <span className="font-semibold text-red-600 ml-1.5">{eur(electricityCost)}/mês</span>
                  </div>
                </div>
              );
            })()}

            <p className="text-xs text-gray-400 mt-2">"est" = rota não calculada, km não contabilizados · {config.consumptionPer100km} kWh/100km · €{config.electricityPricePerKwh}/kWh</p>
          </div>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — collapsible */}
        {sidebarOpen && (
          <div className="w-52 shrink-0 border-r border-gray-200 bg-white flex flex-col overflow-hidden">
            <div className="p-3 border-b border-gray-100">
              <span className="text-sm font-semibold text-gray-700">Inscrições</span>
            </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {loading && <p className="text-sm text-gray-400 text-center py-4">A carregar…</p>}
            {manualKids.map(k => (
              <div key={k.id} className="relative group">
                <KidCard kid={k} assignedSlots={kidAssignments[k.id] ?? new Set()} />
                <button onClick={() => removeManualKid(k.id)}
                  className="absolute top-1.5 right-7 text-gray-300 hover:text-red-500 text-sm opacity-0 group-hover:opacity-100 transition-opacity">×</button>
              </div>
            ))}
            {!loading && pendingKids.length === 0 && manualKids.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-3">Sem pedidos pendentes.</p>
            )}
            {pendingKids.map(k => <KidCard key={k.id} kid={k} assignedSlots={kidAssignments[k.id] ?? new Set()} />)}
            {activeKids.length > 0 && (
              <div className="mt-2">
                <button onClick={() => setShowActiveKids(v => !v)}
                  className="w-full text-left text-xs text-gray-400 font-medium uppercase tracking-wide py-2 flex items-center justify-between">
                  <span>Já ativas ({activeKids.length})</span>
                  <span>{showActiveKids ? '▲' : '▼'}</span>
                </button>
                {showActiveKids && activeKids.map(k => <KidCard key={k.id} kid={k} assignedSlots={kidAssignments[k.id] ?? new Set()} />)}
              </div>
            )}
          </div>
        </div>
        )}

        {/* Sidebar toggle strip */}
        <button
          onClick={() => setSidebarOpen(v => !v)}
          className="shrink-0 w-5 border-r border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-center text-gray-300 hover:text-gray-500 transition-colors"
          title={sidebarOpen ? 'Fechar painel' : 'Abrir painel'}
        >
          <span className="text-xs">{sidebarOpen ? '‹' : '›'}</span>
        </button>

        {/* Calendar grid */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <p className="text-sm text-gray-400 py-8 text-center">A carregar…</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] border-collapse table-fixed">
                <thead>
                  <tr>
                    <th className="w-14 pb-2"></th>
                    {DAYS.map(d => (
                      <th key={d} className="pb-2 text-xs font-semibold text-gray-600 text-center px-1">{DAY_SHORT[d]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PERIODS.map((period, pi) => (
                    <tr key={period.id}>
                      <td className={`pr-2 align-top pt-2 pb-3 ${pi > 0 ? 'border-t border-gray-100' : ''}`}>
                        <div className="flex flex-col items-end gap-0.5 pt-0.5">
                          <span className="text-sm leading-none">{period.emoji}</span>
                          <span className="text-xs font-semibold text-gray-400">{period.label}</span>
                        </div>
                      </td>
                      {DAYS.map(day => {
                        const runsForCell = (allAutoRuns[day] ?? []).filter(r => r.direction === period.id && effectiveStopCount(r) > 0);
                        return (
                          <td key={day} className={`p-1 align-top ${pi > 0 ? 'border-t border-gray-100' : ''}`}>
                            {runsForCell.length === 0 ? (
                              <div className="min-h-[48px] rounded-lg border border-dashed border-gray-100 flex items-center justify-center">
                                <span className="text-xs text-gray-200">—</span>
                              </div>
                            ) : (
                              <div className="space-y-1">
                                {runsForCell.map(run => (
                                  <RouteCell
                                    key={run.id}
                                    run={run}
                                    route={cellRoutes[run.id]}
                                    loading={cellLoading[run.id]}
                                    hasOverrides={!!(runRemovals[run.id]?.length || runAddressOverrides[run.id])}
                                    driverOverride={driverOverrides[run.id]}
                                    locked={locked}
                                    onOptimize={() => handleOptimizeRun(run)}
                                    onEdit={() => setEditingRun(run)}
                                    onDriverEdit={() => setDriverEditingRun(run)}
                                  />
                                ))}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {editingRun && (
        <EditRunModal
          run={editingRun}
          removals={runRemovals[editingRun.id] ?? []}
          addressOverrides={runAddressOverrides[editingRun.id] ?? {}}
          onSave={(removals, overrides) => handleEditSave(editingRun, removals, overrides)}
          onClose={() => setEditingRun(null)}
        />
      )}
      {driverEditingRun && cellRoutes[driverEditingRun.id] && (
        <DriverOverrideModal
          run={driverEditingRun}
          route={cellRoutes[driverEditingRun.id]!}
          override={driverOverrides[driverEditingRun.id] ?? { departureOffsetMin: 0 }}
          onSave={override => {
            if (override.departureOffsetMin === 0 && !override.waypointOrder) {
              setDriverOverrides(prev => { const { [driverEditingRun.id]: _, ...rest } = prev; return rest; });
            } else {
              setDriverOverrides(prev => ({ ...prev, [driverEditingRun.id]: override }));
            }
            setDriverEditingRun(null);
          }}
          onClose={() => setDriverEditingRun(null)}
        />
      )}
    </div>
  );
}
