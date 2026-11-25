// Contract versions: the terms in force each month, and payroll from them.
// Run: pnpm --filter finhub test
const assert = require('node:assert/strict');
const v = require('../node_modules/.tmp/test/contractVersions.cjs');
const m = require('../node_modules/.tmp/test/financeMath.cjs');

const terms = {
  paySchedule: '12_months', baseGrossMonthly: 950, irsRate: 16.1, employeeSsRate: 11, employerSsRate: 23.75,
  mealAllowanceDaily: 0, mealPaymentMethod: 'none', childVoucherMonthly: 312.5,
  childVoucherSubjectToIrs: false, childVoucherSubjectToSs: false,
  otherBenefitName: '', otherBenefitMonthly: 0, otherBenefitSubjectToIrs: false, otherBenefitSubjectToSs: false,
};
const contract = { id: 'c', userId: 'b', entityId: 'e', fundingAccountId: '', workerName: 'Marisa', roleTitle: 'Adm', isOwnerIncome: false, personalEntityId: '', active: true, ...terms };
let n = 0;
const it = (name, fn) => { fn(); n++; console.log(`ok  ${name}`); };

it('no versions: the same terms every month, as before', () => {
  assert.equal(v.termsAt(contract, '2026-01').baseGrossMonthly, 950);
  assert.equal(m.computeContractMonthlyBreakdown(contract, '2026-03').baseSalary, 950);
});

it('a raise from June leaves January to May as they were', () => {
  const c = { ...contract, ...v.addVersion(contract, { effectiveFrom: '2026-06', note: 'raise', terms: { ...terms, baseGrossMonthly: 1000 } }, '2026-01') };
  assert.equal(c.versions.length, 2);
  assert.equal(c.baseGrossMonthly, 1000, 'top-level mirrors the latest');
  assert.equal(m.computeContractMonthlyBreakdown(c, '2026-05').baseSalary, 950);
  assert.equal(m.computeContractMonthlyBreakdown(c, '2026-06').baseSalary, 1000);
  assert.equal(m.computeContractMonthlyBreakdown(c, '2026-12').baseSalary, 1000);
});

it('before its first version a contract pays nothing', () => {
  const c = { ...contract, versions: [{ effectiveFrom: '2026-03', note: '', terms }] };
  assert.equal(m.computeContractMonthlyBreakdown(c, '2026-02').totalEmployerCost, 0);
  assert.ok(m.computeContractMonthlyBreakdown(c, '2026-03').totalEmployerCost > 0);
});

it('a change in the same month replaces that month\'s version', () => {
  const once = { ...contract, ...v.addVersion(contract, { effectiveFrom: '2026-06', note: 'a', terms: { ...terms, irsRate: 10 } }, '2026-01') };
  const twice = { ...once, ...v.addVersion(once, { effectiveFrom: '2026-06', note: 'b', terms: { ...terms, irsRate: 12 } }, '2026-01') };
  assert.equal(twice.versions.length, 2);
  assert.equal(v.termsAt(twice, '2026-07').irsRate, 12);
});

it('removing a version puts the one before it back on top; the last one stays', () => {
  const c = { ...contract, ...v.addVersion(contract, { effectiveFrom: '2026-06', note: '', terms: { ...terms, baseGrossMonthly: 1000 } }, '2026-01') };
  const back = v.removeVersion(c, '2026-06');
  assert.equal(back.versions.length, 1);
  assert.equal(back.baseGrossMonthly, 950);
  assert.equal(v.removeVersion({ ...contract, ...back }, '2026-01'), undefined);
});

it('an import\'s versions merge in, its months winning', () => {
  const mine = { ...contract, versions: [{ effectiveFrom: '2026-01', note: 'mine', terms }, { effectiveFrom: '2026-04', note: 'mine', terms: { ...terms, irsRate: 15 } }] };
  const merged = v.mergeVersions(mine, [{ effectiveFrom: '2026-04', note: 'atlas', terms: { ...terms, irsRate: 14 } }, { effectiveFrom: '2026-09', note: 'atlas', terms: { ...terms, baseGrossMonthly: 1100 } }]);
  assert.deepEqual(merged.versions.map((x) => `${x.effectiveFrom}:${x.note}`), ['2026-01:mine', '2026-04:atlas', '2026-09:atlas']);
  assert.equal(merged.baseGrossMonthly, 1100);
});

it('bad months are dropped and at most 36 kept (the latest)', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ effectiveFrom: `20${20 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, note: '', terms }));
  const kept = v.sortedVersions([...many, { effectiveFrom: '2026-13', note: '', terms }, { effectiveFrom: 'June', note: '', terms }]);
  assert.equal(kept.length, 36);
  assert.equal(kept[0].effectiveFrom, '2020-05');
});

console.log(`${n} passed`);
