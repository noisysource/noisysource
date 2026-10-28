/**
 * Climate history, to work out how this house cools and warms up (Renato,
 * 2026-10-28: "use the intervals to see how long the floor holds temperature,
 * and how long it takes to reach the desired temperature, both night and
 * day"): `domotics_climate/{yyyy-mm-dd}`, one document per Lisbon day.
 *
 * - `q00`…: one field per 15-minute slot, the same slots as `domotics_energy`
 *   (energy.ts), so a slot's kWh and its temperatures line up. Each room's
 *   temperature (last, lowest, highest), its thermostat's target and how much
 *   of the slot its valve was open; the pump's on and compressor shares, its
 *   Hz, water out/in, setpoint and outdoor sensor; the battery; what the
 *   automation and the E13 guard were doing.
 * - `x_HHMMSS_…`: a person's intervention, with the rooms at that moment. The
 *   pump switched on by hand says the house felt cold; off, warm enough. A
 *   thermostat target changed from the app or at the thermostat says which way
 *   and by how much. The automation's and the guard's own switches are already
 *   in `domotics_incidents` and say nothing about comfort, so they are not
 *   here; neither are its own target changes. The controller's nightly timer
 *   is recorded, as such (`by: 'timer'`), so it isn't read as a person.
 *
 * Pure, like energy.ts: fed one reading per poll, it hands back fields to
 * write; climate-store.ts does the writing.
 */

import { dayStart, lisbonOffsetMs, slotField, slotOf, slotsInDay } from './energy';
import type { SwitchSource } from './incidents';

const MIN = 60_000;
/** A thermostat target this long after our command, at that value, is taken to be that command. */
const COMMAND_MATCH_MS = 15 * MIN;

/**
 * The heat pump controller's own timer table switches it off at 23:54 UTC every
 * night (seen since 2026-10-24, through the clock change). An outside off in
 * those minutes is that timer, not a person.
 */
export function isControllerTimer(t: number) {
  const d = new Date(t);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 23 * 60 + 53 && m <= 23 * 60 + 56;
}

export interface ClimateReading {
  t: number;
  zones: Array<{ id: string; name: string; online: boolean; current?: number; target?: number; valveOpen: boolean }>;
  pump?: {
    online: boolean; on: boolean; fault: boolean;
    hz?: number; waterOut?: number; waterIn?: number; flowSetpoint?: number; outdoor?: number;
  };
  soc?: number;
  /** What the automation is doing: its mode, or 'off'; with ' (sim)' in dry-run. */
  plan?: string;
  wantOn?: boolean;
  /** The E13 guard's mode. */
  guard?: string;
  /** Who switched the pump, when this reading shows it switched (incidents.ts). */
  switchedBy?: SwitchSource;
}

/** One 15-minute slot. °C, shares 0–1. */
export interface ClimateSlot {
  /** Readings in the slot (one a poll, ~30 s; thermostats are read every ~5 min, carried between). */
  n: number;
  /** By thermostat id: temperature at the slot's last reading, lowest, highest; target; share of readings with the valve open. */
  z: Record<string, { t: number; lo: number; hi: number; s?: number; v: number }>;
  /** Pump readings (it can be offline: a breaker cycle). */
  pn: number;
  /** Shares of pump readings switched on, and with the compressor running. */
  on: number;
  run: number;
  /** Compressor: mean Hz while it ran, and the top. */
  hz?: number;
  hzMax?: number;
  /** Water out and back in at the last reading, the top water out, the setpoint, outside (the pump's sensor). */
  out?: number;
  inn?: number;
  outMax?: number;
  sp?: number;
  ext?: number;
  fault?: boolean;
  soc?: number;
  plan?: string;
  want?: boolean;
  guard?: string;
}

export interface ClimateEvent {
  /** ms since the epoch, and Lisbon's clock. */
  at: number;
  time: string;
  kind: 'pump' | 'target';
  by: 'app' | 'outside' | 'timer';
  /** What it says about comfort: on → 'cold', off → 'warm-enough', a target up/down → 'warmer'/'cooler'; the timer → 'none'. */
  meaning: 'cold' | 'warm-enough' | 'warmer' | 'cooler' | 'none';
  on?: boolean;
  zone?: string;
  zoneName?: string;
  from?: number;
  to?: number;
  /** The rooms at that moment (thermostat id → °C), their mean, outside, the automation, the pump. */
  rooms: Record<string, number>;
  mean: number | null;
  ext: number | null;
  plan: string | null;
  pumpOn: boolean | null;
}

