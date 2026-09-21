import { describe, it, expect } from "vitest";
import { reconcileService, ReservationEventLite, SubscriptionForReconciliation, ReconciliationConfig } from "./reconciliation";

// ── Test helpers ─────────────────────────────────────────────────────────────

function sub(overrides: Partial<SubscriptionForReconciliation> & { id: string }): SubscriptionForReconciliation {
  return {
    childId: overrides.id,
    manualDiscountPct: 0,
    enrollmentDate: new Date("2026-09-01"),
    ...overrides,
  };
}

function ev(date: string, cents: number, status: ReservationEventLite["status"] = "EXPECTED"): ReservationEventLite {
  return { date, basePriceCents: cents, status };
}

const NO_DISCOUNTS: ReconciliationConfig = {
  multiTripDiscountPct: 0,
  minTripsPerDay: 2,
  siblingDiscountPct: 0,
  schoolDiscounts: [],
  returningStudentDiscountPct: 0,
};

// A month of 20 weekday occurrences at €6 each = €120 gross, no discounts,
// no absences — the baseline every other test perturbs one thing at a time.
function baselineEvents(count: number, cents = 600): ReservationEventLite[] {
  return Array.from({ length: count }, (_, i) => ev(`2026-09-${String(i + 1).padStart(2, "0")}`, cents));
}

// ── Gross / VOIDED handling ──────────────────────────────────────────────────

describe("gross computation", () => {
  it("sums EXPECTED events at their frozen price", () => {
    const s = sub({ id: "s1" });
    const events = new Map([["s1", baselineEvents(20)]]);
    const [r] = reconcileService([s], events, NO_DISCOUNTS);
    expect(r.grossCents).toBe(12000);
    expect(r.finalCents).toBe(12000);
  });

  it("counts CANCELLED events toward gross the same as EXPECTED (still billed unless threshold reached)", () => {
    const s = sub({ id: "s1" });
    const events = new Map([["s1", [...baselineEvents(18), ev("2026-09-19", 600, "CANCELLED"), ev("2026-09-20", 600, "CANCELLED")]]]);
    const [r] = reconcileService([s], events, NO_DISCOUNTS);
    expect(r.grossCents).toBe(12000); // 20 * 600, cancelled ones still counted
    expect(r.absenceCount).toBe(2);
    expect(r.absenceCreditCents).toBe(0); // under threshold
    expect(r.finalCents).toBe(12000);
  });

  it("excludes VOIDED events from gross entirely — subscription ended before this date", () => {
    const s = sub({ id: "s1" });
    const events = new Map([["s1", [...baselineEvents(10), ...Array.from({ length: 10 }, (_, i) => ev(`2026-09-${20 + i}`, 600, "VOIDED"))]]]);
    const [r] = reconcileService([s], events, NO_DISCOUNTS);
    expect(r.grossCents).toBe(6000); // only the 10 non-voided
  });

  it("a subscription with no events at all produces a zero-value line item, not an error", () => {
    const s = sub({ id: "s1" });
    const events = new Map<string, ReservationEventLite[]>();
    const [r] = reconcileService([s], events, NO_DISCOUNTS);
    expect(r.grossCents).toBe(0);
    expect(r.finalCents).toBe(0);
  });
});

// ── Absence threshold: gate at 3, uncapped, floored at zero ─────────────────

