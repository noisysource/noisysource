import { describe, expect, it } from 'vitest';
import { blueprintIdOfItem, blueprints, calendarGaps, nextContractStart, unplannedGroupLines, yearGrid } from './blueprints';
import { ecRunway } from './ec';
import { intercompanyPosition, namesCounterparty } from './intercompany';
import { loanInstalment, plannedItems } from './plan';
import { reconcile } from './reconcile';
import { rebuildNsState } from './state';
import { CLIENT_HOLIDAYS_2030, CONTRACT, ev, terms } from './testkit';
import type { NsEvent } from './events';

const ACC = 'conta-teste';
const TODAY = '2030-03-10';

const line = (id: string, date: string, amountCents: number, description: string, balanceAfterCents: number, seq = 0) =>
  ev('bank.movement.imported', { accountId: ACC, date, valueDate: date, amountCents, description, balanceAfterCents, importId: 'x', seq }, id);

const BASE: NsEvent[] = [
  ev('employment.terms.set', terms(), 'emp-ana'),
  ev('ec.contract.signed', { ...CONTRACT, totalDays: 30 }, 'ec-c-100'),
  CLIENT_HOLIDAYS_2030,
  line('l1', '2030-02-28', -100, 'COMISSAO', 2000000),
];

const COST = {
  key: 'telefone', description: 'Telefone Rede Azul', amountCents: 5000, direction: 'saida' as const, vatCode: 'isento' as const,
  frequency: 'monthly' as const, day: 9, from: '2030-01-01', account: ACC,
};

describe('a new contract generates its own months', () => {
  const next = { ...CONTRACT, number: 'C-200', dailyRateCents: 50000, totalDays: 40, startDate: '2030-04-01', opening: undefined };

  it('invoices at its own rate, with nothing else to enter', () => {
    const before = plannedItems(rebuildNsState(BASE), { from: TODAY, to: '2030-12-31', mainAccount: ACC });
    expect(before.some(i => i.contractNumber === 'C-200')).toBe(false);

    const state = rebuildNsState([...BASE, ev('ec.contract.signed', next, 'ec-c-200')]);
    const items = plannedItems(state, { from: TODAY, to: '2030-12-31', mainAccount: ACC }).filter(i => i.contractNumber === 'C-200');
    const runway = ecRunway(state, state.contracts.find(c => c.number === 'C-200')!, TODAY);

    expect(items.length).toBe(runway.months.length);
    expect(items.length).toBeGreaterThan(1);
    expect(items.reduce((s, i) => s + i.amountCents, 0)).toBe(40 * 50000);
    for (const i of items) expect(i.inputs).toContain('500,00');
  });

  it('removing the contract removes its months', () => {
    const state = rebuildNsState([...BASE, ev('ec.contract.signed', next, 'ec-c-200'), ev('reversal', {}, 'rev-ec-c-200', { reverses: 'ec-c-200' })]);
    expect(plannedItems(state, { from: TODAY, to: '2030-12-31', mainAccount: ACC }).some(i => i.contractNumber === 'C-200')).toBe(false);
  });

  it('warns about the missing income until the contract is there', () => {
    const without = yearGrid(rebuildNsState(BASE), { accountId: ACC, today: TODAY })!;
    expect(without.warnings.some(w => w.kind === 'sem-receita')).toBe(true);
    const longOne = { ...next, totalDays: 900 };
    const withIt = yearGrid(rebuildNsState([...BASE, ev('ec.contract.signed', longOne, 'ec-c-200')]), { accountId: ACC, today: TODAY })!;
    expect(withIt.warnings.some(w => w.kind === 'sem-receita')).toBe(false);
  });

  it('proposes the working day after the last contract', () => {
    const state = rebuildNsState(BASE);
    const last = ecRunway(state, state.contracts[0], TODAY).lastDay!;
    const start = nextContractStart(state, TODAY);
    expect(start > last).toBe(true);
    expect([0, 6]).not.toContain(new Date(`${start}T00:00:00Z`).getUTCDay());
  });

  it('warns when a contract runs into a year the client calendar lacks', () => {
    const long = { ...next, startDate: '2031-01-02', totalDays: 200 };
    const state = rebuildNsState([...BASE, ev('ec.contract.signed', long, 'ec-c-200')]);
    expect(calendarGaps(state, TODAY)).toContainEqual({ contract: 'C-200', calendarId: 'client-x', year: 2031, count: 0 });
    const filled = rebuildNsState([...BASE, ev('ec.contract.signed', long, 'ec-c-200'), ev('holidays.set', {
      calendarId: 'client-x', year: 2031, dates: ['2031-01-01', '2031-04-18', '2031-05-01', '2031-08-15', '2031-12-25'],
    }, 'hol-client-x-2031')]);
    expect(calendarGaps(filled, TODAY).some(g => g.year === 2031)).toBe(false);
  });
});

