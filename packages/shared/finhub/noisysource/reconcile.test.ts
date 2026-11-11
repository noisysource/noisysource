import { describe, expect, it } from 'vitest';
import { reversalId } from '../envelope';
import { planImport } from '../importSync';
import { acceptanceReport } from './acceptance';
import { buildNsEvent, nextFreeId, nsIds, type NsEvent } from './events';
import { plannedItems, providerFeeCents } from './plan';
import { bucketsTotal, descriptionKey, monthRecon, reconcile, subsetSum } from './reconcile';
import { rebuildNsState } from './state';
import { CLIENT_HOLIDAYS_2030, CONTRACT, ev, terms } from './testkit';
import { projectTreasury } from './treasury';

// Made-up company: one worker (Ana Teste), one client (Plataforma X), two costs, vouchers bought
// from "Provedor" with a 5% + 20% VAT fee. Bank lines Feb–Mar 2030.

const FEE = { label: 'comissão Provedor', pct: 5, vatPct: 20 };

const rules = [
  ev('payment.rule.set', { what: 'salarios', label: 'Salários', from: '2030-01-01', day: 25, monthOffset: 0, nonBusinessDay: 'before' }),
  ev('payment.rule.set', { what: 'refeicao', label: 'Cartão refeição', from: '2030-01-01', day: 25, monthOffset: 0, nonBusinessDay: 'before' }),
  ev('payment.rule.set', { what: 'vales', label: 'Vales Provedor', from: '2030-01-01', day: 25, monthOffset: 0, nonBusinessDay: 'before', fee: FEE }),
  ev('payment.rule.set', { what: 'ss', label: 'Segurança Social (TSU)', from: '2030-01-01', day: 20, monthOffset: 1, nonBusinessDay: 'after' }),
  ev('payment.rule.set', { what: 'irs', label: 'IRS retido', from: '2030-01-01', day: 20, monthOffset: 1, nonBusinessDay: 'after' }),
  ev('payment.rule.set', { what: 'ec-fatura', label: 'Fatura', from: '2030-01-01', day: 31, monthOffset: 0, nonBusinessDay: 'before' }),
];
const costs = [
  ev('cost.plan.set', { key: 'telefone', description: 'Telefone Rede Azul', amountCents: 5000, direction: 'saida', vatCode: 23, frequency: 'monthly', day: 9, from: '2030-01-01', account: 'acc-1' }),
  ev('cost.plan.set', { key: 'contabilista', description: 'Contabilista Silva', amountCents: 10000, direction: 'saida', vatCode: 23, frequency: 'monthly', day: 12, from: '2030-01-01', account: 'acc-1' }),
];
const payslip = (month: string) => ev('payroll.payslip.recorded', {
  personId: 'ana', month, grossCents: 100000, irsCents: 10000, ssEmpCents: 11000, ssErCents: 23750, netCents: 79000,
  lines: [
    { code: '1', label: 'Vencimento base', kind: 'base', amountCents: 100000 },
    { code: '2', label: 'Vale Infância', kind: 'beneficio', amountCents: 10000, paidAs: 'cartao' },
    { code: '3', label: 'Vale Educação', kind: 'beneficio', amountCents: 5000, paidAs: 'cartao' },
    { code: '4', label: 'Sub. refeição', kind: 'refeicao', amountCents: 16000, quantity: 20, unitCents: 800, paidAs: 'cartao' },
  ],
}, nsIds.payslip('ana', month));

/** Bank lines with a running balance from 1,000,000. */
function lines(rows: [string, string, number, string][]): NsEvent[] {
  let bal = 1_000_000;
  return rows.map(([id, date, amountCents, description], seq) => {
    bal += amountCents;
    return ev('bank.movement.imported', { accountId: 'acc-1', date, valueDate: date, amountCents, description, balanceAfterCents: bal, importId: 'imp', seq }, id);
  });
}

