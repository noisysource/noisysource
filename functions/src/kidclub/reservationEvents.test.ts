import { describe, it, expect, vi } from "vitest";
import { reconcileService } from "./reconciliation";
import { isActiveThisWeek, weekOfMonthOccurrence, eventDocId, generateStudyEvents, generateTransportEvents, coerceEndDate, coerceStartDate, coerceDate, resolveGenerationStart, resolveGenerationWindowStart, resolveGenerationWindowEnd, splitRegenerationWrites, REASON_BEFORE_START, REASON_AFTER_END } from "./reservationEvents";

// Regression: StudyRoomEntry.endDate is a Firestore Timestamp while
// TransportationSubscription.endDate is a "YYYY-MM-DD" string. Passing a
// Timestamp to `new Date()` yields Invalid Date, which made every
// `cursor <= to` comparison false and generated ZERO study occurrences
// without throwing. Found on dev when every "Cancelar dia" button was
// disabled for a study subscription.
describe("coerceEndDate (study Timestamp vs transport string)", () => {
  it("reads a Firestore Timestamp (duck-typed .toDate())", () => {
    const real = new Date(2027, 6, 31);
    const ts = { toDate: () => real };
    expect(coerceEndDate(ts)?.getTime()).toBe(real.getTime());
  });

  it("reads a plain Date", () => {
    const d = new Date(2027, 6, 31);
    expect(coerceEndDate(d)?.getTime()).toBe(d.getTime());
  });

  it("reads a YYYY-MM-DD string as end-of-day so the last day stays inclusive", () => {
    const d = coerceEndDate("2027-07-31")!;
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(31);
    expect(d.getHours()).toBe(23);
  });

  it("reads the raw REST/JSON timestamp shape", () => {
    const secs = Math.floor(new Date(2027, 6, 31).getTime() / 1000);
    expect(coerceEndDate({ _seconds: secs, _nanoseconds: 0 })?.getTime()).toBe(secs * 1000);
  });

  it("returns null rather than Invalid Date for unusable input", () => {
    expect(coerceEndDate(null)).toBeNull();
    expect(coerceEndDate(undefined)).toBeNull();
    expect(coerceEndDate("not a date")).toBeNull();
    expect(coerceEndDate({})).toBeNull();
    expect(coerceEndDate(new Date("nonsense"))).toBeNull();
  });

  // Second regression from the same dev session: 19 of 23 active transport
  // subscriptions have no endDate field at all. Treating that as "unusable"
  // generated zero events for nearly all of transport. A missing endDate
  // means "runs to the end of the school year" — the rule eventService.ts
  // already uses — not "has no end".
  it("returns null for a missing endDate so the caller can fall back to the school year end", () => {
    expect(coerceEndDate(undefined)).toBeNull();
  });

  it("a Timestamp end date still produces events — the actual bug", () => {
    const sub = { familyId: "f1", childId: "c1", days: [{ day: "monday", hour: "16:00" }], weekPattern: "all" };
    const to = coerceEndDate({ toDate: () => new Date(2026, 8, 30) })!;
    const events = generateStudyEvents(sub, "sub1", 6, new Date(2026, 8, 1), to);
    expect(events.length).toBeGreaterThan(0); // was 0 before the fix
  });
});

describe("isActiveThisWeek (biweekly odd/even pattern)", () => {
  it("'all' pattern is always active", () => {
    for (let d = 1; d <= 28; d++) expect(isActiveThisWeek(new Date(2026, 8, d), "all")).toBe(true);
  });

  it("'odd' pattern is active on the 1st and 3rd occurrence of a weekday in the month", () => {
    // September 2026: Mondays fall on 7, 14, 21, 28 -> occurrences 1,2,3,4
    expect(isActiveThisWeek(new Date(2026, 8, 7), "odd")).toBe(true);   // 1st Monday
    expect(isActiveThisWeek(new Date(2026, 8, 14), "odd")).toBe(false); // 2nd
    expect(isActiveThisWeek(new Date(2026, 8, 21), "odd")).toBe(true);  // 3rd
    expect(isActiveThisWeek(new Date(2026, 8, 28), "odd")).toBe(false); // 4th
  });

  it("'even' pattern is active on the 2nd and 4th occurrence", () => {
    expect(isActiveThisWeek(new Date(2026, 8, 7), "even")).toBe(false);
    expect(isActiveThisWeek(new Date(2026, 8, 14), "even")).toBe(true);
    expect(isActiveThisWeek(new Date(2026, 8, 21), "even")).toBe(false);
    expect(isActiveThisWeek(new Date(2026, 8, 28), "even")).toBe(true);
  });

  it("a 5th occurrence of a weekday in a month is inactive under both odd and even", () => {
    // October 2026: Thursdays fall on 1, 8, 15, 22, 29 -> 5 occurrences
    expect(weekOfMonthOccurrence(new Date(2026, 9, 29))).toBe(5);
    expect(isActiveThisWeek(new Date(2026, 9, 29), "odd")).toBe(false);
    expect(isActiveThisWeek(new Date(2026, 9, 29), "even")).toBe(false);
  });
});

