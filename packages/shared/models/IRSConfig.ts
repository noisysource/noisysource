export interface PersonIncomeSource {
  personName: string;        // "Renato" | "Marisa"
  employerName: string;      // "NoisySource", "Exquisite Talent", "ASFD", etc.
  grossAnnualCents: number;
  irsWithheldCents: number;
  ssEmployeeCents: number;   // 11% of gross (Category A)
}

export interface IRSDeductions {
  healthCents: number;       // total health expenses paid (15% deductible, max €1,000 credit)
  educationCents: number;    // total education expenses paid (30% deductible, max €800 credit)
  housingCents: number;      // rent paid (15% deductible, max €502 credit)
}

export interface IRSConfigDoc {
  id: string;                // year as string e.g. "2025"
  year: number;
  incomes: PersonIncomeSource[];
  deductions: IRSDeductions;
  updatedAt?: Date;
}
