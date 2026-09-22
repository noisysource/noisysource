// Pure reconciliation pipeline for one service (study or transport), one
// family, one billing period. No Firestore access here — billing.ts fetches
// subscriptions/events/config and hands them in, so this stays testable and
// the money math lives in exactly one place.
//
// Pipeline, per the agreed design (2026-09-21, revised 2026-09-22):
//   Gross — FLAT MONTHLY, derived from the weekly schedule pattern, NOT from
//     counting this period's occurrences:
//         scheduleLength x ratePerOccurrence x activeWeeksInPattern
//     A month with five Mondays costs exactly the same as one with four; a
//     half-month of school (July) and a month with no school days (August)
//     still bill the same flat price. Occurrences (ReservationEvents) remain
//     the source of truth for absences and logistics — they never drive gross.
//     -> 1. Multi-trip discount, MARGINAL: only the leg(s) beyond the
//          (minTripsPerDay-1)th on a given weekday of the SCHEDULE PATTERN
//          are discount-eligible.
//     -> 2. Sibling discount, MARGINAL: subscriptions of this service ranked
//          by value (highest = "child #1", full price; tie-break: earlier
//          enrollment, then older child), every subscription below #1 gets
//          the discount on its own post-multi-trip subtotal.
//     -> 3. Institutional discount: school-match + returning-student/manual
//          overrides, SUMMED (not compounded) into one percentage, applied
//          to the post-sibling subtotal.
//     -> net.
//     -> 4. Absence credit: under 3 CANCELLED events this period, no
//          credit. At 3 or more, credit = count x the NOTIONAL rate
//          (net / notional occurrences, i.e. the same denominator that
//          produced gross) -- uncapped, not capped at 3 -- floored so the
//          final total never goes negative. Using the notional rather than
//          the real occurrence count is what keeps the value of one absence
//          identical in every month, consistent with a flat price.

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
  /**
   * One entry per slot in the WEEKLY schedule pattern, in schedule order:
   * transport `schedule[].dayOfWeek`, study `days[].day`. Its length is the
   * schedule length that drives flat gross; its per-weekday distribution is
   * what makes the marginal multi-trip discount computable without counting
   * events (a weekday appearing twice = a genuine pickup + dropoff pair).
   */
  scheduleWeekdays: string[];
  /** "all" = every week, "odd"/"even" = biweekly. Anything else is treated as biweekly, matching discountRecalc.ts. */
  weekPattern?: string;
  /** Per-occurrence rate in cents: transportConfig.flatRatePerTrip / studyPerDayRate(studyConfig), x100. */
  ratePerOccurrenceCents: number;
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

/**
 * Billing weeks in a month for a given week pattern: 4 for every week, 2 for
 * biweekly. MUST stay byte-identical in behaviour to activeWeeksInPattern in
 * discountRecalc.ts — that function sets `subscription.monthlyFee`, this one
 * sets what is actually invoiced, and a divergence between the two is exactly
 * what caused the earlier double-discount bug. (They are duplicated rather
 * than shared only because discountRecalc.ts is out of scope for this change;
 * unifying them is a follow-up.)
 */
export function activeWeeksInPattern(pattern: string | undefined): 2 | 4 {
  return (pattern ?? "all") === "all" ? 4 : 2;
}

/**
 * Per-occurrence study rate, in euros — the same convention used to freeze
 * ReservationEvent.basePriceCents (StudyCenterConfig.pricePerDayPerWeek).
 * Duplicated for now in reservationEvents.ts; that copy should import this
 * one, but that file is out of scope for this change.
 */
