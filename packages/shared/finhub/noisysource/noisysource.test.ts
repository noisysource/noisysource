import { describe, expect, it } from 'vitest';
import { computeEcProjection } from '../../lib/ecProjection';
import { eachDay } from '../dates';
import { liveEvents, reversalId } from '../envelope';
import { contractGaps, ecRunway } from './ec';
import { nsIds, parseNsEvent, type NsEvent } from './events';
import { comparePayslip, estimatePayslip } from './payslip';
import { plannedItems } from './plan';
import { rebuildNsState, ruleAt, termsAt } from './state';
import { CLIENT_HOLIDAYS_2030, CONTRACT, ev, terms } from './testkit';
import { lastRealBalance, pastMonthChecks, projectTreasury, realBalanceAt } from './treasury';

const signed = (over: Partial<typeof CONTRACT> & Record<string, unknown> = {}) =>
  ev('ec.contract.signed', { ...CONTRACT, ...over } as never, nsIds.ecContract(String(over.number ?? CONTRACT.number)));

describe('events', () => {
  it('validates envelope and payload, never throwing', () => {
    const good = ev('holidays.set', { calendarId: 'x', year: 2030, dates: ['2030-01-01'] });
    expect(parseNsEvent(good).ok).toBe(true);
    const bad = parseNsEvent({ ...good, payload: { calendarId: 'x', year: 2030, dates: ['2030-02-30'] } });
    expect(bad.ok).toBe(false);
    expect(parseNsEvent({ ...good, company: 'casa' }).ok).toBe(false);
    expect(parseNsEvent({ ...good, type: 'nope' }).ok).toBe(false);
  });

  it('drops reversed events and the reversals themselves', () => {
    const a = ev('holidays.set', { calendarId: 'x', year: 2030, dates: [] }, 'a');
    const b = ev('holidays.set', { calendarId: 'y', year: 2030, dates: [] }, 'b');
    const r = ev('reversal', {}, reversalId('a'), { reverses: 'a' });
    expect(liveEvents([a, b, r]).map(e => e.id)).toEqual(['b']);
  });

  it('builds deterministic ids', () => {
    expect(nsIds.ecContract('C 100')).toBe('ec-c-100');
    expect(nsIds.payslip('ana', '2030-07')).toBe('ps-ana-2030-07');
    expect(nsIds.rule('ss', '2030-01-01')).toBe('rule-ss-2030-01-01');
  });
});

describe('state', () => {
  it('versions plans by date; the latest version on or before a day wins', () => {
    const s = rebuildNsState([
      ev('employment.terms.set', terms()),
      ev('employment.terms.set', terms({ from: '2030-02-01', ssErPct: 0, ssErNote: 'isenção' })),
      ev('employment.terms.set', terms({ from: '2030-07-01' })),
      ev('employment.ended', { personId: 'ana', lastDay: '2030-12-31' }),
      ev('payment.rule.set', { what: 'ss', label: 'SS', from: '2030-01-01', day: 20, monthOffset: 1, nonBusinessDay: 'after' }),
      ev('payment.rule.set', { what: 'ss', label: 'SS', from: '2030-06-01', day: 15, monthOffset: 1, nonBusinessDay: 'after' }),
    ]);
    expect(termsAt(s, 'ana', '2030-01-15')!.ssErPct).toBe(23.75);
    expect(termsAt(s, 'ana', '2030-03-01')!.ssErPct).toBe(0);
    expect(termsAt(s, 'ana', '2030-07-01')!.ssErPct).toBe(23.75);
    expect(termsAt(s, 'ana', '2031-01-01')).toBeNull();
    expect(ruleAt(s, 'ss', '2030-05-31')!.day).toBe(20);
    expect(ruleAt(s, 'ss', '2030-06-01')!.day).toBe(15);
    expect(s.people).toEqual([{ id: 'ana', name: 'Ana Teste' }]);
  });
});

