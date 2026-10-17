import type { BenefitConfig } from "./Employment";

export interface IncomeSourceDoc {
  id: string;
  personName: string;        // "Renato" | "Marisa" | free text
  employerName: string;      // "Exquisite Talent" | "ASFD"
  grossMonthlyCents: number;
  irsRatePct: number;
  ssEmpPct: number;          // typically 11%
  payDay: number;
  netPayAccountId: string;
  active: boolean;
  benefits: BenefitConfig[];
  startDate?: string;        // ISO "YYYY-MM-DD" — first month it pays
  /** ISO "YYYY-MM-DD" — last month it pays (inclusive). A raise is a new source from the next month. */
  endDate?: string;
  notes?: string;
  createdAt?: any;
}

export type { BenefitConfig };

/** True when an active source pays in that month: start/end month inclusive (ISO dates sliced, no time zone). */
export function incomeSourceInForce(
  source: Pick<IncomeSourceDoc, "active" | "startDate" | "endDate">,
  year: number,
  month1to12: number,
): boolean {
  if (source.active === false) return false;
  const ym = `${year}-${String(month1to12).padStart(2, "0")}`;
  if (source.startDate && ym < source.startDate.slice(0, 7)) return false;
  if (source.endDate && ym > source.endDate.slice(0, 7)) return false;
  return true;
}

/** A benefit's monthly total: per month + per day × days (no days = 0, unlike employment contracts). */
function benefitTotalCents(b: BenefitConfig): number {
  const perMonth = (b as any).perMonthCents ?? 0;
  const perDay = (b as any).perDayCents ?? 0;
  const days = (b as any).daysPerMonth ?? 0;
  return perMonth + perDay * days;
}

export type IncomeSourceMonth = {
  grossCents: number;
  irsCents: number;
  ssCents: number;
  /** gross − IRS − SS */
  netCents: number;
  /** Benefits with no card account, paid in cash with the salary (e.g. a meal allowance). */
  cashBenefitsCents: number;
  /** What lands in netPayAccountId: net + cash benefits. */
  netPayCents: number;
  /** Benefits loaded on a card account, each credited to that account. */
  cardBenefits: Array<{ type: string; totalCents: number; benefitAccountId: string }>;
};

/**
 * One month of an external income source. IRS and SS on the gross only, as before; cash benefits
 * are added to the transfer like employment contracts already do (the ASFD meal allowance).
 */
export function incomeSourceMonth(source: IncomeSourceDoc): IncomeSourceMonth {
  const grossCents = source.grossMonthlyCents;
  const irsCents = Math.round(grossCents * (source.irsRatePct ?? 0) / 100);
  const ssCents = Math.round(grossCents * (source.ssEmpPct ?? 11) / 100);
  const netCents = grossCents - irsCents - ssCents;
  let cashBenefitsCents = 0;
  const cardBenefits: IncomeSourceMonth["cardBenefits"] = [];
  for (const b of source.benefits ?? []) {
    const totalCents = benefitTotalCents(b);
    if (totalCents <= 0) continue;
    if (b.benefitAccountId) cardBenefits.push({ type: b.type, totalCents, benefitAccountId: b.benefitAccountId });
    else cashBenefitsCents += totalCents;
  }
  return { grossCents, irsCents, ssCents, netCents, cashBenefitsCents, netPayCents: netCents + cashBenefitsCents, cardBenefits };
}
