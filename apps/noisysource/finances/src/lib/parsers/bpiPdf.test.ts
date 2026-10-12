import { describe, expect, it } from 'vitest';
import {
  BpiPdfError,
  bpiPdfTxId,
  groupTextLines,
  parseBpiPdfLines,
  parsePtAmountCents,
  type PdfTextItem,
} from './bpiPdf';
import { bpiTxId } from './bpiXlsx';
import { SEPTEMBER_STATEMENT } from './fixtures/bpiPdfSeptember';

const parse = (items: PdfTextItem[]) => parseBpiPdfLines(groupTextLines(items));

// Replace the text of the one fixture item matching (page, y, text[, x]).
function edit(items: PdfTextItem[], page: number, y: number, text: string, to: string, x?: number): PdfTextItem[] {
  const hits = items.filter(i =>
    i.page === page && Math.abs(i.y - y) < 0.5 && i.text === text && (x === undefined || Math.abs(i.x - x) < 1));
  expect(hits).toHaveLength(1);
  return items.map(i => (i === hits[0] ? { ...i, text: to } : i));
}

// Every item on one row (page, y ± 0.5).
const onRow = (page: number, y: number) => (i: PdfTextItem) => i.page === page && Math.abs(i.y - y) < 0.5;

// A minimal statement at the real column positions, for cases the fixture doesn't cover.
// rows: [DATA MOV | '', DATA VAL, description, VALOR, SALDO]
function synthetic(period: string, opening: string, rows: [string, string, string, string, string][], closing: string): PdfTextItem[] {
  const right = (text: string, edge: number, y: number): PdfTextItem =>
    ({ page: 1, x: edge - text.length * 3.2, y, width: text.length * 3.2, text });
  const items: PdfTextItem[] = [
    { page: 1, x: 56.2, y: 619.6, width: 31.3, text: 'Período' },
    { page: 1, x: 105.1, y: 618.8, width: 115.3, text: period },
    { page: 1, x: 56.3, y: 530.4, width: 16.6, text: 'DATA' },
    { page: 1, x: 82.3, y: 530.4, width: 16.6, text: 'DATA' },
    { page: 1, x: 112.9, y: 530.4, width: 82.9, text: 'DESCRIÇÃO DO MOVIMENTO' },
    { page: 1, x: 488.6, y: 530.6, width: 20.4, text: 'VALOR' },
    { page: 1, x: 555, y: 530.7, width: 19.8, text: 'SALDO' },
    { page: 1, x: 113, y: 474.6, width: 118.7, text: 'SALDO ANTERIOR CONTABILISTICO' },
    right(opening, 575.2, 474.6),
  ];
  let y = 474.6;
  for (const [mov, val, desc, valor, saldo] of rows) {
    y -= 11.8;
    if (mov) items.push({ page: 1, x: 56.2, y, width: 15.8, text: mov });
    items.push({ page: 1, x: 82.3, y, width: 15.8, text: val });
    items.push({ page: 1, x: 113, y, width: desc.length * 3.6, text: desc });
    if (valor) items.push(right(valor, 508.8, y));
    if (saldo) items.push(right(saldo, 575.2, y));
  }
  y -= 11.8;
  items.push({ page: 1, x: 113, y, width: 111.5, text: 'SALDO ACTUAL CONTABILISTICO' }, right(closing, 575.2, y));
  return items;
}

describe('parsePtAmountCents', () => {
  it('reads Portuguese amounts exactly', () => {
    expect(parsePtAmountCents('1 234,56')).toBe(123456);
    expect(parsePtAmountCents('-1 000,00')).toBe(-100000);
    expect(parsePtAmountCents('-0,07')).toBe(-7);
    expect(parsePtAmountCents('987,65')).toBe(98765);
    expect(parsePtAmountCents('4.321,09')).toBe(432109);
    expect(parsePtAmountCents('12 345 678,90')).toBe(1234567890);
  });

  it('rejects anything that is not a whole amount', () => {
    for (const s of ['', '1117', '12,5', '162 312 573 096 793', '1.293.063.324,98,', '04/09', 'SALDO', '1 2345,00']) {
      expect(parsePtAmountCents(s)).toBeNull();
    }
  });
});

