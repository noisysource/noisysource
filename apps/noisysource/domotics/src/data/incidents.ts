import { collection, getDocs, limit, orderBy, query, type Timestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';

/**
 * Heat pump incidents for the Reports page: faults and on/off transitions the
 * bridge records in `domotics_incidents` (domotics-bridge/src/incidents.ts),
 * plus the history backfilled from the E13 logs and notes
 * (domotics-bridge/deploy/backfill-incidents.cjs). Owner read only.
 *
 * Types mirror the bridge's, with timestamps turned into ms on the way in.
 */

export interface PumpSample {
  t: number;
  on: boolean;
  hz: number;
  sp?: number;
  out?: number;
  inn?: number;
  dis?: number;
  outdoor?: number;
  coil?: number;
  suct?: number;
  faults: string[];
  valves?: number;
  zones?: number;
}

export type SwitchSource = 'app' | 'automation' | 'guard' | 'outside' | 'unknown';
/** 'notes' = written down by hand (STATUS.md, the first technician report), no readings. */
export type IncidentOrigin = 'bridge' | 'log' | 'notes';

export interface FaultIncident {
  kind: 'fault';
  id: string;
  device: string;
  deviceName: string;
  code: string;
  codes: string[];
  at: number;
  status: 'active' | 'ended' | 'unknown';
  lockout: boolean;
  lockoutAt?: number;
  lockoutWhy?: string;
  endedAt?: number;
  endedHow?: 'self' | 'reset' | 'unknown';
  restartedAt?: number;
  offlineDuring: boolean;
  previousId?: string;
  minutesSincePrevious?: number;
  before: PumpSample[];
  after: PumpSample[];
  actions: Array<{ at: number; by: SwitchSource; what: 'on' | 'off'; reason: string | null }>;
  note?: string;
  origin: IncidentOrigin;
}

export interface SwitchEvent {
  kind: 'switch';
  id: string;
  deviceName: string;
  at: number;
  on: boolean;
  source: SwitchSource;
  reason?: string;
  faults: string[];
  before: PumpSample[];
  /** Every raw datapoint in the reading before the change and the one that showed it (bridge only, from 26/10). */
  dps?: { before: PumpDps; at: PumpDps };
  note?: string;
  origin: IncidentOrigin;
}

export type PumpDps = Record<string, string | number | boolean>;

/** Context written by hand: an intervention, when the guard started, what someone found. */
export interface NoteEntry {
  kind: 'note';
  id: string;
  at: number;
  note: string;
  origin: IncidentOrigin;
}

export type Incident = FaultIncident | SwitchEvent | NoteEntry;

/** Enough for months of history; switches are small, faults carry ~70 readings each. */
const MAX_INCIDENTS = 300;

const ms = (v: unknown) => (v && typeof (v as Timestamp).toMillis === 'function' ? (v as Timestamp).toMillis() : undefined);
const orUndef = <T,>(v: T | null | undefined) => (v === null ? undefined : v);

/** Newest first. */
export async function loadIncidents(): Promise<Incident[]> {
  const snap = await getDocs(query(collection(db, 'domotics_incidents'), orderBy('at', 'desc'), limit(MAX_INCIDENTS)));
  return snap.docs.map(d => {
    const x = d.data();
    const base = { ...x, id: d.id, at: ms(x.at) ?? 0 };
    if (x.kind === 'fault') {
      return {
        ...base,
        lockoutAt: ms(x.lockoutAt),
        endedAt: ms(x.endedAt),
        restartedAt: ms(x.restartedAt),
        lockoutWhy: orUndef(x.lockoutWhy),
        endedHow: orUndef(x.endedHow),
        previousId: orUndef(x.previousId),
        minutesSincePrevious: orUndef(x.minutesSincePrevious),
        note: orUndef(x.note),
        before: x.before ?? [],
        after: x.after ?? [],
        actions: x.actions ?? [],
        codes: x.codes ?? [x.code],
      } as FaultIncident;
    }
    if (x.kind === 'switch') {
      return { ...base, reason: orUndef(x.reason), note: orUndef(x.note), before: x.before ?? [], faults: x.faults ?? [] } as SwitchEvent;
    }
    return base as NoteEntry;
  });
}

// ---------------------------------------------------------------------------
// What preceded a trip
// ---------------------------------------------------------------------------

/** The guard's idea of "idling at the setpoint" (domotics-bridge/src/guard.ts). */
const IDLE_HZ = 45;
const NEAR_SETPOINT = 1.5;
const MIN = 60_000;

export interface TripContext {
  /** Last reading before the trip. */
  last: PumpSample;
  /** The first reading already in fault. */
  trip: PumpSample;
  /** Compressor and discharge ~3 min before, and the highest discharge up to the trip. */
  hzBefore?: number;
  hzMax?: number;
  disBefore?: number;
  disAt?: number;
  disRise?: number;
  /** Minutes, in the 30 before, the compressor sat at its minimum with the water at the setpoint. */
  idleMin: number;
  /** Seconds between readings — 20 s, 30 s or a minute, depending on who recorded it. */
  step: number;
  /** When the compressor started the run that tripped, and for how long it ran; unset when the run started before the readings. */
  runFrom?: number;
  runMin?: number;
  /** The run started before the readings: it lasted longer than this. */
  runOver?: number;
  /** Lowest coil (C00) in the ~3 min before, and the warmest water out during the run. */
  coilMin?: number;
  outPeak?: number;
}

export function tripContext(f: FaultIncident): TripContext | undefined {
  const trip = f.after[0];
  const last = f.before[f.before.length - 1];
  if (!trip || !last) return undefined;
  const window = [...f.before.filter(s => s.t >= f.at - 3 * MIN), trip];
  const first = window[0];
  const dis = window.map(s => s.dis).filter((v): v is number => v !== undefined);
  const disAt = dis.length ? Math.max(...dis) : undefined;
  let idle = 0;
  for (let i = 0; i < f.before.length; i++) {
    const s = f.before[i];
    const next = f.before[i + 1]?.t ?? f.at;
    if (s.on && s.hz > 0 && s.hz <= IDLE_HZ && s.sp !== undefined && s.out !== undefined && s.out >= s.sp - NEAR_SETPOINT) {
      idle += next - s.t;
    }
  }
  const steps = f.before.slice(1).map((s, i) => s.t - f.before[i].t).sort((a, b) => a - b);
  let start = f.before.length;
  while (start > 0 && f.before[start - 1].on && f.before[start - 1].hz > 0) start--;
  const run = f.before.slice(start);
  const runFrom = start > 0 && run.length ? run[0].t : undefined;
  const coil = window.map(s => s.coil).filter((v): v is number => v !== undefined);
  const outs = run.map(s => s.out).filter((v): v is number => v !== undefined);
  return {
    runFrom,
    runMin: runFrom !== undefined ? Math.round((f.at - runFrom) / MIN) : undefined,
    runOver: start === 0 && run.length ? Math.floor((f.at - run[0].t) / MIN) : undefined,
    coilMin: coil.length ? Math.min(...coil) : undefined,
    outPeak: outs.length ? Math.max(...outs) : undefined,
    last,
    trip,
    hzBefore: first.hz,
    hzMax: Math.max(...window.map(s => s.hz)),
    disBefore: first.dis,
    disAt,
    disRise: disAt !== undefined && first.dis !== undefined ? disAt - first.dis : undefined,
    idleMin: Math.round(idle / MIN),
    step: steps.length ? Math.round(steps[Math.floor(steps.length / 2)] / 1000) : 0,
  };
}

/** Minutes from the start of a fault to its end, if it ended. */
export function faultMinutes(f: FaultIncident): number | undefined {
  return f.endedAt !== undefined ? (f.endedAt - f.at) / MIN : undefined;
}

// ---------------------------------------------------------------------------
// Formatting (always Portugal's legal time: the house's, and the technicians')
// ---------------------------------------------------------------------------

const TZ = 'Europe/Lisbon';
export const fmtTime = (t: number, seconds = false) =>
  new Date(t).toLocaleTimeString('pt-PT', { timeZone: TZ, hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
export const fmtDate = (t: number) =>
  new Date(t).toLocaleDateString('pt-PT', { timeZone: TZ, day: '2-digit', month: '2-digit' });
export const fmtDateTime = (t: number) => `${fmtDate(t)} ${fmtTime(t)}`;
export const fmtLongDate = (t: number) =>
  new Date(t).toLocaleDateString('pt-PT', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });

/** Hours since local midnight (0–24), for the time-of-day strips. */
export function hourOfDay(t: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).map(x => [x.type, x.value]),
  );
  return Number(p.hour) + Number(p.minute) / 60;
}

