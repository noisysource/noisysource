// FinHub's financial calendar (decided 2026-11-27): the dates that involve money, FinHub their
// master. Plans he makes here (days off, trips) and the money dates the book already knows
// (client payments due, payslips and their taxes, subscriptions, loan instalments) in one list.
// Atlas writes the plans to a "FinHub" Google calendar and shows all of it beside his other
// calendars; FinHub shows only this. Pure.

import { addDays, endDateOf, projectContract, type ClientContract, type ContractHandover, type DayOff, type DayOffKind } from './clientContracts';

export type TripStatus = 'planned' | 'booked' | 'done' | 'cancelled';
export type TripCostKind = 'flight' | 'hotel' | 'per_diem' | 'transport' | 'other';

/** A cost the trip is expected to bring: an invoice to come, or the per diem in a salary. */
export interface TripCost {
  kind: TripCostKind;
  label: string;
  amount: number;
}

export interface Trip {
  id: string;
  userId: string;
  /** Who pays (the company, for a business trip). */
  entityId: string;
  title: string;
  destination: string;
  /** YYYY-MM-DD, both days included. */
  startDate: string;
  endDate: string;
  traveller: string;
  status: TripStatus;
  /** Per day away, paid with the next salary. */
  perDiemDaily: number;
  /** Days of per diem (usually every day of the trip). */
  perDiemDays: number;
  costs: TripCost[];
  notes: string;
}

export type CalendarKind = 'day_off' | 'trip' | 'per_diem' | 'payment_in' | 'payslip' | 'tax' | 'subscription' | 'loan';

export interface CalendarItem {
  /** Stable across reads: Atlas keys its Google events on it. */
  key: string;
  kind: CalendarKind;
  /** YYYY-MM-DD. */
  date: string;
  /** The last day, for something that spans days (YYYY-MM-DD, included). */
  endDate?: string;
  title: string;
  /** Money in (+) or out (−), when there is any. */
  amount?: number;
  /** Not yet in the book: worked out from a contract's pace. */
  projected?: boolean;
  /** A plan he makes in FinHub (days off, trips): these go to his Google Calendar. */
  plan: boolean;
  /** Whose money it is (none for days off and trips themselves). */
  entityId?: string;
  /** With withBalance: the balance after this movement. */
  balance?: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const monthDays = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** The day in a month, kept within it (the 31st in February is the 28th). */
const dayIn = (month: string, day: number) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad(Math.min(Math.max(1, day), monthDays(y, m)))}`;
};
const monthsBetween = (from: string, to: string) => {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  for (let i = 0; i < 60; i += 1) {
    const mo = `${y}-${pad(m)}`;
    if (mo > to.slice(0, 7)) break;
    out.push(mo);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
};
const lastDay = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad(monthDays(y, m))}`;
};

const KIND_TITLE: Record<DayOff['kind'], string> = { vacation: 'Vacation', day_off: 'Day off', client_closure: 'Client closure', public_holiday: 'Public holiday' };

/** Consecutive days off of the same kind and label, as one span (weekends don't break it). */
export const dayOffSpans = (days: readonly DayOff[]): CalendarItem[] => {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const out: CalendarItem[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    const title = d.label ? `${KIND_TITLE[d.kind]}: ${d.label}` : KIND_TITLE[d.kind];
    const gapOk = last && last.title === title && (() => {
      // The next day, or across a weekend.
      for (let n = 1, x = last.endDate ?? last.date; n <= 3; n += 1) {
        x = addDays(x, 1);
        if (x === d.date) return true;
        const wd = new Date(`${x}T00:00:00Z`).getUTCDay();
        if (wd !== 0 && wd !== 6) return false;
      }
      return false;
    })();
    if (last && gapOk) last.endDate = d.date;
    else out.push({ key: `dayoff:${d.date}:${d.kind}`, kind: 'day_off', date: d.date, endDate: d.date, title, plan: true });
  }
  return out;
};

/** A trip's per diem: daily × days. */
export const perDiemOf = (t: Trip) => Math.round((t.perDiemDaily || 0) * (t.perDiemDays || 0) * 100) / 100;

