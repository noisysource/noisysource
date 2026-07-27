export interface PayrollRunDoc {
  id: string;
  contractId: string;
  companyId: string;
  personId: string;
  year: number;
  month: number; // 1-12
  grossCents: number;
  irsCents: number;
  ssEmpCents: number;
  ssErCents: number;
  netCents: number;
  benefitsCents: number;
  costToEmployerCents: number;
  cashOutCents: number;
  confirmedAt: Date;
  sourceAccountId?: string;
}
