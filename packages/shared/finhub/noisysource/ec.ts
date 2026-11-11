// packages/shared/finhub/noisysource/ec.ts
//
// EC contracts: days per month and the runway (days used / planned / left, projected last day and
// the warning 3 months before it). HANDOFF-finhub-v2.md, "The days engine" → EC days, EC runway.
//
// Days of a month are the submitted timesheet's when there is one, otherwise the planned days
// (client's calendar − the person's days off; trip days count as worked). A contract that started
// before FinHub's history carries an opening position (days used up to a date).
//
// The walk is the same as computeEcProjection's (packages/shared/lib/ecProjection.ts, which
// reproduced the client's end date in #94); ec.test.ts checks they agree when there's no
// timesheet and no opening. This version adds timesheets, openings and early ends.

import { addDays, addMonths, addMonthsClamped, monthOf, yearOf, type IsoDate, type YearMonth } from '../dates';
import { plannedEcDays, personDays, workingDays, type PersonDays } from '../days';
import { holidayDates } from '../holidays';
import { calendarOf, type EcContractState, type NsState } from './state';

export const EC_WARNING_MONTHS = 3;
/** Safety bound for the walk: no contract runs longer than this. */
const MAX_MONTHS = 60;

export interface EcMonth {
  month: YearMonth;
  days: number;
  source: 'folha' | 'planeado';
  amountCents: number;
}

export interface EcRunway {
  contract: EcContractState;
  openingDays: number;
  /** Opening + timesheets + planned days already past (before `today`). */
  usedDays: number;
  /** Planned days from `today` to the last day. */
  plannedDays: number;
  /** totalDays − usedDays. */
  leftDays: number;
  /** Days the budget still had when the contract ended early (0 normally). */
  unusedDays: number;
  /** Last working day: projected, or the early end. Null if the walk never ran out. */
  lastDay: IsoDate | null;
  warningDate: IsoDate | null;
  /** today is on or after the warning date and on or before the last day. */
  warningActive: boolean;
  /** today is after the last day. */
  finished: boolean;
  endedEarly: boolean;
  months: EcMonth[];
}

export function clientHolidaySet(state: NsState, calendarId: string, fromYear: number, toYear: number): Set<IsoDate> {
  const years: number[] = [];
  for (let y = fromYear; y <= toYear; y++) years.push(y);
  return holidayDates([calendarId], years, state.extraHolidays);
}

export function ecRunway(state: NsState, contract: EcContractState, today: IsoDate): EcRunway {
  const person: PersonDays = personDays(calendarOf(state, contract.personId));
  const startYear = yearOf(contract.startDate);
  const holidays = clientHolidaySet(state, contract.holidayCalendar, startYear, startYear + MAX_MONTHS / 12 + 1);

  const openingDays = contract.opening?.daysUsed ?? 0;
  const walkFrom = contract.opening && addDays(contract.opening.asOf, 1) > contract.startDate
    ? addDays(contract.opening.asOf, 1)
    : contract.startDate;
  const cap = contract.endedLastDay;

  let remaining = contract.totalDays - openingDays;
  let usedDays = openingDays;
  let plannedDays = 0;
  let lastDay: IsoDate | null = null;
  const months: EcMonth[] = [];

  let month = monthOf(walkFrom);
  for (let i = 0; i < MAX_MONTHS && remaining > 0; i++, month = addMonths(month, 1)) {
    if (cap && `${month}-01` > cap) break;
    const planned = plannedEcDays(month, { clientHolidays: holidays, person, from: walkFrom, to: cap });
    const ts = state.timesheets[`${contract.number}|${month}`];

    if (ts && ts.days < remaining) {
      remaining -= ts.days;
      usedDays += ts.days;
      months.push({ month, days: ts.days, source: 'folha', amountCents: Math.round(ts.days * contract.dailyRateCents) });
      const worked = [...planned.dates, ...planned.halfDates].sort();
      if (worked.length) lastDay = worked[worked.length - 1];
      continue;
    }

    // Planned days (or the timesheet month where the budget runs out): walk day by day.
    const weighted = [
      ...planned.dates.map(d => [d, 1] as const),
      ...planned.halfDates.map(d => [d, 0.5] as const),
    ].sort((a, b) => a[0].localeCompare(b[0]));
    let monthDays = 0;
    let budget = remaining;
    for (const [d, w] of weighted) {
      if (budget <= 0) break;
      const take = Math.min(w, budget);
      budget -= take;
      monthDays += take;
      lastDay = d;
      if (!ts) {
        if (d < today) usedDays += take; else plannedDays += take;
      }
    }
    if (ts) {
      // The timesheet uses up what was left: the last day is where the planned days run out.
      usedDays += ts.days;
      remaining = 0;
      months.push({ month, days: ts.days, source: 'folha', amountCents: Math.round(ts.days * contract.dailyRateCents) });
      continue;
    }
    remaining = budget;
    if (monthDays > 0) {
      months.push({ month, days: monthDays, source: 'planeado', amountCents: Math.round(monthDays * contract.dailyRateCents) });
    }
  }

  const endedEarly = !!cap && remaining > 0;
  if (cap && endedEarly) lastDay = lastDay && lastDay < cap ? lastDay : cap;
  if (!cap && remaining > 0) lastDay = null; // horizon exhausted without running out (shouldn't happen)

  const warningDate = lastDay ? addMonthsClamped(lastDay, -EC_WARNING_MONTHS) : null;
  return {
    contract,
    openingDays,
    usedDays,
    plannedDays,
    leftDays: contract.totalDays - usedDays,
    unusedDays: endedEarly ? remaining : 0,
    lastDay,
    warningDate,
    warningActive: !!warningDate && !!lastDay && today >= warningDate && today <= lastDay,
    finished: !!lastDay && today > lastDay,
    endedEarly,
    months,
  };
}

/** EC days and amount of one contract in one month (0 when it doesn't run that month). */
export function ecMonth(runway: EcRunway, month: YearMonth): EcMonth | null {
  return runway.months.find(m => m.month === month) ?? null;
}

export interface ContractGap {
  client: string;
  after: string;
  before: string;
  /** Client working days with no contract between the two (0 = follows on directly). */
  workingDays: number;
  from: IsoDate;
  to: IsoDate;
}

/** Gaps between consecutive contracts of the same client (by start date). */
export function contractGaps(state: NsState, runways: EcRunway[]): ContractGap[] {
  const gaps: ContractGap[] = [];
  const byClient = new Map<string, EcRunway[]>();
  for (const r of runways) {
    const list = byClient.get(r.contract.client) ?? [];
    list.push(r);
    byClient.set(r.contract.client, list);
  }
  for (const [client, list] of byClient) {
    list.sort((a, b) => a.contract.startDate.localeCompare(b.contract.startDate));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const next = list[i];
      if (!prev.lastDay) continue;
      const from = addDays(prev.lastDay, 1);
      const to = addDays(next.contract.startDate, -1);
      let days = 0;
      if (from <= to) {
        const holidays = clientHolidaySet(state, next.contract.holidayCalendar, yearOf(from), yearOf(to));
        for (let m = monthOf(from); m <= monthOf(to); m = addMonths(m, 1)) {
          days += workingDays(m, { holidays, from, to }).days;
        }
      }
      gaps.push({ client, after: prev.contract.number, before: next.contract.number, workingDays: days, from, to });
    }
  }
  return gaps;
}
