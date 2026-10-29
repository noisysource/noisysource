// packages/shared/finhub/noisysource/state.ts
//
// Rebuilds NoisySource's current state from its events (reversed events dropped). Pure: the
// screens call it on every load; nothing it returns is ever stored.
//
// Plans are versioned by date: the version in force on a day is the one with the latest `from`
// (or start) on or before it; two versions with the same date → the one recorded last wins.

import { liveEvents, sortEvents } from '../envelope';
import type { ExtraHolidays } from '../holidays';
import type {
  BankMovement, CalendarEntry, CostPlan, EcContractSigned, EmploymentTerms, NsEvent, NsEventOf,
  NsEventType, NsPayload, PaymentRule, PaymentRuleWhat, Payslip,
} from './events';

export type WithId<T> = T & { eventId: string };

export interface EcContractState extends WithId<EcContractSigned> {
  /** Set by `ec.contract.ended` (early end); otherwise the last day is computed. */
  endedLastDay?: string;
  endReason?: string;
}

export interface MovementState extends BankMovement {
  id: string;
}

export interface HolidayMeta {
  toConfirm: boolean;
  names: Record<string, string>;
  note?: string;
}

export interface NsState {
  contracts: EcContractState[];
  /** personId → versions ordered by `from`. */
  terms: Record<string, WithId<EmploymentTerms>[]>;
  people: { id: string; name: string }[];
  employmentEnded: Record<string, string>;
  calendar: WithId<CalendarEntry>[];
  extraHolidays: ExtraHolidays;
  /** `${calendarId}:${year}` → names and the "a confirmar" flag. */
  holidayMeta: Record<string, HolidayMeta>;
  rules: WithId<PaymentRule>[];
  costPlans: WithId<CostPlan>[];
  /** `${contractNumber}|${yyyy-mm}` → timesheet. */
  timesheets: Record<string, WithId<NsPayload<'ec.timesheet.submitted'>>>;
  invoices: WithId<NsPayload<'ec.invoice.issued'>>[];
  /** `${personId}|${yyyy-mm}` → payslip. */
  payslips: Record<string, WithId<Payslip>>;
  /** Ordered by date, then statement position. */
  movements: MovementState[];
  matches: Record<string, WithId<NsPayload<'bank.movement.matched'>>>;
  classifications: Record<string, WithId<NsPayload<'bank.movement.classified'>>>;
  eventCount: number;
}

function of<T extends NsEventType>(events: readonly NsEvent[], type: T): NsEventOf<T>[] {
  return events.filter(e => e.type === type) as unknown as NsEventOf<T>[];
}

