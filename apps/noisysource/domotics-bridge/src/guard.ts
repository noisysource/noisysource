/**
 * E13 guard for the floor-heating heat pump, until the technicians fix it.
 * Moved into the bridge from `deploy/e13-guard.py`, which ran by hand on the Pi
 * from 2026-10-23; same rules and thresholds.
 *
 * Every E13 logged (7 trips, 21–22/10) came the same way: the water reached the
 * setpoint, the compressor dropped to its minimum (35–45 Hz) and idled there
 * for 4–25 minutes, then sped up again and tripped within a minute. Starts from
 * standstill never tripped (11 of 11). So instead of letting it idle at the
 * setpoint, switch it off there and back on after a rest — the slab holds the
 * heat. Two trips within ~15 minutes lock the pump out until someone resets it,
 * so after a trip it is switched off at once, before the automatic restart can
 * trip a second time, and rests longer.
 *
 * Switched off from outside the bridge (the panel, SmartLife, a timer — every
 * night at 23:54 UTC since 21/10, from the pump itself), the pump is switched
 * back on after REON_AFTER_MS (Renato, 2026-10-26) — but only while the
 * heating automation is off or in dry-run. Running live, the automation owns
 * on/off whoever switched the pump (`automationOwns`), so the guard leaves that
 * to it. An off through the app or the automation is respected. Switched off
 * from outside again within INSIST_MS of our switch-on, or after
 * REON_MAX_PER_DAY switch-ons, it is left off until someone switches it on:
 * someone means it, and the guard never fights a timer in a loop. Settings: one
 * on/off, `domotics_config/guard`, set in the app. Switched off while resting,
 * the guard switches the pump back on — it never leaves the house with the pump
 * parked by us.
 *
 * A person's pause ("Pausar" in the app, `domotics_config/automation`
 * `pauseUntil`) stops every switch-on here: no re-on after an outside off (one
 * seen during the pause is not undone later), and a rest that ends meanwhile
 * carries on until the pause does. The protective switch-offs still happen.
 *
 * Since 26/10 the pump has tripped in a new way: E13 9–11 min into every run,
 * far below the setpoint, so the idle rule never sees it coming. The early
 * warning (preempt.ts, on unless `domotics_config/guard` has `preempt: false`)
 * catches the discharge jump 1–2 min before the trip: the pump is switched off
 * and rests REST_PREEMPT_MS, then the rest ends like any other (back on, or
 * held by the live automation / a pause). After PREEMPT_MAX_PER_HOUR stops in
 * an hour the next rest is REST_PREEMPT_LONG_MS. It trips anyway (also during
 * that rest): the usual REST_AFTER_TRIP_MS. Two trips within
 * PREEMPT_TRIPS_WINDOW_MS with the warning on: it isn't helping, and the
 * warning is switched off for PREEMPT_OFF_MS, so a pump that trips anyway
 * isn't cycled for nothing. Switching it off in the app (or the guard) forgets
 * all that. The idle rule comes first when both apply: its rest is longer.
 *
 * With the heating automation running live, a rest doesn't end on the clock
 * alone: while the automation's plan has the pump off it asks (`holdRest`) for
 * the rest to carry on, and it ends as soon as the plan wants heat. The
 * automation never switches on a pump the guard has parked.
 *
 * Pure: it decides, index.ts sends, and the new state is only taken once the
 * command has gone through (a failed command is decided again next poll).
 */

import type { SwitchSource } from './incidents';
import { dayStart, lisbonDate, lisbonOffsetMs } from './energy';
import { INITIAL_WATCH, warningAt, watchDischarge, type DischargeWatch, type Precursor } from './preempt';

export interface GuardConfig {
  enabled: boolean;
  /** The E13 early warning (preempt.ts). A document without the field means on. */
  preempt: boolean;
}

export function parseGuardConfig(raw: unknown): GuardConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { enabled: r.enabled === true, preempt: r.preempt !== false };
}

