import { describe, it, expect } from "vitest";
import { reconcileService, resolveSchoolName, contractCoversPeriod, ReservationEventLite, SubscriptionForReconciliation, ReconciliationConfig } from "./reconciliation";

// ── Test helpers ─────────────────────────────────────────────────────────────

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"];

// Default shape: one occurrence on each of the five weekdays, every week, at
// €6 — i.e. a notional 5 x 4 = 20 occurrences a month, €120 flat gross. That
// is deliberately the same €120 the old occurrence-summing model produced for
// a 20-occurrence month, so the tests below perturb one thing at a time.
function sub(overrides: Partial<SubscriptionForReconciliation> & { id: string }): SubscriptionForReconciliation {
  return {
    childId: overrides.id,
    manualDiscountPct: 0,
    enrollmentDate: new Date("2026-09-01"),
    scheduleWeekdays: WEEKDAYS,
    weekPattern: "all",
    ratePerOccurrenceCents: 600,
    coversPeriod: true,
    ...overrides,
  };
}

function ev(date: string, cents: number, status: ReservationEventLite["status"] = "EXPECTED"): ReservationEventLite {
  return { date, basePriceCents: cents, status };
}

// Materialized occurrences for the period. Under flat pricing these no longer
// determine gross — they only say "this subscription ran this period" and
// carry the absences.
function occurrences(count: number, cents = 600): ReservationEventLite[] {
  return Array.from({ length: count }, (_, i) => ev(`2026-09-${String(i + 1).padStart(2, "0")}`, cents));
}

function cancelledOn(count: number, startDay = 21): ReservationEventLite[] {
  return Array.from({ length: count }, (_, i) => ev(`2026-09-${startDay + i}`, 600, "CANCELLED"));
}

const NO_DISCOUNTS: ReconciliationConfig = {
  multiTripDiscountPct: 0,
  minTripsPerDay: 2,
  siblingDiscountPct: 0,
  schoolDiscounts: [],
  returningStudentDiscountPct: 0,
};

// ── Flat gross ───────────────────────────────────────────────────────────────

describe("flat monthly gross (decision 2026-09-22: schedule pattern, never a count of occurrences)", () => {
  it("bills scheduleLength x rate x 4 for a weekly pattern", () => {
    const s = sub({ id: "s1" });
    const [r] = reconcileService([s], new Map([["s1", occurrences(20)]]), NO_DISCOUNTS);
    expect(r.grossCents).toBe(12000); // 5 days x €6 x 4 weeks
    expect(r.finalCents).toBe(12000);
  });

  it("is identical in a five-Monday month and a four-Monday month — the whole point of the change", () => {
    const s = sub({ id: "s1" });
    const fourWeeks = reconcileService([s], new Map([["s1", occurrences(20)]]), NO_DISCOUNTS)[0];
    const fiveWeeks = reconcileService([s], new Map([["s1", occurrences(23)]]), NO_DISCOUNTS)[0];
    expect(fiveWeeks.grossCents).toBe(fourWeeks.grossCents);
    expect(fiveWeeks.finalCents).toBe(fourWeeks.finalCents);
  });

  it("a short month (school year ends mid-July) still bills the full flat price", () => {
    const s = sub({ id: "s1" });
    const [r] = reconcileService([s], new Map([["s1", occurrences(9)]]), NO_DISCOUNTS);
    expect(r.grossCents).toBe(12000);
  });

  it("halves the notional weeks for an 'odd' biweekly pattern", () => {
    const s = sub({ id: "s1", weekPattern: "odd" });
    const [r] = reconcileService([s], new Map([["s1", occurrences(10)]]), NO_DISCOUNTS);
    expect(r.grossCents).toBe(6000); // 5 days x €6 x 2 weeks
  });

  it("halves the notional weeks for an 'even' biweekly pattern too", () => {
    const s = sub({ id: "s1", weekPattern: "even" });
    const [r] = reconcileService([s], new Map([["s1", occurrences(10)]]), NO_DISCOUNTS);
    expect(r.grossCents).toBe(6000);
  });

  it("a missing weekPattern is treated as 'all' (4 weeks), matching discountRecalc.ts", () => {
    const s = sub({ id: "s1", weekPattern: undefined });
    const [r] = reconcileService([s], new Map([["s1", occurrences(20)]]), NO_DISCOUNTS);
    expect(r.grossCents).toBe(12000);
  });

  it("scales with schedule length, counting two legs on the same weekday twice", () => {
    const twoLegMondays = sub({ id: "s1", scheduleWeekdays: ["monday", "monday"] });
    const [r] = reconcileService([twoLegMondays], new Map([["s1", occurrences(8)]]), NO_DISCOUNTS);
    expect(r.grossCents).toBe(4800); // 2 legs x €6 x 4 weeks
  });
});

