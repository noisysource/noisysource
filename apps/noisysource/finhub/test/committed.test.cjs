// What he committed from an Atlas import, for Atlas to learn from. Run: pnpm --filter finhub test
const assert = require('node:assert/strict');
const { committedOf } = require('../node_modules/.tmp/test/committed.cjs');

const line = (over) => ({ date: '2026-03-05', description: 'TRF CR SEPA+ 375 S ALIM OUT 2', amount: 183.6, direction: 'debit', includeTx: true, vendor: 'S ALIM', category: 'Software & Subscriptions', type: 'expense', ivaRate: 23, ivaDeductible: false, ...over });
const got = committedOf({
  contracts: [{ selected: true, workerName: 'Renato Lopes', baseGrossMonthly: 2000 }],
  subscriptions: [
    { selected: true, name: 'Telecom', vendor: 'MEO', amount: 126.08 },
    { selected: false, name: 'Transfer to Marisa CGD', vendor: 'Marisa CGD', amount: 1005.22 },
  ],
  facilities: [],
  payslips: [{ selected: true, employeeName: 'Renato Lopes', periodStart: '2026-03-01', grossPay: 2000, netPay: 1500, notes: 'x' }],
  statements: [
    { selected: true, filename: 'march.pdf', lines: [line({ vendor: 'Edenred', category: 'Payroll', type: 'payroll', ivaRate: 0 }), line({ includeTx: false })] },
    { selected: false, filename: 'skipped.pdf', lines: [line({})] },
  ],
});
// Unticked items aren't there: that's how Atlas knows he removed them.
assert.deepEqual(got.subscriptions, [{ name: 'Telecom', vendor: 'MEO', amount: 126.08 }]);
assert.deepEqual(got.contracts, [{ workerName: 'Renato Lopes', baseGrossMonthly: 2000 }]);
assert.deepEqual(got.payslips, [{ employeeName: 'Renato Lopes', periodStart: '2026-03-01', grossPay: 2000, netPay: 1500 }]);
assert.equal(got.statements.length, 1);
// His edits to a line are kept, and a line he unticked says so.
assert.deepEqual(got.statements[0].lines.map((l) => [l.vendor, l.type, l.included]), [['Edenred', 'payroll', true], ['S ALIM', 'expense', false]]);
console.log('ok  committed: the items he kept, with his edits; unticked ones left out, unticked lines marked');
