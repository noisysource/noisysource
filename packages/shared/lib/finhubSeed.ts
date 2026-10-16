/**
 * finhubSeed.ts — the FinHub seed file: schema and validation (HANDOFF-finhub-data.md §2).
 *
 * One JSON file holds every record FinHub needs to start from real data: global people and
 * companies, then one section per entity. Each record has a readable `key` that becomes its
 * Firestore id; references between records use keys. The real file lives in `prodata/`
 * (never committed); `apps/noisysource/finances/seed/finhub-seed.example.json` shows the shape
 * with made-up values.
 *
 * Two kinds of problems:
 * - **errors**: the file is wrong (bad shape, duplicate or unknown key, overlapping versions, a
 *   payslip that doesn't add up). Any error blocks the whole import.
 * - **refused records**: a record with a "TODO" anywhere is unknown, not wrong. It is skipped,
 *   and so is every record that references it; the rest imports (Renato, 2026-10-16).
 *
 * Pure: no Firestore. The importer (finances `src/lib/seedImport`) maps records to documents.
 */
import { z } from 'zod';
import { isVatCode, type VatCode } from './vat';
import { computeEcProjection } from './ecProjection';

export const SEED_VERSION = 1;
export const TODO = 'TODO';

export const SEED_ENTITY_IDS = ['private', 'noisysource', 'noisyphocus'] as const;
export type SeedEntityId = (typeof SEED_ENTITY_IDS)[number];

/** Company entities and the company name FinHub matches them by (PayrollPage, CostSummary). */
export const COMPANY_ENTITY_NAMES: Record<Exclude<SeedEntityId, 'private'>, string> = {
  noisysource: 'NoisySource',
  noisyphocus: 'NoisyPhocus',
};

// ── field types ──────────────────────────────────────────────────────────────

const todo = z.literal(TODO);
/** A value that may still be unknown: "TODO" refuses the record, it isn't an error. */
const orTodo = <T extends z.ZodType>(schema: T) => z.union([schema, todo]);

const isRealDate = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

const key = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'key: lowercase letters, digits and "-"');
const ref = orTodo(key);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date: YYYY-MM-DD').refine(isRealDate, 'not a real date');
const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month: YYYY-MM');
const cents = z.number().int('amounts are integer cents');
const pct = z.number().min(0).max(100);
const day = z.number().int().min(1).max(31);
const text = z.string().min(1);
/** Free text for the person editing the file. Never written to Firestore. */
const comment = z.string().optional();
/** 23, 13, 6, 0 (numbers), or "isento", "autoliquidacao", "por_confirmar" (vat.ts). */
const vatCode = z.custom<VatCode>(isVatCode, 'VAT code: 23, 13, 6, 0, "isento", "autoliquidacao" or "por_confirmar"');

// ── records ──────────────────────────────────────────────────────────────────

const PersonSchema = z.strictObject({
  key,
  /** The name FinHub shows and matches on (IRS page, income sources): a first name is fine. */
  name: orTodo(text),
  email: orTodo(z.string().email()).optional(),
  comment,
});

const CompanySchema = z.strictObject({
  key,
  name: orTodo(text),
  shortCode: orTodo(text).optional(),
  taxNumber: orTodo(z.string().regex(/^\d{9}$/, 'NIF: 9 digits')).optional(),
  comment,
});

const owner = orTodo(z.string().regex(/^(person|company):[a-z0-9][a-z0-9-]*$/, 'owner: "person:<key>" or "company:<key>"'));

const accountBase = {
  key,
  name: orTodo(text),
  code: orTodo(text).optional(),
  owner: owner.optional(),
  jointOwners: z.array(ref).optional(),
  comment,
};

export const VOUCHER_TYPES = ['meal', 'childcare', 'education'] as const;

const AccountSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...accountBase,
    type: z.literal('bank'),
    bankName: orTodo(text),
    iban: orTodo(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/, 'IBAN: uppercase, no spaces')),
    bic: orTodo(text),
  }),
  z.strictObject({ ...accountBase, type: z.literal('wallet') }),
  z.strictObject({ ...accountBase, type: z.literal('cash') }),
  z.strictObject({
    ...accountBase,
    type: z.literal('credit'),
    issuer: orTodo(text).optional(),
    last4: orTodo(z.string().regex(/^\d{4}$/)).optional(),
  }),
  z.strictObject({
    ...accountBase,
    type: z.literal('voucher'),
    voucherType: z.enum(VOUCHER_TYPES),
    provider: orTodo(text),
    /** The employer that loads the card, as a company key. */
    issuingEmployer: ref,
  }),
  z.strictObject({ ...accountBase, type: z.literal('bonds'), provider: orTodo(text) }),
]);

const CategorySchema = z.strictObject({
  key,
  name: orTodo(text),
  code: orTodo(text).optional(),
  type: z.enum(['EXPENSE', 'INCOME', 'LIABILITY', 'EQUITY']),
  parent: ref.optional(),
  comment,
});

export const BENEFIT_TYPES = [
  'MEAL_CARD', 'MEAL', 'MEAL_VOUCHER', 'CHILDCARE', 'EDUCATION', 'EXPENSE_ALLOWANCE', 'OTHER',
] as const;
export type SeedBenefitType = (typeof BENEFIT_TYPES)[number];

const BenefitSchema = z.strictObject({
  type: z.enum(BENEFIT_TYPES),
  perMonthCents: orTodo(cents.nonnegative()).optional(),
  perDayCents: orTodo(cents.nonnegative()).optional(),
  daysPerMonth: orTodo(z.number().nonnegative()).optional(),
  subjectToIRS: z.boolean(),
  subjectToSS: z.boolean(),
  /** Voucher card it lands on, or null when it's paid in cash with the salary. Required. */
  account: ref.nullable(),
  expenseCategory: ref.optional(),
  payableCategory: ref.optional(),
  providerFeePct: orTodo(pct).optional(),
  providerFeeCents: orTodo(cents.nonnegative()).optional(),
  comment,
});

/** A version is in force from `from` to `to` (inclusive); no `to` = still in force. */
const versionDates = { from: isoDate, to: isoDate.optional() };

const EmploymentContractSchema = z.strictObject({
  key,
  person: ref,
  company: ref,
  contractType: z.enum(['employee', 'green_receipt']).optional(),
  ...versionDates,
  grossMonthlyCents: orTodo(cents.nonnegative()),
  irsRatePct: orTodo(pct),
  ssEmpPct: orTodo(pct),
  ssErPct: orTodo(pct),
  payDay: orTodo(day),
  netPayAccount: ref,
  /** true → net salary and voucher credits also appear as Casa income. */
  flowToPrivate: z.boolean(),
  benefits: z.array(BenefitSchema),
  comment,
});

/** One payslip: what was actually paid that month, read from the document. */
const PayrollRunSchema = z.strictObject({
  contract: ref,
  month: yearMonth,
  /** Taxable pay of the month: base + subsidies − absences. */
  grossCents: orTodo(cents),
  irsCents: orTodo(cents.nonnegative()),
  ssEmpCents: orTodo(cents.nonnegative()),
  /** Employer SS actually charged (not on the payslip; 0 in exempt months). */
  ssErCents: orTodo(cents.nonnegative()),
  /** Benefits loaded on cards (meal, childcare, education). */
  voucherBenefitsCents: orTodo(cents.nonnegative()),
  /** Benefits paid in cash with the salary (ajudas de custo). */
  cashBenefitsCents: orTodo(cents.nonnegative()),
  /** The payslip's net, the bank transfer. Must equal gross − IRS − SS employee + cash benefits. */
  netPaidCents: orTodo(cents),
  sourceAccount: ref.optional(),
  comment,
});

const IncomeSourceSchema = z.strictObject({
  key,
  person: ref,
  employerName: orTodo(text),
  ...versionDates,
  grossMonthlyCents: orTodo(cents.nonnegative()),
  irsRatePct: orTodo(pct),
  ssEmpPct: orTodo(pct),
  payDay: orTodo(day),
  netPayAccount: ref,
  benefits: z.array(BenefitSchema),
  notes: orTodo(text).optional(),
  comment,
});

