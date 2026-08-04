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
  startDate?: string;        // ISO "YYYY-MM-DD"
  notes?: string;
  createdAt?: any;
}

export type { BenefitConfig };