describe('EC runway', () => {
  const base: NsEvent[] = [CLIENT_HOLIDAYS_2030];

  it('walks the client calendar to the last day, like computeEcProjection', () => {
    const s = rebuildNsState([...base, signed()]);
    const r = ecRunway(s, s.contracts[0], '2030-01-10');
    // Feb: 20 weekdays − 14 Feb (client) = 19; March needs 11 → 15 March.
    expect(r.lastDay).toBe('2030-03-15');
    const old = computeEcProjection(
      { startDate: CONTRACT.startDate, dailyRateCents: CONTRACT.dailyRateCents, totalDays: CONTRACT.totalDays },
      ['2030-01-01', '2030-02-14'], new Date(2030, 0, 10),
    );
    expect(r.lastDay).toBe(old.contractEndDate);
    expect(r.months.map(m => [m.month, m.days])).toEqual([['2030-02', 19], ['2030-03', 11]]);
    expect(r.months[0].amountCents).toBe(19 * 40000);
    expect(r.warningDate).toBe('2029-12-15');
    expect(r.warningActive).toBe(true);
  });

  it('splits used and planned at today', () => {
    const s = rebuildNsState([...base, signed()]);
    const r = ecRunway(s, s.contracts[0], '2030-02-15');
    expect(r.usedDays).toBe(9); // 1, 4–8, 11–13 Feb (14 is a client holiday)
    expect(r.plannedDays).toBe(21);
    expect(r.leftDays).toBe(21);
  });

  it('starts from an opening position', () => {
    const s = rebuildNsState([...base, signed({
      number: 'C-099', startDate: '2029-11-01', totalDays: 40, opening: { asOf: '2029-12-31', daysUsed: 30 },
    })]);
    const r = ecRunway(s, s.contracts[0], '2030-01-01');
    expect(r.lastDay).toBe('2030-01-15'); // 1 Jan is a client holiday; 2–4, 7–11, 14, 15
    expect(r.openingDays).toBe(30);
  });

  it('a timesheet replaces the planned days of its month', () => {
    const s = rebuildNsState([...base, signed(),
      ev('ec.timesheet.submitted', { contractNumber: 'C-100', month: '2030-02', days: 17 })]);
    const r = ecRunway(s, s.contracts[0], '2030-03-01');
    expect(r.months[0]).toMatchObject({ month: '2030-02', days: 17, source: 'folha' });
    expect(r.lastDay).toBe('2030-03-19');
  });

  it("the person's days off push the last day; trips don't", () => {
    const s = rebuildNsState([...base, signed(),
      ev('calendar.entry.set', { personId: 'ana', kind: 'ferias', dates: ['2030-02-20'], halfDays: [] }),
      ev('calendar.entry.set', { personId: 'ana', kind: 'viagem', dates: ['2030-02-21'], halfDays: [] })]);
    expect(ecRunway(s, s.contracts[0], '2030-01-01').lastDay).toBe('2030-03-18');
  });

  it('an early end cuts the contract and shows the unused days', () => {
    const s = rebuildNsState([...base, signed(), ev('ec.contract.ended', { number: 'C-100', lastDay: '2030-03-08' })]);
    const r = ecRunway(s, s.contracts[0], '2030-01-01');
    expect(r.lastDay).toBe('2030-03-08');
    expect(r.endedEarly).toBe(true);
    expect(r.unusedDays).toBe(30 - 19 - 6);
  });

  it('shows the gap between consecutive contracts of a client', () => {
    const s = rebuildNsState([...base, signed(), signed({ number: 'C-101', startDate: '2030-03-25', totalDays: 10 })]);
    const runways = s.contracts.map(c => ecRunway(s, c, '2030-01-01'));
    expect(contractGaps(s, runways)).toEqual([
      { client: 'Plataforma X', after: 'C-100', before: 'C-101', workingDays: 5, from: '2030-03-16', to: '2030-03-24' },
    ]);
    const s2 = rebuildNsState([...base, signed(), signed({ number: 'C-101', startDate: '2030-03-18', totalDays: 10 })]);
    expect(contractGaps(s2, s2.contracts.map(c => ecRunway(s2, c, '2030-01-01')))[0].workingDays).toBe(0);
  });
});

