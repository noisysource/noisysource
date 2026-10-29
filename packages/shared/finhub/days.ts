// packages/shared/finhub/days.ts
//
// The days engine (HANDOFF-finhub-v2.md, "The days engine"). Everything that depends on a
// month's days (EC income, meal allowance, per diems, leave deductions) is computed here from a
// holiday calendar and the person's calendar entries. Pure.
//
// How an entry changes the days:
//   kind                         EC days            meal days   per diem   salary
//   ferias, doenca, outro         −                  −           no         —
//   licenca (unpaid by company)   −                  −           no         − base/30 per day
//   viagem                        counted as worked  −           per day    —
// Half days (`halfDays`) take 0.5 off EC days and leave meal days alone (the person still works
// part of the day).

import { eachDay, firstDay, isWeekend, lastDay, maxDate, minDate, monthOf, type IsoDate, type YearMonth } from './dates';

export interface DayCount {
  days: number;
  /** Full days counted. */
  dates: IsoDate[];
  /** Days counted as 0.5. */
  halfDates: IsoDate[];
}

export interface WorkingDaysOptions {
  holidays: Set<IsoDate>;
  absences?: Set<IsoDate>;
  halfDays?: Set<IsoDate>;
  /** Only count from this date (e.g. a contract's start). */
  from?: IsoDate;
  /** Only count up to this date (e.g. a contract's last day). */
  to?: IsoDate;
}

/** Weekdays of the month − holidays − absences; half days count 0.5. */
export function workingDays(month: YearMonth, opts: WorkingDaysOptions): DayCount {
  const start = opts.from ? maxDate(firstDay(month), opts.from) : firstDay(month);
  const end = opts.to ? minDate(lastDay(month), opts.to) : lastDay(month);
  const out: DayCount = { days: 0, dates: [], halfDates: [] };
  for (const d of eachDay(start, end)) {
    if (isWeekend(d) || opts.holidays.has(d) || opts.absences?.has(d)) continue;
    if (opts.halfDays?.has(d)) {
      out.halfDates.push(d);
      out.days += 0.5;
    } else {
      out.dates.push(d);
      out.days += 1;
    }
  }
  return out;
}

export type EntryKind = 'ferias' | 'doenca' | 'viagem' | 'outro' | 'licenca';

export interface CalendarEntryLike {
  kind: EntryKind;
  dates: readonly IsoDate[];
  halfDays?: readonly IsoDate[];
}

/** A person's calendar as sets of dates. */
export interface PersonDays {
  /** Full days off work (ferias, doenca, outro, licenca). */
  off: Set<IsoDate>;
  /** Half days off work. */
  offHalf: Set<IsoDate>;
  /** Trip days (worked, away). */
  trip: Set<IsoDate>;
  /** Leave the company doesn't pay (subset of `off`). */
  leave: Set<IsoDate>;
  /** Kind of each full day off or trip day, for explanations. */
  kindOf: Map<IsoDate, EntryKind>;
}

export function personDays(entries: readonly CalendarEntryLike[]): PersonDays {
  const p: PersonDays = { off: new Set(), offHalf: new Set(), trip: new Set(), leave: new Set(), kindOf: new Map() };
  for (const e of entries) {
    for (const d of e.dates) {
      p.kindOf.set(d, e.kind);
      if (e.kind === 'viagem') p.trip.add(d);
      else p.off.add(d);
      if (e.kind === 'licenca') p.leave.add(d);
    }
    if (e.kind !== 'viagem') for (const d of e.halfDays ?? []) p.offHalf.add(d);
  }
  return p;
}

/** EC days planned for one contract in a month: the client's calendar minus the person's days off. */
export function plannedEcDays(
  month: YearMonth,
  opts: { clientHolidays: Set<IsoDate>; person: PersonDays; from?: IsoDate; to?: IsoDate },
): DayCount {
  return workingDays(month, {
    holidays: opts.clientHolidays,
    absences: opts.person.off,
    halfDays: opts.person.offHalf,
    from: opts.from,
    to: opts.to,
  });
}

export interface MealDays {
  /** Meal days = possible − removed. */
  days: number;
  /** Working days of the month on the person's calendars. */
  possible: number;
  /** Working days taken off, by kind (trip days included). */
  removed: Partial<Record<EntryKind, number>>;
}

/** Meal days: the month's working days on the person's calendars, minus days off and trip days. */
export function mealDays(month: YearMonth, opts: { holidays: Set<IsoDate>; person: PersonDays; from?: IsoDate; to?: IsoDate }): MealDays {
  const possible = workingDays(month, { holidays: opts.holidays, from: opts.from, to: opts.to });
  const removed: MealDays['removed'] = {};
  let days = 0;
  for (const d of possible.dates) {
    const kind = opts.person.off.has(d) || opts.person.trip.has(d) ? opts.person.kindOf.get(d) : undefined;
    if (kind) removed[kind] = (removed[kind] ?? 0) + 1;
    else days += 1;
  }
  return { days, possible: possible.days, removed };
}

/** Trip days in the month (every calendar day of a trip earns a per diem). */
export function tripDaysInMonth(month: YearMonth, person: PersonDays): number {
  let n = 0;
  for (const d of person.trip) if (monthOf(d) === month) n++;
  return n;
}

/**
 * Unpaid leave days in the month, payroll-style (a month counts as 30 days): the calendar days of
 * leave, capped at 30; a whole month on leave is 30.
 */
export function leaveDaysInMonth(month: YearMonth, person: PersonDays): number {
  const all = eachDay(firstDay(month), lastDay(month));
  const n = all.filter(d => person.leave.has(d)).length;
  return n === all.length ? 30 : Math.min(30, n);
}