describe('money between companies', () => {
  const plan = {
    key: 'irma', counterparty: 'Irmã Lda', matchWords: ['Irma Lda'], from: '2030-01-01', openingCents: 10000, openingAsOf: '2029-12-31', toConfirm: true,
  };
  const lines = [
    ...BASE,
    line('out', '2030-01-10', -500000, 'TRF P/ IRMÃ, LDA', 1000000),
    line('in', '2030-02-10', 100000, 'TRF DE IRMA - LDA', 1100000),
    line('other', '2030-02-11', -7000, 'TRF P/ OUTRA LDA', 1093000),
  ];

  it('moves with the bank lines naming the company, whatever the spelling', () => {
    expect(namesCounterparty(plan, 'trf de irmã  lda')).toBe(true);
    expect(namesCounterparty(plan, 'TRF P/ OUTRA LDA')).toBe(false);
    const state = rebuildNsState([...lines, ev('intercompany.plan.set', plan, 'ic-irma')]);
    const pos = intercompanyPosition(state, state.intercompany[0], ACC);
    expect(pos.lines.map(l => l.id)).toEqual(['out', 'in']);
    expect(pos.balanceCents).toBe(10000 + 500000 - 100000);
  });

  it('with no date it stays out of the forecast, and says so', () => {
    const state = rebuildNsState([...lines, ev('intercompany.plan.set', plan, 'ic-irma')]);
    expect(plannedItems(state, { from: TODAY, to: '2031-12-31', mainAccount: ACC }).some(i => i.kind === 'entre')).toBe(false);
    expect(yearGrid(state, { accountId: ACC, today: TODAY })!.warnings.some(w => w.kind === 'entre-sem-data')).toBe(true);
  });

  it('with a repayment, it comes back until nothing is owed', () => {
    const repay = { ...plan, repayment: { amountCents: 150000, firstMonth: '2030-04', day: 15 } };
    const state = rebuildNsState([...lines, ev('intercompany.plan.set', repay, 'ic-irma')]);
    const items = plannedItems(state, { from: TODAY, to: '2031-12-31', mainAccount: ACC }).filter(i => i.kind === 'entre');
    expect(items.map(i => i.amountCents)).toEqual([150000, 150000, 110000]);
    expect(items.map(i => i.month)).toEqual(['2030-04', '2030-05', '2030-06']);
    expect(blueprintIdOfItem(items[0])).toBe('entre:irma');
  });

  it('when we are the ones who owe, the repayment leaves the account', () => {
    const owing = { ...plan, openingCents: -600000, repayment: { amountCents: 500000, firstMonth: '2030-04', day: 15 } };
    const state = rebuildNsState([...lines, ev('intercompany.plan.set', owing, 'ic-irma')]);
    const items = plannedItems(state, { from: TODAY, to: '2031-12-31', mainAccount: ACC }).filter(i => i.kind === 'entre');
    expect(items.map(i => i.amountCents)).toEqual([-200000]);
  });

  it('a new version replaces the old one', () => {
    const state = rebuildNsState([...lines, ev('intercompany.plan.set', plan, 'ic-irma'), ev('intercompany.plan.set', { ...plan, from: '2030-03-01', openingCents: 0 }, 'ic-irma-2')]);
    expect(state.intercompany).toHaveLength(1);
    expect(state.intercompany[0].openingCents).toBe(0);
  });

  it('points out group lines with no plan', () => {
    const groupLines = [...BASE, line('np', '2030-01-10', -500000, 'TRF P/ NOISYPHOCUS', 1000000)];
    const before = rebuildNsState(groupLines);
    expect(unplannedGroupLines(before, reconcile(before, { accountId: ACC }))).toEqual({ count: 1, outCents: 500000, inCents: 0 });
    const after = rebuildNsState([...groupLines, ev('intercompany.plan.set', { ...plan, matchWords: ['Noisy Phocus'] }, 'ic-np')]);
    expect(unplannedGroupLines(after, reconcile(after, { accountId: ACC })).count).toBe(0);
  });
});