// ── VOIDED under flat pricing ───────────────────────────────────────────────

describe("VOIDED occurrences (flat pricing makes this a per-period on/off switch, not a per-occurrence deduction)", () => {
  it("a mid-month cancellation still bills the elapsed month in full — flat pricing does not pro-rate", () => {
    const s = sub({ id: "s1" });
    const events = new Map([["s1", [
      ...occurrences(10),
      ...Array.from({ length: 10 }, (_, i) => ev(`2026-09-${20 + i}`, 600, "VOIDED")),
    ]]]);
    const [r] = reconcileService([s], events, NO_DISCOUNTS);
    expect(r.grossCents).toBe(12000);
    expect(r.finalCents).toBe(12000);
  });

  it("a period whose occurrences are ALL voided bills nothing — this is what stops future periods", () => {
    const s = sub({ id: "s1" });
    const events = new Map([["s1", Array.from({ length: 20 }, (_, i) => ev(`2026-10-${String(i + 1).padStart(2, "0")}`, 600, "VOIDED"))]]);
    const [r] = reconcileService([s], events, NO_DISCOUNTS);
    expect(r.grossCents).toBe(0);
    expect(r.finalCents).toBe(0);
  });

  it("an all-voided period also produces no multi-trip discount line, not a negative one", () => {
    const cfg: ReconciliationConfig = { ...NO_DISCOUNTS, multiTripDiscountPct: 0.1, minTripsPerDay: 2 };
    const s = sub({ id: "s1", scheduleWeekdays: ["monday", "monday"] });
    const events = new Map([["s1", [ev("2026-10-05", 600, "VOIDED"), ev("2026-10-05", 600, "VOIDED")]]]);
    const [r] = reconcileService([s], events, cfg);
    expect(r.grossCents).toBe(0);
    expect(r.multiTripDiscountCents).toBe(0);
    expect(r.finalCents).toBe(0);
  });

  // This is the August case. Event generation stops at the school year end, so
  // August produces no occurrences for anyone; under the old "no events -> EUR
  // 0" rule every active subscription silently billed nothing. The annual fee
  // is spread over 12 months, so a month with no school days still bills.
  it("no events at all still bills the flat price when the contract covers the period (August)", () => {
    const s = sub({ id: "s1" });
    const [r] = reconcileService([s], new Map<string, ReservationEventLite[]>(), NO_DISCOUNTS);
    expect(r.grossCents).toBe(12000);
    expect(r.finalCents).toBe(12000);
    expect(r.absenceCount).toBe(0);
  });

  it("no events and the contract does not cover the period produces a zero-value line item, not an error", () => {
    const s = sub({ id: "s1", coversPeriod: false });
    const [r] = reconcileService([s], new Map<string, ReservationEventLite[]>(), NO_DISCOUNTS);
    expect(r.grossCents).toBe(0);
    expect(r.finalCents).toBe(0);
  });

  it("an all-VOIDED period still bills EUR 0 even though the contract covers it", () => {
    const s = sub({ id: "s1" });
    const events = new Map([["s1", [ev("2026-10-05", 600, "VOIDED"), ev("2026-10-06", 600, "VOIDED")]]]);
    const [r] = reconcileService([s], events, NO_DISCOUNTS);
    expect(r.grossCents).toBe(0);
    expect(r.finalCents).toBe(0);
  });

  it("CANCELLED occurrences keep a period billable — an absence is not an ended subscription", () => {
    const s = sub({ id: "s1" });
    const [r] = reconcileService([s], new Map([["s1", cancelledOn(2)]]), NO_DISCOUNTS);
    expect(r.grossCents).toBe(12000);
    expect(r.absenceCount).toBe(2);
    expect(r.absenceCreditCents).toBe(0); // under threshold
    expect(r.finalCents).toBe(12000);
  });
});

// ── Absence threshold: gate at 3, uncapped, floored at zero, NOTIONAL rate ──

