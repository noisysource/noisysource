import type { PersonIncomeSource, IRSDeductions } from '../models/IRSConfig';

// ─── 2024/2025 IRS brackets — mainland Portugal ──────────────────────────────
// Values in euros (not cents). Progressive marginal rates.
// For joint filing (casados), income is split by 2, tax computed, then doubled.
const BRACKETS = [
  { upToEur: 7_703,  rate: 0.1325 },
  { upToEur: 11_623, rate: 0.18 },
  { upToEur: 16_472, rate: 0.23 },
  { upToEur: 21_321, rate: 0.26 },
  { upToEur: 27_146, rate: 0.3275 },
  { upToEur: 39_791, rate: 0.37 },
  { upToEur: 51_997, rate: 0.435 },
  { upToEur: 81_199, rate: 0.45 },
  { upToEur: Infinity, rate: 0.48 },
];

const SPECIFIC_DEDUCTION_EUR = 4_104;        // Category A specific deduction per person
const SPECIFIC_DEDUCTION_SS_RATE = 0.75;     // 75% of SS contributions, if higher
const SPECIFIC_DEDUCTION_CAP_EUR = 11_573;   // maximum specific deduction per person

const HEALTH_RATE = 0.15;
const HEALTH_CAP_EUR = 1_000;
const EDUCATION_RATE = 0.30;
const EDUCATION_CAP_EUR = 800;
const HOUSING_RATE = 0.15;
const HOUSING_CAP_EUR = 502;

function centsToEur(cents: number) { return cents / 100; }
function eurToCents(eur: number) { return Math.round(eur * 100); }

/** Progressive tax on a single-filer taxable income in EUR */
function bracketTax(taxableEur: number): number {
  let tax = 0;
  let prev = 0;
  for (const b of BRACKETS) {
    if (taxableEur <= prev) break;
    const slice = Math.min(taxableEur, b.upToEur) - prev;
    tax += slice * b.rate;
    prev = b.upToEur;
    if (taxableEur <= b.upToEur) break;
  }
  return tax;
}

// ─── per-person specific deduction ───────────────────────────────────────────

export function specificDeductionCents(source: PersonIncomeSource): number {
  const ssBasedEur = centsToEur(source.ssEmployeeCents) * SPECIFIC_DEDUCTION_SS_RATE;
  const deductEur = Math.min(
    Math.max(SPECIFIC_DEDUCTION_EUR, ssBasedEur),
    SPECIFIC_DEDUCTION_CAP_EUR
  );
  return eurToCents(deductEur);
}

export function netTaxablePerSourceCents(source: PersonIncomeSource): number {
  return Math.max(0, source.grossAnnualCents - specificDeductionCents(source));
}

// ─── household computation ────────────────────────────────────────────────────

export type PersonSummary = {
  personName: string;
  grossCents: number;
  ssEmployeeCents: number;
  irsWithheldCents: number;
  specificDeductionCents: number;
  netTaxableCents: number;
};

export type IRSResult = {
  persons: PersonSummary[];
  householdGrossCents: number;
  householdNetTaxableCents: number;
  quotientNetTaxableCents: number;      // divided by 2 for joint filing
  taxOnQuotientCents: number;
  totalIRSBeforeDeductionsCents: number; // × 2
  deductColectaHealthCents: number;
  deductColectaEducationCents: number;
  deductColectaHousingCents: number;
  totalDeductColectaCents: number;
  totalIRSOwedCents: number;
  totalWithheldCents: number;
  settlementCents: number;              // positive = refund, negative = owe
};