interface Acc {
  date: string;
  index: number;
  n: number;
  z: Record<string, { t: number; lo: number; hi: number; s?: number; n: number; open: number }>;
  pn: number;
  on: number;
  run: number;
  hzSum: number;
  hzMax: number;
  fault: boolean;
  out?: number;
  inn?: number;
  outMax?: number;
  sp?: number;
  ext?: number;
  soc?: number;
  plan?: string;
  want?: boolean;
  guard?: string;
}

/** What survives a restart. */
export interface ClimateSnapshot {
  open: Acc | null;
  /** Fields waiting to be written, by document id. */
  pending: Record<string, Record<string, unknown>>;
  /** Each thermostat's last target seen, to notice a change. */
  targets: Record<string, number>;
  /** Thermostat names, written with each day so a document reads on its own. */
  names: Record<string, string>;
}

export const INITIAL_CLIMATE: ClimateSnapshot = { open: null, pending: {}, targets: {}, names: {} };

/** Writes not yet confirmed are kept this long, then dropped (as energy.ts). */
const PENDING_DAYS = 14;

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
/** Lisbon's wall clock, HH:MM:SS. */
const lisbonTime = (t: number) => new Date(t + lisbonOffsetMs(t)).toISOString().slice(11, 19);

function newAcc(date: string, index: number): Acc {
  return { date, index, n: 0, z: {}, pn: 0, on: 0, run: 0, hzSum: 0, hzMax: 0, fault: false };
}

function closeAcc(a: Acc): ClimateSlot {
  const z: ClimateSlot['z'] = {};
  for (const [id, x] of Object.entries(a.z)) {
    z[id] = { t: x.t, lo: x.lo, hi: x.hi, v: r2(x.open / x.n), ...(x.s !== undefined ? { s: x.s } : {}) };
  }
  const slot: ClimateSlot = { n: a.n, z, pn: a.pn, on: a.pn ? r2(a.on / a.pn) : 0, run: a.pn ? r2(a.run / a.pn) : 0 };
  if (a.run > 0) { slot.hz = Math.round(a.hzSum / a.run); slot.hzMax = a.hzMax; }
  for (const k of ['out', 'inn', 'outMax', 'sp', 'ext', 'soc', 'plan', 'want', 'guard'] as const) {
    if (a[k] !== undefined) (slot as unknown as Record<string, unknown>)[k] = a[k];
  }
  if (a.fault) slot.fault = true;
  return slot;
}