describe("absence credit (gate at 3, then credit the FULL count; rate is notional, not per real occurrence)", () => {
  const cases: [count: number, expectCredited: boolean][] = [
    [0, false], [1, false], [2, false], [3, true], [4, true], [10, true],
  ];
  for (const [count, expectCredited] of cases) {
    it(`${count} absence(s) -> credit ${expectCredited ? "applies" : "does not apply"}`, () => {
      const s = sub({ id: "s1" });
      const events = new Map([["s1", [...occurrences(20 - count), ...cancelledOn(count)]]]);
      const [r] = reconcileService([s], events, NO_DISCOUNTS);
      const rate = 12000 / 20; // net / NOTIONAL occurrences (5 days x 4 weeks)
      if (expectCredited) {
        expect(r.absenceCreditCents).toBeCloseTo(count * rate, 5);
      } else {
        expect(r.absenceCreditCents).toBe(0);
      }
    });
  }

  it("credits the full count once threshold is reached, NOT capped at 3", () => {
    const s = sub({ id: "s1" });
    const events = new Map([["s1", [...occurrences(15), ...cancelledOn(5, 25)]]]);
    const [r] = reconcileService([s], events, NO_DISCOUNTS);
    expect(r.absenceCount).toBe(5);
    expect(r.absenceCreditCents).toBe(3000); // 5 x (12000 / 20)
    expect(r.finalCents).toBe(9000);
  });

  it("the credit per absence is the SAME in a 20-occurrence month and a 23-occurrence month", () => {
    const s = sub({ id: "s1" });
    const shortMonth = reconcileService([s], new Map([["s1", [...occurrences(17), ...cancelledOn(3)]]]), NO_DISCOUNTS)[0];
    const longMonth = reconcileService([s], new Map([["s1", [...occurrences(20), ...cancelledOn(3)]]]), NO_DISCOUNTS)[0];
    expect(longMonth.absenceCreditCents).toBe(shortMonth.absenceCreditCents);
    expect(longMonth.finalCents).toBe(shortMonth.finalCents);
  });

  it("a biweekly subscription's absence is worth twice as much as a weekly one's, per occurrence", () => {
    const weekly = sub({ id: "weekly" });
    const biweekly = sub({ id: "biweekly", weekPattern: "odd" });
    const events = new Map([
      ["weekly", [...occurrences(17), ...cancelledOn(3)]],
      ["biweekly", [...occurrences(7), ...cancelledOn(3)]],
    ]);
    const [rW] = reconcileService([weekly], events, NO_DISCOUNTS);
    const [rB] = reconcileService([biweekly], events, NO_DISCOUNTS);
    // weekly: net 12000 / 20 notional = 600/absence. biweekly: net 6000 / 10 = 600/absence.
    expect(rW.absenceCreditCents).toBe(1800);
    expect(rB.absenceCreditCents).toBe(1800);
  });

  it("floors the credit so the final total never goes negative", () => {
    // 1 leg a week, biweekly -> a notional 2 occurrences a month, gross €12.
    // 3 absences would credit 1.5x the net; it must clamp to exactly the net.
    const s = sub({ id: "s1", scheduleWeekdays: ["monday"], weekPattern: "odd" });
    const [r] = reconcileService([s], new Map([["s1", cancelledOn(3, 7)]]), NO_DISCOUNTS);
    expect(r.grossCents).toBe(1200);
    expect(r.absenceCreditCents).toBe(1200);
    expect(r.finalCents).toBe(0);
  });

  it("derives the per-absence rate from the NET total (after other discounts), not a flat config rate", () => {
    const cfgWithSchool: ReconciliationConfig = { ...NO_DISCOUNTS, schoolDiscounts: [{ schoolName: "Test School", discountPercentage: 0.5 }] };
    const discounted = sub({ id: "s1", schoolName: "Test School" });
    const plain = sub({ id: "s2" });
    const events = new Map([
      ["s1", [...occurrences(17), ...cancelledOn(3, 25)]],
      ["s2", [...occurrences(17), ...cancelledOn(3, 25)]],
    ]);
    const [rDiscounted] = reconcileService([discounted], events, cfgWithSchool);
    const [rPlain] = reconcileService([plain], events, NO_DISCOUNTS);
    expect(rDiscounted.absenceCreditCents).toBeCloseTo(rPlain.absenceCreditCents / 2, 5);
  });

  it("each subscription's absence count is independent — one family's cancellations never leak into another's", () => {
    const a = sub({ id: "a" });
    const b = sub({ id: "b" });
    const events = new Map([
      ["a", [...occurrences(17), ...cancelledOn(3, 25)]],
      ["b", occurrences(20)],
    ]);
    const [rA, rB] = reconcileService([a, b], events, NO_DISCOUNTS);
    expect(rA.absenceCount).toBe(3);
    expect(rB.absenceCount).toBe(0);
    expect(rB.absenceCreditCents).toBe(0);
  });
});

