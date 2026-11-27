// Days worked an agent proposed, merged with the handovers already there. Run: pnpm --filter finhub test
const assert = require('node:assert/strict');
const { daysWorkedPlan } = require('../node_modules/.tmp/test/clientContracts.cjs');

const c = { id: 'c30557', userId: 'b', entityId: 'ns', clientName: 'Malt', reference: '30557', startDate: '2026-03-25', endDate: '2027-01-26', daysAllowed: 189, dailyRate: 594.24, vatRate: 0, paymentTermsDays: 10, warnMonths: 3, amendments: [], active: true, notes: '' };
const oct = { id: 'h-oct', userId: 'b', contractId: 'c30557', month: '2026-10', days: 22, dailyRate: 594.24, amount: 13073.28, handedOverAt: '2026-11-01', expectedPayDate: '2026-11-11', invoiceNumber: 'F-9' };
const nov = { id: 'h-nov', userId: 'b', contractId: 'c30557', month: '2026-11', days: 10, dailyRate: 594.24, amount: 5942.4, handedOverAt: '2026-12-01', expectedPayDate: '2026-12-11', invoiceNumber: '' };
const d = (month, days, mode = 'add', over = {}) => ({ contractId: 'c30557', reference: '30557', clientName: 'Malt', month, days, mode, ...over });

// "This week I worked 4 days": on top of November's 10, a new handover replaces the old one.
let p = daysWorkedPlan([c], [oct, nov], [d('2026-11', 4)]);
assert.deepEqual(p.replace, ['h-nov']);
assert.equal(p.create.length, 1);
assert.deepEqual(p.create[0], { contractId: 'c30557', month: '2026-11', days: 14, dailyRate: 594.24, amount: 8319.36, handedOverAt: '2026-12-01', expectedPayDate: '2026-12-11', invoiceNumber: '' });
assert.deepEqual(p.lines, ['Malt 30557 2026-11: 10 → 14 days']);

// A month with nothing yet: handed over on the 1st of the next, paid 10 days later.
p = daysWorkedPlan([c], [oct], [d('2026-12', 3), d('2026-12', 2)]);
assert.deepEqual(p.replace, []);
assert.equal(p.create[0].days, 5);
assert.equal(p.create[0].handedOverAt, '2027-01-01');
assert.equal(p.create[0].expectedPayDate, '2027-01-11');

// set: the month's total; the same total changes nothing; the invoice number stays.
p = daysWorkedPlan([c], [oct], [d('2026-10', 22, 'set')]);
assert.deepEqual([p.create, p.replace, p.lines], [[], [], []]);
p = daysWorkedPlan([c], [oct], [d('2026-10', 21, 'set')]);
assert.equal(p.create[0].invoiceNumber, 'F-9');
assert.equal(p.create[0].handedOverAt, '2026-11-01');

// Matched by reference when the id is unknown; too many days or no contract are problems.
p = daysWorkedPlan([c], [nov], [d('2026-11', 30, 'add', { contractId: 'gone' }), d('2026-09', 1, 'add', { contractId: 'x', reference: '999' })]);
assert.deepEqual(p.create, []);
assert.deepEqual(p.problems, ['Malt 999: no such contract in the book', 'Malt 30557 2026-11: 40 days is more than a month has']);

// Set to 0: the month's handover goes.
p = daysWorkedPlan([c], [nov], [d('2026-11', 0, 'set')]);
assert.deepEqual([p.create, p.replace], [[], ['h-nov']]);

console.log('ok  days worked: added to a month or setting it, matched to the contract, merged with the handover there');
