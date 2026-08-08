export type RecurringType = 'income' | 'expense' | 'transfer';
export type RecurringFrequency = 'monthly' | 'quarterly' | 'annual' | 'once';

export interface RecurringEntryDoc {
  id: string;
  type: RecurringType;
  description: string;
  amountCents: number;
  accountId?: string;       // source account (income/expense) or from-account (transfer)
  toAccountId?: string;     // target account (transfer only)
  categoryId?: string;
  frequency: RecurringFrequency;
  dayOfMonth: number;       // 1-31 — day within the month it occurs
  monthOfYear?: number;     // 1-12 — required for frequency = 'annual'
  startYearMonth?: string;  // "YYYY-MM" — inclusive; absent = no limit
  endYearMonth?: string;    // "YYYY-MM" — inclusive; absent = indefinite
  onceYearMonth?: string;   // "YYYY-MM" — for frequency = 'once'
  active: boolean;
  sourceId?: string;        // e.g. "ec:{id}" or "emp:{id}:ns" — used for upsert-by-source
  reimbursable?: boolean;    // true = paid from a personal account on behalf of this entity
  paidByAccountId?: string;  // e.g. 'private-revolut' — account that actually pays; entity derived by prefix
  lastReimbursedYM?: string; // "YYYY-MM" — month through which reimbursement was settled
  createdAt?: Date;
}

export type ForecastEventStatus = 'forecast' | 'confirmed' | 'skipped';

export interface ForecastEventDoc {
  id: string;               // deterministic: "{recurringId}:{YYYY-MM}" or generated for one-offs
  recurringId?: string;     // parent recurring entry (absent for manual one-offs)
  type: RecurringType;
  description: string;
  amountCents: number;
  accountId?: string;
  toAccountId?: string;
  categoryId?: string;
  yearMonth: string;        // "YYYY-MM"
  dayOfMonth: number;
  status: ForecastEventStatus;
  createdAt?: Date;
}
