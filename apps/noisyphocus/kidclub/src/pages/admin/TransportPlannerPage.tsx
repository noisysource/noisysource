import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { getDocs, getDoc, deleteDoc } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';
import { solveRoutes, SolverKid, DEPOT_ADDRESS as SOLVER_DEPOT } from '../../lib/routeSolver';

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
  monthlyFee: number;
  requestedSchedule: ScheduleSlot[];
  notes?: string;
  status?: 'pending' | 'active';
  contactEmail?: string;
}
interface Settings {
  driverRatePerHour: number;
  vanCapacity: number;
  weeksPerMonth: number;
  vanMonthlyCost: number;
  consumptionPer100km: number;
  electricityPricePerKwh: number;
  avgKmPerRun: number;
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
}
interface SavedPlan {
  settings: Settings;
  manualKids: PlannerKid[];
  cellRoutes?: Record<string, OptimizedRoute | null>;
  runRemovals?: Record<string, string[]>;
  runAddressOverrides?: Record<string, Record<string, AddressOverride>>;
  driverOverrides?: Record<string, DriverOverride>;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const HOURS_PER_RUN = 2;
const DEFAULT_SETTINGS: Settings = {
  driverRatePerHour: 7,
  vanCapacity: 8,
  weeksPerMonth: 4.33,
  vanMonthlyCost: 200,
  consumptionPer100km: 20,
  electricityPricePerKwh: 0.22,
  avgKmPerRun: 15,
};
const LS_KEY = 'transport_planner_v7';
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
  return { settings: DEFAULT_SETTINGS, manualKids: [] };
}
function saveToStorage(p: SavedPlan) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
function eur(n: number) {
  return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
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
    deadlineMin: isMorning ? MORNING_DEADLINE_MIN : s.requestedTime + 45,
    maxRideMin: isMorning ? 60 : 45,
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
function SettingsPanel({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const set = (k: keyof Settings, v: number) => onChange({ ...settings, [k]: v });
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-3 border-t border-gray-100 mt-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-500">Motorista</span>
        <Field label="€/h" value={settings.driverRatePerHour} step={0.5} onChange={v => set('driverRatePerHour', v)} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-500">Carrinha</span>
        <Field label="lugares" value={settings.vanCapacity} step={1} onChange={v => set('vanCapacity', v)} />
        <Field label="€/mês" value={settings.vanMonthlyCost} step={10} onChange={v => set('vanMonthlyCost', v)} width="w-16" />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-500">Energia</span>
        <Field label="kWh/100km" value={settings.consumptionPer100km} step={1} onChange={v => set('consumptionPer100km', v)} />
        <Field label="€/kWh" value={settings.electricityPricePerKwh} step={0.01} onChange={v => set('electricityPricePerKwh', v)} />
        <Field label="km/viagem" value={settings.avgKmPerRun} step={1} onChange={v => set('avgKmPerRun', v)} />
      </div>
      <Field label="semanas/mês" value={settings.weeksPerMonth} step={0.01} onChange={v => set('weeksPerMonth', v)} />
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

  const dirLabel = run.direction === 'morning' ? '🌅 Manhã' : run.direction === 'lunch' ? '🍽 Almoço' : '🌆 Tarde';
  const isDefaultOrder = order.every((v, i) => v === i);

  function moveUp(i: number) {
    if (i === 0) return;
    setOrder(prev => { const a = [...prev]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; return a; });
  }
  function moveDown(i: number) {
    if (i === order.length - 1) return;
    setOrder(prev => { const a = [...prev]; [a[i], a[i + 1]] = [a[i + 1], a[i]]; return a; });
  }

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-[420px] max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
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

          {/* Stop reorder */}
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Ordem das paragens</p>
            <div className="space-y-1">
              {order.map((wpIdx, i) => {
                const wp = route.waypoints[wpIdx];
                return (
                  <div key={i} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
                    <span className={`font-mono text-xs font-semibold shrink-0 ${wp.type === 'pickup' ? 'text-blue-600' : 'text-orange-600'}`}>
                      {isDefaultOrder ? wp.eta : '~' + shiftTime(wp.eta, offset)}
                    </span>
                    <span className={`text-xs shrink-0 ${wp.type === 'pickup' ? 'text-blue-400' : 'text-orange-400'}`}>
                      {wp.type === 'pickup' ? '↑' : '↓'}
                    </span>
                    <span className="text-sm text-gray-700 flex-1 truncate">
                      {wp.kidNames.map(n => n.split(' ')[0]).join(', ')}
                    </span>
                    <div className="flex gap-0.5 shrink-0">
                      <button onClick={() => moveUp(i)} disabled={i === 0}
                        className="px-1 text-gray-300 hover:text-gray-600 disabled:opacity-20 text-sm">↑</button>
                      <button onClick={() => moveDown(i)} disabled={i === order.length - 1}
                        className="px-1 text-gray-300 hover:text-gray-600 disabled:opacity-20 text-sm">↓</button>
                    </div>
                  </div>
                );
              })}
            </div>
            {!isDefaultOrder && (
              <button onClick={() => setOrder(route.waypoints.map((_, i) => i))}
                className="text-xs text-gray-400 hover:text-gray-600 mt-2">
                Repor ordem original
              </button>
            )}
            {!isDefaultOrder && (
              <p className="text-xs text-amber-500 mt-1">Os horários (~) são aproximados após reordenação.</p>
            )}
          </div>
        </div>

        <div className="px-5 py-4 border-t border-gray-100 flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancelar</button>
          <button
            onClick={() => onSave({ departureOffsetMin: offset, waypointOrder: isDefaultOrder ? undefined : order })}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── RouteCell ────────────────────────────────────────────────────────────────
function RouteCell({ run, route, loading, onOptimize, onEdit, onDriverEdit, hasOverrides, driverOverride }: {
  run: AutoRun;
  route?: OptimizedRoute | null;
  loading?: boolean;
  onOptimize: () => void;
  onEdit: () => void;
  onDriverEdit: () => void;
  hasOverrides?: boolean;
  driverOverride?: DriverOverride;
}) {
  const [showAddresses, setShowAddresses] = useState(false);
  const isMorning = run.direction === 'morning';
  const anchorShort = run.anchor.split(',')[0];
  const uniqueDestinations = [...new Set(run.stops.map(s => s.dropoffAddr.split(',')[0]).filter(Boolean))];

  const hasDriverOverride = !!(driverOverride && (driverOverride.departureOffsetMin !== 0 || driverOverride.waypointOrder));
  const displayedWaypoints = route
    ? (driverOverride?.waypointOrder
        ? driverOverride.waypointOrder.map(i => route.waypoints[i])
        : route.waypoints)
    : [];
  const displayedStartTime = route && driverOverride?.departureOffsetMin
    ? shiftTime(route.driverStartTime, driverOverride.departureOffsetMin)
    : route?.driverStartTime ?? '';
  const offsetMin = driverOverride?.departureOffsetMin ?? 0;

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
                {driverOverride?.waypointOrder ? '~' : ''}{shiftTime(wp.eta, offsetMin)}
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

      <button onClick={onOptimize} disabled={loading}
        className="w-full py-1 text-indigo-500 hover:text-indigo-700 border border-indigo-100 hover:border-indigo-300 rounded bg-indigo-50 hover:bg-indigo-100 transition-colors disabled:opacity-40">
        {loading ? '…' : route ? '↻ Recalcular' : '🗺 Calcular rota'}
      </button>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function TransportPlannerPage() {
  const saved = useMemo(loadFromStorage, []);

  const [dbKids, setDbKids] = useState<PlannerKid[]>([]);
  const [loading, setLoading] = useState(true);
  const [pricePerTrip, setPricePerTrip] = useState(0);

  const [settings, setSettings] = useState<Settings>(saved.settings);
  const [manualKids, setManualKids] = useState<PlannerKid[]>(saved.manualKids);
  const [cellRoutes, setCellRoutes] = useState<Record<string, OptimizedRoute | null>>(saved.cellRoutes ?? {});
  const [cellLoading, setCellLoading] = useState<Record<string, boolean>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showActiveKids, setShowActiveKids] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Manual overrides
  const [runRemovals, setRunRemovals] = useState<Record<string, string[]>>(saved.runRemovals ?? {});
  const [runAddressOverrides, setRunAddressOverrides] = useState<Record<string, Record<string, AddressOverride>>>(saved.runAddressOverrides ?? {});
  const [driverOverrides, setDriverOverrides] = useState<Record<string, DriverOverride>>(saved.driverOverrides ?? {});
  const [editingRun, setEditingRun] = useState<AutoRun | null>(null);
  const [driverEditingRun, setDriverEditingRun] = useState<AutoRun | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [snap, configSnap] = await Promise.all([
          getDocs(col('transportationSubscriptions')),
          getDoc(docRef('config', 'transportation')),
        ]);
        const kids: PlannerKid[] = snap.docs.map(d => {
          const x = d.data();
          if (x.status === 'cancelled') return null;
          return {
            id: d.id, source: (x.source === 'manual' ? 'manual' : 'db') as 'manual' | 'db',
            name: x.childName || '(sem nome)', monthlyFee: x.monthlyFee ?? 0,
            requestedSchedule: parseSchedule(x.schedule || []),
            contactEmail: x.contactEmail, notes: x.note || undefined,
            status: x.status === 'confirmed' ? 'active' : x.status === 'planned' ? 'pending' : (x.status as any) || 'pending',
          };
        }).filter(Boolean) as PlannerKid[];
        setDbKids(kids);
        if (configSnap.exists()) setPricePerTrip(configSnap.data().flatRatePerTrip ?? 0);
      } catch (e) {
        console.error('Failed to load transport data', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    saveToStorage({ settings, manualKids, cellRoutes, runRemovals, runAddressOverrides, driverOverrides });
  }, [settings, manualKids, cellRoutes, runRemovals, runAddressOverrides, driverOverrides]);

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
      const result = await optimizeAutoRun(effectiveRun, settings.vanCapacity);
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
    const allRuns = (Object.values(allAutoRuns).flat() as AutoRun[]).filter(r => r.stops.length > 0);
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

  const { driverCost, vanCost, electricityCost, monthlyCost, monthlyRevenue, monthlyProfit } = useMemo(() => {
    const allRuns = (Object.values(allAutoRuns).flat() as AutoRun[]).filter(r => r.stops.length > 0);
    const driverCost = allRuns.reduce((sum, run) => {
      const hours = cellRoutes[run.id]
        ? cellRoutes[run.id]!.totalDurationMin / 60
        : HOURS_PER_RUN;
      return sum + hours * settings.driverRatePerHour;
    }, 0) * settings.weeksPerMonth;
    const vanCost = settings.vanMonthlyCost;
    const electricityCost = allRuns.reduce((sum, run) => {
      const km = cellRoutes[run.id]?.totalDistanceKm ?? settings.avgKmPerRun;
      return sum + (km / 100) * settings.consumptionPer100km * settings.electricityPricePerKwh;
    }, 0) * settings.weeksPerMonth;
    const monthlyCost = driverCost + vanCost + electricityCost;
    const monthlyRevenue = allKids.reduce((sum, kid) => sum + kid.requestedSchedule.length * pricePerTrip * settings.weeksPerMonth, 0);
    return { driverCost, vanCost, electricityCost, monthlyCost, monthlyRevenue, monthlyProfit: monthlyRevenue - monthlyCost };
  }, [allAutoRuns, cellRoutes, settings, allKids, pricePerTrip]);

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

  const totalRunCount = useMemo(() => (Object.values(allAutoRuns).flat() as AutoRun[]).filter(r => r.stops.length > 0).length, [allAutoRuns]);
  const totalKidCount = useMemo(() => {
    const ids = new Set<string>();
    (Object.values(allAutoRuns).flat() as AutoRun[]).forEach(run => run.stops.forEach(s => ids.add(s.kidId)));
    return ids.size;
  }, [allAutoRuns]);

  const anyLoading = Object.values(cellLoading).some(Boolean);
  const profitColor = monthlyProfit >= 0 ? 'text-green-600' : 'text-red-600';

  return (
    <div className="flex flex-col h-full -m-6">
      {/* Summary bar */}
      <div className="bg-white border-b border-gray-200 px-6 pt-3 pb-3">
        <div className="flex items-center gap-5 flex-wrap">
          <div className="flex items-center gap-5 divide-x divide-gray-200">
            <div>
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide">Custo mensal</div>
              <div className="text-lg font-bold text-red-600">{eur(monthlyCost)}</div>
              <div className="text-xs text-gray-400 space-x-1.5">
                <span>{eur(driverCost)} motorista</span><span>·</span>
                <span>{eur(vanCost)} van</span><span>·</span>
                <span>{eur(electricityCost)} energia</span>
              </div>
            </div>
            <div className="pl-5">
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide">Receita mensal</div>
              <div className="text-lg font-bold text-blue-600">{eur(monthlyRevenue)}</div>
              {pricePerTrip > 0 && <div className="text-xs text-gray-400">€{pricePerTrip}/viagem</div>}
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
            <button onClick={() => setSettingsOpen(v => !v)}
              className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${settingsOpen ? 'bg-gray-100 border-gray-300 text-gray-700' : 'border-gray-200 hover:bg-gray-50 text-gray-600'}`}>
              ⚙ Definições
            </button>
            <button onClick={handleOptimizeAll} disabled={anyLoading}
              className="text-sm px-4 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-60 font-medium">
              {anyLoading ? '…' : '🗺 Calcular todas as rotas'}
            </button>
          </div>
        </div>
        {settingsOpen && <SettingsPanel settings={settings} onChange={setSettings} />}
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
                        const runsForCell = (allAutoRuns[day] ?? []).filter(r => r.direction === period.id);
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