// ── Marginal multi-trip discount, from the schedule pattern ──────────────────

describe("marginal multi-trip discount (only leg #2+ on a scheduled weekday, computed from the pattern)", () => {
  const cfg: ReconciliationConfig = { ...NO_DISCOUNTS, multiTripDiscountPct: 0.1, minTripsPerDay: 2 };

  it("a single leg per weekday is never discounted, regardless of how many weekdays", () => {
    const s = sub({ id: "s1" });
    const [r] = reconcileService([s], new Map([["s1", occurrences(20)]]), cfg);
    expect(r.multiTripDiscountCents).toBe(0);
  });

  it("two legs on the same weekday: only the 2nd is discounted, every week of the month", () => {
    const s = sub({ id: "s1", scheduleWeekdays: ["monday", "monday"] });
    const [r] = reconcileService([s], new Map([["s1", occurrences(8)]]), cfg);
    expect(r.grossCents).toBe(4800);          // 2 legs x €6 x 4 weeks
    expect(r.multiTripDiscountCents).toBe(240); // 1 eligible leg x €6 x 4 weeks x 10%
    expect(r.finalCents).toBe(4560);
  });

  it("three legs on the same weekday with minTripsPerDay=2: legs #2 and #3 are both discounted", () => {
    const s = sub({ id: "s1", scheduleWeekdays: ["monday", "monday", "monday"] });
    const [r] = reconcileService([s], new Map([["s1", occurrences(12)]]), cfg);
    expect(r.grossCents).toBe(7200);
    expect(r.multiTripDiscountCents).toBe(480); // 2 eligible legs x €6 x 4 weeks x 10%
  });

  it("weekdays are evaluated independently — a single-leg weekday contributes nothing", () => {
    const s = sub({ id: "s1", scheduleWeekdays: ["monday", "monday", "tuesday"] });
    const [r] = reconcileService([s], new Map([["s1", occurrences(12)]]), cfg);
    expect(r.grossCents).toBe(7200);
    expect(r.multiTripDiscountCents).toBe(240); // only the Monday pair
  });

  it("the discount does not grow in a five-Monday month — it follows the pattern, not the calendar", () => {
    const s = sub({ id: "s1", scheduleWeekdays: ["monday", "monday"] });
    const four = reconcileService([s], new Map([["s1", occurrences(8)]]), cfg)[0];
    const five = reconcileService([s], new Map([["s1", occurrences(10)]]), cfg)[0];
    expect(five.multiTripDiscountCents).toBe(four.multiTripDiscountCents);
  });

  it("a biweekly multi-leg pattern halves both gross and the multi-trip discount", () => {
    const s = sub({ id: "s1", scheduleWeekdays: ["monday", "monday"], weekPattern: "even" });
    const [r] = reconcileService([s], new Map([["s1", occurrences(4)]]), cfg);
    expect(r.grossCents).toBe(2400);
    expect(r.multiTripDiscountCents).toBe(120);
  });
});

// ── Marginal sibling discount ────────────────────────────────────────────────