export const num = (v: number | undefined, digits = 1) =>
  v === undefined ? '—' : v.toLocaleString('pt-PT', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const SOURCE_LABEL: Record<SwitchSource, string> = {
  app: 'pela app / ponte',
  automation: 'pela automação',
  guard: 'pela proteção E13',
  outside: 'de fora (SmartLife, painel, técnicos ou temporizador)',
  unknown: 'origem desconhecida',
};

// ---------------------------------------------------------------------------
// The log: everything that happened to the pump, in order
// ---------------------------------------------------------------------------

/**
 * The pump's own clock. Tuya has its time zone as a fixed +01:00 (device
 * details, 26/10), so its timers keep summer time: what it does at 00:54 by its
 * clock happened at 00:54 in Lisbon until 25/10 and at 23:54 since.
 */
const PUMP_CLOCK_OFFSET = 60 * MIN;
const DAY_MS = 24 * 60 * MIN;
export const fmtPumpClock = (t: number) =>
  new Date(t + PUMP_CLOCK_OFFSET).toLocaleTimeString('pt-PT', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });

export type LogOrigin = SwitchSource | 'pump' | 'note';

export const LOG_ORIGIN: Record<LogOrigin, string> = {
  outside: 'De fora',
  unknown: 'Desconhecida',
  guard: 'Proteção E13',
  automation: 'Automação',
  app: 'App / ponte',
  pump: 'Bomba (avaria)',
  note: 'Nota',
};

