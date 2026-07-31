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
  nonWorkingDays?: string[];   // ISO date strings e.g. ["2026-08-15", "2026-12-25"]
  createdAt?: Date;
}

/** Derived field — not stored */
export function estimatedMonthlyInvoiceCents(c: EcContractDoc): number {
  return c.dailyRateCents * c.expectedDaysPerMonth;
}
