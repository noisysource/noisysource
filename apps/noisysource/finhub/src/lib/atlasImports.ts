// What Atlas imported: finhub_books/{book}/atlas_imports/{id}, one per entity
// and month (decided with Renato, 2026-11-23). Atlas reads the documents
// (payslips, bank statements) and writes drafts in the shapes this app's own
// review workbench uses (DocumentsHubView, "Drive Discovery & Auto-Generation
// Preview"); nothing reaches the books until Renato commits them there.
//
// Atlas is trusted to write here, but not to be right: every draft is
// coerced to its type and bounded before it reaches the workbench.
import type { CommittedSnapshot } from '../utils/committed';
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { db, FINHUB_BOOK_ID } from '../firebase';
import { isMonthKey, MAX_CONTRACT_VERSIONS } from '../utils/contractVersions';
import type {
  AccountType,
  BillingFrequency,
  EntityType,
  ContractTerms,
  ContractVersion,
  ContractPaySchedule,
  FacilityType,
  MealPaymentMethod,
  ParsedPayslipDraft,
  SuggestedContractDraft,
  SuggestedFacilityDraft,
  SuggestedSubscriptionDraft,
  TransactionType,
} from '../types/finance';

export interface AtlasStatementLine {
  date: string;
  description: string;
  amount: number;
  direction: 'credit' | 'debit';
  vendor: string;
  category: string;
  type: TransactionType;
  ivaRate: number;
  ivaDeductible: boolean;
}

export interface AtlasStatement {
  filename: string;
  statementPeriod: string;
  openingBalance: number;
  closingBalance: number;
  lines: AtlasStatementLine[];
}

export interface AtlasSource {
  kind: 'drive' | 'gmail';
  name: string;
  id: string;
  link: string;
}

export interface AtlasImport {
  id: string;
  entityHint: string;
  month: string;
  summary: string;
  sources: AtlasSource[];
  statements: AtlasStatement[];
  payslips: ParsedPayslipDraft[];
  contracts: SuggestedContractDraft[];
  subscriptions: SuggestedSubscriptionDraft[];
  facilities: SuggestedFacilityDraft[];
  /** The book's setup an agent proposes from the documents: entities, accounts, loans. */
  setup: AtlasSetup;
  /** Which agent proposed it. */
  createdBy: 'atlas' | 'claude-code';
  createdAtMs: number;
}

/** Entities, accounts and loans to create, matched by name (entities by entityKey). Never bank account numbers. */
export interface AtlasSetup {
  entities: { name: string; entityType: EntityType; registrationCode: string }[];
  accounts: { entityName: string; name: string; institution: string; accountType: AccountType; balance: number; balanceDate: string }[];
  loans: {
    entityName: string;
    accountName: string;
    name: string;
    lender: string;
    facilityType: FacilityType;
    principalOrLimit: number;
    currentBalance: number;
    apr: number;
    monthlyPayment: number;
    dueDay: number;
    maturityDate: string;
  }[];
}

