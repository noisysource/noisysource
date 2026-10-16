import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findTodos, payrollRunId, validateSeed } from '@shared/lib/finhubSeed';
import { planSeedImport } from './plan';

const EXAMPLE_PATH = new URL('../../../seed/finhub-seed.example.json', import.meta.url);
const example = () => JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'));

const messages = (input: unknown) => validateSeed(input).errors.map(e => `${e.path}: ${e.message}`);

describe('finhub seed — the committed example', () => {
  it('validates with no errors', () => {
    expect(messages(example())).toEqual([]);
  });

  it('refuses the record with a TODO and the records that reference it, imports the rest', () => {
    const v = validateSeed(example());
    expect(v.refused.map(r => r.id)).toEqual(['private-banco2', 'outra-bruno-extra']);
    expect(v.refused[0].reasons).toEqual(['TODO in iban', 'TODO in bic']);
    expect(v.refused[1].reasons).toEqual(['netPayAccount → "private-banco2" is refused']);
    expect(v.importable.some(r => r.id === 'private-banco2')).toBe(false);
    expect(v.importable.some(r => r.id === 'ns-ana-v1')).toBe(true);
  });

  it('derives payroll run ids from company, person and month', () => {
    const ids = validateSeed(example()).importable.filter(r => r.collection === 'payrollRuns').map(r => r.id);
    expect(ids).toEqual(['noisysource-ana-2026-02', 'noisysource-ana-2026-06']);
    expect(payrollRunId('noisysource', 'ana', '2026-02')).toBe('noisysource-ana-2026-02');
  });
});

// Real seed, never committed: SEED_FILE=~/dev/noisysource/prodata/finhub-seed.json pnpm --filter finances test
describe.skipIf(!process.env.SEED_FILE)('finhub seed — local file from SEED_FILE', () => {
  it('validates with no errors (refused records are listed, not failed)', () => {
    const v = validateSeed(JSON.parse(readFileSync(process.env.SEED_FILE!, 'utf8')));
    for (const r of v.refused) console.log(`refused ${r.path} (${r.id}): ${r.reasons.join('; ')}`);
    expect(v.errors.map(e => `${e.path}: ${e.message}`)).toEqual([]);
    const writes = planSeedImport(v.seed!, v.importable);
    const counts: Record<string, number> = {};
    for (const w of writes) counts[`${w.entityId ?? 'global'}/${w.collection}`] = (counts[`${w.entityId ?? 'global'}/${w.collection}`] ?? 0) + 1;
    console.log(`plan: ${writes.length} writes`, counts);
  });
});

