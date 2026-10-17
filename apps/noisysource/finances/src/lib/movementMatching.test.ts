import { describe, expect, it } from 'vitest';
import type { RecurringEntryDoc } from '@shared/models/RecurringEntry';
import type { CreditContractDoc } from '@shared/models/CreditContract';
import type { PayrollRunDoc } from '@shared/models/PayrollRun';
import type { BankTransactionDoc, MovementRuleDoc } from '@shared/models/BankTransaction';
import { expectedForMonth, missingExpected, normalizeDescription, suggestMatches } from './movementMatching';

// Made-up values only.
const YM = '2026-09';
const entry = (over: Partial<RecurringEntryDoc>): RecurringEntryDoc => ({
  id: 'e', type: 'expense', description: 'x', amountCents: 1000, frequency: 'monthly', dayOfMonth: 1, active: true, accountId: 'bank', ...over,
});
const line = (over: Partial<BankTransactionDoc>): BankTransactionDoc => ({
  id: 'l', accountId: 'bank', entityId: 'acme', sourceType: 'pdf', date: '2026-09-02', description: 'x', amountCents: -1000, ...over,
});
const credit: CreditContractDoc = {
  id: 'cr', type: 'personal', description: 'Crédito carro', creditor: 'Banco', loanAmountCents: 120000, startYearMonth: '2026-01',
  termMonths: 12, rateType: 'fixed', annualRatePct: 0, active: true, accountId: 'bank', dayOfMonth: 5,
};
const run: PayrollRunDoc = {
  id: 'acme-ana-2026-09', contractId: 'c', companyId: 'acme', personId: 'ana', year: 2026, month: 9,
  grossCents: 100000, irsCents: 10000, ssEmpCents: 11000, ssErCents: 0, netCents: 79000, benefitsCents: 30000,
  costToEmployerCents: 130000, cashOutCents: 109000, confirmedAt: new Date(), sourceAccountId: 'bank',
};
const expected = (entries: RecurringEntryDoc[] = [], credits: CreditContractDoc[] = [], runs: PayrollRunDoc[] = []) =>
  expectedForMonth({ ym: YM, accountId: 'bank', entries, credits, payrollRuns: runs, peopleById: { ana: 'Ana' } });

describe('normalizeDescription', () => {
  it('keeps the stable words only', () => {
    expect(normalizeDescription('DD MEO, SA 41177542876')).toBe('DD MEO SA');
    expect(normalizeDescription('TRF CR SEPA+ 317 P/ PT50003503390005980843060 ANA CGD')).toBe('TRF CR SEPA PT ANA CGD');
    expect(normalizeDescription('Água — Coimbra')).toBe('AGUA COIMBRA');
  });
});

describe('expected items of a month', () => {
  it('takes recurring entries of the account, transfers both ways, credit instalments and salaries paid from it', () => {
    const items = expected(
      [
        entry({ id: 'luz', description: 'Luz', dayOfMonth: 16, amountCents: 4500 }),
        entry({ id: 'other', accountId: 'elsewhere' }),
        entry({ id: 'yearly', frequency: 'annual', monthOfYear: 3 }),
        entry({ id: 'in', type: 'income', description: 'Cliente', amountCents: 50000, dayOfMonth: 31 }),
        entry({ id: 'tr', type: 'transfer', description: 'Para poupança', accountId: 'savings', toAccountId: 'bank', amountCents: 2000 }),
      ],
      [credit], [run],
    );
    expect(items.map(i => [i.key, i.amountCents, i.date])).toEqual([
      ['recurring:luz:2026-09', -4500, '2026-09-16'],
      ['recurring:in:2026-09', 50000, '2026-09-30'],
      ['recurring-in:tr:2026-09', 2000, '2026-09-01'],
      ['credit:cr:2026-09', -10000, '2026-09-05'],
      ['payroll:acme-ana-2026-09:2026-09', -79000, '2026-09-28'],
    ]);
  });
});

