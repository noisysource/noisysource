/**
 * "Have the house warm by HH:MM": a one-off target for the heating automation.
 * Asked from the app (later also from the chat) through the `domoticsWarmBy`
 * callable (functions/src/domotics/warmBy.ts), which stores it in
 * `domotics_config/warm_by`; the bridge reads it with the automation settings.
 *
 * The start time comes from how this house warms up:
 * - the floor: once the pump starts, the water leaving it is warm within
 *   ~15 min, but the return water (the slab) keeps climbing for another hour
 *   or so before it levels off. In the 20-s log of 22–24/10 that took 60–105
 *   min, from cold and after the guard's 60-min rests alike (the pump runs at
 *   full speed either way, so the start temperature hardly matters).
 *   Default 90 min.
 * - the rooms: once the floor is warm they rise ~0.3 °C an hour (observed).
 * Both are refined from what the bridge sees as it runs: each start of the
 * pump after a stop measures the floor, and each stretch of rooms below target
 * with a warm floor measures how fast they rise. The incidents data has no
 * room temperatures, so the rooms can only be learned live.
 *
 * Pure, like automation.ts: index.ts persists the model.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface WarmByRequest {
  /** When the house should be warm, ms since the epoch. */
  at: number;
  /** °C; null = the comfort temperature. */
  target: number | null;
  setAt: number | null;
  /** 'app', 'chat'… */
  source: string | null;
}

const time = (v: unknown) =>
  v instanceof Date ? v.getTime() : typeof v === 'number' && Number.isFinite(v) ? v : null;

/** From the Firestore document (Dates) or the disk cache (numbers). Anything unusable is no request. */
export function parseWarmBy(raw: unknown): WarmByRequest | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const at = time(r.at);
  if (at === null) return null;
  return {
    at,
    target: typeof r.target === 'number' && Number.isFinite(r.target) ? r.target : null,
    setAt: time(r.setAt),
    source: typeof r.source === 'string' ? r.source : null,
  };
}

// ---------------------------------------------------------------------------
// The warm-up model, and how it is learned
// ---------------------------------------------------------------------------

export interface WarmupModel {
  /** Minutes from the pump starting until the floor (the return water) stops climbing. */
  floorMin: number;
  /** How fast the rooms rise once the floor is warm, °C per hour. */
  roomRatePerH: number;
  /** How many observations each figure is built on (0 = still the starting value). */
  floorSamples: number;
  roomSamples: number;
}

export const DEFAULT_MODEL: WarmupModel = { floorMin: 90, roomRatePerH: 0.3, floorSamples: 0, roomSamples: 0 };

const FLOOR_BOUNDS = { lo: 30, hi: 180 };
const ROOM_BOUNDS = { lo: 0.1, hi: 1 };
/** Each new observation moves the figure this far towards itself. */
const ALPHA = 0.3;
/** A stop this long and the floor counts as cold again. */
const STOP_RESETS_MS = 30 * MIN;
/** The floor is warm when the return water rose less than this over half an hour. */
const LEVEL_RISE = 0.5;
/** Give up measuring a start that hasn't levelled off by then. */
const FLOOR_GIVE_UP_MS = 4 * HOUR;
/** A room counts as short (and so should be rising) this far below its target. */
const ROOM_SHORT = 0.3;
const ROOM_WINDOW_MS = 2 * HOUR;
const ROOM_WINDOW_MIN_MS = HOUR;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;

export function parseModel(raw: unknown): WarmupModel {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_MODEL;
  return {
    floorMin: num(r.floorMin, d.floorMin, FLOOR_BOUNDS.lo, FLOOR_BOUNDS.hi),
    roomRatePerH: num(r.roomRatePerH, d.roomRatePerH, ROOM_BOUNDS.lo, ROOM_BOUNDS.hi),
    floorSamples: num(r.floorSamples, 0, 0, 1e6),
    roomSamples: num(r.roomSamples, 0, 0, 1e6),
  };
}

export interface WarmupObservation {
  t: number;
  /** Compressor running (pump on, Hz > 0, no fault). */
  running: boolean;
  /** Return water, °C. */
  waterIn?: number;
  /** Zones online with both a reading and a target. */
  zones: Array<{ id: string; current: number; target: number }>;
  /** The pump can heat: on, or resting at the setpoint by the automation (not off by hand, not faulted). */
  available: boolean;
}