describe("eventDocId", () => {
  it("is bare subscriptionId_date with no direction (study)", () => {
    expect(eventDocId("sub1", "2026-09-08")).toBe("sub1_2026-09-08");
  });

  it("includes the leg index when given (transport)", () => {
    expect(eventDocId("sub1", "2026-09-08", 0)).toBe("sub1_2026-09-08_0");
    expect(eventDocId("sub1", "2026-09-08", 1)).toBe("sub1_2026-09-08_1");
  });
});

describe("generateStudyEvents", () => {
  it("generates one EXPECTED event per scheduled weekday within the range", () => {
    const sub = { familyId: "fam1", childId: "child1", days: [{ day: "monday", hour: "16:00" }, { day: "wednesday", hour: "16:00" }], weekPattern: "all" };
    const events = generateStudyEvents(sub, "sub1", 6, new Date(2026, 8, 1), new Date(2026, 8, 30));
    // September 2026 Mondays: 7,14,21,28 (4) ; Wednesdays: 2,9,16,23,30 (5) => 9 events
    expect(events).toHaveLength(9);
    expect(events.every(e => e.data.status === "EXPECTED")).toBe(true);
    expect(events.every(e => e.data.basePriceCents === 600)).toBe(true);
    expect(events.every(e => e.data.subscriptionType === "study")).toBe(true);
    expect(events[0].id).toMatch(/^sub1_2026-09-\d\d$/);
  });

  it("respects a biweekly (odd/even) weekPattern instead of generating every week", () => {
    const sub = { familyId: "fam1", childId: "child1", days: [{ day: "monday", hour: "16:00" }], weekPattern: "odd" };
    const events = generateStudyEvents(sub, "sub1", 6, new Date(2026, 8, 1), new Date(2026, 8, 30));
    // Mondays: 7 (1st, odd->yes), 14 (2nd, no), 21 (3rd, yes), 28 (4th, no) => 2 events
    expect(events).toHaveLength(2);
  });

  it("produces nothing if the subscription has no scheduled days", () => {
    const sub = { familyId: "fam1", childId: "child1", days: [], weekPattern: "all" };
    expect(generateStudyEvents(sub, "sub1", 6, new Date(2026, 8, 1), new Date(2026, 8, 30))).toHaveLength(0);
  });

  it("produces nothing if the configured rate is zero (no config, or genuinely free)", () => {
    const sub = { familyId: "fam1", childId: "child1", days: [{ day: "monday", hour: "16:00" }], weekPattern: "all" };
    expect(generateStudyEvents(sub, "sub1", 0, new Date(2026, 8, 1), new Date(2026, 8, 30))).toHaveLength(0);
  });
});