export interface LogRow {
  id: string;
  at: number;
  origin: LogOrigin;
  /** One line: what happened. */
  what: string;
  /** Why, and what the pump was doing. */
  details: string[];
  /** For the "De fora" rows: the time by the pump's clock, where its timers live. */
  pumpClock?: string;
}

/** Datapoints that move every reading (temperatures, Hz) or are the switch itself: not "something else changed". */
const MOVING_DPS = new Set(['switch', 'temp_current', 'power_consumption', 'compressor_strength', 'temp_top', 'temp_bottom', 'coiler_temp', 'venting_temp', 'effluent_temp']);
/** The Tuya codes are reused and misleading (domotics-bridge/README.md → Heat pump). */
const DP_LABEL: Record<string, string> = {
  mode: 'modo',
  fault: 'avarias E01–E16',
  smart_system: 'avarias E17–E32',
  power_system: 'avarias E36–E59',
  ithium_battery_system: 'avaria E50',
  electronic_system: 'avarias IPM',
  bcu_com_state: 'avarias IPM',
  p02_heating: 'setpoint de aquecimento',
  p03_cooling: 'setpoint de arrefecimento',
  p04_dhw: 'setpoint AQS',
};

/** What changed in the pump's datapoints with the switch, besides it and the temperatures. */
export function otherChanges(e: SwitchEvent): string | undefined {
  if (!e.dps) return undefined;
  const { before, at } = e.dps;
  const codes = [...new Set([...Object.keys(before), ...Object.keys(at)])].filter(c => !MOVING_DPS.has(c));
  const changed = codes.filter(c => before[c] !== at[c]);
  if (changed.length === 0) return 'Nada mais mudou nos dados da bomba (modo, setpoints e avarias iguais).';
  return `Mudou também: ${changed.map(c => `${DP_LABEL[c] ?? c} ${String(before[c] ?? '—')} → ${String(at[c] ?? '—')}`).join(', ')}.`;
}

function pumpDoing(e: SwitchEvent): string | undefined {
  // For an off, the last reading still running; for an on, the last one still off.
  const s = [...e.before].reverse().find(x => x.on !== e.on) ?? e.before.at(-1);
  if (!s) return undefined;
  const parts = [
    s.on ? `compressor a ${s.hz} Hz` : 'parada',
    s.out !== undefined ? `água ${num(s.out)} °C${s.sp !== undefined ? ` (setpoint ${s.sp} °C)` : ''}` : '',
    s.outdoor !== undefined ? `exterior ${num(s.outdoor)} °C` : '',
  ].filter(Boolean);
  return `Antes: ${parts.join(', ')}.`;
}

