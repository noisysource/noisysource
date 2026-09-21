// apps/finances/src/lib/api/domains/costSummary.ts
//
// Computes and stores NoisyPhocus's monthly cost total at
// finances_entities/noisyphocus/costSummary/{yyyy-mm}, read cross-app by
// KidClub's "Resumo Financeiro" page — see root CLAUDE.md "Cross-App Data
// Contracts" and apps/noisysource/finances/STATUS.md for the design notes
// (why this is recomputed-on-open rather than a one-off manual snapshot).
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../../firebase";
import type { EmploymentContractDoc } from "@shared/models/Employment";
import type { EcContractDoc } from "@shared/models/EcContract";
import { estimatedMonthlyInvoiceCents } from "@shared/models/EcContract";
import type { RecurringEntryDoc } from "@shared/models/RecurringEntry";
import type { CostSummaryBreakdownLine, CostSummaryDoc } from "@shared/models/CostSummary";
import { buildPayrollPreview } from "@shared/lib/payroll";
import { recurringAmountInMonth, recurringIvaInQuarter } from "../../recurringSchedule";

const NOISYPHOCUS_ENTITY = "noisyphocus";

export interface ComputeCostSummaryInput {
  yearMonth: string; // "YYYY-MM"
  contracts: EmploymentContractDoc[];
  ecContracts: EcContractDoc[];
  recurring: RecurringEntryDoc[];
  /** KidClub processed-billing volume for this month, in cents — see api.kidclub.monthlyProcessedVolumeCents(). */
  kidclubVolumeCentsForMonth?: number;
  /** Optional personId -> display name, purely for nicer breakdown labels. */
  peopleById?: Record<string, string>;
}

export type ComputedCostSummary = Omit<CostSummaryDoc, "computedAt">;

/** Pure computation — no Firestore reads/writes, easy to unit-test/inspect. */
export function computeNoisyphocusCostSummary(input: ComputeCostSummaryInput): ComputedCostSummary {
  const [yearStr, monthStr] = input.yearMonth.split("-");
  const year = Number(yearStr);
  const month1to12 = Number(monthStr);
  const breakdown: CostSummaryBreakdownLine[] = [];

  // ── Payroll: active employment contracts + active EC/freelance contracts ──
  let payrollCostCents = 0;

  const activeContracts = input.contracts.filter(c => c.active !== false);
  if (activeContracts.length) {
    const rows = buildPayrollPreview(activeContracts, { year, month1to12, span: 1 });
    for (const row of rows) {
      payrollCostCents += row.totals.costToEmployerCents;
      const personLabel = input.peopleById?.[row.personId] ?? row.personId;
      breakdown.push({
        label: `Contrato — ${personLabel}`,
        amountCents: row.totals.costToEmployerCents,
      });
    }
  }

  for (const c of input.ecContracts) {
    if (!c.active) continue;
    const amountCents = estimatedMonthlyInvoiceCents(c);
    payrollCostCents += amountCents;
    breakdown.push({ label: `Recibo verde — ${c.clientName}`, amountCents });
  }

  // ── Software/tooling: active expense recurring entries for this entity ──
  // NoisyPhocus's payroll lives in employmentContracts/ecContracts (above),
  // not `recurring` — so every active expense recurring entry here is, by
  // construction, a software/tooling cost (Vendus, EasyPay, ...). If a
  // non-software recurring expense is ever added for NoisyPhocus, this will
  // need a real categoryId filter — see STATUS.md.
  let softwareCostCents = 0;
  for (const r of input.recurring) {
    if (r.type !== "expense" || !r.active) continue;
    const amountCents = recurringAmountInMonth(r, input.yearMonth, input.kidclubVolumeCentsForMonth);
    if (!amountCents) continue;
    softwareCostCents += amountCents;
    breakdown.push({ label: r.description, amountCents });
  }

  // ── VAT: IVA dedutível on this month's software/recurring costs ──
  // (Reuses the same engine VatPage uses for its quarterly figures, just
  // scoped to a single month — see recurringSchedule.ts.)
  const volumeCentsByMonth = input.kidclubVolumeCentsForMonth != null
    ? { [input.yearMonth]: input.kidclubVolumeCentsForMonth }
    : undefined;
  const vatRows = recurringIvaInQuarter(input.recurring, [input.yearMonth], "expense", volumeCentsByMonth);
  const vatCents = vatRows.reduce((s, r) => s + r.ivaCents, 0);
  if (vatCents) breakdown.push({ label: "IVA dedutível (custos)", amountCents: vatCents });

  const totalCostCents = payrollCostCents + softwareCostCents + vatCents;

  return { payrollCostCents, softwareCostCents, vatCents, totalCostCents, breakdown };
}

function costSummaryDocRef(yearMonth: string) {
  return doc(db, "finances_entities", NOISYPHOCUS_ENTITY, "costSummary", yearMonth);
}

export function makeCostSummaryDomain() {
  return {
    async get(yearMonth: string): Promise<CostSummaryDoc | undefined> {
      const snap = await getDoc(costSummaryDocRef(yearMonth));
      return snap.exists() ? (snap.data() as CostSummaryDoc) : undefined;
    },

    /** Computes and overwrites finances_entities/noisyphocus/costSummary/{yearMonth}. */
    async computeAndSave(input: ComputeCostSummaryInput): Promise<ComputedCostSummary> {
      const computed = computeNoisyphocusCostSummary(input);
      await setDoc(costSummaryDocRef(input.yearMonth), {
        ...computed,
        computedAt: serverTimestamp(),
      });
      return computed;
    },
  };
}
