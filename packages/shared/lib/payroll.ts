// @shared/lib/payroll.ts
import type { BenefitConfig, EmploymentContractDoc } from "../models/Employment";

/** Public shape returned to UIs */
export type PayrollBenefit = {
  type?: string;
  perMonthCents?: number;
  perDayCents?: number;
  days: number;
  totalCents: number;
  benefitAccountId?: string;
  // expose flags so UIs/debugging can see what counted in bases
  subjectToIRS?: boolean;
  subjectToSS?: boolean;
};

export type MoneyFlow = {
  label: string;
  amountCents: number;
  fromAccountId?: string | null;
  toAccountId?: string | null;
};

export type PayrollRow = {
  key: string;
  contractId: string;
  companyId: string;
  personId: string;
  monthLabel: string;
  payDateISO: string;

  // core numbers
  grossCents: number;
  irsCents: number;
  ssEmpCents: number;
  ssErCents: number;

  // bases used for deductions (so UI can show what was taxed)
  bases: {
    irsBaseCents: number;
    ssBaseCents: number;
  };

  // derived totals (already computed here; UI just renders)
  netCents: number;
  benefits: PayrollBenefit[];
  totals: {
    benefitsCents: number;        // sum of all benefits
    costToEmployerCents: number;  // gross + ssEr + benefits (naive)
    cashOutCents: number;         // net + benefits (naive)
  };

  // cash movements suggestion (from company to destinations)
  flows: MoneyFlow[];
  rates: {
    irsPct: number;
    ssEmpPct: number;
    ssErPct: number;
  };
};

const rnd = (n: number) => Math.round(n);
const pct = (n: number | undefined | null) => (typeof n === "number" ? n : 0);

const isMealLike = (t?: string) => {
  const k = (t || "").toUpperCase();
  return k === "MEAL" || k === "MEAL_CARD" || k === "MEAL_VOUCHER";
};

const daysFor = (b: BenefitConfig): number => {
  const raw = (b as any).daysPerMonth ?? (b as any).meta?.workingDays;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return isMealLike(b.type) ? 22 : 0; // default 22 for meal-like
};

const toCents = (x: any) => (Number.isFinite(Number(x)) ? rnd(Number(x)) : 0);

function benefitMonthly(b: BenefitConfig): PayrollBenefit {
  const perMonth = toCents((b as any).perMonthCents);
  const perDay = toCents((b as any).perDayCents ?? (b as any).dailyAmountCents);
  const d = daysFor(b);
  const total = perMonth + perDay * d;
  return {
    type: b.type,
    perMonthCents: perMonth || undefined,
    perDayCents: perDay || undefined,
    days: d,
    totalCents: total,
    benefitAccountId: (b as any).benefitAccountId ?? (b as any).providerAccountId ?? "",
    subjectToIRS: !!(b as any).subjectToIRS,
    subjectToSS: !!(b as any).subjectToSS,
  };
}

/**
 * Compute a single month preview for a given contract.
 * All math lives here — UI just renders the result.
 */