describe("generateTransportEvents", () => {
  it("gives two legs on the same day DISTINCT ids even when neither has a direction", () => {
    // The real-data case: 0 of 109 schedule entries carry a `direction`, so
    // keying ids by direction collapsed both legs onto one doc. batch.set()
    // then overwrote one with the other, so a two-leg day had a single
    // occurrence -- cancelling one leg cancelled both, gross billed half the
    // trips, and the multi-trip discount never fired.
    const sub = {
      familyId: "f1", childId: "c1", weekPattern: "all",
      schedule: [
        { dayOfWeek: "monday", pickupTime: "08:00" }, // Casa -> Colegio
        { dayOfWeek: "monday", pickupTime: "08:00" }, // Colegio -> KidClub
      ],
    };
    const events = generateTransportEvents(sub, "sub1", 6, new Date(2026, 8, 7), new Date(2026, 8, 7));
    expect(events).toHaveLength(2);
    expect(new Set(events.map(e => e.id)).size).toBe(2);
    expect(events.map(e => e.id).sort()).toEqual(["sub1_2026-09-07_0", "sub1_2026-09-07_1"]);
    expect(events.map(e => e.data.legIndex).sort()).toEqual([0, 1]);
  });

  it("generates one event per schedule entry per matching date, tagged with direction", () => {
    const sub = {
      familyId: "fam1", childId: "child1", weekPattern: "all",
      schedule: [
        { dayOfWeek: "monday", direction: "pickup" },
        { dayOfWeek: "monday", direction: "dropoff" },
      ],
    };
    const events = generateTransportEvents(sub, "sub1", 6, new Date(2026, 8, 1), new Date(2026, 8, 7));
    // Only one Monday (Sept 7) in this narrow range, two schedule entries that day
    expect(events).toHaveLength(2);
    const directions = events.map(e => e.data.direction).sort();
    expect(directions).toEqual(["dropoff", "pickup"]);
    expect(events.find(e => e.data.direction === "pickup")!.id).toBe("sub1_2026-09-07_0");
    expect(events.find(e => e.data.direction === "dropoff")!.id).toBe("sub1_2026-09-07_1");
  });

  it("defaults to direction 'both' for a schedule entry with no explicit direction (single indivisible trip)", () => {
    const sub = { familyId: "fam1", childId: "child1", weekPattern: "all", schedule: [{ dayOfWeek: "monday" }] };
    const events = generateTransportEvents(sub, "sub1", 6, new Date(2026, 8, 1), new Date(2026, 8, 7));
    expect(events).toHaveLength(1);
    expect(events[0].data.direction).toBe("both");
    expect(events[0].id).toBe("sub1_2026-09-07_0");
  });

  it("respects the biweekly weekPattern the same way study does", () => {
    const sub = { familyId: "fam1", childId: "child1", weekPattern: "even", schedule: [{ dayOfWeek: "monday", direction: "pickup" }] };
    const events = generateTransportEvents(sub, "sub1", 6, new Date(2026, 8, 1), new Date(2026, 8, 30));
    // Mondays: 7(1st,no) 14(2nd,yes) 21(3rd,no) 28(4th,yes) => 2 events
    expect(events).toHaveLength(2);
  });
});

// Regression: neither ensureEventsExist (starts at the current month's 1st)
// nor regenerateFutureEvents (starts at today) clamped to the subscription's
// own startDate. A study subscription starting 2026-10-01 therefore got
// September occurrences generated and billed a month before the child
// attends. startDate carries the same three-way shape inconsistency as
// endDate: Timestamp on studyroom, "YYYY-MM-DD" on transport, often absent.
describe("resolveGenerationStart (startDate clamp)", () => {
  const requested = new Date(2026, 8, 1); // Sept 1 — the backfill's month start

  it("clamps to a date-only startDate string, at start-of-day so day one is inclusive", () => {
    const start = resolveGenerationStart({ startDate: "2026-10-01" }, requested);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(9);
    expect(start.getDate()).toBe(1);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
  });

  it("clamps to a Firestore Timestamp startDate (the studyroom shape)", () => {
    const real = new Date(2026, 9, 1);
    const start = resolveGenerationStart({ startDate: { toDate: () => real } }, requested);
    expect(start.getTime()).toBe(real.getTime());
  });

  it("clamps to the raw REST/JSON timestamp shape too", () => {
    const real = new Date(2026, 9, 1);
    const secs = Math.floor(real.getTime() / 1000);
    const start = resolveGenerationStart({ startDate: { _seconds: secs, _nanoseconds: 0 } }, requested);
    expect(start.getTime()).toBe(secs * 1000);
  });

  // 19 of 21 active transport subs in prod have no startDate — this path must
  // behave exactly as it did before the clamp existed.
  it("falls back to the requested from when startDate is absent", () => {
    expect(resolveGenerationStart({}, requested).getTime()).toBe(requested.getTime());
    expect(resolveGenerationStart({ startDate: null }, requested).getTime()).toBe(requested.getTime());
    expect(resolveGenerationStart({ startDate: "not a date" }, requested).getTime()).toBe(requested.getTime());
    expect(resolveGenerationStart(undefined, requested).getTime()).toBe(requested.getTime());
  });

  it("never moves the window EARLIER — a past startDate leaves `from` alone", () => {
    expect(resolveGenerationStart({ startDate: "2025-09-01" }, requested).getTime()).toBe(requested.getTime());
  });

  it("generates no September occurrences for an October-starting subscription", () => {
    const sub = { familyId: "f1", childId: "c1", startDate: "2026-10-01", days: [{ day: "monday", hour: "16:00" }], weekPattern: "all" };
    const from = resolveGenerationStart(sub, new Date(2026, 8, 1));
    const events = generateStudyEvents(sub, "sub1", 6, from, new Date(2026, 9, 31));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(e => e.data.date >= "2026-10-01")).toBe(true);
    // Before the fix these four September Mondays were generated and billed.
    expect(events.some(e => e.data.date.startsWith("2026-09"))).toBe(false);
  });

  it("includes the very first day when startDate is a date-only string", () => {
    // 2026-10-05 is a Monday, and also the startDate — it must be generated.
    const sub = { familyId: "f1", childId: "c1", startDate: "2026-10-05", days: [{ day: "monday", hour: "16:00" }], weekPattern: "all" };
    const from = resolveGenerationStart(sub, new Date(2026, 8, 1));
    const events = generateStudyEvents(sub, "sub1", 6, from, new Date(2026, 9, 31));
    expect(events[0].data.date).toBe("2026-10-05");
  });
});

