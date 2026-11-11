// packages/shared/finhub/holidays.ts
//
// Holiday calendars as data. Two are built in and computed for any year:
//   - 'pt': Portuguese national holidays (Código do Trabalho, art. 234), Easter-based ones included.
//     Carnaval is NOT a legal holiday, so it isn't here (a company that gives it off records it as
//     a company day off, a `holidays.set` event on its own calendar).
//   - 'pt-coimbra': 'pt' plus Coimbra's municipal holiday (4 July, Rainha Santa Isabel).
// Every other calendar (a client's, a company's days off) comes from `holidays.set` events and is
// passed in as `extra`. Extra dates are added to a built-in calendar of the same id.

import { addDays, isoFromParts, type IsoDate } from './dates';

export const BUILT_IN_CALENDARS = ['pt', 'pt-coimbra'] as const;
export type BuiltInCalendarId = (typeof BUILT_IN_CALENDARS)[number];

export interface Holiday {
  date: IsoDate;
  name: string;
}

/** Easter Sunday (Gregorian), anonymous algorithm (Meeus/Jones/Butcher). */
export function easterSunday(year: number): IsoDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoFromParts(year, month, day);
}

export function portugueseNationalHolidays(year: number): Holiday[] {
  const easter = easterSunday(year);
  const fixed = (m: number, d: number, name: string): Holiday => ({ date: isoFromParts(year, m, d), name });
  const list: Holiday[] = [
    fixed(1, 1, 'Ano Novo'),
    { date: addDays(easter, -2), name: 'Sexta-feira Santa' },
    { date: easter, name: 'Páscoa' },
    fixed(4, 25, 'Dia da Liberdade'),
    fixed(5, 1, 'Dia do Trabalhador'),
    { date: addDays(easter, 60), name: 'Corpo de Deus' },
    fixed(6, 10, 'Dia de Portugal'),
    fixed(8, 15, 'Assunção de Nossa Senhora'),
    fixed(10, 5, 'Implantação da República'),
    fixed(11, 1, 'Todos os Santos'),
    fixed(12, 1, 'Restauração da Independência'),
    fixed(12, 8, 'Imaculada Conceição'),
    fixed(12, 25, 'Natal'),
  ];
  return list.sort((x, y) => x.date.localeCompare(y.date));
}

export function builtInHolidays(calendarId: string, year: number): Holiday[] {
  if (calendarId === 'pt') return portugueseNationalHolidays(year);
  if (calendarId === 'pt-coimbra') {
    return [...portugueseNationalHolidays(year), { date: isoFromParts(year, 7, 4), name: 'Feriado municipal de Coimbra' }]
      .sort((x, y) => x.date.localeCompare(y.date));
  }
  return [];
}

export function isBuiltInCalendar(id: string): id is BuiltInCalendarId {
  return (BUILT_IN_CALENDARS as readonly string[]).includes(id);
}

/** Calendar id → year → dates, from `holidays.set` events. */
export type ExtraHolidays = Record<string, Record<number, IsoDate[]>>;

/** Every holiday date of the given calendars over the given years, as a Set. */
export function holidayDates(calendarIds: readonly string[], years: readonly number[], extra: ExtraHolidays = {}): Set<IsoDate> {
  const out = new Set<IsoDate>();
  for (const id of calendarIds) {
    for (const y of years) {
      for (const h of builtInHolidays(id, y)) out.add(h.date);
      for (const d of extra[id]?.[y] ?? []) out.add(d);
    }
  }
  return out;
}

/** True when banks process payments that day: a weekday that isn't a national holiday. */
export function isBusinessDay(iso: IsoDate, nationalHolidays: Set<IsoDate>): boolean {
  const w = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return w !== 0 && w !== 6 && !nationalHolidays.has(iso);
}

/** Moves a date to the nearest business day before or after it (unchanged if it is one). */
export function adjustToBusinessDay(iso: IsoDate, direction: 'before' | 'after', nationalHolidays: Set<IsoDate>): IsoDate {
  let d = iso;
  for (let i = 0; i < 10 && !isBusinessDay(d, nationalHolidays); i++) d = addDays(d, direction === 'before' ? -1 : 1);
  return d;
}