const vales = 10000 + 5000 + providerFeeCents(15000, FEE); // one order for both cards
const bank = lines([
  ['b-tel-feb', '2030-02-11', -4800, 'DD REDE AZUL 990001'],
  ['b-cont', '2030-02-12', -30000, 'TRF CR SEPA+ 11 P/ PT50000000000000000000001 CONTABILISTA SILVA'],
  ['b-sal', '2030-02-26', -79000, 'TRF CR SEPA+ 12 P/ PT50000000000000000000002 ANA TESTE'],
  ['b-vales', '2030-02-26', -vales, 'PAGSERV PROVEDOR 834000001'],
  ['b-meal', '2030-02-26', -16000, 'TRF CR SEPA+ 13 P/ PT50000000000000000000003 CARTAO X'],
  ['b-tel-1', '2030-03-11', -3000, 'DD REDE AZUL 990001'],
  ['b-ec', '2030-03-11', 760000, 'TRF SEPA+ INST 14 DE PLATAFORMA X'],
  ['b-hotel', '2030-03-14', -12000, '12/03 COMPRA EL-E 1234/00 HOTEL CENTRAL'],
  ['b-tsu', '2030-03-20', -34750, 'COBRANCA TSU NIF=500000000 - 203002'],
  ['b-tel-2', '2030-03-21', -2500, 'DD REDE AZUL 990001'],
  ['b-xyz', '2030-03-29', -100, 'XYZ 77'],
]);
const base = [...rules, ...costs, CLIENT_HOLIDAYS_2030, ev('ec.contract.signed', CONTRACT, nsIds.ecContract(CONTRACT.number)),
  ev('employment.terms.set', terms()), payslip('2030-02'), ...bank];

describe('provider fee', () => {
  it('is pct of the amount plus VAT on the fee, each rounded to the cent', () => {
    expect(providerFeeCents(15000, FEE)).toBe(750 + 150);
    expect(providerFeeCents(31250, { label: 'x', pct: 4.5, vatPct: 23 })).toBe(1406 + 323);
  });

  it('adds the fee to each voucher card item, one item per card', () => {
    const items = plannedItems(rebuildNsState(base), { from: '2030-02-01', to: '2030-02-28', mainAccount: 'acc-1' });
    const v = items.filter(i => i.kind === 'vales').map(i => [i.id, i.amountCents, i.baseCents]);
    expect(v).toEqual([
      ['vales:ana.creche:2030-02', -(10000 + providerFeeCents(10000, FEE)), -10000],
      ['vales:ana.educacao:2030-02', -(5000 + providerFeeCents(5000, FEE)), -5000],
    ]);
  });
});

describe('reconciliation suggestions', () => {
  const s = rebuildNsState(base);
  const rec = reconcile(s, { accountId: 'acc-1' });
  const line = (id: string) => rec.lines.get(id)!;

  it('matches the client payment, the salary by name and the SS line by its month', () => {
    expect(line('b-ec')).toMatchObject({ state: 'sugerido', itemIds: ['ec:C-100:2030-02'], exact: true });
    expect(line('b-sal')).toMatchObject({ state: 'sugerido', itemIds: ['salario:ana:2030-02'], exact: true });
    expect(line('b-tsu')).toMatchObject({ state: 'sugerido', itemIds: ['ss:all:2030-02'], exact: true });
    expect(line('b-meal').itemIds).toEqual(['refeicao:ana:2030-02']); // no hint: same amount, close date
  });

  it('pays several voucher cards in one payment, the provider fee on the total', () => {
    expect(line('b-vales')).toMatchObject({ state: 'sugerido', exact: true });
    expect(line('b-vales').itemIds.sort()).toEqual(['vales:ana.creche:2030-02', 'vales:ana.educacao:2030-02']);
  });

  it('spreads a lump payment over the oldest open months of the cost', () => {
    expect(line('b-cont').itemIds).toEqual(['custo:contabilista:2030-02', 'custo:contabilista:2030-03', 'custo:contabilista:2030-04']);
  });

  it('puts every line of a varying cost on its month, as an amount difference', () => {
    expect(line('b-tel-1')).toMatchObject({ itemIds: ['custo:telefone:2030-03'], exact: false });
    expect(line('b-tel-2').itemIds).toEqual(['custo:telefone:2030-03']);
    const g = rec.groups[rec.groupOfItem.get('custo:telefone:2030-03')!];
    expect(g.diffCents).toBe(-5500 + 5000);
  });

  it('suggests an ad hoc category from keywords, and leaves the unknown open', () => {
    expect(line('b-hotel')).toMatchObject({ state: 'classificacao-sugerida', category: 'viagens' });
    expect(line('b-xyz').state).toBe('por-explicar');
  });

  it('explains real − planned bucket by bucket, to the cent', () => {
    for (const month of ['2030-02', '2030-03']) {
      const m = monthRecon(s, rec, month)!;
      expect(bucketsTotal(m.buckets)).toBe(m.diffCents);
    }
    const mar = monthRecon(s, rec, '2030-03')!;
    expect(mar.buckets.unexplainedCents).toBe(-100);
    expect(mar.buckets.adhocCents).toBe(-12000);
  });
});

