import { useEffect, useState, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getDocs, getDoc, deleteDoc, updateDoc, addDoc, writeBatch } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { col, docRef } from '../../lib/db';
import { solveRoutes, SolverKid, DEPOT_ADDRESS as SOLVER_DEPOT } from '../../lib/routeSolver';
import { TransportationConfig, SchoolDiscount, WeekPattern } from '@shared/models/Transportation';
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
  status?: 'pending' | 'active' | 'planned' | 'offered';
  contactEmail?: string;
  weekPattern: WeekPattern;
}
interface AutoStop { kidId: string; kidName: string; pickupAddr: string; dropoffAddr: string; requestedTime: number }
interface AutoRun {
  id: string; day: Day;
  direction: 'morning' | 'lunch' | 'afternoon';
  targetArrival: number;
  anchor: string;
  stops: AutoStop[];
}
interface RouteWaypoint { kidIds: string[]; kidNames: string[]; address: string; type: 'pickup' | 'dropoff'; eta: string; deviationMin?: number; rideTimesMin?: number[] }
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
interface RunAdditionEntry extends AutoStop {
  sourceRunId: string;
}
interface SavedPlan {
  manualKids: PlannerKid[];
  cellRoutes?: Record<string, OptimizedRoute | null>;
  runRemovals?: Record<string, string[]>;
  runAdditions?: Record<string, RunAdditionEntry[]>;
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
  siblingDiscountPercentage: 0, returningStudentDiscountPercentage: 0, schoolDiscounts: [],
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
  try {
    const r = localStorage.getItem(LS_KEY);
    if (r) {
      const p = JSON.parse(r) as SavedPlan;
      // backfill weekPattern for older saved kids
      p.manualKids = (p.manualKids ?? []).map(k => ({ weekPattern: 'all' as WeekPattern, ...k }));
      return p;
    }
  } catch { /* ignore */ }
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
function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
// Mirrors the route card's displayed duration exactly:
// waypointExtraMin[i] shifts ETA of waypoint i+1 onwards, so the last stop's extra never counts.
function routeWallClockMin(route: OptimizedRoute, override?: DriverOverride): number {
  const offsetMin = override?.departureOffsetMin ?? 0;
  const wps = override?.waypointOrder ? override.waypointOrder.map(i => route.waypoints[i]) : route.waypoints;
  let cum = offsetMin;
  const etas: string[] = [];
  wps.forEach((wp, i) => {
    etas.push(shiftTime(wp.eta, cum));
    cum += override?.waypointExtraMin?.[i] ?? 0;
  });
  const last = etas[etas.length - 1];
  const start = offsetMin !== 0 ? shiftTime(route.driverStartTime, offsetMin) : route.driverStartTime;
  if (last && start) return (hhmmToMin(last) - hhmmToMin(start) + 1440) % 1440;
  return route.totalDurationMin;
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
// Compute display ETAs for a route, respecting reorder and extra buffer times.
// When order is default, shifts original solver ETAs by departure offset + cumulative extra.
// When reordered, rebuilds from departure time using original inter-stop durations as estimates.
function computeDisplayEtas(
  route: OptimizedRoute,
  order: number[],
  extraMin: number[],
  offsetMin: number,
): string[] {
  const origEtaMins = route.waypoints.map(wp => hhmmToMin(wp.eta));
  const origStartMin = hhmmToMin(route.driverStartTime);
  const interStopDurs = origEtaMins.slice(1).map((t, i) => (t - origEtaMins[i] + 1440) % 1440);
  const isDefault = order.every((v, i) => v === i);

  if (isDefault) {
    let cum = offsetMin;
    return order.map((wpIdx, i) => {
      const eta = shiftTime(route.waypoints[wpIdx].eta, cum);
      cum += extraMin[i] ?? 0;
      return eta;
    });
  }

  // Reordered: rebuild times from departure anchor using positional segment durations
  const avgSeg = interStopDurs.length > 0
    ? interStopDurs.reduce((s, d) => s + d, 0) / interStopDurs.length
    : 10;
  const result: string[] = [];
  let curMin = origStartMin + offsetMin;
  order.forEach((wpIdx, i) => {
    if (i === 0) {
      curMin += (origEtaMins[wpIdx] - origStartMin + 1440) % 1440;
    } else {
      curMin += (interStopDurs[i - 1] ?? avgSeg) + (extraMin[i - 1] ?? 0);
    }
    const mod = ((curMin % 1440) + 1440) % 1440;
    result.push(`${String(Math.floor(mod / 60)).padStart(2, '0')}:${String(Math.round(mod % 60)).padStart(2, '0')}`);
  });
  return result;
}
function buildMapsUrl(startAddr: string, waypoints: RouteWaypoint[], order: number[]): string {
  const wps = order.map(i => waypoints[i]).filter(wp => wp.address);
  if (!wps.length) return '';
  const origin = encodeURIComponent(startAddr);
  const destination = encodeURIComponent(wps[wps.length - 1].address);
  const midpoints = wps.slice(0, -1).map(wp => encodeURIComponent(wp.address)).join('|');
  const base = `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${origin}&destination=${destination}`;
  return midpoints ? `${base}&waypoints=${midpoints}` : base;
}
function computeAutoRuns(kids: PlannerKid[], day: Day): AutoRun[] {
  const morning: AutoStop[] = [];
  const lunch: AutoStop[] = [];
  const afternoon: AutoStop[] = [];

  for (const kid of kids) {
    for (const slot of kid.requestedSchedule) {
      if (slot.day !== day) continue;
      const t = parseMinutes(slot.time || '08:00');
      const stop: AutoStop = { kidId: kid.id, kidName: kid.name, pickupAddr: slot.pickup, dropoffAddr: slot.dropoff, requestedTime: t };
      if (t < 12 * 60) {
        if (slot.pickup.trim()) morning.push(stop);
      } else if (t < LUNCH_CUTOFF_MIN) {
        if (slot.dropoff.trim()) lunch.push(stop);
      } else {
        if (slot.dropoff.trim()) afternoon.push(stop);
      }
    }
  }

  const dedup = (stops: AutoStop[]) => {
    const seen = new Set<string>();
    return stops.filter(s => { if (seen.has(s.kidId)) return false; seen.add(s.kidId); return true; });
  };

  const runs: AutoRun[] = [];
  if (morning.length > 0) {
    const stops = dedup(morning);
    runs.push({ id: `auto-${day}-m0`, day, direction: 'morning', targetArrival: MORNING_DEADLINE_MIN, anchor: '', stops });
  }
  if (lunch.length > 0) {
    const stops = dedup(lunch);
    runs.push({ id: `auto-${day}-l0`, day, direction: 'lunch', targetArrival: Math.min(...stops.map(s => s.requestedTime)), anchor: '', stops });
  }
  if (afternoon.length > 0) {
    const stops = dedup(afternoon);
    runs.push({ id: `auto-${day}-a0`, day, direction: 'afternoon', targetArrival: Math.min(...stops.map(s => s.requestedTime)), anchor: '', stops });
  }
  return runs.sort((a, b) => a.targetArrival - b.targetArrival);
}
async function optimizeAutoRun(run: AutoRun, vanCapacity: number): Promise<OptimizedRoute | null> {
  if (!MAPS_KEY || !run.stops.length) return null;
  const isMorning = run.direction === 'morning';
  const kids: SolverKid[] = run.stops.filter(s => s.pickupAddr.trim()).map(s => ({
    kidId: s.kidId, kidName: s.kidName,
    pickupAddress: s.pickupAddr,
    dropoffAddress: s.dropoffAddr.trim() ? s.dropoffAddr : SOLVER_DEPOT,
    deadlineMin: isMorning ? MORNING_DEADLINE_MIN : 23 * 60,
    maxRideMin: isMorning ? 60 : 180,
    earliestPickupMin: isMorning ? undefined : s.requestedTime,
  }));
  if (!kids.length) return null;
  const result = await solveRoutes(kids, vanCapacity, MAPS_KEY, isMorning ? 'morning' : 'afternoon', run.targetArrival);
  // Build pickup time lookup for ride-time calculation
  const pickupTimeByKid: Record<string, number> = {};
  result.stops.forEach(s => { if (s.type === 'pickup') pickupTimeByKid[s.kidId] = s.arrivalMin; });

  const rawWaypoints: RouteWaypoint[] = result.stops.filter(s => s.type !== 'depot').map(s => ({
    kidIds: [s.kidId], kidNames: [s.kidName],
    address: s.address, type: s.type as 'pickup' | 'dropoff',
    eta: formatTimeSec(s.arrivalMin * 60),
    deviationMin: s.deviationMin,
    rideTimesMin: s.type === 'dropoff' && pickupTimeByKid[s.kidId] != null
      ? [Math.round(s.arrivalMin - pickupTimeByKid[s.kidId])]
      : undefined,
  }));
  const merged: RouteWaypoint[] = [];
  for (const wp of rawWaypoints) {
    const last = merged[merged.length - 1];
    if (last && last.address === wp.address && last.type === wp.type) {
      last.kidIds.push(...wp.kidIds); last.kidNames.push(...wp.kidNames);
      if (wp.deviationMin != null) last.deviationMin = Math.round(((last.deviationMin ?? 0) + wp.deviationMin) / 2);
      if (wp.rideTimesMin) last.rideTimesMin = [...(last.rideTimesMin ?? []), ...wp.rideTimesMin];
    } else merged.push({ ...wp });
  }
  return {
    waypoints: merged,
    driverStartTime: formatTimeSec(result.driverDepartMin * 60),
    driverStartAddress: SOLVER_DEPOT,
    totalDurationMin: result.totalTimeMin,
    totalDistanceKm: result.totalDistanceKm,
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

        let subtotal = 0;
        const appliedDiscounts = new Set<string>();
        for (const [, slots] of Object.entries(slotsByDay)) {
          slots.forEach((_, idx) => {
            const tripRank = idx + 1;
            let discount = 0;
            if (rank >= 2) { discount += cfg.siblingDiscountPercentage; if (cfg.siblingDiscountPercentage > 0) appliedDiscounts.add(`irmãos -${pct(cfg.siblingDiscountPercentage)}%`); }
            if (tripRank >= cfg.minTripsForDiscount) { discount += cfg.multiTripDiscountPercentage; if (cfg.multiTripDiscountPercentage > 0) appliedDiscounts.add(`2.ª viagem -${pct(cfg.multiTripDiscountPercentage)}%`); }
            discount = Math.min(1, discount);
            subtotal += cfg.flatRatePerTrip * (1 - discount) * cfg.weeksPerMonth;
          });
        }
        let schoolDiscountPct = 0;
        for (const sd of (cfg.schoolDiscounts ?? [])) {
          if (kid.schoolName && sd.schoolName && sd.schoolName.toLowerCase() === kid.schoolName.toLowerCase() && sd.discountPercentage > 0) {
            schoolDiscountPct = sd.discountPercentage;
            appliedDiscounts.add(`escola -${pct(sd.discountPercentage)}%`);
          }
        }
        const fee = subtotal * (1 - schoolDiscountPct);
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

              {/* Aluno anterior */}
              <div className="bg-gray-50 rounded-lg p-3 space-y-2">
                <p className="text-xs font-medium text-gray-700">Aluno anterior</p>
                <Field label="desconto (%)" value={pct(cfg.returningStudentDiscountPercentage)} step={1} onChange={v => set('returningStudentDiscountPercentage', frac(v))} width="w-14" />
                {hint('Desconto aplicado manualmente a alunos do ano anterior (marcados em Inscrições)')}
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

// ─── KidChip ─────────────────────────────────────────────────────────────────
function KidChip({ kid, assignedSlots, onRemove }: {
  kid: PlannerKid;
  assignedSlots: Set<string>;
  onRemove?: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  const totalSlots = kid.requestedSchedule.length;
  const assignedCount = kid.requestedSchedule.filter(s => {
    const p = slotPeriod(s.time);
    return assignedSlots.has(`${s.day}-${p}`);
  }).length;

  const isSeated = assignedCount > 0;
  const isPartial = isSeated && assignedCount < totalSlots;

  const chipCls = isPartial
    ? 'bg-amber-100 text-amber-800 border-amber-200'
    : isSeated
      ? 'bg-green-100 text-green-800 border-green-200'
      : 'bg-gray-100 text-gray-600 border-gray-200';

  const days = [...new Set(kid.requestedSchedule.map(s => DAY_SHORT[s.day] ?? s.day))].join(' ');
  const pickup = kid.requestedSchedule[0]?.pickup?.split(',')[0] ?? '—';
  const dropoff = kid.requestedSchedule[0]?.dropoff?.split(',')[0] ?? '—';

  return (
    <div className="relative inline-block" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <Link
        to={`/admin/subscriptions?highlight=${kid.id}`}
        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs font-medium transition-shadow hover:shadow-sm ${chipCls}`}
        onClick={e => e.stopPropagation()}
      >
        {kid.name}
        {isPartial && <span className="opacity-60 text-[10px]">{assignedCount}/{totalSlots}</span>}
        {onRemove && (
          <button type="button" onClick={e => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
            className="ml-0.5 opacity-40 hover:opacity-100 leading-none">×</button>
        )}
      </Link>

      {/* Hover tooltip */}
      {hovered && (
        <div className="absolute left-0 top-7 z-50 w-52 bg-gray-900 text-white rounded-lg p-2.5 shadow-xl text-xs space-y-1 pointer-events-none">
          <p className="font-semibold">{kid.name}</p>
          {kid.contactEmail && <p className="text-gray-300 truncate">{kid.contactEmail}</p>}
          {days && <p className="text-gray-300">📅 {days}</p>}
          {pickup !== '—' && <p className="text-gray-300 truncate">▲ {pickup}</p>}
          {dropoff !== '—' && <p className="text-gray-300 truncate">▼ {dropoff}</p>}
          {kid.monthlyFee > 0 && <p className="text-green-300 font-medium">€{kid.monthlyFee.toFixed(0)}/mês</p>}
          {kid.notes && <p className="text-gray-400 italic truncate">{kid.notes}</p>}
        </div>
      )}
    </div>
  );
}

function KidChipGroup({ title, color, kids, kidAssignments, onRemove }: {
  title: string;
  color: 'green' | 'amber';
  kids: PlannerKid[];
  kidAssignments: Record<string, Set<string>>;
  onRemove: (k: PlannerKid) => void;
}) {
  const headerCls = color === 'green'
    ? 'bg-green-50 border-green-200 text-green-800'
    : 'bg-amber-50 border-amber-200 text-amber-800';

  return (
    <div className={`rounded-xl border ${color === 'green' ? 'border-green-200' : 'border-amber-200'} overflow-hidden`}>
      <div className={`px-3 py-2 flex items-center justify-between ${headerCls}`}>
        <span className="text-xs font-semibold">{title}</span>
        <span className="text-xs opacity-70">{kids.length}</span>
      </div>
      <div className="p-2 flex flex-wrap gap-1.5 min-h-[40px]">
        {kids.length === 0 && (
          <p className="text-xs text-gray-400 w-full text-center py-1">—</p>
        )}
        {kids.map(k => (
          <KidChip
            key={k.id}
            kid={k}
            assignedSlots={kidAssignments[k.id] ?? new Set()}
            onRemove={k.source === 'manual' ? () => onRemove(k) : undefined}
          />
        ))}
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
            {kid.weekPattern !== 'all' && (
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 font-medium shrink-0">
                {kid.weekPattern === 'odd' ? 'ímp.' : 'par.'}
              </span>
            )}
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

// ─── RunEditModal ─────────────────────────────────────────────────────────────
function RunEditModal({ run, route, removals, addressOverrides, driverOverride, availableKids, existingAdditions, unassignedKids, onSave, onClose }: {
  run: AutoRun;
  route?: OptimizedRoute | null;
  removals: string[];
  addressOverrides: Record<string, AddressOverride>;
  driverOverride: DriverOverride;
  availableKids: Array<{ sourceRunId: string; stop: AutoStop }>;
  existingAdditions: RunAdditionEntry[];
  unassignedKids: PlannerKid[];
  onSave: (opts: { removals: string[]; addressOverrides: Record<string, AddressOverride>; driverOverride: DriverOverride; needsRecalc: boolean; additions: RunAdditionEntry[] }) => void;
  onClose: () => void;
}) {
  const [localRemovals, setLocalRemovals] = useState<string[]>([...removals]);
  const [localOverrides, setLocalOverrides] = useState<Record<string, AddressOverride>>({ ...addressOverrides });
  const [offset, setOffset] = useState(driverOverride.departureOffsetMin ?? 0);
  const [order, setOrder] = useState<number[]>(
    driverOverride.waypointOrder ?? (route ? route.waypoints.map((_, i) => i) : [])
  );
  const [extraMin, setExtraMin] = useState<number[]>(
    driverOverride.waypointExtraMin ?? (route ? route.waypoints.map(() => 0) : [])
  );
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [localAdditions, setLocalAdditions] = useState<RunAdditionEntry[]>([...existingAdditions]);
  // kid-chip drag state (to merge a kid from one waypoint row into another)
  const [draggingKidId, setDraggingKidId] = useState<string | null>(null);
  const [draggingKidSourceWp, setDraggingKidSourceWp] = useState<number | null>(null);
  const [kidDropTargetWp, setKidDropTargetWp] = useState<number | null>(null);
  // kidWpOverride: kidId → original waypoint index (overrides solver assignment for display + address)
  const [kidWpOverride, setKidWpOverride] = useState<Record<string, number>>({});
  const [kidPoolOpen, setKidPoolOpen] = useState(false);
  const [manualStops, setManualStops] = useState<Array<{ id: string; type: 'pickup' | 'dropoff'; address: string; kidIds: string[] }>>([]);

  const dirLabel = run.direction === 'morning' ? '🌅 Manhã' : run.direction === 'lunch' ? '🍽 Almoço' : '🌆 Tarde';
  const isDefaultOrder = order.every((v, i) => v === i);
  const hasExtra = extraMin.some(v => v !== 0);
  const additionsDiff =
    JSON.stringify(localAdditions.map(a => a.kidId).sort()) !==
    JSON.stringify(existingAdditions.map(a => a.kidId).sort());
  const kidsChanged =
    localRemovals.length !== removals.length ||
    JSON.stringify(localOverrides) !== JSON.stringify(addressOverrides) ||
    additionsDiff ||
    Object.keys(kidWpOverride).length > 0 ||
    manualStops.some(ms => ms.kidIds.length > 0);

  // Build kid pool — unassigned kids + kids from other same-day runs, excluding already-assigned
  type PoolEntry = RunAdditionEntry;
  const assignedInModal = new Set([
    ...localAdditions.map(a => a.kidId),
    ...run.stops.map(s => s.kidId).filter(id => !localRemovals.includes(id)),
    ...manualStops.flatMap(ms => ms.kidIds),
  ]);
  const kidPool: PoolEntry[] = [
    ...availableKids
      .filter(a => !assignedInModal.has(a.stop.kidId))
      .map(a => ({ ...a.stop, sourceRunId: a.sourceRunId })),
    ...unassignedKids
      .filter(k => !assignedInModal.has(k.id))
      .map(k => {
        const slot = k.requestedSchedule.find(s => s.day === run.day) || k.requestedSchedule[0];
        return { kidId: k.id, kidName: k.name, pickupAddr: slot?.pickup || '', dropoffAddr: slot?.dropoff || '', requestedTime: parseMinutes(slot?.time || '08:00'), sourceRunId: '' };
      }),
  ];
  // Name lookup across all known kids
  const kidNameMap: Record<string, string> = {};
  for (const k of kidPool) kidNameMap[k.kidId] = k.kidName;
  for (const a of localAdditions) kidNameMap[a.kidId] = a.kidName;
  for (const s of run.stops) kidNameMap[s.kidId] = s.kidName;
  for (const k of unassignedKids) kidNameMap[k.id] = k.name;
  if (route) route.waypoints.forEach(wp => wp.kidIds.forEach((id, i) => { kidNameMap[id] = wp.kidNames[i]; }));

  function poolKidData(kidId: string): PoolEntry | undefined {
    const fromPool = kidPool.find(k => k.kidId === kidId);
    if (fromPool) return fromPool;
    const fromAvail = availableKids.find(a => a.stop.kidId === kidId);
    if (fromAvail) return { ...fromAvail.stop, sourceRunId: fromAvail.sourceRunId };
    const fromUnassigned = unassignedKids.find(k => k.id === kidId);
    if (fromUnassigned) {
      const slot = fromUnassigned.requestedSchedule.find(s => s.day === run.day) || fromUnassigned.requestedSchedule[0];
      return { kidId: fromUnassigned.id, kidName: fromUnassigned.name, pickupAddr: slot?.pickup || '', dropoffAddr: slot?.dropoff || '', requestedTime: parseMinutes(slot?.time || '08:00'), sourceRunId: '' };
    }
    return undefined;
  }

  // Address override helpers — when waypoint shared by multiple kids, apply to all
  function getWpAddress(wp: RouteWaypoint): string {
    const kidId = wp.kidIds[0];
    const ov = localOverrides[kidId];
    return (wp.type === 'pickup' ? ov?.pickup : ov?.dropoff) ?? wp.address;
  }
  function setWpAddress(wp: RouteWaypoint, value: string) {
    const field = wp.type === 'pickup' ? 'pickup' : 'dropoff';
    setLocalOverrides(prev => {
      const next = { ...prev };
      for (const kidId of wp.kidIds) next[kidId] = { ...next[kidId], [field]: value };
      return next;
    });
  }
  function updateOverride(kidId: string, field: 'pickup' | 'dropoff', value: string) {
    setLocalOverrides(prev => ({ ...prev, [kidId]: { ...prev[kidId], [field]: value } }));
  }

  function adjustExtra(i: number, delta: number) {
    setExtraMin(prev => { const a = [...prev]; a[i] = Math.max(-60, (a[i] ?? 0) + delta); return a; });
  }

  function handleDragStart(i: number) { setDragIdx(i); }
  function handleDragOver(e: React.DragEvent, i: number) {
    e.preventDefault();
    if (dragIdx === null || dragIdx === i) return;
    setOrder(prev => { const a = [...prev]; const [item] = a.splice(dragIdx, 1); a.splice(i, 0, item); return a; });
    setExtraMin(prev => { const a = [...prev]; const [item] = a.splice(dragIdx, 1); a.splice(i, 0, item); return a; });
    setDragIdx(i);
  }
  function handleDragEnd() { setDragIdx(null); }

  const displayEtas = route ? computeDisplayEtas(route, order, extraMin, offset) : [];

  function handleSave() {
    const manualAdditions: PoolEntry[] = manualStops.flatMap(ms =>
      ms.kidIds.flatMap(kidId => {
        const data = poolKidData(kidId);
        if (!data) return [];
        return [{
          ...data,
          pickupAddr: ms.type === 'pickup' ? (ms.address || data.pickupAddr) : data.pickupAddr,
          dropoffAddr: ms.type === 'dropoff' ? (ms.address || data.dropoffAddr) : data.dropoffAddr,
        }];
      })
    );
    onSave({
      removals: localRemovals,
      addressOverrides: localOverrides,
      driverOverride: {
        departureOffsetMin: offset,
        waypointOrder: isDefaultOrder ? undefined : order,
        waypointExtraMin: hasExtra ? extraMin : undefined,
      },
      needsRecalc: kidsChanged,
      additions: [...localAdditions, ...manualAdditions],
    });
  }

  // Visible stops (for no-route fallback)
  const visibleStops = run.stops.filter(s => !localRemovals.includes(s.kidId));

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-[500px] max-h-[88vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-gray-800">{dirLabel} — {DAY_PT[run.day]}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
        </div>

        {/* Departure offset strip — only when route exists */}
        {route && (
          <div className="px-5 py-2.5 bg-gray-50 border-b border-gray-100 flex items-center gap-3 text-sm">
            <span className="text-gray-500 text-xs font-medium shrink-0">Partida</span>
            <button onClick={() => setOffset(v => v - 5)} className="w-6 h-6 rounded border border-gray-200 text-gray-600 hover:bg-white font-mono text-xs leading-none">−</button>
            <span className="font-mono text-sm font-semibold w-14 text-center">
              {shiftTime(route.driverStartTime, offset)}
            </span>
            <button onClick={() => setOffset(v => v + 5)} className="w-6 h-6 rounded border border-gray-200 text-gray-600 hover:bg-white font-mono text-xs leading-none">+</button>
            {offset !== 0 && (
              <>
                <span className={`text-xs font-mono ${offset > 0 ? 'text-amber-600' : 'text-blue-600'}`}>
                  {offset > 0 ? `+${offset}` : offset}min
                </span>
                <button onClick={() => setOffset(0)} className="text-xs text-gray-400 hover:text-gray-600">reset</button>
              </>
            )}
          </div>
        )}

        {/* Main list */}
        <div className="flex-1 overflow-y-auto">
          {route ? (
            /* ── Unified waypoint list (route computed) ── */
            <div className="p-4 space-y-0">
              {order.map((wpIdx, i) => {
                const wp = route.waypoints[wpIdx];
                const extra = extraMin[i] ?? 0;
                const isPickup = wp.type === 'pickup';
                // Kids originally here (unless overridden away), plus kids overridden to come here
                const allWpKids = route.waypoints.flatMap(w => w.kidIds);
                const overriddenHere = Object.entries(kidWpOverride)
                  .filter(([, tgt]) => tgt === wpIdx)
                  .map(([id]) => id)
                  .filter(id => !wp.kidIds.includes(id));
                const visibleKidIds = [
                  ...wp.kidIds.filter(id =>
                    !localRemovals.includes(id) &&
                    (kidWpOverride[id] === undefined || kidWpOverride[id] === wpIdx)
                  ),
                  ...overriddenHere.filter(id => !localRemovals.includes(id)),
                ];
                if (visibleKidIds.length === 0) return null;
                // look up name for any kid (they might be from another waypoint)
                const kidName = (id: string) => {
                  for (const w of route.waypoints) {
                    const idx = w.kidIds.indexOf(id);
                    if (idx !== -1) return w.kidNames[idx].split(' ')[0];
                  }
                  return '?';
                };
                const isKidDropTarget = kidDropTargetWp === wpIdx;
                return (
                  <div key={`${wpIdx}-${i}`}>
                    {/* Stop row */}
                    <div
                      draggable
                      onDragStart={e => {
                        if (draggingKidId !== null) { e.preventDefault(); return; }
                        handleDragStart(i);
                      }}
                      onDragOver={e => {
                        e.preventDefault();
                        if (draggingKidId !== null) {
                          if (draggingKidSourceWp !== wpIdx) setKidDropTargetWp(wpIdx);
                        } else {
                          handleDragOver(e, i);
                        }
                      }}
                      onDragLeave={() => { if (kidDropTargetWp === wpIdx) setKidDropTargetWp(null); }}
                      onDrop={e => {
                        if (draggingKidId !== null && draggingKidSourceWp !== wpIdx) {
                          const targetAddr = getWpAddress(wp);
                          const field = isPickup ? 'pickup' : 'dropoff';
                          setLocalOverrides(prev => ({
                            ...prev,
                            [draggingKidId]: { ...prev[draggingKidId], [field]: targetAddr },
                          }));
                          setKidWpOverride(prev => ({ ...prev, [draggingKidId]: wpIdx }));
                          setKidDropTargetWp(null);
                          setDraggingKidId(null);
                          setDraggingKidSourceWp(null);
                        }
                      }}
                      onDragEnd={() => {
                        handleDragEnd();
                        setKidDropTargetWp(null);
                        setDraggingKidId(null);
                        setDraggingKidSourceWp(null);
                      }}
                      className={`rounded-lg border px-3 py-2.5 cursor-grab active:cursor-grabbing transition-colors ${
                        dragIdx === i ? 'bg-blue-50 border-blue-300' :
                        isKidDropTarget ? 'bg-green-50 border-green-400 border-dashed' :
                        'bg-gray-50 border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-gray-300 select-none text-xs shrink-0">⋮⋮</span>
                        <span className={`font-mono text-xs font-semibold shrink-0 w-11 ${isPickup ? 'text-blue-600' : 'text-orange-600'}`}>
                          {(!isDefaultOrder || hasExtra || offset !== 0) ? '~' : ''}{displayEtas[i]}
                        </span>
                        <span className={`text-xs shrink-0 ${isPickup ? 'text-blue-400' : 'text-orange-400'}`}>
                          {isPickup ? '↑' : '↓'}
                        </span>
                        {/* Kid chips — individually draggable to merge into another row */}
                        <div className="flex-1 flex flex-wrap gap-1 min-w-0">
                          {visibleKidIds.map((kidId) => (
                            <span
                              key={kidId}
                              draggable
                              onDragStart={e => {
                                e.stopPropagation();
                                setDraggingKidId(kidId);
                                setDraggingKidSourceWp(wpIdx);
                              }}
                              onDragEnd={e => {
                                e.stopPropagation();
                                setDraggingKidId(null);
                                setDraggingKidSourceWp(null);
                                setKidDropTargetWp(null);
                              }}
                              className={`inline-flex items-center gap-1 bg-white border border-gray-200 rounded-full px-2 py-0.5 text-xs text-gray-700 cursor-grab ${draggingKidId === kidId ? 'opacity-40' : ''}`}
                            >
                              {kidName(kidId)}
                              <button
                                onClick={e => { e.stopPropagation(); setLocalRemovals(prev => [...prev, kidId]); }}
                                className="text-red-300 hover:text-red-500 leading-none ml-0.5"
                              >×</button>
                            </span>
                          ))}
                          {isKidDropTarget && <span className="text-[10px] text-green-500 italic">← largar aqui</span>}
                        </div>
                      </div>
                      {/* Address input — second line */}
                      <div className="mt-2 flex items-center gap-1.5 ml-5">
                        <span className="text-gray-300 text-xs shrink-0">📍</span>
                        <input
                          type="text"
                          value={getWpAddress(wp)}
                          onChange={e => setWpAddress(wp, e.target.value)}
                          onClick={e => e.stopPropagation()}
                          onMouseDown={e => e.stopPropagation()}
                          className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white cursor-text"
                          placeholder="Morada"
                        />
                      </div>
                    </div>

                    {/* Buffer time between stops */}
                    {i < order.length - 1 && (
                      <div className="flex items-center gap-2 py-1 px-4">
                        <div className="flex-1 border-t border-dashed border-gray-200" />
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => adjustExtra(i, -5)} disabled={extra <= -60}
                            className="w-5 h-5 text-xs rounded border border-gray-200 text-gray-400 hover:text-gray-600 disabled:opacity-20 leading-none">−</button>
                          <span className={`text-xs font-mono w-14 text-center ${extra > 0 ? 'text-amber-600 font-semibold' : extra < 0 ? 'text-blue-600 font-semibold' : 'text-gray-300'}`}>
                            {extra !== 0 ? `${extra > 0 ? '+' : ''}${extra}min` : '—'}
                          </span>
                          <button onClick={() => adjustExtra(i, 5)}
                            className="w-5 h-5 text-xs rounded border border-gray-200 text-gray-400 hover:text-gray-600 leading-none">+</button>
                        </div>
                        <div className="flex-1 border-t border-dashed border-gray-200" />
                      </div>
                    )}
                  </div>
                );
              })}
              {(!isDefaultOrder || hasExtra) && (
                <div className="flex items-center justify-between pt-2">
                  <p className="text-xs text-amber-500">Os horários (~) são aproximados após ajustes.</p>
                  {!isDefaultOrder && (
                    <button onClick={() => { setOrder(route.waypoints.map((_, i) => i)); setExtraMin(route.waypoints.map(() => 0)); }}
                      className="text-xs text-gray-400 hover:text-gray-600">
                      Repor ordem
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            /* ── Fallback: per-kid cards when no route yet ── */
            <div className="p-4 space-y-3">
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
                      <label className="text-xs text-gray-500 mb-0.5 block">↑ Embarque</label>
                      <input type="text" value={localOverrides[stop.kidId]?.pickup ?? stop.pickupAddr}
                        onChange={e => updateOverride(stop.kidId, 'pickup', e.target.value)}
                        className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-0.5 block">↓ Destino</label>
                      <input type="text" value={localOverrides[stop.kidId]?.dropoff ?? stop.dropoffAddr}
                        onChange={e => updateOverride(stop.kidId, 'dropoff', e.target.value)}
                        className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pool + manual stops section — always visible */}
        <div className="border-t border-gray-100 px-4 py-3 space-y-3">

          {/* Manual stops */}
          {manualStops.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Paragens manuais</p>
              {manualStops.map(ms => (
                <div key={ms.id} className="border border-gray-200 rounded-lg p-2.5 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <select
                      value={ms.type}
                      onChange={e => setManualStops(prev => prev.map(m => m.id === ms.id ? { ...m, type: e.target.value as 'pickup' | 'dropoff' } : m))}
                      className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white shrink-0"
                    >
                      <option value="pickup">↑ Embarque</option>
                      <option value="dropoff">↓ Destino</option>
                    </select>
                    <input
                      type="text" placeholder="Morada…" value={ms.address}
                      onChange={e => setManualStops(prev => prev.map(m => m.id === ms.id ? { ...m, address: e.target.value } : m))}
                      className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                    <button onClick={() => setManualStops(prev => prev.filter(m => m.id !== ms.id))}
                      className="text-gray-400 hover:text-red-500 text-xs shrink-0">×</button>
                  </div>
                  <div className="flex flex-wrap gap-1 min-h-[26px] bg-gray-50 rounded px-1.5 py-1">
                    {ms.kidIds.length === 0
                      ? <span className="text-[10px] text-gray-300 italic self-center">Sem alunos — atribua abaixo</span>
                      : ms.kidIds.map(kidId => (
                        <span key={kidId} className="inline-flex items-center gap-1 bg-white border border-gray-200 rounded-full px-2 py-0.5 text-xs text-gray-700">
                          {(kidNameMap[kidId] ?? kidId).split(' ')[0]}
                          <button onClick={() => setManualStops(prev => prev.map(m => m.id === ms.id ? { ...m, kidIds: m.kidIds.filter(id => id !== kidId) } : m))}
                            className="text-red-300 hover:text-red-500 leading-none">×</button>
                        </span>
                      ))
                    }
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Kids added without a specific stop */}
          {localAdditions.length > 0 && (
            <div>
              <p className="text-xs font-medium text-indigo-600 mb-1.5">↔ Adicionados a este percurso</p>
              <div className="space-y-1">
                {localAdditions.map(a => (
                  <div key={a.kidId} className="flex items-center gap-2 bg-indigo-50 border border-indigo-100 rounded-lg px-2.5 py-1.5">
                    <span className="flex-1 text-xs text-gray-700 font-medium">{a.kidName}</span>
                    <span className="text-[10px] text-gray-400 truncate max-w-[90px]">{a.pickupAddr.split(',')[0]}</span>
                    <button onClick={() => setLocalAdditions(prev => prev.filter(la => la.kidId !== a.kidId))}
                      className="text-red-300 hover:text-red-500 text-xs shrink-0">×</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Kid pool header row */}
          <div className="flex items-center justify-between gap-2">
            <button onClick={() => setKidPoolOpen(v => !v)}
              className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1 min-w-0">
              <span className={`inline-block transition-transform shrink-0 ${kidPoolOpen ? 'rotate-90' : ''}`}>›</span>
              <span className="truncate">Inscrições disponíveis{kidPool.length > 0 ? ` (${kidPool.length})` : ''}</span>
            </button>
            <div className="flex gap-1 shrink-0">
              <button
                onClick={() => setManualStops(prev => [...prev, { id: Math.random().toString(36).slice(2), type: 'pickup', address: '', kidIds: [] }])}
                className="text-[10px] text-indigo-500 hover:text-indigo-700 border border-indigo-200 rounded px-1.5 py-0.5 whitespace-nowrap"
              >+ ↑ Embarque</button>
              <button
                onClick={() => setManualStops(prev => [...prev, { id: Math.random().toString(36).slice(2), type: 'dropoff', address: '', kidIds: [] }])}
                className="text-[10px] text-indigo-500 hover:text-indigo-700 border border-indigo-200 rounded px-1.5 py-0.5 whitespace-nowrap"
              >+ ↓ Destino</button>
            </div>
          </div>

          {/* Kid pool list */}
          {kidPoolOpen && (
            <div className="space-y-1">
              {kidPool.length === 0 && <p className="text-xs text-gray-400 text-center py-1">Sem inscrições disponíveis.</p>}
              {kidPool.map(k => (
                <div key={k.kidId} className="flex items-center gap-1.5 bg-gray-50 border border-gray-100 rounded-lg px-2.5 py-1.5">
                  <span className="flex-1 text-xs text-gray-700 font-medium truncate">{k.kidName}</span>
                  {k.sourceRunId
                    ? <span className="text-[10px] text-gray-400 shrink-0">← outro percurso</span>
                    : <span className="text-[10px] text-gray-400 shrink-0">sem percurso</span>
                  }
                  {/* Add to run (uses subscription address) */}
                  <button
                    onClick={() => setLocalAdditions(prev => [...prev, k])}
                    title="Adicionar ao percurso"
                    className="text-xs font-bold text-indigo-500 hover:text-indigo-700 shrink-0 px-1"
                  >+</button>
                  {/* Assign to a specific manual stop */}
                  {manualStops.map(ms => (
                    <button key={ms.id}
                      onClick={() => setManualStops(prev => prev.map(m => m.id === ms.id ? { ...m, kidIds: [...m.kidIds, k.kidId] } : m))}
                      title={`Adicionar a paragem "${ms.type === 'pickup' ? '↑' : '↓'}"`}
                      className="text-[10px] text-gray-500 hover:text-gray-800 border border-gray-200 rounded px-1 py-0.5 shrink-0"
                    >→ {ms.type === 'pickup' ? '↑' : '↓'}</button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-100 flex gap-2">
          <button onClick={handleSave}
            className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 font-medium flex-1">
            {kidsChanged ? 'Guardar e recalcular' : 'Guardar'}
          </button>
          <button onClick={onClose} className="text-sm px-4 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-600">
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── RouteCell ────────────────────────────────────────────────────────────────
function RouteCell({ run, route, loading, onOptimize, onEdit, driverOverride, locked }: {
  run: AutoRun;
  route?: OptimizedRoute | null;
  loading?: boolean;
  onOptimize: () => void;
  onEdit: () => void;
  driverOverride?: DriverOverride;
  locked?: boolean;
}) {
  const [showAddresses, setShowAddresses] = useState(false);
  const isMorning = run.direction === 'morning';
  // Morning header: show destination schools (dropoffs). Afternoon: show pickup schools.
  const uniqueDestinations = isMorning
    ? [...new Set(run.stops.map(s => s.dropoffAddr.split(',')[0]).filter(Boolean))]
    : [...new Set(run.stops.map(s => s.pickupAddr.split(',')[0]).filter(Boolean))];

  const hasDriverOverride = !!(driverOverride && (
    driverOverride.departureOffsetMin !== 0 || driverOverride.waypointOrder || driverOverride.waypointExtraMin
  ));
  const wpOrder = route
    ? (driverOverride?.waypointOrder ?? route.waypoints.map((_, i) => i))
    : [];
  const displayedWaypoints = wpOrder.map(i => route!.waypoints[i]);
  const displayedStartTime = route && driverOverride?.departureOffsetMin
    ? shiftTime(route.driverStartTime, driverOverride.departureOffsetMin)
    : route?.driverStartTime ?? '';
  const offsetMin = driverOverride?.departureOffsetMin ?? 0;
  const extraMinsCell = driverOverride?.waypointExtraMin ?? (route?.waypoints.map(() => 0) ?? []);

  const displayEtas = route ? computeDisplayEtas(route, wpOrder, extraMinsCell, offsetMin) : [];
  const hasAnyOverride = !!(driverOverride && (
    driverOverride.departureOffsetMin !== 0 || driverOverride.waypointOrder || driverOverride.waypointExtraMin
  ));
  const mapsUrl = route ? buildMapsUrl(route.driverStartAddress, route.waypoints, wpOrder) : '';

  return (
    <div className={`bg-white rounded-lg border p-2.5 text-xs ${hasDriverOverride ? 'border-blue-200' : 'border-gray-200'}`}>
      {/* Header row */}
      <div className="flex items-center gap-1 mb-2 flex-wrap">
        {uniqueDestinations.slice(0, 2).map(d => (
          <span key={d} className={`border px-1.5 py-0.5 rounded truncate max-w-[90px] ${isMorning ? 'bg-orange-50 text-orange-700 border-orange-100' : 'bg-blue-50 text-blue-700 border-blue-100'}`}>{d}</span>
        ))}
        <span className="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full shrink-0 ml-auto">
          {run.stops.length} {run.stops.length === 1 ? 'aluno' : 'alunos'}
        </span>
        {hasDriverOverride && <span className="text-xs text-blue-400" title="Ajuste motorista activo">🚗</span>}
        <button onClick={onEdit} className="text-gray-300 hover:text-blue-500 transition-colors shrink-0" title="Editar percurso">✏</button>
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
          {displayedWaypoints.map((wp, i) => {
            const dev = wp.type === 'pickup' ? wp.deviationMin : undefined;
            const devClass = dev == null ? '' : dev > 10 ? 'text-red-500' : dev > 0 ? 'text-amber-500' : 'text-green-500';
            const devLabel = dev == null ? null : dev === 0 ? null : `${dev > 0 ? '+' : ''}${dev}min`;
            const hasRideTimes = wp.type === 'dropoff' && wp.rideTimesMin && wp.rideTimesMin.length > 0;
            const multiKid = hasRideTimes && wp.kidNames.length > 1;
            return (
              <div key={i}>
                <div className="flex items-start gap-1.5">
                  <span className={`font-mono shrink-0 font-semibold ${wp.type === 'pickup' ? 'text-blue-600' : 'text-orange-600'}`}>
                    {hasAnyOverride ? '~' : ''}{displayEtas[i]}
                  </span>
                  <span className={`shrink-0 ${wp.type === 'pickup' ? 'text-blue-400' : 'text-orange-400'}`}>{wp.type === 'pickup' ? '↑' : '↓'}</span>
                  {showAddresses
                    ? <span className="text-gray-500 truncate">{wp.address.split(',')[0]}</span>
                    : multiKid
                      ? <span className="text-gray-500 truncate">{wp.kidNames.length} alunos</span>
                      : <span className="text-gray-700 truncate">{wp.kidNames.map(n => n.split(' ')[0]).join(', ')}</span>
                  }
                  {devLabel && <span className={`shrink-0 text-[10px] font-medium ml-auto ${devClass}`}>{devLabel}</span>}
                  {/* single-kid ride time stays inline */}
                  {hasRideTimes && !multiKid && (() => {
                    const rt = wp.rideTimesMin![0];
                    const cls = rt > 45 ? 'text-red-500' : rt > 30 ? 'text-amber-500' : 'text-gray-400';
                    return <span className={`shrink-0 text-[10px] font-medium ml-auto ${cls}`}>{rt}min</span>;
                  })()}
                </div>
                {/* multi-kid sub-rows: name + ride time */}
                {multiKid && !showAddresses && (
                  <div className="ml-8 mt-0.5 space-y-0.5">
                    {wp.kidNames.map((name, ki) => {
                      const rt = wp.rideTimesMin![ki];
                      const cls = rt > 45 ? 'text-red-500 font-semibold' : rt > 30 ? 'text-amber-500' : 'text-gray-400';
                      return (
                        <div key={ki} className="flex justify-between text-[10px]">
                          <span className="text-gray-600">{name.split(' ')[0]}</span>
                          <span className={cls}>{rt}min</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          <div className="text-gray-400 pt-0.5 border-t border-gray-50 flex items-center gap-2">
            <span>{fmtHours(routeWallClockMin(route, driverOverride) / 60)}{' · '}{route.totalDistanceKm}km</span>
            {mapsUrl && (
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer"
                className="ml-auto text-[10px] text-blue-400 hover:text-blue-600 underline shrink-0"
                title="Ver rota no Google Maps">
                🗺 Maps
              </a>
            )}
          </div>
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
      ) : !route && (
        <button onClick={onOptimize} disabled={loading}
          className="w-full py-1 text-indigo-500 hover:text-indigo-700 border border-indigo-100 hover:border-indigo-300 rounded bg-indigo-50 hover:bg-indigo-100 transition-colors disabled:opacity-40">
          {loading ? '…' : '🗺 Calcular rota'}
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
  // Signature of the run inputs (kids/addresses/capacity) as of the last solve for that
  // run id — lets "Recalculate All" skip runs that haven't changed instead of re-buying
  // every run's route matrix on every click (each click was costing real money: N²
  // Routes API elements per run × every run in the week, even for untouched runs).
  const lastSolvedSignatureRef = useRef<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showActiveKids, setShowActiveKids] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [locked, setLocked] = useState<boolean>(saved.locked ?? false);
  const [driverHourOverrides, setDriverHourOverrides] = useState<Record<string, number>>(saved.driverHourOverrides ?? {});
  const [driverBreakdownOpen, setDriverBreakdownOpen] = useState(false);
  const [energyBreakdownOpen, setEnergyBreakdownOpen] = useState(false);

  // Manual overrides
  const [runRemovals, setRunRemovals] = useState<Record<string, string[]>>(saved.runRemovals ?? {});
  const [runAdditions, setRunAdditions] = useState<Record<string, RunAdditionEntry[]>>(saved.runAdditions ?? {});
  const [runAddressOverrides, setRunAddressOverrides] = useState<Record<string, Record<string, AddressOverride>>>(saved.runAddressOverrides ?? {});
  const [driverOverrides, setDriverOverrides] = useState<Record<string, DriverOverride>>(saved.driverOverrides ?? {});
  const [editingRun, setEditingRun] = useState<AutoRun | null>(null);
  const [selectedWeekNum, setSelectedWeekNum] = useState<0 | 1 | 2 | 3 | 4>(0); // 0 = all

  const loadKids = async () => {
    setLoading(true);
    try {
      const [snap, childrenSnap, configSnap] = await Promise.all([
        getDocs(col('transportationSubscriptions')),
        getDocs(col('children')),
        getDoc(docRef('config', 'transportation')),
      ]);
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
          weekPattern: (x.weekPattern ?? 'all') as WeekPattern,
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
  };

  useEffect(() => { loadKids(); }, []);

  useEffect(() => {
    saveToStorage({ manualKids, cellRoutes, runRemovals, runAdditions, runAddressOverrides, driverOverrides, driverHourOverrides, locked });
  }, [manualKids, cellRoutes, runRemovals, runAdditions, runAddressOverrides, driverOverrides, driverHourOverrides, locked]);

  const weekNumPattern = selectedWeekNum === 0 ? 'all'
    : selectedWeekNum % 2 === 1 ? 'odd' : 'even';

  const allKids = useMemo(() => {
    const dbIds = new Set(dbKids.map(k => k.id));
    const all = [...dbKids, ...manualKids.filter(k => !dbIds.has(k.id))];
    if (weekNumPattern === 'all') return all;
    return all.filter(k => k.weekPattern === 'all' || k.weekPattern === weekNumPattern);
  }, [dbKids, manualKids, weekNumPattern]);

  const pendingKids = useMemo(() => dbKids.filter(k => k.status === 'pending'), [dbKids]);
  const activeKids = useMemo(() => dbKids.filter(k => k.status === 'active' &&
    (weekNumPattern === 'all' || k.weekPattern === 'all' || k.weekPattern === weekNumPattern)
  ), [dbKids, weekNumPattern]);

  const allAutoRuns = useMemo(() => {
    const result: Partial<Record<Day, AutoRun[]>> = {};
    for (const day of DAYS) result[day] = computeAutoRuns(allKids, day);
    return result;
  }, [allKids]);

  function computeRunSignature(effectiveRun: AutoRun, vanCapacity: number): string {
    return JSON.stringify({
      capacity: vanCapacity,
      direction: effectiveRun.direction,
      targetArrival: effectiveRun.targetArrival,
      stops: effectiveRun.stops.map(s => [s.kidId, s.pickupAddr, s.dropoffAddr, s.requestedTime]),
    });
  }

  function getEffectiveRun(run: AutoRun): AutoRun {
    const baseStops = run.stops
      .filter(s => !(runRemovals[run.id] ?? []).includes(s.kidId))
      .map(s => {
        const ov = runAddressOverrides[run.id]?.[s.kidId];
        return { ...s, pickupAddr: ov?.pickup ?? s.pickupAddr, dropoffAddr: ov?.dropoff ?? s.dropoffAddr };
      });
    const addedStops = (runAdditions[run.id] ?? []).map(e => {
      const ov = runAddressOverrides[run.id]?.[e.kidId];
      const s: AutoStop = { kidId: e.kidId, kidName: e.kidName, pickupAddr: ov?.pickup ?? e.pickupAddr, dropoffAddr: ov?.dropoff ?? e.dropoffAddr, requestedTime: e.requestedTime };
      return s;
    });
    return { ...run, stops: [...baseStops, ...addedStops] };
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
      lastSolvedSignatureRef.current[runId] = computeRunSignature(effectiveRun, config.vanCapacity);
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
    for (const run of allRuns) {
      const effectiveRun = getEffectiveRun(run);
      const signature = computeRunSignature(effectiveRun, config.vanCapacity);
      // Skip runs whose kids/addresses/capacity haven't changed since their last solve —
      // "Recalculate All" used to re-buy every run's route matrix unconditionally, which is
      // the actual mechanism behind a past unexpected Routes API bill.
      if (cellRoutes[run.id] !== undefined && lastSolvedSignatureRef.current[run.id] === signature) continue;
      await runOptimization(run.id, effectiveRun);
    }
  }

  function handleCombinedSave(run: AutoRun, opts: {
    removals: string[];
    addressOverrides: Record<string, AddressOverride>;
    driverOverride: DriverOverride;
    needsRecalc: boolean;
    additions: RunAdditionEntry[];
  }) {
    setRunRemovals(prev => {
      const next = { ...prev, [run.id]: opts.removals };
      const prevAdditions = runAdditions[run.id] ?? [];
      // Kids removed from additions: un-remove them from their source run (if they had one)
      for (const e of prevAdditions) {
        if (e.sourceRunId && !opts.additions.some(a => a.kidId === e.kidId)) {
          next[e.sourceRunId] = (next[e.sourceRunId] ?? []).filter(id => id !== e.kidId);
        }
      }
      // Kids newly added: remove from their source run (unassigned kids have no source run)
      for (const a of opts.additions) {
        if (a.sourceRunId && !prevAdditions.some(e => e.kidId === a.kidId)) {
          next[a.sourceRunId] = [...new Set([...(next[a.sourceRunId] ?? []), a.kidId])];
        }
      }
      return next;
    });
    setRunAdditions(prev => ({ ...prev, [run.id]: opts.additions }));
    setRunAddressOverrides(prev => ({ ...prev, [run.id]: opts.addressOverrides }));
    if (opts.driverOverride.departureOffsetMin === 0 && !opts.driverOverride.waypointOrder && !opts.driverOverride.waypointExtraMin) {
      setDriverOverrides(prev => { const { [run.id]: _, ...rest } = prev; return rest; });
    } else {
      setDriverOverrides(prev => ({ ...prev, [run.id]: opts.driverOverride }));
    }
    setEditingRun(null);
    if (opts.needsRecalc) {
      setCellRoutes(prev => ({ ...prev, [run.id]: null }));
      const baseStops = run.stops
        .filter(s => !opts.removals.includes(s.kidId))
        .map(s => { const ov = opts.addressOverrides[s.kidId]; return { ...s, pickupAddr: ov?.pickup ?? s.pickupAddr, dropoffAddr: ov?.dropoff ?? s.dropoffAddr }; });
      const addedStops: AutoStop[] = opts.additions.map(e => {
        const ov = opts.addressOverrides[e.kidId];
        return { kidId: e.kidId, kidName: e.kidName, pickupAddr: ov?.pickup ?? e.pickupAddr, dropoffAddr: ov?.dropoff ?? e.dropoffAddr, requestedTime: e.requestedTime };
      });
      runOptimization(run.id, { ...run, stops: [...baseStops, ...addedStops] });
    }
  }

  async function removeManualKid(kidId: string) {
    try { await deleteDoc(docRef('transportationSubscriptions', kidId)); } catch { /* ignore */ }
    setDbKids(prev => prev.filter(k => k.id !== kidId));
    setManualKids(prev => prev.filter(k => k.id !== kidId));
  }

  const effectiveStopCount = (run: AutoRun) =>
    run.stops.filter(s => !(runRemovals[run.id] ?? []).includes(s.kidId)).length +
    (runAdditions[run.id]?.length ?? 0);

  const allRuns = useMemo(
    () => (Object.values(allAutoRuns).flat() as AutoRun[]).filter(r => effectiveStopCount(r) > 0),
    [allAutoRuns, runRemovals]
  );

  const effectiveRunHours = (run: AutoRun): number => {
    if (driverHourOverrides[run.id] != null) return driverHourOverrides[run.id];
    const route = cellRoutes[run.id];
    if (route) return routeWallClockMin(route, driverOverrides[run.id]) / 60;
    return 0;
  };

  const { driverCost, vanCost, electricityCost, monthlyCost, monthlyRevenue, monthlyRevenueActive, monthlyDiscountTotal, monthlyProfit, monthlyProfitActive } = useMemo(() => {
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

    const periodOrder: Record<Period, number> = { morning: 0, lunch: 1, afternoon: 2 };
    const pricePerTrip = config.flatRatePerTrip;

    const calcRevenue = (kids: PlannerKid[]) => {
      const famGroups: Record<string, PlannerKid[]> = {};
      kids.forEach(kid => { const key = kid.familyId ?? kid.contactEmail; if (key) (famGroups[key] ??= []).push(kid); });
      Object.values(famGroups).forEach(g => g.sort((a, b) => a.name.localeCompare(b.name)));
      const sibRankMap: Record<string, number> = {};
      Object.values(famGroups).forEach(group => group.forEach((kid, i) => { sibRankMap[kid.id] = i + 1; }));

      let revenue = 0, revenueGross = 0;
      for (const kid of kids) {
        const siblingRank = sibRankMap[kid.id] ?? 1;
        const slotsByDay: Record<string, ScheduleSlot[]> = {};
        for (const slot of kid.requestedSchedule) (slotsByDay[slot.day] ??= []).push(slot);
        Object.values(slotsByDay).forEach(g => g.sort((a, b) => periodOrder[slotPeriod(a.time)] - periodOrder[slotPeriod(b.time)]));

        let subtotal = 0;
        for (const [, slots] of Object.entries(slotsByDay)) {
          slots.forEach((_, idx) => {
            const tripRank = idx + 1;
            let discount = 0;
            if (siblingRank >= 2) discount += config.siblingDiscountPercentage;
            if (tripRank >= config.minTripsForDiscount) discount += config.multiTripDiscountPercentage;
            discount = Math.min(1, discount);
            subtotal += pricePerTrip * (1 - discount) * config.weeksPerMonth;
            revenueGross += pricePerTrip * config.weeksPerMonth;
          });
        }
        let schoolDiscountPct = 0;
        for (const sd of (config.schoolDiscounts ?? [])) {
          if (kid.schoolName && sd.schoolName && sd.schoolName.toLowerCase() === kid.schoolName.toLowerCase()) {
            schoolDiscountPct = sd.discountPercentage;
          }
        }
        revenue += subtotal * (1 - schoolDiscountPct);
      }
      return { revenue, revenueGross };
    };

    const { revenue: monthlyRevenue, revenueGross: monthlyRevenueGross } = calcRevenue(allKids);
    const { revenue: monthlyRevenueActive } = calcRevenue(activeKids);
    const monthlyDiscountTotal = monthlyRevenueGross - monthlyRevenue;

    return { driverCost, vanCost, electricityCost, monthlyCost, monthlyRevenue, monthlyRevenueActive, monthlyRevenueGross, monthlyDiscountTotal, monthlyProfit: monthlyRevenue - monthlyCost, monthlyProfitActive: monthlyRevenueActive - monthlyCost };
  }, [allRuns, cellRoutes, config, allKids, activeKids, driverHourOverrides, runRemovals]);

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

  // Kids seated = appear in at least one effective run slot
  const seatedKidIds = useMemo(() => new Set(Object.keys(kidAssignments)), [kidAssignments]);

  // Dirty tracking: mark unsaved when routes / removals / overrides change after initial load
  const [isDirty, setIsDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState<{ id: string; savedAt: Date; seatedCount: number }[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    setIsDirty(true);
  }, [cellRoutes, runRemovals, runAdditions, runAddressOverrides, driverOverrides]);

  // Load saved versions on mount
  useEffect(() => {
    getDocs(col('transportRoutes')).then(snap => {
      const vs = snap.docs
        .map(d => ({ id: d.id, savedAt: d.data().savedAt?.toDate?.() ?? new Date(0), seatedCount: (d.data().seatedKidIds ?? []).length }))
        .sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime())
        .slice(0, 10);
      setVersions(vs);
    }).catch(() => {});
  }, []);

  const saveRouteVersion = async () => {
    setSaving(true);
    try {
      const seatedIds = [...seatedKidIds];
      const now = new Date();

      // Save version snapshot (include computed costs so summary page can read them)
      const vRef = await addDoc(col('transportRoutes'), {
        savedAt: now,
        seatedKidIds: seatedIds,
        cellRoutes: JSON.parse(JSON.stringify(cellRoutes)),
        runRemovals,
        runAddressOverrides: JSON.parse(JSON.stringify(runAddressOverrides)),
        driverOverrides: JSON.parse(JSON.stringify(driverOverrides)),
        snapshot: { driverCost, vanCost, electricityCost, monthlyCost, monthlyRevenue, monthlyRevenueActive },
      });

      // Update subscription statuses in batch
      const batch = writeBatch(db);
      for (const kid of dbKids) {
        if (kid.source === 'manual') continue;
        if (seatedKidIds.has(kid.id) && kid.status === 'pending') {
          batch.update(docRef('transportationSubscriptions', kid.id), { status: 'planned', updatedAt: now });
        } else if (!seatedKidIds.has(kid.id) && kid.status === 'planned') {
          batch.update(docRef('transportationSubscriptions', kid.id), { status: 'pending', updatedAt: now });
        }
      }
      await batch.commit();

      // Refresh local kid statuses
      setDbKids(prev => prev.map(k => {
        if (k.source === 'manual') return k;
        if (seatedKidIds.has(k.id) && k.status === 'pending') return { ...k, status: 'pending' as const };
        if (!seatedKidIds.has(k.id) && k.status === 'planned') return { ...k, status: 'pending' as const };
        return k;
      }));

      setLastSavedAt(now);
      setIsDirty(false);
      setVersions(prev => [{ id: vRef.id, savedAt: now, seatedCount: seatedIds.length }, ...prev].slice(0, 10));
    } finally {
      setSaving(false);
    }
  };

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

        let subtotal = 0;
        for (const [, slots] of Object.entries(slotsByDay)) {
          slots.forEach((_, idx) => {
            const tripRank = idx + 1;
            let discount = 0;
            if (rank >= 2) discount += cfg.siblingDiscountPercentage;
            if (tripRank >= cfg.minTripsForDiscount) discount += cfg.multiTripDiscountPercentage;
            discount = Math.min(1, discount);
            subtotal += cfg.flatRatePerTrip * (1 - discount) * cfg.weeksPerMonth;
          });
        }
        let schoolDiscountPct = 0;
        for (const sd of (cfg.schoolDiscounts ?? [])) {
          if (sub.schoolName && sd.schoolName && sd.schoolName.toLowerCase() === sub.schoolName.toLowerCase()) {
            schoolDiscountPct = sd.discountPercentage;
          }
        }
        const totalSlotFee = subtotal * (1 - schoolDiscountPct);
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

  return (
    <div className="flex flex-col h-full -m-6">
      {/* Summary bar */}
      <div className="bg-white border-b border-gray-200 px-6 pt-3 pb-3 overflow-y-auto max-h-[80vh]">
        <div className="flex items-center gap-5 flex-wrap">
          <div className="flex items-center gap-5 divide-x divide-gray-200">
            {/* Costs */}
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
            {/* Forecast — all kids */}
            <div className="pl-5">
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide">Estimado</div>
              <div className="text-lg font-bold text-indigo-600">{eur(monthlyRevenue)}</div>
              <div className={`text-xs font-semibold ${monthlyProfit >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                {monthlyProfit >= 0 ? '+' : '−'}{eur(monthlyProfit)} lucro · <span className="font-normal text-gray-400">{pendingKids.length} pend.{monthlyDiscountTotal > 0 ? ` · -${eur(monthlyDiscountTotal)} desc.` : ''}</span>
              </div>
            </div>
            {/* Reality — active kids only */}
            <div className="pl-5">
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide">Realidade</div>
              <div className="text-lg font-bold text-blue-600">{eur(monthlyRevenueActive)}</div>
              <div className={`text-xs font-semibold ${monthlyProfitActive >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                {monthlyProfitActive >= 0 ? '+' : '−'}{eur(monthlyProfitActive)} lucro · <span className="font-normal text-gray-400">{activeKids.length} ativos</span>
              </div>
            </div>
          </div>
          <div className="text-sm text-gray-500">
            <span className="font-semibold text-gray-700">{totalRunCount}</span> viagens ·{' '}
            <span className="font-semibold text-gray-700">{totalKidCount}</span> alunos
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={loadKids} disabled={loading}
              className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-600 transition-colors disabled:opacity-50">
              ↺ Recarregar
            </button>
            <button onClick={() => setSettingsOpen(true)}
              className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-600 transition-colors">
              ⚙ Definições
            </button>
            {/* Version history */}
            <div className="relative">
              <button onClick={() => setShowVersions(v => !v)}
                className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-500 transition-colors">
                🕓 {versions.length > 0 ? `v${versions.length}` : 'Versões'}
              </button>
              {showVersions && (
                <div className="absolute right-0 top-9 z-50 w-64 bg-white border border-gray-200 rounded-xl shadow-lg p-2">
                  <p className="text-xs font-semibold text-gray-500 px-2 py-1 uppercase tracking-wide">Versões guardadas</p>
                  {versions.length === 0 && <p className="text-xs text-gray-400 px-2 py-2">Nenhuma versão guardada.</p>}
                  {versions.map(v => (
                    <div key={v.id} className="px-2 py-1.5 rounded-lg hover:bg-gray-50 text-xs text-gray-600">
                      <span className="font-medium">{v.savedAt.toLocaleDateString('pt-PT')} {v.savedAt.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })}</span>
                      <span className="text-gray-400 ml-2">{v.seatedCount} com lugar</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* Dirty indicator + save */}
            {isDirty && (
              <span className="text-xs text-amber-600 font-medium flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
                Não guardado
              </span>
            )}
            {lastSavedAt && !isDirty && (
              <span className="text-xs text-green-600">
                ✓ Guardado {lastSavedAt.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            <button
              onClick={saveRouteVersion}
              disabled={saving || !isDirty}
              className="text-sm px-4 py-1.5 bg-indigo-700 text-white rounded-lg hover:bg-indigo-800 disabled:opacity-40 font-medium transition-colors"
            >
              {saving ? '…' : '💾 Guardar versão'}
            </button>
            {!locked && (
              <>
                <button
                  onClick={() => {
                    if (!window.confirm('Limpar todas as rotas calculadas e recomeçar?')) return;
                    setCellRoutes({});
                    setRunRemovals({});
                    setRunAdditions({});
                    setRunAddressOverrides({});
                    setDriverOverrides({});
                    setDriverHourOverrides({});
                  }}
                  className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-red-50 hover:border-red-200 hover:text-red-600 text-gray-500 transition-colors"
                >
                  ✕ Limpar
                </button>
                <button onClick={handleOptimizeAll} disabled={anyLoading}
                  className="text-sm px-4 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-60 font-medium">
                  {anyLoading ? '…' : '🗺 Calcular todas as rotas'}
                </button>
              </>
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
                      const fromRoute = cellRoutes[run.id] != null
                        ? routeWallClockMin(cellRoutes[run.id]!, driverOverrides[run.id]) / 60
                        : null;
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
          <div className="w-56 shrink-0 border-r border-gray-200 bg-white flex flex-col overflow-hidden">
            <div className="p-3 border-b border-gray-100 flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-700">Inscrições</span>
              <span className="text-xs text-gray-400">{allKids.length} total</span>
            </div>
            {/* Week number filter */}
            <div className="px-3 py-2 border-b border-gray-100 space-y-1">
              <button
                onClick={() => setSelectedWeekNum(0)}
                className={`text-xs px-2 py-0.5 rounded-full border transition-colors w-full ${selectedWeekNum === 0 ? 'bg-gray-700 text-white border-gray-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}
              >
                Todas as semanas
              </button>
              <div className="flex gap-1">
                {([1, 2, 3, 4] as const).map(n => (
                  <button
                    key={n}
                    onClick={() => setSelectedWeekNum(n)}
                    className={`text-xs px-2 py-0.5 rounded-full border transition-colors flex-1 ${selectedWeekNum === n ? 'bg-gray-700 text-white border-gray-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}
                  >
                    Sem. {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {loading && <p className="text-sm text-gray-400 text-center py-4">A carregar…</p>}

              {/* Seated */}
              <KidChipGroup
                title="Com lugar"
                color="green"
                kids={allKids.filter(k => seatedKidIds.has(k.id))}
                kidAssignments={kidAssignments}
                onRemove={k => { if (k.source === 'manual') removeManualKid(k.id); }}
              />

              {/* Unseated */}
              <KidChipGroup
                title="Sem lugar"
                color="amber"
                kids={allKids.filter(k => !seatedKidIds.has(k.id))}
                kidAssignments={kidAssignments}
                onRemove={k => { if (k.source === 'manual') removeManualKid(k.id); }}
              />
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
                                    driverOverride={driverOverrides[run.id]}
                                    locked={locked}
                                    onOptimize={() => handleOptimizeRun(run)}
                                    onEdit={() => setEditingRun(run)}
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

      {editingRun && (() => {
        const thisKidIds = new Set([
          ...editingRun.stops.map(s => s.kidId),
          ...(runAdditions[editingRun.id] ?? []).map(a => a.kidId),
        ]);
        const availableKidsForModal: Array<{ sourceRunId: string; stop: AutoStop }> = [];
        for (const r of (allAutoRuns[editingRun.day] ?? [])) {
          if (r.id === editingRun.id) continue;
          for (const stop of r.stops) {
            if (thisKidIds.has(stop.kidId)) continue;
            if ((runRemovals[r.id] ?? []).includes(stop.kidId)) continue;
            availableKidsForModal.push({ sourceRunId: r.id, stop });
          }
        }
        // Kids not seated in any run (the sidebar's "Sem lugar" list)
        const availableKidIdsInModal = new Set(availableKidsForModal.map(a => a.stop.kidId));
        const unassignedKidsForModal = allKids.filter(k =>
          !seatedKidIds.has(k.id) && !availableKidIdsInModal.has(k.id)
        );
        return (
          <RunEditModal
            run={editingRun}
            route={cellRoutes[editingRun.id]}
            removals={runRemovals[editingRun.id] ?? []}
            addressOverrides={runAddressOverrides[editingRun.id] ?? {}}
            driverOverride={driverOverrides[editingRun.id] ?? { departureOffsetMin: 0 }}
            availableKids={availableKidsForModal}
            existingAdditions={runAdditions[editingRun.id] ?? []}
            unassignedKids={unassignedKidsForModal}
            onSave={opts => handleCombinedSave(editingRun, opts)}
            onClose={() => setEditingRun(null)}
          />
        );
      })()}
    </div>
  );
}
