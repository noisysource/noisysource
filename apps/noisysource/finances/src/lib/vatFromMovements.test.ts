import { describe, expect, it } from 'vitest';
import type { RecurringEntryDoc } from '@shared/models/RecurringEntry';
import type { BankTransactionDoc, BankTransactionMatch } from '@shared/models/BankTransaction';
import { quarterVat } from './vatFromMovements';

// Made-up values only.
const entry = (over: Partial<RecurringEntryDoc>): RecurringEntryDoc => ({
  id: 'e', type: 'expense', description: 'x', amountCents: 1000, frequency: 'monthly', dayOfMonth: 1, active: true, ...over,
});
const m = (over: Partial<BankTransactionMatch>): BankTransactionMatch => ({ kind: 'adhoc', label: 'x', confirmedAt: 't', ...over });
const line = (date: string, amountCents: number, match?: BankTransactionMatch): BankTransactionDoc =>
  ({ id: `${date}${amountCents}`, accountId: 'bank', entityId: 'acme', sourceType: 'pdf', date, description: 'x', amountCents, match });

const MONTHS = ['2026-07', '2026-08', '2026-09'];
const entries = [
  entry({ id: 'acc', description: 'Contabilista', vatCode: 23, amountCents: 12300 }),
  entry({ id: 'sal', description: 'Encargos', sourceId: 'emp:c:ns', amountCents: 100000 }),
];

describe('IVA from movements', () => {
  it('takes real VAT from the confirmed lines of months that are over, and estimates the rest', () => {
    const v = quarterVat({
      months: MONTHS, currentYM: '2026-09', incomeFromLines: true, entries,
      lines: [
        line('2026-07-05', -12300, m({ kind: 'recurring', ref: 'acc', label: 'Contabilista' })),
        line('2026-08-05', -12300, m({ kind: 'recurring', ref: 'acc', label: 'Contabilista' })),
        line('2026-08-10', -6150, m({ kind: 'adhoc', label: 'Portátil', vatCode: 23 })),
        line('2026-08-12', -50000, m({ kind: 'recurring', ref: 'sal', label: 'Encargos' })),
        line('2026-08-15', -2000, m({ kind: 'credit', ref: 'cr', label: 'Crédito' })),
        line('2026-08-20', 24600, m({ kind: 'adhoc', label: 'Serviço', vatCode: 23 })),
      ],
    });
    expect(v.monthSource).toEqual({ '2026-07': 'real', '2026-08': 'real', '2026-09': 'previsto' });
    expect(v.expenseRows).toEqual([
      { description: 'Contabilista', vatCode: 23, baseCents: 20000, ivaCents: 4600, source: 'real' },
      { description: 'Portátil', vatCode: 23, baseCents: 5000, ivaCents: 1150, source: 'real' },
      { description: 'Contabilista', vatCode: 23, baseCents: 10000, ivaCents: 2300, source: 'previsto' },
    ]);
    expect(v.incomeRows).toEqual([{ description: 'Serviço', vatCode: 23, baseCents: 20000, ivaCents: 4600, source: 'real' }]);
  });

  it('lists unknown VAT apart and counts the lines still to classify', () => {
    const v = quarterVat({
      months: MONTHS, currentYM: '2026-10', incomeFromLines: true, entries,
      lines: [line('2026-07-01', -1000, m({ kind: 'adhoc', label: 'Sem taxa' })), line('2026-07-02', -500), line('2026-09-03', -700)],
    });
    expect(v.unconfirmed).toEqual([{ description: 'Sem taxa', amountCents: 1000, kind: 'despesa', source: 'real' }]);
    expect(v.pendingLines).toBe(2);
    expect(v.monthSource['2026-08']).toBe('previsto'); // over, but no statement lines
  });

  it('leaves income lines out when the income VAT comes from invoices (NoisyPhocus)', () => {
    const v = quarterVat({
      months: MONTHS, currentYM: '2026-10', incomeFromLines: false, entries: [],
      lines: [line('2026-07-20', 24600, m({ kind: 'adhoc', label: 'Serviço', vatCode: 23 })), line('2026-07-21', 100)],
    });
    expect(v.incomeRows).toEqual([]);
    expect(v.pendingLines).toBe(0);
  });
});
