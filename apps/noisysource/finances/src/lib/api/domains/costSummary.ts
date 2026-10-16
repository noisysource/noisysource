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
import type { CostSummaryBreakdownLine, CostSummaryDoc, CostSummaryGroup } from "@shared/models/CostSummary";
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
  /** The entity's categories: each recurring cost is grouped under its top-level category. */
  categories?: ReadonlyArray<{ id: string; name: string; parentId?: string }>;
}

export const PAYROLL_GROUP = "Pessoal";
export const UNCATEGORISED_GROUP = "Sem categoria";
const isSoftware = (group: string) => group.trim().toLowerCase() === "software";

/** Name of a category's top-level ancestor (itself if it has no parent). */
function topCategoryName(
  categoryId: string | undefined,
  byId: ReadonlyMap<string, { name: string; parentId?: string }>,
): string {
  let c = categoryId ? byId.get(categoryId) : undefined;
  if (!c) return UNCATEGORISED_GROUP;
  for (let i = 0; i < 10 && c.parentId && byId.has(c.parentId); i++) c = byId.get(c.parentId)!;
  return c.name;
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
      breakdown.push({ label, group: PAYROLL_GROUP, amountCents: row.totals.costToEmployerCents, netCents: row.totals.costToEmployerCents });
    }
  }

  // ── Recurring costs: every active expense entry, grouped by its top-level category ──
  // (rent, utilities, the van, software…). Only the "Software" category counts as software.
  // Amounts are VAT-inclusive (VAT convention): the VAT is split out of them
  // into the "sem IVA" column, never added on top.
  const categoriesById = new Map((input.categories ?? []).map(c => [c.id, c]));
  let recurringCostCents = 0;
  let recurringNetCents = 0;
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
    const group = topCategoryName(r.categoryId, categoriesById);
    recurringCostCents += amountCents;
    recurringNetCents += netCents;
    if (isSoftware(group)) {
      softwareCostCents += amountCents;
      softwareNetCents += netCents;
    }
    vatCents += split ? split.vatCents : 0;
    breakdown.push({ label: r.description, group, amountCents, netCents, vatCode });
  }

  // Subtotals: payroll first, then the largest group.
  const byGroup = new Map<string, CostSummaryGroup>();
  for (const line of breakdown) {
    const name = line.group ?? UNCATEGORISED_GROUP;
    const g = byGroup.get(name) ?? { name, amountCents: 0, netCents: 0 };
    g.amountCents += line.amountCents;
    g.netCents += line.netCents ?? line.amountCents;
    byGroup.set(name, g);
  }
  const groups = [...byGroup.values()].sort((a, b) =>
    (b.name === PAYROLL_GROUP ? 1 : 0) - (a.name === PAYROLL_GROUP ? 1 : 0) || b.amountCents - a.amountCents);

  const totalCostCents = payrollCostCents + recurringCostCents;
  const totalNetCents = payrollCostCents + recurringNetCents;

  return {
    payrollCostCents,
    recurringCostCents,
    recurringNetCents,
    softwareCostCents,
    softwareNetCents,
    vatCents,
    totalCostCents,
    totalNetCents,
    unconfirmedVatCount,
    groups,
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