export function computeIRS(
  incomes: PersonIncomeSource[],
  deductions: IRSDeductions
): IRSResult {
  // Aggregate per person
  const personMap = new Map<string, PersonSummary>();
  for (const src of incomes) {
    const existing = personMap.get(src.personName);
    const specDed = specificDeductionCents(src);
    if (!existing) {
      personMap.set(src.personName, {
        personName: src.personName,
        grossCents: src.grossAnnualCents,
        ssEmployeeCents: src.ssEmployeeCents,
        irsWithheldCents: src.irsWithheldCents,
        specificDeductionCents: specDed,
        netTaxableCents: Math.max(0, src.grossAnnualCents - specDed),
      });
    } else {
      // Multiple employers for the same person — aggregate income, re-compute deduction
      const newGross = existing.grossCents + src.grossAnnualCents;
      const newSS = existing.ssEmployeeCents + src.ssEmployeeCents;
      const combinedSrc: PersonIncomeSource = {
        ...src,
        grossAnnualCents: newGross,
        ssEmployeeCents: newSS,
      };
      const combinedSpecDed = specificDeductionCents(combinedSrc);
      personMap.set(src.personName, {
        personName: src.personName,
        grossCents: newGross,
        ssEmployeeCents: newSS,
        irsWithheldCents: existing.irsWithheldCents + src.irsWithheldCents,
        specificDeductionCents: combinedSpecDed,
        netTaxableCents: Math.max(0, newGross - combinedSpecDed),
      });
    }
  }

  const persons = [...personMap.values()];
  const householdGrossCents = persons.reduce((s, p) => s + p.grossCents, 0);
  const householdNetTaxableCents = persons.reduce((s, p) => s + p.netTaxableCents, 0);
  const totalWithheldCents = persons.reduce((s, p) => s + p.irsWithheldCents, 0);

  // Joint filing: divide household taxable by 2, apply brackets, multiply by 2
  const quotientEur = centsToEur(householdNetTaxableCents) / 2;
  const taxOnQuotientEur = bracketTax(quotientEur);
  const taxOnQuotientCents = eurToCents(taxOnQuotientEur);
  const totalIRSBeforeDeductionsCents = taxOnQuotientCents * 2;

  // Deduções à coleta
  const deductHealth = eurToCents(Math.min(centsToEur(deductions.healthCents) * HEALTH_RATE, HEALTH_CAP_EUR));
  const deductEdu    = eurToCents(Math.min(centsToEur(deductions.educationCents) * EDUCATION_RATE, EDUCATION_CAP_EUR));
  const deductHouse  = eurToCents(Math.min(centsToEur(deductions.housingCents) * HOUSING_RATE, HOUSING_CAP_EUR));
  const totalDeductColectaCents = deductHealth + deductEdu + deductHouse;

  const totalIRSOwedCents = Math.max(0, totalIRSBeforeDeductionsCents - totalDeductColectaCents);
  const settlementCents = totalWithheldCents - totalIRSOwedCents;

  return {
    persons,
    householdGrossCents,
    householdNetTaxableCents,
    quotientNetTaxableCents: eurToCents(quotientEur),
    taxOnQuotientCents,
    totalIRSBeforeDeductionsCents,
    deductColectaHealthCents: deductHealth,
    deductColectaEducationCents: deductEdu,
    deductColectaHousingCents: deductHouse,
    totalDeductColectaCents,
    totalIRSOwedCents,
    totalWithheldCents,
    settlementCents,
  };
}

/** Effective tax rate as a percentage */
export function effectiveRatePct(result: IRSResult): number {
  if (!result.householdGrossCents) return 0;
  return (result.totalIRSOwedCents / result.householdGrossCents) * 100;
}

/** Monthly projection: given months elapsed, estimate full-year settlement */
export function projectFullYear(
  incomes: PersonIncomeSource[],
  deductions: IRSDeductions,
  monthsElapsed: number // 1–12
): IRSResult {
  if (monthsElapsed >= 12) return computeIRS(incomes, deductions);
  const factor = 12 / monthsElapsed;
  const projected = incomes.map(s => ({
    ...s,
    grossAnnualCents: Math.round(s.grossAnnualCents * factor),
    irsWithheldCents: Math.round(s.irsWithheldCents * factor),
    ssEmployeeCents: Math.round(s.ssEmployeeCents * factor),
  }));
  return computeIRS(projected, deductions);
}