/** Newest first, like the incidents. Faults are one row each, with how they ended. */
export function logRows(incidents: Incident[]): LogRow[] {
  return incidents.map((i): LogRow => {
    if (i.kind === 'switch') {
      const details = [
        i.reason ? `Porquê: ${i.reason}.` : '',
        i.faults.length ? `Em avaria: ${i.faults.join(', ')}.` : '',
        pumpDoing(i) ?? '',
        otherChanges(i) ?? '',
        i.note ?? '',
      ].filter(Boolean);
      return {
        id: i.id, at: i.at, origin: i.source, what: i.on ? 'Ligada' : 'Desligada', details,
        ...(i.source === 'outside' || i.source === 'unknown' ? { pumpClock: fmtPumpClock(i.at) } : {}),
      };
    }
    if (i.kind === 'fault') {
      const details = [
        endPhrase(i),
        i.lockoutWhy ? `Bloqueio: ${i.lockoutWhy}.` : '',
        ...i.actions.map(a => `${fmtTime(a.at)} ${a.what === 'on' ? 'ligada' : 'desligada'} ${SOURCE_LABEL[a.by]}${a.reason ? ` — ${a.reason}` : ''}`),
        i.note ?? '',
      ].filter(Boolean);
      return { id: i.id, at: i.at, origin: 'pump', what: `Avaria ${i.codes.join(', ')}${i.lockout ? ' — bloqueou' : ''}`, details };
    }
    return { id: i.id, at: i.at, origin: 'note', what: i.note, details: [] };
  });
}

export interface Repeat {
  on: boolean;
  /** By the pump's clock. */
  from: string;
  to: string;
  times: number[];
}

/**
 * Switches from outside that come back at the same time of day, by the pump's
 * clock, on two days or more: a timer's signature. Within 5 min counts as the same.
 */
export function repeatedOutside(incidents: Incident[]): Repeat[] {
  const out: Repeat[] = [];
  for (const on of [false, true]) {
    const list = incidents
      .filter((i): i is SwitchEvent => i.kind === 'switch' && i.on === on && i.origin !== 'notes' && (i.source === 'outside' || i.source === 'unknown'))
      .map(i => ({ t: i.at, m: ((i.at + PUMP_CLOCK_OFFSET) % DAY_MS) / MIN }))
      .sort((a, b) => a.m - b.m);
    let group: typeof list = [];
    const flush = () => {
      const days = new Set(group.map(g => Math.floor((g.t + PUMP_CLOCK_OFFSET) / DAY_MS)));
      if (days.size >= 2) {
        out.push({ on, from: fmtPumpClock(group[0].t), to: fmtPumpClock(group[group.length - 1].t), times: group.map(g => g.t).sort((a, b) => a - b) });
      }
    };
    for (const x of list) {
      if (group.length && x.m - group[0].m > 5) { flush(); group = []; }
      group.push(x);
    }
    if (group.length) flush();
  }
  return out.sort((a, b) => b.times.length - a.times.length);
}

export const ENDED_LABEL: Record<NonNullable<FaultIncident['endedHow']>, string> = {
  self: 'limpou sozinho',
  reset: 'rearmada',
  unknown: 'fim desconhecido',
};

/** How a fault ended, in one phrase. */
export function endPhrase(f: FaultIncident): string {
  if (f.status === 'active') return f.lockout ? 'bloqueada — em curso' : 'em curso';
  if (f.status === 'unknown' || f.endedAt === undefined) return 'sem registo do fim';
  const mins = faultMinutes(f)!;
  const dur = mins < 60 ? `${Math.max(1, Math.round(mins))} min` : `${(mins / 60).toLocaleString('pt-PT', { maximumFractionDigits: 1 })} h`;
  const how = f.endedHow === 'self' ? 'limpou sozinho' : f.endedHow === 'reset' ? `rearmada às ${fmtTime(f.endedAt)}${mins >= 24 * 60 ? ` de ${fmtDate(f.endedAt)}` : ''}` : 'terminou';
  return `${how} (${dur})`;
}

