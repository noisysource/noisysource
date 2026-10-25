import {
  SLOT_MS, SLOT_SEC, addDays, addFlows, dayStart, daysBetween, derivedFlows, isVazio, lisbonDate, lisbonOffsetMs,
  slotSurplus, zeroFlows, type EnergyDay, type EnergyFlows, type Tariff,
} from '@shared/lib/energyBill';

/** Periods, chart buckets and number formatting for the Energia page. Pure. */

export type PeriodKind = 'day' | 'week' | 'month' | 'year' | 'custom';
/** Dates inclusive, Lisbon. */
export interface Period { kind: PeriodKind; from: string; to: string }
export type Grain = 'hour' | 'day' | 'month';

const HOUR = 3_600_000;
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const lastOfMonth = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);

export function periodContaining(kind: Exclude<PeriodKind, 'custom'>, date: string): Period {
  switch (kind) {
    case 'day': return { kind, from: date, to: date };
    case 'week': {
      // Weeks start on Monday here.
      const from = addDays(date, -((weekday(date) + 6) % 7));
      return { kind, from, to: addDays(from, 6) };
    }
    case 'month': return { kind, from: `${date.slice(0, 7)}-01`, to: lastOfMonth(date.slice(0, 7)) };
    case 'year': return { kind, from: `${date.slice(0, 4)}-01-01`, to: `${date.slice(0, 4)}-12-31` };
  }
}

/** The previous or next period of the same kind (a custom one moves by its own length). */
export function shiftPeriod(p: Period, dir: 1 | -1): Period {
  switch (p.kind) {
    case 'day': return periodContaining('day', addDays(p.from, dir));
    case 'week': return periodContaining('week', addDays(p.from, 7 * dir));
    case 'month': {
      const d = new Date(Date.UTC(Number(p.from.slice(0, 4)), Number(p.from.slice(5, 7)) - 1 + dir, 1));
      return periodContaining('month', d.toISOString().slice(0, 10));
    }
    case 'year': return periodContaining('year', `${Number(p.from.slice(0, 4)) + dir}-01-01`);
    case 'custom': {
      const len = daysBetween(p.from, p.to) + 1;
      return { kind: 'custom', from: addDays(p.from, dir * len), to: addDays(p.to, dir * len) };
    }
  }
}

export function grainOf(p: Period): Grain {
  if (p.kind === 'day' || (p.kind === 'custom' && p.from === p.to)) return 'hour';
  if (p.kind === 'year' || (p.kind === 'custom' && daysBetween(p.from, p.to) > 62)) return 'month';
  return 'day';
}

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MON = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const dm = (date: string) => `${Number(date.slice(8, 10))} ${MON[Number(date.slice(5, 7)) - 1]}`;

export function periodLabel(p: Period, today: string): string {
  const y = (d: string) => d.slice(0, 4);
  switch (p.kind) {
    case 'day':
      if (p.from === today) return 'Hoje';
      if (p.from === addDays(today, -1)) return 'Ontem';
      return `${WEEKDAYS[weekday(p.from)]}, ${dm(p.from)}${y(p.from) !== y(today) ? ` ${y(p.from)}` : ''}`;
    case 'month': return `${MONTHS[Number(p.from.slice(5, 7)) - 1]} ${y(p.from)}`;
    case 'year': return y(p.from);
    default:
      return y(p.from) === y(p.to)
        ? `${dm(p.from)} – ${dm(p.to)} ${y(p.to)}`
        : `${dm(p.from)} ${y(p.from)} – ${dm(p.to)} ${y(p.to)}`;
  }
}

/** Short date for tables and notes: '25/10 14:05'. */
export function fmtWhen(t: number, withTime = true): string {
  const d = new Date(t + lisbonOffsetMs(t));
  const dd = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return withTime ? `${dd} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` : dd;
}
export const fmtHM = (t: number) => fmtWhen(t).slice(6);

export interface Bucket {
  start: number;
  end: number;
  /** Axis label. */
  label: string;
  /** Tooltip heading. */
  title: string;
  flows: EnergyFlows;
  coveredSec: number;
  /** Seconds of the bucket in the past (0 = future). */
  expectedSec: number;
  /** Hour buckets only: in vazio. */
  vazio?: boolean;
  /** Solar surplus sent to the grid (unpaid), Wh; and the part with the battery full. */
  surplus: number;
  surplusFull: number;
}

function emptyBucket(start: number, end: number, label: string, title: string): Bucket {
  return { start, end, label, title, flows: zeroFlows(), coveredSec: 0, expectedSec: 0, surplus: 0, surplusFull: 0 };
}

