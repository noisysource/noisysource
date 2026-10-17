import { describe, expect, it } from 'vitest';
import type { RecurringEntryDoc } from '@shared/models/RecurringEntry';
import type { CreditContractDoc } from '@shared/models/CreditContract';
import type { EmploymentContractDoc } from '@shared/models/Employment';
import { buildRecurringItems, groupRecurringItems, monthlyEquivalentCents } from './recurringItems';

// Made-up values only.
const YM = '2026-10';
const entry = (over: Partial<RecurringEntryDoc>): RecurringEntryDoc => ({
  id: 'e', type: 'expense', description: 'x', amountCents: 1000, frequency: 'monthly', dayOfMonth: 1, active: true, ...over,
});
const credit = (over: Partial<CreditContractDoc>): CreditContractDoc => ({
  id: 'cr', type: 'personal', description: 'Crédito', creditor: 'Banco', loanAmountCents: 120000, startYearMonth: '2026-01',
  termMonths: 12, rateType: 'fixed', annualRatePct: 0, active: true, accountId: 'banco1', dayOfMonth: 5, ...over,
});
const contract: EmploymentContractDoc = {
  id: 'c1', companyId: 'acme', personId: 'ana', active: true, grossMonthlyCents: 100000, irsRatePct: 10, ssEmpPct: 11,
  ssErPct: 23.75, payDay: 30, startDate: '2026-01-01' as any, netPayAccountId: 'banco1',
  benefits: [{ type: 'CHILDCARE', perMonthCents: 20000, subjectToIRS: false, subjectToSS: false, benefitAccountId: 'card', expenseCategoryId: '', payableCategoryId: '' }],
};
const categories = [
  { id: 'casa', name: 'Habitação' },
  { id: 'luz', name: 'Luz', parentId: 'casa' },
];
const build = (entries: RecurringEntryDoc[], credits: CreditContractDoc[] = []) =>
  buildRecurringItems({ ym: YM, entries, credits, categories, contracts: [contract] });

describe('Recorrentes items', () => {
  it('groups each kind of entry: typed ones by top-level category, derived ones by what they are', () => {
    const items = build([
      entry({ id: 'm1', categoryId: 'luz' }),
      entry({ id: 'm2' }),
      entry({ id: 's1', sourceId: 'emp:c1:ns', amountCents: 123750 }),
      entry({ id: 's2', type: 'income', sourceId: 'emp:c1:private' }),
      entry({ id: 's3', type: 'income', sourceId: 'emp:c1:benefit:CHILDCARE' }),
      entry({ id: 's4', type: 'income', sourceId: 'inc:src1' }),
      entry({ id: 's5', type: 'income', sourceId: 'ec:ec1' }),
      entry({ id: 's6', sourceId: 'insurance:ins1' }),
    ]);
    expect(items.map(i => [i.key, i.kind, i.group])).toEqual([
      ['m1', 'manual', 'Habitação'],
      ['m2', 'manual', 'Sem categoria'],
      ['s1', 'salary_cost', 'Pessoal'],
      ['s2', 'salary', 'Salários'],
      ['s3', 'benefit', 'Vales'],
      ['s4', 'income_source', 'Salários'],
      ['s5', 'ec', 'Prestação de serviços'],
      ['s6', 'insurance', 'Seguros'],
    ]);
  });

  it('breaks a salary charge down from its contract', () => {
    const [item] = build([entry({ sourceId: 'emp:c1:ns', amountCents: 123750 })]);
    expect(item.details.map(d => [d.label, d.amountCents])).toEqual([
      ['Vencimento bruto', 100000],
      ['Segurança Social patronal (23.75%)', 23750],
      ['Encargos (bruto + SS patronal)', 123750],
      ['Vale creche (pago à parte)', 20000],
      ['Custo total para a empresa', 143750],
      ['Líquido ao trabalhador', 79000],
    ]);
  });

  it('counts only what is in force this month, as a monthly equivalent', () => {
    const items = build([
      entry({ id: 'ended', endYearMonth: '2026-04' }),
      entry({ id: 'future', startYearMonth: '2026-11' }),
      entry({ id: 'off', active: false }),
      entry({ id: 'q', frequency: 'quarterly', amountCents: 3000 }),
      entry({ id: 'a', frequency: 'annual', monthOfYear: 7, amountCents: 12000 }),
      entry({ id: 'once-now', frequency: 'once', onceYearMonth: YM, amountCents: 500 }),
      entry({ id: 'once-past', frequency: 'once', onceYearMonth: '2026-02', amountCents: 500 }),
    ]);
    expect(items.map(i => [i.key, i.status, i.monthlyCents])).toEqual([
      ['ended', 'ended', 0], ['future', 'future', 0], ['off', 'inactive', 0],
      ['q', 'current', 1000], ['a', 'current', 1000], ['once-now', 'current', 500], ['once-past', 'ended', 0],
    ]);
    expect(monthlyEquivalentCents(entry({ frequency: 'once', onceYearMonth: '2026-12' }), YM)).toBe(0);
  });

  it("adds each credit's instalment of the month, with capital, interest and what's left", () => {
    const [item] = build([], [credit({})]);
    expect(item).toMatchObject({ kind: 'credit', group: 'Créditos', status: 'current', amountCents: 10000, monthlyCents: 10000, accountId: 'banco1', dayOfMonth: 5, endYearMonth: '2026-12' });
    expect(item.details.slice(0, 3).map(d => d.amountCents)).toEqual([10000, 0, 20000]);
  });

  it('shows ended, future and interest-only credits correctly', () => {
    const items = build([], [
      credit({ id: 'old', startYearMonth: '2025-01', termMonths: 6 }),
      credit({ id: 'new', startYearMonth: '2027-01' }),
      credit({ id: 'io', interestOnlyPhase: true, annualRatePct: 12, loanAmountCents: 100000, termMonths: 60 }),
    ]);
    expect(items.map(i => [i.sourceRef, i.status, i.monthlyCents])).toEqual([
      ['old', 'ended', 0], ['new', 'future', 0], ['io', 'current', 1000],
    ]);
  });
});

describe('Recorrentes groups', () => {
  const items = build([
    entry({ id: 'luz', categoryId: 'luz', amountCents: 5000, accountId: 'banco1' }),
    entry({ id: 'ins', sourceId: 'insurance:i', amountCents: 2000, accountId: 'banco2' }),
    entry({ id: 'sal', type: 'income', sourceId: 'emp:c1:private', amountCents: 79000, accountId: 'banco1' }),
    entry({ id: 'gone', categoryId: 'luz', endYearMonth: '2026-01', amountCents: 99999 }),
  ], [credit({})]);

  it('by category: current items only, subtotals per group, biggest first', () => {
    const groups = groupRecurringItems(items, 'category', id => id ?? '—');
    expect(groups.map(g => [g.name, g.items.map(i => i.key), g.expenseCents, g.incomeCents])).toEqual([
      ['Salários', ['sal'], 0, 79000],
      ['Créditos', ['credit:cr'], 10000, 0],
      ['Habitação', ['luz'], 5000, 0],
      ['Seguros', ['ins'], 2000, 0],
    ]);
  });

  it('by account', () => {
    const groups = groupRecurringItems(items, 'account', id => (id ? `Conta ${id}` : 'Sem conta'));
    expect(groups.map(g => [g.name, g.items.map(i => i.key)])).toEqual([
      ['Conta banco1', ['sal', 'credit:cr', 'luz']],
      ['Conta banco2', ['ins']],
    ]);
  });
});