const MIN = 60_000;
/** Compressor at or near its minimum. */
export const IDLE_HZ = 45;
/** Water out within this of the setpoint (a dip of 1.5 preceded the 20:30 trip on 22/10). */
export const NEAR_SETPOINT = 1.5;
/** The idle rule is ignored this long after the pump is switched on. */
export const GRACE_MS = 4 * MIN;
export const REST_PREVENTIVE_MS = 60 * MIN;
export const REST_AFTER_TRIP_MS = 120 * MIN;
/** Still faulted this soon after switching on = locked out. */
const LOCKOUT_CHECK_MS = 3 * MIN;
/** After an off from outside: compressor stopped, the pump's own restart delay long over. */
export const REON_AFTER_MS = 5 * MIN;
/** Off from outside again this soon after our switch-on: someone means it, leave it off. */
export const INSIST_MS = 60 * MIN;
export const REON_MAX_PER_DAY = 6;
const DAY = 24 * 60 * MIN;
/**
 * Rest after the early warning. The pump has its own ~2-min restart delay, and
 * on 27/10 a 3-min rest gave the same 10-min run as a 4.8-h one.
 */
export const REST_PREEMPT_MS = 5 * MIN;
/** Early-warning stops in the last hour before the next one rests longer… */
export const PREEMPT_MAX_PER_HOUR = 5;
/** …this long. */
export const REST_PREEMPT_LONG_MS = 30 * MIN;
/** Two E13 trips this close with the early warning on… */
export const PREEMPT_TRIPS_WINDOW_MS = 6 * 60 * MIN;
/** …switch it off for this long. */
export const PREEMPT_OFF_MS = DAY;
const HOUR = 60 * MIN;

export type GuardMode = 'off' | 'watch' | 'rest' | 'lockout';

/** Persisted across bridge restarts, so a rest in progress still ends with the pump switched back on. */
export interface GuardState {
  mode: GuardMode;
  restUntil: number;
  /** When the pump was last seen switched on (0 = long enough ago). */
  switchedOnAt: number;
  /** On at the previous reading, so a switch-on by anyone starts the grace period. */
  lastSeenOn: boolean | null;
  lastAction: { at: number; what: 'on' | 'off'; reason: string } | null;
  /** When the pump was switched off from outside, waiting to be switched back on (0 = none). */
  offOutsideAt: number;
  /** Our switch-ons after an off from outside, last 24 h. */
  reons: number[];
  /** Left off from outside on purpose: why (null = not). */
  leftOffWhy: string | null;
  /** The early warning's view of the current run (preempt.ts). */
  discharge: DischargeWatch;
  /** In fault at the previous fresh reading (null = not known): a trip is a fault that wasn't there. */
  lastSeenFault: boolean | null;
  /** The rest in progress came from the early warning (null = another rest, or none). */
  restKind: 'preempt' | null;
  /** Early-warning stops, last 24 h. */
  preemptStops: number[];
  lastPreempt: { at: number; reason: string } | null;
  /** E13 trips seen with the early warning on, last PREEMPT_TRIPS_WINDOW_MS. */
  preemptTrips: number[];
  /** Switched off after two trips anyway, until then (0 = not). */
  preemptOffUntil: number;
}

/** The early warning, for the app. */
export interface PreemptStatus {
  /** On in the app, with the guard on. */
  enabled: boolean;
  /** Enabled, and not switched off after two trips anyway. */
  active: boolean;
  /** Stops since midnight (Lisbon). */
  stopsToday: number;
  lastStop: { at: number; reason: string } | null;
  /** Switched off after two trips anyway, until then. */
  offUntil: number | null;
  /** One line, in Portuguese. */
  note: string;
}