describe('confirming a blueprint', () => {
  const costEv = ev('cost.plan.set', { ...COST, toConfirm: true }, 'cost-telefone');
  const events = [...BASE, costEv];
  const find = (e: NsEvent[], id: string) => blueprints(rebuildNsState(e), { today: TODAY }).find(b => b.id === id)!;
  const conf = (eventIds: string[], id = 'conf-1') => ev('plan.blueprint.confirmed', { blueprintId: 'custo:telefone', eventIds }, id, { effectiveDate: TODAY });

  it('starts unconfirmed, and clears the placeholder once confirmed', () => {
    const before = find(events, 'custo:telefone');
    expect(before.confirmed).toBe(false);
    expect(before.placeholders).toEqual(['valores']);
    const after = find([...events, conf(['cost-telefone'])], 'custo:telefone');
    expect(after.confirmed).toBe(true);
    expect(after.confirmEventId).toBe('conf-1');
    expect(after.placeholders).toEqual([]);
    const item = plannedItems(rebuildNsState([...events, conf(['cost-telefone'])]), { from: TODAY, to: '2030-04-30', mainAccount: ACC }).find(i => i.costKey === 'telefone')!;
    expect(item.toConfirm).toBe(false);
  });

  it('a later version goes back to "por confirmar"', () => {
    const newer = ev('cost.plan.set', { ...COST, amountCents: 6000, from: '2030-04-01' }, 'cost-telefone-2');
    expect(find([...events, conf(['cost-telefone']), newer], 'custo:telefone').confirmed).toBe(false);
  });

  it('undoing the confirmation brings the placeholder back', () => {
    const undone = [...events, conf(['cost-telefone'], 'conf-9'), ev('reversal', {}, 'rev-conf-9', { reverses: 'conf-9' })];
    const b = find(undone, 'custo:telefone');
    expect(b.confirmed).toBe(false);
    expect(b.placeholders).toEqual(['valores']);
  });

  it('a finished contract, a paid-off loan or an ended cost no longer needs confirming', () => {
    const loan = { principalCents: 100000, capitalPerMonthCents: 100000, annualRatePct: 3, firstPaymentMonth: '2029-01', stampDutyPct: 4 };
    const list = blueprints(rebuildNsState([
      ...BASE,
      ev('cost.plan.set', { ...COST, key: 'pago', description: 'Empréstimo pago', loan, amountCents: 0 }, 'cost-pago'),
      ev('cost.plan.set', { ...COST, key: 'fim', description: 'Acabou', to: '2030-02-01' }, 'cost-fim'),
    ]), { today: '2031-06-01' });
    expect(list.find(b => b.id === 'custo:pago')).toMatchObject({ group: 'creditos', active: false });
    expect(list.find(b => b.id === 'custo:fim')!.active).toBe(false);
    expect(list.find(b => b.id === 'ec:C-100')!.active).toBe(false);
  });

  it('a person only rests on the terms in force and those ahead', () => {
    const list = blueprints(rebuildNsState([
      ...BASE,
      ev('employment.terms.set', terms({ from: '2030-02-01', grossMonthlyCents: 110000 }), 'emp-ana-2'),
      ev('employment.terms.set', terms({ from: '2030-06-01', grossMonthlyCents: 120000 }), 'emp-ana-3'),
    ]), { today: TODAY });
    expect(list.find(b => b.id === 'pessoa:ana')!.eventIds).toEqual(['emp-ana-2', 'emp-ana-3']);
  });
});