describe("absence threshold (agreed 2026-09-21: gate at 3, then credit the FULL count, not capped at 3)", () => {
  const cases: [count: number, expectCredited: boolean][] = [
    [0, false], [1, false], [2, false], [3, true], [4, true], [10, true],
  ];
  for (const [count, expectCredited] of cases) {
    it(`${count} absence(s) -> credit ${expectCredited ? "applies" : "does not apply"}`, () => {
      const s = sub({ id: "s1" });
      const total = 20;
      const events = new Map([["s1", [
        ...baselineEvents(total - count),
        ...Array.from({ length: count }, (_, i) => ev(`2026-09-${21 + i}`, 600, "CANCELLED")),
      ]]]);
      const [r] = reconcileService([s], events, NO_DISCOUNTS);
      const rate = 12000 / total; // net (no other discounts) / occurrences
      if (expectCredited) {
        expect(r.absenceCreditCents).toBeCloseTo(count * rate, 5);
      } else {
        expect(r.absenceCreditCents).toBe(0);
      }
    });
  }

  it("credits the full count once threshold is reached, NOT capped at 3 (this is the corrected behavior)", () => {
    const s = sub({ id: "s1" });
    const events = new Map([["s1", [
      ...baselineEvents(15),
      ...Array.from({ length: 5 }, (_, i) => ev(`2026-09-${25 + i}`, 600, "CANCELLED")),
    ]]]);
    const [r] = reconcileService([s], events, NO_DISCOUNTS);
    // 20 occurrences total, net = 12000, rate = 600/occurrence, 5 absences -> credit 5x600=3000, not 3x600=1800
    expect(r.absenceCount).toBe(5);
    expect(r.absenceCreditCents).toBe(3000);
    expect(r.finalCents).toBe(12000 - 3000);
  });

  it("floors the credit so the final total never goes negative", () => {
    const s = sub({ id: "s1" });
    // 3 occurrences total, all cancelled -- credit would be 100% of net, final must be exactly 0, not negative
    const events = new Map([["s1", [ev("2026-09-01", 600, "CANCELLED"), ev("2026-09-02", 600, "CANCELLED"), ev("2026-09-03", 600, "CANCELLED")]]]);
    const [r] = reconcileService([s], events, NO_DISCOUNTS);
    expect(r.finalCents).toBe(0);
    expect(r.absenceCreditCents).toBe(1800);
  });

  it("derives the per-absence rate from the NET total (after other discounts), not a flat config rate", () => {
    // A family with a 50% institutional discount should get half the absence credit
    // per day compared to an identical family with no discount.
    const cfgWithSchool: ReconciliationConfig = { ...NO_DISCOUNTS, schoolDiscounts: [{ schoolName: "Test School", discountPercentage: 0.5 }] };
    const discounted = sub({ id: "s1", schoolName: "Test School" });
    const plain = sub({ id: "s2" });
    const events = new Map([
      ["s1", [...baselineEvents(17), ...Array.from({ length: 3 }, (_, i) => ev(`2026-09-${25 + i}`, 600, "CANCELLED"))]],
      ["s2", [...baselineEvents(17), ...Array.from({ length: 3 }, (_, i) => ev(`2026-09-${25 + i}`, 600, "CANCELLED"))]],
    ]);
    const [rDiscounted] = reconcileService([discounted], events, cfgWithSchool);
    const [rPlain] = reconcileService([plain], events, NO_DISCOUNTS);
    expect(rDiscounted.absenceCreditCents).toBeCloseTo(rPlain.absenceCreditCents / 2, 5);
  });

  it("each subscription's absence count is independent — one family's cancellations never leak into another's", () => {
    const a = sub({ id: "a" });
    const b = sub({ id: "b" });
    const events = new Map([
      ["a", [...baselineEvents(17), ...Array.from({ length: 3 }, (_, i) => ev(`2026-09-${25 + i}`, 600, "CANCELLED"))]],
      ["b", baselineEvents(20)],
    ]);
    const [rA, rB] = reconcileService([a, b], events, NO_DISCOUNTS);
    expect(rA.absenceCount).toBe(3);
    expect(rB.absenceCount).toBe(0);
    expect(rB.absenceCreditCents).toBe(0);
  });
});

// ── Marginal multi-trip discount ─────────────────────────────────────────────

