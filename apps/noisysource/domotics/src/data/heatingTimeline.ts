import SunCalc from 'suncalc';
import { SLOT_MS, addDays, dayStart, lisbonDate, lisbonOffsetMs, slotsInDay } from '@shared/lib/energyBill';
import type { LinePoint, StripLane, StripSelection, StripTone } from '../components/timeline/stripLogic';
import type { AutomationStatus } from './automation';
import { faultMeaning } from './heatpumpFaults';
import { LOG_ORIGIN, SOURCE_LABEL, type SwitchSource } from './incidentLabels';
import type { FaultIncident, Incident, SwitchEvent } from './incidents';
import { SITE } from './site';

/**
 * One day of the heating, as lanes for DayStrip and words for whoever taps them:
 * what was planned, what the pump did and who or what made it, and the rooms.
 * Pure: the caller loads the records (data/heatingHistory.ts) and passes `now`.
 *
 * What is recorded and what is worked out:
 * - Past plan: `plan` on each 15-min slot of `domotics_climate` (the bridge's
 *   climate.ts; the slot holds its last reading's plan, so a change shows from
 *   the start of its slot). 'day' is split here into "Só com sol" and "Desligada"
 *   by sunrise and sunset, which the bridge doesn't record.
 * - Future plan, and today's slots not written yet (the bridge writes them
 *   hourly): from `settings.windows` and the warm-up, here.
 * - The pump: the exact times and who from the switch records in
 *   `domotics_incidents`, checked against the slots; slots only where a switch
 *   has no record. A slot with no pump reading is drawn as "Sem registo", never
 *   as off.
 * - Why: the automation's own words when there are any (`why`, then `reason`,
 *   then the status's recent actions), or worked out from the plan and said to
 *   be (`derived`).
 *
 * Time is Lisbon's by the helpers in energyBill, like the bridge's, so clock
 * changes (92 or 100 slots) and the machine's time zone don't move anything.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The bridge writes a status at least this often; older means it's gone quiet (AutomationCard says so too). */
const STALE_MS = 10 * MIN;
/** The incident and the climate event of one switch come from the same poll. */
const SAME_SWITCH_MS = 90_000;
/** A pump action this long before a switch record is taken to be that switch (the bridge's COMMAND_MATCH_MS). */
const ACTION_MATCH_MS = 3 * MIN;
/** The warm-up cap when the settings can't be read (signed out, on the LAN): what is configured since 2/11. */
const DEFAULT_WARMUP_MIN = 30;
const WARM_HOLD_MS = HOUR;
const PUMP_DEVICE = 'Bomba de calor';

// ---------------------------------------------------------------------------
// The records
// ---------------------------------------------------------------------------

/** One 15-minute slot of `domotics_climate` (domotics-bridge/src/climate.ts). */
export interface ClimateSlot {
  z?: Record<string, { t: number; lo?: number; hi?: number; s?: number; v?: number }>;
  /** Pump readings in the slot; 0 = it didn't answer. */
  pn?: number;
  /** Shares of those with the pump switched on and with the compressor running. */
  on?: number;
  run?: number;
  hz?: number;
  sp?: number;
  ext?: number;
  fault?: boolean;
  soc?: number;
  /** 'day' | 'warm' | 'warmup', with ' (sim)' in dry-run; 'off' with the automation off. */
  plan?: string;
  want?: boolean;
  guard?: string;
}

/** A person's intervention, or the pump's timer (`x_…`). The automation's own switches aren't here. */
export interface ClimateEvent {
  at: number;
  kind: 'pump' | 'target';
  by: 'app' | 'outside' | 'timer';
  meaning?: string;
  on?: boolean;
  zone?: string;
  zoneName?: string;
  from?: number;
  to?: number;
  mean?: number | null;
}

export interface ClimateDay {
  date: string;
  /** Index i covers dayStart + i × 15 min; null = nothing recorded. */
  slots: Array<ClimateSlot | null>;
  events: ClimateEvent[];
  zones: Record<string, string>;
}

/** What is on record for a day. */
export interface HeatingRecord {
  climate: ClimateDay | null;
  /** Everything starting that day, in any order. */
  incidents: Incident[];
  /** The last switch before the day: how the day began and who did it. */
  before: SwitchEvent | null;
}

const toMs = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v && typeof (v as { toMillis?: unknown }).toMillis === 'function') return (v as { toMillis(): number }).toMillis();
  return undefined;
};

/** A `domotics_climate/{date}` document → ClimateDay. Fields it doesn't know, and malformed slots, are ignored. */
export function parseClimateDay(date: string, data: Record<string, unknown>): ClimateDay {
  const slots: Array<ClimateSlot | null> = Array.from({ length: slotsInDay(date) }, () => null);
  const events: ClimateEvent[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object') continue;
    const q = /^q(\d+)$/.exec(key);
    if (q) {
      const i = Number(q[1]);
      if (i < slots.length) slots[i] = value as ClimateSlot;
    } else if (key.startsWith('x_')) {
      const e = value as Partial<ClimateEvent>;
      const at = toMs(e.at);
      if (at !== undefined && (e.kind === 'pump' || e.kind === 'target')) events.push({ ...e, at, kind: e.kind, by: e.by ?? 'outside' });
    }
  }
  events.sort((a, b) => a.at - b.at);
  const zones = data.zones && typeof data.zones === 'object' ? (data.zones as Record<string, string>) : {};
  return { date, slots, events, zones };
}

// ---------------------------------------------------------------------------
// Clock and words
// ---------------------------------------------------------------------------

export const hhmm = (t: number) => new Date(t + lisbonOffsetMs(t)).toISOString().slice(11, 16);
/** The instant Lisbon's clock reads `time` on `date` (the bridge's lisbonAt). */
export function lisbonAt(date: string, time: string): number {
  const wall = Date.parse(`${date}T${time}:00Z`);
  return wall - lisbonOffsetMs(wall - lisbonOffsetMs(wall));
}
const deg = (v: number) => `${String(Math.round(v * 10) / 10).replace('.', ',')}°`;
const rate = (v: number) => `${v.toFixed(2).replace('.', ',')}°/h`;
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** "hoje às 20:10", "amanhã às 10:00", "a 06/11 às 10:00". */
function atDay(t: number, now: number): string {
  const d = lisbonDate(t);
  const today = lisbonDate(now);
  const day = d === today ? 'hoje' : d === addDays(today, 1) ? 'amanhã' : `a ${d.slice(8, 10)}/${d.slice(5, 7)}`;
  return `${day} às ${hhmm(t)}`;
}
/** "às 17:00" today, otherwise with the day. */
const atTime = (t: number, now: number) => (lisbonDate(t) === lisbonDate(now) ? `às ${hhmm(t)}` : atDay(t, now));

// ---------------------------------------------------------------------------
// Tones
// ---------------------------------------------------------------------------