// Regression: 6 active transport + 5 active study subscriptions in prod have
// no familyId. Events copy familyId off the subscription, and
// onReservationEventBillingSync silently skips events with no familyId — so
// these would have written a school year of invisible, never-billed events.
describe("missing familyId guard", () => {
  const spy = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("generates nothing for a study subscription with no familyId", () => {
    const err = spy();
    const sub = { childId: "c1", days: [{ day: "monday", hour: "16:00" }], weekPattern: "all" };
    expect(generateStudyEvents(sub, "orphanStudy", 6, new Date(2026, 8, 1), new Date(2026, 8, 30))).toHaveLength(0);
    expect(err).toHaveBeenCalledOnce();
    expect(err.mock.calls[0][0]).toContain("orphanStudy");
    expect(err.mock.calls[0][0]).toContain("study");
    err.mockRestore();
  });

  it("generates nothing for a transport subscription with no familyId", () => {
    const err = spy();
    const sub = { childId: "c1", weekPattern: "all", schedule: [{ dayOfWeek: "monday" }] };
    expect(generateTransportEvents(sub, "orphanTransport", 6, new Date(2026, 8, 1), new Date(2026, 8, 30))).toHaveLength(0);
    expect(err).toHaveBeenCalledOnce();
    expect(err.mock.calls[0][0]).toContain("orphanTransport");
    expect(err.mock.calls[0][0]).toContain("transport");
    err.mockRestore();
  });

  it("treats an empty-string familyId as missing (the ManualEnrollForm shape)", () => {
    const err = spy();
    const sub = { familyId: "", childId: "c1", days: [{ day: "monday", hour: "16:00" }], weekPattern: "all" };
    expect(generateStudyEvents(sub, "sub1", 6, new Date(2026, 8, 1), new Date(2026, 8, 30))).toHaveLength(0);
    err.mockRestore();
  });

  it("still generates normally when familyId is present", () => {
    const sub = { familyId: "fam1", childId: "c1", days: [{ day: "monday", hour: "16:00" }], weekPattern: "all" };
    expect(generateStudyEvents(sub, "sub1", 6, new Date(2026, 8, 1), new Date(2026, 8, 30))).toHaveLength(4);
  });
});

describe("coerceDate (shared start/end coercer)", () => {
  it("differs only in what a date-only string means", () => {
    expect(coerceDate("2026-10-01", "start")!.getHours()).toBe(0);
    expect(coerceDate("2026-10-01", "end")!.getHours()).toBe(23);
    expect(coerceStartDate("2026-10-01")!.getTime()).toBe(coerceDate("2026-10-01", "start")!.getTime());
    expect(coerceEndDate("2026-10-01")!.getTime()).toBe(coerceDate("2026-10-01", "end")!.getTime());
  });

  it("is identical for every non-date-only shape", () => {
    const d = new Date(2026, 9, 1, 14, 30);
    expect(coerceDate(d, "start")!.getTime()).toBe(coerceDate(d, "end")!.getTime());
    expect(coerceStartDate(null)).toBeNull();
  });
});