// ---------------------------------------------------------------------------
// Pattern per fault code
// ---------------------------------------------------------------------------

const range = (vals: Array<number | undefined>, digits = 0) => {
  const v = vals.filter((x): x is number => x !== undefined);
  if (v.length === 0) return undefined;
  const lo = num(Math.min(...v), digits);
  const hi = num(Math.max(...v), digits);
  return lo === hi ? lo : `${lo}–${hi}`;
};
const median = (v: number[]) => {
  if (v.length === 0) return undefined;
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Fills `minutesSincePrevious` where the record lacks it — the bridge doesn't
 * link one fault to the last — from the fault before it. Expects time order.
 */
export function linkPrevious(faults: FaultIncident[]): FaultIncident[] {
  return faults.map((f, i) => i === 0 || f.minutesSincePrevious !== undefined ? f
    : { ...f, minutesSincePrevious: Math.round((f.at - faults[i - 1].at) / MIN) });
}

/** A trip this soon after the compressor started: the pump never got going. */
const SHORT_RUN_MIN = 20;
/** A run that starts this long after the trip before — after its reset, if it locked out — opens a new episode. */
const SPELL_GAP = 6 * 60 * MIN;

/**
 * The trips at the end of the record that each came minutes after a start —
 * the pump can't run at all, rather than trips now and then. Empty unless
 * there are at least three and the last is from the past day.
 */
export function shortRunSpell(faults: FaultIncident[], now: number): FaultIncident[] {
  const byTime = [...faults].sort((a, b) => a.at - b.at);
  const spell: FaultIncident[] = [];
  for (let i = byTime.length - 1; i >= 0; i--) {
    const f = byTime[i];
    const run = tripContext(f)?.runMin;
    if (run === undefined || run > SHORT_RUN_MIN) break;
    if (spell.length && tripContext(spell[0])!.runFrom! - (f.endedAt ?? f.at) > SPELL_GAP) break;
    spell.unshift(f);
  }
  return spell.length >= 3 && now - spell[spell.length - 1].at <= 24 * 60 * MIN ? spell : [];
}

const hoursOrMin = (min: number) =>
  min < 90 ? `${Math.round(min)} min` : `${(min / 60).toLocaleString('pt-PT', { maximumFractionDigits: 1 })} h`;

/** A short-run spell (shortRunSpell) in sentences: the top of the technicians' report. `previous` = the fault before it. */
export function spellSummary(spell: FaultIncident[], previous?: FaultIncident): string[] {
  if (spell.length === 0) return [];
  const ctx = spell.map(f => tripContext(f)!);
  const codes = [...new Set(spell.map(f => f.code))].join(', ');
  const runs = ctx.map(c => c.runMin);
  const out: string[] = [];
  out.push(
    `Desde ${fmtDateTime(ctx[0].runFrom!)}, ${spell.length} arranques seguidos acabaram em ${codes}: ` +
    `disparou sempre ${range(runs)} min depois de o compressor arrancar.`,
  );
  const peaks = ctx.map(c => c.outPeak).filter((v): v is number => v !== undefined);
  const sps = ctx.map(c => c.last.sp).filter((v): v is number => v !== undefined);
  const valves = range(ctx.map(c => c.last.valves));
  if (peaks.length) {
    const far = sps.length > 0 && Math.max(...peaks) <= Math.min(...sps) - 5;
    out.push(
      `A água à saída não passou dos ${num(Math.max(...peaks), 1)} °C` +
      (sps.length ? `, com o setpoint a ${range(sps)} °C` : '') +
      (valves ? ` e ${valves} zonas abertas` : '') +
      (far ? ': disparou longe do setpoint.' : '.'),
    );
  }
  const rests = ctx.slice(1).map((c, i) => (c.runFrom! - spell[i].at) / MIN);
  if (rests.length) {
    out.push(
      `Antes de cada arranque esteve parada entre ${hoursOrMin(Math.min(...rests))} e ${hoursOrMin(Math.max(...rests))} ` +
      'desde o disparo anterior, e voltou a disparar da mesma forma.',
    );
  }
  out.push(
    `Nos ~3 min antes de cada disparo, a descarga passou de ${range(ctx.map(c => c.disBefore))} para ${range(ctx.map(c => c.disAt))} °C, ` +
    `a serpentina (C00) chegou a ${range(ctx.map(c => c.coilMin), 1)} °C e a água à saída passou de ` +
    `${range(ctx.map(c => c.outPeak), 1)} para ${range(ctx.map(c => c.last.out), 1)} °C.`,
  );
  const locks = spell.filter(f => f.lockout);
  if (locks.length) {
    out.push(`Bloqueou ${locks.length === 1 ? 'uma vez' : `${locks.length} vezes`}: ${locks.map(f => `${fmtDateTime(f.at)}, ${endPhrase(f)}`).join('; ')}.`);
  }
  if (previous) out.push(`Antes desta série, o disparo anterior tinha sido a ${fmtDateTime(previous.at)}.`);
  out.push(`Cada arranque dá cerca de ${num(median(runs.filter((v): v is number => v !== undefined))!, 0)} min de aquecimento: assim, a máquina não consegue aquecer a casa.`);
  return out;
}

/** What the record says about one code, in sentences, from the trips themselves. */
export function codeSummary(faults: FaultIncident[]): string[] {
  if (faults.length === 0) return [];
  const byTime = [...faults].sort((a, b) => a.at - b.at);
  const first = byTime[0].at;
  const last = byTime[byTime.length - 1].at;
  const out: string[] = [];
  const ctx = byTime.map(tripContext).filter((c): c is TripContext => !!c);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  out.push(
    `${plural(faults.length, 'disparo', 'disparos')}${faults.length > 1 ? ` entre ${fmtDate(first)} e ${fmtDate(last)}` : ` a ${fmtDate(first)}`}` +
    (ctx.length < faults.length ? `, ${ctx.length} com leituras ao detalhe.` : '.'),
  );
  const locks = byTime.filter(f => f.lockout);
  if (locks.length) {
    const second = locks.filter(f => f.minutesSincePrevious !== undefined);
    out.push(
      `${plural(locks.length, 'bloqueou', 'bloquearam')} a máquina (${locks.map(f => fmtDateTime(f.at)).join(', ')})` +
      (second.length === locks.length
        ? `, ${locks.length === 1 ? 'num segundo disparo' : 'sempre num segundo disparo'} ${range(second.map(f => f.minutesSincePrevious))} min depois do anterior.`
        : '.'),
    );
  }
  const selfCleared = byTime.filter(f => f.endedHow === 'self');
  const clearMin = median(selfCleared.map(f => faultMinutes(f)!).filter(v => v !== undefined));
  if (selfCleared.length && clearMin !== undefined) {
    out.push(`${plural(selfCleared.length, 'limpou', 'limparam')} sozinho${selfCleared.length === 1 ? '' : 's'}, em ${num(clearMin, 1)} min (mediana), e a máquina voltou a arrancar.`);
  }
  if (ctx.length) {
    const idle = ctx.filter(c => c.idleMin > 0);
    if (idle.length) {
      out.push(
        `Antes de ${idle.length === ctx.length ? (ctx.length === 1 ? 'o disparo' : `todos os ${ctx.length}`) : `${idle.length} dos ${ctx.length}`}, ` +
        `o compressor esteve no mínimo (≤ ${IDLE_HZ} Hz) com a água no setpoint durante ${range(idle.map(c => c.idleMin))} min.`,
      );
    }
    const rise = range(ctx.map(c => c.disRise));
    out.push(
      `Nos ~3 min antes, o compressor passou de ${range(ctx.map(c => c.hzBefore))} para ${range(ctx.map(c => c.hzMax))} Hz` +
      (rise ? ` e a descarga subiu ${rise} °C.` : '.'),
    );
    out.push(
      `Água à saída no disparo: ${range(ctx.map(c => c.last.out), 1)} °C, com o setpoint a ${range(ctx.map(c => c.last.sp))} °C; ` +
      `exterior ${range(ctx.map(c => c.last.outdoor), 1)} °C.`,
    );
    const hours = ctx.map(c => hourOfDay(c.trip.t));
    const night = hours.filter(h => h < 7 || h >= 22).length;
    out.push(`Hora do dia: ${night} de noite (22h–7h), ${ctx.length - night} de dia.`);
  }
  return out;
}
