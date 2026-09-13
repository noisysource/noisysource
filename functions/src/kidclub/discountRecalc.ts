import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { appCol } from "./db";

// ── Types (duplicated from @shared/models/Discount to avoid cross-package runtime dep) ──

type DiscountTrigger = "auto_sibling" | "auto_multitrip" | "auto_school" | "manual";
type DiscountScope = "study" | "transport";

interface DiscountRule {
  id: string;
  name: string;
  percentage: number;
  appliesTo: DiscountScope[];
  trigger: DiscountTrigger;
  active: boolean;
  minTripsPerDay?: number;
  schoolName?: string;
}

interface AppliedDiscount {
  ruleId: string;
  name: string;
  percentage: number;
  appliedAt: Date;
  appliedBy: "auto" | "admin";
}

interface DayLike {
  services?: { transportTrips?: unknown[] };
}

// ── Pure discount logic (mirrors packages/shared/models/discountLogic.ts) ──

function resolveAutoDiscounts(
  rules: DiscountRule[],
  scope: DiscountScope,
  days: DayLike[],
  schoolName?: string,
  activeSiblingCount?: number,
): AppliedDiscount[] {
  const now = new Date();
  return rules
    .filter(r => r.active && r.appliesTo.includes(scope))
    .flatMap((r): AppliedDiscount[] => {
      switch (r.trigger) {
        case "auto_sibling":
          if ((activeSiblingCount ?? 0) > 0) {
            return [{ ruleId: r.id, name: r.name, percentage: r.percentage, appliedAt: now, appliedBy: "auto" }];
          }
          break;
        case "auto_multitrip": {
          const min = r.minTripsPerDay ?? 2;
          if (days.some(d => (d.services?.transportTrips?.length ?? 0) >= min)) {
            return [{ ruleId: r.id, name: r.name, percentage: r.percentage, appliedAt: now, appliedBy: "auto" }];
          }
          break;
        }
        case "auto_school":
          if (schoolName && r.schoolName) {
            const a = schoolName.toLowerCase();
            const b = r.schoolName.toLowerCase();
            if (a.includes(b) || b.includes(a)) {
              return [{ ruleId: r.id, name: r.name, percentage: r.percentage, appliedAt: now, appliedBy: "auto" }];
            }
          }
          break;
      }
      return [];
    });
}

function applyDiscounts(gross: number, discounts: AppliedDiscount[]): number {
  const totalPct = Math.min(discounts.reduce((s, d) => s + d.percentage, 0), 1);
  return Math.round(gross * (1 - totalPct) * 100) / 100;
}

function activeWeeksInPattern(pattern: string): 2 | 4 {
  return pattern === "all" ? 4 : 2;
}

const REGION = "europe-west3";
const CANCELLED = new Set(["cancelled", "canceled"]);

/**
 * Fields whose change should trigger a recalculation.
 * We deliberately exclude monthlyFee, monthlyPrice, appliedDiscounts, updatedAt
 * so that our own writes don't create an infinite loop.
 */
function triggerFieldsChanged(before: any, after: any): boolean {
  if (!before || !after) return true; // create or delete → always run
  return (
    before.familyId !== after.familyId ||
    before.status !== after.status ||
    before.childId !== after.childId ||
    before.schoolName !== after.schoolName ||
    before.weekPattern !== after.weekPattern ||
    JSON.stringify(before.schedule) !== JSON.stringify(after.schedule) ||
    JSON.stringify(before.days) !== JSON.stringify(after.days)
  );
}