type O = Record<string, unknown>;
const obj = (v: unknown): O => (v && typeof v === 'object' && !Array.isArray(v) ? (v as O) : {});
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const str = (v: unknown, max = 300): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const bool = (v: unknown): boolean => v === true;
const isoDate = (v: unknown): string => {
  const s = str(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
};
const oneOf = <T extends string>(options: readonly T[], v: unknown, fallback: T): T =>
  typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback;

const TX_TYPES: readonly TransactionType[] = ['income', 'expense', 'transfer', 'debt_payment', 'payroll'];
const PAY_SCHEDULES: readonly ContractPaySchedule[] = ['14_months', '12_months'];
const MEAL_METHODS: readonly MealPaymentMethod[] = ['card', 'cash', 'none'];
const FREQUENCIES: readonly BillingFrequency[] = ['monthly', 'annual'];
const FACILITY_TYPES: readonly FacilityType[] = ['term_loan', 'credit_line', 'credit_card', 'mortgage', 'equipment_loan'];

const lineOf = (raw: unknown): AtlasStatementLine | undefined => {
  const l = obj(raw);
  const date = isoDate(l.date);
  if (!date) return undefined;
  const direction = l.direction === 'credit' ? 'credit' : 'debit';
  return {
    date,
    description: str(l.description, 300),
    amount: Math.abs(num(l.amount)),
    direction,
    vendor: str(l.vendor, 120),
    category: str(l.category, 80) || (direction === 'credit' ? 'Revenue & Inflows' : 'Operating Expense'),
    type: oneOf(TX_TYPES, l.type, direction === 'credit' ? 'income' : 'expense'),
    ivaRate: num(l.ivaRate),
    ivaDeductible: bool(l.ivaDeductible),
  };
};

export const statementOf = (raw: unknown): AtlasStatement => {
  const s = obj(raw);
  return {
    filename: str(s.filename, 200),
    statementPeriod: str(s.statementPeriod, 60),
    openingBalance: num(s.openingBalance),
    closingBalance: num(s.closingBalance),
    lines: list(s.lines, 2000).map(lineOf).filter((l): l is AtlasStatementLine => l !== undefined),
  };
};

export const payslipOf = (raw: unknown): ParsedPayslipDraft => {
  const p = obj(raw);
  return {
    employeeName: str(p.employeeName, 120),
    periodStart: isoDate(p.periodStart),
    periodEnd: isoDate(p.periodEnd),
    payDate: isoDate(p.payDate),
    taxDueDate: isoDate(p.taxDueDate),
    grossPay: num(p.grossPay),
    netPay: num(p.netPay),
    employeeWithholdings: num(p.employeeWithholdings),
    employerTaxes: num(p.employerTaxes),
    employerContributions: num(p.employerContributions),
    notes: str(p.notes, 1000),
    sourceFilename: str(p.sourceFilename, 200),
  };
};

export const contractOf = (raw: unknown): SuggestedContractDraft => {
  const c = obj(raw);
  return {
    workerName: str(c.workerName, 120),
    roleTitle: str(c.roleTitle, 120),
    employerName: str(c.employerName, 120),
    isOwnerHint: bool(c.isOwnerHint),
    paySchedule: oneOf(PAY_SCHEDULES, c.paySchedule, '14_months'),
    baseGrossMonthly: num(c.baseGrossMonthly),
    irsRate: num(c.irsRate),
    employeeSsRate: num(c.employeeSsRate),
    employerSsRate: num(c.employerSsRate),
    mealAllowanceDaily: num(c.mealAllowanceDaily),
    mealPaymentMethod: oneOf(MEAL_METHODS, c.mealPaymentMethod, 'none'),
    childVoucherMonthly: num(c.childVoucherMonthly),
    otherBenefitName: str(c.otherBenefitName, 80),
    otherBenefitMonthly: num(c.otherBenefitMonthly),
    notes: str(c.notes, 1000),
    versions: list(c.versions, MAX_CONTRACT_VERSIONS).flatMap((v): ContractVersion[] => {
      const x = obj(v);
      if (!isMonthKey(x.effectiveFrom)) return [];
      return [{ effectiveFrom: x.effectiveFrom, note: str(x.note, 200), terms: termsDraftOf(obj(x.terms)) }];
    }),
  };
};

/** A version's terms from Atlas: the voucher and benefit tax flags are FinHub's (off), as for new contracts. */
const termsDraftOf = (t: O): ContractTerms => ({
  paySchedule: oneOf(PAY_SCHEDULES, t.paySchedule, '14_months'),
  baseGrossMonthly: num(t.baseGrossMonthly),
  irsRate: Math.min(100, num(t.irsRate)),
  employeeSsRate: Math.min(100, num(t.employeeSsRate)),
  employerSsRate: Math.min(100, num(t.employerSsRate)),
  mealAllowanceDaily: num(t.mealAllowanceDaily),
  mealPaymentMethod: oneOf(MEAL_METHODS, t.mealPaymentMethod, 'none'),
  childVoucherMonthly: num(t.childVoucherMonthly),
  childVoucherSubjectToIrs: false,
  childVoucherSubjectToSs: false,
  otherBenefitName: str(t.otherBenefitName, 60),
  otherBenefitMonthly: num(t.otherBenefitMonthly),
  otherBenefitSubjectToIrs: false,
  otherBenefitSubjectToSs: false,
});

export const subscriptionOf = (raw: unknown): SuggestedSubscriptionDraft => {
  const s = obj(raw);
  const day = Math.round(num(s.billingDay));
  const month = Math.round(num(s.billingMonth));
  return {
    name: str(s.name, 120),
    vendor: str(s.vendor, 120),
    category: str(s.category, 80) || 'Operating Expense',
    amount: Math.abs(num(s.amount)),
    frequency: oneOf(FREQUENCIES, s.frequency, 'monthly'),
    billingDay: day >= 1 && day <= 31 ? day : 1,
    billingMonth: month >= 1 && month <= 12 ? month : 1,
    ivaRate: num(s.ivaRate),
    ivaDeductible: bool(s.ivaDeductible),
    hasInvoice: bool(s.hasInvoice),
    matchCount: Math.max(1, Math.round(num(s.matchCount))),
    sampleDates: list(s.sampleDates, 24).map(isoDate).filter(Boolean),
    notes: str(s.notes, 1000),
  };
};

export const facilityOf = (raw: unknown): SuggestedFacilityDraft => {
  const f = obj(raw);
  const day = Math.round(num(f.dueDay));
  return {
    name: str(f.name, 120),
    lender: str(f.lender, 120),
    facilityType: oneOf(FACILITY_TYPES, f.facilityType, 'term_loan'),
    monthlyPayment: Math.abs(num(f.monthlyPayment)),
    dueDay: day >= 1 && day <= 31 ? day : 1,
    apr: num(f.apr),
    matchCount: Math.max(1, Math.round(num(f.matchCount))),
    notes: str(f.notes, 1000),
  };
};

const sourceOf = (raw: unknown): AtlasSource => {
  const s = obj(raw);
  const link = str(s.link, 500);
  return {
    kind: s.kind === 'gmail' ? 'gmail' : 'drive',
    name: str(s.name, 200),
    id: str(s.id, 200),
    link: /^https:\/\//.test(link) ? link : '',
  };
};

const millis = (v: unknown): number => {
  const t = v as { toMillis?: () => number } | undefined;
  return typeof t?.toMillis === 'function' ? t.toMillis() : 0;
};

/** One import as the app may use it, whatever Atlas wrote. */
const ACCOUNT_TYPES: readonly AccountType[] = ['checking', 'savings', 'treasury', 'cash', 'meal_voucher', 'child_voucher'];
const DATE = /^20\d\d-\d\d-\d\d$/;

export const setupOf = (raw: unknown): AtlasSetup => {
  const d = obj(raw);
  return {
    entities: list(d.entities, 10).map((v) => {
      const e = obj(v);
      const entityType: EntityType = e.entityType === 'personal' ? 'personal' : 'company';
      return { name: str(e.name, 100), entityType, registrationCode: str(e.registrationCode, 20).replace(/[^0-9A-Za-z]/g, '') };
    }).filter((e) => e.name),
    accounts: list(d.accounts, 20).map((v) => {
      const a = obj(v);
      const date = str(a.balanceDate, 10);
      return {
        entityName: str(a.entityName, 100),
        name: str(a.name, 100),
        institution: str(a.institution, 100),
        accountType: oneOf(ACCOUNT_TYPES, a.accountType, 'checking'),
        balance: num(a.balance),
        balanceDate: DATE.test(date) ? date : '',
      };
    }).filter((a) => a.name && a.entityName),
    loans: list(d.loans, 20).map((v) => {
      const l = obj(v);
      const date = str(l.maturityDate, 10);
      return {
        entityName: str(l.entityName, 100),
        accountName: str(l.accountName, 100),
        name: str(l.name, 100),
        lender: str(l.lender, 100),
        facilityType: oneOf(FACILITY_TYPES, l.facilityType, 'term_loan'),
        principalOrLimit: num(l.principalOrLimit),
        currentBalance: num(l.currentBalance),
        apr: Math.min(100, num(l.apr)),
        monthlyPayment: num(l.monthlyPayment),
        dueDay: Math.min(28, Math.max(1, Math.round(num(l.dueDay)) || 1)),
        maturityDate: DATE.test(date) ? date : '',
      };
    }).filter((l) => l.name && l.entityName),
  };
};

export const atlasImportOf = (id: string, raw: unknown): AtlasImport => {
  const d = obj(raw);
  return {
    id,
    entityHint: str(d.entityHint, 100),
    month: str(d.month, 7),
    summary: str(d.summary, 4000),
    sources: list(d.sources, 300).map(sourceOf),
    statements: list(d.statements, 20).map(statementOf),
    payslips: list(d.payslips, 60).map(payslipOf),
    contracts: list(d.contracts, 20).map(contractOf),
    subscriptions: list(d.subscriptions, 200).map(subscriptionOf),
    facilities: list(d.facilities, 20).map(facilityOf),
    setup: setupOf(d.setup),
    createdBy: d.createdBy === 'claude-code' ? 'claude-code' : 'atlas',
    createdAtMs: millis(d.createdAt),
  };
};

const COLLECTION = `finhub_books/${FINHUB_BOOK_ID}/atlas_imports`;

/** The imports waiting for him, newest month first. */
export const watchPendingAtlasImports = (
  onChange: (imports: AtlasImport[]) => void,
  onError: (err: Error) => void
): Unsubscribe =>
  onSnapshot(
    query(collection(db, COLLECTION), where('status', '==', 'pending')),
    (snap) =>
      onChange(
        snap.docs
          .map((d) => atlasImportOf(d.id, d.data()))
          .sort((a, b) => b.month.localeCompare(a.month) || a.entityHint.localeCompare(b.entityHint))
      ),
    onError
  );

/**
 * He committed it in the workbench, or set it aside. On commit, what he actually committed
 * (`committedOf`, utils/committed.ts) is kept beside Atlas's proposal, so Atlas can learn
 * from his corrections.
 */
export const decideAtlasImport = (id: string, status: 'applied' | 'dismissed', committed?: CommittedSnapshot) =>
  updateDoc(doc(db, COLLECTION, id), { status, decidedAt: serverTimestamp(), ...(status === 'applied' && committed ? { committed } : {}) });

/** The entity an import is for: by name, as Atlas named it. */
export { entityForHint, entityKey } from '../utils/entityMatch';

/** What an import holds, in a line. */
export const countsOf = (i: AtlasImport): string => {
  const lines = i.statements.reduce((n, s) => n + s.lines.length, 0);
  const parts = [
    i.setup.entities.length > 0 ? `${i.setup.entities.length} entit${i.setup.entities.length === 1 ? 'y' : 'ies'}` : '',
    i.setup.accounts.length > 0 ? `${i.setup.accounts.length} account${i.setup.accounts.length === 1 ? '' : 's'}` : '',
    i.setup.loans.length > 0 ? `${i.setup.loans.length} loan${i.setup.loans.length === 1 ? '' : 's'}` : '',
    i.statements.length > 0 ? `${i.statements.length} statement${i.statements.length === 1 ? '' : 's'} (${lines} lines)` : '',
    i.payslips.length > 0 ? `${i.payslips.length} payslip${i.payslips.length === 1 ? '' : 's'}` : '',
    i.contracts.length > 0 ? `${i.contracts.length} contract${i.contracts.length === 1 ? '' : 's'}` : '',
    i.subscriptions.length > 0 ? `${i.subscriptions.length} subscription${i.subscriptions.length === 1 ? '' : 's'}` : '',
    i.facilities.length > 0 ? `${i.facilities.length} loan${i.facilities.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'nothing found';
};