describe('finhub seed — errors block the import', () => {
  it('rejects a malformed file with the path of the problem', () => {
    const seed = example();
    seed.entities.noisysource.employmentContracts[0].grossMonthly = 1; // typo'd field name
    const v = validateSeed(seed);
    expect(v.seed).toBeUndefined();
    expect(v.importable).toEqual([]);
    expect(v.errors[0].path).toBe('entities.noisysource.employmentContracts.0');
  });

  it('rejects amounts that are not integer cents', () => {
    const seed = example();
    seed.entities.noisysource.employmentContracts[0].grossMonthlyCents = 1500.5;
    expect(messages(seed)).toEqual(['entities.noisysource.employmentContracts.0.grossMonthlyCents: amounts are integer cents']);
  });

  it('rejects a duplicate key anywhere in the file', () => {
    const seed = example();
    seed.entities.private.categories[1].key = 'private-banco1';
    expect(messages(seed)).toContain('entities.private.categories[1]: key "private-banco1" is already used at entities.private.accounts[0]');
  });

  it('rejects a reference to a key that does not exist, or to the wrong kind of record', () => {
    const seed = example();
    seed.entities.noisysource.employmentContracts[2].netPayAccount = 'noisysource-nope';
    seed.entities.noisysource.employmentContracts[2].person = 'noisysource';
    expect(messages(seed)).toEqual([
      'entities.noisysource.employmentContracts[2].person: "noisysource" is a companies record, expected people',
      'entities.noisysource.employmentContracts[2].netPayAccount: "noisysource-nope" doesn\'t exist',
    ]);
  });

  it('rejects overlapping versions and says which end date fixes it', () => {
    const seed = example();
    delete seed.entities.noisysource.employmentContracts[0].to;
    expect(messages(seed)).toEqual([
      'entities.noisysource.employmentContracts[1]: contract "ns-ana-v2" starts 2026-05-01, but "ns-ana-v1" is still in force then (no end date) — give "ns-ana-v1" "to": "2026-04-30"',
    ]);
  });

  it('rejects a payslip that does not add up', () => {
    const seed = example();
    seed.entities.noisysource.payrollRuns[1].netPaidCents = 156824;
    expect(messages(seed)).toEqual([
      'entities.noisysource.payrollRuns[1].netPaidCents: payslip doesn\'t add up: gross − IRS − SS + cash benefits = 156825, netPaidCents = 156824',
    ]);
  });

  it('needs the net pay account of a household contract', () => {
    const seed = example();
    seed.entities.noisysource.employmentContracts[0].netPayAccount = null;
    expect(messages(seed)).toEqual(['entities.noisysource.employmentContracts[0].netPayAccount: flowToPrivate needs the netPayAccount the salary lands on']);
  });

  it('rejects a payroll run outside its contract version', () => {
    const seed = example();
    seed.entities.noisysource.payrollRuns[0].month = '2026-05';
    expect(messages(seed)).toEqual([
      'entities.noisysource.payrollRuns[0].month: 2026-05 is outside contract "ns-ana-v1" (2026-01-01 → 2026-04-30)',
    ]);
  });

  it('rejects two payroll runs for the same person and month', () => {
    const seed = example();
    seed.entities.noisysource.payrollRuns.push({ ...seed.entities.noisysource.payrollRuns[0] });
    expect(messages(seed)).toEqual(['entities.noisysource.payrollRuns[2]: same person and month as entities.noisysource.payrollRuns[0]']);
  });

  it('checks an EC contract end date against FinHub\'s own projection', () => {
    const seed = example();
    seed.entities.noisysource.ecContracts[0].to = '2026-01-30';
    expect(messages(seed)).toEqual([
      'entities.noisysource.ecContracts[0].to: with these days off, 20 days from 2026-01-05 end on 2026-02-02, not 2026-01-30',
    ]);
  });

  it('puts a benefit on the right kind of card, and ajudas de custo in cash', () => {
    const seed = example();
    const benefits = seed.entities.noisysource.employmentContracts[1].benefits;
    benefits[0].account = 'private-ana-refeicao-ns'; // CHILDCARE on the meal card
    benefits[2].account = 'private-ana-creche-ns';   // ajudas on a card
    expect(messages(seed)).toEqual([
      'entities.noisysource.employmentContracts[1].benefits[0].account: CHILDCARE goes on a childcare voucher card; "private-ana-refeicao-ns" isn\'t one',
      'entities.noisysource.employmentContracts[1].benefits[2].account: ajudas de custo are paid in cash: "account": null',
    ]);
  });

  it('requires account keys to start with their entity', () => {
    const seed = example();
    seed.entities.noisyphocus.accounts[0].key = 'np-banco1';
    seed.entities.noisyphocus.recurring.forEach((r: any) => { r.account = 'np-banco1'; });
    expect(messages(seed)).toEqual(['entities.noisyphocus.accounts[0].key: account keys start with their entity: "noisyphocus-…"']);
  });

  it('requires a contract to be with the company named like its entity', () => {
    const seed = example();
    seed.entities.noisysource.employmentContracts[2].company = 'outra-sa';
    expect(messages(seed)).toEqual([
      'entities.noisysource.employmentContracts[2].company: a contract under noisysource must be with the company named "NoisySource" (FinHub matches by name)',
    ]);
  });

  it('requires a VAT code on company income and expense entries (not Casa), and none on transfers', () => {
    const seed = example();
    delete seed.entities.noisysource.recurring[0].vatCode;
    delete seed.entities.private.recurring[0].vatCode;
    seed.entities.noisyphocus.recurring[1].vatCode = 23;
    expect(messages(seed)).toEqual([
      'entities.noisysource.recurring[0].vatCode: company income and expense need a vatCode ("por_confirmar" if unknown)',
      'entities.noisyphocus.recurring[1].vatCode: transfers have no VAT',
    ]);
  });

  it('imports nothing while there is any error', () => {
    const seed = example();
    seed.entities.noisysource.payrollRuns[1].netPaidCents = 1;
    expect(validateSeed(seed).importable).toEqual([]);
  });

  it('keeps payroll runs and EC contracts out of Casa', () => {
    const seed = example();
    seed.entities.private.ecContracts = [];
    expect(messages(seed)[0]).toMatch(/^entities\.private: /);
  });
});

describe('finhub seed — TODO cascade', () => {
  it('refuses a contract version, then its payroll runs', () => {
    const seed = example();
    seed.entities.noisysource.employmentContracts[1].irsRatePct = 'TODO';
    const v = validateSeed(seed);
    expect(v.errors).toEqual([]);
    expect(v.refused.map(r => [r.id, r.reasons])).toEqual([
      ['private-banco2', ['TODO in iban', 'TODO in bic']],
      ['outra-bruno-extra', ['netPayAccount → "private-banco2" is refused']],
      ['ns-ana-v2', ['TODO in irsRatePct']],
      ['noisysource-ana-2026-06', ['contract → "ns-ana-v2" is refused']],
    ]);
  });

  it('follows chains: a refused person refuses their account, then what is paid into it', () => {
    const seed = example();
    seed.people[1].name = 'TODO'; // bruno, joint owner of private-banco1
    const refused = validateSeed(seed).refused.map(r => r.id);
    expect(refused).toEqual(expect.arrayContaining(['bruno', 'private-banco1', 'outra-bruno-v1', 'ns-ana-v1', 'noisysource-ana-2026-02']));
  });

  it('finds TODOs at any depth and ignores comments', () => {
    expect(findTodos({ a: 1, b: ['x', 'TODO'], c: { d: 'TODO' }, comment: 'TODO later' })).toEqual(['b[1]', 'c.d']);
  });
});
