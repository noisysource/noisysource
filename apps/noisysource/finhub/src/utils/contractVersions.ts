// A contract's terms change over time (a raise, a new IRS rate, a voucher added).
// Each change is a version with the month it takes effect from; payroll for a month
// uses the version in force that month, so a raise in June leaves January–May as they were.
// The contract's top-level terms always mirror its latest version, so anything that reads
// them (and contracts saved before versions existed) keeps working.
// A one-month exception (leave, a bonus, a pro-rata month) is not a version: it belongs on
// that month's payslip.

import type { ContractTerms, ContractVersion, EmploymentContract } from '../types/finance';

/** The terms a version carries, in a fixed order. */
export const CONTRACT_TERM_KEYS = [
  'paySchedule',
  'baseGrossMonthly',
  'irsRate',
  'employeeSsRate',
  'employerSsRate',
  'mealAllowanceDaily',
  'mealPaymentMethod',
  'childVoucherMonthly',
  'childVoucherSubjectToIrs',
  'childVoucherSubjectToSs',
  'otherBenefitName',
  'otherBenefitMonthly',
  'otherBenefitSubjectToIrs',
  'otherBenefitSubjectToSs',
] as const satisfies readonly (keyof ContractTerms)[];

/** Most versions a contract keeps (the rules allow no more). */
export const MAX_CONTRACT_VERSIONS = 36;

const MONTH = /^20\d\d-(0[1-9]|1[0-2])$/;

export const isMonthKey = (v: unknown): v is string => typeof v === 'string' && MONTH.test(v);

/** A month nothing is paid: the contract wasn't in force yet. */
export const NOT_IN_FORCE: ContractTerms = {
  paySchedule: '12_months',
  baseGrossMonthly: 0,
  irsRate: 0,
  employeeSsRate: 0,
  employerSsRate: 0,
  mealAllowanceDaily: 0,
  mealPaymentMethod: 'none',
  childVoucherMonthly: 0,
  childVoucherSubjectToIrs: false,
  childVoucherSubjectToSs: false,
  otherBenefitName: '',
  otherBenefitMonthly: 0,
  otherBenefitSubjectToIrs: false,
  otherBenefitSubjectToSs: false,
};

/** The contract's top-level terms. */
export const termsOf = (c: ContractTerms): ContractTerms =>
  Object.fromEntries(CONTRACT_TERM_KEYS.map((k) => [k, c[k]])) as unknown as ContractTerms;

/** Versions in month order, one per month (the last given wins), at most MAX_CONTRACT_VERSIONS (the latest kept). */
export const sortedVersions = (versions: readonly ContractVersion[] | undefined): ContractVersion[] => {
  const byMonth = new Map<string, ContractVersion>();
  for (const v of versions ?? []) if (isMonthKey(v.effectiveFrom)) byMonth.set(v.effectiveFrom, v);
  return [...byMonth.values()]
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
    .slice(-MAX_CONTRACT_VERSIONS);
};

/**
 * The terms in force in a month: the latest version from that month or before.
 * Before its first version the contract wasn't in force (nothing is paid).
 * A contract without versions has the same terms every month, as before versions existed.
 */
export const termsAt = (c: EmploymentContract, monthKey: string): ContractTerms => {
  const versions = sortedVersions(c.versions);
  if (versions.length === 0) return termsOf(c);
  let found: ContractVersion | undefined;
  for (const v of versions) if (v.effectiveFrom <= monthKey) found = v;
  return found ? { ...termsOf(c), ...found.terms } : NOT_IN_FORCE;
};

/** The version in force in a month, if the contract has versions. */
export const versionAt = (c: EmploymentContract, monthKey: string): ContractVersion | undefined => {
  let found: ContractVersion | undefined;
  for (const v of sortedVersions(c.versions)) if (v.effectiveFrom <= monthKey) found = v;
  return found;
};

/** The versions and top-level terms to save: the latest version's terms on top. */
export const withVersions = (
  versions: readonly ContractVersion[]
): { versions: ContractVersion[] } & Partial<ContractTerms> => {
  const sorted = sortedVersions(versions);
  const latest = sorted[sorted.length - 1];
  return latest ? { versions: sorted, ...latest.terms } : { versions: sorted };
};

/**
 * A change from a month on. A contract without versions gets its current terms
 * as the first version (from `startMonth`, or the month of the change when that's earlier).
 */
export const addVersion = (
  c: EmploymentContract,
  change: { readonly effectiveFrom: string; readonly note: string; readonly terms: ContractTerms },
  startMonth: string
) => {
  const existing = sortedVersions(c.versions);
  const base: ContractVersion[] =
    existing.length > 0
      ? existing
      : [
          {
            effectiveFrom: startMonth <= change.effectiveFrom ? startMonth : change.effectiveFrom,
            note: 'Terms before versions were kept',
            terms: termsOf(c),
          },
        ];
  return withVersions([...base.filter((v) => v.effectiveFrom !== change.effectiveFrom), { ...change, terms: termsOf(change.terms) }]);
};

/** Without one version; the first can't go while others remain after it, and the last one can't go at all. */
export const removeVersion = (c: EmploymentContract, effectiveFrom: string) => {
  const existing = sortedVersions(c.versions);
  if (existing.length <= 1) return undefined;
  return withVersions(existing.filter((v) => v.effectiveFrom !== effectiveFrom));
};

/**
 * Versions from an import merged into a contract's: the import's month wins when both
 * have one. Months the import doesn't name keep what he saved.
 */
export const mergeVersions = (
  c: EmploymentContract | undefined,
  incoming: readonly ContractVersion[]
) => {
  const mine = c ? sortedVersions(c.versions) : [];
  const theirs = sortedVersions(incoming);
  const months = new Set(theirs.map((v) => v.effectiveFrom));
  return withVersions([...mine.filter((v) => !months.has(v.effectiveFrom)), ...theirs]);
};

/** The first version of a contract saved before versions existed: its terms "from the start". */
export const START_MONTH = '2000-01';

/** "Jan 2026" for a month key ("the start" for START_MONTH). */
export const monthLabel = (monthKey: string): string => {
  if (monthKey <= START_MONTH) return 'the start';
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1)).toLocaleDateString('en-GB', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
};