export function createClimateRecorder(initial?: ClimateSnapshot) {
  const s: ClimateSnapshot = structuredClone(initial ?? INITIAL_CLIMATE);
  s.pending ??= {};
  s.targets ??= {};
  s.names ??= {};
  /** The bridge's own target commands, to tell them from a person's. Not kept across restarts. */
  const commands: Array<{ zone: string; value: number; by: SwitchSource; t: number }> = [];

  function queue(date: string, field: string, value: unknown) {
    (s.pending[date] ??= {})[field] = value;
    const days = Object.keys(s.pending).sort();
    while (days.length > PENDING_DAYS) delete s.pending[days.shift()!];
  }

  function closeOpen() {
    const o = s.open;
    if (!o) return;
    if (o.n > 0) queue(o.date, slotField(o.index), closeAcc(o));
    s.open = null;
  }

  function event(r: ClimateReading, e: Omit<ClimateEvent, 'at' | 'time' | 'rooms' | 'mean' | 'ext' | 'plan' | 'pumpOn'>) {
    const rooms: Record<string, number> = {};
    for (const z of r.zones) if (z.online && z.current !== undefined) rooms[z.id] = z.current;
    const temps = Object.values(rooms);
    const doc: ClimateEvent = {
      at: r.t,
      time: lisbonTime(r.t),
      ...e,
      rooms,
      mean: temps.length ? r1(temps.reduce((a, b) => a + b, 0) / temps.length) : null,
      ext: r.pump?.outdoor ?? null,
      plan: r.plan ?? null,
      pumpOn: r.pump?.online ? r.pump.on : null,
    };
    const { date } = slotOf(r.t);
    queue(date, `x_${doc.time.replace(/:/g, '')}_${e.kind === 'pump' ? 'pump' : e.zone}`, doc);
    return doc;
  }

  return {
    /** One poll. Returns the interventions it recorded (for the log). */
    observe(r: ClimateReading): ClimateEvent[] {
      const { date, index } = slotOf(r.t);
      if (s.open && (s.open.date !== date || s.open.index !== index)) closeOpen();
      const a = (s.open ??= newAcc(date, index));
      a.n++;
      for (const z of r.zones) {
        s.names[z.id] = z.name;
        if (!z.online || z.current === undefined) continue;
        const x = a.z[z.id];
        if (!x) a.z[z.id] = { t: z.current, lo: z.current, hi: z.current, s: z.target, n: 1, open: z.valveOpen ? 1 : 0 };
        else {
          x.t = z.current;
          x.lo = Math.min(x.lo, z.current);
          x.hi = Math.max(x.hi, z.current);
          if (z.target !== undefined) x.s = z.target;
          x.n++;
          if (z.valveOpen) x.open++;
        }
      }
      const p = r.pump;
      if (p?.online) {
        a.pn++;
        if (p.on) a.on++;
        const hz = p.hz ?? 0;
        if (p.on && hz > 0) { a.run++; a.hzSum += hz; a.hzMax = Math.max(a.hzMax, hz); }
        if (p.fault) a.fault = true;
        if (p.waterOut !== undefined) { a.out = p.waterOut; a.outMax = Math.max(a.outMax ?? -Infinity, p.waterOut); }
        if (p.waterIn !== undefined) a.inn = p.waterIn;
        if (p.flowSetpoint !== undefined) a.sp = p.flowSetpoint;
        if (p.outdoor !== undefined) a.ext = p.outdoor;
      }
      if (r.soc !== undefined) a.soc = Math.round(r.soc);
      if (r.plan !== undefined) a.plan = r.plan;
      if (r.wantOn !== undefined) a.want = r.wantOn;
      if (r.guard !== undefined) a.guard = r.guard;

      const out: ClimateEvent[] = [];
      // --- The pump, switched by a person (or the controller's timer) -------
      if (p?.online && (r.switchedBy === 'app' || r.switchedBy === 'outside')) {
        const timer = r.switchedBy === 'outside' && !p.on && isControllerTimer(r.t);
        out.push(event(r, {
          kind: 'pump',
          by: timer ? 'timer' : r.switchedBy,
          meaning: timer ? 'none' : p.on ? 'cold' : 'warm-enough',
          on: p.on,
        }));
      }
      // --- A thermostat target that changed, not by the automation ---------
      for (const z of r.zones) {
        if (!z.online || z.target === undefined) continue;
        const prev = s.targets[z.id];
        s.targets[z.id] = z.target;
        if (prev === undefined || Math.abs(z.target - prev) < 0.25) continue;
        const i = commands.findIndex(c => c.zone === z.id && Math.abs(c.value - z.target!) < 0.25 && c.t <= r.t && r.t - c.t <= COMMAND_MATCH_MS);
        const cmd = i >= 0 ? commands.splice(i, 1)[0] : undefined;
        if (cmd && cmd.by !== 'app') continue;
        out.push(event(r, {
          kind: 'target',
          by: cmd ? 'app' : 'outside',
          meaning: z.target > prev ? 'warmer' : 'cooler',
          zone: z.id,
          zoneName: z.name,
          from: prev,
          to: z.target,
        }));
      }
      return out;
    },
    /** Every thermostat target the bridge sends, °C, with who asked. */
    noteTarget(zone: string, value: number, by: SwitchSource, t: number) {
      commands.push({ zone, value, by, t });
      while (commands.length > 20) commands.shift();
    },
    pendingCount: () => Object.values(s.pending).reduce((n, p) => n + Object.keys(p).length, 0),
    /** Documents to write: id → fields (waiting slots and events, plus the day's metadata). */
    pendingWrites(): Array<{ id: string; fields: Record<string, unknown> }> {
      return Object.entries(s.pending).map(([date, fields]) => ({
        id: date,
        fields: { ...fields, date, start: new Date(dayStart(date)), slots: slotsInDay(date), zones: { ...s.names }, v: 1 },
      }));
    },
    /** A write landed: only the fields it carried are dropped. */
    written(id: string, fields: Record<string, unknown>) {
      const p = s.pending[id];
      if (!p) return;
      for (const k of Object.keys(fields)) if (p[k] === fields[k]) delete p[k];
      if (Object.keys(p).length === 0) delete s.pending[id];
    },
    snapshot: (): ClimateSnapshot => s,
  };
}
