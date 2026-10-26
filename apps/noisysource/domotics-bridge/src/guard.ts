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
 * back on after REON_AFTER_MS (Renato, 2026-10-26). An off through the app or
 * the automation is respected. Switched off from outside again within
 * INSIST_MS of our switch-on, or after REON_MAX_PER_DAY switch-ons, it is left
 * off until someone switches it on: someone means it, and the guard never
 * fights a timer in a loop. Settings: one on/off, `domotics_config/guard`, set
 * in the app. Switched off while resting, the guard switches the pump back on
 * — it never leaves the house with the pump parked by us.
 *
 * With the heating automation running live, a rest doesn't end on the clock
 * alone: while no zone wants heat the automation asks (`holdRest`) for the
 * pump to stay off, and the rest ends as soon as one does. The automation
 * never switches on a pump the guard has parked.
 *
 * Pure: it decides, index.ts sends, and the new state is only taken once the
 * command has gone through (a failed command is decided again next poll).
 */

import type { SwitchSource } from './incidents';

export interface GuardConfig {
  enabled: boolean;
}

export function parseGuardConfig(raw: unknown): GuardConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { enabled: r.enabled === true };
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
    faults: string[];
  };
  /** From the heating automation (live only): no zone wants heat, so a rest that is due to end carries on. */
  holdRest?: boolean;
  /** Who caused the on/off this reading shows, from the incident recorder; absent when it shows none. */
  switchedBy?: SwitchSource;
}

export interface GuardDecision {
  status: GuardStatus;
  /** A switch to send; `next` is the state to take once it has gone through. */
  action?: { on: boolean; reason: string; next: GuardState };
}

export const INITIAL_GUARD: GuardState = {
  mode: 'off', restUntil: 0, switchedOnAt: 0, lastSeenOn: null, lastAction: null, offOutsideAt: 0, reons: [], leftOffWhy: null,
};

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });

export function createGuard(initial: GuardState = INITIAL_GUARD) {
  let s: GuardState = { ...initial };

  function status(cfg: GuardConfig, now: number, st: GuardState, held = false): GuardStatus {
    const note = !cfg.enabled ? 'Desligada'
      : st.mode === 'rest' && held ? `Bomba em descanso desde as ${hhmm(st.lastAction?.at ?? st.restUntil)} — nenhuma zona pede calor; liga quando uma pedir (automação)`
      : st.mode === 'rest' ? `Bomba em descanso até às ${hhmm(st.restUntil)}`
      : st.mode === 'lockout' ? 'Bomba bloqueada em avaria — precisa de rearme (painel, disjuntor ou técnicos)'
      : st.offOutsideAt && held ? `Bomba desligada de fora às ${hhmm(st.offOutsideAt)} — liga quando uma zona pedir calor (automação)`
      : st.offOutsideAt ? `Bomba desligada de fora às ${hhmm(st.offOutsideAt)} — volta a ligar às ${hhmm(st.offOutsideAt + REON_AFTER_MS)}`
      : st.leftOffWhy ? `Bomba desligada de fora — ${st.leftOffWhy}`
      : 'A vigiar — desliga a bomba quando fica parada no setpoint e volta a ligá-la se for desligada de fora';
    return {
      enabled: cfg.enabled,
      mode: cfg.enabled ? st.mode : 'off',
      restUntil: st.mode === 'rest' ? st.restUntil : null,
      note,
      lastAction: st.lastAction,
      reonAt: cfg.enabled && st.mode === 'watch' && st.offOutsideAt && !held ? st.offOutsideAt + REON_AFTER_MS : null,
      evaluatedAt: now,
    };
  }

  function act(cfg: GuardConfig, now: number, on: boolean, reason: string, next: Omit<GuardState, 'lastAction'>): GuardDecision {
    const full: GuardState = { ...next, lastAction: { at: now, what: on ? 'on' : 'off', reason } };
    return { status: status(cfg, now, full), action: { on, reason, next: full } };
  }

  function decide(cfg: GuardConfig, input: GuardInput): GuardDecision {
    const { now, pump } = input;

    if (!cfg.enabled) {
      // Switched off while it had the pump parked: give the pump back.
      if (s.mode === 'rest' && pump && !pump.on) {
        return act(cfg, now, true, 'proteção desligada na app — a bomba volta a ligar', { ...s, mode: 'off' });
      }
      // An off from outside seen meanwhile is not ours to undo once switched back on.
      if (s.mode !== 'rest' || pump?.on) s = { ...s, mode: 'off', offOutsideAt: 0, leftOffWhy: null };
      return { status: status(cfg, now, s) };
    }
    if (s.mode === 'off') s = { ...s, mode: 'watch', switchedOnAt: 0 };
    // Nothing fresh to go on: do nothing rather than act on an old reading.
    if (!pump) return { status: status(cfg, now, s) };
    // Switched on by anyone: the same grace as after our own switch-on, and a
    // fault right after it is a lockout, not a fresh trip to rest from.
    const turnedOn = pump.on && s.lastSeenOn === false;
    const turnedOff = !pump.on && s.lastSeenOn === true;
    s = { ...s, lastSeenOn: pump.on, switchedOnAt: turnedOn ? now : s.switchedOnAt };
    // On again, by anyone: nothing left to undo.
    if (pump.on && (s.offOutsideAt || s.leftOffWhy)) s = { ...s, offOutsideAt: 0, leftOffWhy: null };
    const held = !!input.holdRest;

    const fault = pump.faults.length > 0;
    switch (s.mode) {
      case 'rest':
        if (pump.on) {
          // Someone switched it on during the rest: theirs now.
          s = { ...s, mode: 'watch', switchedOnAt: now };
        } else if (now >= s.restUntil && input.holdRest) {
          return { status: status(cfg, now, s, true) };
        } else if (now >= s.restUntil) {
          // Past its end by more than a poll or two: the automation was holding it.
          const reason = now - s.restUntil > 2 * MIN ? 'fim do descanso — uma zona voltou a pedir calor' : 'fim do descanso';
          return act(cfg, now, true, reason, { ...s, mode: 'watch', switchedOnAt: now });
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
            return act(cfg, now, false, `disparo ${pump.faults.join(', ')} — desligada ${REST_AFTER_TRIP_MS / MIN} min para não disparar outra vez`,
              { ...s, mode: 'rest', restUntil: now + REST_AFTER_TRIP_MS });
          }
        } else if (pump.on && pump.hz > 0 && pump.sp !== undefined && pump.out !== undefined) {
          const idling = pump.hz <= IDLE_HZ && pump.out >= pump.sp - NEAR_SETPOINT && now - s.switchedOnAt > GRACE_MS;
          if (idling) {
            return act(cfg, now, false,
              `no setpoint a ${pump.hz} Hz, água a ${pump.out} °C — desligada ${REST_PREVENTIVE_MS / MIN} min antes de voltar a acelerar`,
              { ...s, mode: 'rest', restUntil: now + REST_PREVENTIVE_MS });
          }
        } else if (!pump.on) {
          // Only an off the recorder saw happen and couldn't put down to the
          // app or the automation; an off found at start-up isn't one.
          const reons = s.reons.filter(t => now - t < DAY);
          if (turnedOff && (input.switchedBy === 'outside' || input.switchedBy === 'unknown')) {
            const last = reons.at(-1);
            s = last !== undefined && now - last < INSIST_MS
              ? { ...s, reons, offOutsideAt: 0, leftOffWhy: `desligada outra vez às ${hhmm(now)}, ${Math.round((now - last) / MIN)} min depois de a proteção a ter ligado: fica desligada até alguém a ligar` }
              : reons.length >= REON_MAX_PER_DAY
                ? { ...s, reons, offOutsideAt: 0, leftOffWhy: `já foi ligada ${reons.length} vezes nas últimas 24 h: fica desligada até alguém a ligar` }
                : { ...s, reons, offOutsideAt: now, leftOffWhy: null };
          }
          if (s.offOutsideAt && !fault && !held && now - s.offOutsideAt >= REON_AFTER_MS) {
            return act(cfg, now, true, `desligada de fora às ${hhmm(s.offOutsideAt)} — volta a ligar`,
              { ...s, offOutsideAt: 0, reons: [...reons, now], switchedOnAt: now });
          }
        }
        break;
    }
    return { status: status(cfg, now, s, s.mode === 'watch' && held) };
  }

  return {
    decide,
    /** The decision's command went through. */
    commit(next: GuardState) { s = { ...next }; },
    state: (): GuardState => s,
  };
}
