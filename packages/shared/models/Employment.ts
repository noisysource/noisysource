import { Timestamp } from 'firebase/firestore';

export interface BenefitConfig {
  type: string;
  perMonthCents?: number;
  perDayCents?: number;
  daysPerMonth?: number;
  subjectToIRS: boolean;
  subjectToSS: boolean;
  benefitAccountId: string;
  expenseCategoryId: string;
  payableCategoryId: string;
  providerFeePct?: number;
  providerFeeCents?: number;
}

export interface EmploymentContractDoc {
  id: string;
  orgId: string;
  companyId: string;
  personId: string;
  active: boolean;
  grossMonthlyCents?: number | null;
  hourlyRateCents?: number | null;
  irsRatePct: number;
  ssEmpPct: number;
  ssErPct: number;
  payDay: number;
  startDate: Timestamp;
  endDate?: Timestamp;
  benefits: BenefitConfig[];
  netPayAccountId: string;
}