// ── Boundary months ─────────────────────────────────────────────────────────
// A flat monthly price cannot pro-rate the month a subscription starts or
// ends. The agreed answer is not to add pro-rating as a pricing concept but to
// let the days outside the contract exist as SYSTEM-recorded absences, so the
// >=3-absence credit that already exists does the pro-rating.
//
// October 2026 is the worked example throughout: Oct 1 is a Thursday, so a
// Mon-Fri pattern has 22 occurrences — 10 of them before the 15th, 12 on or
// after. The notional denominator behind the flat price is still 5 x 4 = 20.

const MON_FRI = ["monday", "tuesday", "wednesday", "thursday", "friday"].map(day => ({ day, hour: "16:00" }));
const OCT_START = new Date(2026, 9, 1);
const OCT_END = new Date(2026, 9, 31, 23, 59, 59);

describe("boundary month — subscription STARTS mid-month", () => {
  const sub = { familyId: "f1", childId: "c1", startDate: "2026-10-15", days: MON_FRI, weekPattern: "all" };
  const bounds = { start: coerceStartDate(sub.startDate) };

  it("generates the whole calendar month, not just the in-contract part", () => {
    const events = generateStudyEvents(sub, "s1", 6, OCT_START, OCT_END, bounds);
    expect(events).toHaveLength(22);
  });

  it("marks every pre-start occurrence CANCELLED by the system, with a reason", () => {
    const events = generateStudyEvents(sub, "s1", 6, OCT_START, OCT_END, bounds);
    const before = events.filter(e => e.data.date < "2026-10-15");
    expect(before).toHaveLength(10);
    expect(before.every(e => e.data.status === "CANCELLED")).toBe(true);
    expect(before.every(e => e.data.changedByRole === "system")).toBe(true);
    expect(before.every(e => e.data.reason === REASON_BEFORE_START)).toBe(true);
  });

  it("leaves everything from startDate onward EXPECTED, with no system provenance", () => {
    const events = generateStudyEvents(sub, "s1", 6, OCT_START, OCT_END, bounds);
    const after = events.filter(e => e.data.date >= "2026-10-15");
    expect(after).toHaveLength(12);
    expect(after.every(e => e.data.status === "EXPECTED")).toBe(true);
    expect(after.every(e => e.data.changedByRole === undefined)).toBe(true);
    expect(after.every(e => e.data.reason === undefined)).toBe(true);
  });

  it("still bills the FULL flat gross and pro-rates through the credit — half a month, half the money", () => {
    const events = generateStudyEvents(sub, "s1", 6, OCT_START, OCT_END, bounds);
    const [r] = reconcileService(
      [{
        id: "s1", childId: "c1", manualDiscountPct: 0, enrollmentDate: new Date("2026-09-01"),
        scheduleWeekdays: MON_FRI.map(d => d.day), weekPattern: "all", ratePerOccurrenceCents: 600,
        // The boundary month itself: the contract covers it, and the days
        // outside the contract are what the absence credit pro-rates.
        coversPeriod: true,
      }],
      new Map([["s1", events.map(e => ({ date: e.data.date, basePriceCents: e.data.basePriceCents, status: e.data.status }))]]),
      { multiTripDiscountPct: 0, minTripsPerDay: 2, siblingDiscountPct: 0, schoolDiscounts: [], returningStudentDiscountPct: 0 },
    );
    expect(r.grossCents).toBe(12000);        // unchanged — gross never pro-rates
    expect(r.absenceCount).toBe(10);
    expect(r.absenceCreditCents).toBe(6000); // 10 x (net / 20 notional)
    expect(r.finalCents).toBe(6000);         // ~half a month, ~half the price
  });

  it("generates NOTHING for a whole month before the start — not a fully-cancelled month", () => {
    // The backfill asks for September; the window must still open on Oct 1.
    const windowStart = resolveGenerationWindowStart(sub, new Date(2026, 8, 1));
    expect(windowStart.getTime()).toBe(OCT_START.getTime());
    const events = generateStudyEvents(sub, "s1", 6, windowStart, OCT_END, bounds);
    expect(events.some(e => e.data.date.startsWith("2026-09"))).toBe(false);
  });

  it("opens the window on the 1st only when startDate is in a LATER month than requested", () => {
    // Already inside the boundary month: the requested `from` already covers it.
    expect(resolveGenerationWindowStart(sub, OCT_START).getTime()).toBe(OCT_START.getTime());
    // 19 of 21 active transport subs in prod carry no startDate at all.
    expect(resolveGenerationWindowStart({}, OCT_START).getTime()).toBe(OCT_START.getTime());
    // A start already in the past never moves the window earlier.
    expect(resolveGenerationWindowStart({ startDate: "2025-09-01" }, OCT_START).getTime()).toBe(OCT_START.getTime());
  });
});

