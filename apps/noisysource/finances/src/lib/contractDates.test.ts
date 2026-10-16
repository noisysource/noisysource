import { describe, expect, it } from 'vitest';
import { buildPayrollPreview, contractInForce } from '@shared/lib/payroll';
import { generateIncomeSourceEvents } from '@shared/lib/eventGenerators';
import { incomeSourceMonth, type IncomeSourceDoc } from '@shared/models/IncomeSource';
import { ecContractInForce, type EcContractDoc } from '@shared/models/EcContract';
import type { EmploymentContractDoc } from '@shared/models/Employment';

// Made-up values only.
const contract = (over: Partial<EmploymentContractDoc>): EmploymentContractDoc => ({
  id: 'c', companyId: 'acme', personId: 'ana', active: true, grossMonthlyCents: 100000, irsRatePct: 10,
  ssEmpPct: 11, ssErPct: 23.75, payDay: 28, benefits: [], netPayAccountId: 'bank',
  startDate: '2026-01-01' as any, ...over,
});

describe('payroll counts only the contracts in force that month', () => {
  const v1 = contract({ id: 'v1', startDate: '2026-01-01' as any, endDate: '2026-04-30' as any, grossMonthlyCents: 100000 });
  const v2 = contract({ id: 'v2', startDate: '2026-05-01' as any, grossMonthlyCents: 120000 });

  it('takes one version per month across a raise', () => {
    const rows = buildPayrollPreview([v1, v2], { year: 2026, month1to12: 3, span: 4 });
    expect(rows.map(r => [r.contractId, r.monthLabel !== undefined && r.payDateISO.slice(0, 7)])).toEqual([
      ['v1', '2026-03'], ['v1', '2026-04'], ['v2', '2026-05'], ['v2', '2026-06'],
    ]);
  });

  it('leaves out inactive contracts and months before the start', () => {
    const inactive = contract({ id: 'x', active: false });
    expect(buildPayrollPreview([inactive, v2], { year: 2026, month1to12: 1, span: 1 })).toEqual([]);
  });

  it('reads ISO strings, Dates and Firestore Timestamps; no dates = always in force', () => {
    const ts = { toDate: () => new Date(2026, 5, 15) };
    expect(contractInForce(contract({ startDate: ts as any }), 2026, 5)).toBe(false);
    expect(contractInForce(contract({ startDate: ts as any }), 2026, 6)).toBe(true);
    expect(contractInForce(contract({ startDate: new Date(2026, 0, 1) as any, endDate: new Date(2026, 1, 28) as any }), 2026, 3)).toBe(false);
    expect(contractInForce(contract({ startDate: undefined as any }), 2020, 1)).toBe(true);
  });
});

const source = (over: Partial<IncomeSourceDoc>): IncomeSourceDoc => ({
  id: 's', personName: 'Ana', employerName: 'Outra SA', grossMonthlyCents: 100000, irsRatePct: 5, ssEmpPct: 11,
  payDay: 30, netPayAccountId: 'bank', active: true, benefits: [], ...over,
});

describe('income sources: end date and cash benefits', () => {
  it('stops at the end month (inclusive)', () => {
    const events = generateIncomeSourceEvents([source({ startDate: '2026-01-01', endDate: '2026-03-31' })], '2026-01', 6);
    expect(events.map(e => e.date.slice(0, 7))).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('adds benefits paid in cash to the net pay, and credits card benefits to their card', () => {
    const s = source({
      benefits: [
        { type: 'MEAL', perDayCents: 600, daysPerMonth: 20, subjectToIRS: false, subjectToSS: false, benefitAccountId: '', expenseCategoryId: '', payableCategoryId: '' },
        { type: 'CHILDCARE', perMonthCents: 30000, subjectToIRS: false, subjectToSS: false, benefitAccountId: 'card', expenseCategoryId: '', payableCategoryId: '' },
      ],
    });
    expect(incomeSourceMonth(s)).toEqual({
      grossCents: 100000, irsCents: 5000, ssCents: 11000, netCents: 84000,
      cashBenefitsCents: 12000, netPayCents: 96000,
      cardBenefits: [{ type: 'CHILDCARE', totalCents: 30000, benefitAccountId: 'card' }],
    });
    const events = generateIncomeSourceEvents([s], '2026-01', 1);
    expect(events.map(e => [e.accountId, e.amountCents])).toEqual([['bank', 96000], ['card', 30000]]);
  });
});

const ec = (over: Partial<EcContractDoc>): EcContractDoc => ({
  id: 'ec', clientName: 'Cliente X', dailyRateCents: 50000, expectedDaysPerMonth: 20, active: true, ...over,
});

describe('the EC contract in force on a day', () => {
  const v1 = ec({ id: 'v1', startDate: new Date(2026, 0, 5, 12), endDate: new Date(2026, 1, 2, 12) });
  const v2 = ec({ id: 'v2', startDate: new Date(2026, 1, 3, 12) });

  it('picks the version whose dates contain the day', () => {
    expect(ecContractInForce([v1, v2], new Date(2026, 0, 20))?.id).toBe('v1');
    expect(ecContractInForce([v1, v2], new Date(2026, 1, 2))?.id).toBe('v1');
    expect(ecContractInForce([v1, v2], new Date(2026, 1, 3))?.id).toBe('v2');
    expect(ecContractInForce([v1, v2], new Date(2026, 9, 16))?.id).toBe('v2');
  });

  it('falls back to the next one to start, ignores inactive ones, else null', () => {
    expect(ecContractInForce([v1, v2], new Date(2025, 11, 1))?.id).toBe('v1');
    expect(ecContractInForce([v1, { ...v2, active: false }], new Date(2026, 5, 1))).toBeNull();
  });
});