/** The period cut into chart buckets — hours of a day, days of a week or month, months of a year. */
export function bucketize(p: Period, days: EnergyDay[], tariff: Tariff, now: number): Bucket[] {
  const grain = grainOf(p);
  const rangeFrom = dayStart(p.from);
  const rangeTo = dayStart(addDays(p.to, 1));
  const out: Bucket[] = [];
  const index = new Map<string, Bucket>();

  if (grain === 'hour') {
    // Real hours: 25 on the October change (01:00 twice), 23 in March.
    for (let t = rangeFrom; t < rangeTo; t += HOUR) {
      const h = String(new Date(t + lisbonOffsetMs(t)).getUTCHours()).padStart(2, '0');
      const repeat = out.some(b => b.label === h);
      const b = emptyBucket(t, t + HOUR, h, `${h}:00–${String((Number(h) + 1) % 24).padStart(2, '0')}:00${repeat ? ' (hora repetida)' : ''}`);
      b.vazio = isVazio(t, tariff);
      out.push(b);
    }
  } else if (grain === 'day') {
    for (let d = p.from; d <= p.to; d = addDays(d, 1)) {
      const b = emptyBucket(dayStart(d), dayStart(addDays(d, 1)), String(Number(d.slice(8, 10))), `${WEEKDAYS[weekday(d)]}, ${dm(d)}`);
      out.push(b);
      index.set(d, b);
    }
  } else {
    for (let d = `${p.from.slice(0, 7)}-01`; d <= p.to; d = addDays(lastOfMonth(d.slice(0, 7)), 1)) {
      const to = addDays(lastOfMonth(d.slice(0, 7)), 1);
      const b = emptyBucket(dayStart(d < p.from ? p.from : d), dayStart(to > addDays(p.to, 1) ? addDays(p.to, 1) : to),
        MON[Number(d.slice(5, 7)) - 1], `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`);
      out.push(b);
      index.set(d.slice(0, 7), b);
    }
  }

  // Seconds each bucket has had so far, then the slots themselves.
  for (const b of out) b.expectedSec = Math.max(0, Math.min(b.end, now) - b.start) / 1000;
  for (const day of days) {
    day.slots.forEach((slot, i) => {
      if (!slot) return;
      const t = day.start + i * SLOT_MS;
      if (t < rangeFrom || t >= rangeTo) return;
      const b = grain === 'hour' ? out[Math.floor((t - rangeFrom) / HOUR)]
        : index.get(grain === 'day' ? lisbonDate(t) : lisbonDate(t).slice(0, 7));
      if (!b) return;
      addFlows(b.flows, slot);
      b.coveredSec += slot.sec;
      const sp = slotSurplus(slot);
      if (sp) {
        b.surplus += sp.wh;
        if (sp.full) b.surplusFull += sp.wh;
      }
    });
  }
  return out;
}

/** Battery % through the day, one point per slot with a reading. */
export function socSeries(days: EnergyDay[], from: number, to: number): Array<{ t: number; soc: number }> {
  const pts: Array<{ t: number; soc: number }> = [];
  for (const day of days) {
    day.slots.forEach((slot, i) => {
      const t = day.start + (i + 1) * SLOT_MS;
      if (slot?.soc !== undefined && t > from && t <= to) pts.push({ t, soc: slot.soc });
    });
  }
  return pts.sort((a, b) => a.t - b.t);
}

/** When the newest slot with data ends. */
export function lastRecorded(days: EnergyDay[]): number | undefined {
  let last: number | undefined;
  for (const day of days) {
    day.slots.forEach((slot, i) => {
      if (slot && slot.sec > 0) last = Math.max(last ?? 0, day.start + (i + 1) * SLOT_MS);
    });
  }
  return last;
}

/** The three stacks the chart draws, Wh. */
export function stacks(f: EnergyFlows) {
  const d = derivedFlows(f);
  return {
    house: { solar: f.pvLoad, battery: f.batLoad, grid: d.gridLoad },
    solar: { house: f.pvLoad, battery: d.pvBat, grid: d.pvGrid },
  };
}

// --- Formatting -----------------------------------------------------------------

const nf = (digits: number) => new Intl.NumberFormat('pt-PT', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const eur = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });

/** Wh → '0,45 kWh', '12,3 kWh', '1 234 kWh'. */
export function fmtKwh(wh: number, unit = true): string {
  const kwh = wh / 1000;
  const a = Math.abs(kwh);
  const s = nf(a < 1 ? 2 : a < 100 ? 1 : 0).format(kwh);
  return unit ? `${s} kWh` : s;
}
export const fmtEur = (v: number) => eur.format(v);
export const fmtPct = (share: number | undefined) => (share === undefined ? '—' : `${Math.round(share * 100)}%`);
export const coverageOf = (covered: number, expected: number) => (expected > 0 ? Math.min(1, covered / expected) : 1);
export const SLOT_SECONDS = SLOT_SEC;

/** '3 h 15 min', '45 min'. */
export function fmtDuration(sec: number): string {
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** '12:00–15:00'. */
export const fmtHours = (from: number, to: number) => `${String(from).padStart(2, '0')}:00–${String(to % 24).padStart(2, '0')}:00`;