async function recalcForFamily(familyId: string): Promise<void> {
  const [transportConfigSnap, discountRulesSnap, transportSnap, studySnap] = await Promise.all([
    appCol("config").doc("transportation").get(),
    appCol("config").doc("discounts").get(),
    appCol("transportationSubscriptions").where("familyId", "==", familyId).get(),
    appCol("studyroom").where("familyId", "==", familyId).get(),
  ]);

  const tCfg = transportConfigSnap.data() ?? {};
  const rules: DiscountRule[] = (discountRulesSnap.data()?.rules ?? []) as DiscountRule[];
  const flatRatePerTrip: number = tCfg.flatRatePerTrip ?? 0;

  // Unified sibling set: all non-cancelled childIds across both collections
  const allChildIds = new Set<string>();
  for (const d of [...transportSnap.docs, ...studySnap.docs]) {
    const x = d.data();
    if (!CANCELLED.has(x.status) && x.childId) allChildIds.add(x.childId);
  }

  const writes: Array<Promise<unknown>> = [];

  // --- Transport subscriptions ---
  for (const d of transportSnap.docs) {
    const x = d.data();
    if (CANCELLED.has(x.status)) continue;

    // Sibling count = other distinct children in the family (any service)
    const siblingCount = x.childId
      ? allChildIds.size - (allChildIds.has(x.childId) ? 1 : 0)
      : allChildIds.size;

    // Build DayLike[] from schedule for multi-trip detection
    const dayMap: Record<string, number> = {};
    (x.schedule ?? []).forEach((s: any) => {
      dayMap[s.dayOfWeek] = (dayMap[s.dayOfWeek] ?? 0) + 1;
    });
    const fakeDays: DayLike[] = Object.values(dayMap).map(count => ({
      services: { transportTrips: Array(count).fill(null) },
    }));

    // Preserve existing manual discounts
    const manualDiscounts: AppliedDiscount[] = (x.appliedDiscounts ?? []).filter((ad: AppliedDiscount) => {
      const rule = rules.find(r => r.id === ad.ruleId);
      return rule?.trigger === "manual";
    });

    const autoDiscounts = resolveAutoDiscounts(rules, "transport", fakeDays, x.schoolName, siblingCount);
    const allDiscounts = [...autoDiscounts, ...manualDiscounts];

    const scheduleLen: number = x.schedule?.length ?? 0;
    const grossFromSchedule = scheduleLen * flatRatePerTrip * activeWeeksInPattern(x.weekPattern ?? "all");
    const grossFee = grossFromSchedule > 0 ? grossFromSchedule : (x.monthlyFee ?? 0);
    const newFee = applyDiscounts(grossFee, allDiscounts);

    const prevRuleIds = [...(x.appliedDiscounts ?? [])].map((a: any) => a.ruleId).sort().join(",");
    const newRuleIds = allDiscounts.map(a => a.ruleId).sort().join(",");
    const feeChanged = Math.abs(newFee - (x.monthlyFee ?? 0)) > 0.001;
    const discountsChanged = prevRuleIds !== newRuleIds;

    if (feeChanged || discountsChanged) {
      writes.push(d.ref.update({ monthlyFee: newFee, appliedDiscounts: allDiscounts, updatedAt: new Date() }));
    }
  }

  // --- Study room subscriptions ---
  for (const d of studySnap.docs) {
    const x = d.data();
    if (CANCELLED.has(x.status) || x.status === "archived") continue;

    const siblingCount = x.childId
      ? allChildIds.size - (allChildIds.has(x.childId) ? 1 : 0)
      : allChildIds.size;

    const manualDiscounts: AppliedDiscount[] = (x.appliedDiscounts ?? []).filter((ad: AppliedDiscount) => {
      const rule = rules.find(r => r.id === ad.ruleId);
      return rule?.trigger === "manual";
    });

    const autoDiscounts = resolveAutoDiscounts(rules, "study", [], x.schoolName, siblingCount);
    const allDiscounts = [...autoDiscounts, ...manualDiscounts];

    const grossFee: number = x.basePrice ?? x.monthlyPrice ?? 0;
    const newFee = applyDiscounts(grossFee, allDiscounts);

    const prevRuleIds = [...(x.appliedDiscounts ?? [])].map((a: any) => a.ruleId).sort().join(",");
    const newRuleIds = allDiscounts.map(a => a.ruleId).sort().join(",");
    const feeChanged = Math.abs(newFee - (x.monthlyPrice ?? 0)) > 0.001;
    const discountsChanged = prevRuleIds !== newRuleIds;

    if (feeChanged || discountsChanged) {
      writes.push(d.ref.update({ monthlyPrice: newFee, appliedDiscounts: allDiscounts, updatedAt: new Date() }));
    }
  }

  if (writes.length > 0) {
    console.log(`[discountRecalc] family ${familyId}: ${writes.length} subscription(s) updated`);
    await Promise.all(writes);
  }
}

export const onTransportDiscountRecalc = onDocumentWritten(
  { document: "_apps/arcoiris/transportationSubscriptions/{id}", region: REGION },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!triggerFieldsChanged(before, after)) return;
    const familyId: string | undefined = (after ?? before)?.familyId;
    if (!familyId) return;
    await recalcForFamily(familyId);
  }
);

export const onStudyroomDiscountRecalc = onDocumentWritten(
  { document: "_apps/arcoiris/studyroom/{id}", region: REGION },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!triggerFieldsChanged(before, after)) return;
    const familyId: string | undefined = (after ?? before)?.familyId;
    if (!familyId) return;
    await recalcForFamily(familyId);
  }
);
