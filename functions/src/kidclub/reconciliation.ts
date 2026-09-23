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
  /**
   * Admin overrides of the automatic discounts, by rule id: true = force on,
   * false = force off, absent = let the automatic result stand. An overridden
   * rule's structural calculation is suppressed and, when forced on, its
   * percentage is applied flat in the institutional tier instead.
   */
  discountOverrides?: Record<string, boolean>;
  /**
   * Whether the subscription's contract covers this billing period at all —
   * computed by the caller with contractCoversPeriod() below.
   *
   * This, not the presence of occurrences, is what decides whether the flat
   * monthly price applies. See the note on runsThisPeriod in reconcileService.
   */
  coversPeriod: boolean;
}

export interface ReconciliationConfig {
  multiTripDiscountPct: number; // e.g. 0.10
  minTripsPerDay: number;       // e.g. 2 — the 1st trip that day is always full price
  siblingDiscountPct: number;   // e.g. 0.10
  schoolDiscounts: { schoolName: string; discountPercentage: number; ruleId?: string }[];
  returningStudentDiscountPct: number;
  /** Rule ids, so a per-rule admin override can be matched to the step that implements it. */
  multiTripRuleId?: string;
  siblingRuleId?: string;
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

/**
 * schoolName is canonical on the child record, but subscriptions keep a mirror
 * of it and the two disagree in prod. It decides the 20% school discount, so
 * how the two are combined is a money decision, not a display one.
 *
 * Resolved per FIELD, never per record. Keying the fallback on whether a
 * childId exists has a hole that is reachable today: ClaimSubscriptionsPage
 * validates only firstName/lastName/dateOfBirth and writes
 * `schoolName: f.schoolName.trim() || null`, so a parent claiming a
 * subscription can create a child record with no school while the subscription
 * simultaneously gains a childId. Keyed on the record, that subscription would
 * switch to reading a child that has no school and silently lose the discount.
 *
 * Blank and whitespace-only count as absent, not as an answer — `??` alone
 * would let `schoolName: ""` resolve to empty and drop the match the same way.
 */
export function resolveSchoolName(
  childSchoolName: string | null | undefined,
  subSchoolName: string | null | undefined,
): string | undefined {
  return childSchoolName?.trim() || subSchoolName?.trim() || undefined;
}

function matchesSchool(schoolName: string | undefined, ruleSchoolName: string): boolean {
  if (!schoolName) return false;
  const a = schoolName.toLowerCase();
  const b = ruleSchoolName.toLowerCase();
  return a.includes(b) || b.includes(a);
}

/**
 * Does this subscription's contract overlap the billing period?
 *
 * Deliberately NOT clamped to the school year. The annual fee is spread over
 * 12 months, so August — which contains no school days at all and therefore no
 * occurrences — still bills the flat price. A missing startDate/endDate means
 * "open at that end", which is the common case: 19 of 21 active transport
 * subscriptions carry neither.
 *
 * Ending a subscription is expressed as an endDate or a cancellation, never as
 * "the school year ran out" — that is the distinction this function exists to
 * preserve.
 */
export function contractCoversPeriod(
  startDate: Date | null | undefined,
  endDate: Date | null | undefined,
  periodStart: Date,
  periodEnd: Date,
): boolean {
  if (startDate && startDate > periodEnd) return false;
  if (endDate && endDate < periodStart) return false;
  return true;
}

/**
 * An admin's override for one rule, or undefined when they have no opinion.
 *
 * Kept as a named lookup rather than inlined because "undefined means no
 * opinion" and "false means explicitly off" are different states, and reading
 * the map directly invites collapsing them into one falsy check.
 */
function overrideFor(sub: SubscriptionForReconciliation, ruleId: string | undefined): boolean | undefined {
  if (!ruleId) return undefined;
  const v = sub.discountOverrides?.[ruleId];
  return typeof v === "boolean" ? v : undefined;
}

export function reconcileService(
  subs: SubscriptionForReconciliation[],
  eventsBySub: Map<string, ReservationEventLite[]>,
  cfg: ReconciliationConfig,
): ReconciledLineItem[] {
  // ── Step 1: flat gross + marginal multi-trip, per subscription ─────────
  const step1 = subs.map(sub => {
    const rawEvents = eventsBySub.get(sub.id) ?? [];
    const events = rawEvents.filter(e => e.status !== "VOIDED");

    // VOIDED under flat pricing is a per-PERIOD on/off switch, not a
    // per-occurrence deduction. Voiding happens from today forward when a
    // subscription is cancelled or rescheduled, so:
    //   - a period with at least one live (EXPECTED/CANCELLED) occurrence =
    //     the subscription ran that month -> the full flat price applies,
    //     exactly as it would in a 4-Monday vs 5-Monday month;
    //   - a period whose occurrences are ALL voided = the subscription was
    //     already over before the period began -> nothing is billed.
    // That is what stops a mid-month cancellation from billing future
    // periods while leaving the elapsed one intact.
    //
    // The BOUNDARY month itself is not voided and is not pro-rated here
    // either: gross stays flat. Instead the days outside the contract are
    // written as CANCELLED system absences by reservationEvents.ts, so step 4
    // below pro-rates that month through the ordinary absence credit. Nothing
    // in this file is aware of the boundary — that is deliberate, pro-rating
    // is not a pricing concept. One consequence worth knowing: the >=3
    // threshold still applies, so a cancellation in the last couple of days
    // of a month credits nothing and bills the month in full.
    //
    // Whether the period is billable comes from the CONTRACT, not from the
    // event count. "No events -> EUR 0" was the earlier rule and it silently
    // zeroed August: event generation stops at
    // config/schoolCalendar.yearEndDate (2027-07-15), so August 2027 produced
    // no occurrences for anyone and 22 active subscriptions with existing
    // billing records computed EUR 0 — EUR 1,800 in one month, against
    // decision 1's explicit "no EUR 0 August". A month with no school days is
    // still a month of the 12-month spread. A subscription stops billing
    // because it ended or was cancelled, which is what coversPeriod encodes.
    //
    // "All occurrences VOIDED" is kept as a separate EUR 0: that means the
    // subscription was already over before the period began, and unlike an
    // empty list it is positive evidence rather than an absence of evidence.
    const allVoided = rawEvents.length > 0 && events.length === 0;
    const runsThisPeriod = sub.coversPeriod && !allVoided;

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
    // An admin override replaces the marginal calculation with a flat
    // percentage in the institutional tier (see overridePctFor), so the
    // structural discount is suppressed in BOTH directions — forced off and
    // forced on. Applying both would be the same double-count that the
    // appliedBy label already caused once.
    const multiTripOverridden = overrideFor(sub, cfg.multiTripRuleId) !== undefined;
    const discountEligibleCents = runsThisPeriod && !multiTripOverridden
      ? eligibleSlots * weeks * sub.ratePerOccurrenceCents : 0;
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
    // Same as multi-trip: an overridden sibling discount is applied flat
    // below, never here. The subscription still takes part in the ranking —
    // it is still one of the family's subscriptions, and removing it would
    // change which sibling counts as child #1.
    const siblingOverridden = overrideFor(item.sub, cfg.siblingRuleId) !== undefined;
    const siblingDiscountCents = (idx === 0 || siblingOverridden)
      ? 0 : Math.round(item.subtotal * cfg.siblingDiscountPct);
    return { ...item, siblingDiscountCents, subtotal: item.subtotal - siblingDiscountCents };
  });

  // ── Step 3: institutional discount (school + returning/manual), summed ──
  const step3 = step2.map(item => {
    // School is already a flat percentage, so an override only decides whether
    // it applies at all — forced on, it applies without a name match.
    const schoolRule = cfg.schoolDiscounts.find(sd => matchesSchool(item.sub.schoolName, sd.schoolName));
    const schoolOverrides = cfg.schoolDiscounts
      .map(sd => ({ sd, ov: overrideFor(item.sub, sd.ruleId) }))
      .filter(x => x.ov !== undefined);
    const schoolPct = schoolOverrides.length
      ? schoolOverrides.reduce((n, x) => n + (x.ov ? x.sd.discountPercentage : 0), 0)
      : (schoolRule?.discountPercentage ?? 0);

    // Multi-trip and sibling, when an admin has overruled them: flat
    // percentages here instead of their structural calculations above.
    const overridePct =
      (overrideFor(item.sub, cfg.multiTripRuleId) ? cfg.multiTripDiscountPct : 0)
      + (overrideFor(item.sub, cfg.siblingRuleId) ? cfg.siblingDiscountPct : 0);

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

    const institutionalDiscountPct = Math.min(schoolPct + concessionPct + overridePct, 1);
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

// ── Config mapping ──────────────────────────────────────────────────────────
// These two live here rather than in billing.ts because they are pure and
// because they decide money: the Phase 3 reconciliation report has to apply
// exactly the same rules, and a second copy of manualDiscountPctFor in the
// report script is precisely how the appliedBy double-count stayed invisible
// for a run longer than it needed to.

// Maps the config/discounts rules doc + service config into the flat shape
// reconcileService() expects. Manual (admin-applied) discounts already
// stored on the subscription are folded into the institutional tier, same
// tier as school/returning-student — they're all "a percentage on the
// post-sibling subtotal," just from different sources.
export function buildReconciliationConfig(
  type: "study" | "transport",
  rules: any[],
  serviceConfig: any,
): ReconciliationConfig {
  const multiTripRule = rules.find(r => r.active && r.trigger === "auto_multitrip" && r.appliesTo?.includes(type));
  const siblingRule = rules.find(r => r.active && r.trigger === "auto_sibling" && r.appliesTo?.includes(type));
  const schoolRules = rules.filter(r => r.active && r.trigger === "auto_school" && r.appliesTo?.includes(type) && r.schoolName);
  return {
    multiTripDiscountPct: multiTripRule?.percentage ?? 0,
    minTripsPerDay: multiTripRule?.minTripsPerDay ?? 2,
    siblingDiscountPct: siblingRule?.percentage ?? 0,
    schoolDiscounts: schoolRules.map(r => ({ schoolName: r.schoolName, discountPercentage: r.percentage, ruleId: r.id })),
    returningStudentDiscountPct: serviceConfig?.returningStudentDiscountPercentage ?? 0,
    multiTripRuleId: multiTripRule?.id,
    siblingRuleId: siblingRule?.id,
  };
}

// Only a genuinely MANUAL rule counts as a manual concession. The earlier
// version also counted anything stamped `appliedBy: "admin"`, whatever the
// rule's trigger — which double-charged the automatic discounts, because
// reconcileService recomputes multi-trip/sibling/school structurally and would
// then add the same rule again as a flat percentage.
//
// An admin ticking an automatic rule is not a second concession: the admin UI
// (SubscriptionsAdminPage.toggleManualDiscount) stamps `appliedBy: "admin"` on
// whichever rule was clicked, including an automatic one, so the label records
// who last touched the row rather than what kind of discount it is. Two live
// subscriptions were in that state (Carolina Almeida, Maria Manon) and would
// each have received 30% instead of 20% at cutover. Keyed on `trigger`, an
// auto rule toggled by an admin is applied exactly once, by the pipeline step
// that owns it.
//
// A discount whose rule no longer exists is ignored rather than trusted: its
// percentage is unverifiable, and there are none in prod today.
export function manualDiscountPctFor(sub: any, rules: any[]): number {
  const manual: { percentage: number }[] = (sub.appliedDiscounts ?? []).filter((ad: any) =>
    rules.find(r => r.id === ad.ruleId)?.trigger === "manual");
  return manual.reduce((s, d) => s + d.percentage, 0);
}