export const HEATING_TONES: Record<string, StripTone> = {
  'plan-warm': { label: 'Horário quente', fill: 'var(--viz-1)' },
  'plan-warmup': { label: 'A aquecer', fill: 'var(--viz-1)', pattern: 'dense' },
  'plan-sun': { label: 'Só com sol', fill: 'var(--viz-solar)', pattern: 'hatch' },
  'plan-off': { label: 'Desligada', fill: 'var(--viz-muted)', thin: true },
  'plan-request': { label: 'Pedido pontual', fill: 'var(--viz-hz)', pattern: 'dense' },
  'plan-pause': { label: 'Em pausa', fill: 'var(--viz-muted)', pattern: 'dots' },
  'plan-none': { label: 'Automação desligada', fill: 'var(--viz-axis)', thin: true },
  'pump-schedule': { label: 'Automação, horário', fill: 'var(--viz-1)', mark: 'A' },
  'pump-sun': { label: 'Automação, sol', fill: 'var(--viz-solar)', mark: 'S' },
  'pump-daymin': { label: 'Automação, mínimo de dia', fill: 'var(--viz-3)', mark: 'D' },
  'pump-app': { label: 'À mão, na app', fill: 'var(--viz-hz)', mark: 'M' },
  'pump-outside': { label: 'De fora da app (painel, SmartLife ou temporizador)', fill: 'var(--viz-2)', mark: 'F' },
  'pump-timer': { label: 'Temporizador da bomba', fill: 'var(--viz-2)', pattern: 'hatch', mark: 'T' },
  'pump-guard': { label: 'Proteção E13 (registos antigos)', fill: 'var(--viz-muted)', mark: 'E' },
  'pump-unknown': { label: 'Sem registo de quem', fill: 'var(--viz-muted)', pattern: 'dots', mark: '?' },
  // Off is a low stripe in the colour of who switched it off. Only this one goes in the legend.
  'pump-off': { label: 'Desligada (traço na cor de quem a desligou)', fill: 'var(--viz-muted)', thin: true },
  'off-automation': { label: 'Desligada pela automação', fill: 'var(--viz-1)', thin: true },
  'off-app': { label: 'Desligada à mão, na app', fill: 'var(--viz-hz)', thin: true },
  'off-outside': { label: 'Desligada de fora da app', fill: 'var(--viz-2)', thin: true },
  'off-timer': { label: 'Desligada pelo temporizador', fill: 'var(--viz-2)', thin: true, mark: 'T' },
  'off-guard': { label: 'Desligada pela proteção E13', fill: 'var(--viz-muted)', thin: true },
  'off-unknown': { label: 'Desligada', fill: 'var(--viz-muted)', thin: true },
  fault: { label: 'Avaria', fill: 'var(--viz-critical)', mark: '!' },
  nodata: { label: 'Sem registo', fill: 'var(--viz-axis)', pattern: 'hatch' },
};

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type PlanKind = 'warm' | 'warmup' | 'sun' | 'off' | 'request' | 'pause' | 'none' | 'nodata';

export interface PlanPiece {
  from: number;
  to: number;
  kind: PlanKind;
  /** Decided in dry-run: nothing was sent. */
  sim?: boolean;
  /** Worked out from the settings rather than recorded. */
  derived?: boolean;
  /** A warm-up the rooms may turn out not to need. */
  maybe?: boolean;
}

type RawPiece = Omit<PlanPiece, 'kind'> & { kind: PlanKind | 'day' };

const isHeat = (k: PlanKind | 'day' | undefined) => k === 'warm' || k === 'warmup' || k === 'request';

interface PlanOptions {
  windows: Array<{ from: string; to: string }>;
  solarEnabled: boolean;
  /** Minutes of warm-up before the window starting at this instant. */
  leadFor: (start: number) => { min: number; maybe?: boolean };
}

function planOptions(status: AutomationStatus | undefined, warmupMaxMin: number | undefined): PlanOptions | null {
  const st = status?.settings;
  if (!st) return null;
  const w = status!.warm;
  const usual = warmupMaxMin ?? (w?.capped ? w.leadMin : DEFAULT_WARMUP_MIN);
  return {
    windows: st.windows?.length ? st.windows : [{ from: st.warmFrom, to: st.warmTo }],
    solarEnabled: st.solar?.enabled !== false,
    leadFor: start => {
      // The next window's is in the status; the others' depend on how far the rooms will have cooled.
      if (w && !w.inWindow && w.nextStart === start) {
        return w.warmupAt !== null ? { min: (start - w.warmupAt) / MIN } : { min: usual, maybe: true };
      }
      return { min: usual };
    },
  };
}

/** The warm windows overlapping [a, b), merged where they touch. */
function warmIntervals(windows: PlanOptions['windows'], a: number, b: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let d = addDays(lisbonDate(a), -1); d <= lisbonDate(b); d = addDays(d, 1)) {
    for (const w of windows) {
      const s = lisbonAt(d, w.from);
      const e = lisbonAt(w.from < w.to ? d : addDays(d, 1), w.to);
      if (e > a && s < b) out.push([s, e]);
    }
  }
  out.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of out) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  return merged;
}

/** The plan over [a, b) from the settings: windows, the warm-up before each, day rules in between. */
function derivedPlan(a: number, b: number, o: PlanOptions): RawPiece[] {
  const out: RawPiece[] = [];
  const add = (from: number, to: number, kind: RawPiece['kind'], maybe?: boolean) => {
    const f = Math.max(a, from);
    const t = Math.min(b, to);
    if (t > f) out.push({ from: f, to: t, kind, derived: true, ...(maybe ? { maybe } : {}) });
  };
  let prevEnd = a - DAY;
  // Reach back and ahead: a warm-up can start before `a`, for a window after it.
  for (const [s, e] of warmIntervals(o.windows, a - DAY, b + DAY)) {
    const lead = o.leadFor(s);
    const warmupFrom = Math.max(prevEnd, s - lead.min * MIN);
    add(prevEnd, warmupFrom, 'day');
    if (warmupFrom < s) add(warmupFrom, s, 'warmup', lead.maybe);
    add(s, e, 'warm');
    prevEnd = e;
  }
  add(prevEnd, b, 'day');
  return out;
}

/** Sunrise and sunset at the house, for the Lisbon day `date`. */
function daylight(date: string): [number, number] {
  const times = SunCalc.getTimes(new Date(dayStart(date) + 12 * HOUR), SITE.lat, SITE.lon);
  return [times.sunrise.getTime(), times.sunset.getTime()];
}

/**
 * 'day' in words: the bridge's day rules hold around the clock, but "only with
 * sun" means nothing at night, so that part reads as off.
 */
function resolveDay(pieces: RawPiece[], solarEnabled: boolean): PlanPiece[] {
  const out: PlanPiece[] = [];
  for (const p of pieces) {
    if (p.kind !== 'day') { out.push(p as PlanPiece); continue; }
    if (!solarEnabled) { out.push({ ...p, kind: 'off' }); continue; }
    const cuts = [p.from, p.to];
    for (let d = lisbonDate(p.from); d <= lisbonDate(p.to - 1); d = addDays(d, 1)) {
      for (const c of daylight(d)) if (c > p.from && c < p.to) cuts.push(c);
    }
    cuts.sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const mid = (cuts[i] + cuts[i + 1]) / 2;
      const [rise, set] = daylight(lisbonDate(mid));
      out.push({ ...p, from: cuts[i], to: cuts[i + 1], kind: mid >= rise && mid < set ? 'sun' : 'off' });
    }
  }
  return out;
}

function mergePieces(pieces: PlanPiece[]): PlanPiece[] {
  const out: PlanPiece[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && last.kind === p.kind && !!last.sim === !!p.sim && last.to === p.from) {
      last.to = p.to;
      if (p.derived) last.derived = true;
      if (p.maybe) last.maybe = true;
    } else {
      out.push({ ...p });
    }
  }
  return out;
}

