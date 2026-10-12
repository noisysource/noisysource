import type { VatCode } from '../lib/vat';

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
  /** VAT on the invoices. EC invoices carry no PT VAT: 'isento' (Renato, 2026-10-12). */
  vatCode?: VatCode;
  /** Pre-convention field, always saved as 0. Ignored: read the VAT through ecContractVatCode(). */
  ivaRatePct?: number;
  createdAt?: Date;
}

/** Derived field — not stored */
export function estimatedMonthlyInvoiceCents(c: EcContractDoc): number {
  return c.dailyRateCents * c.expectedDaysPerMonth;
}

/** VAT code of an EC contract's invoices. Contracts saved before the VAT convention are exempt too. */
export function ecContractVatCode(c: EcContractDoc): VatCode {
  return c.vatCode ?? 'isento';
}
