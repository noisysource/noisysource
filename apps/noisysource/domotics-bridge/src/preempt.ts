/**
 * E13 early warning: the readings that come 1–2 minutes before a trip, so the
 * guard can switch the pump off first (guard.ts). Pure; the guard keeps its
 * state and decides what to do with a hit.
 *
 * Since 26/10 19:10 every start ended in E13 9–11 min later. Before each trip
 * the discharge (`dis`, C01) sat low, 42–46 °C, for minutes at a steady
 * compressor speed, then jumped by 3 °C or more between two ~30 s readings
 * while the coil (C00) dropped at the same reading, 61–121 s before the trip.
 * The same shape preceded the 22/10 trips (31–73 s ahead).
 *
 * A discharge rise alone means nothing: in healthy runs the discharge sits at
 * 60–100 °C and climbs 3–9 °C per reading every ten minutes or so (281 such
 * rises in the 21–24/10 logs, none of them before a trip). So a rise only
 * counts when:
 *  - the run is at least MIN_RUN_MS old (the warm-up right after a compressor
 *    start jumps by up to 8 °C per reading);
 *  - the discharge before it was at most MAX_BASE_DIS (it was 42–46 before
 *    every trip; a healthy run is at 51+ once warm, 75 °C on 27/10 evening);
 *  - the coil fell by at least COIL_DROP over the same two readings (1.1–3.0
 *    before the trips; 0–0.5 in the six healthy warm-ups that climbed through
 *    the low 40s by 3 °C a reading).
 * Without a coil reading (the 21/10 logs, one line a minute) there is no hit:
 * the discharge alone fires on those healthy warm-ups.
 *
 * Numbers, rule as below, on the fixture in test/fixtures and the logs in
 * deploy/ (test/preempt.test.cjs checks them): fires on all 13 trips with a
 * coil reading and the run's start in the readings, 31–121 s before the trip
 * reading (61–121 s, median 91, on the 8 since 26/10; 31–73 s on 22/10); zero
 * times outside a run that ended in a trip, in ~2.5 days of 30 s readings.
 * Chosen 2026-10-27; the PR has the tables.
 */

const MIN = 60_000;

export const RISE_PER_30S = 3;
export const MAX_BASE_DIS = 50;
export const COIL_DROP = 0.8;
export const MIN_RUN_MS = 5 * MIN;
/** The rise is per 30 s, the bridge's pump poll. */
const STEP_MS = 30_000;
/** Polls drift 30–33 s apart (read time); up to this much over 30 s isn't scaled down. */
const JITTER_MS = 5_000;
/** Readings closer than this (an extra poll when someone opens the app) aren't a step: the next one is compared with the older reading. */
const MIN_STEP_MS = 20_000;
/** No reading for this long: the compressor may have stopped and restarted unseen, so the run counts from here. */
const GAP_MS = 3 * MIN;

export interface DischargeWatch {
  /** First reading of the current run (on, compressor turning, no fault); 0 = not running. */
  runFrom: number;
  /** Last fresh reading. */
  lastAt: number;
  /** The reading the next one is compared with. */
  base: { t: number; dis: number; coil?: number } | null;
  /** This run's warning, kept until the run ends so a switch-off that failed is tried again (see WARNING_MS). */
  warning: (Precursor & { at: number }) | null;
}

export const INITIAL_WATCH: DischargeWatch = { runFrom: 0, lastAt: 0, base: null, warning: null };

/** A warning is acted on for this long: the trip comes 30–120 s after it. */
export const WARNING_MS = 2 * MIN;

/** The warning still worth acting on at `now`, if any. */
export function warningAt(w: DischargeWatch | undefined, now: number): (Precursor & { at: number }) | null {
  const x = w?.warning;
  return x && now - x.at <= WARNING_MS ? x : null;
}

export interface DischargeReading {
  t: number;
  on: boolean;
  hz: number;
  dis?: number;
  coil?: number;
  faults: string[];
}

export interface Precursor {
  /** Discharge before and now, °C. */
  from: number;
  to: number;
  /** Seconds between the two readings. */
  seconds: number;
  /** Rise per 30 s, °C. */
  per30: number;
  coilFrom: number;
  coilTo: number;
  /** Minutes into the run. */
  runMin: number;
}

const tenth = (v: number) => Math.round(v * 10) / 10;

/** One fresh reading in, the new state out, and a hit if this reading is the warning. */
export function watchDischarge(w: DischargeWatch, r: DischargeReading): { watch: DischargeWatch; hit?: Precursor } {
  const running = r.on && r.hz > 0 && r.faults.length === 0;
  if (!running) return { watch: { ...INITIAL_WATCH, lastAt: r.t } };
  const here = r.dis !== undefined ? { t: r.t, dis: r.dis, coil: r.coil } : null;
  if (!w.runFrom || !w.lastAt || r.t - w.lastAt > GAP_MS) {
    return { watch: { ...INITIAL_WATCH, runFrom: r.t, lastAt: r.t, base: here } };
  }
  if (!here) return { watch: { ...w, lastAt: r.t } };
  if (!w.base) return { watch: { ...w, lastAt: r.t, base: here } };

  const { base } = w;
  const span = r.t - base.t;
  // Scaled down when readings are further apart than a poll, never up: a
  // 0.5 °C reading step a few seconds apart is not a ramp.
  const per30 = tenth((here.dis - base.dis) * STEP_MS / Math.max(STEP_MS, span - JITTER_MS));
  const coilDrop = base.coil !== undefined && here.coil !== undefined ? tenth(base.coil - here.coil) : undefined;
  const hit = r.t - w.runFrom >= MIN_RUN_MS && per30 >= RISE_PER_30S && base.dis <= MAX_BASE_DIS
    && coilDrop !== undefined && coilDrop >= COIL_DROP;
  const watch: DischargeWatch = { ...w, lastAt: r.t, base: span >= MIN_STEP_MS ? here : base };
  if (!hit) return { watch };
  const found: Precursor = {
    from: base.dis, to: here.dis, seconds: Math.round(span / 1000), per30,
    coilFrom: base.coil!, coilTo: here.coil!, runMin: Math.round((r.t - w.runFrom) / MIN),
  };
  // The first of a burst is the one acted on; a jump after it has gone stale is a new warning.
  const fresh = watch.warning && r.t - watch.warning.at <= WARNING_MS ? watch.warning : { ...found, at: r.t };
  return { watch: { ...watch, warning: fresh }, hit: found };
}
