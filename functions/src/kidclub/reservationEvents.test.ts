import { describe, it, expect } from "vitest";
import { isActiveThisWeek, weekOfMonthOccurrence, eventDocId, generateStudyEvents, generateTransportEvents, coerceEndDate } from "./reservationEvents";

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

  it("includes the direction suffix when given (transport)", () => {
    expect(eventDocId("sub1", "2026-09-08", "pickup")).toBe("sub1_2026-09-08_pickup");
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
    expect(events.find(e => e.data.direction === "pickup")!.id).toBe("sub1_2026-09-07_pickup");
    expect(events.find(e => e.data.direction === "dropoff")!.id).toBe("sub1_2026-09-07_dropoff");
  });

  it("defaults to direction 'both' for a schedule entry with no explicit direction (single indivisible trip)", () => {
    const sub = { familyId: "fam1", childId: "child1", weekPattern: "all", schedule: [{ dayOfWeek: "monday" }] };
    const events = generateTransportEvents(sub, "sub1", 6, new Date(2026, 8, 1), new Date(2026, 8, 7));
    expect(events).toHaveLength(1);
    expect(events[0].data.direction).toBe("both");
    expect(events[0].id).toBe("sub1_2026-09-07_both");
  });

  it("respects the biweekly weekPattern the same way study does", () => {
    const sub = { familyId: "fam1", childId: "child1", weekPattern: "even", schedule: [{ dayOfWeek: "monday", direction: "pickup" }] };
    const events = generateTransportEvents(sub, "sub1", 6, new Date(2026, 8, 1), new Date(2026, 8, 30));
    // Mondays: 7(1st,no) 14(2nd,yes) 21(3rd,no) 28(4th,yes) => 2 events
    expect(events).toHaveLength(2);
  });
});
