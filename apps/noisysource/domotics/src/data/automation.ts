import { deleteField, doc, getDoc, setDoc } from 'firebase/firestore';
import { db, warmByFn } from '../lib/firebase';

/**
 * Heating automation, as the app sees it: the settings (edited here, stored in
 * `domotics_config/automation`, owner-only) and the status the bridge reports
 * with its state (what it decided and why).
 *
 * Mirrors `domotics-bridge/src/automation.ts`. Kept as its own copy rather than
 * imported, like EnergyReading: the bridge is a separate deployable, and the
 * bridge clamps whatever it reads to its own hard limits anyway.
 *
 * The plan since 2026-10-26: a warm floor in the warm window (19:00–09:00),
 * by day only on spare sun (battery ≥ 90 %) or below the day minimum (21 °C).
 * From 2026-11-02 spare sun includes what the inverter holds back (the battery
 * charging at its ~3 kW limit, or full), with the rooms set `solar.boost`
 * warmer while it heats on it.
 */

export interface AutomationConfig {
  enabled: boolean;
  dryRun: boolean;
  /** "Pausar": until then nothing switches the pump on by itself (ms; null = not paused). */
  pauseUntil: number | null;
  comfort: number;
  warm: { from: string; to: string };
  /**
   * Several warm windows (from 2026-10-28: 19–23 and 06–10, to measure how the
   * house cools between them). Stored only when there is more than one; the
   * bridge then ignores `warm`. Not editable here yet: shown read-only.
   */
  windows?: Array<{ from: string; to: string }>;
  dayMin: number;
  solar: {
    enabled: boolean; socOn: number; pumpW: number; exportW: number;
    /** Or the battery charging at least this fast (at its limit, the panels held back), W. */
    chargeW: number;
    /** Heating on sun, it carries on while the battery still charges at least this fast, W. */
    keepChargeW: number;
    /** Heating on sun, the rooms this much above the temperature (up to the maximum), °C. */
    boost: number;
  };
  flow: { enabled: boolean; at15: number; slope: number; min: number; max: number };
  recovery: { enabled: boolean };
  rest: { enabled: boolean; minutes: number };
  pumpFollowsZones: { enabled: boolean; idleMin: number; minOnMin: number; minOffMin: number };
  limits: { roomMin: number; roomMax: number };
}

export const DEFAULT_AUTOMATION: AutomationConfig = {
  enabled: false,
  dryRun: true,
  pauseUntil: null,
  comfort: 24,
  warm: { from: '19:00', to: '09:00' },
  dayMin: 21,
  solar: { enabled: true, socOn: 90, pumpW: 3300, exportW: 500, chargeW: 2700, keepChargeW: 1500, boost: 0 },
  flow: { enabled: true, at15: 30, slope: 0.8, min: 28, max: 45 },
  recovery: { enabled: true },
  rest: { enabled: true, minutes: 60 },
  pumpFollowsZones: { enabled: true, idleMin: 20, minOnMin: 30, minOffMin: 15 },
  limits: { roomMin: 21, roomMax: 25 },
};

export interface AutomationAction {
  at: number;
  device: string;
  what: string;
  sent: boolean;
  error?: string;
}

/** Mirrors the bridge's WarmPlan. */
export interface WarmPlan {
  from: string;
  to: string;
  inWindow: boolean;
  nextStart: number;
  end: number;
  warmupAt: number | null;
  warmupStarted: boolean;
  leadMin: number;
  capped: boolean;
  need: number;
  expectedAt: number | null;
}

export interface AutomationStatus {
  enabled: boolean;
  dryRun: boolean;
  state: 'off' | 'running' | 'dry-run';
  /** The pause in force, ms it ends; null = not paused. Absent on a bridge from before 2026-10-26. */
  pausedUntil?: number | null;
  /** The settings shown on top. Absent on an older bridge; `solar` from 2026-11-02. */
  settings?: {
    warmFrom: string; warmTo: string; comfort: number; dayMin: number; socOn: number; windows?: Array<{ from: string; to: string }>;
    solar?: { enabled: boolean; boost: number };
  };
  /** 'warm' = horário quente; 'warmup' = a aquecer para ele; 'day'. */
  mode?: 'warm' | 'warmup' | 'day';
  wantOn?: boolean;
  /** What it is doing now and why, one sentence. */
  doing?: string;
  /** Today's plan in plain words. */
  plan?: string;
  warm?: WarmPlan;
  /** `batteryW` (> 0 charging) from 2026-11-02. */
  solar?: { on: boolean; soc: number | null; spareW: number | null; batteryW?: number | null; note: string };
  dayMinActive?: boolean;
  meanRoom?: number;
  roomTarget?: number;
  outdoor?: number;
  flowTarget?: number;
  flowCorrection?: number;
  /** The water setpoint was changed by hand: left alone until the plan moves from day to warm or back. */
  flowManual?: boolean;
  /** Rooms well below target: water at the top of the range until they reach it. */
  recovery?: boolean;
  /** How far below their targets the rooms are, on average, °C. */
  shortfall?: number;
  pumpHold?: string;
  /** Asking the E13 guard to keep its rest going (the plan has the pump off). */
  holdRest?: boolean;
  /** The automation's own rest at the setpoint (guard off), until when. */
  restUntil?: number;
  switchOns24h?: number;
  warmBy?: WarmByStatus | null;
  model?: WarmupModel;
  zones: Array<{ id: string; name: string; note: string }>;
  reasons: string[];
  actions: AutomationAction[];
  evaluatedAt: number;
}