/** Takes intervals out of `base`. */
function cutOut<T extends { from: number; to: number }>(base: T[], holes: Array<{ from: number; to: number }>): T[] {
  let out = base;
  for (const h of holes) {
    out = out.flatMap(b => {
      if (h.to <= b.from || h.from >= b.to) return [b];
      const parts: T[] = [];
      if (h.from > b.from) parts.push({ ...b, to: h.from });
      if (h.to < b.to) parts.push({ ...b, from: h.to });
      return parts;
    });
  }
  return out;
}

/** What the automation has changed about the plan from now on. */
function futureOverlays(status: AutomationStatus, a: number, b: number): PlanPiece[] {
  if (status.state === 'off') return [{ from: a, to: b, kind: 'none' }];
  const out: PlanPiece[] = [];
  if (status.pausedUntil && status.pausedUntil > a) {
    out.push({ from: a, to: Math.min(b, status.pausedUntil), kind: 'pause' });
  }
  const r = status.warmBy;
  if (r && r.phase !== 'done') {
    const from = Math.max(a, r.startAt);
    const to = Math.min(b, r.at + WARM_HOLD_MS);
    if (to > from) out.push({ from, to, kind: 'request' });
  }
  return out;
}

function planFromSettings(a: number, b: number, o: PlanOptions | null): PlanPiece[] {
  if (b <= a || !o) return [];
  return resolveDay(derivedPlan(a, b, o), o.solarEnabled);
}

/** The recorded plan on a slot. */
function slotPlan(s: ClimateSlot | null): { kind: RawPiece['kind']; sim: boolean } {
  const raw = s?.plan;
  if (typeof raw !== 'string') return { kind: 'nodata', sim: false };
  const sim = raw.endsWith(' (sim)');
  const m = sim ? raw.slice(0, -6) : raw;
  if (m === 'warm' || m === 'warmup' || m === 'day') return { kind: m, sim };
  if (m === 'off') return { kind: 'none', sim: false };
  return { kind: 'nodata', sim: false };
}

/** The index after the last slot with anything in it; later ones haven't been written (yet). */
function frontierOf(day: ClimateDay | null): number {
  if (!day) return 0;
  for (let i = day.slots.length - 1; i >= 0; i--) if (day.slots[i]) return i + 1;
  return 0;
}

function dayPlan(p: {
  from: number; to: number; now: number; phase: DayPhase; day: ClimateDay | null; status?: AutomationStatus; opts: PlanOptions | null;
}): PlanPiece[] {
  const { from, to, now, phase, day, status, opts } = p;
  const pastEnd = phase === 'future' ? from : phase === 'past' ? to : Math.min(now, to);
  const frontier = frontierOf(day);
  const recordedEnd = Math.min(pastEnd, from + frontier * SLOT_MS);
  const raw: RawPiece[] = [];
  for (let i = 0; i < frontier; i++) {
    const a = from + i * SLOT_MS;
    if (a >= recordedEnd) break;
    const { kind, sim } = slotPlan(day!.slots[i]);
    raw.push({ from: a, to: Math.min(recordedEnd, a + SLOT_MS), kind, ...(sim ? { sim } : {}) });
  }
  const recorded = resolveDay(raw, opts?.solarEnabled ?? true);
  let rest: PlanPiece[] = [];
  if (recordedEnd < pastEnd) {
    // Today, the bridge just hasn't written these slots yet. On a past day, nothing was written.
    rest = phase === 'today' ? planFromSettings(recordedEnd, pastEnd, opts)
      : [{ from: recordedEnd, to: pastEnd, kind: 'nodata' }];
  }
  // `derived` is about what has already happened: everything still to come is worked out.
  let future: PlanPiece[] = planFromSettings(pastEnd, to, opts).map(x => ({ ...x, derived: false }));
  if (status && pastEnd < to) {
    const overlays = futureOverlays(status, pastEnd, to);
    future = [...cutOut(future, overlays), ...overlays].sort((a, b) => a.from - b.from);
  }
  return mergePieces([...recorded, ...rest, ...future]);
}

// ---------------------------------------------------------------------------
// The pump
// ---------------------------------------------------------------------------

type Source = SwitchSource | 'timer';
export type PumpKind = 'schedule' | 'sun' | 'daymin' | 'app' | 'outside' | 'timer' | 'guard' | 'unknown';

interface Transition {
  at: number;
  on: boolean;
  source: Source;
  /** The reason in the automation's own words, without the verb. */
  text?: string;
  /** Inferred from the slots: there's no record of this switch. */
  synthetic?: boolean;
  /** How the day began, from a switch the day before. */
  carried?: boolean;
}

export interface PumpStretch {
  from: number;
  to: number;
  state: 'on' | 'off' | 'fault' | 'nodata';
  /** While on: who or why. */
  kind?: PumpKind;
  source?: Source;
  text?: string;
  synthetic?: boolean;
  /** Runs on from before the day. */
  carried?: boolean;
  fault?: FaultIncident;
  /** The bridge didn't answer, as opposed to a slot with no reading. */
  quiet?: boolean;
  /** Reaches the present. */
  ongoing?: boolean;
}

/** "ligar (com o sol: …)" → "com o sol: …". What the bridge sends as `what` and stores as `reason`. */
export function reasonText(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const rest = /^desligar (\d+) min \((.*)\)$/s.exec(raw);
  if (rest) return `descanso de ${rest[1]} min: ${rest[2]}`;
  const m = /^(?:ligar|desligar) \((.*)\)$/s.exec(raw);
  return m ? m[1] : raw;
}

/** Why, from the record, then the status's recent actions. Undefined: nobody wrote it down. */
function reasonOf(e: SwitchEvent, status: AutomationStatus | undefined): string | undefined {
  if (e.why) return e.why;
  const fromReason = reasonText(e.reason);
  if (fromReason) return fromReason;
  if (e.source !== 'automation') return undefined;
  const verb = e.on ? 'ligar' : 'desligar';
  const action = status?.actions.find(a =>
    a.device === PUMP_DEVICE && a.sent && a.what.startsWith(verb) && a.at <= e.at && e.at - a.at <= ACTION_MATCH_MS);
  return action ? reasonText(action.what) : undefined;
}

function transitionsOf(record: HeatingRecord, status: AutomationStatus | undefined, from: number, to: number): Transition[] {
  const out: Transition[] = record.incidents
    .filter((i): i is SwitchEvent => i.kind === 'switch' && i.at >= from && i.at < to)
    .map(e => ({ at: e.at, on: e.on, source: e.source, text: reasonOf(e, status) }));
  for (const ev of record.climate?.events ?? []) {
    if (ev.kind !== 'pump' || ev.at < from || ev.at >= to || ev.on === undefined) continue;
    const same = out.find(t => t.on === ev.on && Math.abs(t.at - ev.at) <= SAME_SWITCH_MS);
    if (same) { if (ev.by === 'timer') same.source = 'timer'; } else out.push({ at: ev.at, on: ev.on, source: ev.by });
  }
  return out.sort((a, b) => a.at - b.at);
}

function automationKind(text: string | undefined, plan: PlanKind | undefined, belowDayMin: boolean): PumpKind {
  if (text) {
    if (/mínimo de dia/.test(text)) return 'daymin';
    return /\bsol\b/.test(text) ? 'sun' : 'schedule';
  }
  if (isHeat(plan)) return 'schedule';
  return belowDayMin ? 'daymin' : 'sun';
}

function slotMean(s: ClimateSlot | null | undefined): number | undefined {
  const v = Object.values(s?.z ?? {}).map(z => z.t).filter(isNum);
  return v.length ? mean(v) : undefined;
}

function slotTarget(s: ClimateSlot | null | undefined): number | undefined {
  const v = Object.values(s?.z ?? {}).map(z => z.s).filter(isNum);
  return v.length ? mean(v) : undefined;
}

