// packages/shared/finhub/dates.ts
//
// Calendar dates as 'YYYY-MM-DD' strings and months as 'YYYY-MM', computed in UTC so the result
// never depends on the browser's time zone. Pure, no dependencies.

export type IsoDate = string; // YYYY-MM-DD
export type YearMonth = string; // YYYY-MM

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isIsoDate(s: unknown): s is IsoDate {
  if (typeof s !== 'string') return false;
  const m = s.match(DATE_RE);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function isYearMonth(s: unknown): s is YearMonth {
  return typeof s === 'string' && MONTH_RE.test(s);
}

function toUtc(iso: IsoDate): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function isoFromParts(year: number, month1to12: number, day: number): IsoDate {
  return fromUtc(new Date(Date.UTC(year, month1to12 - 1, day)));
}

export function addDays(iso: IsoDate, n: number): IsoDate {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

/** Same day n months later, clamped to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsClamped(iso: IsoDate, n: number): IsoDate {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = daysInMonth(monthOf(fromUtc(target)));
  return isoFromParts(target.getUTCFullYear(), target.getUTCMonth() + 1, Math.min(d, last));
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(iso: IsoDate): number {
  return toUtc(iso).getUTCDay();
}

export function isWeekend(iso: IsoDate): boolean {
  const w = weekday(iso);
  return w === 0 || w === 6;
}

export function monthOf(iso: IsoDate): YearMonth {
  return iso.slice(0, 7);
}

export function yearOf(isoOrMonth: string): number {
  return Number(isoOrMonth.slice(0, 4));
}

export function daysInMonth(month: YearMonth): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function firstDay(month: YearMonth): IsoDate {
  return `${month}-01`;
}

export function lastDay(month: YearMonth): IsoDate {
  return `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
}

export function addMonths(month: YearMonth, n: number): YearMonth {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return fromUtc(d).slice(0, 7);
}

/** Months from `from` to `to`, both included. Empty when from > to. */
export function monthsBetween(from: YearMonth, to: YearMonth): YearMonth[] {
  const out: YearMonth[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** Every date from `from` to `to`, both included. Empty when from > to. */
export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Whole days from a to b (b − a). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a > b ? a : b;
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a < b ? a : b;
}

/** Today in Lisbon (the business's calendar), as YYYY-MM-DD. */
export function todayInLisbon(now: Date = new Date()): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon' }).format(now);
}
