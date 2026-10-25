/**
 * Heating automation: keep the house at its comfort temperature for less
 * energy and less money. Design and reasoning: apps/noisysource/domotics/
 * HANDOFF-heating-automation.md.
 *
 * The house is underfloor heating on a heavy slab, fed by one air-to-water
 * heat pump (floor heating only — hot water is a separate unit), with six
 * zone thermostats opening and closing the valves, solar panels, a battery,
 * and a two-rate (bi-horário) tariff. So:
 * - the water temperature follows the OUTDOOR SENSOR ON THE PUMP (not a
 *   weather service — it reads colder here, and it is what the pump feels);
 * - room targets follow the time of day: pre-heat at the end of the cheap
 *   night window, coast through the expensive evening, and store solar heat in
 *   the slab when there is surplus;
 * - the pump is switched off when no zone has wanted heat for a while.
 *
 * What the cold morning of 20/10 and the E13 trips of 21–24/10 added:
 * - recovery: while the rooms are well below target the water goes to the top
 *   of the range, and it is never lowered while they are below target (on
 *   20/10 the curve lowered it overnight and the slab never caught up);
 * - a water setpoint changed by hand is left alone until the next period,
 *   like a zone;
 * - the pump never idles at the setpoint: every E13 came after the compressor
 *   sat at its minimum there and then sped up again. So it is switched off and
 *   rests instead (the E13 guard does it when it is on; the automation does it
 *   itself when the guard is off), it is switched back on only when a zone
 *   wants heat, and the water is never raised while the compressor idles —
 *   raised then, it would speed up from the minimum, which is the trip.
 * - "warm by HH:MM" (warmby.ts): a one-off target, started early enough from
 *   how the house is seen to warm up.
 *
 * Off and in dry-run by default. Every decision carries its reason, and the
 * status travels with the bridge state so the app can show what is happening.
 *
 * This file decides; `index.ts` sends. Decisions are kept free of I/O so they
 * can be reasoned about (and tested) without a house attached.
 */

import { GRACE_MS, IDLE_HZ, NEAR_SETPOINT } from './guard';
import {
  createWarmupLearner, parseModel, planWarmBy, WARM_HOLD_MS,
  type WarmByRequest, type WarmByStatus, type WarmupModel,
} from './warmby';

export interface AutomationConfig {
  /** Master switch. Off: nothing is evaluated or sent. */
  enabled: boolean;
  /** Decide and log, but send nothing to the devices. */
  dryRun: boolean;
  /** The temperature the house is kept at, °C. */
  comfort: number;
  /** End of the cheap window: heat the slab a little above comfort. */
  preheat: { from: string; to: string; delta: number };
  /** Expensive evening: let the slab carry the house a little below comfort. */
  evening: { from: string; to: string; delta: number };
  /** Daytime solar surplus: store it in the slab. */
  solarBoost: { enabled: boolean; delta: number; exportW: number };
  /** Water temperature from the outdoor temperature: at15 + (15 − outdoor) × slope. */
  flow: { enabled: boolean; at15: number; slope: number; min: number; max: number };
  /** Rooms well below target: water at the top of the range until they reach it. */
  recovery: { enabled: boolean };
  /** At the setpoint with the compressor at its minimum: switch off and rest, rather than idle there. */
  rest: { enabled: boolean; minutes: number };
  /** Switch the pump off once every zone valve has been closed for a while. */
  pumpFollowsZones: { enabled: boolean; idleMin: number; minOnMin: number; minOffMin: number };
  /** Hard limits on room targets, whatever else is configured. */
  limits: { roomMin: number; roomMax: number };
}

