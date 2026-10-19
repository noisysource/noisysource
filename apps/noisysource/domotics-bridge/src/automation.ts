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
 * Off and in dry-run by default. Every decision carries its reason, and the
 * status travels with the bridge state so the app can show what is happening.
 *
 * This file decides; `index.ts` sends. Decisions are kept free of I/O so they
 * can be reasoned about (and tested) without a house attached.
 */

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
  flow: { enabled: true, at15: 30, slope: 0.8, min: 28, max: 38 },
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
  const pz = obj(r.pumpFollowsZones);
  const li = obj(r.limits);
  const roomMin = num(li.roomMin, d.limits.roomMin, HARD.roomMin, HARD.roomMax);
  const roomMax = num(li.roomMax, d.limits.roomMax, roomMin, HARD.roomMax);
  const flowMin = num(fl.min, d.flow.min, HARD.flowMin, HARD.flowMax);
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
      max: num(fl.max, d.flow.max, flowMin, HARD.flowMax),
    },
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
}

export interface EnergyReading {
  pvW?: number;
  loadW?: number;
  /** Positive while exporting. */
  gridW?: number;
  soc?: number;
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
  /** Set when the pump is left alone (fault, offline, switched off by hand). */
  pumpHold?: string;
  zones: Array<{ id: string; name: string; note: string }>;
  reasons: string[];
  /** Newest first. */
  actions: AutomationAction[];
  evaluatedAt: number;
}

export type Send = (deviceId: string, commands: Array<{ code: string; value: number | boolean }>) => Promise<void>;

const MIN = 60_000;
const ZONE_EVERY = 10 * MIN;
const FLOW_EVERY = 30 * MIN;
const BOOST_GRACE = 15 * MIN;
const CORRECTION_AFTER = 120 * MIN;
const KEEP_ACTIONS = 12;

const fmt = (v: number) => `${v.toFixed(1).replace(/\.0$/, '')}°C`;

