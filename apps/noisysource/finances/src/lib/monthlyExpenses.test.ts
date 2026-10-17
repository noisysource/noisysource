import { describe, expect, it } from 'vitest';
import type { RecurringEntryDoc } from '@shared/models/RecurringEntry';
import type { CreditContractDoc } from '@shared/models/CreditContract';
import type { EmploymentContractDoc } from '@shared/models/Employment';
import type { PayrollRunDoc } from '@shared/models/PayrollRun';
import { buildMonthlyExpenses, type MonthlyExpensesInput } from './monthlyExpenses';

// Made-up values only.
const entry = (over: Partial<RecurringEntryDoc>): RecurringEntryDoc => ({
  id: 'e', type: 'expense', description: 'x', amountCents: 1000, frequency: 'monthly', dayOfMonth: 1, active: true, ...over,
});
const contract = (over: Partial<EmploymentContractDoc>): EmploymentContractDoc => ({
  id: 'c1', companyId: 'acme', personId: 'ana', active: true, grossMonthlyCents: 100000, irsRatePct: 10, ssEmpPct: 11,
  ssErPct: 23.75, payDay: 30, startDate: '2026-01-01' as any, netPayAccountId: '',
  benefits: [{ type: 'CHILDCARE', perMonthCents: 20000, subjectToIRS: false, subjectToSS: false, benefitAccountId: 'card', expenseCategoryId: '', payableCategoryId: '' }],
  ...over,
});
const run = (over: Partial<PayrollRunDoc>): PayrollRunDoc => ({
  id: 'acme-ana-2026-02', contractId: 'c1', companyId: 'acme', personId: 'ana', year: 2026, month: 2,
  grossCents: 90000, irsCents: 0, ssEmpCents: 0, ssErCents: 0, netCents: 90000, benefitsCents: 20000,
  costToEmployerCents: 110000, cashOutCents: 110000, confirmedAt: new Date(), ...over,
});
const credit: CreditContractDoc = {
  id: 'cr', type: 'personal', description: 'Crédito', creditor: 'Banco', loanAmountCents: 30000, startYearMonth: '2026-03',
  termMonths: 3, rateType: 'fixed', annualRatePct: 0, active: true,
};
const base = (over: Partial<MonthlyExpensesInput>): MonthlyExpensesInput => ({
  year: 2026, entries: [], credits: [], categories: [{ id: 'casa', name: 'Habitação' }, { id: 'luz', name: 'Luz', parentId: 'casa' }],
  contracts: [], payrollRuns: [], peopleById: { ana: 'Ana' }, withVat: true, ...over,
});
const month = (ms: ReturnType<typeof buildMonthlyExpenses>, m: number) => ms[m - 1];
const labels = (ms: ReturnType<typeof buildMonthlyExpenses>, m: number) =>
  month(ms, m).groups.flatMap(g => g.lines.map(l => `${g.name}: ${l.label}`));

describe('Despesas do mês', () => {
  it('gives the twelve months of the year, January first', () => {
    expect(buildMonthlyExpenses(base({})).map(m => m.ym)).toEqual(
      Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`));
  });

  it('puts each entry in the months it falls in, grouped by top-level category', () => {
    const ms = buildMonthlyExpenses(base({
      entries: [
        entry({ id: 'luz', description: 'Luz', categoryId: 'luz', vatCode: 23, amountCents: 12300 }),
        entry({ id: 'seg', description: 'Seguro', sourceId: 'insurance:i', frequency: 'annual', monthOfYear: 7, amountCents: 5000 }),
        entry({ id: 'trim', description: 'Trimestral', frequency: 'quarterly', vatCode: 'isento' }),
        entry({ id: 'gone', description: 'Antigo', endYearMonth: '2026-02', vatCode: 'isento' }),
        entry({ id: 'in', type: 'income', description: 'Entrada' }),
      ],
    }));
    expect(labels(ms, 1)).toEqual(['Habitação: Luz', 'Sem categoria: Antigo', 'Sem categoria: Trimestral']);
    expect(labels(ms, 3)).toEqual(['Habitação: Luz']);
    expect(labels(ms, 7)).toEqual(['Habitação: Luz', 'Seguros: Seguro', 'Sem categoria: Trimestral']);
  });

  it('splits VAT for a company and counts what is still to confirm; Casa takes amounts as paid', () => {
    const entries = [
      entry({ id: 'a', vatCode: 23, amountCents: 12300 }),
      entry({ id: 'b', vatCode: 'isento', amountCents: 5000 }),
      entry({ id: 'c', amountCents: 1000 }), // no code: por confirmar
    ];
    const company = month(buildMonthlyExpenses(base({ entries })), 1);
    expect([company.amountCents, company.netCents, company.unconfirmedVatCount]).toEqual([18300, 16000, 1]);
    const casa = month(buildMonthlyExpenses(base({ entries, withVat: false })), 1);
    expect([casa.amountCents, casa.netCents, casa.unconfirmedVatCount]).toEqual([18300, 18300, 0]);
  });

  it('adds credit instalments only in the months they run', () => {
    const ms = buildMonthlyExpenses(base({ credits: [credit] }));
    expect(ms.map(m => m.amountCents)).toEqual([0, 0, 10000, 10000, 10000, 0, 0, 0, 0, 0, 0, 0]);
    expect(month(ms, 3).groups[0].lines[0].detail).toMatch(/^capital 100,00\s?€ · juros 0,00\s?€$/);
  });

  it('uses the processed payroll run when there is one, else the contract (with vouchers), never the synced entry', () => {
    const ms = buildMonthlyExpenses(base({
      contracts: [contract({})],
      payrollRuns: [run({})],
      entries: [entry({ id: 'enc', sourceId: 'emp:c1:ns', amountCents: 123750 })],
    }));
    expect(month(ms, 2).groups).toEqual([{
      name: 'Pessoal', amountCents: 110000, netCents: 110000,
      lines: [expect.objectContaining({ label: 'Salário — Ana', source: 'payroll_run', amountCents: 110000 })],
    }]);
    expect(month(ms, 2).hasPayrollRuns).toBe(true);
    expect(month(ms, 3).groups[0].lines).toEqual([
      expect.objectContaining({ label: 'Salário — Ana', source: 'contract', amountCents: 143750 }),
    ]);
    expect(month(ms, 3).hasPayrollRuns).toBe(false);
  });

  it('takes the contract version in force each month, and labels green receipts', () => {
    const ms = buildMonthlyExpenses(base({
      contracts: [
        contract({ id: 'v1', endDate: '2026-04-30' as any, grossMonthlyCents: 100000, benefits: [] }),
        contract({ id: 'v2', startDate: '2026-05-01' as any, grossMonthlyCents: 120000, benefits: [] }),
        contract({ id: 'gr', personId: 'bia', contractType: 'green_receipt', ssErPct: 0, ssEmpPct: 0, irsRatePct: 0, grossMonthlyCents: 50000, benefits: [] }),
      ],
      peopleById: { ana: 'Ana', bia: 'Bia' },
    }));
    const pessoal = (m: number) => month(ms, m).groups.find(g => g.name === 'Pessoal')!.lines.map(l => [l.label, l.amountCents]);
    expect(pessoal(4)).toEqual([['Salário — Ana', 123750], ['Recibo verde — Bia', 50000]]);
    expect(pessoal(5)).toEqual([['Salário — Ana', 148500], ['Recibo verde — Bia', 50000]]);
  });
});
