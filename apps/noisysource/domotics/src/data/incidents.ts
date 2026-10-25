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
  note?: string;
  origin: IncidentOrigin;
}

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
  return {
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