export const financialCalendar = (input: {
  readonly from: string;
  readonly to: string;
  readonly today: string;
  readonly daysOff?: readonly DayOff[];
  readonly trips?: readonly Trip[];
  readonly contracts?: readonly ClientContract[];
  readonly handovers?: readonly ContractHandover[];
  readonly payslips?: readonly { id: string; entityId?: string; employeeName: string; payDate: string; taxDueDate: string; netPay: number; employeeWithholdings: number; employerTaxes: number }[];
  readonly subscriptions?: readonly { id: string; entityId?: string; name: string; amount: number; frequency: string; billingDay: number; billingMonth: number; status?: string }[];
  readonly loans?: readonly { id: string; entityId?: string; name: string; monthlyPayment: number; dueDay: number; maturityDate: string; status?: string }[];
}): CalendarItem[] => {
  const { from, to } = input;
  const inRange = (i: CalendarItem) => (i.endDate ?? i.date) >= from && i.date <= to;
  const items: CalendarItem[] = [...dayOffSpans(input.daysOff ?? [])];

  for (const t of input.trips ?? []) {
    if (t.status === 'cancelled') continue;
    items.push({ key: `trip:${t.id}`, kind: 'trip', date: t.startDate, endDate: t.endDate, title: `Trip: ${t.title}${t.destination ? ` (${t.destination})` : ''}`, plan: true });
    const perDiem = perDiemOf(t);
    // Paid with the salary of the month the trip ends.
    if (perDiem > 0) items.push({ key: `perdiem:${t.id}`, kind: 'per_diem', date: lastDay(t.endDate.slice(0, 7)), title: `Per diem for ${t.title} (${t.traveller || 'salary'})`, amount: -perDiem, plan: false, entityId: t.entityId });
  }

  for (const c of input.contracts ?? []) {
    const mine = (input.handovers ?? []).filter((h) => h.contractId === c.id);
    for (const h of mine) items.push({ key: `payin:${h.id}`, kind: 'payment_in', date: h.expectedPayDate, title: `${c.clientName} pays ${h.month}`, amount: h.amount, plan: false, entityId: c.entityId });
    // Months not handed over yet: handed over on the 1st of the next month, paid N days later.
    if (!c.active) continue;
    const p = projectContract(c, input.handovers ?? [], input.daysOff ?? [], input.today);
    for (const m of p.months) {
      if (m.plannedDays <= 0) continue;
      const handOver = addDays(lastDay(m.month), 1);
      items.push({ key: `payin:${c.id}:${m.month}`, kind: 'payment_in', date: addDays(handOver, c.paymentTermsDays || 0), title: `${c.clientName} pays ${m.month} (${m.plannedDays} days, projected)`, amount: m.amount, projected: true, plan: false, entityId: c.entityId });
    }
    const end = p.projectedEnd ?? endDateOf(c);
    items.push({ key: `contractend:${c.id}`, kind: 'payment_in', date: end, title: `${c.clientName}: ${p.projectedEnd ? 'the days run out' : 'the period ends'}`, projected: true, plan: false });
  }

  for (const s of input.payslips ?? []) {
    if (s.payDate) items.push({ key: `pay:${s.id}`, kind: 'payslip', date: s.payDate, title: `Salary: ${s.employeeName}`, amount: -s.netPay, plan: false, entityId: s.entityId });
    if (s.taxDueDate) items.push({ key: `tax:${s.id}`, kind: 'tax', date: s.taxDueDate, title: `IRS and Social Security: ${s.employeeName}`, amount: -((s.employeeWithholdings || 0) + (s.employerTaxes || 0)), plan: false, entityId: s.entityId });
  }

  for (const s of input.subscriptions ?? []) {
    if (s.status && s.status !== 'active') continue;
    for (const m of monthsBetween(from, to)) {
      if (s.frequency === 'annual' && Number(m.slice(5)) !== s.billingMonth) continue;
      items.push({ key: `sub:${s.id}:${m}`, kind: 'subscription', date: dayIn(m, s.billingDay), title: s.name, amount: -s.amount, plan: false, entityId: s.entityId });
    }
  }

  for (const l of input.loans ?? []) {
    if (l.status && l.status !== 'active') continue;
    for (const m of monthsBetween(from, to)) {
      const date = dayIn(m, l.dueDay);
      if (l.maturityDate && date > l.maturityDate) continue;
      items.push({ key: `loan:${l.id}:${m}`, kind: 'loan', date, title: l.name, amount: -l.monthlyPayment, plan: false, entityId: l.entityId });
    }
  }

  return items.filter(inRange).sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
};