describe('payslip estimate', () => {
  const july = [
    ev('employment.terms.set', terms()),
    ev('calendar.entry.set', { personId: 'ana', kind: 'ferias', dates: ['2030-07-01', '2030-07-02'], halfDays: [] }),
    ev('calendar.entry.set', { personId: 'ana', kind: 'viagem', dates: ['2030-07-10', '2030-07-11', '2030-07-12'], halfDays: [] }),
  ];

  it('takes meal days and per diems from the calendar', () => {
    const e = estimatePayslip(rebuildNsState(july), 'ana', '2030-07')!;
    expect(e.meal.days).toBe(22 - 2 - 3);
    expect(e.mealCents).toBe(17 * 800);
    expect(e.perDiemCents).toBe(3 * 5000);
    expect(e.grossCents).toBe(100000);
    expect(e.irsBaseCents).toBe(105000); // education voucher is in the IRS base
    expect(e.irsCents).toBe(10500);
    expect(e.ssEmpCents).toBe(11000);
    expect(e.ssErCents).toBe(23750);
    expect(e.netCents).toBe(100000 - 10500 - 11000 + 15000);
    expect(e.cardTopUps).toEqual({ refeicao: 13600, vales: 15000 });
    expect(e.explain[0]).toBe('22 dias úteis − 2 férias − 3 viagem = 17 dias de refeição');
  });

  it('rounds IRS withheld to the euro', () => {
    const e = estimatePayslip(rebuildNsState([ev('employment.terms.set', terms({ grossMonthlyCents: 120000, irsRatePct: 1.58, benefits: [] }))]), 'ana', '2030-03')!;
    expect(e.irsCents).toBe(1900); // 18.96 → 19.00
  });

  it('adds the subsidies in their month', () => {
    const s = rebuildNsState([ev('employment.terms.set', terms({ benefits: [] }))]);
    expect(estimatePayslip(s, 'ana', '2030-06')!.grossCents).toBe(200000);
    expect(estimatePayslip(s, 'ana', '2030-11')!.lines.map(l => l.kind)).toContain('subsidio-natal');
  });

  it('deducts unpaid leave at base/30 per day; a whole month pays nothing', () => {
    const part = rebuildNsState([ev('employment.terms.set', terms()),
      ev('calendar.entry.set', { personId: 'ana', kind: 'licenca', dates: eachDay('2030-02-01', '2030-02-08'), halfDays: [] })]);
    const e = estimatePayslip(part, 'ana', '2030-02')!;
    expect(e.grossCents).toBe(100000 - 26667);
    expect(e.meal.days).toBe(14);
    const whole = rebuildNsState([ev('employment.terms.set', terms()),
      ev('calendar.entry.set', { personId: 'ana', kind: 'licenca', dates: eachDay('2030-01-01', '2030-01-31'), halfDays: [] })]);
    const w = estimatePayslip(whole, 'ana', '2030-01')!;
    expect([w.grossCents, w.netCents, w.cardTopUps.vales, w.cardTopUps.refeicao]).toEqual([0, 0, 0, 0]);
  });

  it('employer SS exemption is a terms version', () => {
    const s = rebuildNsState([ev('employment.terms.set', terms()), ev('employment.terms.set', terms({ from: '2030-02-01', ssErPct: 0 }))]);
    expect(estimatePayslip(s, 'ana', '2030-01')!.ssErCents).toBe(23750);
    expect(estimatePayslip(s, 'ana', '2030-02')!.ssErCents).toBe(0);
  });

  it('compares with the recorded payslip and names the cause', () => {
    const recorded = (mealDays: number) => ev('payroll.payslip.recorded', {
      personId: 'ana', month: '2030-07', grossCents: 100000, irsRatePct: 10, irsCents: 10500, ssEmpCents: 11000,
      ssErCents: 23750, ssErDerived: true, netCents: 93500,
      lines: [
        { code: '001', label: 'Vencimento base', kind: 'base', amountCents: 100000 },
        { code: '017', label: 'Ajudas de custo', kind: 'ajudas', amountCents: 15000 },
        { code: '993', label: 'Sub. refeição cartão', kind: 'refeicao', amountCents: mealDays * 800, quantity: mealDays, unitCents: 800, paidAs: 'cartao' },
        { code: '989', label: 'Vale infância', kind: 'beneficio', amountCents: 10000, paidAs: 'cartao' },
        { code: '661', label: 'Vale educação', kind: 'beneficio', amountCents: 5000, paidAs: 'cartao' },
      ],
    });
    const s = rebuildNsState([...july, recorded(17)]);
    const est = estimatePayslip(s, 'ana', '2030-07')!;
    expect(comparePayslip(est, s.payslips['ana|2030-07'])).toEqual({ equal: true, diffs: [] });

    const s2 = rebuildNsState([...july, recorded(19)]);
    const c = comparePayslip(est, s2.payslips['ana|2030-07']);
    expect(c.equal).toBe(false);
    expect(c.diffs.map(d => d.cause)).toEqual(['dias de refeição']);
  });
});