function pumpStretches(p: {
  date: string; from: number; to: number; now: number; phase: DayPhase; record: HeatingRecord;
  status?: AutomationStatus; pumpOn?: boolean; plan: PlanPiece[];
}): { stretches: PumpStretch[]; switches: PumpStretch[] } {
  const { from, to, now, phase, record, status, pumpOn, plan } = p;
  const end = phase === 'past' ? to : Math.min(now, to);
  if (end <= from) return { stretches: [], switches: [] };
  const day = record.climate;
  const fresh = !!status && now - status.evaluatedAt <= STALE_MS;
  const frontier = frontierOf(day);
  const slotAt = (t: number) => day?.slots[Math.floor((t - from) / SLOT_MS)] ?? null;
  const planAt = (t: number) => plan.find(x => t >= x.from && t < x.to)?.kind;

  const transitions = transitionsOf(record, status, from, to).filter(t => t.at <= end);

  // How the day began: before the first switch, the opposite of it; failing that, the last switch, the first reading, or now.
  const before = record.before;
  const firstReading = day?.slots.find(s => s && (s.pn ?? 0) > 0);
  let startOn: boolean | undefined = transitions.length ? !transitions[0].on
    : before ? before.on
    : firstReading ? (firstReading.on ?? 0) >= 0.5
    : phase === 'today' ? pumpOn
    : undefined;
  let start: Transition | null = startOn === undefined ? null : before && before.on === startOn
    ? { at: from, on: startOn, source: before.source, text: reasonOf(before, status), carried: true }
    : { at: from, on: startOn, source: 'unknown' };

  // The slots check the switches: a whole slot saying otherwise, with no switch in it, means a switch nobody recorded.
  const all: Transition[] = [];
  let state = startOn;
  let ti = 0;
  for (let i = 0; i < frontier; i++) {
    const a = from + i * SLOT_MS;
    const b = a + SLOT_MS;
    const inSlot: Transition[] = [];
    while (ti < transitions.length && transitions[ti].at < b) inSlot.push(transitions[ti++]);
    if (inSlot.length) { all.push(...inSlot); state = inSlot[inSlot.length - 1].on; continue; }
    const s = day!.slots[i];
    if (!s || !s.pn) continue;
    const want = (s.on ?? 0) >= 0.5;
    if (want !== state) {
      if (i === 0 || state === undefined) { startOn = want; start = { at: from, on: want, source: 'unknown' }; } else all.push({ at: a, on: want, source: 'unknown', synthetic: true });
      state = want;
    }
  }
  while (ti < transitions.length) { state = transitions[ti].on; all.push(transitions[ti++]); }

  // The live reading is ahead of the records by up to a refresh: a switch just now is on its way.
  if (phase === 'today' && fresh && pumpOn !== undefined && state !== undefined && pumpOn !== state) {
    const lastAt = all[all.length - 1]?.at ?? from;
    const verb = pumpOn ? 'ligar' : 'desligar';
    const action = status!.actions.find(a =>
      a.device === PUMP_DEVICE && a.sent && a.what.startsWith(verb) && a.at > lastAt && now - a.at <= STALE_MS);
    const at = Math.max(lastAt + 1, Math.min(now - 1, action?.at ?? status!.evaluatedAt));
    if (at < end) {
      all.push(action
        ? { at, on: pumpOn, source: 'automation', text: reasonText(action.what) }
        : { at, on: pumpOn, source: 'unknown', synthetic: true });
    }
  }

  const stretchFrom = (t: Transition, t0: number, t1: number): PumpStretch => {
    const belowMin = (slotMean(slotAt(t.at)) ?? Infinity) < (status?.settings?.dayMin ?? -Infinity);
    const kind: PumpKind | undefined = !t.on ? undefined
      : t.source === 'automation' ? automationKind(t.text, planAt(t.at), belowMin)
      : t.source;
    return {
      from: t0, to: t1, state: t.on ? 'on' : 'off', kind, source: t.source, text: t.text,
      ...(t.synthetic ? { synthetic: true } : {}), ...(t.carried ? { carried: true } : {}),
    };
  };
  const stretches: PumpStretch[] = [];
  let t0 = from;
  let cur = start;
  for (const t of all) {
    if (t.at >= end) break;
    if (cur && t.at > t0) stretches.push(stretchFrom(cur, t0, t.at));
    t0 = t.at;
    cur = t;
  }
  if (cur && end > t0) stretches.push(stretchFrom(cur, t0, end));

  // Where nothing was read, say so rather than draw it as off.
  const holes: Array<{ from: number; to: number; quiet?: boolean }> = [];
  const addHole = (a: number, b: number, quiet?: boolean) => {
    if (b <= a) return;
    const last = holes[holes.length - 1];
    if (last && last.to === a && !!last.quiet === !!quiet) last.to = b;
    else holes.push({ from: a, to: b, ...(quiet ? { quiet } : {}) });
  };
  for (let i = 0; i < frontier; i++) {
    const a = from + i * SLOT_MS;
    const b = a + SLOT_MS;
    const s = day!.slots[i];
    if ((!s || !s.pn) && !all.some(t => t.at >= a && t.at < b)) addHole(a, Math.min(b, end));
  }
  const recordedEnd = from + frontier * SLOT_MS;
  const lastSwitch = all[all.length - 1]?.at ?? from;
  if (phase === 'past') {
    // Slots that never came. A day with switches but no slots at all (before 28/10) goes by the switches.
    if (day || all.length === 0) addHole(Math.max(recordedEnd, lastSwitch), end);
  } else if (!fresh) {
    // Today's tail: the status vouches for it while the bridge is talking.
    addHole(Math.max(recordedEnd, lastSwitch, status?.evaluatedAt ?? 0), end, true);
  }
  if (cur === null && stretches.length === 0 && holes.length === 0) addHole(from, end);

  const faults = faultBands(record, from, end, day);
  const body = cutOut(cutOut(stretches, holes), faults);
  const out: PumpStretch[] = [
    ...body,
    ...holes.map(h => ({ from: h.from, to: h.to, state: 'nodata' as const, ...(h.quiet ? { quiet: true } : {}) })),
    ...faults,
  ].sort((a, b) => a.from - b.from);
  if (phase === 'today' && out.length && out[out.length - 1].to >= end) out[out.length - 1].ongoing = true;
  return {
    stretches: out,
    switches: all.filter(t => t.at < end).map(t => stretchFrom(t, t.at, t.at + 1)),
  };
}

function faultBands(record: HeatingRecord, from: number, end: number, day: ClimateDay | null): PumpStretch[] {
  const bands: PumpStretch[] = [];
  for (const i of record.incidents) {
    if (i.kind !== 'fault') continue;
    const stop = i.endedAt ?? (i.status === 'active' ? end : i.at + SLOT_MS);
    const a = Math.max(from, i.at);
    const b = Math.min(end, stop);
    if (b > a) bands.push({ from: a, to: b, state: 'fault', fault: i });
  }
  // A fault that began before the day, or with no record: the slots flag it.
  day?.slots.forEach((s, i) => {
    if (!s?.fault) return;
    const a = from + i * SLOT_MS;
    const b = Math.min(end, a + SLOT_MS);
    if (b <= a) return;
    if (bands.some(x => x.fault && x.from < b && x.to > a)) return;
    const last = bands[bands.length - 1];
    if (last && !last.fault && last.to === a) last.to = b;
    else bands.push({ from: a, to: b, state: 'fault' });
  });
  return bands.sort((a, b) => a.from - b.from);
}

