// Transport board (/admin/transportes): the pure part, kept apart from React so it can be tested.
// A run is one child (or group) on one weekday in one direction: a pick-up and a drop-off in one
// vehicle's lane. Times are "HH:MM" strings; the maths works in minutes since midnight.
//
// Runs come from two places. Each leg of an active or pending transport subscription is a run: who,
// which day, where from and to and the requested time come from the subscription. The board only
// stores its plan for that leg (vehicle, planned pick-up, drop-off, notes) in `transportRuns`, keyed
// by subscription, day and leg. A planning-only run (a child the app doesn't know yet) is stored
// whole in the same collection, with no subscription.

import type { WeekPattern } from '@shared/models/weekPattern';

export const RUNS_COLLECTION = 'transportRuns';

export type VehicleId = 'van' | 'car';

/** The one place vehicle seats and labels live. The car is the Model X: 6 seats, so 5 children. */
export const VEHICLES: Record<VehicleId, { label: string; seats: number }> = {
  van: { label: 'Carrinha', seats: 8 },
  car: { label: 'Model X', seats: 5 },
};
export const VEHICLE_IDS = Object.keys(VEHICLES) as VehicleId[];
/** Where a subscription leg goes until someone plans it. */
export const DEFAULT_VEHICLE: VehicleId = 'van';

export const DAYS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta'];
export const DAYS_SHORT = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex'];
const DAY_INDEX: Record<string, number> = { monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4 };

/** Minutes per board row. */
export const STEP = 5;
/** Drive time assumed for a drop-off nobody has set yet. */
export const DEFAULT_DRIVE = 15;
const LAST = 23 * 60 + 55;

export interface TransportRun {
  id: string;
  /** 'sub': a leg of a transport subscription. 'plan': only on the board, no subscription yet. */
  source: 'sub' | 'plan';
  name: string;
  /** 0 = Monday … 4 = Friday. */
  day: number;
  vehicle: VehicleId;
  /** Pick-up, "HH:MM": the planned time, which can differ from the one the family asked for. */
  time: string;
  /** Drop-off: "HH:MM" when set by hand, "~HH:MM" or missing when it's a placeholder. */
  dropAt?: string;
  from?: string;
  to?: string;
  /** Children this run carries; 1 when missing. A subscription leg is always one child. */
  seats?: number;
  /** Must arrive by, "HH:MM". */
  by?: string;
  note?: string;
  /** Still to agree with the family. */
  flag?: boolean;
  /** The van driver still has to confirm they can take it. */
  vanCheck?: boolean;
  // Subscription legs only:
  subId?: string;
  /** Position of this leg among the subscription's legs that day, by requested time. */
  leg?: number;
  status?: 'active' | 'pending';
  /** The pick-up time on the subscription. */
  requested?: string;
  weekPattern?: WeekPattern;
  /** Set when the subscription starts later than today. */
  startDate?: string;
}
export type Part = 'pick' | 'drop';

/** What the page passes in for each transport subscription (status already normalised). */
export interface SubInput {
  id: string;
  status: 'active' | 'pending' | 'cancelled';
  childName?: string;
  weekPattern?: WeekPattern;
  startDate?: string;
  endDate?: string;
  schedule?: { dayOfWeek?: string; pickupTime?: string; pickupLocation?: string; dropoffLocation?: string }[];
}
/** A `transportRuns` document as stored. */
export type StoredRun = Record<string, unknown>;

const pad = (n: number) => String(n).padStart(2, '0');
export const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export const toTime = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const slotOf = (t: string) => toTime(Math.floor(toMin(t) / STEP) * STEP);
const range = (a: number, b: number) => { const out: string[] = []; for (let m = a; m < b; m += STEP) out.push(toTime(m)); return out; };

/** Rows always shown: 07:00–09:10 and 14:00–18:55. A box outside them adds its own row. */
export const BASE_SLOTS = [...range(7 * 60, 9 * 60 + 15), ...range(14 * 60, 19 * 60)];

const HHMM = /^\d\d:\d\d$/;
const DROP = /^~?\d\d:\d\d$/;
const isTime = (v: unknown): v is string => typeof v === 'string' && HHMM.test(v);
const isVehicle = (v: unknown): v is VehicleId => typeof v === 'string' && Object.hasOwn(VEHICLES, v);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
/** Drops undefined, null and false, which Firestore either rejects or doesn't need. */
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== false)) as T;

/** First part of an address: "Colégio Bissaya Barreto, Rua dos Plátanos, Coimbra" → "Colégio Bissaya Barreto". */
export const shortPlace = (s?: string) => (s ?? '').split(',')[0].trim();
export const legId = (subId: string, day: number, leg: number) => `${subId}_${day}_${leg}`;