export function createWarmupLearner(initial: WarmupModel = DEFAULT_MODEL) {
  let m: WarmupModel = { ...initial };
  /** When the compressor last started after a long stop; null = stopped long enough to be cold. */
  let runningSince: number | null = null;
  let stoppedSince: number | null = null;
  /** Measuring the floor of this start (only a start after a long stop is measured). */
  let measuring = false;
  const returns: Array<{ t: number; v: number }> = [];
  let win: { t0: number; temps: Map<string, number> } | null = null;

  function learn(which: 'floor' | 'room', v: number) {
    if (which === 'floor') {
      m = { ...m, floorMin: Math.round(clamp(m.floorMin + ALPHA * (v - m.floorMin), FLOOR_BOUNDS.lo, FLOOR_BOUNDS.hi)), floorSamples: m.floorSamples + 1 };
    } else {
      const next = m.roomRatePerH + ALPHA * (v - m.roomRatePerH);
      m = { ...m, roomRatePerH: Math.round(clamp(next, ROOM_BOUNDS.lo, ROOM_BOUNDS.hi) * 100) / 100, roomSamples: m.roomSamples + 1 };
    }
  }

  const maxOf = (from: number, to: number) => {
    let best: number | undefined;
    for (const r of returns) if (r.t >= from && r.t < to && (best === undefined || r.v > best)) best = r.v;
    return best;
  };

  function floorWarm(t: number) {
    return runningSince !== null && t - runningSince >= m.floorMin * MIN;
  }

  return {
    observe(o: WarmupObservation) {
      const { t } = o;

      // --- The floor: from a start after a long stop to the return water levelling off.
      if (o.running) {
        if (stoppedSince !== null && t - stoppedSince >= STOP_RESETS_MS) {
          runningSince = t;
          measuring = true;
          returns.length = 0;
        } else if (runningSince === null) {
          // Running when first seen, or after a stop too short to tell: start unknown, not measured.
          runningSince = t;
          measuring = false;
        }
        stoppedSince = null;
        if (measuring && o.waterIn !== undefined) {
          returns.push({ t, v: o.waterIn });
          while (returns.length > 0 && returns[0].t < t - 45 * MIN) returns.shift();
          const elapsed = t - runningSince;
          if (elapsed >= 30 * MIN) {
            // Highest readings, so a defrost's dip doesn't pass for the floor levelling off.
            const recent = maxOf(t - 10 * MIN, t + 1);
            const earlier = maxOf(t - 40 * MIN, t - 30 * MIN);
            if (recent !== undefined && earlier !== undefined && recent - earlier < LEVEL_RISE) {
              learn('floor', elapsed / MIN);
              measuring = false;
            } else if (elapsed >= FLOOR_GIVE_UP_MS) {
              measuring = false;
            }
          }
        }
      } else {
        stoppedSince ??= t;
        if (t - stoppedSince >= STOP_RESETS_MS) {
          runningSince = null;
          measuring = false;
        }
      }

      // --- The rooms: how fast the short ones rise while the floor is warm.
      if (!o.available) {
        win = null;
      } else if (!win) {
        const short = o.zones.filter(z => z.target - z.current > ROOM_SHORT);
        if (floorWarm(t) && short.length > 0) win = { t0: t, temps: new Map(short.map(z => [z.id, z.current])) };
      } else {
        const elapsed = t - win.t0;
        const byId = new Map(o.zones.map(z => [z.id, z]));
        const ids = [...win.temps.keys()].filter(id => byId.has(id));
        const reached = ids.every(id => byId.get(id)!.current >= byId.get(id)!.target - 0.1);
        if (ids.length === 0) {
          win = null;
        } else if (elapsed >= ROOM_WINDOW_MS || (reached && elapsed >= ROOM_WINDOW_MIN_MS)) {
          const rise = ids.reduce((a, id) => a + (byId.get(id)!.current - win!.temps.get(id)!), 0) / ids.length;
          const rate = rise / (elapsed / HOUR);
          if (rate >= 0 && rate <= 2) learn('room', rate);
          win = null;
        } else if (reached) {
          win = null;
        }
      }
    },
    /** Minutes until the floor is warm, if heating started now (or carries on). */
    floorWarmIn(t: number) {
      return runningSince === null ? m.floorMin : Math.max(0, m.floorMin - (t - runningSince) / MIN);
    },
    model: (): WarmupModel => m,
  };
}

// ---------------------------------------------------------------------------
// The plan for one request
// ---------------------------------------------------------------------------

export type WarmByPhase = 'waiting' | 'heating' | 'holding' | 'done';

