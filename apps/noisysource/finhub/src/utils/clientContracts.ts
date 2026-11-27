// Client contracts (the income side): a pot of days at a daily rate over a period, like the
// Malt contract. Each month he hands over the days worked; the client pays N days later. The
// calendar decides how fast the pot empties: weekdays, minus his days off (vacations, days off)
// and the client's closures (the Commission's holidays, entered once a year). FinHub is the
// master of this financial calendar; Atlas shows it beside his other calendars. The projection counts forward to the day the days run out, so a
// vacation in August moves the end date, and warns when it's time to renegotiate. Pure.

export type DayOffKind = 'vacation' | 'day_off' | 'client_closure' | 'public_holiday';

export interface DayOff {
  id: string;
  userId: string;
  /** YYYY-MM-DD. */
  date: string;
  kind: DayOffKind;
  label: string;
  /** Entered in FinHub, the master of the financial calendar. */
  source: 'manual';
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

// ── Handovers pasted from the client's invoice list (Malt's "Invoice" tab) ─────

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};

export interface PastedHandover {
  /** YYYY-MM. */
  month: string;
  days: number;
  /** As billed, when the paste shows it (else days × the month's rate). */
  amount: number;
  dailyRate: number;
  /** The 1st of the next month: the handover itself isn't on the invoice list. */
  handedOverAt: string;
  expectedPayDate: string;
  /** Billed differs from days × the contract's rate for that month. */
  rateDiffers: boolean;
}

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** "€11,940.18", "11.940,18 €", "€2,274.32" → 11940.18. */
const euros = (s: string): number => {
  const t = s.replace(/[^\d.,]/g, '');
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  const decimal = lastComma > lastDot && t.length - lastComma === 3 ? ',' : '.';
  const n = Number(decimal === ',' ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/**
 * The months in a pasted invoice list, in order: a month name, then "N days", then (if shown)
 * the amount billed. The year comes from the contract: the first month on or after its start,
 * then counting on (a month that comes round again is the next year). Copy the table, any layout.
 */
export const parseHandovers = (c: ClientContract, text: string): PastedHandover[] => {
  const words = plain(text);
  const re = new RegExp(`\\b(${Object.keys(MONTHS).join('|')})\\b[^\\d€]{0,40}?(\\d+(?:[.,]5)?)\\s*(?:days?|dias?|jours?)\\b([^€\\d]{0,40}(?:€\\s*[\\d.,]+|[\\d.,]+\\s*€))?`, 'g');
  const out: PastedHandover[] = [];
  let year = Number(c.startDate.slice(0, 4));
  let last = 0;
  for (const m of words.matchAll(re)) {
    const mo = MONTHS[m[1]];
    if (!mo) continue;
    if (out.length === 0) {
      if (mo < Number(c.startDate.slice(5, 7))) year += 1;
    } else if (mo <= last) year += 1;
    last = mo;
    const month = `${year}-${String(mo).padStart(2, '0')}`;
    const days = Number(m[2].replace(',', '.'));
    if (!(days > 0 && days <= 31)) continue;
    const rate = rateAt(c, month);
    const billed = m[3] ? euros(m[3]) : 0;
    const amount = billed > 0 ? billed : Math.round(days * rate * 100) / 100;
    const handedOverAt = `${month === `${year}-12` ? year + 1 : year}-${String(mo === 12 ? 1 : mo + 1).padStart(2, '0')}-01`;
    out.push({ month, days, amount, dailyRate: Math.round((amount / days) * 100) / 100, handedOverAt, expectedPayDate: addDays(handedOverAt, c.paymentTermsDays || 0), rateDiffers: billed > 0 && Math.abs(billed - days * rate) > 0.05 });
  }
  return out;
};

/**
 * Days worked an agent proposed ("this week I worked 4 days"): add to a month, or set a month.
 * Atlas names the contract; FinHub works out the month's handover from what's already there.
 */
export interface DaysWorked {
  contractId: string;
  reference: string;
  clientName: string;
  /** YYYY-MM: the month worked. */
  month: string;
  days: number;
  /** add: on top of what the month already has; set: the month's total. */
  mode: 'add' | 'set';
}

export interface DaysWorkedPlan {
  /** New handovers to create (a month that had one gets a new one with the new total). */
  create: Omit<ContractHandover, 'id' | 'userId'>[];
  /** The handovers they replace, deleted once the new ones are written. */
  replace: string[];
  /** One line per month, for the toast. */
  lines: string[];
  problems: string[];
}

export const daysWorkedPlan = (contracts: readonly ClientContract[], handovers: readonly ContractHandover[], drafts: readonly DaysWorked[]): DaysWorkedPlan => {
  const plan: DaysWorkedPlan = { create: [], replace: [], lines: [], problems: [] };
  // Several drafts for one month add up, in order.
  const totals = new Map<string, { c: ClientContract; month: string; days: number; before?: ContractHandover }>();
  for (const d of drafts) {
    const c = contracts.find((x) => x.id === d.contractId) ?? contracts.find((x) => d.reference && x.reference.trim() === d.reference.trim());
    if (!c) {
      plan.problems.push(`${d.clientName || 'Client'} ${d.reference}: no such contract in the book`);
      continue;
    }
    const key = `${c.id}|${d.month}`;
    const before = handovers.find((h) => h.contractId === c.id && h.month === d.month);
    const now = totals.get(key) ?? { c, month: d.month, days: before?.days ?? 0, ...(before ? { before } : {}) };
    now.days = d.mode === 'set' ? d.days : now.days + d.days;
    totals.set(key, now);
  }
  for (const { c, month, days, before } of totals.values()) {
    const label = `${c.clientName} ${c.reference} ${month}`.replace(/\s+/g, ' ');
    if (!(days >= 0 && days <= 31)) {
      plan.problems.push(`${label}: ${days} days is more than a month has`);
      continue;
    }
    if (before && before.days === days) continue;
    const handedOverAt = before?.handedOverAt || `${nextMonth(month)}-01`;
    if (days > 0) plan.create.push({ contractId: c.id, month, days, ...handoverOf(c, month, days, handedOverAt), handedOverAt, invoiceNumber: before?.invoiceNumber ?? '' });
    if (before) plan.replace.push(before.id);
    plan.lines.push(`${label}: ${before ? `${before.days} → ` : ''}${days} days`);
  }
  return plan;
};
