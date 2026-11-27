// Handovers pasted from Malt's invoice list. Run: pnpm --filter finhub test
const assert = require('node:assert/strict');
const { parseHandovers } = require('../node_modules/.tmp/test/clientContracts.cjs');

const contract = (over) => ({ id: 'c', userId: 'b', entityId: 'ns', clientName: 'Malt', reference: '', startDate: '2024-08-27', endDate: '2025-05-31', daysAllowed: 162, dailyRate: 568.58, vatRate: 0, paymentTermsDays: 10, warnMonths: 3, amendments: [], active: false, notes: '', ...over });

// Copied from Malt's Invoice tab (order 017436), as the browser pastes it.
const paste017436 = `Invoice for	Status	Amount billed	Invoices
August
4 days
paid
€2,274.32
Download
September
21 days
paid
€11,940.18
Download
October 21 days paid €11,940.18 Download
November
20 days
paid
€11,371.60
December
15 days
paid
€8,528.70
January
21 days
paid
€11,940.18
February
20 days
paid
€11,371.60
March
21 days
paid
€11,940.18
April
7 days
paid
€3,980.06`;
const rows = parseHandovers(contract(), paste017436);
assert.deepEqual(rows.map((r) => [r.month, r.days, r.amount]), [
  ['2024-08', 4, 2274.32], ['2024-09', 21, 11940.18], ['2024-10', 21, 11940.18], ['2024-11', 20, 11371.6], ['2024-12', 15, 8528.7],
  ['2025-01', 21, 11940.18], ['2025-02', 20, 11371.6], ['2025-03', 21, 11940.18], ['2025-04', 7, 3980.06],
]);
assert.equal(rows.reduce((n, r) => n + r.days, 0), 150);
assert.deepEqual([rows[4].handedOverAt, rows[4].expectedPayDate], ['2025-01-01', '2025-01-11']);
assert.ok(rows.every((r) => !r.rateDiffers), 'every month billed at the contract rate');

// 30557 starts on 26 March 2026; without amounts, days × rate.
const r30557 = parseHandovers(contract({ startDate: '2026-03-26', endDate: '2027-01-26', daysAllowed: 189, dailyRate: 594.24 }), 'March 4 days April 19 days May 17 days');
assert.deepEqual(r30557.map((r) => [r.month, r.days, r.amount]), [['2026-03', 4, 2376.96], ['2026-04', 19, 11290.56], ['2026-05', 17, 10102.08]]);

// A billed amount that isn't days × rate is flagged.
assert.equal(parseHandovers(contract(), 'September 21 days paid €12,000.00')[0].rateDiffers, true);
console.log('ok  pasted handovers: months, days and amounts from Malt\'s invoice list, years from the contract');
