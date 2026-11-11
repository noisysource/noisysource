import { describe, expect, it } from 'vitest';
import { addMonthsClamped, daysBetween, eachDay, isIsoDate, monthsBetween, todayInLisbon } from './dates';
import {
  adjustToBusinessDay, builtInHolidays, easterSunday, holidayDates, portugueseNationalHolidays,
} from './holidays';
import { leaveDaysInMonth, mealDays, personDays, plannedEcDays, tripDaysInMonth, workingDays } from './days';

describe('dates', () => {
  it('validates real dates only', () => {
    expect(isIsoDate('2030-02-28')).toBe(true);
    expect(isIsoDate('2030-02-29')).toBe(false);
    expect(isIsoDate('2030-2-1')).toBe(false);
  });
  it('adds months clamping to the month end', () => {
    expect(addMonthsClamped('2030-05-31', -3)).toBe('2030-02-28');
    expect(addMonthsClamped('2031-01-26', -3)).toBe('2030-10-26');
  });
  it('lists months and days inclusively', () => {
    expect(monthsBetween('2029-11', '2030-02')).toEqual(['2029-11', '2029-12', '2030-01', '2030-02']);
    expect(eachDay('2030-02-27', '2030-03-01')).toEqual(['2030-02-27', '2030-02-28', '2030-03-01']);
    expect(daysBetween('2030-02-27', '2030-03-01')).toBe(2);
  });
  it('gives today in Lisbon', () => {
    expect(todayInLisbon(new Date('2030-06-30T23:30:00Z'))).toBe('2030-07-01'); // summer time, UTC+1
  });
});

describe('holiday calendars', () => {
  it('computes Easter', () => {
    expect(easterSunday(2024)).toBe('2024-03-31');
    expect(easterSunday(2025)).toBe('2025-04-20');
    expect(easterSunday(2030)).toBe('2030-04-21');
    expect(easterSunday(2038)).toBe('2038-04-25');
  });
  it('has the 13 Portuguese national holidays, Easter-based ones included, no Carnaval', () => {
    const pt = portugueseNationalHolidays(2030).map(h => h.date);
    expect(pt).toHaveLength(13);
    expect(pt).toContain('2030-04-19'); // Sexta-feira Santa
    expect(pt).toContain('2030-06-20'); // Corpo de Deus (Easter + 60)
    expect(pt).not.toContain('2030-03-05'); // Carnaval isn't a legal holiday
  });
  it('pt-coimbra adds 4 July', () => {
    expect(builtInHolidays('pt-coimbra', 2030).map(h => h.date)).toContain('2030-07-04');
    expect(builtInHolidays('pt', 2030).map(h => h.date)).not.toContain('2030-07-04');
  });
  it('merges extra dates from events, for any calendar', () => {
    const set = holidayDates(['client-x', 'pt-coimbra'], [2030], { 'client-x': { 2030: ['2030-07-21'] } });
    expect(set.has('2030-07-21')).toBe(true);
    expect(set.has('2030-07-04')).toBe(true);
  });
  it('moves a payment off weekends and national holidays', () => {
    const pt = holidayDates(['pt'], [2030]);
    // 8 Jun 2030 is a Saturday, 10 Jun (Monday) is Dia de Portugal.
    expect(adjustToBusinessDay('2030-06-08', 'after', pt)).toBe('2030-06-11');
    expect(adjustToBusinessDay('2030-06-08', 'before', pt)).toBe('2030-06-07');
    expect(adjustToBusinessDay('2030-06-12', 'before', pt)).toBe('2030-06-12');
  });
});

describe('days engine', () => {
  const pt = holidayDates(['pt-coimbra'], [2030]);

  it('counts weekdays minus holidays and absences, half days as 0.5', () => {
    expect(workingDays('2030-06', { holidays: pt }).days).toBe(18); // 20 weekdays − 10 Jun − Corpo de Deus
    const r = workingDays('2030-06', { holidays: pt, absences: new Set(['2030-06-03']), halfDays: new Set(['2030-06-04']) });
    expect(r.days).toBe(16.5);
    expect(r.halfDates).toEqual(['2030-06-04']);
  });

  it('limits the count to a from/to window', () => {
    expect(workingDays('2030-02', { holidays: new Set(), from: '2030-02-18', to: '2030-02-22' }).days).toBe(5);
  });

  it('meal days: working days on the calendar minus days off and trip days', () => {
    const p = personDays([
      { kind: 'ferias', dates: ['2030-07-01', '2030-07-02'] },
      { kind: 'viagem', dates: ['2030-07-10', '2030-07-11', '2030-07-12', '2030-07-13'] }, // Wed → Sat
    ]);
    const m = mealDays('2030-07', { holidays: pt, person: p });
    expect(m.possible).toBe(22); // 23 weekdays − 4 Jul (Coimbra)
    expect(m.days).toBe(17);
    expect(m.removed).toEqual({ ferias: 2, viagem: 3 });
    expect(tripDaysInMonth('2030-07', p)).toBe(4); // the Saturday earns a per diem too
  });

  it('EC days count trip days as worked and follow the client calendar', () => {
    const p = personDays([
      { kind: 'viagem', dates: ['2030-07-10'] },
      { kind: 'ferias', dates: ['2030-07-15'], halfDays: ['2030-07-16'] },
    ]);
    const client = new Set(['2030-07-22']);
    const d = plannedEcDays('2030-07', { clientHolidays: client, person: p });
    expect(d.days).toBe(23 - 1 - 1 - 0.5); // 4 Jul is worked for the client
  });

  it('leave days are payroll days: a whole month is 30', () => {
    const whole = personDays([{ kind: 'licenca', dates: eachDay('2030-01-01', '2030-01-31') }]);
    expect(leaveDaysInMonth('2030-01', whole)).toBe(30);
    const part = personDays([{ kind: 'licenca', dates: eachDay('2030-02-01', '2030-02-08') }]);
    expect(leaveDaysInMonth('2030-02', part)).toBe(8);
    expect(mealDays('2030-02', { holidays: pt, person: part }).days).toBe(20 - 6);
    // Leave is a payroll fact: EC days still follow the client calendar (and the timesheet).
    expect(plannedEcDays('2030-02', { clientHolidays: new Set(), person: part }).days).toBe(20);
  });
});