export const DEFAULT_CONFIG: AutomationConfig = {
  enabled: false,
  dryRun: true,
  comfort: 24,
  preheat: { from: '05:00', to: '08:00', delta: 0.5 },
  evening: { from: '18:00', to: '22:00', delta: -0.5 },
  solarBoost: { enabled: true, delta: 0.5, exportW: 800 },
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

/** Whatever is stored, a configuration that is complete and inside the hard bounds. */
export function parseConfig(raw: unknown): AutomationConfig {
  const r = obj(raw);
  const d = DEFAULT_CONFIG;
  const pre = obj(r.preheat);
  const eve = obj(r.evening);
  const sb = obj(r.solarBoost);
  const fl = obj(r.flow);
  const rc = obj(r.recovery);
  const rs = obj(r.rest);
  const pz = obj(r.pumpFollowsZones);
  const li = obj(r.limits);
  const roomMin = num(li.roomMin, d.limits.roomMin, HARD.roomMin, HARD.roomMax);
  const roomMax = num(li.roomMax, d.limits.roomMax, roomMin, HARD.roomMax);
  // Whole degrees: the pump's setpoint is an integer.
  const flowMin = Math.round(num(fl.min, d.flow.min, HARD.flowMin, HARD.flowMax));
  return {
    enabled: bool(r.enabled, d.enabled),
    dryRun: bool(r.dryRun, d.dryRun),
    comfort: num(r.comfort, d.comfort, roomMin, roomMax),
    preheat: { from: hhmm(pre.from, d.preheat.from), to: hhmm(pre.to, d.preheat.to), delta: num(pre.delta, d.preheat.delta, 0, 2) },
    evening: { from: hhmm(eve.from, d.evening.from), to: hhmm(eve.to, d.evening.to), delta: num(eve.delta, d.evening.delta, -2, 0) },
    solarBoost: {
      enabled: bool(sb.enabled, d.solarBoost.enabled),
      delta: num(sb.delta, d.solarBoost.delta, 0, 2),
      exportW: num(sb.exportW, d.solarBoost.exportW, 100, 10_000),
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

// ---------------------------------------------------------------------------
// Inputs and decisions
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

export interface EnergyReading {
  pvW?: number;
  loadW?: number;
  /** Positive while exporting. */
  gridW?: number;
  soc?: number;
}

/** What the E13 guard is doing (guard.ts), as far as the automation needs to know. */
export interface GuardView {
  enabled: boolean;
  mode: 'off' | 'watch' | 'rest' | 'lockout';
  restUntil: number | null;
}

export type Period = 'preheat' | 'day' | 'evening' | 'night';

export const PERIOD_LABEL: Record<Period, string> = {
  preheat: 'pré-aquecimento',
  day: 'dia',
  evening: 'fim do dia (poupança)',
  night: 'noite (vazio)',
};

const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
/** Whether a local time falls in [from, to), windows crossing midnight included. */
function within(now: number, from: string, to: string) {
  const a = minutes(from);
  const b = minutes(to);
  return a <= b ? now >= a && now < b : now >= a || now < b;
}

export function periodAt(cfg: AutomationConfig, date: Date): Period {
  const m = date.getHours() * 60 + date.getMinutes();
  if (within(m, cfg.preheat.from, cfg.preheat.to)) return 'preheat';
  if (within(m, cfg.evening.from, cfg.evening.to)) return 'evening';
  // Between the end of the evening and the start of pre-heat: the cheap window.
  if (within(m, cfg.evening.to, cfg.preheat.from)) return 'night';
  return 'day';
}

/** Room targets go in half degrees: the thermostats step in 0.5. */
const half = (v: number) => Math.round(v * 2) / 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function roomTarget(cfg: AutomationConfig, period: Period, boost: boolean) {
  const delta = period === 'preheat' ? cfg.preheat.delta
    : period === 'evening' ? cfg.evening.delta
    : 0;
  return clamp(half(cfg.comfort + delta + (boost ? cfg.solarBoost.delta : 0)), cfg.limits.roomMin, cfg.limits.roomMax);
}

export function flowFor(cfg: AutomationConfig, outdoor: number, correction: number) {
  return Math.round(clamp(cfg.flow.at15 + (15 - outdoor) * cfg.flow.slope + correction, cfg.flow.min, cfg.flow.max));
}

/** Solar surplus: exporting past the threshold, or the battery full and the panels ahead of the house. */
export function hasSurplus(cfg: AutomationConfig, e?: EnergyReading) {
  if (!e) return false;
  if ((e.gridW ?? 0) > cfg.solarBoost.exportW) return true;
  return (e.soc ?? 0) >= 95 && (e.pvW ?? 0) > (e.loadW ?? Infinity);
}

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

export interface AutomationStatus {
  enabled: boolean;
  dryRun: boolean;
  state: 'off' | 'running' | 'dry-run';
  period?: Period;
  periodLabel?: string;
  boost?: boolean;
  roomTarget?: number;
  outdoor?: number;
  flowTarget?: number;
  flowCorrection?: number;
  /** The water setpoint was changed by hand: left alone until the next period. */
  flowManual?: boolean;
  /** Rooms well below target: water at the top of the range. */
  recovery?: boolean;
  /** How far below their targets the rooms are, on average (rooms above target count as 0), °C. */
  shortfall?: number;
  /** Set when the pump is left alone (fault, offline, switched off by hand). */
  pumpHold?: string;
  /** Live only: asks the E13 guard to keep its rest going, since no zone wants heat. */
  holdRest?: boolean;
  /** The automation's own rest at the setpoint (guard off), until when. */
  restUntil?: number;
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
}

export type Send = (deviceId: string, commands: Array<{ code: string; value: number | boolean }>) => Promise<void>;

const MIN = 60_000;
const ZONE_EVERY = 10 * MIN;
/** Raising the water: as soon as it is due, at most this often. */
const FLOW_EVERY = 15 * MIN;
/** Lowering it: a degree at a time, this far apart. */
const FLOW_DOWN_EVERY = 30 * MIN;
const BOOST_GRACE = 15 * MIN;
/** Rooms short of target this long → water +1 °C; at target this long → −1 °C. */
const CORRECTION_UP_AFTER = 30 * MIN;
const CORRECTION_DOWN_AFTER = 60 * MIN;
const CORRECTION_MAX = 4;
/** The rooms' mean shortfall that starts recovery, and the one that ends it. */
const RECOVERY_ON = 0.5;
const RECOVERY_OFF = 0.2;
/** Below target by more than this on average: the water is not lowered. */
const SHORT = 0.2;
const KEEP_ACTIONS = 12;

const fmt = (v: number) => `${v.toFixed(1).replace(/\.0$/, '')}°C`;
const clock = (ms: number) => new Date(ms).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });

export function createAutomation(send: Send, memory?: Partial<AutomationMemory>) {
  /** What we last asked of each device (sent, or decided in dry-run). */
  const last = new Map<string, { value: number | boolean; at: number; period: string; dry: boolean; confirmed: boolean }>();
  /** Zones changed by hand: left alone until the period changes. */
  const manual = new Map<string, string>();
  let lastSurplusAt = 0;
  let boost = false;
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
  /** The pump switched off by the automation (live), and when it may come back on. */
  let ownOff: { why: 'rest' | 'zones'; until: number } | null = null;
  /** The warm-by request being worked on. */
  let warm: { at: number; started: boolean; outcome: { mean: number; reached: boolean } | null } | null = null;
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
        await send(deviceId, commands);
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
    if (p?.on) ownOff = null;

    // How the house warms up, learned from what it does whatever the automation is set to.
    const running = !!p && p.online && p.on && !p.fault && (p.hz ?? 0) > 0;
    learner.observe({
      t,
      running,
      waterIn: p?.waterIn,
      zones: known,
      // Off is "available" when something will switch it back on: the guard, or
      // a live automation, whoever switched it off.
      available: !!p && p.online && !p.fault
        && (p.on || guardResting || ownOff !== null || (cfg.enabled && !cfg.dryRun && cfg.pumpFollowsZones.enabled)),
    });
    const model = learner.model();

    // --- Warm by HH:MM ------------------------------------------------------
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
    const memoryOut = () => ({ model, flow: ownFlow });

    const base = { enabled: cfg.enabled, dryRun: cfg.dryRun, actions, evaluatedAt: t, model, warmBy };
    if (!cfg.enabled) {
      boost = false;
      recovery = false;
      if (warmBy) warmBy = { ...warmBy, note: `A automação está desligada: o pedido fica guardado mas não aquece. ${warmBy.note}` };
      memo = memoryOut();
      return { ...base, warmBy, state: 'off', zones: [], reasons: ['Automação desligada.'] };
    }
    const dry = cfg.dryRun;
    const period = periodAt(cfg, input.now);
    const periodKey = `${input.now.toDateString()}:${period}`;
    const reasons: string[] = [];
    const warmTarget = warmBy && (warmBy.phase === 'heating' || warmBy.phase === 'holding') ? warmBy.target : undefined;
    /** Heating towards the requested time, with the rooms still short of it. */
    const warmDrive = warmBy?.phase === 'heating' && warmBy.current !== null
      ? warmBy.target - warmBy.current > 0.1
      : warmBy?.phase === 'heating';

    // --- Solar boost -------------------------------------------------------
    const surplus = period === 'day' && cfg.solarBoost.enabled && hasSurplus(cfg, input.energy);
    if (surplus) {
      lastSurplusAt = t;
      boost = true;
    } else if (boost && (period !== 'day' || t - lastSurplusAt > BOOST_GRACE)) {
      boost = false;
    }
    const scheduled = roomTarget(cfg, period, boost);
    const target = warmTarget !== undefined && warmTarget > scheduled ? warmTarget : scheduled;
    reasons.push(`Período: ${PERIOD_LABEL[period]} — alvo das divisões ${fmt(target)}${target !== scheduled ? ` (pedido para as ${clock(warmBy!.at)})` : boost ? ' (inclui bónus solar)' : ''}.`);
    if (boost) reasons.push(surplus ? 'Há excedente solar: a guardar calor no pavimento.' : 'Bónus solar a terminar (sem excedente há pouco).');

    // --- Recovery ----------------------------------------------------------
    if (!cfg.recovery.enabled || known.length === 0) recovery = false;
    else if (!recovery && shortfall > RECOVERY_ON) recovery = true;
    else if (recovery && shortfall <= RECOVERY_OFF) recovery = false;
    if (recovery) {
      const coldest = [...known].sort((a, b) => shortOf(b) - shortOf(a)).slice(0, 2)
        .map(z => `${z.name} ${fmt(z.current)} para ${fmt(z.target)}`).join(', ');
      reasons.push(`Recuperação: divisões em média ${fmt(shortfall)} abaixo do alvo (${coldest}) — água no máximo até chegarem ao alvo.`);
    }
    const drive = recovery || warmDrive;

    // --- Zones -------------------------------------------------------------
    const zones: AutomationStatus['zones'] = [];
    for (const z of input.zones) {
      const prev = last.get(z.id);
      if (prev && !prev.dry && z.target !== undefined && Math.abs(z.target - Number(prev.value)) < 0.25) prev.confirmed = true;
      if (!z.online) { zones.push({ id: z.id, name: z.name, note: 'sem ligação' }); continue; }
      if (z.mode === 'auto') { zones.push({ id: z.id, name: z.name, note: 'em programa próprio — não mexe' }); continue; }
      if (manual.get(z.id) === periodKey) { zones.push({ id: z.id, name: z.name, note: 'alterada à mão — respeitada até ao próximo período' }); continue; }
      // We set it this period, the device took it, and now it says something
      // else: someone changed it by hand.
      if (prev && !prev.dry && prev.confirmed && prev.period === periodKey && z.target !== undefined
        && Math.abs(z.target - Number(prev.value)) >= 0.25) {
        manual.set(z.id, periodKey);
        zones.push({ id: z.id, name: z.name, note: 'alterada à mão — respeitada até ao próximo período' });
        continue;
      }
      if (z.target !== undefined && Math.abs(z.target - target) < 0.25) { zones.push({ id: z.id, name: z.name, note: 'no alvo' }); continue; }
      if (dry && prev?.dry && Number(prev.value) === target) { zones.push({ id: z.id, name: z.name, note: `definiria ${fmt(target)}` }); continue; }
      if (prev && t - prev.at < ZONE_EVERY) { zones.push({ id: z.id, name: z.name, note: `a aguardar (${fmt(Number(prev.value))} pedido há pouco)` }); continue; }
      await act(z.id, z.id, z.name, `alvo ${z.target !== undefined ? fmt(z.target) : '—'} → ${fmt(target)}`,
        [{ code: 'temp_set', value: Math.round(target * 10) }], target, periodKey, dry, t);
      zones.push({ id: z.id, name: z.name, note: `${dry ? 'definiria' : 'definido'} ${fmt(target)}` });
    }

    // --- Pump --------------------------------------------------------------
    let pumpHold: string | undefined;
    let flowTarget: number | undefined;
    let flowManual = false;
    let holdRest = false;
    if (!p) pumpHold = 'bomba não encontrada';
    else if (!p.online) pumpHold = 'bomba sem ligação';
    else if (p.fault || (guardOn && g!.mode === 'lockout')) pumpHold = 'bomba em avaria — a automação não lhe mexe';
    else {
      if (!pumpSeen || pumpSeen.on !== p.on) pumpSeen = { on: p.on, since: t };
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
      // recovering or heating for a requested time.
      if (cfg.flow.enabled && p.outdoor !== undefined) {
        if (drive) {
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
        const want = drive ? cfg.flow.max : curve;
        flowTarget = want;
        const key = `${p.id}:flow`;
        const prev = last.get(key);
        if (flowManualIn === periodKey && sp !== undefined) {
          flowManual = true;
          flowTarget = sp;
          reasons.push(`Água a ${fmt(sp)}: alterada à mão (ou antes de a automação arrancar) — respeitada até ao próximo período.`);
        } else {
          reasons.push(drive
            ? `Água no máximo (${fmt(want)}): ${recovery ? 'recuperação' : `a aquecer para as ${clock(warmBy!.at)}`}.`
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
              const e = await act(key, p.id, 'Bomba de calor',
                `água ${sp !== undefined ? fmt(sp) : '—'} → ${fmt(next)}${next !== want ? ` (desce 1° de cada vez até ${fmt(want)})` : ''}`,
                [{ code: 'p02_heating', value: next }], next, periodKey, dry, t);
              if (!dry && e.sent) ownFlow = { value: next, at: t };
            }
          }
        }
      }

      // On and off. Whatever switches the pump off, it comes back on only when
      // a zone wants heat (or recovery, or a requested time, does).
      const pz = cfg.pumpFollowsZones;
      if (pz.enabled || cfg.rest.enabled) {
        const anyOpen = reporting.some(z => z.valveOpen);
        allClosedSince = anyOpen || !quorum ? null : (allClosedSince ?? t);
        /** With too few thermostats answering, nothing is taken to mean "no heat wanted". */
        const heatWanted = !pz.enabled || anyOpen || drive || !quorum;
        const key = `${p.id}:switch`;
        const prevSwitch = last.get(key);
        /** A switch decision already made recently (or already recorded in dry-run). */
        const recentlySwitched = (want: boolean) =>
          !!prevSwitch && prevSwitch.value === want && (prevSwitch.dry ? dry : t - prevSwitch.at < ZONE_EVERY);
        const onFor = (t - pumpSeen.since) / MIN;

        if (guardResting) {
          // The guard parked it: never switched on from here. Live, the rest
          // carries on past its end while nothing wants heat.
          const wouldHold = pz.enabled && !heatWanted;
          holdRest = wouldHold && !dry;
          const until = g!.restUntil && g!.restUntil > t ? ` até às ${clock(g!.restUntil)}` : '';
          reasons.push(`Proteção E13: bomba em descanso${until}${wouldHold ? ` — ${dry ? 'manteria' : 'mantém'}-na desligada enquanto nenhuma zona pedir calor` : ''}.`);
        } else if (p.on) {
          if (cfg.rest.enabled && idling && onFor * MIN > GRACE_MS) {
            if (guardOn) {
              reasons.push('No setpoint com o compressor no mínimo: a proteção E13 desliga-a e põe-na a descansar.');
            } else if (recentlySwitched(false)) {
              reasons.push(dry ? `Desligaria a bomba ${cfg.rest.minutes} min: no setpoint com o compressor no mínimo.` : 'Bomba: pedido para desligar enviado, a aguardar.');
            } else {
              const e = await act(key, p.id, 'Bomba de calor', `desligar ${cfg.rest.minutes} min (no setpoint a ${p.hz} Hz — não deixa voltar a acelerar)`,
                [{ code: 'switch', value: false }], false, periodKey, dry, t);
              if (!dry && e.sent) ownOff = { why: 'rest', until: t + cfg.rest.minutes * MIN };
            }
          } else if (pz.enabled && allClosedSince !== null && !drive) {
            const idle = (t - allClosedSince) / MIN;
            if (idle >= pz.idleMin && onFor >= pz.minOnMin && recentlySwitched(false)) {
              reasons.push(dry ? 'Desligaria a bomba: nenhuma zona pede calor.' : 'Bomba: pedido para desligar enviado, a aguardar.');
            } else if (idle >= pz.idleMin && onFor >= pz.minOnMin) {
              const e = await act(key, p.id, 'Bomba de calor', 'desligar (nenhuma zona pede calor)', [{ code: 'switch', value: false }], false, periodKey, dry, t);
              if (!dry && e.sent) ownOff = { why: 'zones', until: t + pz.minOffMin * MIN };
            } else {
              reasons.push(`Todas as válvulas fechadas há ${Math.round(idle)} min — desliga aos ${pz.idleMin} min.`);
            }
          }
        } else if (!ownOff && !pz.enabled && !drive) {
          // Switching on and off is turned off in the settings; only recovery or a requested time switch it on.
          reasons.push('Bomba desligada — ligar e desligar pelas zonas está desativado.');
        } else if (!heatWanted) {
          reasons.push(`Bomba desligada ${ownOff ? `pela automação (${ownOff.why === 'rest' ? 'descanso no setpoint' : 'sem pedidos de calor'})` : 'de fora da automação'} — liga quando uma zona pedir calor.`);
        } else if (t < (ownOff?.until ?? pumpSeen.since + pz.minOffMin * MIN)) {
          // Whoever switched it off, the automation switches it back on (Renato,
          // 2026-10-25), but not straight after an off from outside.
          reasons.push(ownOff
            ? `Bomba em descanso — liga às ${clock(ownOff.until)}.`
            : `Bomba desligada de fora às ${clock(pumpSeen.since)} — liga às ${clock(pumpSeen.since + pz.minOffMin * MIN)}.`);
        } else if (recentlySwitched(true)) {
          reasons.push('Bomba: pedido para ligar enviado, a aguardar.');
        } else {
          await act(key, p.id, 'Bomba de calor', `ligar (${drive ? (recovery ? 'recuperação' : 'a aquecer para a hora pedida') : 'uma zona pede calor'})`,
            [{ code: 'switch', value: true }], true, periodKey, dry, t);
        }
      }
    }
    if (pumpHold) reasons.push(`Bomba: ${pumpHold}.`);
    if (warmBy && pumpHold && (warmBy.phase === 'waiting' || warmBy.phase === 'heating')) {
      warmBy = { ...warmBy, note: `${warmBy.note} Atenção: ${pumpHold}, assim não aquece.` };
    }

    memo = memoryOut();
    return {
      ...base,
      actions,
      warmBy,
      state: dry ? 'dry-run' : 'running',
      period,
      periodLabel: PERIOD_LABEL[period],
      boost,
      roomTarget: target,
      outdoor: p?.outdoor,
      flowTarget,
      flowCorrection: correction,
      flowManual,
      recovery,
      shortfall: Math.round(shortfall * 10) / 10,
      pumpHold,
      holdRest,
      restUntil: ownOff?.why === 'rest' ? ownOff.until : undefined,
      zones,
      reasons,
    };
  }

  let memo: AutomationMemory = { model: learner.model(), flow: ownFlow };
  return Object.assign(tick, {
    /** For index.ts to save: the warm-up model and the last water setpoint sent. */
    memory: (): AutomationMemory => memo,
  });
}
