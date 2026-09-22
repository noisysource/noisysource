// Pure reconciliation pipeline for one service (study or transport), one
// family, one billing period. No Firestore access here — billing.ts fetches
// subscriptions/events/config and hands them in, so this stays testable and
// the money math lives in exactly one place.
//
// Pipeline, per the agreed design (2026-09-21):
//   Gross (from materialized ReservationEvents, EXPECTED+CANCELLED only)
//     -> 1. Multi-trip discount, MARGINAL: only the trip(s) beyond the
//          (minTripsPerDay-1)th on a given calendar date are discounted.
//     -> 2. Sibling discount, MARGINAL: subscriptions of this service ranked
//          by value (highest = "child #1", full price; tie-break: earlier
//          enrollment, then older child), every subscription below #1 gets
//          the discount on its own post-multi-trip subtotal.
//     -> 3. Institutional discount: school-match + returning-student +
//          manual admin overrides, SUMMED (not compounded) into one
//          percentage, applied to the post-sibling subtotal.
//     -> net.
//     -> 4. Absence credit: under 3 CANCELLED events this period, no
//          credit. At 3 or more, credit = count x (net / real scheduled
//          occurrences this period) -- uncapped, not capped at 3 -- floored
//          so the final total never goes negative.

export interface ReservationEventLite {
  date: string; // yyyy-mm-dd
  basePriceCents: number;
  status: "EXPECTED" | "CANCELLED" | "VOIDED";
}

export interface SubscriptionForReconciliation {
  id: string;
  childId: string;
  schoolName?: string;
  returningStudent?: boolean;
  /** Sum of admin-applied ("manual") discount percentages already on this subscription, e.g. 0.05 for 5% */
  manualDiscountPct: number;
  /** Earlier = more likely to land in position #1 (full price) on a value tie */
  enrollmentDate: Date;
  /** Older child = more likely to land in position #1 on a further tie */
  childBirthDate?: Date;
}

export interface ReconciliationConfig {
  multiTripDiscountPct: number; // e.g. 0.10
  minTripsPerDay: number;       // e.g. 2 — the 1st trip that day is always full price
  siblingDiscountPct: number;   // e.g. 0.10
  schoolDiscounts: { schoolName: string; discountPercentage: number }[];
  returningStudentDiscountPct: number;
}

export interface ReconciledLineItem {
  subscriptionId: string;
  childId: string;
  grossCents: number;
  multiTripDiscountCents: number;
  siblingDiscountCents: number;
  institutionalDiscountPct: number;
  institutionalDiscountCents: number;
  netBeforeAbsenceCents: number;
  absenceCount: number;
  absenceCreditCents: number;
  absenceCreditDates: string[];
  finalCents: number;
}

function matchesSchool(schoolName: string | undefined, ruleSchoolName: string): boolean {
  if (!schoolName) return false;
  const a = schoolName.toLowerCase();
  const b = ruleSchoolName.toLowerCase();
  return a.includes(b) || b.includes(a);
}

export function reconcileService(
  subs: SubscriptionForReconciliation[],
  eventsBySub: Map<string, ReservationEventLite[]>,
  cfg: ReconciliationConfig,
): ReconciledLineItem[] {
  // ── Step 1: gross + marginal multi-trip, per subscription ──────────────
  const step1 = subs.map(sub => {
    const events = (eventsBySub.get(sub.id) ?? []).filter(e => e.status !== "VOIDED");
    const grossCents = events.reduce((s, e) => s + e.basePriceCents, 0);

    const byDate = new Map<string, ReservationEventLite[]>();
    for (const e of events) {
      const arr = byDate.get(e.date) ?? [];
      arr.push(e);
      byDate.set(e.date, arr);
    }
    let discountEligibleCents = 0;
    for (const dayEvents of byDate.values()) {
      if (dayEvents.length >= cfg.minTripsPerDay) {
        const eligible = dayEvents.slice(cfg.minTripsPerDay - 1);
        discountEligibleCents += eligible.reduce((s, e) => s + e.basePriceCents, 0);
      }
    }
    const multiTripDiscountCents = Math.round(discountEligibleCents * cfg.multiTripDiscountPct);
    return { sub, events, grossCents, multiTripDiscountCents, subtotal: grossCents - multiTripDiscountCents };
  });

  // ── Step 2: marginal sibling discount, ranked across the family ────────
  const ranked = [...step1].sort((a, b) => {
    if (b.subtotal !== a.subtotal) return b.subtotal - a.subtotal; // higher value -> position 1 (full price)
    const enrollDiff = a.sub.enrollmentDate.getTime() - b.sub.enrollmentDate.getTime();
    if (enrollDiff !== 0) return enrollDiff; // earlier enrolled -> position 1
    const aBd = a.sub.childBirthDate?.getTime() ?? Infinity;
    const bBd = b.sub.childBirthDate?.getTime() ?? Infinity;
    return aBd - bBd; // older child -> position 1
  });

  const step2 = ranked.map((item, idx) => {
    const siblingDiscountCents = idx === 0 ? 0 : Math.round(item.subtotal * cfg.siblingDiscountPct);
    return { ...item, siblingDiscountCents, subtotal: item.subtotal - siblingDiscountCents };
  });

  // ── Step 3: institutional discount (school + returning + manual), summed ──
  const step3 = step2.map(item => {
    const schoolPct = cfg.schoolDiscounts.find(sd => matchesSchool(item.sub.schoolName, sd.schoolName))?.discountPercentage ?? 0;
    const returningPct = item.sub.returningStudent ? cfg.returningStudentDiscountPct : 0;
    const institutionalDiscountPct = Math.min(schoolPct + returningPct + item.sub.manualDiscountPct, 1);
    const institutionalDiscountCents = Math.round(item.subtotal * institutionalDiscountPct);
    return { ...item, institutionalDiscountPct, institutionalDiscountCents, netBeforeAbsence: item.subtotal - institutionalDiscountCents };
  });

  // ── Step 4: absence credit, uncapped once the 3-absence gate is reached ──
  return step3.map(item => {
    const cancelled = item.events.filter(e => e.status === "CANCELLED").sort((a, b) => a.date.localeCompare(b.date));
    const absenceCount = cancelled.length;
    const occurrencesThisPeriod = item.events.length; // EXPECTED + CANCELLED = every occurrence actually scheduled this period
    const perOccurrenceRateCents = occurrencesThisPeriod > 0 ? item.netBeforeAbsence / occurrencesThisPeriod : 0;
    const qualifies = absenceCount >= 3;
    const absenceCreditCents = qualifies ? Math.min(item.netBeforeAbsence, Math.round(absenceCount * perOccurrenceRateCents)) : 0;

    return {
      subscriptionId: item.sub.id,
      childId: item.sub.childId,
      grossCents: item.grossCents,
      multiTripDiscountCents: item.multiTripDiscountCents,
      siblingDiscountCents: item.siblingDiscountCents,
      institutionalDiscountPct: item.institutionalDiscountPct,
      institutionalDiscountCents: item.institutionalDiscountCents,
      netBeforeAbsenceCents: item.netBeforeAbsence,
      absenceCount,
      absenceCreditCents,
      absenceCreditDates: qualifies ? cancelled.map(c => c.date) : [],
      finalCents: Math.max(0, item.netBeforeAbsence - absenceCreditCents),
    };
  });
}
