/**
 * Heating automation: a warm floor every evening and night, and daytime heating
 * only on spare sun. Design and Renato's decisions (reworked 2026-10-26):
 * apps/noisysource/domotics/HANDOFF-heating-automation.md.
 *
 * The house is underfloor heating on a heavy slab, fed by one air-to-water
 * heat pump (floor heating only; hot water is a separate unit) that draws
 * ~3.3 kW while its compressor runs, six zone thermostats opening and closing
 * the valves, solar panels and a battery. Every day, in Lisbon time:
 * - WARM WINDOW (19:00–09:00 by default): the pump runs whenever a zone wants
 *   heat, and the thermostats hold the rooms at the comfort temperature (24).
 *   It starts early enough to be warm at 19:00 (the "warm-up"), from how this
 *   house is seen to warm up (warmby.ts: floor ~90 min, rooms ~0.3 °C/h).
 * - DAY (09:00 to the warm-up): the pump is OFF, unless there is spare sun
 *   (battery ≥ 90 % and the panels covering the house plus the pump, or power
 *   going out to the grid) or the rooms' mean falls below the day minimum
 *   (21). The battery comes first: a house a little colder by day is fine.
 * - Live, the automation OWNS on/off, whoever switched the pump: an off in the
 *   warm window (the controller's nightly 23:54 UTC timer, the panel,
 *   SmartLife, a person) is undone after the minimum off time, and an on
 *   outside the plan by day is undone after the minimum on time. A person
 *   stops it with the app's "Pausar" (`pauseUntil`): until then nothing
 *   switches the pump on by itself, and a live automation switches it off.
 * - The E13 guard (guard.ts) comes first: its rests and a lockout are never
 *   overridden; while it rests, the automation asks it (`holdRest`) to carry
 *   on whenever the plan has the pump off.
 *
 * Kept from before (the cold morning of 20/10 and the E13 trips of 21–24/10):
 * - the water temperature follows the pump's own outdoor sensor, with a
 *   correction while the rooms stay short, the top of the range while they
 *   are well below target (recovery) or warming up, never lowered while they
 *   are short, and never raised while the compressor idles at the setpoint;
 * - a water setpoint or a zone changed by hand is left alone until the plan
 *   moves from day to warm or back;
 * - at the setpoint with the compressor at its minimum the pump is switched
 *   off to rest rather than idle there (by the guard when it is on);
 * - a one-off "warm by HH:MM" request (warmby.ts) heats regardless of the
 *   time of day.
 *
 * Off and in dry-run by default. Every decision carries its reason, and the
 * status travels with the bridge state so the app can show what is happening.
 * All clock times are Lisbon's, computed by hand (energy.ts), so neither the
 * Pi's time zone nor the clock change can move them.
 *
 * This file decides; `index.ts` sends. Decisions are kept free of I/O so they
 * can be reasoned about (and tested) without a house attached.
 */

import { GRACE_MS, IDLE_HZ, NEAR_SETPOINT } from './guard';
import { lisbonDate, lisbonOffsetMs } from './energy';
import {
  createWarmupLearner, leadMinutes, parseModel, planWarmBy, WARM_HOLD_MS, WARM_MARGIN_MIN,
  type WarmByRequest, type WarmByStatus, type WarmupModel,
} from './warmby';

export interface AutomationConfig {
  /** Master switch. Off: nothing is evaluated or sent. */
  enabled: boolean;
  /** Decide and log, but send nothing to the devices. */
  dryRun: boolean;
  /**
   * A person's pause, set from the app ("Pausar"): until then nothing switches
   * the pump on by itself (neither this nor the guard), and a live automation
   * switches it off. ms since the epoch; null = not paused.
   */
  pauseUntil: number | null;
  /** The room temperature, written to the thermostats, °C. */
  comfort: number;
  /** The warm window, Lisbon time: warm floor from `from` to `to` (may cross midnight). */
  warm: { from: string; to: string };
  /** By day, the rooms' mean below this → heat whatever the sun, °C. */
  dayMin: number;
  /** By day, heat on spare sun only. */
  solar: {
    enabled: boolean;
    /** Battery at least this full, %. */
    socOn: number;
    /** What the pump draws while its compressor runs, W (measured 26/10: ~3.3 kW). */
    pumpW: number;
    /** Or at least this much going out to the grid, W. */
    exportW: number;
  };
  /** Water temperature from the outdoor temperature: at15 + (15 − outdoor) × slope. */
  flow: { enabled: boolean; at15: number; slope: number; min: number; max: number };
  /** Rooms well below target: water at the top of the range until they reach it. */
  recovery: { enabled: boolean };
  /** At the setpoint with the compressor at its minimum: switch off and rest, rather than idle there. */
  rest: { enabled: boolean; minutes: number };
  /**
   * In the warm window, switch the pump off once every zone valve has been
   * closed for a while (and on when one opens). The minimum on/off times hold
   * for every switch the automation makes.
   */
  pumpFollowsZones: { enabled: boolean; idleMin: number; minOnMin: number; minOffMin: number };
  /** Hard limits on room targets, whatever else is configured. */
  limits: { roomMin: number; roomMax: number };
}

export const DEFAULT_CONFIG: AutomationConfig = {
  enabled: false,
  dryRun: true,
  pauseUntil: null,
  comfort: 24,
  warm: { from: '19:00', to: '09:00' },
  dayMin: 21,
  solar: { enabled: true, socOn: 90, pumpW: 3300, exportW: 500 },
  flow: { enabled: true, at15: 30, slope: 0.8, min: 28, max: 45 },
  recovery: { enabled: true },
  rest: { enabled: true, minutes: 60 },
  pumpFollowsZones: { enabled: true, idleMin: 20, minOnMin: 30, minOffMin: 15 },
  limits: { roomMin: 21, roomMax: 25 },
};

/** Absolute bounds no configuration can cross. */
const HARD = { roomMin: 18, roomMax: 26, flowMin: 25, flowMax: 45 };