// ---------------------------------------------------------------------------
// In words
// ---------------------------------------------------------------------------

export interface Detail {
  /** "11:31–11:54" */
  when: string;
  /** What and who: "Ligada pela automação, com o sol". */
  title: string;
  /** "bateria 42 %, a carregar 3,0 kW" */
  why?: string;
  /** Sentences after it. */
  extra?: string;
  /** What it meant for the rooms. */
  facts?: string;
  /** Worked out rather than recorded, and the like. */
  note?: string;
  /** All of it but `facts` and `note`, as one line. */
  text: string;
}

function compose(d: Omit<Detail, 'text'>): Detail {
  const why = d.why ? `: ${d.why.replace(/\.$/, '')}` : '';
  return { ...d, text: `${d.when} · ${d.title}${why}.${d.extra ? ` ${d.extra}` : ''}` };
}

const SUN_PREFIX = /^com o sol:?\s*/;
const DAY_RULE_PREFIX = /^de dia só com sol:?\s*/;

interface WordsContext {
  from: number;
  to: number;
  now: number;
  phase: DayPhase;
  date: string;
  plan: PlanPiece[];
  status?: AutomationStatus;
  day: ClimateDay | null;
  warmupMaxMin?: number;
}

function range(ctx: WordsContext, from: number, to: number, ongoing = false): string {
  const side = (t: number) => (t >= ctx.to ? '24:00' : hhmm(t));
  return `${side(from)}–${ongoing ? 'agora' : side(to)}`;
}

function dayMinSentence(status?: AutomationStatus): string {
  const m = status?.settings?.dayMin;
  return m !== undefined ? `Também aquece se as divisões descerem dos ${deg(m)}.` : 'Também aquece se as divisões arrefecerem demais.';
}

/** When the plan next changes between heating and not, in this day. A person's on or off holds until then (`manualPump` in the bridge). */
function planMovesAt(ctx: WordsContext, t: number): number | undefined {
  const here = ctx.plan.find(p => t >= p.from && t < p.to);
  if (!here) return undefined;
  const heat = isHeat(here.kind);
  return ctx.plan.find(p => p.from > t && isHeat(p.kind) !== heat && p.kind !== 'nodata')?.from;
}

function respected(ctx: WordsContext, t: number): string {
  const at = planMovesAt(ctx, t);
  return `A automação respeita-o até o plano mudar${at !== undefined ? `, às ${hhmm(at)}` : ''}.`;
}

/** When heating next starts, for an off stretch at night. */
function nextHeatAfter(ctx: WordsContext, t: number): number | undefined {
  const inDay = ctx.plan.find(p => p.from > t && isHeat(p.kind))?.from;
  if (inDay !== undefined) return inDay;
  const opts = planOptions(ctx.status, ctx.warmupMaxMin);
  if (!opts) return undefined;
  return derivedPlan(ctx.to, ctx.to + DAY, opts).find(p => isHeat(p.kind))?.from;
}

/** What the slots say about a stretch. */
function stretchFacts(ctx: WordsContext, s: PumpStretch): string | undefined {
  const day = ctx.day;
  if (!day) return undefined;
  const slots = day.slots
    .map((slot, i) => ({ slot, at: ctx.from + i * SLOT_MS }))
    .filter(x => x.slot && x.at + SLOT_MS > s.from && x.at < s.to);
  const temps = slots.map(x => slotMean(x.slot)).filter(isNum);
  const parts: string[] = [];
  if (temps.length >= 2) parts.push(`Casa ${deg(temps[0])} → ${deg(temps[temps.length - 1])}`);
  else if (temps.length === 1) parts.push(`Casa a ${deg(temps[0])}`);
  if (s.state === 'on' && slots.length) {
    const runs = slots.map(x => x.slot!.run).filter(isNum);
    if (runs.length) parts.push(`compressor a trabalhar ${Math.round(mean(runs) * 100)} % do tempo`);
  }
  return parts.length ? `${parts.join(' · ')}.` : undefined;
}

/** The rooms' target while it heated on sun: what was recorded, else what's configured. */
function sunTargetSentence(ctx: WordsContext, s: PumpStretch): string | undefined {
  const recorded = ctx.day?.slots
    .map((slot, i) => ({ slot, at: ctx.from + i * SLOT_MS }))
    .filter(x => x.slot && x.at + SLOT_MS > s.from && x.at < s.to)
    .map(x => slotTarget(x.slot))
    .filter(isNum) ?? [];
  const st = ctx.status?.settings;
  const configured = st && st.solar?.boost ? st.comfort + st.solar.boost : undefined;
  const target = recorded.length ? Math.max(...recorded, configured ?? -Infinity) : configured;
  return target !== undefined ? `As divisões a ${deg(target)} enquanto trabalha.` : undefined;
}

function faultDetail(ctx: WordsContext, s: PumpStretch): Detail {
  const f = s.fault;
  const code = f ? f.codes.join(', ') : '';
  const ended = !f ? undefined
    : f.status === 'active' ? (f.lockout ? 'bloqueada, em curso' : 'em curso')
    : f.endedHow === 'self' ? 'limpou sozinho'
    : f.endedHow === 'reset' ? 'rearmada'
    : f.status === 'unknown' ? 'sem registo do fim' : 'terminou';
  return compose({
    when: range(ctx, s.from, s.to, s.ongoing),
    title: f ? `Avaria ${code}` : 'Em avaria',
    why: f ? faultMeaning(f.code) : undefined,
    extra: ended ? `${ended.charAt(0).toUpperCase()}${ended.slice(1)}.` : undefined,
    note: f ? undefined : 'Marcada nas leituras de 15 em 15 min; não há registo com a hora exata.',
  });
}

function pumpDetail(ctx: WordsContext, s: PumpStretch): Detail {
  const when = range(ctx, s.from, s.to, s.ongoing);
  if (s.state === 'fault') return faultDetail(ctx, s);
  if (s.state === 'nodata') {
    return compose({
      when,
      title: 'Sem registo',
      why: s.quiet ? 'a ponte não dá notícias'
        : ctx.date === addDays(lisbonDate(ctx.now), -1) ? 'ainda não chegou, ou a ponte não leu a bomba'
        : 'a ponte não leu a bomba',
      extra: 'Não quer dizer que estivesse desligada.',
    });
  }
  const verb = s.state === 'on' ? 'Ligada' : 'Desligada';
  const facts = stretchFacts(ctx, s);
  const carriedNote = s.carried ? 'Já vinha do dia anterior.' : undefined;
  let d: Omit<Detail, 'text'>;
  switch (s.source) {
    case 'automation':
      d = s.state === 'on' ? automationOn(ctx, s, when) : automationOff(ctx, s, when);
      break;
    case 'outside':
      d = {
        when,
        title: `${verb} de fora da app`,
        why: 'painel, SmartLife ou temporizador, a ponte não os distingue',
        extra: respected(ctx, s.from),
      };
      break;
    case 'app':
      d = { when, title: `${verb} à mão, na app`, extra: respected(ctx, s.from) };
      break;
    case 'timer':
      d = {
        when,
        title: `${verb} pelo temporizador da bomba`,
        extra: 'Não é uma pessoa: se o plano a quiser ligada, a automação volta a ligá-la.',
      };
      break;
    case 'guard':
      d = {
        when,
        title: `${verb} ${SOURCE_LABEL.guard}`,
        why: s.text,
        note: 'Registo antigo: a proteção já não está na app.',
      };
      break;
    default:
      d = {
        when,
        title: s.state === 'on' ? 'Ligada, sem registo de quem a ligou' : 'Desligada, sem registo de quem a desligou',
        note: s.synthetic ? 'Vê-se pelas leituras de 15 em 15 min, por isso a hora é aproximada.' : undefined,
      };
  }
  return compose({ ...d, facts, note: [carriedNote, d.note].filter(Boolean).join(' ') || undefined });
}