describe('suggestions', () => {
  const items = expected([entry({ id: 'luz', description: 'EDP Luz', dayOfMonth: 16, amountCents: 4500 })], [credit], [run]);

  it('suggests the expected item with the same amount and a close date, and says why', () => {
    const s = suggestMatches([line({ id: 'a', date: '2026-09-17', description: 'DD EDP COMERCIAL 123', amountCents: -4500 })], items, []);
    expect(s.get('a')).toMatchObject({ match: { kind: 'recurring', ref: 'luz', yearMonth: YM, label: 'EDP Luz' }, reason: 'mesmo valor, 1 dia(s) de diferença, descrição parecida' });
  });

  it('never suggests the wrong sign, an item twice, or an item already settled', () => {
    const settled = line({ id: 'done', amountCents: -10000, match: { kind: 'credit', ref: 'cr', yearMonth: YM, label: 'Crédito carro', confirmedAt: 'x' } });
    const s = suggestMatches([
      settled,
      line({ id: 'again', date: '2026-09-05', amountCents: -10000 }),
      line({ id: 'refund', date: '2026-09-16', amountCents: 4500 }),
      line({ id: 'l1', date: '2026-09-16', amountCents: -4500 }),
      line({ id: 'l2', date: '2026-09-16', amountCents: -4500 }),
    ], items, []);
    expect([...s.keys()]).toEqual(['l1']);
  });

  it('matches a salary transfer anywhere between the net and the net plus benefits', () => {
    const s = suggestMatches([line({ id: 'pay', date: '2026-10-02', description: 'TRF P/ ANA', amountCents: -95000 })], items, []);
    expect(s.get('pay')?.match).toMatchObject({ kind: 'payroll', ref: 'acme-ana-2026-09', label: 'Salário — Ana' });
  });

  it('accepts a commission estimate within 15%, but not a fixed amount that is off', () => {
    const est = expected([entry({ id: 'fee', description: 'Comissão', costModel: 'commission', commissionPct: 1, amountCents: 3000 }), entry({ id: 'fix', description: 'Fixo', amountCents: 2000 })]);
    const s = suggestMatches([line({ id: 'c', amountCents: -3300 }), line({ id: 'f', amountCents: -2100 })], est, []);
    expect([...s.entries()].map(([k, v]) => [k, v.match.ref])).toEqual([['c', 'fee']]);
  });

  it('puts a remembered description first, even with no expected item', () => {
    const rules: MovementRuleDoc[] = [
      { id: 'r1', key: 'PAG PORTAGEM', match: { kind: 'adhoc', label: 'Portagens', categoryId: 'viaturas', vatCode: 23 } },
      { id: 'r2', key: 'DD EDP COMERCIAL', match: { kind: 'recurring', ref: 'luz', label: 'EDP Luz' } },
    ];
    const s = suggestMatches([
      line({ id: 'toll', description: 'PAG. PORTAGEM 5131541/06', amountCents: -340 }),
      line({ id: 'edp', date: '2026-09-25', description: 'DD EDP COMERCIAL 999', amountCents: -4700 }),
    ], items, rules);
    expect(s.get('toll')).toMatchObject({ score: 100, match: { kind: 'adhoc', label: 'Portagens', categoryId: 'viaturas', vatCode: 23, yearMonth: YM } });
    expect(s.get('edp')).toMatchObject({ score: 100, item: { key: 'recurring:luz:2026-09' } });
  });
});

describe('missing expected items', () => {
  it('lists what was due a few days ago and has no confirmed line', () => {
    const items = expected([entry({ id: 'luz', dayOfMonth: 16 })], [credit]);
    const lines = [line({ match: { kind: 'credit', ref: 'cr', yearMonth: YM, label: 'x', confirmedAt: 'x' } })];
    expect(missingExpected(items, lines, '2026-09-20').map(i => i.key)).toEqual([]);
    expect(missingExpected(items, lines, '2026-09-22').map(i => i.key)).toEqual(['recurring:luz:2026-09']);
  });
});
