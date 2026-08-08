export type CreditType = 'mortgage' | 'auto' | 'personal' | 'business';
export type RateType = 'fixed' | 'variable';

export interface RateHistoryEntry {
  effectiveYearMonth: string;  // "YYYY-MM" — month this rate takes effect
  annualRatePct: number;
  note?: string;               // e.g. "Euribor 6M review — Oct 2026"
}

export interface BalanceSyncEntry {
  syncYearMonth: string;       // "YYYY-MM" — month of the sync
  actualOutstandingCents: number; // balance from the bank statement
  computedOutstandingCents: number; // what the engine had calculated
  deltaCents: number;          // actual − computed (negative = bank owes more than we thought)
  note?: string;
}

export interface CreditContractDoc {
  id: string;
  type: CreditType;
  description: string;         // "Casa Lisboa", "Tesla Model Y #1"
  creditor: string;            // "BPI", "CGD", "Montepio"
  loanAmountCents: number;     // original principal
  startYearMonth: string;      // "YYYY-MM" — month of FIRST payment
  termMonths: number;          // total number of monthly payments
  rateType: RateType;
  annualRatePct: number;       // current TAN (effective rate today)
  spreadPct?: number;          // variable only: fixed spread over Euribor
  rateHistory?: RateHistoryEntry[];   // chronological log of rate changes
  balanceSyncs?: BalanceSyncEntry[];  // reconciliation snapshots — engine restarts from latest
  interestOnlyPhase?: boolean; // true = construction phase: only interest is paid, no capital amortization
  accountId?: string;
  dayOfMonth?: number;         // payment day (default 15)
  active: boolean;
  notes?: string;
  createdAt?: Date;
}
