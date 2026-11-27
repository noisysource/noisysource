// The calendar's balance after each movement, and the plans Atlas proposes. Run: pnpm --filter finhub test
const assert = require('node:assert/strict');
const { withBalance, calendarPlanOf, financialCalendar } = require('../node_modules/.tmp/test/financialCalendar.cjs');

// Balance: from what the accounts hold, each movement in date order; days off carry none.
const items = [
  { key: 'a', kind: 'day_off', date: '2026-12-01', title: 'Day off', plan: true },
  { key: 'b', kind: 'payment_in', date: '2026-12-11', title: 'Malt pays', amount: 11290.56, plan: false },
  { key: 'c', kind: 'payslip', date: '2026-12-20', title: 'Salary', amount: -3000.1, plan: false },
];
assert.deepEqual(withBalance(items, 1000).map((i) => i.balance), [undefined, 12290.56, 9290.46]);

// Each money date says whose money it is.
const cal = financialCalendar({ from: '2026-12-01', to: '2026-12-31', today: '2026-12-01', subscriptions: [{ id: 's', entityId: 'hh', name: 'Netflix', amount: 12, frequency: 'monthly', billingDay: 5, billingMonth: 1 }], loans: [{ id: 'l', entityId: 'hh', name: 'Mortgage', monthlyPayment: 900, dueDay: 8, maturityDate: '2040-01-01' }] });
assert.deepEqual(cal.map((i) => [i.title, i.entityId]), [['Netflix', 'hh'], ['Mortgage', 'hh']]);

// Days off: the weekdays of the span, a day already off kept; trips paid by the company named.
const entities = [{ id: 'ns', name: 'Noisy Source' }, { id: 'hh', name: 'Household' }];
const had = [{ id: 'x', userId: 'b', date: '2026-12-24', kind: 'client_closure', label: 'Christmas', source: 'manual' }];
let p = calendarPlanOf(
  {
    daysOff: [{ from: '2026-12-22', to: '2027-01-02', kind: 'vacation', label: 'Christmas holidays' }],
    trips: [{ title: 'Brussels', destination: 'BE', startDate: '2026-12-09', endDate: '2026-12-11', traveller: 'Renato Lopes', entityHint: 'noisysource', perDiemDaily: 0, perDiemDays: 0 }],
  },
  { entities, daysOff: had, trips: [] },
);
assert.deepEqual(p.daysOff.map((d) => d.date), ['2026-12-22', '2026-12-23', '2026-12-25', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01']);
assert.equal(p.trips[0].entityId, 'ns');
assert.equal(p.trips[0].status, 'planned');
assert.deepEqual(p.lines, ['Christmas holidays 2026-12-22 to 2027-01-02: 8 weekdays off (1 already off)', 'Trip Brussels (BE) 2026-12-09 to 2026-12-11, paid by Noisy Source']);
assert.deepEqual(p.problems, []);

// An unknown company, a bad range, a trip already planned.
p = calendarPlanOf(
  { daysOff: [{ from: '2026-12-10', to: '2026-12-01', kind: 'day_off', label: '' }], trips: [{ title: 'Lisbon', destination: '', startDate: '2026-12-01', endDate: '2026-12-02', traveller: '', entityHint: 'Acme', perDiemDaily: 0, perDiemDays: 0 }, { title: 'Brussels', destination: '', startDate: '2026-12-09', endDate: '2026-12-11', traveller: '', entityHint: 'Noisy Source', perDiemDaily: 0, perDiemDays: 0 }] },
  { entities, daysOff: [], trips: [{ id: 't', userId: 'b', entityId: 'ns', title: 'Brussels', destination: 'BE', startDate: '2026-12-09', endDate: '2026-12-11', traveller: '', status: 'planned', perDiemDaily: 0, perDiemDays: 0, costs: [], notes: '' }] },
);
assert.deepEqual([p.daysOff, p.trips], [[], []]);
assert.equal(p.problems.length, 2);
assert.match(p.problems[1], /which company pays/);
assert.deepEqual(p.lines, ['Trip Brussels 2026-12-09: already planned']);

console.log('ok  calendar: the balance after each movement, and the plans Atlas proposes');