/** The plan fields the board keeps for any run. */
function planOf(p: StoredRun) {
  return {
    dropAt: typeof p.dropAt === 'string' && DROP.test(p.dropAt) ? p.dropAt : undefined,
    by: isTime(p.by) ? p.by : undefined,
    note: str(p.note),
    flag: p.flag === true,
    vanCheck: p.vanCheck === true,
  };
}

/**
 * Every run on the board: each leg of each active or pending subscription that hasn't ended, with
 * the board's plan for it, plus the planning-only runs. A plan whose leg no longer exists (the
 * subscription was cancelled or its schedule changed) is ignored.
 */
export function buildRuns(subs: SubInput[], stored: Map<string, StoredRun>, today: string): TransportRun[] {
  const out: TransportRun[] = [];
  for (const s of subs) {
    if (s.status === 'cancelled' || (s.endDate && s.endDate < today)) continue;
    const byDay = new Map<number, { time: string; from?: string; to?: string }[]>();
    for (const leg of s.schedule ?? []) {
      const day = DAY_INDEX[(leg.dayOfWeek ?? '').toLowerCase()];
      if (day === undefined || !isTime(leg.pickupTime)) continue;
      const list = byDay.get(day) ?? [];
      list.push({ time: leg.pickupTime, from: leg.pickupLocation, to: leg.dropoffLocation });
      byDay.set(day, list);
    }
    for (const [day, legs] of byDay) {
      legs.sort((a, b) => a.time.localeCompare(b.time));
      legs.forEach((leg, n) => {
        const id = legId(s.id, day, n);
        const p = stored.get(id) ?? {};
        out.push(clean({
          id, source: 'sub' as const, subId: s.id, leg: n, status: s.status === 'pending' ? 'pending' as const : 'active' as const,
          name: s.childName?.trim() || '—', day,
          vehicle: isVehicle(p.vehicle) ? p.vehicle : DEFAULT_VEHICLE,
          time: isTime(p.time) ? p.time : leg.time, requested: leg.time,
          from: shortPlace(leg.from) || undefined, to: shortPlace(leg.to) || undefined,
          ...planOf(p),
          weekPattern: s.weekPattern && s.weekPattern !== 'all' ? s.weekPattern : undefined,
          startDate: s.startDate && s.startDate > today ? s.startDate : undefined,
        }));
      });
    }
  }
  for (const [id, p] of stored) {
    if (p.subId !== undefined) continue;
    const day = p.day;
    if (typeof p.name !== 'string' || !p.name.trim() || typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 4
      || !isVehicle(p.vehicle) || !isTime(p.time)) continue;
    out.push(clean({
      id, source: 'plan' as const, name: p.name, day, vehicle: p.vehicle, time: p.time,
      from: str(p.from), to: str(p.to), seats: Number(p.seats) > 1 ? Math.min(8, Number(p.seats)) : undefined,
      ...planOf(p),
    }));
  }
  return out;
}

/**
 * The document to store for a run. For a subscription leg, only the plan: who, where and the
 * requested time stay on the subscription, and the planned pick-up only when it differs.
 */
export function storedOf(r: TransportRun): StoredRun {
  const plan = { vehicle: r.vehicle, dropAt: r.dropAt, by: r.by, note: r.note, flag: r.flag, vanCheck: r.vanCheck };
  return r.source === 'sub'
    ? clean({ subId: r.subId, leg: r.leg, day: r.day, ...plan, time: r.time !== r.requested ? r.time : undefined })
    : clean({ name: r.name, day: r.day, time: r.time, from: r.from, to: r.to, seats: r.seats, ...plan });
}

/** Pending subscriptions and planning-only runs: what "Destacar novos" brings forward. */
export const isNewRun = (r: TransportRun) => r.source === 'plan' || r.status === 'pending';

/** The drop-off time, and whether it's a placeholder: empty or "~HH:MM" means nobody has set it. */
export function dropOf(r: Pick<TransportRun, 'time' | 'dropAt'>): { time: string; guess: boolean } {
  const m = /^(~?)(\d\d:\d\d)$/.exec(r.dropAt ?? '');
  if (m) return { time: m[2], guess: m[1] === '~' };
  return { time: toTime(Math.min(toMin(r.time) + DEFAULT_DRIVE, LAST)), guess: true };
}
export const seatsOf = (r: Pick<TransportRun, 'seats'>) => Number(r.seats) || 1;
const sumSeats = (rs: TransportRun[]) => rs.reduce((n, r) => n + seatsOf(r), 0);

/** Children on board at minute t: picked up at or before t, not dropped off yet. */
export function seatsAt(lane: TransportRun[], t: number): number {
  return sumSeats(lane.filter(r => toMin(r.time) <= t && t < toMin(dropOf(r).time)));
}

/** Children on board at any point of the row starting at `start`, for the lane's on-board strip. */
export function seatsDuring(lane: TransportRun[], start: number): number {
  return sumSeats(lane.filter(r => toMin(r.time) < start + STEP && toMin(dropOf(r).time) >= start));
}