describe("marginal sibling discount (highest-value subscription is 'child #1', full price; rest discounted)", () => {
  const cfg: ReconciliationConfig = { ...NO_DISCOUNTS, siblingDiscountPct: 0.1 };

  it("a single subscription with no siblings is never discounted", () => {
    const s = sub({ id: "s1" });
    const [r] = reconcileService([s], new Map([["s1", occurrences(20)]]), cfg);
    expect(r.siblingDiscountCents).toBe(0);
  });

  it("the higher-value subscription pays full price; the lower-value one is discounted", () => {
    const expensive = sub({ id: "expensive" });                                   // 5 days -> 12000
    const cheap = sub({ id: "cheap", scheduleWeekdays: ["monday", "tuesday"] });  // 2 days -> 4800
    const events = new Map([["expensive", occurrences(20)], ["cheap", occurrences(8)]]);
    const [rExpensive, rCheap] = reconcileService([expensive, cheap], events, cfg);
    expect(rExpensive.siblingDiscountCents).toBe(0);
    expect(rCheap.grossCents).toBe(4800);
    expect(rCheap.siblingDiscountCents).toBe(480);
  });

  it("ties in value break by earlier enrollment date -> earlier enrolled is position #1 (full price)", () => {
    const early = sub({ id: "early", enrollmentDate: new Date("2026-01-01") });
    const late = sub({ id: "late", enrollmentDate: new Date("2026-06-01") });
    const events = new Map([["early", occurrences(20)], ["late", occurrences(20)]]);
    const [rEarly, rLate] = reconcileService([early, late], events, cfg);
    expect(rEarly.siblingDiscountCents).toBe(0);
    expect(rLate.siblingDiscountCents).toBeGreaterThan(0);
  });

  it("ties in value AND enrollment date break by older child (earlier birthdate) -> position #1", () => {
    const older = sub({ id: "older", childBirthDate: new Date("2015-01-01") });
    const younger = sub({ id: "younger", childBirthDate: new Date("2020-01-01") });
    const events = new Map([["older", occurrences(20)], ["younger", occurrences(20)]]);
    const [rOlder, rYounger] = reconcileService([older, younger], events, cfg);
    expect(rOlder.siblingDiscountCents).toBe(0);
    expect(rYounger.siblingDiscountCents).toBeGreaterThan(0);
  });

  it("with 3+ siblings, only position #1 is exempt -- everyone else is discounted", () => {
    const a = sub({ id: "a" });
    const b = sub({ id: "b", scheduleWeekdays: ["monday", "tuesday", "wednesday"] });
    const c = sub({ id: "c", scheduleWeekdays: ["monday"] });
    const events = new Map([["a", occurrences(20)], ["b", occurrences(12)], ["c", occurrences(4)]]);
    const [rA, rB, rC] = reconcileService([a, b, c], events, cfg);
    expect(rA.siblingDiscountCents).toBe(0);
    expect(rB.siblingDiscountCents).toBeGreaterThan(0);
    expect(rC.siblingDiscountCents).toBeGreaterThan(0);
  });
});

// ── Institutional discount: summed, not compounded, applied after marginal tiers ──

describe("institutional discount (school + returning-student/manual, SUMMED not compounded)", () => {
  it("school discount alone", () => {
    const cfg: ReconciliationConfig = { ...NO_DISCOUNTS, schoolDiscounts: [{ schoolName: "Colégio X", discountPercentage: 0.2 }] };
    const s = sub({ id: "s1", schoolName: "Colégio X" });
    const [r] = reconcileService([s], new Map([["s1", occurrences(20)]]), cfg);
    expect(r.institutionalDiscountPct).toBeCloseTo(0.2, 5);
    expect(r.institutionalDiscountCents).toBe(2400);
  });

  it("returning-student discount alone", () => {
    const cfg: ReconciliationConfig = { ...NO_DISCOUNTS, returningStudentDiscountPct: 0.15 };
    const s = sub({ id: "s1", returningStudent: true });
    const [r] = reconcileService([s], new Map([["s1", occurrences(20)]]), cfg);
    expect(r.institutionalDiscountPct).toBeCloseTo(0.15, 5);
  });

  it("school + returning-student SUM (20% + 15% = 35%), do not compound (which would give 32%)", () => {
    const cfg: ReconciliationConfig = { ...NO_DISCOUNTS, schoolDiscounts: [{ schoolName: "Colégio X", discountPercentage: 0.2 }], returningStudentDiscountPct: 0.15 };
    const s = sub({ id: "s1", schoolName: "Colégio X", returningStudent: true });
    const [r] = reconcileService([s], new Map([["s1", occurrences(20)]]), cfg);
    expect(r.institutionalDiscountPct).toBeCloseTo(0.35, 5);
    expect(r.institutionalDiscountCents).toBe(4200);
  });

  it("manual admin discount is folded into the same summed tier", () => {
    const cfg: ReconciliationConfig = { ...NO_DISCOUNTS, schoolDiscounts: [{ schoolName: "Colégio X", discountPercentage: 0.2 }] };
    const s = sub({ id: "s1", schoolName: "Colégio X", manualDiscountPct: 0.05 });
    const [r] = reconcileService([s], new Map([["s1", occurrences(20)]]), cfg);
    expect(r.institutionalDiscountPct).toBeCloseTo(0.25, 5);
  });

  it("total institutional percentage is capped at 100%", () => {
    const cfg: ReconciliationConfig = { ...NO_DISCOUNTS, schoolDiscounts: [{ schoolName: "X", discountPercentage: 0.7 }], returningStudentDiscountPct: 0.5 };
    const s = sub({ id: "s1", schoolName: "X", returningStudent: true });
    const [r] = reconcileService([s], new Map([["s1", occurrences(20)]]), cfg);
    expect(r.institutionalDiscountPct).toBe(1);
    expect(r.finalCents).toBeGreaterThanOrEqual(0);
  });

  it("applies to the subtotal AFTER multi-trip and sibling discounts, not the original gross", () => {
    const cfg: ReconciliationConfig = {
      multiTripDiscountPct: 0.1, minTripsPerDay: 2, siblingDiscountPct: 0.1,
      schoolDiscounts: [{ schoolName: "X", discountPercentage: 0.2 }], returningStudentDiscountPct: 0,
    };
    const expensive = sub({ id: "expensive" }); // position 1, no sibling discount
    const cheap = sub({ id: "cheap", schoolName: "X", scheduleWeekdays: ["monday", "monday"] });
    const events = new Map([["expensive", occurrences(20)], ["cheap", occurrences(8)]]);
    const [, rCheap] = reconcileService([expensive, cheap], events, cfg);
    // gross 4800 -> multi-trip -240 -> 4560 -> sibling 10% = -456 -> 4104 -> school 20% = -821 (820.8 rounds up)
    expect(rCheap.grossCents).toBe(4800);
    expect(rCheap.multiTripDiscountCents).toBe(240);
    expect(rCheap.siblingDiscountCents).toBe(456);
    expect(rCheap.institutionalDiscountCents).toBe(821);
    expect(rCheap.netBeforeAbsenceCents).toBe(4800 - 240 - 456 - 821);
  });
});