describe('the loan', () => {
  it('counts interest on the actual days when the bank does', () => {
    const loan = { principalCents: 1200000, capitalPerMonthCents: 100000, annualRatePct: 3, firstPaymentMonth: '2030-01', stampDutyPct: 4, dayCount: 'dias-reais' as const };
    const march = loanInstalment(loan, 20, '2030-03')!; // 20 Feb → 20 Mar: 28 days, on 10 000 €
    expect(march.balanceCents).toBe(1000000);
    expect(march.days).toBe(28);
    expect(march.interestCents).toBe(Math.round((1000000 * 3 * 28) / 100 / 360));
    expect(march.stampCents).toBe(Math.round((march.interestCents * 4) / 100));
    expect(loanInstalment({ ...loan, dayCount: undefined }, 20, '2030-03')!.interestCents).toBe(2500);
    expect(loanInstalment(loan, 20, '2029-12')).toBeNull();
    expect(loanInstalment(loan, 20, '2031-01')).toBeNull();
  });
});

describe('the year', () => {
  const loan = { principalCents: 1200000, capitalPerMonthCents: 100000, annualRatePct: 3, firstPaymentMonth: '2030-01', stampDutyPct: 4 };
  const events = [
    ...BASE,
    ev('cost.plan.set', COST, 'cost-telefone'),
    ev('cost.plan.set', { ...COST, key: 'banco', description: 'Empréstimo', amountCents: 0, day: 20, loan }, 'cost-banco'),
  ];
  const grid = yearGrid(rebuildNsState(events), { accountId: ACC, today: TODAY })!;

  it('runs to the end of next year', () => {
    expect(grid.months[0].month).toBe('2030-03');
    expect(grid.months[grid.months.length - 1].month).toBe('2031-12');
  });

  it('its month-ends add up: the last real balance plus every item', () => {
    let bal = grid.start.balanceCents;
    for (const m of grid.months) {
      bal += m.inCents + m.outCents;
      expect(m.endCents).toBe(bal);
      const fromRows = grid.rows.flatMap(r => r.items[m.month] ?? []).reduce((s, i) => s + i.amountCents, 0);
      expect(fromRows).toBe(m.inCents + m.outCents);
    }
  });

  it('one row per blueprint: a person sums salary, meal card and vouchers', () => {
    const ana = grid.rows.find(r => r.key === 'pessoa:ana')!;
    expect(new Set(Object.values(ana.items).flat().map(i => i.kind))).toEqual(new Set(['salario', 'refeicao', 'vales']));
    expect(ana.blueprint?.id).toBe('pessoa:ana');
    expect(grid.rows.find(r => r.key === 'ss')!.blueprint).toBeNull();
  });

  it('the groups read in order: income, people, credits, expenses', () => {
    const order = grid.rows.map(r => r.group);
    expect(order.indexOf('receitas')).toBeLessThan(order.indexOf('pessoas'));
    expect(order.indexOf('pessoas')).toBeLessThan(order.indexOf('creditos'));
    expect(order.indexOf('creditos')).toBeLessThan(order.indexOf('despesas'));
  });

  it('files an item under the month the money moves', () => {
    const row = grid.rows.find(r => r.key === 'ec:C-100')!;
    for (const [cash, items] of Object.entries(row.items)) for (const i of items) expect(i.date.slice(0, 7)).toBe(cash);
  });
});