export interface GuardStatus {
  enabled: boolean;
  mode: GuardMode;
  restUntil: number | null;
  /** What it's doing, in Portuguese, for the app. */
  note: string;
  lastAction: GuardState['lastAction'];
  /** When it will switch back on a pump switched off from outside (null = not waiting, or waiting for heat to be wanted). */
  reonAt: number | null;
  /** A person's pause in force: no switch-ons until then (ms). */
  pausedUntil: number | null;
  /** The live heating automation decides on/off: no re-on after an outside off from here. */
  automationOwns: boolean;
  /** The E13 early warning (absent from a bridge older than 2026-10-27). */
  preempt: PreemptStatus;
  evaluatedAt: number;
}

export interface GuardInput {
  now: number;
  /** Absent when this poll has no fresh reading of the pump. */
  pump?: {
    on: boolean;
    hz: number;
    sp?: number;
    out?: number;
    /** Discharge (C01) and coil (C00), for the early warning. */
    dis?: number;
    coil?: number;
    faults: string[];
  };
  /** From the heating automation (live only): its plan has the pump off, so a rest that is due to end carries on. */
  holdRest?: boolean;
  /** A person's pause in force (ms it ends): the guard switches nothing on until then. */
  pausedUntil?: number | null;
  /** The heating automation is running live (and recently): it, not the guard, undoes an off from outside. */
  automationOwns?: boolean;
  /** Who caused the on/off this reading shows, from the incident recorder; absent when it shows none. */
  switchedBy?: SwitchSource;
}

export interface GuardDecision {
  status: GuardStatus;
  /** A switch to send; `next` is the state to take once it has gone through. */
  action?: { on: boolean; reason: string; next: GuardState };
}

/** Every field has a default here: a guard-state.json from an older bridge is spread over this. */
export const INITIAL_GUARD: GuardState = {
  mode: 'off', restUntil: 0, switchedOnAt: 0, lastSeenOn: null, lastAction: null, offOutsideAt: 0, reons: [], leftOffWhy: null,
  discharge: INITIAL_WATCH, lastSeenFault: null, restKind: null, preemptStops: [], lastPreempt: null, preemptTrips: [], preemptOffUntil: 0,
};

/** "HH:MM" in Lisbon, whatever the machine's time zone (energy.ts does the clock change). */
const hhmm = (ms: number) => new Date(ms + lisbonOffsetMs(ms)).toISOString().slice(11, 16);
/** "às HH:MM", or "amanhã às HH:MM" when it's another day in Lisbon. */
const atTime = (ms: number, now: number) => `${lisbonDate(ms) !== lisbonDate(now) ? 'amanhã ' : ''}às ${hhmm(ms)}`;
/** One decimal with a comma, as written in Portugal. */
const deg = (v: number) => String(Math.round(v * 10) / 10).replace('.', ',');

function preemptStatus(cfg: GuardConfig, now: number, st: GuardState): PreemptStatus {
  const enabled = cfg.enabled && cfg.preempt;
  const offUntil = enabled && st.preemptOffUntil > now ? st.preemptOffUntil : null;
  const today = dayStart(lisbonDate(now));
  const stopsToday = st.preemptStops.filter(t => t >= today && t <= now).length;
  const note = !cfg.enabled ? 'Antecipação do E13 desligada (a proteção está desligada)'
    : !cfg.preempt ? 'Antecipação do E13 desligada'
    : offUntil ? `Antecipação desligada até ${atTime(offUntil, now)}: dois E13 mesmo assim`
    : stopsToday === 0 ? 'Antecipa o E13 — hoje ainda não foi preciso desligá-la'
    : `Antecipa o E13 — desligou ${stopsToday} ${stopsToday === 1 ? 'vez' : 'vezes'} hoje antes do disparo`;
  return { enabled, active: enabled && !offUntil, stopsToday, lastStop: st.lastPreempt, offUntil, note };
}