export function createAutomation(send: Send) {
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
  /** Whether the automation, not a person, last switched the pump off. */
  let pumpOffByUs = false;
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
  }

  return async function tick(
    cfg: AutomationConfig,
    input: { now: Date; zones: ZoneReading[]; pump?: PumpReading; energy?: EnergyReading },
  ): Promise<AutomationStatus> {
    const t = input.now.getTime();
    const base = { enabled: cfg.enabled, dryRun: cfg.dryRun, actions, evaluatedAt: t };
    if (!cfg.enabled) {
      boost = false;
      return { ...base, state: 'off', zones: [], reasons: ['Automação desligada.'] };
    }
    const dry = cfg.dryRun;
    const period = periodAt(cfg, input.now);
    const periodKey = `${input.now.toDateString()}:${period}`;
    const reasons: string[] = [];

    // --- Solar boost -------------------------------------------------------
    const surplus = period === 'day' && cfg.solarBoost.enabled && hasSurplus(cfg, input.energy);
    if (surplus) {
      lastSurplusAt = t;
      boost = true;
    } else if (boost && (period !== 'day' || t - lastSurplusAt > BOOST_GRACE)) {
      boost = false;
    }
    const target = roomTarget(cfg, period, boost);
    reasons.push(`Período: ${PERIOD_LABEL[period]} — alvo das divisões ${fmt(target)}${boost ? ' (inclui bónus solar)' : ''}.`);
    if (boost) reasons.push(surplus ? 'Há excedente solar: a guardar calor no pavimento.' : 'Bónus solar a terminar (sem excedente há pouco).');

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
    const p = input.pump;
    let pumpHold: string | undefined;
    let flowTarget: number | undefined;
    if (!p) pumpHold = 'bomba não encontrada';
    else if (!p.online) pumpHold = 'bomba sem ligação';
    else if (p.fault) pumpHold = 'bomba em avaria — a automação não lhe mexe';
    else {
      // Water temperature from the pump's own outdoor sensor, with a slow
      // correction if the rooms stay short of target for hours.
      if (cfg.flow.enabled && p.outdoor !== undefined) {
        // Short of what each zone is actually asking for — a zone set by hand
        // or on its own program has its own setpoint, not the house target.
        const known = input.zones.filter(z => z.online && z.current !== undefined && z.target !== undefined);
        const deficit = known.length
          ? known.reduce((a, z) => a + ((z.target as number) - (z.current as number)), 0) / known.length
          : 0;
        if (deficit > 0.5) {
          deficitSince ??= t;
          satisfiedSince = null;
          if (t - deficitSince >= CORRECTION_AFTER && correction < 3) { correction += 1; deficitSince = t; }
        } else if (deficit <= 0) {
          satisfiedSince ??= t;
          deficitSince = null;
          if (t - satisfiedSince >= CORRECTION_AFTER && correction > 0) { correction -= 1; satisfiedSince = t; }
        } else {
          deficitSince = null;
          satisfiedSince = null;
        }
        flowTarget = flowFor(cfg, p.outdoor, correction);
        reasons.push(`Água a ${fmt(flowTarget)}: exterior ${fmt(p.outdoor)} (sensor da bomba)${correction ? `, +${correction}°C porque as divisões estão abaixo do alvo` : ''}.`);
        const prev = last.get(`${p.id}:flow`);
        if (p.flowSetpoint !== undefined && Math.abs(p.flowSetpoint - flowTarget) < 1) {
          // At target already.
        } else if (dry && prev?.dry && prev.value === flowTarget) {
          // Already recorded in dry-run.
        } else if (prev && t - prev.at < FLOW_EVERY) {
          reasons.push('Temperatura da água: alteração recente, a aguardar.');
        } else {
          await act(`${p.id}:flow`, p.id, 'Bomba de calor', `água ${p.flowSetpoint !== undefined ? fmt(p.flowSetpoint) : '—'} → ${fmt(flowTarget)}`,
            [{ code: 'p02_heating', value: flowTarget }], flowTarget, periodKey, dry, t);
        }
      }

      // Pump off once no zone has wanted heat for a while; back on when one does.
      if (cfg.pumpFollowsZones.enabled) {
        if (!pumpSeen || pumpSeen.on !== p.on) pumpSeen = { on: p.on, since: t };
        const reporting = input.zones.filter(z => z.online);
        const anyOpen = reporting.some(z => z.valveOpen);
        allClosedSince = anyOpen || reporting.length === 0 ? null : (allClosedSince ?? t);
        const { idleMin, minOnMin, minOffMin } = cfg.pumpFollowsZones;
        const prevSwitch = last.get(`${p.id}:switch`);
        /** A switch decision already made recently (or already recorded in dry-run). */
        const recentlySwitched = (want: boolean) =>
          !!prevSwitch && prevSwitch.value === want && (prevSwitch.dry ? dry : t - prevSwitch.at < ZONE_EVERY);
        if (reporting.length === 0) {
          reasons.push('Nenhuma zona responde — a bomba fica como está.');
        } else if (p.on && allClosedSince !== null) {
          const idle = (t - allClosedSince) / MIN;
          const ranFor = (t - pumpSeen.since) / MIN;
          if (idle >= idleMin && ranFor >= minOnMin && recentlySwitched(false)) {
            reasons.push(dry ? 'Desligaria a bomba: nenhuma zona pede calor.' : 'Bomba: pedido para desligar enviado, a aguardar.');
          } else if (idle >= idleMin && ranFor >= minOnMin) {
            await act(`${p.id}:switch`, p.id, 'Bomba de calor', 'desligar (nenhuma zona pede calor)', [{ code: 'switch', value: false }], false, periodKey, dry, t);
            if (!dry) pumpOffByUs = true;
          } else {
            reasons.push(`Todas as válvulas fechadas há ${Math.round(idle)} min — desliga aos ${idleMin} min.`);
          }
        } else if (!p.on && anyOpen) {
          if (!pumpOffByUs && !dry) {
            pumpHold = 'bomba desligada à mão — a automação não a liga';
          } else if (recentlySwitched(true)) {
            reasons.push(dry ? 'Ligaria a bomba: uma zona pede calor.' : 'Bomba: pedido para ligar enviado, a aguardar.');
          } else if ((t - pumpSeen.since) / MIN >= minOffMin) {
            await act(`${p.id}:switch`, p.id, 'Bomba de calor', 'ligar (uma zona pede calor)', [{ code: 'switch', value: true }], true, periodKey, dry, t);
            if (!dry) pumpOffByUs = false;
          } else {
            reasons.push(`Uma zona pede calor — a bomba liga após ${minOffMin} min desligada.`);
          }
        }
      }
    }
    if (pumpHold) reasons.push(`Bomba: ${pumpHold}.`);

    return {
      ...base,
      actions,
      state: dry ? 'dry-run' : 'running',
      period,
      periodLabel: PERIOD_LABEL[period],
      boost,
      roomTarget: target,
      outdoor: p?.outdoor,
      flowTarget,
      flowCorrection: correction,
      pumpHold,
      zones,
      reasons,
    };
  };
}
