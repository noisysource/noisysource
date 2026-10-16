/**
 * contractSync.ts
 *
 * Keeps Recurring entries in sync with Employment and EC contracts.
 *
 * Employment contract (NoisySource entity) → two recurring entries:
 *   1. NoisySource expense: gross + SS employer (company payroll cost)
 *   2. Private income: net cash salary (only when flowToPrivate = true)
 *
 * EC contract (NoisySource entity) → one recurring entry:
 *   1. NoisySource income: dailyRate × expectedDaysPerMonth
 *
 * Insurance (any entity) → one recurring expense: the premium, VAT-exempt.
 */

import type { EmploymentContractDoc } from "@shared/models/Employment";
import type { EcContractDoc } from "@shared/models/EcContract";
import { ecContractVatCode } from "@shared/models/EcContract";
import type { IncomeSourceDoc } from "@shared/models/IncomeSource";
import type { InsuranceDoc } from "@shared/models/Insurance";
import { incomeSourceMonth } from "@shared/models/IncomeSource";
import { computeMonthlyPayroll } from "@shared/lib/payroll";
import { computeEcProjection } from "@shared/lib/ecProjection";
import { api } from "./api";

/** Convert a Date to a local YYYY-MM-DD string (avoids UTC-offset issues). */
function dateToLocalIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toYearMonth(date: Date | undefined): string | undefined {
  if (!date) return undefined;
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ── Employment contract ──────────────────────────────────────────────────────

export async function syncEmploymentContractRecurring(
  contract: EmploymentContractDoc,
  personName: string,
  currentEntityId: string,
): Promise<void> {
  const now = new Date();
  const row = computeMonthlyPayroll(contract, now.getFullYear(), now.getMonth() + 1);

  // Cash benefits (e.g. ajudas de custo): no voucher account → paid via bank transfer
  const cashBenefitsCents = row.benefits
    .filter(b => !b.benefitAccountId)
    .reduce((s, b) => s + b.totalCents, 0);

  // 1. NoisySource: salary burden expense (gross + SS employer)
  const nsSourceId = `emp:${contract.id}:ns`;
  await api.recurring.upsertBySourceId(nsSourceId, {
    type: "expense",
    description: `Encargos Salariais — ${personName}`,
    amountCents: row.grossCents + row.ssErCents,
    frequency: "monthly",
    dayOfMonth: contract.payDay ?? 25,
    startYearMonth: toYearMonth(contract.startDate as any),
    endYearMonth: toYearMonth(contract.endDate as any),
    active: contract.active,
    sourceId: nsSourceId,
  });

  // 2. Private: net cash income (only for household members)
  if (contract.flowToPrivate) {
    api.setEntity("private");
    const privSourceId = `emp:${contract.id}:private`;
    await api.recurring.upsertBySourceId(privSourceId, {
      type: "income",
      description: `Salário NoisySource — ${personName}`,
      amountCents: row.netCents + cashBenefitsCents,
      accountId: contract.netPayAccountId || undefined,
      frequency: "monthly",
      dayOfMonth: contract.payDay ?? 25,
      startYearMonth: toYearMonth(contract.startDate as any),
      endYearMonth: toYearMonth(contract.endDate as any),
      active: contract.active,
      sourceId: privSourceId,
    });

    // 3. Private: voucher benefit credits (meal card, childcare, etc.)
    for (const benefit of contract.benefits ?? []) {
      const benefitAccountId = (benefit as any).benefitAccountId as string | undefined;
      if (!benefitAccountId) continue;
      const b = row.benefits.find(rb => rb.type === benefit.type);
      if (!b || b.totalCents <= 0) continue;
      const benefitSourceId = `emp:${contract.id}:benefit:${benefit.type}`;
      await api.recurring.upsertBySourceId(benefitSourceId, {
        type: "income",
        description: `${benefit.type === "MEAL_CARD" ? "Cartão Refeição" : benefit.type === "CHILDCARE" ? "Cheque Creche" : benefit.type} — ${personName}`,
        amountCents: b.totalCents,
        accountId: benefitAccountId,
        frequency: "monthly",
        dayOfMonth: contract.payDay ?? 25,
        startYearMonth: toYearMonth(contract.startDate as any),
        endYearMonth: toYearMonth(contract.endDate as any),
        active: contract.active,
        sourceId: benefitSourceId,
      });
    }

    api.setEntity(currentEntityId);
  } else {
    // Deactivate any existing private entry if flowToPrivate was turned off
    api.setEntity("private");
    const privSourceId = `emp:${contract.id}:private`;
    await api.recurring.deactivateBySourceId(privSourceId);
    api.setEntity(currentEntityId);
  }
}

export async function deactivateEmploymentContractRecurring(
  contractId: string,
  currentEntityId: string,
): Promise<void> {
  await api.recurring.deactivateBySourceId(`emp:${contractId}:ns`);
  api.setEntity("private");
  await api.recurring.deactivateBySourceId(`emp:${contractId}:private`);
  api.setEntity(currentEntityId);
}

// ── EC contract ──────────────────────────────────────────────────────────────

export async function syncEcContractRecurring(contract: EcContractDoc): Promise<void> {
  const sourceId = `ec:${contract.id}`;

  // If we have enough data, use the projection to compute the true average
  // working days per month (accounting for non-working days and partial months).
  // Otherwise fall back to the manually-set expectedDaysPerMonth.
  let amountCents: number;
  if (contract.startDate && contract.totalDays) {
    const projection = computeEcProjection(
      {
        startDate: dateToLocalIso(contract.startDate),
        dailyRateCents: contract.dailyRateCents,
        totalDays: contract.totalDays,
      },
      contract.nonWorkingDays ?? [],
      new Date(),
    );
    const numMonths = projection.monthBreakdown.length;
    const avgDays =
      numMonths > 0
        ? Math.round((projection.totalContractWorkingDays / numMonths) * 10) / 10
        : contract.expectedDaysPerMonth;
    amountCents = Math.round(contract.dailyRateCents * avgDays);
  } else {
    amountCents = contract.dailyRateCents * contract.expectedDaysPerMonth;
  }

  await api.recurring.upsertBySourceId(sourceId, {
    type: "income",
    description: `EC — ${contract.clientName}${contract.projectName ? ` / ${contract.projectName}` : ""}`,
    amountCents,
    vatCode: ecContractVatCode(contract),
    frequency: "monthly",
    dayOfMonth: 1,
    startYearMonth: toYearMonth(contract.startDate),
    endYearMonth: toYearMonth(contract.endDate),
    active: contract.active,
    sourceId,
  });
}

export async function deactivateEcContractRecurring(contractId: string): Promise<void> {
  await api.recurring.deactivateBySourceId(`ec:${contractId}`);
}

// ── Income source (external employer) ───────────────────────────────────────

export async function syncIncomeSourceRecurring(source: IncomeSourceDoc): Promise<void> {
  // Net pay includes benefits paid in cash with it; card benefits go to their own accounts.
  const month = incomeSourceMonth(source);

  const startYM = source.startDate ? source.startDate.slice(0, 7) : undefined;
  const endYM = source.endDate ? source.endDate.slice(0, 7) : undefined;
  const prevEntity = api.entityId;
  api.setEntity("private");

  const sourceId = `inc:${source.id}`;
  await api.recurring.upsertBySourceId(sourceId, {
    type: "income",
    description: `${source.employerName} — ${source.personName}`,
    amountCents: month.netPayCents,
    accountId: source.netPayAccountId || undefined,
    frequency: "monthly",
    dayOfMonth: source.payDay ?? 28,
    startYearMonth: startYM,
    endYearMonth: endYM,
    active: source.active,
    sourceId,
  });

  for (const b of month.cardBenefits) {
    const benefitSourceId = `inc:${source.id}:benefit:${b.type}`;
    await api.recurring.upsertBySourceId(benefitSourceId, {
      type: "income",
      description: `${b.type === "MEAL_CARD" ? "Cartão Refeição" : b.type === "CHILDCARE" ? "Cheque Creche" : b.type} — ${source.personName}`,
      amountCents: b.totalCents,
      accountId: b.benefitAccountId,
      frequency: "monthly",
      dayOfMonth: source.payDay ?? 28,
      startYearMonth: startYM,
      endYearMonth: endYM,
      active: source.active,
      sourceId: benefitSourceId,
    });
  }

  api.setEntity(prevEntity);
}

export async function deactivateIncomeSourceRecurring(sourceId: string): Promise<void> {
  const prevEntity = api.entityId;
  api.setEntity("private");
  await api.recurring.deactivateBySourceId(`inc:${sourceId}`);
  api.setEntity(prevEntity);
}

// ── Insurance ────────────────────────────────────────────────────────────────

/**
 * The premium as a recurring expense in the current entity (InsurancesPage and the seed import).
 * Annual premiums fall in the renewal month; the renewal day is the day of the month.
 */
export async function syncInsuranceRecurring(
  insurance: Pick<InsuranceDoc, "id" | "name" | "insurer" | "premiumCents" | "frequency" | "renewalDate" | "active">,
): Promise<void> {
  const sourceId = `insurance:${insurance.id}`;
  if (insurance.active && insurance.premiumCents > 0) {
    const renewalDate = insurance.renewalDate ? new Date(`${insurance.renewalDate}T00:00:00`) : null;
    const dayOfMonth = renewalDate ? renewalDate.getDate() : 1;
    const monthOfYear = renewalDate && insurance.frequency === "annual" ? renewalDate.getMonth() + 1 : undefined;
    await api.recurring.upsertBySourceId(sourceId, {
      type: "expense",
      description: `${insurance.name} (${insurance.insurer})`,
      amountCents: insurance.premiumCents,
      vatCode: "isento", // insurance premiums are VAT-exempt (CIVA art. 9)
      frequency: insurance.frequency,
      dayOfMonth,
      monthOfYear,
      active: true,
      sourceId,
    });
  } else if (!insurance.active) {
    await api.recurring.deactivateBySourceId(sourceId);
  }
}
