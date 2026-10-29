// Test helpers for the NoisySource domain. Made-up people, contracts and amounts only.

import { buildNsEvent, type NsEvent, type NsEventType, type NsPayload } from './events';
import type { EmploymentTerms } from './events';

let seq = 0;

export function ev<T extends NsEventType>(type: T, payload: NsPayload<T>, id?: string, extra: { reverses?: string; recordedAt?: string } = {}): NsEvent {
  seq += 1;
  return buildNsEvent<T>(type, payload, {
    id: id ?? `t-${seq}`,
    source: 'manual',
    recordedBy: 'test-uid',
    recordedAt: extra.recordedAt ?? `2030-01-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    reverses: extra.reverses,
  }) as unknown as NsEvent;
}

export function terms(over: Partial<EmploymentTerms> = {}): EmploymentTerms {
  return {
    personId: 'ana',
    personName: 'Ana Teste',
    from: '2030-01-01',
    contractType: 'employee',
    grossMonthlyCents: 100000,
    irsRatePct: 10,
    ssEmpPct: 11,
    ssErPct: 23.75,
    mealPerDayCents: 800,
    mealPaidAs: 'cartao',
    perDiemCents: 5000,
    benefits: [
      { code: 'creche', label: 'Vale infância', perMonthCents: 10000, subjectToIRS: false, subjectToSS: false, paidAs: 'cartao' },
      { code: 'educacao', label: 'Vale educação', perMonthCents: 5000, subjectToIRS: true, subjectToSS: false, paidAs: 'cartao' },
    ],
    holidaySubsidyMonth: 6,
    christmasSubsidyMonth: 11,
    payDay: 25,
    calendars: ['pt-coimbra'],
    ...over,
  };
}

export const CONTRACT = {
  number: 'C-100',
  client: 'Plataforma X',
  endClient: 'Cliente Y',
  personId: 'ana',
  dailyRateCents: 40000,
  totalDays: 30,
  startDate: '2030-02-01',
  holidayCalendar: 'client-x',
  daysToPayment: 10,
  vatCode: 'isento' as const,
};

export const CLIENT_HOLIDAYS_2030 = ev('holidays.set', {
  calendarId: 'client-x', year: 2030, dates: ['2030-01-01', '2030-02-14'],
}, 'hol-client-x-2030');