function automationOn(ctx: WordsContext, s: PumpStretch, when: string): Omit<Detail, 'text'> {
  const derived = !s.text;
  const planHere = ctx.plan.find(p => s.from >= p.from && s.from < p.to);
  const note = derived ? 'Motivo deduzido do plano: não ficou registado.' : undefined;
  const slot = ctx.day?.slots[Math.floor((s.from - ctx.from) / SLOT_MS)];
  if (s.kind === 'sun') {
    const why = s.text ? s.text.replace(SUN_PREFIX, '')
      : isNum(slot?.soc) ? `bateria ${Math.round(slot!.soc!)} %` : undefined;
    return { when, title: 'Ligada pela automação, com o sol', why, extra: sunTargetSentence(ctx, s), note };
  }
  if (s.kind === 'daymin') {
    const mean_ = slotMean(slot);
    const min = ctx.status?.settings?.dayMin;
    const why = s.text ?? (mean_ !== undefined && min !== undefined ? `casa a ${deg(mean_)} de média, abaixo do mínimo de dia (${deg(min)})` : undefined);
    return { when, title: 'Ligada pela automação, pelo mínimo de dia', why, note };
  }
  const why = s.text
    ?? (planHere?.kind === 'warmup' ? `a aquecer para as ${hhmm(planHere.to)}` : planHere?.kind === 'warm' ? 'horário quente' : undefined);
  return { when, title: 'Ligada pela automação, pelo horário', why, note };
}

function automationOff(ctx: WordsContext, s: PumpStretch, when: string): Omit<Detail, 'text'> {
  const here = ctx.plan.find(p => s.from >= p.from && s.from < p.to)?.kind;
  const prev = s.from > ctx.from ? ctx.plan.find(p => s.from - 1 >= p.from && s.from - 1 < p.to)?.kind : undefined;
  const windowEnded = isHeat(prev) && !isHeat(here);
  const title = 'Desligada pela automação';
  // Its "de dia só com sol: …" also comes at 23:00, when there's no sun to speak of.
  if (!s.text || DAY_RULE_PREFIX.test(s.text)) {
    const detail = s.text?.replace(DAY_RULE_PREFIX, '');
    const note = s.text ? undefined : 'Motivo deduzido do plano: não ficou registado.';
    if (here === 'off') {
      const next = nextHeatAfter(ctx, s.from);
      const nextAt = next !== undefined ? `, só volta a ligar às ${hhmm(next)}` : '';
      return {
        when, title, note,
        why: `${windowEnded ? 'acabou o horário quente; ' : ''}de noite não há sol${nextAt}`,
        extra: dayMinSentence(ctx.status),
      };
    }
    if (here === 'sun') {
      return {
        when, title, note,
        why: `${windowEnded ? 'acabou o horário quente; ' : ''}de dia só liga com sol${detail ? ` (${detail})` : ''}`,
        extra: dayMinSentence(ctx.status),
      };
    }
    return { when, title, why: detail, note };
  }
  return { when, title, why: s.text };
}

function planDetail(ctx: WordsContext, p: PlanPiece): Detail {
  const when = range(ctx, p.from, p.to);
  const st = ctx.status?.settings;
  const sim = p.sim ? ' Em simulação: não mexeu em nada.' : '';
  const note = p.derived ? 'Deduzido das definições: ainda não há registo deste bocado.' : undefined;
  const comfort = st ? ` as divisões a ${deg(st.comfort)}` : ' a temperatura';
  switch (p.kind) {
    case 'warm':
      return compose({
        when, title: 'Horário quente', note,
        why: `mantém${comfort}, com a bomba a trabalhar quando uma zona pede calor`,
        extra: sim.trim() || undefined,
      });
    case 'warmup': {
      const cap = ctx.warmupMaxMin !== undefined ? ` (no máximo ${ctx.warmupMaxMin} min antes)` : '';
      const moved = p.maybe ? ' Só se as divisões ainda precisarem: agora estão no alvo.' : '';
      return compose({
        when, title: `A aquecer para as ${hhmm(p.to)}`, note,
        why: `liga a bomba antes do horário quente${cap}`,
        extra: `${moved}${sim}`.trim() || undefined,
      });
    }
    case 'sun': {
      const soc = st ? ` a bateria tiver ≥ ${Math.round(st.socOn)} % e` : '';
      const boost = st?.solar?.boost ? ` (as divisões a ${deg(st.comfort + st.solar.boost)} enquanto trabalha)` : '';
      return compose({
        when, title: 'Só com sol', note,
        why: `liga se${soc} houver sol a sobrar${boost}`,
        extra: `${dayMinSentence(ctx.status)}${sim}`,
      });
    }
    case 'off': {
      const solarOff = st?.solar?.enabled === false;
      return compose({
        when, title: 'Desligada', note,
        why: solarOff ? 'aquecer com o sol está desligado' : 'sem sol, fora do horário quente',
        extra: `${dayMinSentence(ctx.status)}${sim}`,
      });
    }
    case 'request':
      return compose({
        when, title: 'Pedido pontual',
        why: ctx.status?.warmBy ? `quente às ${hhmm(ctx.status.warmBy.at)}, com sol ou sem ele` : undefined,
      });
    case 'pause':
      return compose({ when, title: 'Em pausa', why: 'a automação não liga a bomba até lá' });
    case 'none':
      return compose({ when, title: 'Automação desligada', why: 'não liga nem desliga nada' });
    default:
      return compose({ when, title: 'Sem registo', why: 'a ponte não escreveu o plano nesta altura' });
  }
}

function tempDetail(ctx: WordsContext, t: number, points: LinePoint[], targets: LinePoint[]): Detail | null {
  if (points.length === 0) return null;
  const p = points.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
  const target = [...targets].reverse().find(x => x.t <= p.t) ?? targets[0];
  const diff = target ? p.v - target.v : undefined;
  const short = diff === undefined ? undefined
    : Math.abs(diff) < 0.05 ? 'no alvo'
    : diff < 0 ? `${deg(-diff)} abaixo do alvo` : `${deg(diff)} acima do alvo`;
  const slot = ctx.day?.slots[Math.floor((p.t - 1 - ctx.from) / SLOT_MS)];
  const around = [
    isNum(slot?.ext) ? `lá fora ${deg(slot!.ext!)}` : '',
    isNum(slot?.soc) ? `bateria ${Math.round(slot!.soc!)} %` : '',
  ].filter(Boolean).join(' · ');
  return compose({
    when: hhmm(p.t),
    title: `Divisões a ${deg(p.v)}${target ? `, alvo ${deg(target.v)}` : ''}`,
    why: short,
    facts: around ? `${around.charAt(0).toUpperCase()}${around.slice(1)}.` : undefined,
  });
}

// ---------------------------------------------------------------------------
// The day's events
// ---------------------------------------------------------------------------

export interface HeatingEvent {
  id: string;
  at: number;
  who: string;
  what: string;
  why?: string;
  /** The reason wasn't recorded, it was worked out. */
  derived?: boolean;
  /** Tone of the swatch beside it. */
  tone?: string;
  /** What to select when it's tapped. */
  select?: StripSelection;
}

