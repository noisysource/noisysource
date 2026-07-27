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
 */

import type { EmploymentContractDoc } from "@shared/models/Employment";
import type { EcContractDoc } from "@shared/models/EcContract";
import { computeMonthlyPayroll } from "@shared/lib/payroll";
import { api } from "./api";

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
      frequency: "monthly",
      dayOfMonth: contract.payDay ?? 25,
      startYearMonth: toYearMonth(contract.startDate as any),
      endYearMonth: toYearMonth(contract.endDate as any),
      active: contract.active,
      sourceId: privSourceId,
    });
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
  await api.recurring.upsertBySourceId(sourceId, {
    type: "income",
    description: `EC — ${contract.clientName}${contract.projectName ? ` / ${contract.projectName}` : ""}`,
    amountCents: contract.dailyRateCents * contract.expectedDaysPerMonth,
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
