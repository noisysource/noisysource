// Client contracts (the income side): a pot of days at a daily rate over a period, like the
// Malt contract. Each month he hands over the days worked; the client pays N days later. The
// calendar decides how fast the pot empties: weekdays, minus his days off (vacations from his
// Google Calendar, brought in by Atlas) and the client's closures (the Commission's holidays,
// entered once a year). The projection counts forward to the day the days run out, so a
// vacation in August moves the end date, and warns when it's time to renegotiate. Pure.

export type DayOffKind = 'vacation' | 'day_off' | 'client_closure' | 'public_holiday';

export interface DayOff {
  id: string;
  userId: string;
  /** YYYY-MM-DD. */
  date: string;
  kind: DayOffKind;
  label: string;
  /** google: from his Google Calendar (Atlas keeps these in step); manual: entered here. */
  source: 'google' | 'manual';
}

/** A renegotiation from a month on: a new rate, more days, a new end date (any of them). */
export interface ContractAmendment {
  /** YYYY-MM: the first month it applies to. */
  from: string;
  dailyRate: number | null;
  addDays: number;
  newEndDate: string;
  note: string;
}

export interface ClientContract {
  id: string;
  userId: string;
  entityId: string;
  clientName: string;
  reference: string;
  /** YYYY-MM-DD. */
  startDate: string;
  endDate: string;
  daysAllowed: number;
  dailyRate: number;
  /** VAT percent on the invoices (0 when reverse charged). */
  vatRate: number;
  /** Days from the handover to the payment. */
  paymentTermsDays: number;
  /** Warn this many months before the days (or the period) run out. */
  warnMonths: number;
  amendments: ContractAmendment[];
  active: boolean;
  notes: string;
}

export interface ContractHandover {
  id: string;
  userId: string;
  contractId: string;
  /** YYYY-MM: the month worked. */
  month: string;
  days: number;
  dailyRate: number;
  amount: number;
  /** YYYY-MM-DD: when he handed the days over. */
  handedOverAt: string;
  /** YYYY-MM-DD: handedOverAt + the payment terms. */
  expectedPayDate: string;
  invoiceNumber: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDay = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const dayOf = (s: string) => new Date(`${s}T00:00:00Z`);
export const addDays = (s: string, n: number) => {
  const d = dayOf(s);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
};
const nextMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${pad(mo + 1)}`;
};

/** The amendments in force, oldest first. */
const amendmentsOf = (c: ClientContract) => [...(c.amendments ?? [])].sort((a, b) => a.from.localeCompare(b.from));

/** The daily rate for a month: the latest amendment with a rate from that month on, or the contract's. */
export const rateAt = (c: ClientContract, month: string): number =>
  amendmentsOf(c).reduce((rate, a) => (a.from <= month && typeof a.dailyRate === 'number' && a.dailyRate > 0 ? a.dailyRate : rate), c.dailyRate);

/** Every day the contract allows, extensions included. */
export const daysAllowedOf = (c: ClientContract) => c.daysAllowed + amendmentsOf(c).reduce((n, a) => n + (a.addDays || 0), 0);

/** The period's last day, after the latest extension. */
export const endDateOf = (c: ClientContract) => amendmentsOf(c).reduce((end, a) => (a.newEndDate && a.newEndDate > end ? a.newEndDate : end), c.endDate);

export interface ProjectionMonth {
  month: string;
  workingDays: number;
  daysOff: number;
  /** Days that would be handed over for it, at this pace. */
  plannedDays: number;
  amount: number;
}

export interface ContractProjection {
  allowed: number;
  handedOver: number;
  remaining: number;
  /** The day the days run out at this pace (null: they don't before the period ends). */
  projectedEnd: string | null;
  /** What ends it first: the days, or the period. */
  endsBy: 'days' | 'period';
  /** Days left unused when the period ends first. */
  unusedAtEnd: number;
  /** Money still to invoice, without VAT. */
  toInvoice: number;
  /** Within warnMonths of the end: time to renegotiate or extend. */
  warn: boolean;
  months: ProjectionMonth[];
}

/**
 * From the month after the last handover (or the start), every weekday that isn't a day off
 * uses one day, until the days or the period run out.
 */
export const projectContract = (c: ClientContract, handovers: readonly ContractHandover[], daysOff: readonly DayOff[], today: string): ContractProjection => {
  const mine = handovers.filter((h) => h.contractId === c.id);
  const allowed = daysAllowedOf(c);
  const handedOver = mine.reduce((n, h) => n + (h.days || 0), 0);
  const lastMonth = mine.reduce((m, h) => (h.month > m ? h.month : m), '');
  const end = endDateOf(c);
  let day = lastMonth ? `${nextMonth(lastMonth)}-01` : c.startDate;
  if (day < c.startDate) day = c.startDate;
  const off = new Set(daysOff.map((d) => d.date));
  let left = Math.max(0, allowed - handedOver);
  const months = new Map<string, ProjectionMonth>();
  let projectedEnd: string | null = null;
  let toInvoice = 0;
  // Three years at most: a contract with no end in sight still gets an answer.
  for (let i = 0; i < 3 * 366 && left > 0 && day <= end; i += 1, day = addDays(day, 1)) {
    const m = day.slice(0, 7);
    const row = months.get(m) ?? { month: m, workingDays: 0, daysOff: 0, plannedDays: 0, amount: 0 };
    months.set(m, row);
    const weekday = dayOf(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (off.has(day)) {
      row.daysOff += 1;
      continue;
    }
    row.workingDays += 1;
    const used = Math.min(1, left);
    row.plannedDays += used;
    row.amount += used * rateAt(c, m);
    toInvoice += used * rateAt(c, m);
    left -= used;
    if (left <= 0) projectedEnd = day;
  }
  const endsBy = projectedEnd ? 'days' : 'period';
  const until = projectedEnd ?? end;
  const warnFrom = (() => {
    const d = dayOf(until);
    d.setUTCMonth(d.getUTCMonth() - (c.warnMonths || 0));
    return isoDay(d);
  })();
  return {
    allowed,
    handedOver,
    remaining: Math.max(0, allowed - handedOver),
    projectedEnd,
    endsBy,
    unusedAtEnd: projectedEnd ? 0 : left,
    toInvoice: Math.round(toInvoice * 100) / 100,
    warn: c.active && today >= warnFrom,
    months: [...months.values()].map((r) => ({ ...r, amount: Math.round(r.amount * 100) / 100 })),
  };
};

/** A handover's money and payment date, from the contract's rate and terms. */
export const handoverOf = (c: ClientContract, month: string, days: number, handedOverAt: string) => {
  const dailyRate = rateAt(c, month);
  return { dailyRate, amount: Math.round(days * dailyRate * 100) / 100, expectedPayDate: addDays(handedOverAt, c.paymentTermsDays || 0) };
};