/** The most children on board right after any of these pick-ups. Seats only go up at a pick-up. */
export function peakAfterPickups(lane: TransportRun[], pickups: string[]): number {
  return Math.max(0, ...pickups.map(t => seatsAt(lane, toMin(t))));
}

export function warnings(r: TransportRun, part: Part): string[] {
  const out: string[] = [];
  if (part === 'pick' && r.vanCheck && r.vehicle === 'van') out.push('Motorista da carrinha a confirmar');
  if (part === 'drop' && r.by && dropOf(r).time > r.by) out.push(`Depois do limite das ${r.by}`);
  return out;
}

/** Facts from the subscription worth seeing on the pick-up box. */
export function legNotes(r: TransportRun): string[] {
  const out: string[] = [];
  if (r.requested && r.requested !== r.time) out.push(`Pedido às ${r.requested}`);
  if (r.weekPattern === 'odd') out.push('1.ª e 3.ª semanas do mês');
  if (r.weekPattern === 'even') out.push('2.ª e 4.ª semanas do mês');
  if (r.startDate) out.push(`Começa a ${r.startDate.slice(8, 10)}/${r.startDate.slice(5, 7)}`);
  return out;
}

export interface Box { run: TransportRun; part: Part; time: string }
export interface Grid {
  /** Boxes by day, vehicle and row. */
  cells: Map<string, Box[]>;
  /** Runs by day and vehicle. */
  lanes: Map<string, TransportRun[]>;
  slots: string[];
}
export const cellKey = (day: number, vehicle: VehicleId, slot: string) => `${day}|${vehicle}|${slot}`;
export const laneKey = (day: number, vehicle: VehicleId) => `${day}|${vehicle}`;

export function buildGrid(runs: TransportRun[]): Grid {
  const cells = new Map<string, Box[]>();
  const lanes = new Map<string, TransportRun[]>();
  const put = <T,>(map: Map<string, T[]>, k: string, v: T) => { const list = map.get(k); if (list) list.push(v); else map.set(k, [v]); };
  const used = new Set<string>();
  for (const run of runs) {
    const drop = dropOf(run).time;
    put(cells, cellKey(run.day, run.vehicle, slotOf(run.time)), { run, part: 'pick', time: run.time });
    put(cells, cellKey(run.day, run.vehicle, slotOf(drop)), { run, part: 'drop', time: drop });
    put(lanes, laneKey(run.day, run.vehicle), run);
    used.add(slotOf(run.time));
    used.add(slotOf(drop));
  }
  // Within a row: by time, a vehicle unloads before it loads, then by name.
  for (const list of cells.values()) {
    list.sort((a, b) => a.time.localeCompare(b.time)
      || (a.part === b.part ? 0 : a.part === 'drop' ? -1 : 1)
      || a.run.name.localeCompare(b.run.name));
  }
  return { cells, lanes, slots: [...new Set([...BASE_SLOTS, ...used])].sort() };
}

export type MoveResult = { run: TransportRun; message: string } | { error: string } | null;

/**
 * What dropping one box on a row does. A pick-up takes its drop-off with it, keeping the drive time.
 * A drop-off moves alone, changing the drive time. Another vehicle takes the whole run; so does
 * another day, for a planning-only run (a subscription leg's day comes from the subscription).
 * Dropping a placeholder drop-off on its own row sets it. null = nothing changes.
 */
export function moveBox(r: TransportRun, part: Part, day: number, vehicle: VehicleId, slot: string): MoveResult {
  if (r.source === 'sub' && day !== r.day) return { error: `O dia de ${r.name} vem da inscrição. Para o mudar, altere a inscrição.` };
  const sameLane = r.day === day && r.vehicle === vehicle;
  const next: TransportRun = { ...r, day, vehicle };
  const drop = dropOf(r);
  const lane = `${VEHICLES[vehicle].label}, ${DAYS[day]}`;
  if (part === 'pick') {
    const time = slotOf(r.time) === slot ? r.time : slot;
    if (sameLane && time === r.time) return null;
    next.time = time;
    if (r.dropAt) next.dropAt = `${drop.guess ? '~' : ''}${toTime(Math.min(toMin(drop.time) + toMin(time) - toMin(r.time), LAST))}`;
    return { run: next, message: `Recolha de ${r.name} passou para as ${time} (${lane}). A entrega foi junto.` };
  }
  const time = slotOf(drop.time) === slot ? drop.time : slot;
  if (toMin(time) <= toMin(r.time)) return { error: `A entrega tem de ser depois da recolha das ${r.time}.` };
  if (sameLane && time === drop.time && !drop.guess) return null;
  next.dropAt = time;
  return { run: next, message: `Entrega de ${r.name} passou para as ${time} (${lane}): ${toMin(time) - toMin(r.time)} min de viagem.` };
}