describe('confirmations', () => {
  const match = (id: string, movementId: string, items: { to: 'custo' | 'salario'; ref: string; month: string }[]) =>
    ev('bank.movement.matched', { movementId, items, basis: 'escolhido à mão' }, id, { effectiveDate: '2030-03-01' });

  it('a confirmed match is "confirmado", and a reversal brings the suggestion back', () => {
    const m = match(nsIds.match('b-sal'), 'b-sal', [{ to: 'salario', ref: 'ana', month: '2030-02' }]);
    const s1 = rebuildNsState([...base, m]);
    expect(reconcile(s1, { accountId: 'acc-1' }).lines.get('b-sal')!.state).toBe('confirmado');
    const s2 = rebuildNsState([...base, m, ev('reversal', {}, reversalId(m.id), { reverses: m.id })]);
    expect(reconcile(s2, { accountId: 'acc-1' }).lines.get('b-sal')!.state).toBe('sugerido');
    expect(nextFreeId(nsIds.match('b-sal'), new Set([m.id]))).toBe('m-b-sal-r2');
  });

  it('learns from a confirmed line: the same description goes to the same cost', () => {
    const confirmed = match(nsIds.match('b-tel-feb'), 'b-tel-feb', [{ to: 'custo', ref: 'telefone', month: '2030-02' }]);
    const rec = reconcile(rebuildNsState([...base, confirmed]), { accountId: 'acc-1' });
    expect(rec.lines.get('b-tel-1')!.basis).toContain('já confirmadas');
    expect(descriptionKey('16/08 COMPRA EL-E 6043649/06 A1 SANTA')).toBe('COMPRA EL-E A1 SANTA');
  });

  it('a written reason explains a planned item without a bank line', () => {
    const s0 = rebuildNsState(base);
    const missing = [...reconcile(s0, { accountId: 'acc-1' }).items.values()].find(i => i.state === 'sem-movimento')!;
    const s = rebuildNsState([...base, ev('plan.item.explained', { itemId: missing.item.id, month: missing.item.month, reason: 'pago pela outra conta' }, nsIds.explained(missing.item.id))]);
    const it = reconcile(s, { accountId: 'acc-1' }).items.get(missing.item.id)!;
    expect(it).toMatchObject({ state: 'explicado', reason: 'pago pela outra conta' });
  });

  it('Tesouraria doesn\'t project an item a confirmed lump already paid', () => {
    const lump = match(nsIds.match('b-cont'), 'b-cont', ['2030-02', '2030-03', '2030-04'].map(month => ({ to: 'custo' as const, ref: 'contabilista', month })));
    const s = rebuildNsState([...base, lump]);
    const p = projectTreasury(s, { accountId: 'acc-1', today: '2030-03-30', horizonDays: 60 })!;
    const ids = p.days.flatMap(d => d.items.map(i => i.id));
    expect(ids).not.toContain('custo:contabilista:2030-04');
    expect(ids).toContain('custo:contabilista:2030-05');
  });
});

