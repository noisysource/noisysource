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
import type { RecurringEntryDoc } from "@shared/models/RecurringEntry";
import type { CostSummaryBreakdownLine, CostSummaryDoc } from "@shared/models/CostSummary";
import { buildPayrollPreview } from "@shared/lib/payroll";
import { recurringVatCode } from "@shared/models/RecurringEntry";
import { splitGross } from "@shared/lib/vat";
import { recurringAmountInMonth } from "../../recurringSchedule";

const NOISYPHOCUS_ENTITY = "noisyphocus";

export interface ComputeCostSummaryInput {
  yearMonth: string; // "YYYY-MM"
  // Both salaried (contractType: 'employee'/undefined) and freelance
  // (contractType: 'green_receipt') NoisyPhocus workers live here — see
  // packages/shared/models/Employment.ts. There is no separate EC-contracts
  // input: EcContractDoc models a client paying US (income direction), the
  // wrong shape for what NoisyPhocus pays a freelancer, and using it here
  // was a design mistake corrected in this pass — see STATUS.md.
  contracts: EmploymentContractDoc[];
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

  // ── Payroll: active employment contracts, both salaried and green-receipt ──
  // buildPayrollPreview doesn't need to branch on contractType at all — a
  // green-receipt contract has ssErPct/benefits forced to 0 at save time
  // (EmploymentContractsPage.tsx), so costToEmployerCents = gross + 0 + 0,
  // which is exactly the freelancer's real cost to NoisyPhocus.
  let payrollCostCents = 0;

  const activeContracts = input.contracts.filter(c => c.active !== false);
  if (activeContracts.length) {
    const rows = buildPayrollPreview(activeContracts, { year, month1to12, span: 1 });
    for (const row of rows) {
      payrollCostCents += row.totals.costToEmployerCents;
      const personLabel = input.peopleById?.[row.personId] ?? row.personId;
      const contract = activeContracts.find(c => c.id === row.contractId);
      const label = contract?.contractType === "green_receipt"
        ? `Recibo Verde — ${personLabel}`
        : `Contrato — ${personLabel}`;
      breakdown.push({ label, amountCents: row.totals.costToEmployerCents, netCents: row.totals.costToEmployerCents });
    }
  }

  // ── Software/tooling: active expense recurring entries for this entity ──
  // NoisyPhocus's payroll lives in employmentContracts (above), not `recurring`
  // — so every other active expense recurring entry here is, by construction,
  // a software/tooling cost (Vendus, EasyPay, ...). If a non-software recurring
  // expense is ever added for NoisyPhocus, this will need a real categoryId
  // filter — see STATUS.md.
  // Amounts are VAT-inclusive (VAT convention): the VAT is split out of them
  // into the "sem IVA" column, never added on top.
  let softwareCostCents = 0;
  let softwareNetCents = 0;
  let vatCents = 0;
  let unconfirmedVatCount = 0;
  for (const r of input.recurring) {
    if (r.type !== "expense" || !r.active) continue;
    // Saving an employment contract also writes an "Encargos Salariais" recurring
    // expense (sourceId "emp:…", contractSync.ts). That pay is already counted
    // above from the contract itself.
    if (r.sourceId?.startsWith("emp:")) continue;
    const amountCents = recurringAmountInMonth(r, input.yearMonth, input.kidclubVolumeCentsForMonth);
    if (!amountCents) continue;
    const vatCode = recurringVatCode(r) ?? "por_confirmar";
    // 'por_confirmar': unknown whether the amount includes VAT, so it's counted
    // as stored in both columns and the page warns that the totals are approximate.
    const split = splitGross(amountCents, vatCode);
    if (!split) unconfirmedVatCount++;
    const netCents = split ? split.netCents : amountCents;
    softwareCostCents += amountCents;
    softwareNetCents += netCents;
    vatCents += split ? split.vatCents : 0;
    breakdown.push({ label: r.description, amountCents, netCents, vatCode });
  }

  const totalCostCents = payrollCostCents + softwareCostCents;
  const totalNetCents = payrollCostCents + softwareNetCents;

  return {
    payrollCostCents,
    softwareCostCents,
    softwareNetCents,
    vatCents,
    totalCostCents,
    totalNetCents,
    unconfirmedVatCount,
    breakdown,
  };
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