const EcContractSchema = z.strictObject({
  key,
  clientName: orTodo(text),
  projectName: orTodo(text).optional(),
  ...versionDates,
  dailyRateCents: orTodo(cents.positive()),
  totalDays: orTodo(z.number().positive()),
  expectedDaysPerMonth: orTodo(z.number().nonnegative()),
  daysToPayment: orTodo(z.number().int().nonnegative()).optional(),
  paymentAccount: ref.optional(),
  vatCode,
  nonWorkingDays: z.array(isoDate),
  halfDays: z.array(isoDate),
  comment,
});

const CreditContractSchema = z.strictObject({
  key,
  type: z.enum(['mortgage', 'auto', 'personal', 'business']),
  description: orTodo(text),
  creditor: orTodo(text),
  loanAmountCents: orTodo(cents.positive()),
  startYearMonth: orTodo(yearMonth),
  termMonths: orTodo(z.number().int().positive()),
  rateType: z.enum(['fixed', 'variable']),
  annualRatePct: orTodo(z.number().nonnegative()),
  spreadPct: orTodo(z.number()).optional(),
  rateHistory: z.array(z.strictObject({
    effectiveYearMonth: yearMonth,
    annualRatePct: orTodo(z.number().nonnegative()),
    note: z.string().optional(),
  })).optional(),
  balanceSyncs: z.array(z.strictObject({
    syncYearMonth: yearMonth,
    actualOutstandingCents: orTodo(cents),
    computedOutstandingCents: orTodo(cents),
    note: z.string().optional(),
  })).optional(),
  interestOnlyPhase: z.boolean().optional(),
  account: ref.optional(),
  dayOfMonth: orTodo(day).optional(),
  active: z.boolean().optional(),
  notes: orTodo(text).optional(),
  comment,
});

export const LOAN_KINDS = ['lent', 'borrowed', 'repayment_in', 'repayment_out', 'covered_for_me'] as const;
/** Same signs as LoansPage: positive = in my favour. */
export const LOAN_KIND_SIGN: Record<(typeof LOAN_KINDS)[number], 1 | -1> = {
  lent: 1, borrowed: -1, repayment_in: -1, repayment_out: 1, covered_for_me: -1,
};

const LoanSchema = z.strictObject({
  key,
  counterparty: orTodo(text),
  kind: z.enum(LOAN_KINDS),
  /** Always positive, as typed in the form; the sign comes from `kind`. */
  amountCents: orTodo(cents.positive()),
  description: orTodo(text),
  date: orTodo(isoDate),
  notes: orTodo(text).optional(),
  comment,
});

const InsuranceSchema = z.strictObject({
  key,
  name: orTodo(text),
  type: z.enum(['health', 'life', 'car', 'home', 'liability', 'work', 'travel', 'other']),
  insurer: orTodo(text),
  policyNumber: orTodo(text).optional(),
  premiumCents: orTodo(cents.nonnegative()),
  frequency: z.enum(['monthly', 'quarterly', 'annual']),
  startDate: orTodo(isoDate).optional(),
  renewalDate: orTodo(isoDate).optional(),
  insuredPersons: orTodo(text).optional(),
  notes: orTodo(text).optional(),
  active: z.boolean().optional(),
  comment,
});

/**
 * Hand-entered recurring entries only. Entries FinHub derives (salaries, benefits, EC income,
 * insurance premiums) are created by the importer through the same syncs as the forms.
 */
const RecurringSchema = z.strictObject({
  key,
  type: z.enum(['income', 'expense', 'transfer']),
  description: orTodo(text),
  /** VAT included (VAT convention). For a commission: the fallback estimate. */
  amountCents: orTodo(cents.nonnegative()),
  account: ref.optional(),
  toAccount: ref.optional(),
  category: ref.optional(),
  frequency: z.enum(['monthly', 'quarterly', 'annual', 'once']),
  dayOfMonth: orTodo(day),
  monthOfYear: orTodo(z.number().int().min(1).max(12)).optional(),
  startYearMonth: orTodo(yearMonth).optional(),
  endYearMonth: orTodo(yearMonth).optional(),
  onceYearMonth: orTodo(yearMonth).optional(),
  /** Required for income and expense ("por_confirmar" is a valid answer); not for transfers. */
  vatCode: orTodo(vatCode).optional(),
  reimbursable: z.boolean().optional(),
  paidByAccount: ref.optional(),
  costModel: z.enum(['fixed', 'commission']).optional(),
  commissionPct: orTodo(pct).optional(),
  commissionVolumeSource: z.literal('kidclub_billing').optional(),
  active: z.boolean().optional(),
  comment,
});