export function studyPerDayRate(cfg: any): number {
  if (cfg?.pricePerDayPerWeek != null) return cfg.pricePerDayPerWeek;
  if (cfg?.monthlyPricePerWeekday != null) return cfg.monthlyPricePerWeekday / (cfg?.weeksPerMonth ?? 4);
  return 0;
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
  // ── Step 1: flat gross + marginal multi-trip, per subscription ─────────
  const step1 = subs.map(sub => {
    const events = (eventsBySub.get(sub.id) ?? []).filter(e => e.status !== "VOIDED");

    // VOIDED under flat pricing is a per-PERIOD on/off switch, not a
    // per-occurrence deduction. Voiding happens from today forward when a
    // subscription is cancelled or rescheduled, so:
    //   - a period with at least one live (EXPECTED/CANCELLED) occurrence =
    //     the subscription ran that month -> the full flat price applies,
    //     exactly as it would in a 4-Monday vs 5-Monday month;
    //   - a period whose occurrences are ALL voided = the subscription was
    //     already over before the period began -> nothing is billed.
    // That is what stops a mid-month cancellation from billing future
    // periods while leaving the elapsed one intact. Note the deliberate
    // consequence: flat pricing does not pro-rate, so the month in which the
    // cancellation happens is billed in full.
    const runsThisPeriod = events.length > 0;

    const weeks = activeWeeksInPattern(sub.weekPattern);
    const scheduleLength = sub.scheduleWeekdays.length;
    // The denominator behind both gross and the notional absence rate.
    const notionalOccurrences = scheduleLength * weeks;
    const grossCents = runsThisPeriod ? notionalOccurrences * sub.ratePerOccurrenceCents : 0;

    // Marginal multi-trip, from the schedule pattern rather than from
    // counting events: on a weekday served N times, the first
    // (minTripsPerDay - 1) legs are always full price and only the rest are
    // eligible. minTripsPerDay is floored at 1 so a misconfigured 0 can never
    // make MORE than the scheduled legs eligible.
    const minTrips = Math.max(1, cfg.minTripsPerDay);
    const slotsByWeekday = new Map<string, number>();
    for (const wd of sub.scheduleWeekdays) slotsByWeekday.set(wd, (slotsByWeekday.get(wd) ?? 0) + 1);
    let eligibleSlots = 0;
    for (const count of slotsByWeekday.values()) {
      if (count >= minTrips) eligibleSlots += count - (minTrips - 1);
    }
    const discountEligibleCents = runsThisPeriod ? eligibleSlots * weeks * sub.ratePerOccurrenceCents : 0;
    const multiTripDiscountCents = Math.round(discountEligibleCents * cfg.multiTripDiscountPct);

    return {
      sub, events, notionalOccurrences, grossCents, multiTripDiscountCents,
      subtotal: grossCents - multiTripDiscountCents,
    };
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

  // ── Step 3: institutional discount (school + returning/manual), summed ──
  const step3 = step2.map(item => {
    const schoolPct = cfg.schoolDiscounts.find(sd => matchesSchool(item.sub.schoolName, sd.schoolName))?.discountPercentage ?? 0;
    const returningPct = item.sub.returningStudent ? cfg.returningStudentDiscountPct : 0;

    // The returning-student flag and an admin-applied ("manual") discount are
    // two encodings of the SAME real-world concession, not two concessions.
    // In prod the flag is set on zero subscriptions while 7 carry a manual
    // "Aluno do ano anterior" discount at 15% — and the transport config's
    // returningStudentDiscountPercentage is also 0.15. Summing them meant
    // that the first time anyone ticked that flag on one of those 7, the
    // family would silently receive 30%. They are therefore mutually
    // exclusive: whichever is more generous applies, once. Only the school
    // discount — a genuinely separate, differently-sourced concession — is
    // added on top.
    const concessionPct = Math.max(returningPct, item.sub.manualDiscountPct);

    const institutionalDiscountPct = Math.min(schoolPct + concessionPct, 1);
    const institutionalDiscountCents = Math.round(item.subtotal * institutionalDiscountPct);
    return { ...item, institutionalDiscountPct, institutionalDiscountCents, netBeforeAbsence: item.subtotal - institutionalDiscountCents };
  });

  // ── Step 4: absence credit, uncapped once the 3-absence gate is reached ──
  return step3.map(item => {
    const cancelled = item.events.filter(e => e.status === "CANCELLED").sort((a, b) => a.date.localeCompare(b.date));
    const absenceCount = cancelled.length;
    // NOTIONAL rate, not net / real-occurrences-this-period: the flat price
    // buys a notional `scheduleLength x activeWeeks` occurrences, so one
    // missed day is worth the same in a 4-Monday month as in a 5-Monday one.
    // Using the real count here would put back exactly the calendar variance
    // the flat gross above removes.
    const perOccurrenceRateCents = item.notionalOccurrences > 0 ? item.netBeforeAbsence / item.notionalOccurrences : 0;
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
