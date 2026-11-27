// Client contracts: the Malt-style pot of days and its projection. Run: pnpm --filter finhub test
const assert = require('node:assert/strict');
const { projectContract, rateAt, daysAllowedOf, endDateOf, handoverOf } = require('../node_modules/.tmp/test/clientContracts.cjs');

const contract = (over = {}) => ({
  id: 'malt', userId: 'b', entityId: 'ns', clientName: 'Malt', reference: '', startDate: '2026-01-01', endDate: '2027-12-31',
  daysAllowed: 60, dailyRate: 500, vatRate: 23, paymentTermsDays: 10, warnMonths: 3, amendments: [], active: true, notes: '', ...over,
});
const off = (date, kind = 'vacation') => ({ id: date, userId: 'b', date, kind, label: '', source: 'manual' });
const handover = (month, days) => ({ id: month, userId: 'b', contractId: 'malt', month, days, dailyRate: 500, amount: days * 500, handedOverAt: '', expectedPayDate: '', invoiceNumber: '' });

// 60 days, Jan + Feb handed over (20 + 20): 20 left from 1 March 2026, a Sunday.
const base = projectContract(contract(), [handover('2026-01', 20), handover('2026-02', 20)], [], '2026-03-01');
assert.equal(base.remaining, 20);
assert.equal(base.projectedEnd, '2026-03-27', 'twenty weekdays from Mon 2 March');
assert.equal(base.toInvoice, 10000);
assert.equal(base.endsBy, 'days');

// A week of vacation in March, and a Commission closure day, push the end out by six weekdays.
const away = ['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13'].map((d) => off(d));
const later = projectContract(contract(), [handover('2026-01', 20), handover('2026-02', 20)], [...away, off('2026-03-20', 'client_closure')], '2026-03-01');
assert.equal(later.projectedEnd, '2026-04-06');
const march = later.months.find((m) => m.month === '2026-03');
assert.deepEqual([march.workingDays, march.daysOff, march.plannedDays], [16, 6, 16]);

// Near the end: time to renegotiate.
assert.equal(base.warn, true);
assert.equal(projectContract(contract({ daysAllowed: 600 }), [], [], '2026-01-01').warn, false);

// The period ends first: days left unused.
const short = projectContract(contract({ endDate: '2026-01-09' }), [], [], '2026-01-01');
assert.deepEqual([short.endsBy, short.projectedEnd, short.unusedAtEnd], ['period', null, 53]);

// A renegotiation: a new rate from June, 40 more days, a later end.
const renewed = contract({ amendments: [{ from: '2026-06', dailyRate: 550, addDays: 40, newEndDate: '2028-06-30', note: 'extension' }] });
assert.equal(rateAt(renewed, '2026-05'), 500);
assert.equal(rateAt(renewed, '2026-07'), 550);
assert.equal(daysAllowedOf(renewed), 100);
assert.equal(endDateOf(renewed), '2028-06-30');

// A handover: days × the month's rate, paid ten days later.
assert.deepEqual(handoverOf(renewed, '2026-07', 18.5, '2026-08-03'), { dailyRate: 550, amount: 10175, expectedPayDate: '2026-08-13' });
console.log('ok  client contracts: days left, the end date the calendar gives, renegotiations, handovers');