// ── Returning-student vs manual discount: mutually exclusive ─────────────────

describe("returning-student and manual discount are the same concession, applied once", () => {
  const cfg: ReconciliationConfig = { ...NO_DISCOUNTS, returningStudentDiscountPct: 0.15 };

  it("the prod scenario: the 'Aluno do ano anterior' manual 15% plus the returningStudent flag gives 15%, not 30%", () => {
    const s = sub({ id: "s1", returningStudent: true, manualDiscountPct: 0.15 });
    const [r] = reconcileService([s], new Map([["s1", occurrences(20)]]), cfg);
    expect(r.institutionalDiscountPct).toBeCloseTo(0.15, 5);
    expect(r.institutionalDiscountCents).toBe(1800); // NOT 3600
  });

  it("the more generous of the two wins when they differ (flag larger)", () => {
    const s = sub({ id: "s1", returningStudent: true, manualDiscountPct: 0.05 });
    const [r] = reconcileService([s], new Map([["s1", occurrences(20)]]), cfg);
    expect(r.institutionalDiscountPct).toBeCloseTo(0.15, 5);
  });

  it("the more generous of the two wins when they differ (manual larger)", () => {
    const s = sub({ id: "s1", returningStudent: true, manualDiscountPct: 0.25 });
    const [r] = reconcileService([s], new Map([["s1", occurrences(20)]]), cfg);
    expect(r.institutionalDiscountPct).toBeCloseTo(0.25, 5);
  });

  it("today's prod data is unaffected: manual 15% with the flag unset still yields exactly 15%", () => {
    const s = sub({ id: "s1", returningStudent: false, manualDiscountPct: 0.15 });
    const [r] = reconcileService([s], new Map([["s1", occurrences(20)]]), cfg);
    expect(r.institutionalDiscountPct).toBeCloseTo(0.15, 5);
  });

  it("the school discount is a separate concession and still stacks on top", () => {
    const withSchool: ReconciliationConfig = { ...cfg, schoolDiscounts: [{ schoolName: "Bissaya", discountPercentage: 0.2 }] };
    const s = sub({ id: "s1", schoolName: "Bissaya Barreto", returningStudent: true, manualDiscountPct: 0.15 });
    const [r] = reconcileService([s], new Map([["s1", occurrences(20)]]), withSchool);
    expect(r.institutionalDiscountPct).toBeCloseTo(0.35, 5);
  });
});

// ── Reference families: real prod shapes, October 2026 ──────────────────────
// These four are the agreed acceptance figures for the migration (STATUS.md,
// 2026-09-22). Transport only, €6/trip, 10% multi-trip, 10% sibling,
// 20% Bissaya Barreto school discount.

