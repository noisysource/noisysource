import { RecurrenceRule } from './FinancialEvent';

/**
 * Allowed types of accounts in the ledger.
 */
export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

/**
 * Defines a chart of account entry. Each account belongs to an organisation
 * (`orgId`) and has a currency associated with it. Accounts that are no
 * longer in use should be marked inactive via the `active` flag rather
 * than deleted, to maintain historical integrity.
 */
export interface Account {
  id: string;
  orgId: string;
  name: string;
  type: AccountType;
  /** ISO currency code, e.g. 'EUR' */
  currency: string;
  active: boolean;
  createdAt: Date;
}

/**
 * Indicates whether a posting is a debit or a credit. In a double-entry
 * ledger all debits must sum to the same amount as all credits.
 */
export type PostingSide = 'debit' | 'credit';

/**
 * A posting represents one half of a journal entry. A complete
 * `LedgerTransaction` will contain multiple postings whose net amount
 * sums to zero (debits minus credits). The `personId` and `tag` fields
 * are optional metadata that can be used to track payroll or category
 * associations without polluting the core account definitions.
 */
export interface Posting {
  accountId: string;
  /** Amount in minor units (e.g. cents). Always positive. */
  amountCents: number;
  side: PostingSide;
  personId?: string;
  tag?: string;
}

/**
 * A transaction is a journal entry that must be balanced: the sum of
 * `debit` postings must equal the sum of `credit` postings. Use the
 * `source` property to indicate how the transaction was generated
 * (manual entry, planned event, payroll calculation, etc.).
 */
export interface LedgerTransaction {
  id: string;
  orgId: string;
  date: Date;
  label: string;
  /** ISO currency code for all postings in this transaction */
  currency: string;
  postings: Posting[];
  createdBy: string;
  createdAt: Date;
  source?: {
    type: 'manual' | 'planned' | 'payroll' | 'import';
    refId?: string;
  };
  idempotencyKey?: string;
}

/**
 * Distinguishes the structural shape of a planned transaction template.
 * - `single`: a basic income or expense that affects one account and
 *   the counterparty is implicitly a bank or default cash account.
 * - `transfer`: moves money between two accounts with equal debit
 *   and credit amounts.
 * - `split`: supports complex journal entries (e.g. payroll accruals) with
 *   multiple debit and credit lines.
 */
export type TemplateKind = 'single' | 'transfer' | 'split';

export interface SingleTemplate {
  kind: 'single';
  /** Target account for the single transaction */
  accountId: string;
  amountCents: number;
  type: 'income' | 'expense';
}

export interface TransferTemplate {
  kind: 'transfer';
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
}

export interface SplitTemplate {
  kind: 'split';
  lines: {
    accountId: string;
    amountCents: number;
    side: PostingSide;
    personId?: string;
    tag?: string;
  }[];
}

/**
 * TemplateShape can be one of `single`, `transfer`, or `split`. This
 * corresponds to how the resulting postings will be constructed when
 * converting the template into an actual `PlannedTransactionInstance` or
 * `LedgerTransaction`.
 */
export type TemplateShape = SingleTemplate | TransferTemplate | SplitTemplate;

/**
 * Represents a recurring template that can be expanded into planned
 * transactions. Templates live at the organisation level and can be
 * disabled via the `active` flag without deleting them, allowing a
 * record of past schedules to remain in the system.
 */
export interface PlannedTransactionTemplate {
  id: string;
  orgId: string;
  label: string;
  kind: TemplateKind;
  currency: string;
  cashAccountId?: string;
  dateAnchor: Date;
  recurrence: RecurrenceRule;
  shape: TemplateShape;
  tags?: string[];
  active: boolean;
  createdBy: string;
  createdAt: Date;
}

export type PlannedEventStatus = 'draft' | 'approved';

/**
 * A concrete instance of a planned transaction. These are generated
 * from templates for a specific date and can be either approved or
 * remain in draft status. Once approved, a planned instance can be
 * posted into the ledger, after which it should no longer be modified.
 */
export interface PlannedTransactionInstance {
  id: string;
  templateId: string;
  orgId: string;
  label: string;
  kind: TemplateKind;
  currency: string;
  cashAccountId?: string;
  date: Date;
  status: PlannedEventStatus;
  shape: TemplateShape;
  idempotencyKey: string;
}