describe('groupTextLines', () => {
  const lines = groupTextLines(SEPTEMBER_STATEMENT);
  const texts = (i: number) => lines[i].cells.map(c => c.text);

  it('rebuilds rows from column-ordered items, left to right', () => {
    // DATA MOV sits 0.2pt below the rest of this row in the real statement.
    const i = lines.findIndex(l => l.cells.some(c => c.text.startsWith('04/09 COMPRA')));
    expect(texts(i)).toEqual(['04/09', '04/09', '04/09 COMPRA EL-E 0000000/11 LOJA EXEMPLO', 'LISBOA', '-62,30', '595,96']);
  });

  it('keeps header lines that are 2.6pt apart separate', () => {
    expect(lines.find(l => l.cells[0].text === 'Extracto')!.cells.map(c => c.text)).toEqual(['Extracto', '009/2026']);
    expect(lines.find(l => l.cells[0].text === 'Conta')!.cells.map(c => c.text))
      .toEqual(['Conta', '0-0000000-000-001', 'EMPRESA EXEMPLO - LDA']);
  });

  it('never merges lines across pages', () => {
    // Both pages print the same footer at the same y.
    expect(lines.filter(l => l.cells[0].text.startsWith('Sede:')).map(l => l.page)).toEqual([1, 2]);
    expect(lines.filter(l => l.cells.some(c => c.text === 'DESCRIÇÃO DO MOVIMENTO')).map(l => l.page)).toEqual([1, 2]);
  });
});

describe('parseBpiPdfLines — September fixture', () => {
  const stmt = parse(SEPTEMBER_STATEMENT);
  const tx = stmt.transactions;

  it('reads the header: account, holder, period, balances', () => {
    expect(stmt.accountNumber).toBe('0-0000000-000-001');
    expect(stmt.holderName).toBe('EMPRESA EXEMPLO - LDA');
    expect(stmt.dateFrom).toBe('2026-09-01');
    expect(stmt.dateTo).toBe('2026-09-30');
    expect(stmt.openingBalanceCents).toBe(187540);
    expect(stmt.closingBalanceCents).toBe(223632);
  });

  it('reads every movement, oldest first, and skips footers and legal text', () => {
    expect(tx).toHaveLength(36);
    expect(tx.filter(t => t.amountCents > 0)).toHaveLength(16);
    expect(tx[0]).toEqual({
      date: '2026-09-01',
      valueDate: '2026-09-01',
      description: 'TRF SEPA+ INST 101 P/ PT50000000000000000000001',
      amountCents: -21000,
      balanceCents: 166540,
    });
    expect(tx[1].amountCents).toBe(-112000); // thousands separator on a debit
    expect(tx[35]).toMatchObject({ amountCents: -2890, balanceCents: 223632 });
    expect(stmt.openingBalanceCents! + tx.reduce((s, t) => s + t.amountCents, 0)).toBe(stmt.closingBalanceCents);
  });

  it('takes the year from Período', () => {
    expect(tx.every(t => t.date.startsWith('2026-09-') && t.valueDate.startsWith('2026-09-'))).toBe(true);
  });

  it('gives a blank DATA MOV the date of the line above', () => {
    expect(tx[1].date).toBe('2026-09-01');
    expect(tx.slice(16, 22).map(t => t.date)).toEqual(Array(6).fill('2026-09-15'));
  });

  it('carries a blank DATA MOV across the page break', () => {
    expect(tx[34]).toMatchObject({ date: '2026-09-29', description: 'TRF SEPA+ INST 117 DE PAGADOR N EXEMPLO' });
    expect(tx[35].date).toBe('2026-09-29');
  });

  it('keeps DATA VAL separate from DATA MOV', () => {
    expect(tx[6]).toMatchObject({ date: '2026-09-07', valueDate: '2026-09-06', amountCents: 12750 });
  });

  it('does not mistake a date at the start of the description for DATA MOV', () => {
    expect(tx[7]).toMatchObject({
      date: '2026-09-07',
      description: '07/09 VENDAS EM TPA 1000000001 KIDCLUB ARCO-IRIS E - R/C -',
    });
    expect(tx[17]).toMatchObject({ date: '2026-09-15', description: '27/08 COMPRA EL-E 0000000/00 RENT A CAR EXEMPLO' });
  });

  it('joins a description split into several text runs', () => {
    expect(tx[5].description).toBe('04/09 COMPRA EL-E 0000000/11 LOJA EXEMPLO LISBOA');
  });
});