const WHO: Record<Source, string> = {
  ...LOG_ORIGIN,
  outside: 'De fora da app',
  timer: 'Temporizador',
  unknown: 'Sem registo',
} as Record<Source, string>;

/** One row per switch, whether or not a fault or a gap covers the moment it happened. */
function switchEvents(ctx: WordsContext, switches: PumpStretch[], stretches: PumpStretch[]): HeatingEvent[] {
  return switches.map(sw => {
    const d = pumpDetail(ctx, sw);
    const moves = planMovesAt(ctx, sw.from);
    const until = `a automação respeita${moves !== undefined ? ` até às ${hhmm(moves)}` : ' até o plano mudar'}`;
    const why = sw.source === 'automation' ? (sw.kind === 'sun' ? `com o sol${d.why ? `: ${d.why}` : ''}` : d.why)
      : sw.source === 'outside' ? `painel, SmartLife ou temporizador (a ponte não os distingue); ${until}`
      : sw.source === 'app' ? until
      : d.why;
    const here = stretches.find(x => sw.from >= x.from && sw.from < x.to);
    return {
      id: `sw${sw.from}`,
      at: sw.from,
      who: WHO[sw.source ?? 'unknown'],
      what: sw.state === 'on' ? 'Ligou a bomba' : 'Desligou a bomba',
      why,
      ...(sw.source === 'automation' && !sw.text ? { derived: true } : {}),
      tone: toneOf(sw),
      ...(here ? { select: { lane: 'pump', id: stretchId(here), t: sw.from } } : {}),
    };
  });
}

function climateEvents(day: ClimateDay | null): HeatingEvent[] {
  return (day?.events ?? []).filter(e => e.kind === 'target').map(e => {
    const name = e.zoneName ?? (e.zone ? day!.zones[e.zone] : undefined) ?? 'Termóstato';
    const way = isNum(e.from) && isNum(e.to) ? (e.to > e.from ? 'mais quente' : 'menos quente') : '';
    const house = isNum(e.mean) ? `casa a ${deg(e.mean)}` : '';
    return {
      id: `t${e.at}-${e.zone ?? ''}`,
      at: e.at,
      who: e.by === 'app' ? 'À mão, na app' : 'De fora da app',
      what: `${name}: ${isNum(e.from) ? deg(e.from) : '—'} → ${isNum(e.to) ? deg(e.to) : '—'}`,
      why: [way, house].filter(Boolean).join(', ') || undefined,
    };
  });
}

function faultEvents(ctx: WordsContext, stretches: PumpStretch[]): HeatingEvent[] {
  return stretches.filter(s => s.state === 'fault' && s.fault).map(s => {
    const d = faultDetail(ctx, s);
    return {
      id: `f${s.from}`,
      at: s.from,
      who: LOG_ORIGIN.pump,
      what: d.title,
      why: [d.why, d.extra?.replace(/\.$/, '').toLowerCase()].filter(Boolean).join(': '),
      tone: 'fault',
      select: { lane: 'pump', id: stretchId(s), t: s.from },
    };
  });
}

/**
 * What the automation says it did but there's no switch to show for: simulated
 * or failed commands. Signed out there's no history at all, so all of them, the
 * thermostats' and the water's too.
 */
function actionEvents(ctx: WordsContext, withHistory: boolean): HeatingEvent[] {
  const list = ctx.status?.actions ?? [];
  return list
    .filter(a => a.at >= ctx.from && a.at < ctx.to && (!withHistory || (a.device === PUMP_DEVICE && !a.sent)))
    .map(a => ({
      id: `a${a.at}-${a.device}`,
      at: a.at,
      who: 'Automação',
      what: `${a.device}: ${a.what.split(' (')[0]}${a.error ? ' (falhou)' : a.sent ? '' : ' (simulado)'}`,
      why: a.error ?? (a.what.includes(' (') ? reasonText(a.what) : undefined),
    }));
}

// ---------------------------------------------------------------------------
// The day
// ---------------------------------------------------------------------------

export type DayPhase = 'past' | 'today' | 'future';

export interface HeatingDayInput {
  date: string;
  now: number;
  status?: AutomationStatus;
  /** The pump as read just now; undefined if it isn't answering. */
  pumpOn?: boolean;
  /** undefined: no history (signed out on the LAN, or still loading). */
  record?: HeatingRecord | null;
  warmupMaxMin?: number;
}

export interface HeatingDayView {
  date: string;
  phase: DayPhase;
  from: number;
  to: number;
  /** Today only: where the marker goes. */
  now?: number;
  lanes: StripLane[];
  /** The legend's tones, in order. */
  legend: string[];
  plan: PlanPiece[];
  pump: PumpStretch[];
  events: HeatingEvent[];
  /** Nothing on record for a past day. */
  empty: boolean;
  /** Now, today; nothing otherwise. */
  defaultSelection: StripSelection | null;
  describe: (s: StripSelection) => Detail | null;
}

const planId = (p: PlanPiece) => `plan:${p.from}`;
const stretchId = (s: PumpStretch) => `pump:${s.from}`;

function toneOf(s: PumpStretch): string {
  if (s.state === 'fault') return 'fault';
  if (s.state === 'nodata') return 'nodata';
  if (s.state === 'on') return `pump-${s.kind ?? 'unknown'}`;
  return `off-${s.source ?? 'unknown'}`;
}

const PLAN_LEGEND: Array<[PlanKind, string]> = [
  ['warm', 'plan-warm'], ['warmup', 'plan-warmup'], ['sun', 'plan-sun'], ['off', 'plan-off'],
  ['request', 'plan-request'], ['pause', 'plan-pause'], ['none', 'plan-none'],
];
const PUMP_LEGEND = ['pump-schedule', 'pump-sun', 'pump-daymin', 'pump-app', 'pump-outside', 'pump-timer', 'pump-guard', 'pump-unknown'];