describe("reference families (real prod shapes, October 2026 — service line items only)", () => {
  const TRANSPORT_CFG: ReconciliationConfig = {
    multiTripDiscountPct: 0.1,
    minTripsPerDay: 2,
    siblingDiscountPct: 0.1,
    schoolDiscounts: [{ schoolName: "Bissaya Barreto", discountPercentage: 0.2 }],
    returningStudentDiscountPct: 0.15,
  };

  it("Carolina Almeida: 10 legs, weekly, Bissaya -> €182.40 (was €168.00)", () => {
    const s = sub({
      id: "carolina", schoolName: "Bissaya Barreto",
      scheduleWeekdays: ["monday", "monday", "tuesday", "tuesday", "wednesday", "wednesday", "thursday", "thursday", "friday", "friday"],
    });
    const [r] = reconcileService([s], new Map([["carolina", occurrences(40)]]), TRANSPORT_CFG);
    expect(r.grossCents).toBe(24000);
    expect(r.multiTripDiscountCents).toBe(1200);
    expect(r.siblingDiscountCents).toBe(0);
    expect(r.institutionalDiscountCents).toBe(4560);
    expect(r.finalCents).toBe(18240); // €182.40
  });

  it("José Eduardo: 9 legs (four two-leg days + one single), weekly, Bissaya -> €165.12 (was €151.20)", () => {
    const s = sub({
      id: "jose", schoolName: "Bissaya Barreto",
      scheduleWeekdays: ["monday", "monday", "tuesday", "tuesday", "wednesday", "wednesday", "thursday", "thursday", "friday"],
    });
    const [r] = reconcileService([s], new Map([["jose", occurrences(36)]]), TRANSPORT_CFG);
    expect(r.grossCents).toBe(21600);
    expect(r.multiTripDiscountCents).toBe(960);
    expect(r.finalCents).toBe(16512); // €165.12
  });

  it("Maria Manon: 7 legs (two two-leg days + three singles), weekly, Bissaya -> €130.56 (was €117.60)", () => {
    const s = sub({
      id: "manon", schoolName: "Bissaya Barreto",
      scheduleWeekdays: ["monday", "monday", "tuesday", "tuesday", "wednesday", "thursday", "friday"],
    });
    const [r] = reconcileService([s], new Map([["manon", occurrences(28)]]), TRANSPORT_CFG);
    expect(r.grossCents).toBe(16800);
    expect(r.multiTripDiscountCents).toBe(480);
    expect(r.finalCents).toBe(13056); // €130.56
  });

  it("Mogo siblings: two 5-leg subs, Diogo ranked #1 and carrying the 15% manual concession -> €210.00 combined (was €198.00)", () => {
    // Equal value (5 legs each, no multi-trip), so the tie breaks on enrollment
    // date: Diogo enrolled first -> position #1 -> no sibling discount.
    const diogo = sub({ id: "diogo", enrollmentDate: new Date("2026-06-01"), manualDiscountPct: 0.15 });
    const sibling = sub({ id: "sibling", enrollmentDate: new Date("2026-07-01") });
    const events = new Map([["diogo", occurrences(20)], ["sibling", occurrences(20)]]);
    const results = reconcileService([diogo, sibling], events, TRANSPORT_CFG);
    const rDiogo = results.find(r => r.subscriptionId === "diogo")!;
    const rSibling = results.find(r => r.subscriptionId === "sibling")!;
    expect(rDiogo.siblingDiscountCents).toBe(0);
    expect(rDiogo.finalCents).toBe(10200);   // €120 - 15% = €102.00
    expect(rSibling.siblingDiscountCents).toBe(1200);
    expect(rSibling.finalCents).toBe(10800); // €120 - 10% sibling = €108.00
    expect(rDiogo.finalCents + rSibling.finalCents).toBe(21000); // €210.00
  });
});

