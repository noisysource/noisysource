// Transport board (/admin/transportes): the pure part, kept apart from React so it can be tested.
// A run is one child (or group) on one weekday in one direction: a pick-up and a drop-off in one
// vehicle's lane. Times are "HH:MM" strings; the maths works in minutes since midnight.

export const RUNS_COLLECTION = 'transportRuns';

export type VehicleId = 'van' | 'car';

/** The one place vehicle seats and labels live. The car is the Model X: 6 seats, so 5 children. */
export const VEHICLES: Record<VehicleId, { label: string; seats: number }> = {
  van: { label: 'Carrinha', seats: 8 },
  car: { label: 'Model X', seats: 5 },
};
export const VEHICLE_IDS = Object.keys(VEHICLES) as VehicleId[];

export const DAYS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta'];
export const DAYS_SHORT = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex'];

/** Minutes per board row. */
export const STEP = 5;
/** Drive time assumed for a drop-off nobody has set yet. */
export const DEFAULT_DRIVE = 15;
const LAST = 23 * 60 + 55;

export interface RunBody {
  name: string;
  /** 0 = Monday … 4 = Friday. */
  day: number;
  vehicle: VehicleId;
  /** Pick-up, "HH:MM". */
  time: string;
  /** Drop-off: "HH:MM" when set by hand, "~HH:MM" or missing when it's a placeholder. */
  dropAt?: string;
  from?: string;
  to?: string;
  /** Children this run carries; 1 when missing. */
  seats?: number;
  /** Must arrive by, "HH:MM". */
  by?: string;
  note?: string;
  /** Still to agree with the family. */
  flag?: boolean;
  /** Not active in the app yet. */
  isNew?: boolean;
  /** The van driver still has to confirm they can take it. */
  vanCheck?: boolean;
}
export interface TransportRun extends RunBody { id: string }
export type Part = 'pick' | 'drop';

const pad = (n: number) => String(n).padStart(2, '0');
export const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export const toTime = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const slotOf = (t: string) => toTime(Math.floor(toMin(t) / STEP) * STEP);
const range = (a: number, b: number) => { const out: string[] = []; for (let m = a; m < b; m += STEP) out.push(toTime(m)); return out; };

/** Rows always shown: 07:00–09:10 and 14:00–18:55. A box outside them adds its own row. */
export const BASE_SLOTS = [...range(7 * 60, 9 * 60 + 15), ...range(14 * 60, 19 * 60)];

const HHMM = /^\d\d:\d\d$/;
const BODY_KEYS = ['name', 'day', 'vehicle', 'time', 'dropAt', 'from', 'to', 'seats', 'by', 'note', 'flag', 'isNew', 'vanCheck'] as const;

export function isRun(x: unknown): x is TransportRun {
  const r = x as Partial<TransportRun> | null;
  return !!r && typeof r.name === 'string' && typeof r.day === 'number' && Number.isInteger(r.day) && r.day >= 0 && r.day <= 4
    && typeof r.vehicle === 'string' && Object.hasOwn(VEHICLES, r.vehicle) && HHMM.test(r.time ?? '');
}

/** The run's own fields only: no id, no audit stamp, nothing undefined (Firestore rejects it). */
export function bodyOf(r: RunBody): RunBody {
  const out: Record<string, unknown> = {};
  for (const k of BODY_KEYS) if (r[k] !== undefined && r[k] !== null) out[k] = r[k];
  return out as unknown as RunBody;
}

/** The drop-off time, and whether it's a placeholder: empty or "~HH:MM" means nobody has set it. */
export function dropOf(r: Pick<RunBody, 'time' | 'dropAt'>): { time: string; guess: boolean } {
  const m = /^(~?)(\d\d:\d\d)$/.exec(r.dropAt ?? '');
  if (m) return { time: m[2], guess: m[1] === '~' };
  return { time: toTime(Math.min(toMin(r.time) + DEFAULT_DRIVE, LAST)), guess: true };
}
export const driveMin = (r: Pick<RunBody, 'time' | 'dropAt'>) => toMin(dropOf(r).time) - toMin(r.time);
export const seatsOf = (r: Pick<RunBody, 'seats'>) => Number(r.seats) || 1;
const sumSeats = (rs: RunBody[]) => rs.reduce((n, r) => n + seatsOf(r), 0);

/** Children on board at minute t: picked up at or before t, not dropped off yet. */
export function seatsAt(lane: RunBody[], t: number): number {
  return sumSeats(lane.filter(r => toMin(r.time) <= t && t < toMin(dropOf(r).time)));
}

/** Children on board at any point of the row starting at `start`, for the lane's on-board strip. */
export function seatsDuring(lane: RunBody[], start: number): number {
  return sumSeats(lane.filter(r => toMin(r.time) < start + STEP && toMin(dropOf(r).time) >= start));
}

/** The most children on board right after any of these pick-ups. Seats only go up at a pick-up. */
export function peakAfterPickups(lane: RunBody[], pickups: string[]): number {
  return Math.max(0, ...pickups.map(t => seatsAt(lane, toMin(t))));
}

export function warnings(r: RunBody, part: Part): string[] {
  const out: string[] = [];
  if (part === 'pick' && r.vanCheck && r.vehicle === 'van') out.push('Motorista da carrinha a confirmar');
  if (part === 'drop' && r.by && dropOf(r).time > r.by) out.push(`Depois do limite das ${r.by}`);
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

export type MoveResult = { body: RunBody; message: string } | { error: string } | null;

/**
 * What dropping one box on a row does. A pick-up takes its drop-off with it, keeping the drive time.
 * A drop-off moves alone, changing the drive time. Another day or vehicle takes the whole run.
 * Dropping a placeholder drop-off on its own row sets it. null = nothing changes.
 */
export function moveBox(r: TransportRun, part: Part, day: number, vehicle: VehicleId, slot: string): MoveResult {
  const sameLane = r.day === day && r.vehicle === vehicle;
  const body: RunBody = { ...bodyOf(r), day, vehicle };
  const drop = dropOf(r);
  const lane = `${VEHICLES[vehicle].label}, ${DAYS[day]}`;
  if (part === 'pick') {
    const time = slotOf(r.time) === slot ? r.time : slot;
    if (sameLane && time === r.time) return null;
    body.time = time;
    if (r.dropAt) body.dropAt = `${drop.guess ? '~' : ''}${toTime(Math.min(toMin(drop.time) + toMin(time) - toMin(r.time), LAST))}`;
    return { body, message: `Recolha de ${r.name} passou para as ${time} (${lane}). A entrega foi junto.` };
  }
  const time = slotOf(drop.time) === slot ? drop.time : slot;
  if (toMin(time) <= toMin(r.time)) return { error: `A entrega tem de ser depois da recolha das ${r.time}.` };
  if (sameLane && time === drop.time && !drop.guess) return null;
  body.dropAt = time;
  return { body, message: `Entrega de ${r.name} passou para as ${time} (${lane}): ${toMin(time) - toMin(r.time)} min de viagem.` };
}