describe("marginal multi-trip discount (only trip #2+ on a given calendar date)", () => {
  const cfg: ReconciliationConfig = { ...NO_DISCOUNTS, multiTripDiscountPct: 0.1, minTripsPerDay: 2 };

  it("a single trip per day is never discounted, regardless of how many days", () => {
    const s = sub({ id: "s1" });
    const events = new Map([["s1", baselineEvents(20)]]); // one event per date
    const [r] = reconcileService([s], events, cfg);
    expect(r.multiTripDiscountCents).toBe(0);
  });

  it("two trips on the same date: only the 2nd is discounted", () => {
    const s = sub({ id: "s1" });
    const events = new Map([["s1", [ev("2026-09-01", 600), ev("2026-09-01", 600)]]]);
    const [r] = reconcileService([s], events, cfg);
    // gross 1200, only one of the two 600-cent trips is discount-eligible -> 60 cents off
    expect(r.grossCents).toBe(1200);
    expect(r.multiTripDiscountCents).toBe(60);
    expect(r.finalCents).toBe(1140);
  });

  it("three trips on the same date with minTripsPerDay=2: trips #2 and #3 are both discounted", () => {
    const s = sub({ id: "s1" });
    const events = new Map([["s1", [ev("2026-09-01", 600), ev("2026-09-01", 600), ev("2026-09-01", 600)]]]);
    const [r] = reconcileService([s], events, cfg);
    expect(r.grossCents).toBe(1800);
    expect(r.multiTripDiscountCents).toBe(120); // 2 trips x 600 x 10%
  });

  it("multi-trip days are evaluated independently per calendar date, not per week", () => {
    const s = sub({ id: "s1" });
    const events = new Map([["s1", [
      ev("2026-09-01", 600), ev("2026-09-01", 600), // multi-trip day
      ev("2026-09-02", 600), // single-trip day elsewhere in the same period
    ]]]);
    const [r] = reconcileService([s], events, cfg);
    expect(r.multiTripDiscountCents).toBe(60); // only from the 9-01 pair
  });
});

// ── Marginal sibling discount ────────────────────────────────────────────────

describe("marginal sibling discount (highest-value subscription is 'child #1', full price; rest discounted)", () => {
  const cfg: ReconciliationConfig = { ...NO_DISCOUNTS, siblingDiscountPct: 0.1 };

  it("a single subscription with no siblings is never discounted", () => {
    const s = sub({ id: "s1" });
    const events = new Map([["s1", baselineEvents(20)]]);
    const [r] = reconcileService([s], events, cfg);
    expect(r.siblingDiscountCents).toBe(0);
  });

  it("the higher-value subscription pays full price; the lower-value one is discounted", () => {
    const expensive = sub({ id: "expensive" });
    const cheap = sub({ id: "cheap" });
    const events = new Map([
      ["expensive", baselineEvents(20, 600)], // 12000
      ["cheap", baselineEvents(10, 600)], // 6000
    ]);
    const [rExpensive, rCheap] = reconcileService([expensive, cheap], events, cfg);
    expect(rExpensive.siblingDiscountCents).toBe(0);
    expect(rCheap.siblingDiscountCents).toBe(600); // 10% of 6000
  });

  it("ties in value break by earlier enrollment date -> earlier enrolled is position #1 (full price)", () => {
    const early = sub({ id: "early", enrollmentDate: new Date("2026-01-01") });
    const late = sub({ id: "late", enrollmentDate: new Date("2026-06-01") });
    const events = new Map([
      ["early", baselineEvents(20, 600)],
      ["late", baselineEvents(20, 600)],
    ]);
    const [rEarly, rLate] = reconcileService([early, late], events, cfg);
    expect(rEarly.siblingDiscountCents).toBe(0);
    expect(rLate.siblingDiscountCents).toBeGreaterThan(0);
  });

  it("ties in value AND enrollment date break by older child (earlier birthdate) -> position #1", () => {
    const older = sub({ id: "older", childBirthDate: new Date("2015-01-01") });
    const younger = sub({ id: "younger", childBirthDate: new Date("2020-01-01") });
    const events = new Map([
      ["older", baselineEvents(20, 600)],
      ["younger", baselineEvents(20, 600)],
    ]);
    const [rOlder, rYounger] = reconcileService([older, younger], events, cfg);
    expect(rOlder.siblingDiscountCents).toBe(0);
    expect(rYounger.siblingDiscountCents).toBeGreaterThan(0);
  });

  it("with 3+ siblings, only position #1 is exempt -- everyone else is discounted", () => {
    const a = sub({ id: "a" }); // highest value
    const b = sub({ id: "b" });
    const c = sub({ id: "c" }); // lowest value
    const events = new Map([
      ["a", baselineEvents(20, 600)],
      ["b", baselineEvents(15, 600)],
      ["c", baselineEvents(10, 600)],
    ]);
    const [rA, rB, rC] = reconcileService([a, b, c], events, cfg);
    expect(rA.siblingDiscountCents).toBe(0);
    expect(rB.siblingDiscountCents).toBeGreaterThan(0);
    expect(rC.siblingDiscountCents).toBeGreaterThan(0);
  });
});

// ── Institutional discount: summed, not compounded, applied after marginal tiers ──