describe('parseBpiPdfLines — refuses an inconsistent statement', () => {
  const refuses = (items: PdfTextItem[], message: RegExp) => {
    expect(() => parse(items)).toThrow(BpiPdfError);
    expect(() => parse(items)).toThrow(message);
  };

  it('when one amount does not match the running balance', () => {
    refuses(edit(SEPTEMBER_STATEMENT, 1, 404, '-62,30', '-62,40'), /Saldo não bate em 04\/09.*Importação recusada/);
  });

  it('when one balance is wrong', () => {
    refuses(edit(SEPTEMBER_STATEMENT, 2, 730, '2 265,22', '2 265,23'), /Saldo não bate em 29\/09/);
  });

  it('when a whole movement is missing', () => {
    refuses(SEPTEMBER_STATEMENT.filter(i => !onRow(1, 286)(i)), /Saldo não bate em 15\/09/);
  });

  it('when the closing balance does not match the movements', () => {
    refuses(edit(SEPTEMBER_STATEMENT, 2, 706.5, '2 236,32', '2 236,33'), /saldo final do extrato/);
  });

  it('when SALDO ANTERIOR or SALDO ACTUAL CONTABILISTICO is missing', () => {
    refuses(SEPTEMBER_STATEMENT.filter(i => !onRow(1, 474.6)(i)), /Saldo anterior não encontrado/);
    const noClosing = /Saldo final \(SALDO ACTUAL CONTABILISTICO\) não encontrado/;
    refuses(SEPTEMBER_STATEMENT.filter(i => !onRow(2, 706.5)(i)), noClosing);
    refuses(SEPTEMBER_STATEMENT.filter(i => !onRow(2, 706.5)(i) && !onRow(2, 694.7)(i)), noClosing);
  });

  it('when Período is missing', () => {
    refuses(SEPTEMBER_STATEMENT.filter(i => !i.text.startsWith('De 01/09/2026')), /Período do extrato não encontrado/);
  });

  it('when the first movement has no DATA MOV', () => {
    refuses(SEPTEMBER_STATEMENT.filter(i => !(onRow(1, 462.9)(i) && i.x < 60)), /Primeiro movimento sem data/);
  });

  it('when a movement has an amount but no balance', () => {
    refuses(SEPTEMBER_STATEMENT.filter(i => !(onRow(1, 392.1)(i) && i.x > 540)), /Linha não reconhecida/);
  });

  it('when a movement date falls outside the period', () => {
    refuses(edit(SEPTEMBER_STATEMENT, 1, 179.9, '18/09', '18/10', 56.2), /fora do período/);
  });

  it('when a date does not exist', () => {
    refuses(edit(SEPTEMBER_STATEMENT, 1, 180, '18/09', '31/09', 82.3), /Data inválida 31\/09/);
  });
});

describe('parseBpiPdfLines — dates across a year boundary', () => {
  it('splits a December → January statement between the two years', () => {
    const stmt = parse(synthetic('De 15/12/2026 a 14/01/2027', '100,00', [
      ['20/12', '20/12', 'TRF SEPA+ INST 1 DE PAGADOR A EXEMPLO', '50,00', '150,00'],
      ['02/01', '31/12', 'TRF SEPA+ INST 2 DE PAGADOR B EXEMPLO', '25,00', '175,00'],
      ['', '05/01', 'IMPOSTO DE SELO DEZ 2026', '-0,20', '174,80'],
    ], '174,80'));
    expect(stmt.transactions.map(t => [t.date, t.valueDate])).toEqual([
      ['2026-12-20', '2026-12-20'],
      ['2027-01-02', '2026-12-31'],
      ['2027-01-02', '2027-01-05'],
    ]);
    expect([stmt.dateFrom, stmt.dateTo]).toEqual(['2026-12-15', '2027-01-14']);
  });

  it('puts a value date just before a January statement in the previous year', () => {
    const stmt = parse(synthetic('De 01/01/2027 a 31/01/2027', '10,00', [
      ['02/01', '31/12', 'TRF SEPA+ INST 3 DE PAGADOR C EXEMPLO', '5,00', '15,00'],
    ], '15,00'));
    expect(stmt.transactions[0]).toMatchObject({ date: '2027-01-02', valueDate: '2026-12-31' });
  });

  it('handles an overdrawn (negative) balance', () => {
    const stmt = parse(synthetic('De 01/03/2027 a 31/03/2027', '-10,00', [
      ['03/03', '03/03', 'TRF SEPA+ INST 4 DE PAGADOR D EXEMPLO', '25,00', '15,00'],
      ['04/03', '04/03', 'DD MEO, SA 10000000001', '-1 020,00', '-1 005,00'],
    ], '-1 005,00'));
    expect(stmt.openingBalanceCents).toBe(-1000);
    expect(stmt.closingBalanceCents).toBe(-100500);
  });
});

describe('transaction ids', () => {
  const tx = parse(SEPTEMBER_STATEMENT).transactions;

  it('keeps two identical lines on the same day apart (PDF ids carry the balance)', () => {
    const [a, b] = [tx[16], tx[17]];
    expect([a.date, a.amountCents, a.description]).toEqual([b.date, b.amountCents, b.description]);
    expect(bpiTxId('acc1', a)).toBe(bpiTxId('acc1', b)); // why the XLSX id isn't enough
    expect(bpiPdfTxId('acc1', a)).not.toBe(bpiPdfTxId('acc1', b));
    expect(new Set(tx.map(t => bpiPdfTxId('acc1', t))).size).toBe(36);
  });

  it('is the XLSX id plus the balance, and leaves the XLSX id unchanged', () => {
    expect(bpiTxId('acc1', tx[0])).toBe('acc1_20260901_n21000_6bd8ce');
    expect(bpiPdfTxId('acc1', tx[0])).toBe('acc1_20260901_n21000_6bd8ce_p166540');
    expect(bpiPdfTxId('acc1', { ...tx[0], balanceCents: -500 })).toBe('acc1_20260901_n21000_6bd8ce_n500');
  });
});