/** The reason on the switch incident and in the Registo, e.g. "descarga a subir 44 → 50,5 °C em 30 s aos 9 min — …". */
function preemptReason(w: Precursor, until: number, now: number, lastHour: number, ctx: { paused: number | null; automationOwns: boolean }): string {
  const what = `descarga a subir ${deg(w.from)} → ${deg(w.to)} °C em ${w.seconds} s aos ${w.runMin} min — desligada antes do E13`;
  const then = ctx.paused ? `; em pausa, só volta a ligar depois das ${hhmm(ctx.paused)}`
    : ctx.automationOwns ? `; descansa até ${atTime(until, now)} e depois decide a automação`
    : `, volta a ligar ${atTime(until, now)}`;
  const long = lastHour >= PREEMPT_MAX_PER_HOUR ? ` (já ${lastHour} vezes na última hora: descanso de ${REST_PREEMPT_LONG_MS / MIN} min)` : '';
  return what + then + long;
}

interface Ctx { pausedUntil: number | null; automationOwns: boolean }
const NO_CTX: Ctx = { pausedUntil: null, automationOwns: false };

export function createGuard(initial: Partial<GuardState> = INITIAL_GUARD) {
  // Over the defaults, so a state saved by an older bridge has every field.
  let s: GuardState = { ...INITIAL_GUARD, ...initial };

  function status(cfg: GuardConfig, now: number, st: GuardState, held = false, ctx: Ctx = NO_CTX): GuardStatus {
    const { pausedUntil, automationOwns } = ctx;
    const pause = pausedUntil ? `em pausa até às ${hhmm(pausedUntil)}` : '';
    const note = !cfg.enabled ? 'Desligada'
      : st.mode === 'rest' && held && pause ? `Bomba em descanso — ${pause}: não volta a ligar antes disso`
      : st.mode === 'rest' && held ? `Bomba em descanso desde as ${hhmm(st.lastAction?.at ?? st.restUntil)} — a automação não quer calor agora; liga quando quiser`
      : st.mode === 'rest' ? `Bomba em descanso até às ${hhmm(st.restUntil)}`
      : st.mode === 'lockout' ? 'Bomba bloqueada em avaria — precisa de rearme (painel, disjuntor ou técnicos)'
      : pause ? `A vigiar — ${pause}: desliga a bomba se for preciso, mas não a liga`
      : st.offOutsideAt && held ? `Bomba desligada de fora às ${hhmm(st.offOutsideAt)} — liga quando uma zona pedir calor (automação)`
      : st.offOutsideAt ? `Bomba desligada de fora às ${hhmm(st.offOutsideAt)} — volta a ligar às ${hhmm(st.offOutsideAt + REON_AFTER_MS)}`
      : st.leftOffWhy ? `Bomba desligada de fora — ${st.leftOffWhy}`
      : automationOwns ? 'A vigiar — desliga a bomba quando fica parada no setpoint; ligar e desligar é com a automação'
      : 'A vigiar — desliga a bomba quando fica parada no setpoint e volta a ligá-la se for desligada de fora';
    const preempt = preemptStatus(cfg, now, st);
    return {
      enabled: cfg.enabled,
      mode: cfg.enabled ? st.mode : 'off',
      restUntil: st.mode === 'rest' ? st.restUntil : null,
      // Why it no longer stops the pump before a trip belongs with what it's doing.
      note: preempt.offUntil ? `${note}. ${preempt.note}` : note,
      lastAction: st.lastAction,
      reonAt: cfg.enabled && st.mode === 'watch' && st.offOutsideAt && !held ? st.offOutsideAt + REON_AFTER_MS : null,
      pausedUntil: pausedUntil ?? null,
      automationOwns: !!automationOwns,
      preempt,
      evaluatedAt: now,
    };
  }

  function decide(cfg: GuardConfig, input: GuardInput): GuardDecision {
    const { now, pump } = input;
    const paused = input.pausedUntil && now < input.pausedUntil ? input.pausedUntil : null;
    const ctx: Ctx = { pausedUntil: paused, automationOwns: !!input.automationOwns };
    const act = (on: boolean, reason: string, next: Omit<GuardState, 'lastAction'>): GuardDecision => {
      const full: GuardState = { ...next, lastAction: { at: now, what: on ? 'on' : 'off', reason } };
      return { status: status(cfg, now, full, false, ctx), action: { on, reason, next: full } };
    };

    // The early warning sees every fresh reading, whatever the mode, so it
    // knows when the run started; a trip is a fault that wasn't there before.
    let tripped = false;
    if (pump) {
      const fault = pump.faults.length > 0;
      tripped = fault && s.lastSeenFault === false;
      const { watch } = watchDischarge(s.discharge ?? INITIAL_WATCH, { t: now, on: pump.on, hz: pump.hz, dis: pump.dis, coil: pump.coil, faults: pump.faults });
      s = { ...s, discharge: watch, lastSeenFault: fault };
    }
    // Switched off (the warning or the whole guard): forgotten, so switching it on starts afresh.
    const preemptOn = cfg.enabled && cfg.preempt;
    s = preemptOn
      ? {
          ...s,
          preemptStops: s.preemptStops.filter(t => now - t < DAY),
          preemptTrips: s.preemptTrips.filter(t => now - t < PREEMPT_TRIPS_WINDOW_MS),
          preemptOffUntil: s.preemptOffUntil > now ? s.preemptOffUntil : 0,
        }
      : { ...s, preemptStops: s.preemptStops.filter(t => now - t < DAY), preemptTrips: [], preemptOffUntil: 0 };
    if (tripped && preemptOn && !s.preemptOffUntil) {
      const trips = [...s.preemptTrips, now];
      s = trips.length >= 2 ? { ...s, preemptTrips: [], preemptOffUntil: now + PREEMPT_OFF_MS } : { ...s, preemptTrips: trips };
    }
    const preemptActive = preemptOn && !s.preemptOffUntil;

    if (!cfg.enabled) {
      // Switched off while it had the pump parked: give the pump back — unless
      // a person has paused the heating, which means off.
      if (s.mode === 'rest' && pump && !pump.on && !paused) {
        return act(true, 'proteção desligada na app — a bomba volta a ligar', { ...s, mode: 'off' });
      }
      // An off from outside seen meanwhile is not ours to undo once switched back on.
      if (s.mode !== 'rest' || pump?.on || paused) s = { ...s, mode: 'off', offOutsideAt: 0, leftOffWhy: null };
      return { status: status(cfg, now, s, false, ctx) };
    }
    if (s.mode === 'off') s = { ...s, mode: 'watch', switchedOnAt: 0 };
    // Nothing fresh to go on: do nothing rather than act on an old reading.
    if (!pump) return { status: status(cfg, now, s, false, ctx) };
    // Switched on by anyone: the same grace as after our own switch-on, and a
    // fault right after it is a lockout, not a fresh trip to rest from.
    const turnedOn = pump.on && s.lastSeenOn === false;
    const turnedOff = !pump.on && s.lastSeenOn === true;
    s = { ...s, lastSeenOn: pump.on, switchedOnAt: turnedOn ? now : s.switchedOnAt };
    // On again, by anyone: nothing left to undo. Paused, or with the live
    // automation deciding, an off from outside is not the guard's to undo.
    if ((pump.on || paused || ctx.automationOwns) && (s.offOutsideAt || s.leftOffWhy)) s = { ...s, offOutsideAt: 0, leftOffWhy: null };
    const held = !!input.holdRest || !!paused;

    const fault = pump.faults.length > 0;
    switch (s.mode) {
      case 'rest':
        if (s.restKind === 'preempt' && fault) {
          // Tripped anyway, as it was being switched off: the rest after a trip.
          s = { ...s, restKind: null, restUntil: Math.max(s.restUntil, now + REST_AFTER_TRIP_MS) };
        }
        if (pump.on) {
          // Someone switched it on during the rest: theirs now.
          s = { ...s, mode: 'watch', switchedOnAt: now, restKind: null };
        } else if (now >= s.restUntil && held) {
          return { status: status(cfg, now, s, true, ctx) };
        } else if (now >= s.restUntil) {
          // Past its end by more than a poll or two: the automation or a pause was holding it.
          const reason = now - s.restUntil > 2 * MIN ? 'fim do descanso — a automação voltou a pedir calor (ou a pausa acabou)' : 'fim do descanso';
          return act(true, reason, { ...s, mode: 'watch', switchedOnAt: now, restKind: null });
        }
        break;
      case 'lockout':
        if (pump.on && !fault) s = { ...s, mode: 'watch', switchedOnAt: now };
        break;
      case 'watch':
        if (pump.on && fault) {
          if (s.switchedOnAt && now - s.switchedOnAt < LOCKOUT_CHECK_MS) {
            s = { ...s, mode: 'lockout' };
          } else {
            return act(false, `disparo ${pump.faults.join(', ')} — desligada ${REST_AFTER_TRIP_MS / MIN} min para não disparar outra vez`,
              { ...s, mode: 'rest', restUntil: now + REST_AFTER_TRIP_MS, restKind: null });
          }
        } else if (pump.on && pump.hz > 0) {
          const idling = pump.sp !== undefined && pump.out !== undefined
            && pump.hz <= IDLE_HZ && pump.out >= pump.sp - NEAR_SETPOINT && now - s.switchedOnAt > GRACE_MS;
          if (idling) {
            return act(false,
              `no setpoint a ${pump.hz} Hz, água a ${pump.out} °C — desligada ${REST_PREVENTIVE_MS / MIN} min antes de voltar a acelerar`,
              { ...s, mode: 'rest', restUntil: now + REST_PREVENTIVE_MS, restKind: null });
          }
          // The early warning (preempt.ts). Kept for the run, so a command
          // that failed is sent again next poll, for as long as it's fresh.
          const warning = preemptActive ? warningAt(s.discharge, now) : null;
          if (warning) {
            const lastHour = s.preemptStops.filter(t => now - t < HOUR).length;
            const until = now + (lastHour >= PREEMPT_MAX_PER_HOUR ? REST_PREEMPT_LONG_MS : REST_PREEMPT_MS);
            const reason = preemptReason(warning, until, now, lastHour, { paused, automationOwns: ctx.automationOwns });
            return act(false, reason, {
              ...s, mode: 'rest', restUntil: until, restKind: 'preempt',
              preemptStops: [...s.preemptStops, now], lastPreempt: { at: now, reason },
            });
          }
        } else if (!pump.on) {
          // Only an off the recorder saw happen and couldn't put down to the
          // app or the automation; an off found at start-up isn't one. Not
          // while paused (a person wants it off) or while the live automation
          // decides (it undoes the off itself, by its own plan).
          const reons = s.reons.filter(t => now - t < DAY);
          if (turnedOff && !paused && !ctx.automationOwns && (input.switchedBy === 'outside' || input.switchedBy === 'unknown')) {
            const last = reons.at(-1);
            s = last !== undefined && now - last < INSIST_MS
              ? { ...s, reons, offOutsideAt: 0, leftOffWhy: `desligada outra vez às ${hhmm(now)}, ${Math.round((now - last) / MIN)} min depois de a proteção a ter ligado: fica desligada até alguém a ligar` }
              : reons.length >= REON_MAX_PER_DAY
                ? { ...s, reons, offOutsideAt: 0, leftOffWhy: `já foi ligada ${reons.length} vezes nas últimas 24 h: fica desligada até alguém a ligar` }
                : { ...s, reons, offOutsideAt: now, leftOffWhy: null };
          }
          if (s.offOutsideAt && !fault && !held && now - s.offOutsideAt >= REON_AFTER_MS) {
            return act(true, `desligada de fora às ${hhmm(s.offOutsideAt)} — volta a ligar`,
              { ...s, offOutsideAt: 0, reons: [...reons, now], switchedOnAt: now });
          }
        }
        break;
    }
    return { status: status(cfg, now, s, s.mode === 'watch' && held, ctx) };
  }

  return {
    decide,
    /** The decision's command went through. */
    commit(next: GuardState) { s = { ...next }; },
    state: (): GuardState => s,
  };
}