const IrsConfigSchema = z.strictObject({
  year: z.number().int().min(2000).max(2100),
  incomes: z.array(z.strictObject({
    person: ref,
    employerName: orTodo(text),
    grossAnnualCents: orTodo(cents.nonnegative()),
    irsWithheldCents: orTodo(cents.nonnegative()),
    ssEmployeeCents: orTodo(cents.nonnegative()),
  })),
  deductions: z.strictObject({
    healthCents: orTodo(cents.nonnegative()),
    educationCents: orTodo(cents.nonnegative()),
    housingCents: orTodo(cents.nonnegative()),
  }),
  comment,
});

// ── sections ─────────────────────────────────────────────────────────────────

const list = <T extends z.ZodType>(s: T) => z.array(s).optional();

/** Casa: no payroll, no EC contracts. Income sources, loans and IRS live only here. */
const PrivateSectionSchema = z.strictObject({
  accounts: list(AccountSchema),
  categories: list(CategorySchema),
  incomeSources: list(IncomeSourceSchema),
  creditContracts: list(CreditContractSchema),
  loans: list(LoanSchema),
  insurances: list(InsuranceSchema),
  recurring: list(RecurringSchema),
  irsConfig: list(IrsConfigSchema),
});

const companySection = {
  accounts: list(AccountSchema),
  categories: list(CategorySchema),
  employmentContracts: list(EmploymentContractSchema),
  payrollRuns: list(PayrollRunSchema),
  creditContracts: list(CreditContractSchema),
  insurances: list(InsuranceSchema),
  recurring: list(RecurringSchema),
};

/** EC contracts only under NoisySource: FinHub's EC events are hard-wired to it (redesign step 3). */
const NoisySourceSectionSchema = z.strictObject({ ...companySection, ecContracts: list(EcContractSchema) });
const NoisyPhocusSectionSchema = z.strictObject(companySection);

export const SeedSchema = z.strictObject({
  version: z.literal(SEED_VERSION),
  comment,
  people: z.array(PersonSchema),
  companies: z.array(CompanySchema),
  entities: z.strictObject({
    private: PrivateSectionSchema.optional(),
    noisysource: NoisySourceSectionSchema.optional(),
    noisyphocus: NoisyPhocusSectionSchema.optional(),
  }),
});

export type Seed = z.infer<typeof SeedSchema>;
export type SeedPerson = z.infer<typeof PersonSchema>;
export type SeedCompany = z.infer<typeof CompanySchema>;
export type SeedAccount = z.infer<typeof AccountSchema>;
export type SeedCategory = z.infer<typeof CategorySchema>;
export type SeedBenefit = z.infer<typeof BenefitSchema>;
export type SeedEmploymentContract = z.infer<typeof EmploymentContractSchema>;
export type SeedPayrollRun = z.infer<typeof PayrollRunSchema>;
export type SeedIncomeSource = z.infer<typeof IncomeSourceSchema>;
export type SeedEcContract = z.infer<typeof EcContractSchema>;
export type SeedCreditContract = z.infer<typeof CreditContractSchema>;
export type SeedLoan = z.infer<typeof LoanSchema>;
export type SeedInsurance = z.infer<typeof InsuranceSchema>;
export type SeedRecurring = z.infer<typeof RecurringSchema>;
export type SeedIrsConfig = z.infer<typeof IrsConfigSchema>;

/** A record with every "TODO" ruled out: what the importer maps once a record isn't refused. */
export type Known<T> = T extends typeof TODO
  ? never
  : T extends Array<infer U>
    ? Array<Known<U>>
    : T extends object
      ? { [K in keyof T]: Known<T[K]> }
      : T;

// ── flattening ───────────────────────────────────────────────────────────────

export type SeedCollection =
  | 'people' | 'companies' | 'accounts' | 'categories' | 'employmentContracts' | 'payrollRuns'
  | 'incomeSources' | 'ecContracts' | 'creditContracts' | 'loans' | 'insurances' | 'recurring'
  | 'irsConfig';

