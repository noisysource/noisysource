// FinHub's financial calendar. Run: pnpm --filter finhub test
const assert = require('node:assert/strict');
const { financialCalendar, dayOffSpans, perDiemOf } = require('../node_modules/.tmp/test/financialCalendar.cjs');

const off = (date, kind = 'vacation', label = 'Summer') => ({ id: date, userId: 'b', date, kind, label, source: 'manual' });

// A week of vacation across a weekend is one span; a closure is its own.
const spans = dayOffSpans([off('2026-08-06'), off('2026-08-07'), off('2026-08-10'), off('2026-08-11'), off('2026-12-24', 'client_closure', 'Christmas')]);
assert.deepEqual(spans.map((s) => [s.date, s.endDate, s.title]), [['2026-08-06', '2026-08-11', 'Vacation: Summer'], ['2026-12-24', '2026-12-24', 'Client closure: Christmas']]);
assert.equal(spans[0].key, 'dayoff:2026-08-06:vacation');

const trip = { id: 't1', userId: 'b', entityId: 'ns', title: 'Brussels', destination: 'BE', startDate: '2026-09-14', endDate: '2026-09-17', traveller: 'Renato Lopes', status: 'booked', perDiemDaily: 175.42, perDiemDays: 4, costs: [], notes: '' };
assert.equal(perDiemOf(trip), 701.68);

const contract = { id: 'malt', userId: 'b', entityId: 'ns', clientName: 'Malt', reference: '', startDate: '2026-01-01', endDate: '2027-12-31', daysAllowed: 60, dailyRate: 500, vatRate: 23, paymentTermsDays: 10, warnMonths: 3, amendments: [], active: true, notes: '' };
const handovers = [{ id: 'h1', userId: 'b', contractId: 'malt', month: '2026-08', days: 15, dailyRate: 500, amount: 7500, handedOverAt: '2026-09-01', expectedPayDate: '2026-09-11', invoiceNumber: '' }];
const items = financialCalendar({
  from: '2026-09-01', to: '2026-10-31', today: '2026-09-01',
  daysOff: [], trips: [trip], contracts: [contract], handovers,
  payslips: [{ id: 'p9', employeeName: 'Renato Lopes', payDate: '2026-09-30', taxDueDate: '2026-10-20', netPay: 1500, employeeWithholdings: 400, employerTaxes: 475 }],
  subscriptions: [{ id: 'meo', name: 'MEO', amount: 126.08, frequency: 'monthly', billingDay: 31, billingMonth: 1, status: 'active' }],
  loans: [{ id: 'l1', name: 'Mortgage 165-003', monthlyPayment: 439.34, dueDay: 1, maturityDate: '2054-04-01', status: 'active' }],
});
const at = (key) => items.find((i) => i.key === key);
assert.equal(at('trip:t1').endDate, '2026-09-17');
assert.equal(at('trip:t1').plan, true);
assert.deepEqual([at('perdiem:t1').date, at('perdiem:t1').amount], ['2026-09-30', -701.68]);
assert.deepEqual([at('payin:h1').date, at('payin:h1').amount], ['2026-09-11', 7500]);
// September not handed over yet: projected, handed over 1 October, paid 10 days later.
assert.equal(at('payin:malt:2026-09').date, '2026-10-11');
assert.equal(at('payin:malt:2026-09').projected, true);
assert.equal(at('tax:p9').amount, -875);
// The 31st in September is the 30th.
assert.equal(at('sub:meo:2026-09').date, '2026-09-30');
assert.equal(at('loan:l1:2026-10').date, '2026-10-01');
// Only plans go to his Google Calendar.
assert.deepEqual(items.filter((i) => i.plan).map((i) => i.kind), ['trip']);
console.log('ok  financial calendar: days off as spans, trips and per diem, client payments, payslips, taxes, subscriptions, loans');