const num = (v: unknown, fallback: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const hhmm = (v: unknown, fallback: string) =>
  typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : fallback;
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
/** A Firestore timestamp arrives as a Date, the app writes ms, the disk cache holds ms. */
const instant = (v: unknown) =>
  v instanceof Date ? v.getTime() : typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

/** Whatever is stored, a configuration that is complete and inside the hard bounds. */
export function parseConfig(raw: unknown): AutomationConfig {
  const r = obj(raw);
  const d = DEFAULT_CONFIG;
  const wm = obj(r.warm);
  const so = obj(r.solar);
  const fl = obj(r.flow);
  const rc = obj(r.recovery);
  const rs = obj(r.rest);
  const pz = obj(r.pumpFollowsZones);
  const li = obj(r.limits);
  const roomMin = num(li.roomMin, d.limits.roomMin, HARD.roomMin, HARD.roomMax);
  const roomMax = num(li.roomMax, d.limits.roomMax, roomMin, HARD.roomMax);
  const comfort = num(r.comfort, d.comfort, roomMin, roomMax);
  // Whole degrees: the pump's setpoint is an integer.
  const flowMin = Math.round(num(fl.min, d.flow.min, HARD.flowMin, HARD.flowMax));
  let from = hhmm(wm.from, d.warm.from);
  let to = hhmm(wm.to, d.warm.to);
  // An empty window would mean never warm: not something to take from a typo.
  if (from === to) { from = d.warm.from; to = d.warm.to; }
  return {
    enabled: bool(r.enabled, d.enabled),
    dryRun: bool(r.dryRun, d.dryRun),
    pauseUntil: instant(r.pauseUntil),
    comfort,
    warm: { from, to },
    dayMin: num(r.dayMin, d.dayMin, 16, comfort),
    solar: {
      enabled: bool(so.enabled, d.solar.enabled),
      socOn: num(so.socOn, d.solar.socOn, 50, 100),
      pumpW: num(so.pumpW, d.solar.pumpW, 500, 10_000),
      exportW: num(so.exportW, d.solar.exportW, 100, 10_000),
    },
    flow: {
      enabled: bool(fl.enabled, d.flow.enabled),
      at15: num(fl.at15, d.flow.at15, HARD.flowMin, HARD.flowMax),
      slope: num(fl.slope, d.flow.slope, 0, 3),
      min: flowMin,
      max: Math.round(num(fl.max, d.flow.max, flowMin, HARD.flowMax)),
    },
    recovery: { enabled: bool(rc.enabled, d.recovery.enabled) },
    rest: { enabled: bool(rs.enabled, d.rest.enabled), minutes: num(rs.minutes, d.rest.minutes, 15, 240) },
    pumpFollowsZones: {
      enabled: bool(pz.enabled, d.pumpFollowsZones.enabled),
      idleMin: num(pz.idleMin, d.pumpFollowsZones.idleMin, 5, 240),
      minOnMin: num(pz.minOnMin, d.pumpFollowsZones.minOnMin, 10, 240),
      minOffMin: num(pz.minOffMin, d.pumpFollowsZones.minOffMin, 5, 240),
    },
    limits: { roomMin, roomMax },
  };
}

/** The pause in force at `t`, if any (ms it ends). */
export function pausedUntil(cfg: AutomationConfig, t: number): number | null {
  return cfg.pauseUntil !== null && t < cfg.pauseUntil ? cfg.pauseUntil : null;
}

// ---------------------------------------------------------------------------
// Lisbon clock
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const minutesOf = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
/** Minutes since Lisbon midnight at instant `t`. */
export function lisbonMinute(t: number) {
  const d = new Date(t + lisbonOffsetMs(t));
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
/** "HH:MM" in Lisbon, whatever the machine's time zone. */
export function lisbonClock(t: number) {
  return new Date(t + lisbonOffsetMs(t)).toISOString().slice(11, 16);
}
/**
 * The instant Lisbon's wall clock reads `time` on `date`. The clocks change at
 * 01:00 UTC, so the offset is taken where the guess lands; 09:00 and 19:00 are
 * never near the change.
 */
export function lisbonAt(date: string, time: string): number {
  const wall = Date.parse(`${date}T${time}:00Z`);
  return wall - lisbonOffsetMs(wall - lisbonOffsetMs(wall));
}
const nextDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
/** The next time (strictly after `t`) Lisbon's clock reads `time`. */
export function nextLisbon(t: number, time: string): number {
  const today = lisbonDate(t);
  const x = lisbonAt(today, time);
  return x > t ? x : lisbonAt(nextDate(today), time);
}
/** Whether a minute of the day falls in [from, to), windows crossing midnight included. */
function within(m: number, from: string, to: string) {
  const a = minutesOf(from);
  const b = minutesOf(to);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}
export function inWarmWindow(cfg: AutomationConfig, t: number) {
  return within(lisbonMinute(t), cfg.warm.from, cfg.warm.to);
}

/** Room targets go in half degrees: the thermostats step in 0.5. */
const half = (v: number) => Math.round(v * 2) / 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function flowFor(cfg: AutomationConfig, outdoor: number, correction: number) {
  return Math.round(clamp(cfg.flow.at15 + (15 - outdoor) * cfg.flow.slope + correction, cfg.flow.min, cfg.flow.max));
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ZoneReading {
  id: string;
  name: string;
  online: boolean;
  /** °C */
  current?: number;
  /** °C */
  target?: number;
  /** The thermostat's own program; the automation leaves 'auto' zones alone. */
  mode?: string;
  valveOpen: boolean;
}

export interface PumpReading {
  id: string;
  online: boolean;
  on: boolean;
  fault: boolean;
  /** The pump's own outdoor sensor, °C. */
  outdoor?: number;
  /** Current heating water setpoint, °C. */
  flowSetpoint?: number;
  /** Compressor, Hz. */
  hz?: number;
  /** Water out / back in, °C. */
  waterOut?: number;
  waterIn?: number;
}

/**
 * The inverter, in the bridge's signs (index.ts maps `state.inverter`, checked
 * against the power balance on 26/10).
 */
export interface EnergyReading {
  /** Both strings, W. */
  pvW?: number;
  /** The whole house, the pump included, W. */
  loadW?: number;
  /** > 0 exporting, < 0 importing, W. */
  gridW?: number;
  /** > 0 charging, < 0 discharging, W. */
  batteryW?: number;
  soc?: number;
}

/** What the E13 guard is doing (guard.ts), as far as the automation needs to know. */
export interface GuardView {
  enabled: boolean;
  mode: 'off' | 'watch' | 'rest' | 'lockout';
  restUntil: number | null;
}

// ---------------------------------------------------------------------------
// Spare sun
// ---------------------------------------------------------------------------

/** Spare sun has to last this long before the pump is switched on for it… */
const SOLAR_START_MS = 10 * MIN;
/** …and be gone this long before it is switched off again. */
const SOLAR_STOP_MS = 15 * MIN;
/** Running on sun, it carries on down to this many points below the battery threshold. */
const SOC_HYST = 5;
/** Running on sun, it carries on while the panels still cover this share of the pump. */
const KEEP_SHARE = 0.5;
/** Running on sun, buying this much from the grid stops it (the battery isn't covering). */
const IMPORT_STOP_W = 500;
/** The house never draws less than this (night baseline 0.2–0.3 kW, 26/10). */
const BASELINE_W = 200;

export interface SolarView {
  /** Heating on sun now (after the hysteresis). */
  on: boolean;
  soc: number | null;
  /** Panels minus the house without the pump, W; null without inverter readings. */
  spareW: number | null;
  /** In Portuguese, for the app. */
  note: string;
}

/**
 * What the sun leaves after the house, the pump's own draw taken out of the
 * house while it runs: otherwise switching the pump on would make the surplus
 * vanish and it would switch itself off again.
 */
export function spareSun(cfg: AutomationConfig, e: EnergyReading | undefined, pumpRunning: boolean): number | null {
  if (!e || e.pvW === undefined || e.loadW === undefined) return null;
  const house = Math.max(BASELINE_W, e.loadW - (pumpRunning ? cfg.solar.pumpW : 0));
  return e.pvW - house;
}

const kw = (w: number) => `${(w / 1000).toFixed(1).replace('.', ',')} kW`;

// ---------------------------------------------------------------------------
// The runner: memory between ticks, rate limits, and what gets sent
// ---------------------------------------------------------------------------

export interface AutomationAction {
  at: number;
  device: string;
  what: string;
  /** False in dry-run: decided, not sent. */
  sent: boolean;
  error?: string;
}

/** 'warm' = the warm window; 'warmup' = heating towards it; 'day' = sun only. */
export type PlanMode = 'warm' | 'warmup' | 'day';

export interface WarmPlan {
  from: string;
  to: string;
  /** Inside the warm window now. */
  inWindow: boolean;
  /** The next start of the warm window (19:00), ms. */
  nextStart: number;
  /** When the current window ends, or the next one does (09:00), ms. */
  end: number;
  /** When the warm-up for the next start begins (or began), ms; null inside the window. */
  warmupAt: number | null;
  warmupStarted: boolean;
  /** Minutes of heating it plans, margin included, and whether that was capped. */
  leadMin: number;
  capped: boolean;
  /** How far below the comfort temperature the rooms are, on average (rooms above it count as 0), °C. */
  need: number;
  /** When the rooms should be warm, if after the start (late). */
  expectedAt: number | null;
}

export interface AutomationStatus {
  enabled: boolean;
  dryRun: boolean;
  state: 'off' | 'running' | 'dry-run';
  /** The person's pause in force, ms it ends; null = not paused. */
  pausedUntil: number | null;
  /** The four settings the app shows on top. */
  settings: { warmFrom: string; warmTo: string; comfort: number; dayMin: number; socOn: number };
  mode?: PlanMode;
  /** The plan wants the pump on now. */
  wantOn?: boolean;
  /** What it is doing now and why, one sentence, for the app. */
  doing?: string;
  /** Today's plan in plain words, for the app. */
  plan?: string;
  warm?: WarmPlan;
  solar?: SolarView;
  /** By day: the rooms' mean is below the day minimum (after the hysteresis). */
  dayMinActive?: boolean;
  /** The rooms' mean, °C. */
  meanRoom?: number;
  roomTarget?: number;
  outdoor?: number;
  flowTarget?: number;
  flowCorrection?: number;
  /** The water setpoint was changed by hand: left alone until the plan moves from day to warm or back. */
  flowManual?: boolean;
  /** Rooms well below target: water at the top of the range. */
  recovery?: boolean;
  /** How far below their thermostats' targets the rooms are, on average (rooms above target count as 0), °C. */
  shortfall?: number;
  /** Set when the pump is left alone (fault, offline). */
  pumpHold?: string;
  /** Live only: asks the E13 guard to keep its rest going, since the plan has the pump off. */
  holdRest?: boolean;
  /** The automation's own rest at the setpoint (guard off), until when. */
  restUntil?: number;
  /** Switch-ons the automation sent in the last 24 h (it stops at MAX_ONS_PER_DAY). */
  switchOns24h?: number;
  warmBy?: WarmByStatus | null;
  /** How the house is seen to warm up (warmby.ts). */
  model?: WarmupModel;
  zones: Array<{ id: string; name: string; note: string }>;
  reasons: string[];
  /** Newest first. */
  actions: AutomationAction[];
  evaluatedAt: number;
}

/** What the automation keeps across bridge restarts (index.ts saves it). */
export interface AutomationMemory {
  model: WarmupModel;
  /** The last water setpoint it sent, so after a restart it still knows that value was its own. */
  flow: { value: number; at: number } | null;
  /** The evening warm-up in progress: which warm start it is for, and when it started. */
  warmup?: { at: number; started: boolean; startedAt?: number } | null;
  /** Its own switch-ons in the last 24 h. */
  ons?: number[];
}

export type Send = (
  deviceId: string,
  commands: Array<{ code: string; value: number | boolean }>,
  /** Why, for the incident record of a pump switch. */
  reason?: string,
) => Promise<void>;

const ZONE_EVERY = 10 * MIN;
/** Raising the water: as soon as it is due, at most this often. */
const FLOW_EVERY = 15 * MIN;
/** Lowering it: a degree at a time, this far apart. */
const FLOW_DOWN_EVERY = 30 * MIN;
/** Rooms short of target this long → water +1 °C; at target this long → −1 °C. */
const CORRECTION_UP_AFTER = 30 * MIN;
const CORRECTION_DOWN_AFTER = 60 * MIN;
const CORRECTION_MAX = 4;
/** The rooms' mean shortfall that starts recovery, and the one that ends it. */
const RECOVERY_ON = 0.5;
const RECOVERY_OFF = 0.2;
/** Below target by more than this on average: the water is not lowered. */
const SHORT = 0.2;
/** Back this far above the day minimum before heating for it stops. */
const DAY_MIN_HYST = 0.5;
/**
 * The warm-up never starts earlier than this before the warm window: a bad
 * model or a broken sensor must not run the pump on grid power all day. The
 * day minimum covers a really cold house.
 */
export const MAX_WARMUP_LEAD_MIN = 6 * 60;
/**
 * Its own switch-ons, rolling 24 h. Something switching the pump off again and
 * again (a broken controller, a person who should use Pausar) is not fought
 * past this: the compressor's starts are finite.
 */
export const MAX_ONS_PER_DAY = 12;
const KEEP_ACTIONS = 12;

const fmt = (v: number) => `${v.toFixed(1).replace(/\.0$/, '')}°C`;
const deg = (v: number) => `${v.toFixed(1).replace(/\.0$/, '').replace('.', ',')}°`;
const clock = lisbonClock;

export function createAutomation(send: Send, memory?: Partial<AutomationMemory>) {
  /** What we last asked of each device (sent, or decided in dry-run). */
  const last = new Map<string, { value: number | boolean; at: number; period: string; dry: boolean; confirmed: boolean }>();
  /** Zones changed by hand: left alone until the plan moves from day to warm or back. */
  const manual = new Map<string, string>();
  let correction = 0;
  let deficitSince: number | null = null;
  let satisfiedSince: number | null = null;
  let allClosedSince: number | null = null;
  let pumpSeen: { on: boolean; since: number } | null = null;
  let recovery = false;
  /** The pump's water setpoint at the previous reading, and the period it was changed by hand in. */
  let lastSeenSp: number | undefined;
  let flowManualIn: string | null = null;
  let ownFlow = memory?.flow ?? null;
  /** The automation's own rest at the setpoint (live, guard off), and when it ends. */
  let ownRest: number | null = null;
  /** The warm-by request being worked on. */
  let warm: { at: number; started: boolean; outcome: { mean: number; reached: boolean } | null } | null = null;
  /** The evening warm-up, kept across restarts so a started one doesn't go back to waiting. */
  let warmup: { at: number; started: boolean; startedAt?: number } | null = memory?.warmup ?? null;
  /** Heating on sun, and since when the condition to change that has held. */
  let solarOn = false;
  let solarSince: number | null = null;
  let dayMinOn = false;
  /** What the plan wanted of the pump at the previous tick. */
  let lastWantOn: boolean | null = null;
  /** Counts the plan's moves between day and warm: zones and water changed by hand are kept until the next one. */
  let segment = 0;
  let lastSegment: 'warm' | 'day' | null = null;
  let ons: number[] = Array.isArray(memory?.ons) ? memory!.ons!.filter(x => typeof x === 'number') : [];
  const learner = createWarmupLearner(parseModel(memory?.model));
  let actions: AutomationAction[] = [];

  /**
   * Send (or, in dry-run, only record) one decision. `key` is what the rate
   * limit and the hand-change check are kept under: the zone id, or the pump's
   * id plus which of its settings.
   */
  async function act(
    key: string, deviceId: string, name: string, what: string,
    commands: Array<{ code: string; value: number | boolean }>,
    value: number | boolean, period: string, dry: boolean, now: number,
  ) {
    const entry: AutomationAction = { at: now, device: name, what, sent: !dry };
    if (!dry) {
      try {
        await send(deviceId, commands, what);
      } catch (err) {
        entry.sent = false;
        entry.error = (err as Error).message;
      }
    }
    // A failed send still counts for the rate limit: a sleepy valve head is not
    // retried every poll.
    last.set(key, { value, at: now, period, dry, confirmed: false });
    actions = [entry, ...actions].slice(0, KEEP_ACTIONS);
    return entry;
  }

  let memo: AutomationMemory = { model: learner.model(), flow: ownFlow, warmup, ons };

  async function tick(
    cfg: AutomationConfig,
    input: {
      now: Date;
      zones: ZoneReading[];
      pump?: PumpReading;
      energy?: EnergyReading;
      guard?: GuardView;
      warmBy?: WarmByRequest | null;
    },
  ): Promise<AutomationStatus> {
    const t = input.now.getTime();
    const p = input.pump;
    const g = input.guard;
    const guardOn = !!g?.enabled;
    const guardResting = guardOn && g!.mode === 'rest';
    const paused = pausedUntil(cfg, t);
    ons = ons.filter(x => t - x < DAY);

    // How far below target the rooms are, measured against what each zone is
    // actually asking for (a zone set by hand or on its own program has its
    // own setpoint, not the house target). A room above target doesn't make up
    // for a cold one.
    const reporting = input.zones.filter(z => z.online);
    const known = reporting
      .filter(z => z.current !== undefined && z.target !== undefined)
      .map(z => ({ id: z.id, name: z.name, current: z.current as number, target: z.target as number }));
    const shortOf = (z: { current: number; target: number }) => Math.max(0, z.target - z.current);
    const shortfall = known.length ? known.reduce((a, z) => a + shortOf(z), 0) / known.length : 0;
    const meanRoom = known.length ? known.reduce((a, z) => a + z.current, 0) / known.length : undefined;
    // Too few thermostats answering to decide that nothing wants heat (on 22–25/10 only one or two did).
    const quorum = reporting.length > 0 && reporting.length * 2 >= input.zones.length;
    const pumpRunning = !!p && p.online && p.on && !p.fault && (p.hz ?? 0) > 0;

    // How the house warms up, learned from what it does whatever the automation is set to.
    learner.observe({
      t,
      running: pumpRunning,
      waterIn: p?.waterIn,
      zones: known,
      // Off is "available" only while it is parked for a rest: off by the plan
      // (daytime) says nothing about how fast the house warms.
      available: !!p && p.online && !p.fault && (p.on || guardResting || (ownRest !== null && t < ownRest)),
    });
    const model = learner.model();

    // --- Warm by HH:MM (one-off request) -----------------------------------
    const request = input.warmBy && t < input.warmBy.at + WARM_HOLD_MS ? input.warmBy : null;
    if (!request) warm = null;
    else if (warm?.at !== request.at) warm = { at: request.at, started: false, outcome: null };
    let warmBy: WarmByStatus | null = null;
    if (request && warm) {
      const target = clamp(half(request.target ?? cfg.comfort), cfg.limits.roomMin, cfg.limits.roomMax);
      if (t >= request.at && !warm.outcome && meanRoom !== undefined) {
        warm.outcome = { mean: Math.round(meanRoom * 10) / 10, reached: meanRoom >= target - 0.3 };
      }
      warmBy = planWarmBy({
        request, now: t, target, current: meanRoom, floorWarmInMin: learner.floorWarmIn(t),
        model, started: warm.started, outcome: warm.outcome,
      });
      if (warmBy.phase === 'heating') warm.started = true;
    }

    const settings = { warmFrom: cfg.warm.from, warmTo: cfg.warm.to, comfort: cfg.comfort, dayMin: cfg.dayMin, socOn: cfg.solar.socOn };
    const save = () => { memo = { model, flow: ownFlow, warmup, ons }; };
    const base = { enabled: cfg.enabled, dryRun: cfg.dryRun, pausedUntil: paused, settings, actions, evaluatedAt: t, model, warmBy };
    if (!cfg.enabled) {
      recovery = false;
      solarOn = false;
      solarSince = null;
      dayMinOn = false;
      if (warmBy) warmBy = { ...warmBy, note: `A automação está desligada: o pedido fica guardado mas não aquece. ${warmBy.note}` };
      save();
      return { ...base, warmBy, state: 'off', zones: [], reasons: ['Automação desligada.'] };
    }
    const dry = cfg.dryRun;
    const reasons: string[] = [];
    const comfort = clamp(half(cfg.comfort), cfg.limits.roomMin, cfg.limits.roomMax);

    // --- The plan: warm window, the warm-up before it, or day ---------------
    const inWindow = inWarmWindow(cfg, t);
    const nextStart = nextLisbon(t, cfg.warm.from);
    const end = nextLisbon(t, cfg.warm.to);
    // How far below the comfort temperature the rooms are (rooms above it count as 0).
    const need = known.length ? known.reduce((a, z) => a + Math.max(0, comfort - z.current), 0) / known.length : 1;
    let plan: WarmPlan;
    const needR = Math.round(need * 10) / 10;
    if (inWindow) {
      warmup = null;
      plan = { from: cfg.warm.from, to: cfg.warm.to, inWindow, nextStart, end, warmupAt: null, warmupStarted: false, leadMin: 0, capped: false, need: needR, expectedAt: null };
    } else {
      if (warmup?.at !== nextStart) warmup = { at: nextStart, started: false };
      const full = leadMinutes(need, learner.floorWarmIn(t), model);
      const lead = Math.min(MAX_WARMUP_LEAD_MIN, full);
      let startAt = nextStart - lead * MIN;
      if (lead > 0 && t >= startAt && !warmup.started) warmup = { ...warmup, started: true, startedAt: t };
      // Once started, the start is when it started (the plan itself moves later as the rooms warm).
      if (warmup.started && warmup.startedAt) startAt = warmup.startedAt;
      // From the start, it takes the full lead less the margin; later than the window start is late.
      const expected = warmup.started
        ? Math.max(t, startAt) + Math.max(0, full - WARM_MARGIN_MIN) * MIN
        : startAt + Math.max(0, full - WARM_MARGIN_MIN) * MIN;
      plan = {
        from: cfg.warm.from, to: cfg.warm.to, inWindow, nextStart, end,
        warmupAt: lead > 0 || warmup.started ? startAt : null, warmupStarted: warmup.started, leadMin: lead, capped: full > lead,
        need: needR, expectedAt: lead > 0 && expected > nextStart ? expected : null,
      };
    }
    const mode: PlanMode = inWindow ? 'warm' : warmup?.started ? 'warmup' : 'day';
    const warmByActive = !!warmBy && (warmBy.phase === 'heating' || warmBy.phase === 'holding');
    /** The pump follows the zones (warm window, warm-up, a warm-by request); otherwise, day rules. */
    const heating = mode !== 'day' || warmByActive;
    const seg = heating ? 'warm' : 'day';
    if (seg !== lastSegment) { segment++; lastSegment = seg; }
    const periodKey = `seg${segment}`;

    const warmTarget = warmByActive ? warmBy!.target : undefined;
    const target = warmTarget !== undefined && warmTarget > comfort ? warmTarget : comfort;
    if (target !== comfort) reasons.push(`Alvo das divisões ${fmt(target)} (pedido para as ${clock(warmBy!.at)}).`);
    /** Heating towards the requested time, with the rooms still short of it. */
    const warmByDrive = warmBy?.phase === 'heating' && (warmBy.current === null || warmBy.target - warmBy.current > 0.1);

    // --- Recovery ----------------------------------------------------------
    if (!cfg.recovery.enabled || known.length === 0) recovery = false;
    else if (!recovery && shortfall > RECOVERY_ON) recovery = true;
    else if (recovery && shortfall <= RECOVERY_OFF) recovery = false;
    if (recovery) {
      const coldest = [...known].sort((a, b) => shortOf(b) - shortOf(a)).slice(0, 2)
        .map(z => `${z.name} ${fmt(z.current)} para ${fmt(z.target)}`).join(', ');
      reasons.push(`Recuperação: divisões em média ${fmt(shortfall)} abaixo do alvo (${coldest}) — água no máximo enquanto a bomba trabalhar.`);
    }
    /** The water at the top of the range: recovering, warming up, or heating for a requested time. */
    const waterDrive = recovery || warmByDrive || (mode === 'warmup' && need > 0.1);

    // --- Spare sun and the day minimum ---------------------------------------
    const e = input.energy;
    const spareW = spareSun(cfg, e, pumpRunning);
    const soc = e?.soc;
    const gridW = e?.gridW ?? 0;
    let solarNote: string;
    if (mode !== 'day' || !cfg.solar.enabled) {
      solarOn = false;
      solarSince = null;
      solarNote = !cfg.solar.enabled ? 'aquecer com o sol está desligado' : '';
    } else {
      const startOk = soc !== undefined && soc >= cfg.solar.socOn && spareW !== null
        && (spareW >= cfg.solar.pumpW || gridW >= cfg.solar.exportW);
      const keepOk = soc !== undefined && soc >= cfg.solar.socOn - SOC_HYST && spareW !== null
        && spareW >= cfg.solar.pumpW * KEEP_SHARE && gridW > -IMPORT_STOP_W;
      if (!solarOn) {
        solarSince = startOk ? (solarSince ?? t) : null;
        if (solarSince !== null && t - solarSince >= SOLAR_START_MS) { solarOn = true; solarSince = null; }
      } else {
        solarSince = keepOk ? null : (solarSince ?? t);
        if (solarSince !== null && t - solarSince >= SOLAR_STOP_MS) { solarOn = false; solarSince = null; }
      }
      const socTxt = soc !== undefined ? `bateria ${Math.round(soc)} %` : 'bateria sem leitura';
      const spareTxt = spareW !== null ? `sobra ${kw(Math.max(0, spareW))} de sol` : 'sem leitura do inversor';
      solarNote = solarOn
        ? (solarSince !== null ? `sol a acabar (${socTxt}, ${spareTxt}) — desliga se durar 15 min` : `${socTxt}, ${spareTxt}`)
        : solarSince !== null ? `sol a chegar (${socTxt}, ${spareTxt}) — liga se durar 10 min`
        : `${socTxt}, ${spareTxt} (precisa de ${Math.round(cfg.solar.socOn)} % e ${kw(cfg.solar.pumpW)})`;
    }
    const solar: SolarView = { on: solarOn, soc: soc ?? null, spareW, note: solarNote };
    if (mode !== 'day' || meanRoom === undefined || !quorum) dayMinOn = false;
    else if (!dayMinOn && meanRoom < cfg.dayMin) dayMinOn = true;
    else if (dayMinOn && meanRoom >= cfg.dayMin + DAY_MIN_HYST) dayMinOn = false;

    // --- Zones -------------------------------------------------------------
    const zones: AutomationStatus['zones'] = [];
    for (const z of input.zones) {
      const prev = last.get(z.id);
      if (prev && !prev.dry && z.target !== undefined && Math.abs(z.target - Number(prev.value)) < 0.25) prev.confirmed = true;
      if (!z.online) { zones.push({ id: z.id, name: z.name, note: 'sem ligação' }); continue; }
      if (z.mode === 'auto') { zones.push({ id: z.id, name: z.name, note: 'em programa próprio — não mexe' }); continue; }
      if (manual.get(z.id) === periodKey) { zones.push({ id: z.id, name: z.name, note: 'alterada à mão — respeitada até mudar de dia para noite (ou o contrário)' }); continue; }
      // We set it in this stretch, the device took it, and now it says
      // something else: someone changed it by hand.
      if (prev && !prev.dry && prev.confirmed && prev.period === periodKey && z.target !== undefined
        && Math.abs(z.target - Number(prev.value)) >= 0.25) {
        manual.set(z.id, periodKey);
        zones.push({ id: z.id, name: z.name, note: 'alterada à mão — respeitada até mudar de dia para noite (ou o contrário)' });
        continue;
      }
      if (z.target !== undefined && Math.abs(z.target - target) < 0.25) { zones.push({ id: z.id, name: z.name, note: 'no alvo' }); continue; }
      if (dry && prev?.dry && Number(prev.value) === target) { zones.push({ id: z.id, name: z.name, note: `definiria ${fmt(target)}` }); continue; }
      if (prev && t - prev.at < ZONE_EVERY) { zones.push({ id: z.id, name: z.name, note: `a aguardar (${fmt(Number(prev.value))} pedido há pouco)` }); continue; }
      await act(z.id, z.id, z.name, `alvo ${z.target !== undefined ? fmt(z.target) : '—'} → ${fmt(target)}`,
        [{ code: 'temp_set', value: Math.round(target * 10) }], target, periodKey, dry, t);
      zones.push({ id: z.id, name: z.name, note: `${dry ? 'definiria' : 'definido'} ${fmt(target)}` });
    }

    // --- What the plan wants of the pump ------------------------------------
    const pz = cfg.pumpFollowsZones;
    const anyOpen = reporting.some(z => z.valveOpen);
    allClosedSince = anyOpen || !quorum ? null : (allClosedSince ?? t);
    /** A zone wants heat (with too few thermostats answering, assume one does). */
    const zonesWant = !pz.enabled || anyOpen || !quorum;
    let wantOn: boolean;
    let why: string;
    if (paused) {
      wantOn = false;
      why = `em pausa até às ${clock(paused)}`;
    } else if (heating) {
      wantOn = zonesWant || waterDrive;
      why = warmByActive ? `pedido para as ${clock(warmBy!.at)}`
        : mode === 'warmup' ? `a aquecer para as ${cfg.warm.from}`
        : 'horário quente';
      if (!wantOn) why = `${why}, mas nenhuma zona pede calor`;
    } else if (dayMinOn) {
      wantOn = true;
      why = `casa a ${deg(meanRoom!)} de média, abaixo do mínimo de dia (${deg(cfg.dayMin)})`;
    } else if (solarOn) {
      wantOn = zonesWant;
      why = wantOn ? `sol a sobrar (${solarNote})` : 'há sol a sobrar, mas nenhuma zona pede calor';
    } else {
      wantOn = false;
      why = `de dia só com sol (${solarNote})`;
    }
    reasons.unshift(`${mode === 'warm' ? 'Horário quente' : mode === 'warmup' ? 'Aquecimento para a noite' : 'Dia'}: bomba ${wantOn ? 'ligada' : 'desligada'} — ${why}.`);

    // --- Pump --------------------------------------------------------------
    let pumpHold: string | undefined;
    let flowTarget: number | undefined;
    let flowManual = false;
    let holdRest = false;
    let doing = '';
    if (!p) pumpHold = 'bomba não encontrada';
    else if (!p.online) pumpHold = 'bomba sem ligação';
    else if (p.fault || (guardOn && g!.mode === 'lockout')) pumpHold = 'bomba em avaria — a automação não lhe mexe';
    else {
      if (!pumpSeen || pumpSeen.on !== p.on) pumpSeen = { on: p.on, since: t };
      if (p.on || (ownRest !== null && t >= ownRest)) ownRest = null;
      const sp = p.flowSetpoint;
      /** At the setpoint with the compressor at its minimum: what precedes every E13. */
      const idling = p.on && (p.hz ?? 0) > 0 && (p.hz ?? 0) <= IDLE_HZ
        && sp !== undefined && p.waterOut !== undefined && p.waterOut >= sp - NEAR_SETPOINT;

      // A setpoint the automation didn't send is someone's: SmartLife, the
      // panel, the technicians. So is the one found at start-up, unless it is
      // the last one the automation sent.
      if (sp !== undefined) {
        const ownValue = (v: number) => !!ownFlow && Math.abs(ownFlow.value - v) < 0.5;
        if (lastSeenSp === undefined) {
          if (!ownValue(sp)) flowManualIn = periodKey;
        } else if (Math.abs(sp - lastSeenSp) >= 0.5 && !ownValue(sp)) {
          flowManualIn = periodKey;
        }
        lastSeenSp = sp;
      }

      // Water temperature from the pump's own outdoor sensor, with a correction
      // while the rooms stay short of target — or the top of the range while
      // recovering or warming up.
      if (cfg.flow.enabled && p.outdoor !== undefined) {
        if (waterDrive) {
          // Frozen meanwhile: it says how wrong the curve is, which the top of the range says nothing about.
          deficitSince = null;
          satisfiedSince = null;
        } else if (shortfall > 0.25) {
          deficitSince ??= t;
          satisfiedSince = null;
          if (t - deficitSince >= CORRECTION_UP_AFTER && correction < CORRECTION_MAX) { correction += 1; deficitSince = t; }
        } else if (shortfall <= 0.05) {
          satisfiedSince ??= t;
          deficitSince = null;
          if (t - satisfiedSince >= CORRECTION_DOWN_AFTER && correction > 0) { correction -= 1; satisfiedSince = t; }
        } else {
          deficitSince = null;
          satisfiedSince = null;
        }
        const curve = flowFor(cfg, p.outdoor, correction);
        const want = waterDrive ? cfg.flow.max : curve;
        flowTarget = want;
        const key = `${p.id}:flow`;
        const prev = last.get(key);
        if (flowManualIn === periodKey && sp !== undefined) {
          flowManual = true;
          flowTarget = sp;
          reasons.push(`Água a ${fmt(sp)}: alterada à mão (ou antes de a automação arrancar) — respeitada até mudar de dia para noite (ou o contrário).`);
        } else {
          reasons.push(waterDrive
            ? `Água no máximo (${fmt(want)}): ${recovery ? 'recuperação' : warmByDrive ? `a aquecer para as ${clock(warmBy!.at)}` : `a aquecer para as ${cfg.warm.from}`}.`
            : `Água a ${fmt(want)}: exterior ${fmt(p.outdoor)} (sensor da bomba)${correction ? `, +${correction}°C porque as divisões estão abaixo do alvo` : ''}.`);
          if (sp !== undefined && Math.abs(want - sp) < 1) {
            // At target already.
          } else if (sp !== undefined && want < sp && shortfall > SHORT) {
            flowTarget = sp;
            reasons.push(`Não baixa a água (${fmt(sp)}) enquanto as divisões estiverem abaixo do alvo.`);
          } else if (sp !== undefined && want > sp && idling) {
            reasons.push(`Sobe para ${fmt(want)} quando o compressor parar: subir com ele no mínimo é o que antecede o E13.`);
          } else {
            // Down a degree at a time, so the rooms aren't left short by a big drop.
            const next = sp !== undefined && want < sp ? Math.max(want, sp - 1) : want;
            const every = sp !== undefined && want < sp ? FLOW_DOWN_EVERY : FLOW_EVERY;
            if (dry && prev?.dry && prev.value === next) {
              // Already recorded in dry-run.
            } else if (prev && t - prev.at < every) {
              reasons.push('Temperatura da água: alteração recente, a aguardar.');
            } else {
              const e2 = await act(key, p.id, 'Bomba de calor',
                `água ${sp !== undefined ? fmt(sp) : '—'} → ${fmt(next)}${next !== want ? ` (desce 1° de cada vez até ${fmt(want)})` : ''}`,
                [{ code: 'p02_heating', value: next }], next, periodKey, dry, t);
              if (!dry && e2.sent) ownFlow = { value: next, at: t };
            }
          }
        }
      }

      // --- On and off: the plan decides, whoever switched the pump ----------
      const key = `${p.id}:switch`;
      // In dry-run the pump doesn't follow, so a decision is recorded once and
      // again only after the plan changes its mind or someone switches the pump.
      if (lastWantOn !== null && lastWantOn !== wantOn && last.get(key)?.dry) last.delete(key);
      lastWantOn = wantOn;
      const prevSwitch = last.get(key);
      const seenSince = pumpSeen.since;
      /** A switch decision already made recently (or already recorded in dry-run). */
      const recentlySwitched = (v: boolean) =>
        !!prevSwitch && prevSwitch.value === v
        && (prevSwitch.dry ? dry && prevSwitch.at >= seenSince : t - prevSwitch.at < ZONE_EVERY);
      const since = (t - pumpSeen.since) / MIN;
      const would = (live: string, sim: string) => (dry ? sim : live);

      if (guardResting) {
        // The guard parked it: never switched on from here. Live, the rest
        // carries on past its end while the plan has the pump off.
        holdRest = !wantOn && !dry;
        const until = g!.restUntil && g!.restUntil > t ? ` até às ${clock(g!.restUntil)}` : '';
        doing = `Proteção E13: bomba em descanso${until}${wantOn ? ' — liga a seguir' : ` — ${would('mantém', 'manteria')}-na desligada (${why})`}.`;
      } else if (p.on && cfg.rest.enabled && idling && since * MIN > GRACE_MS && !paused) {
        if (guardOn) {
          doing = 'Bomba no setpoint com o compressor no mínimo: a proteção E13 desliga-a e põe-na a descansar.';
        } else if (recentlySwitched(false)) {
          doing = dry ? `Desligaria a bomba ${cfg.rest.minutes} min: no setpoint com o compressor no mínimo.` : 'Bomba: pedido para desligar enviado, a aguardar.';
        } else {
          const e2 = await act(key, p.id, 'Bomba de calor', `desligar ${cfg.rest.minutes} min (no setpoint a ${p.hz} Hz — não deixa voltar a acelerar)`,
            [{ code: 'switch', value: false }], false, periodKey, dry, t);
          if (!dry && e2.sent) ownRest = t + cfg.rest.minutes * MIN;
          doing = `${would('Desliga', 'Desligaria')} a bomba ${cfg.rest.minutes} min: no setpoint com o compressor no mínimo.`;
        }
      } else if (p.on && wantOn) {
        doing = `Bomba ligada — ${why}.`;
      } else if (p.on) {
        // On, and the plan has it off: a pause now; otherwise after the minimum on
        // time (and, following the zones, once they've all been closed a while).
        const idleFor = allClosedSince !== null ? (t - allClosedSince) / MIN : 0;
        // Off because no zone wants heat (warm window, or spare sun with every
        // valve closed): only once they've all been closed a while.
        const forZones = !paused && !zonesWant && (heating || (solarOn && !dayMinOn));
        const zonesWait = forZones ? Math.max(0, pz.idleMin - idleFor) : 0;
        const onWait = paused ? 0 : Math.max(0, pz.minOnMin - since);
        const wait = Math.max(zonesWait, onWait);
        if (wait > 0) {
          doing = `Bomba ligada — ${why}: ${would('desliga', 'desligaria')} às ${clock(t + wait * MIN)} (${onWait >= zonesWait ? `mínimo de ${pz.minOnMin} min a trabalhar` : `válvulas fechadas há ${Math.round(idleFor)} min`}).`;
        } else if (recentlySwitched(false)) {
          doing = dry ? `Desligaria a bomba — ${why}.` : 'Bomba: pedido para desligar enviado, a aguardar.';
        } else {
          await act(key, p.id, 'Bomba de calor', `desligar (${why})`, [{ code: 'switch', value: false }], false, periodKey, dry, t);
          doing = `${would('Desliga', 'Desligaria')} a bomba — ${why}.`;
        }
      } else if (!wantOn) {
        doing = `Bomba desligada — ${why}.`;
      } else {
        // Off, and the plan wants it on: whoever switched it off, after the
        // minimum off time (or the automation's own rest).
        const at = ownRest ?? pumpSeen.since + pz.minOffMin * MIN;
        if (t < at) {
          doing = ownRest
            ? `Bomba em descanso — ${would('liga', 'ligaria')} às ${clock(ownRest)}.`
            : `Bomba desligada às ${clock(pumpSeen.since)} — ${would('liga', 'ligaria')} às ${clock(at)} (${why}).`;
        } else if (!dry && ons.length >= MAX_ONS_PER_DAY) {
          doing = `Bomba desligada — já a ligou ${ons.length} vezes nas últimas 24 h; não volta a ligar antes das ${clock(ons[0] + DAY)} (use Pausar para a parar).`;
        } else if (recentlySwitched(true)) {
          doing = dry ? `Ligaria a bomba — ${why}.` : 'Bomba: pedido para ligar enviado, a aguardar.';
        } else {
          const e2 = await act(key, p.id, 'Bomba de calor', `ligar (${why})`, [{ code: 'switch', value: true }], true, periodKey, dry, t);
          if (!dry && e2.sent) ons = [...ons, t];
          doing = `${would('Liga', 'Ligaria')} a bomba — ${why}.`;
        }
      }
      reasons.push(doing);
    }
    if (pumpHold) {
      doing = `Bomba: ${pumpHold}.`;
      reasons.push(doing);
    }
    if (warmBy && pumpHold && (warmBy.phase === 'waiting' || warmBy.phase === 'heating')) {
      warmBy = { ...warmBy, note: `${warmBy.note} Atenção: ${pumpHold}, assim não aquece.` };
    }

    save();
    return {
      ...base,
      actions,
      warmBy,
      state: dry ? 'dry-run' : 'running',
      mode,
      wantOn,
      doing,
      plan: planText(cfg, plan, mode, model, paused),
      warm: plan,
      solar,
      dayMinActive: dayMinOn,
      meanRoom: meanRoom !== undefined ? Math.round(meanRoom * 10) / 10 : undefined,
      roomTarget: target,
      outdoor: p?.outdoor,
      flowTarget,
      flowCorrection: correction,
      flowManual,
      recovery,
      shortfall: Math.round(shortfall * 10) / 10,
      pumpHold,
      holdRest,
      restUntil: ownRest ?? undefined,
      switchOns24h: ons.length,
      zones,
      reasons,
    };
  }

  return Object.assign(tick, {
    /** For index.ts to save: the warm-up model, the last water setpoint sent, the warm-up and the switch-ons. */
    memory: (): AutomationMemory => memo,
  });
}

/** Today's plan in plain words, e.g. "Aquece a partir das 17:20 para estar quente às 19:00; de dia só com sol…". */
export function planText(cfg: AutomationConfig, w: WarmPlan, mode: PlanMode, model: WarmupModel, paused: number | null) {
  const dayRule = cfg.solar.enabled
    ? `de dia só com sol e bateria ≥ ${Math.round(cfg.solar.socOn)} %, ou se a casa descer dos ${deg(cfg.dayMin)}`
    : `de dia só se a casa descer dos ${deg(cfg.dayMin)}`;
  const how = `faltam ${deg(w.need)}: chão ~${model.floorMin} min + divisões a ${model.roomRatePerH.toFixed(2).replace('.', ',')}°/h + ${WARM_MARGIN_MIN} min de margem`;
  const late = w.expectedAt ? ` Previsto quente às ${lisbonClock(w.expectedAt)}.` : '';
  let text: string;
  if (mode === 'warm') {
    text = `Horário quente até às ${lisbonClock(w.end)}: mantém ${deg(cfg.comfort)}. Depois, ${dayRule}.`;
  } else if (mode === 'warmup') {
    text = `A aquecer${w.warmupAt ? ` desde as ${lisbonClock(w.warmupAt)}` : ''} para estar quente às ${lisbonClock(w.nextStart)} (horário quente até às ${lisbonClock(w.end)}).${late}`;
  } else if (w.warmupAt) {
    text = `Aquece a partir das ${lisbonClock(w.warmupAt)} para estar quente às ${lisbonClock(w.nextStart)} (${how}${w.capped ? `; no máximo ${MAX_WARMUP_LEAD_MIN / 60} h antes` : ''}); ${dayRule}.${late}`;
  } else {
    text = `A casa já está a ${deg(cfg.comfort)}: o horário quente começa às ${lisbonClock(w.nextStart)}; ${dayRule}.`;
  }
  if (paused) text = `Em pausa até às ${lisbonClock(paused)}: ninguém liga a bomba sozinho até lá. Depois: ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
  return text;
}