/** Where a record lives: global (people, companies) or one entity. */
export type SeedRecordRef = {
  collection: SeedCollection;
  entityId: SeedEntityId | null;
  /** Firestore id: the record's key, derived for payroll runs and IRS config. */
  id: string;
  /** Path in the file, for messages: e.g. "entities.noisysource.employmentContracts[2]". */
  path: string;
};

export type SeedRecord = SeedRecordRef & { data: any };

/** Firestore id of a payroll run: one per company, person and month. */
export const payrollRunId = (companyKey: string, personKey: string, month: string) =>
  `${companyKey}-${personKey}-${month}`;

/** Every record in file order, global first, then entity by entity. */
export function flattenSeed(seed: Seed): SeedRecord[] {
  const out: SeedRecord[] = [];
  seed.people.forEach((data, i) =>
    out.push({ collection: 'people', entityId: null, id: data.key, path: `people[${i}]`, data }));
  seed.companies.forEach((data, i) =>
    out.push({ collection: 'companies', entityId: null, id: data.key, path: `companies[${i}]`, data }));

  const contracts = new Map<string, SeedEmploymentContract>();
  for (const eid of SEED_ENTITY_IDS) {
    for (const c of (seed.entities[eid] as any)?.employmentContracts ?? []) contracts.set(c.key, c);
  }

  for (const entityId of SEED_ENTITY_IDS) {
    const section = seed.entities[entityId] as Record<string, any[] | undefined> | undefined;
    if (!section) continue;
    for (const [collection, rows] of Object.entries(section)) {
      (rows ?? []).forEach((data: any, i: number) => {
        const path = `entities.${entityId}.${collection}[${i}]`;
        let id: string = data.key;
        if (collection === 'payrollRuns') {
          const c = contracts.get(data.contract);
          id = payrollRunId(String(c?.company ?? '?'), String(c?.person ?? '?'), data.month);
        } else if (collection === 'irsConfig') {
          id = String(data.year);
        }
        out.push({ collection: collection as SeedCollection, entityId, id, path, data });
      });
    }
  }
  return out;
}

// ── validation ───────────────────────────────────────────────────────────────

export type SeedIssue = { path: string; message: string };

export type SeedValidation = {
  /** Parsed file; undefined when the shape itself is wrong. */
  seed?: Seed;
  /** Mistakes in the file. Any error blocks the import. */
  errors: SeedIssue[];
  /** Records that will be skipped, with why (a TODO, or a reference to a skipped record). */
  refused: Array<SeedRecordRef & { reasons: string[] }>;
  /** Records that can be imported, in import order. */
  importable: SeedRecord[];
};

