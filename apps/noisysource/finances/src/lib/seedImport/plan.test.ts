import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateSeed } from '@shared/lib/finhubSeed';
import { planSeedImport } from './plan';

const example = () => JSON.parse(readFileSync(new URL('../../../seed/finhub-seed.example.json', import.meta.url), 'utf8'));
const plan = (seed = example()) => {
  const v = validateSeed(seed);
  expect(v.errors).toEqual([]);
  return planSeedImport(v.seed!, v.importable);
};
const write = (id: string, seed?: any) => plan(seed).find(w => w.id === id)!;

describe('seed import plan', () => {
  it('writes global records first, then entity by entity in dependency order, without refused records', () => {
    const p = plan();
    expect(p.slice(0, 6).map(w => w.id)).toEqual(['ana', 'bruno', 'carla', 'noisysource', 'noisyphocus', 'outra-sa']);
    expect(p.map(w => `${w.entityId}/${w.collection}`).filter((x, i, a) => a.indexOf(x) === i)).toEqual([
      'null/people', 'null/companies',
      'private/accounts', 'private/categories', 'private/incomeSources', 'private/creditContracts', 'private/loans',
      'private/insurances', 'private/recurring',
      'noisysource/accounts', 'noisysource/employmentContracts', 'noisysource/payrollRuns', 'noisysource/ecContracts',
      'noisysource/recurring',
      'noisyphocus/accounts', 'noisyphocus/recurring',
    ]);
    expect(p.some(w => w.id === 'private-banco2' || w.id === 'outra-bruno-extra')).toBe(false);
  });

  it('maps accounts as the form saves them: owner, joint owners, the issuing employer by name', () => {
    expect(write('private-banco1').input).toMatchObject({ type: 'bank', ownerType: 'person', ownerId: 'ana', jointOwnerIds: ['bruno'], currency: 'EUR' });
    expect(write('private-ana-creche-ns').input).toMatchObject({ type: 'voucher', voucherType: 'childcare', issuingEmployer: 'NoisySource' });
  });

  it('maps contracts with their dates, benefits (cash = no account) and the sync to run', () => {
    const w = write('ns-ana-v2');
    expect(w.sync).toBe('employmentContract');
    expect(w.personName).toBe('Ana');
    expect(w.input).toMatchObject({ companyId: 'noisysource', personId: 'ana', startDate: '2026-05-01', contractType: 'employee' });
    expect((w.input.benefits as any[]).map(b => [b.type, b.benefitAccountId])).toEqual([
      ['CHILDCARE', 'private-ana-creche-ns'], ['MEAL_CARD', 'private-ana-refeicao-ns'], ['EXPENSE_ALLOWANCE', ''],
    ]);
    expect(write('ns-carla').input).toMatchObject({ netPayAccountId: '', flowToPrivate: false });
  });

  it('derives the payroll run totals the Payroll page would store', () => {
    const w = write('noisysource-ana-2026-06');
    expect(w.input).toEqual({
      contractId: 'ns-ana-v2', companyId: 'noisysource', personId: 'ana', year: 2026, month: 6,
      grossCents: 150000, irsCents: 18000, ssEmpCents: 16500, ssErCents: 35625,
      netCents: 115500, benefitsCents: 92745, costToEmployerCents: 278370, cashOutCents: 208245,
      confirmedAt: new Date(2026, 5, 30, 12), sourceAccountId: 'noisysource-banco1',
    });
  });

  it('gives EC contracts the projected end date, and the average days when none are given', () => {
    const v1 = write('ec-cliente-x-v1');
    expect(v1.sync).toBe('ecContract');
    expect(v1.input).toMatchObject({ startDate: new Date('2026-01-05T12:00:00'), endDate: new Date('2026-02-02T12:00:00'), nonWorkingDays: ['2026-01-06'], vatCode: 'isento' });
    expect(v1.input.halfDays).toBeUndefined();
    const seed = example();
    delete seed.entities.noisysource.ecContracts[0].expectedDaysPerMonth;
    expect(write('ec-cliente-x-v1', seed).input.expectedDaysPerMonth).toBe(10); // 20 days over Jan + Feb
  });

  it('fills each balance sync with what FinHub had computed before it', () => {
    const syncs = write('private-carro').input.balanceSyncs as any[];
    expect(syncs).toHaveLength(1);
    expect(syncs[0].computedOutstandingCents).toBeGreaterThan(0);
    expect(syncs[0].computedOutstandingCents).toBeLessThan(2000000);
    expect(syncs[0].deltaCents).toBe(1610000 - syncs[0].computedOutstandingCents);
  });

  it('signs loan amounts by kind, as LoansPage does', () => {
    expect(write('loan-joao-1').input.amountCents).toBe(50000);
    expect(write('loan-joao-2').input.amountCents).toBe(-20000);
  });

  it('maps recurring and insurance entries, never with a sourceId', () => {
    expect(write('np-transfer-ns').input).toMatchObject({ type: 'transfer', accountId: 'noisyphocus-banco1', toAccountId: 'noisysource-banco1', active: true });
    expect(write('private-internet').input).toMatchObject({ categoryId: 'private-casa-telecom', vatCode: 23 });
    expect(plan().every(w => !('sourceId' in w.input))).toBe(true);
    const ins = write('private-saude');
    expect(ins.sync).toBe('insurance');
    expect('attachments' in ins.input).toBe(false);
    expect(ins.input.recurring).toBe(true);
    const seed = example();
    seed.entities.private.insurances[0].recurring = false;
    expect(write('private-saude', seed).input.recurring).toBe(false);
  });
});