export interface WarmByStatus {
  at: number;
  target: number;
  setAt: number | null;
  source: string | null;
  phase: WarmByPhase;
  /** When heating starts, or started. */
  startAt: number;
  /** Minutes of heating it needs from now, margin included. */
  leadMin: number;
  /** The rooms' mean now. */
  current: number | null;
  /** When the rooms should reach the target. */
  expectedAt: number | null;
  /** Expected after `at`. */
  late: boolean;
  /** How the house was at `at`. */
  outcome: { mean: number; reached: boolean } | null;
  /** In Portuguese, for the app. */
  note: string;
}

/** Started this much earlier than the model says, for what it gets wrong. */
export const WARM_MARGIN_MIN = 30;
/** After `at`, the target is held this long, then the request is done. */
export const WARM_HOLD_MS = HOUR;
const MAX_LEAD_MIN = 18 * 60;
/** Without room readings, plan for this much to make up. */
const UNKNOWN_NEED = 1;

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
const deg = (v: number) => `${v.toFixed(1).replace(/\.0$/, '')}°`;

/** Minutes of heating from now to bring the rooms up by `need` °C, margin included. */
export function leadMinutes(need: number, floorWarmInMin: number, model: WarmupModel) {
  if (need <= 0.1) return 0;
  return Math.min(MAX_LEAD_MIN, Math.round(floorWarmInMin + (need / model.roomRatePerH) * 60 + WARM_MARGIN_MIN));
}

export function planWarmBy(o: {
  request: WarmByRequest;
  now: number;
  target: number;
  current?: number;
  floorWarmInMin: number;
  model: WarmupModel;
  /** Heating for this request has already started (it doesn't go back to waiting). */
  started: boolean;
  outcome: { mean: number; reached: boolean } | null;
}): WarmByStatus {
  const { request, now, target, current, model } = o;
  const { at } = request;
  const need = current === undefined ? UNKNOWN_NEED : Math.max(0, target - current);
  const lead = leadMinutes(need, o.floorWarmInMin, model);
  const startAt = at - lead * MIN;
  const phase: WarmByPhase = now >= at + WARM_HOLD_MS ? 'done'
    : now >= at ? 'holding'
    : o.started || now >= startAt ? 'heating'
    : 'waiting';
  const expectedAt = need <= 0.1 ? null
    : phase === 'heating' ? now + Math.max(0, lead - WARM_MARGIN_MIN) * MIN
    : phase === 'waiting' ? at - WARM_MARGIN_MIN * MIN
    : null;
  const late = expectedAt !== null && expectedAt > at;
  const how = `faltam ${deg(need)} · chão ~${Math.round(o.floorWarmInMin)} min + divisões a ${model.roomRatePerH.toFixed(2).replace('.', ',')}°/h + ${WARM_MARGIN_MIN} min de margem`;

  let note: string;
  if (phase === 'done' || phase === 'holding') {
    const r = o.outcome;
    note = !r ? `Pedido para as ${hhmm(at)}.`
      : r.reached ? `Às ${hhmm(at)} a casa estava a ${deg(r.mean)} (alvo ${deg(target)}).`
      : `Às ${hhmm(at)} a casa estava a ${deg(r.mean)}, abaixo do alvo ${deg(target)}.`;
    if (phase === 'holding') note += ` Mantém ${deg(target)} até às ${hhmm(at + WARM_HOLD_MS)}.`;
  } else if (phase === 'heating') {
    note = need <= 0.1 ? `Já está a ${deg(target)} — mantém até às ${hhmm(at)}.`
      : `A aquecer: ${how}. Previsto às ${hhmm(expectedAt!)}${late ? ', depois da hora pedida' : ''}.`;
    if (current === undefined) note = `Sem leituras das divisões — a aquecer por precaução desde as ${hhmm(startAt)}.`;
  } else {
    note = need <= 0.1 ? `Já está a ${deg(target)}. Mantém até às ${hhmm(at)}.`
      : `Começa a aquecer às ${hhmm(startAt)} (${how}).`;
    if (current === undefined) note = `Sem leituras das divisões — começa às ${hhmm(startAt)} por precaução.`;
  }

  return {
    at,
    target,
    setAt: request.setAt,
    source: request.source,
    phase,
    startAt,
    leadMin: lead,
    current: current === undefined ? null : Math.round(current * 10) / 10,
    expectedAt,
    late,
    outcome: o.outcome,
    note,
  };
}