describe("resolveSchoolName", () => {
  it("prefers the child record, which is canonical", () => {
    expect(resolveSchoolName("Colégio Bissaya Barreto", "Rua Pedro Alvares Cabral")).toBe("Colégio Bissaya Barreto");
  });

  // The reachable claim-flow hole: a parent claims a subscription, which links a
  // childId AND creates a child record with schoolName null. Keyed on childId
  // rather than on the field, this subscription would silently lose its 20%.
  it("falls back to the subscription copy when the linked child has no school", () => {
    expect(resolveSchoolName(null, "Colégio Bissaya Barreto")).toBe("Colégio Bissaya Barreto");
    expect(resolveSchoolName(undefined, "Colégio Bissaya Barreto")).toBe("Colégio Bissaya Barreto");
  });

  it("treats blank and whitespace-only as absent, not as an answer", () => {
    expect(resolveSchoolName("", "Colégio Bissaya Barreto")).toBe("Colégio Bissaya Barreto");
    expect(resolveSchoolName("   ", "Colégio Bissaya Barreto")).toBe("Colégio Bissaya Barreto");
  });

  it("returns undefined when neither source has a school", () => {
    expect(resolveSchoolName(null, null)).toBeUndefined();
    expect(resolveSchoolName("  ", "")).toBeUndefined();
  });

  // The fee consequence, end to end: a child record with no school must still
  // reach the 20% rule through the subscription copy.
  it("still matches the discount rule through the fallback", () => {
    const subs = [sub({ id: "s1", schoolName: resolveSchoolName(null, "Colégio Bissaya Barreto") })];
    const events = new Map([["s1", occurrences(20)]]);
    const [r] = reconcileService(subs, events, {
      ...NO_DISCOUNTS,
      schoolDiscounts: [{ schoolName: "Colégio Bissaya Barreto", discountPercentage: 0.2 }],
    });
    expect(r.institutionalDiscountPct).toBe(0.2);
    expect(r.institutionalDiscountCents).toBe(2400); // 20% of EUR 120 flat gross
  });
});

// ── Contract window vs school year ──────────────────────────────────────────

describe("contractCoversPeriod", () => {
  const aug = [new Date(2027, 7, 1), new Date(2027, 7, 31)] as const;

  it("covers a month past the school year end when the contract is open-ended", () => {
    expect(contractCoversPeriod(null, null, ...aug)).toBe(true);
  });

  it("covers August for a subscription that started during the year", () => {
    expect(contractCoversPeriod(new Date(2026, 8, 1), null, ...aug)).toBe(true);
  });

  it("excludes a period entirely before the subscription starts", () => {
    expect(contractCoversPeriod(new Date(2027, 9, 1), null, ...aug)).toBe(false);
  });

  it("excludes a period entirely after the subscription ended", () => {
    expect(contractCoversPeriod(null, new Date(2027, 5, 30), ...aug)).toBe(false);
  });

  it("includes the boundary months at both ends", () => {
    expect(contractCoversPeriod(new Date(2027, 7, 31), null, ...aug)).toBe(true);
    expect(contractCoversPeriod(null, new Date(2027, 7, 1), ...aug)).toBe(true);
  });
});

// ── An admin-toggled AUTO discount is applied once, not twice ───────────────

describe("an automatic discount an admin has toggled is never applied twice", () => {
  // Carolina Almeida's real shape: 10 legs a week, Bissaya Barreto, and the
  // Multi-viagem rule stored with appliedBy "admin" after an admin ticked it.
  // manualDiscountPctFor now keys on the rule's trigger, so manualDiscountPct
  // is 0 here and multi-trip is applied only by the step that owns it.
  const cfg: ReconciliationConfig = {
    multiTripDiscountPct: 0.1, minTripsPerDay: 2, siblingDiscountPct: 0.1,
    schoolDiscounts: [{ schoolName: "Colégio Bissaya Barreto", discountPercentage: 0.2 }],
    returningStudentDiscountPct: 0.15,
  };
  const carolina = (manualDiscountPct: number) => sub({
    id: "carolina", schoolName: "Colégio Bissaya Barreto", manualDiscountPct,
    scheduleWeekdays: ["monday", "monday", "tuesday", "tuesday", "wednesday",
      "wednesday", "thursday", "thursday", "friday", "friday"],
  });

  it("applies the multi-trip discount once: EUR 182.40", () => {
    const [r] = reconcileService([carolina(0)], new Map([["carolina", occurrences(20)]]), cfg);
    expect(r.grossCents).toBe(24000);
    expect(r.multiTripDiscountCents).toBe(1200);
    expect(r.institutionalDiscountPct).toBeCloseTo(0.2);
    expect(r.finalCents).toBe(18240);
  });

  it("counting the same auto rule again as a manual concession is what produced EUR 159.60", () => {
    const [r] = reconcileService([carolina(0.1)], new Map([["carolina", occurrences(20)]]), cfg);
    expect(r.institutionalDiscountPct).toBeCloseTo(0.3);
    expect(r.finalCents).toBe(15960);
  });
});
