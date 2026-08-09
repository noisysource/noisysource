export interface EcContractDoc {
  id: string;
  clientName: string;
  projectName?: string;
  dailyRateCents: number;
  totalDays?: number;
  expectedDaysPerMonth: number;
  startDate?: Date;
  endDate?: Date;
  active: boolean;
  nonWorkingDays?: string[];   // ISO date strings — full day off (counts as 1 day)
  halfDays?: string[];         // ISO date strings — half day off (counts as 0.5 day)
  daysToPayment?: number;      // calendar days from TS submission to expected payment
  paymentAccountId?: string;   // account that receives EC payments
  ivaRatePct?: number;         // IVA rate charged on invoices (default 23 in PT for B2B services)
  createdAt?: Date;
}

/** Derived field — not stored */
export function estimatedMonthlyInvoiceCents(c: EcContractDoc): number {
  return c.dailyRateCents * c.expectedDaysPerMonth;
}