describe("institutional discount (school + returning-student + manual, SUMMED not compounded)", () => {
  it("school discount alone", () => {
    const cfg: ReconciliationConfig = { ...NO_DISCOUNTS, schoolDiscounts: [{ schoolName: "Colégio X", discountPercentage: 0.2 }] };
    const s = sub({ id: "s1", schoolName: "Colégio X" });
    const events = new Map([["s1", baselineEvents(20, 600)]]); // gross 12000
    const [r] = reconcileService([s], events, cfg);
    expect(r.institutionalDiscountPct).toBeCloseTo(0.2, 5);
    expect(r.institutionalDiscountCents).toBe(2400);
  });

  it("returning-student discount alone", () => {
    const cfg: ReconciliationConfig = { ...NO_DISCOUNTS, returningStudentDiscountPct: 0.15 };
    const s = sub({ id: "s1", returningStudent: true });
    const events = new Map([["s1", baselineEvents(20, 600)]]);
    const [r] = reconcileService([s], events, cfg);
    expect(r.institutionalDiscountPct).toBeCloseTo(0.15, 5);
  });

  it("school + returning-student SUM (20% + 15% = 35%), do not compound (which would give 32%)", () => {
    const cfg: ReconciliationConfig = { ...NO_DISCOUNTS, schoolDiscounts: [{ schoolName: "Colégio X", discountPercentage: 0.2 }], returningStudentDiscountPct: 0.15 };
    const s = sub({ id: "s1", schoolName: "Colégio X", returningStudent: true });
    const events = new Map([["s1", baselineEvents(20, 600)]]); // gross 12000
    const [r] = reconcileService([s], events, cfg);
    expect(r.institutionalDiscountPct).toBeCloseTo(0.35, 5);
    expect(r.institutionalDiscountCents).toBe(4200); // NOT 3840 (the compounded answer)
  });

  it("manual admin discount is folded into the same summed tier", () => {
    const cfg: ReconciliationConfig = { ...NO_DISCOUNTS, schoolDiscounts: [{ schoolName: "Colégio X", discountPercentage: 0.2 }] };
    const s = sub({ id: "s1", schoolName: "Colégio X", manualDiscountPct: 0.05 });
    const events = new Map([["s1", baselineEvents(20, 600)]]);
    const [r] = reconcileService([s], events, cfg);
    expect(r.institutionalDiscountPct).toBeCloseTo(0.25, 5);
  });

  it("total institutional percentage is capped at 100%", () => {
    const cfg: ReconciliationConfig = { ...NO_DISCOUNTS, schoolDiscounts: [{ schoolName: "X", discountPercentage: 0.7 }], returningStudentDiscountPct: 0.5 };
    const s = sub({ id: "s1", schoolName: "X", returningStudent: true });
    const events = new Map([["s1", baselineEvents(20, 600)]]);
    const [r] = reconcileService([s], events, cfg);
    expect(r.institutionalDiscountPct).toBe(1);
    expect(r.finalCents).toBeGreaterThanOrEqual(0);
  });

  it("applies to the subtotal AFTER multi-trip and sibling discounts, not the original gross", () => {
    const cfg: ReconciliationConfig = {
      multiTripDiscountPct: 0.1, minTripsPerDay: 2, siblingDiscountPct: 0.1,
      schoolDiscounts: [{ schoolName: "X", discountPercentage: 0.2 }], returningStudentDiscountPct: 0,
    };
    const expensive = sub({ id: "expensive" }); // position 1, no sibling discount
    const cheap = sub({ id: "cheap", schoolName: "X" });
    const events = new Map([
      ["expensive", baselineEvents(20, 600)], // 12000
      ["cheap", [ev("2026-09-01", 600), ev("2026-09-01", 600)]], // 1200 gross, multi-trip eligible
    ]);
    const [, rCheap] = reconcileService([expensive, cheap], events, cfg);
    // gross 1200 -> multi-trip -60 -> 1140 -> sibling 10% of 1140 = -114 -> 1026 -> school 20% of 1026 = -205.2 (rounds to 205)
    expect(rCheap.multiTripDiscountCents).toBe(60);
    expect(rCheap.siblingDiscountCents).toBe(114);
    expect(rCheap.institutionalDiscountCents).toBe(205);
    expect(rCheap.netBeforeAbsenceCents).toBe(1200 - 60 - 114 - 205);
  });
});