/** Paths of every "TODO" inside a value, relative to it ("" = the value itself). */
export function findTodos(value: unknown, at = ''): string[] {
  if (value === TODO) return [at || '(value)'];
  if (Array.isArray(value)) return value.flatMap((v, i) => findTodos(v, `${at}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => (k === 'comment' ? [] : findTodos(v, at ? `${at}.${k}` : k)));
  }
  return [];
}

type RefKind = 'person' | 'company' | 'account' | 'category' | 'employmentContract';

/** The references a record makes: [field path, kind, key]. TODO references are left out. */
function referencesOf(r: SeedRecord): Array<[string, RefKind, string]> {
  const d = r.data;
  const out: Array<[string, RefKind, string]> = [];
  const add = (field: string, kind: RefKind, k: unknown) => {
    if (typeof k === 'string' && k !== TODO) out.push([field, kind, k]);
  };
  const benefits = (bs: SeedBenefit[] | undefined) =>
    (bs ?? []).forEach((b, i) => {
      add(`benefits[${i}].account`, 'account', b.account);
      add(`benefits[${i}].expenseCategory`, 'category', b.expenseCategory);
      add(`benefits[${i}].payableCategory`, 'category', b.payableCategory);
    });

  switch (r.collection) {
    case 'accounts': {
      if (typeof d.owner === 'string' && d.owner !== TODO) {
        const [kind, k] = d.owner.split(':');
        add('owner', kind as RefKind, k);
      }
      (d.jointOwners ?? []).forEach((k: string, i: number) => add(`jointOwners[${i}]`, 'person', k));
      if (d.type === 'voucher') add('issuingEmployer', 'company', d.issuingEmployer);
      break;
    }
    case 'categories':
      add('parent', 'category', d.parent);
      break;
    case 'employmentContracts':
      add('person', 'person', d.person);
      add('company', 'company', d.company);
      add('netPayAccount', 'account', d.netPayAccount);
      benefits(d.benefits);
      break;
    case 'payrollRuns':
      add('contract', 'employmentContract', d.contract);
      add('sourceAccount', 'account', d.sourceAccount);
      break;
    case 'incomeSources':
      add('person', 'person', d.person);
      add('netPayAccount', 'account', d.netPayAccount);
      benefits(d.benefits);
      break;
    case 'ecContracts':
      add('paymentAccount', 'account', d.paymentAccount);
      break;
    case 'creditContracts':
      add('account', 'account', d.account);
      break;
    case 'recurring':
      add('account', 'account', d.account);
      add('toAccount', 'account', d.toAccount);
      add('category', 'category', d.category);
      add('paidByAccount', 'account', d.paidByAccount);
      break;
    case 'irsConfig':
      (d.incomes ?? []).forEach((inc: any, i: number) => add(`incomes[${i}].person`, 'person', inc.person));
      break;
  }
  return out;
}

const KIND_COLLECTION: Record<RefKind, SeedCollection> = {
  person: 'people',
  company: 'companies',
  account: 'accounts',
  category: 'categories',
  employmentContract: 'employmentContracts',
};

const BENEFIT_VOUCHER: Partial<Record<SeedBenefitType, (typeof VOUCHER_TYPES)[number]>> = {
  MEAL_CARD: 'meal', MEAL: 'meal', MEAL_VOUCHER: 'meal', CHILDCARE: 'childcare', EDUCATION: 'education',
};

const normName = (s: string) => s.toLowerCase().replace(/\s+/g, '');
const known = (v: unknown): v is string | number => v !== undefined && v !== TODO;
/** The ISO date one day before `iso`. */
function dayBefore(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Overlap check for versions of the same thing (same person + company, client, …). */
function checkVersions(
  rows: SeedRecord[],
  groupOf: (d: any) => string | null,
  label: string,
  errors: SeedIssue[],
) {
  const groups = new Map<string, SeedRecord[]>();
  for (const r of rows) {
    const g = groupOf(r.data);
    if (g === null) continue;
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  for (const versions of groups.values()) {
    const sorted = [...versions].sort((a, b) => a.data.from.localeCompare(b.data.from));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (!prev.data.to || prev.data.to >= cur.data.from) {
        errors.push({
          path: cur.path,
          message: `${label} "${cur.id}" starts ${cur.data.from}, but "${prev.id}" is still in force then` +
            (prev.data.to ? ` (until ${prev.data.to})` : ' (no end date)') +
            ` — give "${prev.id}" "to": "${dayBefore(cur.data.from)}"`,
        });
      }
    }
  }
}

/**
 * zod issues → messages. A field that also accepts "TODO" fails as a union with a generic
 * "Invalid input": report why the real value was rejected instead (orTodo puts it first).
 */
function issueMessages(issues: ReadonlyArray<any>, base: PropertyKey[] = []): SeedIssue[] {
  return issues.flatMap((i): SeedIssue[] => {
    const path = [...base, ...i.path];
    if (i.code === 'invalid_union' && i.errors?.[0]?.length) return issueMessages(i.errors[0], path);
    return [{ path: path.map(String).join('.') || '(file)', message: i.message }];
  });
}

/**
 * Validates a parsed JSON value. Never throws: every problem comes back as an error, and records
 * with a TODO (or depending on one) come back as refused.
 */
export function validateSeed(input: unknown): SeedValidation {
  const parsed = SeedSchema.safeParse(input);
  if (!parsed.success) {
    return {
      errors: issueMessages(parsed.error.issues),
      refused: [],
      importable: [],
    };
  }
  const seed = parsed.data;
  const records = flattenSeed(seed);
  const errors: SeedIssue[] = [];

  // Keys are unique across the whole file: references don't say which collection or entity.
  const byKey = new Map<string, SeedRecord>();
  for (const r of records) {
    const k = r.data.key;
    if (typeof k !== 'string') continue;
    const prev = byKey.get(k);
    if (prev) errors.push({ path: r.path, message: `key "${k}" is already used at ${prev.path}` });
    else byKey.set(k, r);
  }

  // Derived ids (payroll runs, IRS years) are unique per collection and entity.
  const derivedSeen = new Map<string, SeedRecord>();
  for (const r of records) {
    if (r.collection !== 'payrollRuns' && r.collection !== 'irsConfig') continue;
    const id = `${r.entityId}/${r.collection}/${r.id}`;
    const prev = derivedSeen.get(id);
    if (prev) errors.push({ path: r.path, message: `same ${r.collection === 'irsConfig' ? 'year' : 'person and month'} as ${prev.path}` });
    else derivedSeen.set(id, r);
  }

  // References point to an existing record of the right kind.
  for (const r of records) {
    for (const [field, kind, k] of referencesOf(r)) {
      const target = byKey.get(k);
      if (!target) errors.push({ path: `${r.path}.${field}`, message: `"${k}" doesn't exist` });
      else if (target.collection !== KIND_COLLECTION[kind]) {
        errors.push({ path: `${r.path}.${field}`, message: `"${k}" is a ${target.collection} record, expected ${KIND_COLLECTION[kind]}` });
      }
    }
  }

  const get = (k: unknown, collection: SeedCollection) => {
    const t = typeof k === 'string' ? byKey.get(k) : undefined;
    return t && t.collection === collection ? t : undefined;
  };

  for (const r of records) {
    const d = r.data;
    const err = (message: string, field?: string) => errors.push({ path: field ? `${r.path}.${field}` : r.path, message });

    if (r.collection === 'accounts' && !r.id.startsWith(`${r.entityId}-`)) {
      err(`account keys start with their entity: "${r.entityId}-…"`, 'key');
    }

    if ('from' in d && d.to && d.to < d.from) err(`"to" (${d.to}) is before "from" (${d.from})`, 'to');

    if (Array.isArray(d.benefits)) {
      d.benefits.forEach((b: SeedBenefit, i: number) => {
        const f = `benefits[${i}]`;
        if (b.perMonthCents === undefined && b.perDayCents === undefined) err('give perMonthCents or perDayCents', f);
        if (b.perDayCents !== undefined && b.daysPerMonth === undefined) err('perDayCents needs daysPerMonth', f);
        const card = get(b.account, 'accounts');
        if (b.type === 'EXPENSE_ALLOWANCE' && b.account !== null) err('ajudas de custo are paid in cash: "account": null', `${f}.account`);
        const want = BENEFIT_VOUCHER[b.type];
        if (card && want && (card.data.type !== 'voucher' || card.data.voucherType !== want)) {
          err(`${b.type} goes on a ${want} voucher card; "${card.id}" isn't one`, `${f}.account`);
        }
      });
    }

    if (r.collection === 'employmentContracts' || r.collection === 'payrollRuns') {
      if (r.entityId === 'private') err('employment contracts and payroll runs belong to a company entity');
    }
    if (r.collection === 'employmentContracts') {
      const company = get(d.company, 'companies');
      const entityName = r.entityId !== 'private' ? COMPANY_ENTITY_NAMES[r.entityId as 'noisysource'] : '';
      if (company && known(company.data.name) && normName(String(company.data.name)) !== normName(entityName)) {
        err(`a contract under ${r.entityId} must be with the company named "${entityName}" (FinHub matches by name)`, 'company');
      }
      if (d.contractType === 'green_receipt' && (d.ssEmpPct !== 0 || d.ssErPct !== 0 || d.benefits.length)) {
        err('a green-receipt contract has no SS and no benefits');
      }
    }

    if (r.collection === 'payrollRuns') {
      const contract = get(d.contract, 'employmentContracts');
      if (contract) {
        if (contract.entityId !== r.entityId) err(`contract "${contract.id}" is under ${contract.entityId}`, 'contract');
        const c = contract.data;
        if (d.month < c.from.slice(0, 7) || (c.to && d.month > c.to.slice(0, 7))) {
          err(`${d.month} is outside contract "${contract.id}" (${c.from} → ${c.to ?? 'open'})`, 'month');
        }
      }
      const parts = [d.grossCents, d.irsCents, d.ssEmpCents, d.cashBenefitsCents, d.netPaidCents];
      if (parts.every(known)) {
        const expected = d.grossCents - d.irsCents - d.ssEmpCents + d.cashBenefitsCents;
        if (expected !== d.netPaidCents) {
          err(`payslip doesn't add up: gross − IRS − SS + cash benefits = ${expected}, netPaidCents = ${d.netPaidCents}`, 'netPaidCents');
        }
      }
    }

    if (r.collection === 'ecContracts') {
      const days = [...d.nonWorkingDays, ...d.halfDays];
      if (new Set(days).size !== days.length) err('a day is listed twice in nonWorkingDays/halfDays');
      if ([d.dailyRateCents, d.totalDays].every(known)) {
        try {
          const p = computeEcProjection(
            { startDate: d.from, dailyRateCents: d.dailyRateCents, totalDays: d.totalDays },
            d.nonWorkingDays, new Date(`${d.from}T12:00:00`), d.halfDays,
          );
          if (d.to && p.contractEndDate !== d.to) {
            err(`with these days off, ${d.totalDays} days from ${d.from} end on ${p.contractEndDate}, not ${d.to}`, 'to');
          }
        } catch (e: any) {
          err(`end date can't be computed: ${e?.message ?? e}`);
        }
      }
    }

    if (r.collection === 'recurring') {
      if (d.type !== 'transfer' && d.vatCode === undefined) err('income and expense need a vatCode ("por_confirmar" if unknown)', 'vatCode');
      if (d.type === 'transfer' && d.vatCode !== undefined) err('transfers have no VAT', 'vatCode');
      if (d.type === 'transfer' && !d.toAccount) err('a transfer needs toAccount', 'toAccount');
      if (d.frequency === 'annual' && d.monthOfYear === undefined) err('annual needs monthOfYear', 'monthOfYear');
      if (d.frequency === 'once' && d.onceYearMonth === undefined) err('once needs onceYearMonth', 'onceYearMonth');
      if (d.costModel === 'commission' && d.commissionPct === undefined) err('a commission needs commissionPct', 'commissionPct');
      if (known(d.startYearMonth) && known(d.endYearMonth) && d.endYearMonth < d.startYearMonth) err('endYearMonth is before startYearMonth', 'endYearMonth');
    }
  }

  checkVersions(records.filter(r => r.collection === 'employmentContracts'),
    d => (known(d.person) && known(d.company) ? `${d.person}|${d.company}` : null), 'contract', errors);
  checkVersions(records.filter(r => r.collection === 'incomeSources'),
    d => (known(d.person) && known(d.employerName) ? `${d.person}|${normName(d.employerName)}` : null), 'income source', errors);
  checkVersions(records.filter(r => r.collection === 'ecContracts'),
    d => (known(d.clientName) ? `${normName(d.clientName)}|${normName(known(d.projectName) ? d.projectName : '')}` : null), 'EC contract', errors);

  // Refused: a TODO inside, or a reference to a refused record (repeat until nothing changes).
  const reasons = new Map<SeedRecord, string[]>();
  for (const r of records) {
    const todos = findTodos(r.data);
    if (todos.length) reasons.set(r, todos.map(p => `TODO in ${p}`));
  }
  const refusedKeys = () => new Set([...reasons.keys()].map(r => r.data.key).filter(Boolean));
  for (let changed = true; changed;) {
    changed = false;
    const refusedNow = refusedKeys();
    for (const r of records) {
      if (reasons.has(r)) continue;
      const deps = referencesOf(r).filter(([, , k]) => refusedNow.has(k));
      if (deps.length) {
        reasons.set(r, deps.map(([field, , k]) => `${field} → "${k}" is refused`));
        changed = true;
      }
    }
  }

  const refused = records
    .filter(r => reasons.has(r))
    .map(r => ({ collection: r.collection, entityId: r.entityId, id: r.id, path: r.path, reasons: reasons.get(r)! }));

  return {
    seed,
    errors,
    refused,
    importable: errors.length ? [] : records.filter(r => !reasons.has(r)),
  };
}