describe("boundary month — subscription ENDS mid-month", () => {
  const sub = { familyId: "f1", childId: "c1", endDate: "2026-10-15", days: MON_FRI, weekPattern: "all" };
  const bounds = { end: coerceEndDate(sub.endDate) };

  it("cancels the post-end tail instead of omitting or voiding it", () => {
    const events = generateStudyEvents(sub, "s1", 6, OCT_START, OCT_END, bounds);
    const after = events.filter(e => e.data.date > "2026-10-15");
    expect(after).toHaveLength(11);
    expect(after.every(e => e.data.status === "CANCELLED")).toBe(true);
    expect(after.every(e => e.data.changedByRole === "system")).toBe(true);
    expect(after.every(e => e.data.reason === REASON_AFTER_END)).toBe(true);
    // VOIDED would have been unreachable for both the credit and for staff.
    expect(events.some(e => (e.data.status as string) === "VOIDED")).toBe(false);
  });

  it("leaves the already-served part of the month EXPECTED, endDate inclusive", () => {
    const events = generateStudyEvents(sub, "s1", 6, OCT_START, OCT_END, bounds);
    const served = events.filter(e => e.data.status === "EXPECTED");
    expect(served).toHaveLength(11);
    expect(served[served.length - 1].data.date).toBe("2026-10-15"); // last day inclusive
  });

  it("pro-rates the ending month through the credit", () => {
    const events = generateStudyEvents(sub, "s1", 6, OCT_START, OCT_END, bounds);
    const [r] = reconcileService(
      [{
        id: "s1", childId: "c1", manualDiscountPct: 0, enrollmentDate: new Date("2026-09-01"),
        scheduleWeekdays: MON_FRI.map(d => d.day), weekPattern: "all", ratePerOccurrenceCents: 600,
        // The boundary month itself: the contract covers it, and the days
        // outside the contract are what the absence credit pro-rates.
        coversPeriod: true,
      }],
      new Map([["s1", events.map(e => ({ date: e.data.date, basePriceCents: e.data.basePriceCents, status: e.data.status }))]]),
      { multiTripDiscountPct: 0, minTripsPerDay: 2, siblingDiscountPct: 0, schoolDiscounts: [], returningStudentDiscountPct: 0 },
    );
    expect(r.grossCents).toBe(12000);
    expect(r.absenceCount).toBe(11);
    expect(r.absenceCreditCents).toBe(6600); // 11 x €6 notional
    expect(r.finalCents).toBe(5400);
  });

  it("the credit can never exceed the month — a start on the last working day bills EUR 0", () => {
    const late = { familyId: "f1", childId: "c1", startDate: "2026-10-30", days: MON_FRI, weekPattern: "all" };
    const events = generateStudyEvents(late, "s1", 6, OCT_START, OCT_END, { start: coerceStartDate(late.startDate) });
    const [r] = reconcileService(
      [{
        id: "s1", childId: "c1", manualDiscountPct: 0, enrollmentDate: new Date("2026-09-01"),
        scheduleWeekdays: MON_FRI.map(d => d.day), weekPattern: "all", ratePerOccurrenceCents: 600,
        // The boundary month itself: the contract covers it, and the days
        // outside the contract are what the absence credit pro-rates.
        coversPeriod: true,
      }],
      new Map([["s1", events.map(e => ({ date: e.data.date, basePriceCents: e.data.basePriceCents, status: e.data.status }))]]),
      { multiTripDiscountPct: 0, minTripsPerDay: 2, siblingDiscountPct: 0, schoolDiscounts: [], returningStudentDiscountPct: 0 },
    );
    expect(r.absenceCount).toBe(21);      // more absences than the 20 notional
    expect(r.absenceCreditCents).toBe(12000); // floored at the net
    expect(r.finalCents).toBe(0);
  });

  it("gives transport BOTH legs of a post-end day the same cancelled status", () => {
    const t = {
      familyId: "f1", childId: "c1", weekPattern: "all", endDate: "2026-10-15",
      schedule: [{ dayOfWeek: "monday" }, { dayOfWeek: "monday" }],
    };
    const events = generateTransportEvents(t, "t1", 6, OCT_START, OCT_END, { end: coerceEndDate(t.endDate) });
    const oct19 = events.filter(e => e.data.date === "2026-10-19");
    expect(oct19).toHaveLength(2);
    expect(oct19.every(e => e.data.status === "CANCELLED" && e.data.reason === REASON_AFTER_END)).toBe(true);
  });
});