export function computeMonthlyPayroll(
  contract: EmploymentContractDoc,
  y: number,
  month1to12: number,
  opts?: {
    monthLabelLocale?: string;
    companyBankAccountId?: string | null; // optional source for flows
  }
): PayrollRow {
  const gross = toCents(contract.grossMonthlyCents);

  const benefits = Array.isArray(contract.benefits)
    ? contract.benefits.map(benefitMonthly)
    : [];

  // Build taxable bases using benefit flags
  const taxableFromBenefitsIRS = benefits.reduce(
    (s, b) => s + (b.subjectToIRS ? b.totalCents : 0),
    0
  );
  const taxableFromBenefitsSS = benefits.reduce(
    (s, b) => s + (b.subjectToSS ? b.totalCents : 0),
    0
  );

  const irsBase = gross + taxableFromBenefitsIRS;
  const ssBase = gross + taxableFromBenefitsSS;

  const irs = rnd(irsBase * pct(contract.irsRatePct) / 100);
  const ssEmp = rnd(ssBase * pct(contract.ssEmpPct) / 100);
  const ssEr = rnd(ssBase * pct(contract.ssErPct) / 100);

  const benefitsSum = benefits.reduce((s, b) => s + b.totalCents, 0);
  const net = gross - irs - ssEmp;

  // dates/labels
  const m0 = month1to12 - 1;
  const monthDate = new Date(Date.UTC(y, m0, 1));
  const monthLabel = monthDate.toLocaleString(opts?.monthLabelLocale, { month: "long", year: "numeric" });
  const payDay = typeof contract.payDay === "number" ? contract.payDay : 25;
  const payDateISO = new Date(Date.UTC(y, m0, payDay)).toISOString().slice(0, 10);

  // Suggested flows (source optional; UI can show "—" if missing)
  const flows: MoneyFlow[] = [];
  if (net > 0) {
    flows.push({
      label: "Net salary",
      amountCents: net,
      fromAccountId: opts?.companyBankAccountId ?? null,
      toAccountId: contract.netPayAccountId || null,
    });
  }
  for (const b of benefits) {
    if (b.totalCents > 0) {
      flows.push({
        label: `Benefit: ${b.type || "voucher"}`,
        amountCents: b.totalCents,
        fromAccountId: opts?.companyBankAccountId ?? null,
        toAccountId: b.benefitAccountId || null,
      });
    }
  }

  return {
    key: `${contract.id}:${y}-${month1to12}`,
    contractId: contract.id!,
    companyId: contract.companyId!,
    personId: contract.personId!,
    monthLabel,
    payDateISO,

    grossCents: gross,
    irsCents: irs,
    ssEmpCents: ssEmp,
    ssErCents: ssEr,

    bases: {
      irsBaseCents: irsBase,
      ssBaseCents: ssBase,
    },

    netCents: net,
    benefits,
    totals: {
      benefitsCents: benefitsSum,
      costToEmployerCents: gross + ssEr + benefitsSum,
      cashOutCents: net + benefitsSum,
    },
    flows,
    rates: {
      irsPct: contract.irsRatePct ?? 0,
      ssEmpPct: contract.ssEmpPct ?? 0,
      ssErPct: contract.ssErPct ?? 0,
    },

  };
}

/**
 * "YYYY-MM" of a contract date. The form saves ISO "YYYY-MM-DD" strings (read by slicing, so no
 * time zone can move the month); older docs may hold a Firestore Timestamp or a Date.
 */
export function contractDateYM(d: unknown): string | undefined {
  if (!d) return undefined;
  if (typeof d === "string") return /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : undefined;
  const date: Date | null =
    typeof (d as any).toDate === "function" ? (d as any).toDate() : d instanceof Date ? d : null;
  if (!date || isNaN(date.getTime())) return undefined;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * True when an active contract is in force at some point in that month: start and end dates
 * inclusive, by month. A contract with versions (a raise, a new rate) is several docs with
 * consecutive dates, so each month counts exactly one of them.
 */
export function contractInForce(
  contract: Pick<EmploymentContractDoc, "active" | "startDate" | "endDate">,
  year: number,
  month1to12: number,
): boolean {
  if (contract.active === false) return false;
  const ym = `${year}-${String(month1to12).padStart(2, "0")}`;
  const startYM = contractDateYM(contract.startDate);
  const endYM = contractDateYM(contract.endDate);
  if (startYM && ym < startYM) return false;
  if (endYM && ym > endYM) return false;
  return true;
}

/**
 * Build a preview for a set of contracts across N months: one row per contract in force in each
 * month (contractInForce), so ended contracts and later versions don't double up.
 * The UI can call this directly; no calculations should be done in components.
 */
export function buildPayrollPreview(
  contracts: EmploymentContractDoc[],
  opts: {
    year: number;
    month1to12: number;
    span: number;
    monthLabelLocale?: string;
    companyBankAccountId?: string | null;
  }
): PayrollRow[] {
  const out: PayrollRow[] = [];
  for (const c of contracts) {
    for (let i = 0; i < opts.span; i++) {
      const d = new Date(Date.UTC(opts.year, opts.month1to12 - 1 + i, 1));
      if (!contractInForce(c, d.getUTCFullYear(), d.getUTCMonth() + 1)) continue;
      out.push(
        computeMonthlyPayroll(c, d.getUTCFullYear(), d.getUTCMonth() + 1, {
          monthLabelLocale: opts.monthLabelLocale,
          companyBankAccountId: opts.companyBankAccountId ?? null,
        })
      );
    }
  }
  return out;
}