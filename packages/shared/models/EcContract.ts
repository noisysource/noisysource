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
  createdAt?: Date;
}

/** Derived field — not stored */
export function estimatedMonthlyInvoiceCents(c: EcContractDoc): number {
  return c.dailyRateCents * c.expectedDaysPerMonth;
}