export function rebuildNsState(allEvents: readonly NsEvent[]): NsState {
  const events = sortEvents(liveEvents(allEvents));

  const ended = new Map<string, NsPayload<'ec.contract.ended'>>();
  for (const e of of(events, 'ec.contract.ended')) ended.set(e.payload.number, e.payload);
  const contractsByNumber = new Map<string, EcContractState>();
  for (const e of of(events, 'ec.contract.signed')) {
    const end = ended.get(e.payload.number);
    contractsByNumber.set(e.payload.number, {
      ...e.payload, eventId: e.id, endedLastDay: end?.lastDay, endReason: end?.reason,
    });
  }
  const contracts = [...contractsByNumber.values()].sort((a, b) =>
    a.client.localeCompare(b.client) || a.startDate.localeCompare(b.startDate));

  const terms: NsState['terms'] = {};
  const names = new Map<string, string>();
  for (const e of of(events, 'employment.terms.set')) {
    const list = (terms[e.payload.personId] ??= []);
    const same = list.findIndex(v => v.from === e.payload.from);
    const v = { ...e.payload, eventId: e.id };
    if (same >= 0) list[same] = v; else list.push(v);
    names.set(e.payload.personId, e.payload.personName);
  }
  for (const list of Object.values(terms)) list.sort((a, b) => a.from.localeCompare(b.from));

  const employmentEnded: Record<string, string> = {};
  for (const e of of(events, 'employment.ended')) employmentEnded[e.payload.personId] = e.payload.lastDay;

  const extraHolidays: ExtraHolidays = {};
  const holidayMeta: Record<string, HolidayMeta> = {};
  for (const e of of(events, 'holidays.set')) {
    const p = e.payload;
    (extraHolidays[p.calendarId] ??= {})[p.year] = [...p.dates].sort();
    holidayMeta[`${p.calendarId}:${p.year}`] = { toConfirm: !!p.toConfirm, names: p.names ?? {}, note: p.note };
  }

  const timesheets: NsState['timesheets'] = {};
  for (const e of of(events, 'ec.timesheet.submitted')) {
    timesheets[`${e.payload.contractNumber}|${e.payload.month}`] = { ...e.payload, eventId: e.id };
  }

  const payslips: NsState['payslips'] = {};
  for (const e of of(events, 'payroll.payslip.recorded')) {
    payslips[`${e.payload.personId}|${e.payload.month}`] = { ...e.payload, eventId: e.id };
  }

  const movements = of(events, 'bank.movement.imported')
    .map(e => ({ ...e.payload, id: e.id }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId) || a.date.localeCompare(b.date)
      || a.importId.localeCompare(b.importId) || a.seq - b.seq);

  const matches: NsState['matches'] = {};
  for (const e of of(events, 'bank.movement.matched')) matches[e.payload.movementId] = { ...e.payload, eventId: e.id };
  const classifications: NsState['classifications'] = {};
  for (const e of of(events, 'bank.movement.classified')) classifications[e.payload.movementId] = { ...e.payload, eventId: e.id };

  return {
    contracts,
    terms,
    people: [...names.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id)),
    employmentEnded,
    calendar: of(events, 'calendar.entry.set').map(e => ({ ...e.payload, eventId: e.id })),
    extraHolidays,
    holidayMeta,
    rules: of(events, 'payment.rule.set').map(e => ({ ...e.payload, eventId: e.id })),
    costPlans: of(events, 'cost.plan.set').map(e => ({ ...e.payload, eventId: e.id })),
    timesheets,
    invoices: of(events, 'ec.invoice.issued').map(e => ({ ...e.payload, eventId: e.id })),
    payslips,
    movements,
    matches,
    classifications,
    eventCount: allEvents.length,
  };
}

/** The person's terms in force on `date`, or null (not hired yet, or employment ended). */
export function termsAt(state: NsState, personId: string, date: string): WithId<EmploymentTerms> | null {
  const end = state.employmentEnded[personId];
  if (end && date > end) return null;
  let found: WithId<EmploymentTerms> | null = null;
  for (const v of state.terms[personId] ?? []) if (v.from <= date) found = v;
  return found;
}

/** The payment rule for `what` in force on `date` (latest `from` ≤ date; same `from` → last recorded). */
export function ruleAt(state: NsState, what: PaymentRuleWhat, date: string): WithId<PaymentRule> | null {
  let found: WithId<PaymentRule> | null = null;
  for (const r of state.rules) if (r.what === what && r.from <= date && (!found || r.from >= found.from)) found = r;
  return found;
}

/** For each cost plan key, its versions ordered by `from` (a later version replaces the earlier one). */
export function costPlanVersions(state: NsState): Record<string, WithId<CostPlan>[]> {
  const out: Record<string, WithId<CostPlan>[]> = {};
  for (const c of state.costPlans) {
    const list = (out[c.key] ??= []);
    const same = list.findIndex(v => v.from === c.from);
    if (same >= 0) list[same] = c; else list.push(c);
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.from.localeCompare(b.from));
  return out;
}

/** The person's calendar entries (all kinds). */
export function calendarOf(state: NsState, personId: string): WithId<CalendarEntry>[] {
  return state.calendar.filter(c => c.personId === personId);
}