describe('acceptance report', () => {
  it('a month passes with suggestions until they are confirmed, and names what fails', () => {
    const r = acceptanceReport(rebuildNsState(base), { accountId: 'acc-1', today: '2030-03-30', months: ['2030-02', '2030-03'] });
    const mar = r.months.find(m => m.month === '2030-03')!;
    expect(mar.criteria.find(c => c.n === 1)!).toMatchObject({ status: 'falha', details: ['2030-03-29 XYZ 77'] });
    const feb = r.months.find(m => m.month === '2030-02')!;
    expect(feb.criteria.find(c => c.n === 4)!.summary).toMatch(/\/1 iguais/);
    expect(r.chain[0]).toMatchObject({ contract: 'C-100', lastDay: '2030-03-15' });
  });
});

describe('subset sum', () => {
  it('finds the earliest subset that fits', () => {
    expect(subsetSum([5, 3, 2, 7], { maxSize: 3, limit: 10, ok: s => s === 10 })).toEqual([0, 1, 2]);
    expect(subsetSum([5, 3], { maxSize: 2, minSize: 2, limit: 5, ok: s => s === 5 })).toBeNull();
  });
});

describe('import as corrections', () => {
  const imp = (id: string, dates: string[], recordedBy = 'importer:test') =>
    buildNsEvent('holidays.set', { calendarId: 'x', year: 2030, dates }, { id, source: 'import:seed', recordedBy, recordedAt: '2030-01-01T00:00:00.000Z' }) as unknown as NsEvent;
  const reversal = (o: { id: string; reverses: string; note: string }) =>
    buildNsEvent('reversal', {}, { ...o, source: 'import:seed', recordedBy: 'importer:test', recordedAt: '2030-02-01T00:00:00.000Z' }) as unknown as NsEvent;
  const opts = { isImporter: (e: NsEvent) => e.recordedBy.startsWith('importer:'), reversal };

  it('creates what is new, skips what is the same, and corrects with a reversal + -r2', () => {
    const stored = [imp('a', ['2030-01-01']), imp('b', ['2030-01-01'])];
    const plan = planImport([imp('a', ['2030-01-01']), imp('b', ['2030-01-02']), imp('c', [])], stored, opts);
    expect(plan.create.map(e => e.id)).toEqual(['c']);
    expect(plan.unchanged).toBe(1);
    expect(plan.corrections).toMatchObject([{ liveId: 'b', reversalId: 'rev-b', changed: ['payload.dates'] }]);
    expect(plan.corrections[0].replacement.id).toBe('b-r2');
    expect(plan.reversals[0]).toMatchObject({ id: 'rev-b', reverses: 'b' });
  });

  it('follows the chain to the version in force, and never replaces one a person recorded', () => {
    const stored = [imp('b', ['2030-01-01']), reversal({ id: 'rev-b', reverses: 'b', note: '' }), imp('b-r2', ['2030-01-02'])];
    expect(planImport([imp('b', ['2030-01-02'])], stored, opts).unchanged).toBe(1);
    const third = planImport([imp('b', ['2030-01-03'])], stored, opts);
    expect(third.corrections[0]).toMatchObject({ liveId: 'b-r2', reversalId: 'rev-b-r2' });
    expect(third.corrections[0].replacement.id).toBe('b-r3');
    const manual = [imp('b', ['2030-01-01']), reversal({ id: 'rev-b', reverses: 'b', note: '' }), imp('b-r2', ['2030-01-05'], 'uid-renato')];
    expect(planImport([imp('b', ['2030-01-02'])], manual, opts).keptManual).toEqual(['b']);
    expect(planImport([imp('b', ['2030-01-02'])], [imp('b', ['2030-01-01']), reversal({ id: 'rev-b', reverses: 'b', note: '' })], opts).cancelled).toEqual(['b']);
  });
});
