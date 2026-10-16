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

function localIsoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The EC contract in force on `day`: active, started on or before it, and not ended before it
 * (endDate, which the form sets from the projection; none = open). A rate change is a new contract
 * from the day it applies, so several can exist: the latest start wins. None in force → the next one
 * to start, so the Dashboard calendar shows what's coming; none of those either → null.
 */
export function ecContractInForce<T extends EcContractDoc>(contracts: readonly T[], day: Date): T | null {
  const today = localIsoDay(day);
  const active = contracts.filter(c => c.active && c.startDate);
  const started = active
    .filter(c => localIsoDay(c.startDate!) <= today && (!c.endDate || localIsoDay(c.endDate) >= today))
    .sort((a, b) => b.startDate!.getTime() - a.startDate!.getTime());
  if (started.length) return started[0];
  const upcoming = active
    .filter(c => localIsoDay(c.startDate!) > today)
    .sort((a, b) => a.startDate!.getTime() - b.startDate!.getTime());
  return upcoming[0] ?? null;
}

/** VAT code of an EC contract's invoices. Contracts saved before the VAT convention are exempt too. */
export function ecContractVatCode(c: EcContractDoc): VatCode {
  return c.vatCode ?? 'isento';
}