/** The balance after each movement, in date order, from what the accounts hold now. */
export const withBalance = (items: readonly CalendarItem[], start: number): CalendarItem[] => {
  let balance = start;
  return items.map((i) => {
    if (typeof i.amount !== 'number') return i;
    balance = Math.round((balance + i.amount) * 100) / 100;
    return { ...i, balance };
  });
};

// ── Plans Atlas proposes ("I'm off 22 Dec to 2 Jan", "a trip to Brussels 9–11 Dec") ──

export interface DaysOffDraft {
  /** YYYY-MM-DD, both days included. */
  from: string;
  to: string;
  kind: DayOffKind;
  label: string;
}

export interface TripDraft {
  title: string;
  destination: string;
  startDate: string;
  endDate: string;
  traveller: string;
  /** The paying company, by name (Atlas doesn't know FinHub's ids). */
  entityHint: string;
  perDiemDaily: number;
  perDiemDays: number;
}

export interface CalendarPlan {
  daysOff: Omit<DayOff, 'id' | 'userId' | 'source'>[];
  trips: Omit<Trip, 'id' | 'userId'>[];
  lines: string[];
  problems: string[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const weekday = (d: string) => {
  const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6;
};
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');

/**
 * Atlas's plans as FinHub's records: days off on the weekdays of each span (a day already off
 * stays as it is), trips paid by the company named. Pure.
 */
export const calendarPlanOf = (
  drafts: { readonly daysOff: readonly DaysOffDraft[]; readonly trips: readonly TripDraft[] },
  book: { readonly entities: readonly { id: string; name: string }[]; readonly daysOff: readonly DayOff[]; readonly trips: readonly Trip[] },
): CalendarPlan => {
  const plan: CalendarPlan = { daysOff: [], trips: [], lines: [], problems: [] };
  const taken = new Set(book.daysOff.map((d) => d.date));
  for (const d of drafts.daysOff) {
    if (!DATE.test(d.from) || !DATE.test(d.to) || d.to < d.from) {
      plan.problems.push(`days off ${d.from} to ${d.to}: not a date range`);
      continue;
    }
    let added = 0;
    let had = 0;
    for (let x = d.from, n = 0; x <= d.to && n < 400; x = addDays(x, 1), n += 1) {
      if (!weekday(x)) continue;
      if (taken.has(x)) {
        had += 1;
        continue;
      }
      taken.add(x);
      plan.daysOff.push({ date: x, kind: d.kind, label: d.label });
      added += 1;
    }
    plan.lines.push(`${d.label || d.kind.replace('_', ' ')} ${d.from}${d.to !== d.from ? ` to ${d.to}` : ''}: ${added} weekday${added === 1 ? '' : 's'} off${had ? ` (${had} already off)` : ''}`);
  }
  for (const t of drafts.trips) {
    if (!t.title.trim() || !DATE.test(t.startDate) || !DATE.test(t.endDate) || t.endDate < t.startDate) {
      plan.problems.push(`trip "${t.title}": needs a title and its dates`);
      continue;
    }
    const hint = norm(t.entityHint);
    const entity = (hint && book.entities.find((e) => norm(e.name) === hint || norm(e.name).includes(hint) || hint.includes(norm(e.name)))) || (book.entities.length === 1 ? book.entities[0] : undefined);
    if (!entity) {
      plan.problems.push(`trip "${t.title}": which company pays ("${t.entityHint}" isn't one of ${book.entities.map((e) => e.name).join(', ')})`);
      continue;
    }
    if (book.trips.some((x) => norm(x.title) === norm(t.title) && x.startDate === t.startDate)) {
      plan.lines.push(`Trip ${t.title} ${t.startDate}: already planned`);
      continue;
    }
    plan.trips.push({ entityId: entity.id, title: t.title.trim(), destination: t.destination, startDate: t.startDate, endDate: t.endDate, traveller: t.traveller, status: 'planned', perDiemDaily: t.perDiemDaily, perDiemDays: t.perDiemDays, costs: [], notes: 'From Atlas' });
    plan.lines.push(`Trip ${t.title} (${t.destination || 'no destination'}) ${t.startDate} to ${t.endDate}, paid by ${entity.name}${t.perDiemDaily > 0 ? `, per diem ${t.perDiemDays} × ${t.perDiemDaily}` : ''}`);
  }
  return plan;
};
