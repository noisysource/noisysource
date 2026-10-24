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
 * A person switching the pump on or off is respected: an off pump is never
 * switched on unless the guard itself parked it. Settings: one on/off,
 * `domotics_config/guard`, set in the app. Switched off while resting, the
 * guard switches the pump back on — it never leaves the house with the pump
 * parked by us.
 *
 * Pure: it decides, index.ts sends, and the new state is only taken once the
 * command has gone through (a failed command is decided again next poll).
 */

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
const GRACE_MS = 4 * MIN;
export const REST_PREVENTIVE_MS = 60 * MIN;
export const REST_AFTER_TRIP_MS = 120 * MIN;
/** Still faulted this soon after switching on = locked out. */
const LOCKOUT_CHECK_MS = 3 * MIN;

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
}

export interface GuardStatus {
  enabled: boolean;
  mode: GuardMode;
  restUntil: number | null;
  /** What it's doing, in Portuguese, for the app. */
  note: string;
  lastAction: GuardState['lastAction'];
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
}

export interface GuardDecision {
  status: GuardStatus;
  /** A switch to send; `next` is the state to take once it has gone through. */
  action?: { on: boolean; reason: string; next: GuardState };
}

export const INITIAL_GUARD: GuardState = { mode: 'off', restUntil: 0, switchedOnAt: 0, lastSeenOn: null, lastAction: null };

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });

export function createGuard(initial: GuardState = INITIAL_GUARD) {
  let s: GuardState = { ...initial };

  function status(cfg: GuardConfig, now: number, st: GuardState): GuardStatus {
    const note = !cfg.enabled ? 'Desligada'
      : st.mode === 'rest' ? `Bomba em descanso até às ${hhmm(st.restUntil)}`
      : st.mode === 'lockout' ? 'Bomba bloqueada em avaria — precisa de rearme (painel, disjuntor ou técnicos)'
      : 'A vigiar — desliga a bomba quando fica parada no setpoint';
    return {
      enabled: cfg.enabled,
      mode: cfg.enabled ? st.mode : 'off',
      restUntil: st.mode === 'rest' ? st.restUntil : null,
      note,
      lastAction: st.lastAction,
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
      if (s.mode !== 'rest' || pump?.on) s = { ...s, mode: 'off' };
      return { status: status(cfg, now, s) };
    }
    if (s.mode === 'off') s = { ...s, mode: 'watch', switchedOnAt: 0 };
    // Nothing fresh to go on: do nothing rather than act on an old reading.
    if (!pump) return { status: status(cfg, now, s) };
    // Switched on by anyone: the same grace as after our own switch-on, and a
    // fault right after it is a lockout, not a fresh trip to rest from.
    const turnedOn = pump.on && s.lastSeenOn === false;
    s = { ...s, lastSeenOn: pump.on, switchedOnAt: turnedOn ? now : s.switchedOnAt };

    const fault = pump.faults.length > 0;
    switch (s.mode) {
      case 'rest':
        if (pump.on) {
          // Someone switched it on during the rest: theirs now.
          s = { ...s, mode: 'watch', switchedOnAt: now };
        } else if (now >= s.restUntil) {
          return act(cfg, now, true, 'fim do descanso', { ...s, mode: 'watch', switchedOnAt: now });
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
        }
        break;
    }
    return { status: status(cfg, now, s) };
  }

  return {
    decide,
    /** The decision's command went through. */
    commit(next: GuardState) { s = { ...next }; },
    state: (): GuardState => s,
  };
}
