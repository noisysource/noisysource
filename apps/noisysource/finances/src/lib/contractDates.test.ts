import { describe, expect, it } from 'vitest';
import { buildPayrollPreview, computeMonthlyPayroll, contractInForce, payrollRunId, splitConfirmedRows } from '@shared/lib/payroll';
import { generateEmploymentEvents, generateIncomeSourceEvents } from '@shared/lib/eventGenerators';
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
    expect(rows.map(r => [r.contractId, r.yearMonth])).toEqual([
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

describe('a payroll month is confirmed once', () => {
  const c = contract({ id: 'v1', payDay: 30 });

  it('pays day 30 of February on the 28th, and says which month a row is', () => {
    const row = computeMonthlyPayroll(c, 2026, 2);
    expect(row.yearMonth).toBe('2026-02');
    expect(row.payDateISO).toBe('2026-02-28');
  });

  it('leaves out rows whose company, person and month already have a run', () => {
    const rows = buildPayrollPreview([c], { year: 2026, month1to12: 1, span: 3 });
    const runs = [{ companyId: 'acme', personId: 'ana', year: 2026, month: 2 }];
    const { pending, confirmed } = splitConfirmedRows(rows, runs);
    expect(pending.map(r => r.yearMonth)).toEqual(['2026-01', '2026-03']);
    expect(confirmed.map(r => r.yearMonth)).toEqual(['2026-02']);
    expect(payrollRunId('acme', 'ana', '2026-02')).toBe('acme-ana-2026-02');
  });
});

describe('employment events land in the contract\'s company', () => {
  it('files a NoisyPhocus green receipt under NoisyPhocus', () => {
    const teacher = { ...contract({ id: 't', contractType: 'green_receipt', ssErPct: 0, ssEmpPct: 0, irsRatePct: 0, flowToPrivate: false }), entityId: 'noisyphocus' as const };
    const events = generateEmploymentEvents([teacher], new Map([['ana', 'Ana']]), '2026-10', 1);
    expect(events.map(e => [e.entityId, e.description, e.amountCents])).toEqual([['noisyphocus', 'Recibo Verde — Ana', -100000]]);
  });

  it('keeps untagged contracts under NoisySource', () => {
    const events = generateEmploymentEvents([contract({ flowToPrivate: false })], new Map(), '2026-10', 1);
    expect(events[0].entityId).toBe('noisysource');
  });
});