/** Mirrors `domotics-bridge/src/warmby.ts`. */
export interface WarmByStatus {
  at: number;
  target: number;
  setAt: number | null;
  source: string | null;
  phase: 'waiting' | 'heating' | 'holding' | 'done';
  startAt: number;
  leadMin: number;
  current: number | null;
  expectedAt: number | null;
  late: boolean;
  outcome: { mean: number; reached: boolean } | null;
  note: string;
}

/** How the house is seen to warm up, learned by the bridge. */
export interface WarmupModel {
  floorMin: number;
  roomRatePerH: number;
  floorSamples: number;
  roomSamples: number;
}

const REF = () => doc(db, 'domotics_config', 'automation');

type Stored = Partial<Omit<AutomationConfig, 'pauseUntil'>> & { pauseUntil?: unknown };

/** Stored settings over the defaults, section by section, so a partial document still reads whole. */
function merge(stored: Stored | undefined): AutomationConfig {
  const s = stored ?? {};
  const d = DEFAULT_AUTOMATION;
  const pause = s.pauseUntil;
  return {
    ...d,
    ...s,
    pauseUntil: typeof pause === 'number' ? pause
      : pause && typeof (pause as { toMillis?: unknown }).toMillis === 'function' ? (pause as { toMillis: () => number }).toMillis()
      : null,
    warm: { ...d.warm, ...s.warm },
    solar: { ...d.solar, ...s.solar },
    flow: { ...d.flow, ...s.flow },
    recovery: { ...d.recovery, ...s.recovery },
    rest: { ...d.rest, ...s.rest },
    pumpFollowsZones: { ...d.pumpFollowsZones, ...s.pumpFollowsZones },
    limits: { ...d.limits, ...s.limits },
  };
}

/** Owner only (firestore.rules): anyone else, and anything signed out, gets permission-denied. */
export async function loadAutomationConfig(): Promise<AutomationConfig> {
  const snap = await getDoc(REF());
  return merge(snap.exists() ? (snap.data() as Stored) : undefined);
}

/**
 * The settings form. A field-level merge that leaves the pause alone (it is set
 * from the card's buttons, possibly after this form was loaded) and clears the
 * periods the 2026-10-26 plan removed, which the bridge ignores anyway.
 */
export async function saveAutomationConfig(cfg: AutomationConfig) {
  const { pauseUntil: _pause, ...settings } = cfg;
  await setDoc(REF(), {
    ...settings,
    preheat: deleteField(),
    evening: deleteField(),
    solarBoost: deleteField(),
  }, { merge: true });
}

/** "Ligar": the automation runs live (switches the pump and sets the thermostats). One field-level write. */
export async function goLive() {
  await setDoc(REF(), { enabled: true, dryRun: false }, { merge: true });
}

/** Back to simulating: decides and shows, sends nothing. */
export async function backToDryRun() {
  await setDoc(REF(), { enabled: true, dryRun: true }, { merge: true });
}

/** "Pausar" until `until` (ms), or "Retomar" with null. */
export async function setPause(until: number | null) {
  await setDoc(REF(), { pauseUntil: until }, { merge: true });
}

/**
 * "Warm by HH:MM" goes through the `domoticsWarmBy` callable, not a document
 * write: the rules let no client write `domotics_config/warm_by`, so every
 * request — from here or, later, the chat — is checked in one place. The
 * bridge picks it up within two minutes and reports its plan in its status.
 */
export async function setWarmBy(time: string, target: number) {
  return (await warmByFn({ time, target, source: 'app' })).data;
}

export async function clearWarmBy() {
  await warmByFn({ clear: true });
}