describe('expected movements', () => {
  const rules = [
    ev('payment.rule.set', { what: 'salarios', label: 'Salários', from: '2030-01-01', day: 25, monthOffset: 0, nonBusinessDay: 'before' }),
    ev('payment.rule.set', { what: 'refeicao', label: 'Refeição', from: '2030-01-01', day: 25, monthOffset: 0, nonBusinessDay: 'before', toConfirm: true }),
    ev('payment.rule.set', { what: 'vales', label: 'Vales', from: '2030-01-01', day: 25, monthOffset: 0, nonBusinessDay: 'before' }),
    ev('payment.rule.set', { what: 'ss', label: 'SS', from: '2030-01-01', day: 20, monthOffset: 1, nonBusinessDay: 'after' }),
    ev('payment.rule.set', { what: 'irs', label: 'IRS', from: '2030-01-01', day: 20, monthOffset: 1, nonBusinessDay: 'after' }),
    ev('payment.rule.set', { what: 'ec-fatura', label: 'Fatura', from: '2030-01-01', day: 31, monthOffset: 0, nonBusinessDay: 'before' }),
  ];
  const costs = [
    ev('cost.plan.set', { key: 'telefone', description: 'Telefone', amountCents: 5000, direction: 'saida', vatCode: 23, frequency: 'monthly', day: 9, from: '2030-01-01', account: 'acc-1' }),
    ev('cost.plan.set', { key: 'telefone', description: 'Telefone', amountCents: 6000, direction: 'saida', vatCode: 23, frequency: 'monthly', day: 9, from: '2030-05-01', to: '2030-06-30', account: 'acc-1' }),
    ev('cost.plan.set', { key: 'seguro', description: 'Seguro', amountCents: 30000, direction: 'saida', vatCode: 'isento', frequency: 'annual', months: [3], day: 2, from: '2030-01-01', account: 'acc-1', toConfirm: true }),
    ev('cost.plan.set', {
      key: 'emprestimo', description: 'Empréstimo', amountCents: 0, direction: 'saida', vatCode: 'isento', frequency: 'monthly', day: 20, from: '2030-01-01', account: 'acc-1',
      loan: { principalCents: 1200000, capitalPerMonthCents: 50000, annualRatePct: 6, firstPaymentMonth: '2030-01', stampDutyPct: 4 },
    }),
  ];
  const state = rebuildNsState([...rules, ...costs, CLIENT_HOLIDAYS_2030, signed(), ev('employment.terms.set', terms())]);
  const items = plannedItems(state, { from: '2030-01-01', to: '2030-12-31', mainAccount: 'acc-1' });
  const byId = (id: string) => items.find(i => i.id === id)!;

  it('pays salaries on the 25th, the business day before when it falls on a weekend', () => {
    expect(byId('salario:ana:2030-08').date).toBe('2030-08-23'); // 25 Aug 2030 is a Sunday
    expect(byId('salario:ana:2030-07').date).toBe('2030-07-25');
    expect(byId('refeicao:ana:2030-07').toConfirm).toBe(true);
    expect(byId('vales:ana:2030-07').amountCents).toBe(-15000);
  });

  it('pays SS and IRS for M on the 20th of M+1', () => {
    expect(byId('ss:all:2030-07')).toMatchObject({ date: '2030-08-20', amountCents: -(11000 + 23750) });
    expect(byId('irs:all:2030-07')).toMatchObject({ date: '2030-08-20', amountCents: -10500 });
  });

  it('cashes EC days × rate in at the invoice + days to payment, next business day', () => {
    // Feb invoice on 28 Feb + 10 days = Sunday 10 March → Monday 11 March.
    expect(byId('ec:C-100:2030-02')).toMatchObject({ date: '2030-03-11', amountCents: 19 * 40000, source: 'plano' });
    expect(byId('ec:C-100:2030-02').inputs).toContain('19 dias');
    expect(items.some(i => i.id === 'ec:C-100:2030-04')).toBe(false); // the contract ran out on 15 March
  });

  it('follows cost plan versions, annual months and loans', () => {
    expect(byId('custo:telefone:2030-04').amountCents).toBe(-5000);
    expect(byId('custo:telefone:2030-05').amountCents).toBe(-6000);
    expect(items.some(i => i.id === 'custo:telefone:2030-07')).toBe(false);
    expect(byId('custo:seguro:2030-03')).toMatchObject({ date: '2030-03-04', toConfirm: true }); // 2 Mar is a Saturday
    // March: balance 12,000 − 2 × 500 = 11,000; interest 6%/12 = 55.00; stamp 4% = 2.20.
    expect(byId('custo:emprestimo:2030-03').amountCents).toBe(-(50000 + 5500 + 220));
  });

  it('a recorded payslip replaces the estimate', () => {
    const s = rebuildNsState([...rules, ev('employment.terms.set', terms()), ev('payroll.payslip.recorded', {
      personId: 'ana', month: '2030-07', grossCents: 100000, irsCents: 10000, ssEmpCents: 11000, ssErCents: 0, netCents: 79000, lines: [],
    })]);
    const it7 = plannedItems(s, { from: '2030-07-01', to: '2030-08-31', mainAccount: 'acc-1' });
    expect(it7.find(i => i.id === 'salario:ana:2030-07')).toMatchObject({ amountCents: -79000, source: 'recibo' });
    expect(it7.find(i => i.id === 'refeicao:ana:2030-07')).toBeUndefined();
  });
});

