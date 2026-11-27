// FinHub's financial calendar (decided 2026-11-27): the dates that involve money, FinHub their
// master. Plans he makes here (days off, trips) and the money dates the book already knows
// (client payments due, payslips and their taxes, subscriptions, loan instalments) in one list.
// Atlas writes the plans to a "FinHub" Google calendar and shows all of it beside his other
// calendars; FinHub shows only this. Pure.

import { addDays, endDateOf, projectContract, type ClientContract, type ContractHandover, type DayOff } from './clientContracts';

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
  readonly payslips?: readonly { id: string; employeeName: string; payDate: string; taxDueDate: string; netPay: number; employeeWithholdings: number; employerTaxes: number }[];
  readonly subscriptions?: readonly { id: string; name: string; amount: number; frequency: string; billingDay: number; billingMonth: number; status?: string }[];
  readonly loans?: readonly { id: string; name: string; monthlyPayment: number; dueDay: number; maturityDate: string; status?: string }[];
}): CalendarItem[] => {
  const { from, to } = input;
  const inRange = (i: CalendarItem) => (i.endDate ?? i.date) >= from && i.date <= to;
  const items: CalendarItem[] = [...dayOffSpans(input.daysOff ?? [])];

  for (const t of input.trips ?? []) {
    if (t.status === 'cancelled') continue;
    items.push({ key: `trip:${t.id}`, kind: 'trip', date: t.startDate, endDate: t.endDate, title: `Trip: ${t.title}${t.destination ? ` (${t.destination})` : ''}`, plan: true });
    const perDiem = perDiemOf(t);
    // Paid with the salary of the month the trip ends.
    if (perDiem > 0) items.push({ key: `perdiem:${t.id}`, kind: 'per_diem', date: lastDay(t.endDate.slice(0, 7)), title: `Per diem for ${t.title} (${t.traveller || 'salary'})`, amount: -perDiem, plan: false });
  }

  for (const c of input.contracts ?? []) {
    const mine = (input.handovers ?? []).filter((h) => h.contractId === c.id);
    for (const h of mine) items.push({ key: `payin:${h.id}`, kind: 'payment_in', date: h.expectedPayDate, title: `${c.clientName} pays ${h.month}`, amount: h.amount, plan: false });
    // Months not handed over yet: handed over on the 1st of the next month, paid N days later.
    if (!c.active) continue;
    const p = projectContract(c, input.handovers ?? [], input.daysOff ?? [], input.today);
    for (const m of p.months) {
      if (m.plannedDays <= 0) continue;
      const handOver = addDays(lastDay(m.month), 1);
      items.push({ key: `payin:${c.id}:${m.month}`, kind: 'payment_in', date: addDays(handOver, c.paymentTermsDays || 0), title: `${c.clientName} pays ${m.month} (${m.plannedDays} days, projected)`, amount: m.amount, projected: true, plan: false });
    }
    const end = p.projectedEnd ?? endDateOf(c);
    items.push({ key: `contractend:${c.id}`, kind: 'payment_in', date: end, title: `${c.clientName}: ${p.projectedEnd ? 'the days run out' : 'the period ends'}`, projected: true, plan: false });
  }

  for (const s of input.payslips ?? []) {
    if (s.payDate) items.push({ key: `pay:${s.id}`, kind: 'payslip', date: s.payDate, title: `Salary: ${s.employeeName}`, amount: -s.netPay, plan: false });
    if (s.taxDueDate) items.push({ key: `tax:${s.id}`, kind: 'tax', date: s.taxDueDate, title: `IRS and Social Security: ${s.employeeName}`, amount: -((s.employeeWithholdings || 0) + (s.employerTaxes || 0)), plan: false });
  }

  for (const s of input.subscriptions ?? []) {
    if (s.status && s.status !== 'active') continue;
    for (const m of monthsBetween(from, to)) {
      if (s.frequency === 'annual' && Number(m.slice(5)) !== s.billingMonth) continue;
      items.push({ key: `sub:${s.id}:${m}`, kind: 'subscription', date: dayIn(m, s.billingDay), title: s.name, amount: -s.amount, plan: false });
    }
  }

  for (const l of input.loans ?? []) {
    if (l.status && l.status !== 'active') continue;
    for (const m of monthsBetween(from, to)) {
      const date = dayIn(m, l.dueDay);
      if (l.maturityDate && date > l.maturityDate) continue;
      items.push({ key: `loan:${l.id}:${m}`, kind: 'loan', date, title: l.name, amount: -l.monthlyPayment, plan: false });
    }
  }

  return items.filter(inRange).sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
};