export function buildHeatingDay(input: HeatingDayInput): HeatingDayView {
  const { date, now, status, pumpOn, record, warmupMaxMin } = input;
  const from = dayStart(date);
  const to = dayStart(addDays(date, 1));
  const today = lisbonDate(now);
  const phase: DayPhase = date < today ? 'past' : date === today ? 'today' : 'future';
  const day = record?.climate ?? null;
  const opts = planOptions(status, warmupMaxMin);
  const plan = dayPlan({ from, to, now, phase, day, status, opts });
  const end = phase === 'past' ? to : Math.min(now, to);
  const { stretches: pump, switches } = record && phase !== 'future'
    ? pumpStretches({ date, from, to, now, phase, record, status, pumpOn, plan })
    : { stretches: [] as PumpStretch[], switches: [] as PumpStretch[] };

  // --- Temperatures -------------------------------------------------------
  const temps: LinePoint[] = [];
  const targets: LinePoint[] = [];
  day?.slots.forEach((s, i) => {
    if (!s) return;
    // A slot's temperature is its last reading's.
    const t = Math.min(end, from + (i + 1) * SLOT_MS);
    const m = slotMean(s);
    if (m !== undefined) temps.push({ t, v: Math.round(m * 100) / 100 });
    const target = slotTarget(s);
    if (target !== undefined) targets.push({ t: from + i * SLOT_MS, v: Math.round(target * 100) / 100 });
  });
  const live = phase === 'today' && status && now - status.evaluatedAt <= STALE_MS;
  if (live && status!.meanRoom !== undefined) {
    const t = Math.min(now, status!.evaluatedAt);
    if (!temps.length || t > temps[temps.length - 1].t) temps.push({ t, v: status!.meanRoom });
  }
  if (live && status!.roomTarget !== undefined) {
    targets.push({ t: Math.max(targets[targets.length - 1]?.t ?? from, Math.min(now, status!.evaluatedAt)), v: status!.roomTarget });
  }
  if (targets.length) targets.push({ t: temps[temps.length - 1]?.t ?? end, v: targets[targets.length - 1].v });

  // --- Lanes --------------------------------------------------------------
  const ctx: WordsContext = { from, to, now, phase, date, plan, status, day, warmupMaxMin };
  const lanes: StripLane[] = [{
    id: 'plan',
    label: 'Plano',
    note: phase === 'future' ? 'previsto' : undefined,
    segments: plan.map(p => ({ id: planId(p), from: p.from, to: p.to, tone: p.kind === 'nodata' ? 'nodata' : `plan-${p.kind}`, label: planLabel(p) })),
  }];
  if (phase !== 'future' && record) {
    lanes.push({
      id: 'pump',
      label: 'Bomba',
      segments: pump.map(s => ({ id: stretchId(s), from: s.from, to: s.to, tone: toneOf(s), label: HEATING_TONES[toneOf(s)]?.label ?? '' })),
    });
    const lastT = temps[temps.length - 1];
    const lastTarget = targets[targets.length - 1];
    lanes.push({
      kind: 'line',
      id: 'temp',
      label: 'Temperatura',
      note: lastT ? `${deg(lastT.v)}${lastTarget ? ` · alvo ${deg(lastTarget.v)}` : ''}` : undefined,
      points: temps,
      reference: targets,
      format: deg,
    });
  }

  // --- Legend -------------------------------------------------------------
  const legend = PLAN_LEGEND.filter(([k]) => plan.some(p => p.kind === k)).map(([, tone]) => tone);
  const pumpTones = new Set(pump.map(toneOf));
  legend.push(...PUMP_LEGEND.filter(t => pumpTones.has(t)));
  if ([...pumpTones].some(t => t.startsWith('off-'))) legend.push('pump-off');
  if (pumpTones.has('off-timer')) legend.push('off-timer');
  if (pumpTones.has('fault')) legend.push('fault');
  if (pumpTones.has('nodata') || plan.some(p => p.kind === 'nodata')) legend.push('nodata');

  // --- Events -------------------------------------------------------------
  const events = phase === 'future' ? [] : [
    ...switchEvents(ctx, switches, pump),
    ...climateEvents(day),
    ...faultEvents(ctx, pump),
    ...actionEvents(ctx, !!record),
  ].sort((a, b) => a.at - b.at);

  // --- Selection ----------------------------------------------------------
  const describe = (sel: StripSelection): Detail | null => {
    if (sel.lane === 'temp') return tempDetail(ctx, sel.t, temps, targets);
    if (sel.lane === 'plan') {
      const p = plan.find(x => planId(x) === sel.id) ?? plan.find(x => sel.t >= x.from && sel.t < x.to);
      return p ? planDetail(ctx, p) : null;
    }
    const s = pump.find(x => stretchId(x) === sel.id) ?? pump.find(x => sel.t >= x.from && sel.t < x.to);
    return s ? pumpDetail(ctx, s) : null;
  };
  let defaultSelection: StripSelection | null = null;
  if (phase === 'today') {
    const s = pump.find(x => now - 1 >= x.from && now - 1 < x.to) ?? pump[pump.length - 1];
    const p = plan.find(x => now >= x.from && now < x.to);
    if (s) defaultSelection = { lane: 'pump', id: stretchId(s), t: now };
    else if (p) defaultSelection = { lane: 'plan', id: planId(p), t: now };
  }

  const empty = phase === 'past' && !!record && !day && record.incidents.length === 0;
  return { date, phase, from, to, now: phase === 'today' ? now : undefined, lanes, legend, plan, pump, events, empty, defaultSelection, describe };
}

function planLabel(p: PlanPiece): string {
  const tone = HEATING_TONES[p.kind === 'nodata' ? 'nodata' : `plan-${p.kind}`];
  return `${tone.label}${p.sim ? ' (simulação)' : ''}`;
}

// ---------------------------------------------------------------------------
// Now and next
// ---------------------------------------------------------------------------

/** What happens next, in one line: "16:30 — liga e aquece para as 17:00". Null with the automation off. */
export function nextPlanStep(status: AutomationStatus | undefined, now: number, warmupMaxMin?: number): { at: number; text: string } | null {
  if (!status || status.state === 'off') return null;
  const opts = planOptions(status, warmupMaxMin);
  if (!opts) return null;
  const horizon = now + 2 * DAY;
  const overlays = futureOverlays(status, now, horizon);
  const pieces = mergePieces(
    [...cutOut(planFromSettings(now, horizon, opts), overlays), ...overlays].sort((a, b) => a.from - b.from),
  );
  const first = pieces[0];
  if (!first) return null;
  const line = (at: number, what: string) => ({
    at,
    text: `${lisbonDate(at) === lisbonDate(now) ? hhmm(at) : `amanhã às ${hhmm(at)}`} — ${what}`,
  });
  if (first.kind === 'pause') return line(first.to, 'acaba a pausa, volta ao plano');
  const heating = isHeat(first.kind);
  const next = pieces.find(p => p.from > now && isHeat(p.kind) !== heating && p.kind !== 'pause');
  if (!next) return null;
  if (first.kind === 'warmup' && pieces[1]?.kind === 'warm') return line(first.to, `começa o horário quente, até às ${hhmm(pieces[1].to)}`);
  if (heating) return line(next.from, first.kind === 'request' ? 'desliga, acaba o pedido pontual' : 'desliga, acaba o horário quente');
  if (next.kind === 'warmup') return line(next.from, `liga e aquece para as ${hhmm(next.to)}`);
  if (next.kind === 'request') return line(next.from, 'liga para o pedido pontual');
  return line(next.from, `começa o horário quente, até às ${hhmm(next.to)}`);
}

/**
 * The plain truth when the model doesn't expect the rooms warm by the start of
 * the next window: how short, how slowly it warms, and when, with the date if
 * it isn't today. `expectedAt` assumes the pump keeps running, so past the end
 * of the window it says that too. Null when it should get there.
 */
export function warmForecast(status: AutomationStatus | undefined, now: number): { text: string } | null {
  const w = status?.warm;
  if (!w || w.inWindow || !w.expectedAt || w.expectedAt <= w.nextStart) return null;
  const target = status!.settings?.comfort;
  const r = status!.model?.roomRatePerH;
  const starts = w.warmupAt !== null
    ? (w.warmupStarted ? `está a aquecer desde as ${hhmm(w.warmupAt)}` : `só começa ${atTime(w.warmupAt, now)}${w.capped ? ` (no máximo ${Math.round(w.leadMin)} min antes)` : ''}`)
    : '';
  const why = [`faltam ${deg(w.need)}`, r ? `a casa aquece ~${rate(r)}` : '', starts].filter(Boolean).join(', ');
  const afterEnd = w.expectedAt > w.end
    ? `, e isso com a bomba sempre ligada: o horário quente acaba ${atTime(w.end, now)}`
    : '';
  return {
    text: `Não vai chegar${target !== undefined ? ` aos ${deg(target)}` : ''} ${atTime(w.nextStart, now)}: ${why}. Previsto só ${atDay(w.expectedAt, now)}${afterEnd}.`,
  };
}
