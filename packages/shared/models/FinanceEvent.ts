export type FinanceEntityId = 'private' | 'noisysource' | 'noisyphocus';

export type FinanceEventType =
  // EC contract markers (amountCents = 0 for submission; positive for payment)
  | 'ec_ts_submission'
  | 'ec_payment'
  // Salary / employment income
  | 'salary_credit'
  // General
  | 'income'
  | 'expense'
  | 'transfer'
  // Tax
  | 'tax_payment'
  // Vacation / day off (cross-entity)
  | 'vacation'
  // KidClub
  | 'kidclub_revenue';

export type FinanceEventStatus = 'planned' | 'confirmed' | 'cancelled' | 'corrected';

export type FinanceEventSource =
  | 'ec_contract'
  | 'employment_contract'
  | 'recurring'
  | 'manual'
  | 'vacation'
  | 'kidclub_billing';

export interface FinanceEvent {
  id: string;
  entityId: FinanceEntityId;
  type: FinanceEventType;
  /** YYYY-MM-DD */
  date: string;
  /** Signed cents: positive = income, negative = expense, 0 = marker */
  amountCents: number;
  status: FinanceEventStatus;
  description?: string;
  accountId?: string;
  toAccountId?: string;
  categoryId?: string;
  /** Which template/domain generated or owns this event */
  sourceType?: FinanceEventSource;
  /** ID of the source document (contract, recurring entry, etc.) */
  sourceId?: string;
  tags?: string[];
  /** Free-form per-type data (e.g. vacation days count, TS month) */
  metadata?: Record<string, unknown>;
  /** ID of the event that supersedes this one (immutable correction pattern) */
  correctedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** A computed (in-memory) event not yet stored in Firestore */
export type ComputedEvent = Omit<FinanceEvent, 'id' | 'createdAt' | 'updatedAt'> & {
  /** Unique stable key for React rendering */
  key: string;
  /** true = generated from template, not stored */
  computed: true;
};