describe("resolveGenerationWindowEnd (how far past the contract to generate)", () => {
  const schoolYearEnd = new Date(2027, 6, 31, 23, 59, 59);

  it("extends to the end of the month the subscription's own end falls in", () => {
    const subEnd = coerceEndDate("2026-10-15")!;
    const w = resolveGenerationWindowEnd(subEnd, subEnd, schoolYearEnd)!;
    expect(isoLike(w)).toBe("2026-10-31");
  });

  it("generates NOTHING past that month — a whole month after the end is not written at all", () => {
    const subEnd = coerceEndDate("2026-10-15")!;
    const w = resolveGenerationWindowEnd(subEnd, subEnd, schoolYearEnd)!;
    const sub = { familyId: "f1", childId: "c1", endDate: "2026-10-15", days: MON_FRI, weekPattern: "all" };
    const events = generateStudyEvents(sub, "s1", 6, OCT_START, w, { end: subEnd });
    expect(events.some(e => e.data.date.startsWith("2026-11"))).toBe(false);
  });

  it("does NOT add a cancelled tail when the school year end is what binds", () => {
    // The school year ending is not a mid-contract cancellation, and July must
    // not sprout a fortnight of system absences for every family.
    const w = resolveGenerationWindowEnd(schoolYearEnd, null, schoolYearEnd)!;
    expect(w.getTime()).toBe(schoolYearEnd.getTime());
    const subEndLater = coerceEndDate("2027-12-31")!;
    expect(resolveGenerationWindowEnd(schoolYearEnd, subEndLater, schoolYearEnd)!.getTime()).toBe(schoolYearEnd.getTime());
  });

  it("never runs past the school year end even inside the boundary month", () => {
    const subEnd = coerceEndDate("2027-07-10")!;
    const w = resolveGenerationWindowEnd(subEnd, subEnd, schoolYearEnd)!;
    expect(w.getTime()).toBe(schoolYearEnd.getTime()); // not 2027-07-31
  });
});

function isoLike(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Regeneration previously voided every future event and rewrote them all as
// EXPECTED with merge:true — silently erasing every absence a parent had
// recorded, on any schedule edit. System boundary absences must stay
// recomputable; a human's must not be touched.
describe("splitRegenerationWrites (human absences survive a regeneration)", () => {
  const generated = [{ id: "s1_2026-10-05" }, { id: "s1_2026-10-06" }, { id: "s1_2026-10-07" }];

  it("keeps a parent-recorded absence untouched: neither rewritten nor voided", () => {
    const { toCreate, toVoid } = splitRegenerationWrites(generated, [
      { id: "s1_2026-10-05", changedByRole: "parent" },
      { id: "s1_2026-10-06" },
    ]);
    expect(toCreate.map(g => g.id)).toEqual(["s1_2026-10-06", "s1_2026-10-07"]);
    expect(toVoid).toEqual([]);
  });

  it("keeps a staff-recorded one the same way", () => {
    const { toCreate } = splitRegenerationWrites(generated, [{ id: "s1_2026-10-05", changedByRole: "staff" }]);
    expect(toCreate.map(g => g.id)).not.toContain("s1_2026-10-05");
  });

  it("DOES recompute a system boundary absence — that is the point of the role tag", () => {
    const { toCreate } = splitRegenerationWrites(generated, [{ id: "s1_2026-10-05", changedByRole: "system" }]);
    expect(toCreate.map(g => g.id)).toContain("s1_2026-10-05");
  });

  it("voids a stale event the new schedule no longer contains, even a human one", () => {
    // Leaving it would credit an absence for a day that is no longer served.
    const { toVoid } = splitRegenerationWrites(generated, [
      { id: "s1_2026-10-08", changedByRole: "parent" },
      { id: "s1_2026-10-09" },
    ]);
    expect(toVoid.sort()).toEqual(["s1_2026-10-08", "s1_2026-10-09"]);
  });

  it("never voids an occurrence it is about to rewrite", () => {
    const { toVoid } = splitRegenerationWrites(generated, generated.map(g => ({ id: g.id })));
    expect(toVoid).toEqual([]);
  });
});
