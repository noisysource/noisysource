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
  orgId?: string;
  companyId: string;
  personId: string;
  active: boolean;
  // 'green_receipt' (recibo verde / freelance): no employer/employee social
  // security contribution — ssEmpPct/ssErPct should be 0, and `benefits`
  // (subsídios) don't apply. Undefined/'employee' is a regular salaried
  // contract — the default for backward-compat with contracts saved before
  // this field existed. `buildPayrollPreview` (packages/shared/lib/payroll.ts)
  // doesn't need to know about this at all: costToEmployerCents = gross +
  // ssEr + benefits already comes out correct for a green-receipt contract
  // as long as ssErPct/benefits are 0 — this field only drives the UI.
  contractType?: 'employee' | 'green_receipt';
  paymentType?: 'salary' | 'hourly';
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
  flowToPrivate?: boolean;  // true → net salary auto-synced as income in Private entity
}