describe('treasury', () => {
  const mv = (id: string, date: string, amountCents: number, balanceAfterCents: number, seq: number) =>
    ev('bank.movement.imported', { accountId: 'acc-1', date, valueDate: date, amountCents, description: 'x', balanceAfterCents, importId: 'imp-1', seq }, id);
  const events = [
    mv('m1', '2030-03-05', -5000, 95000, 0),
    mv('m2', '2030-03-09', -5000, 90000, 1),
    mv('m3', '2030-04-09', -5000, 85000, 0),
    ev('cost.plan.set', { key: 'telefone', description: 'Telefone', amountCents: 5000, direction: 'saida', vatCode: 23, frequency: 'monthly', day: 9, from: '2030-01-01', account: 'acc-1' }),
  ];
  const s = rebuildNsState(events);

  it('reads real balances from the bank lines', () => {
    expect(lastRealBalance(s, 'acc-1')).toEqual({ accountId: 'acc-1', date: '2030-04-09', balanceCents: 85000 });
    expect(realBalanceAt(s, 'acc-1', '2030-03-01')).toBe(100000); // opening
    expect(realBalanceAt(s, 'acc-1', '2030-03-31')).toBe(90000);
    expect(realBalanceAt(s, 'acc-1', '2030-02-28')).toBeNull();
  });

  it('projects the plan from the last real balance', () => {
    const p = projectTreasury(s, { accountId: 'acc-1', today: '2030-05-01', horizonDays: 45 })!;
    expect(p.days.map(d => [d.date, d.balanceCents])).toEqual([['2030-05-09', 80000], ['2030-06-11', 75000]]); // 9 Jun is a Sunday, 10 Jun a holiday
    expect(p.monthEnds.slice(0, 2)).toEqual([{ month: '2030-04', balanceCents: 85000 }, { month: '2030-05', balanceCents: 80000 }]);
    expect(p.lowest).toEqual({ date: '2030-06-11', balanceCents: 75000 });
  });

  it('compares planned and real month-end balances', () => {
    const [mar, apr] = pastMonthChecks(s, { accountId: 'acc-1', months: ['2030-03', '2030-04', '2030-05'] });
    expect(mar).toMatchObject({ openingCents: 100000, plannedEndCents: 95000, realEndCents: 90000, diffCents: -5000 });
    expect(mar.unhintedMovementIds).toEqual(['m1']);
    expect(apr).toMatchObject({ openingCents: 90000, plannedEndCents: 85000, realEndCents: 85000, diffCents: 0 });
    expect(apr.hints[0].movementId).toBe('m3');
  });
});
