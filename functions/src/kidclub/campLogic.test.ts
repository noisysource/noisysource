import { describe, it, expect } from "vitest";
import {
  holdsSeat, takenPerDay, campAmounts, reminderDue, alreadySignedUpDays, holdExpiry, fmtDatePt, HOLD_DAYS,
  weekKey, incompleteWeeks, planSignup, waitlistOfferChanges, PlanDay, SeatSub,
} from "./campLogic";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 17, 9);

describe("holdsSeat", () => {
  it("confirmed always holds; pending only while its hold runs", () => {
    expect(holdsSeat({ status: "confirmed", selectedDays: ["a"] }, NOW)).toBe(true);
    expect(holdsSeat({ status: "pending", selectedDays: ["a"], holdExpiresAtMs: NOW + 1 }, NOW)).toBe(true);
    expect(holdsSeat({ status: "pending", selectedDays: ["a"], holdExpiresAtMs: NOW }, NOW)).toBe(false);
  });
  it("pending from before holds existed, waitlisted and cancelled hold nothing", () => {
    expect(holdsSeat({ status: "pending", selectedDays: ["a"] }, NOW)).toBe(false);
    expect(holdsSeat({ status: "waitlisted", selectedDays: ["a"], holdExpiresAtMs: NOW + DAY }, NOW)).toBe(false);
    expect(holdsSeat({ status: "cancelled", selectedDays: ["a"] }, NOW)).toBe(false);
  });
});

describe("takenPerDay", () => {
  const subs = [
    { status: "confirmed", selectedDays: ["a", "b"] },
    { status: "pending", selectedDays: ["a"], holdExpiresAtMs: NOW + DAY },
    { status: "pending", selectedDays: ["b"], holdExpiresAtMs: NOW - DAY },
    { status: "waitlisted", selectedDays: ["a", "b"] },
  ];
  it("counts confirmed and held seats only", () => {
    expect(takenPerDay(subs, NOW)).toEqual({ a: 2, b: 1 });
  });
});

describe("campAmounts", () => {
  it("25% deposit, rounded to cents, balance is the rest", () => {
    expect(campAmounts(110.1)).toEqual({ totalAmount: 110.1, depositAmount: 27.53, balanceAmount: 82.57 });
  });
});

describe("reminderDue", () => {
  const created = NOW;
  it("nothing before day 3", () => expect(reminderDue(created, created + 2 * DAY + DAY - 1, undefined)).toBeNull());
  it("day 3, once", () => {
    expect(reminderDue(created, created + 3 * DAY, undefined)).toBe(3);
    expect(reminderDue(created, created + 4 * DAY, 3)).toBeNull();
  });
  it("day 5 after day 3; alone if day 3 was missed", () => {
    expect(reminderDue(created, created + 5 * DAY, 3)).toBe(5);
    expect(reminderDue(created, created + 6 * DAY, undefined)).toBe(5);
    expect(reminderDue(created, created + 6 * DAY, 5)).toBeNull();
  });
  it("the hold lasts 7 days", () => expect(holdExpiry(created)).toBe(created + HOLD_DAYS * DAY));
});

describe("alreadySignedUpDays", () => {
  const existing = [
    { status: "pending", familyId: "f1", childName: "Rita  Silva", selectedDays: ["a", "b"] },
    { status: "cancelled", familyId: "f1", childName: "Rita Silva", selectedDays: ["c"] },
    { status: "confirmed", familyId: "f2", childName: "Rita Silva", selectedDays: ["d"] },
  ];
  it("same family + same name (case/space-insensitive), not cancelled", () => {
    expect(alreadySignedUpDays(existing, "f1", " rita silva", ["b", "c", "d"])).toEqual(["b"]);
    expect(alreadySignedUpDays(existing, "f1", "Tomás Silva", ["a", "b"])).toEqual([]);
  });
});

describe("fmtDatePt", () => {
  it("formats ISO dates, leaves anything else alone", () => {
    expect(fmtDatePt("2026-12-22")).toBe("22/12/2026");
    expect(fmtDatePt("abc")).toBe("abc");
  });
});

// A camp week Mon 21 – Fri 25 Dec 2026 (ids d1..d5) plus Mon 28 (d6), one seat per day unless said.
const campDays = (cap = 1): Record<string, PlanDay> => Object.fromEntries(
  ["2026-12-21", "2026-12-22", "2026-12-23", "2026-12-24", "2026-12-25", "2026-12-28"].map((date, i) => [`d${i + 1}`, { date, capacity: cap, active: true }]),
);
const WEEK1 = ["d1", "d2", "d3", "d4", "d5"];
const held = (id: string, days: string[], o: Partial<SeatSub> = {}): SeatSub =>
  ({ id, status: "pending", selectedDays: days, holdExpiresAtMs: NOW + DAY, subscriptionType: "day", createdAtMs: NOW - DAY, ...o });

describe("weekKey / incompleteWeeks", () => {
  it("Monday of the week, Sunday included", () => {
    expect(weekKey("2026-12-23")).toBe("2026-12-21");
    expect(weekKey("2026-12-27")).toBe("2026-12-21");
    expect(weekKey("2026-12-28")).toBe("2026-12-28");
  });
  it("a week sign-up must take every open day of the weeks it touches", () => {
    expect(incompleteWeeks(campDays(), WEEK1)).toEqual([]);
    expect(incompleteWeeks(campDays(), ["d1", "d2", "d6"])).toEqual(["2026-12-21"]);
    const days = campDays(); days.d5.active = false;
    expect(incompleteWeeks(days, ["d1", "d2", "d3", "d4"])).toEqual([]);
  });
});

describe("planSignup", () => {
  const plan = (type: string, selected: string[], subs: SeatSub[], o: { cap?: number; unbumpable?: Set<string> } = {}) =>
    planSignup({ type, selected, days: campDays(o.cap), subs, nowMs: NOW, unbumpable: o.unbumpable });

  it("single days: free seat → held; full or with people waiting → waiting list", () => {
    const subs = [held("a", ["d1"]), { id: "w", status: "waitlisted", selectedDays: ["d2"] }];
    expect(plan("day", ["d1", "d2", "d3"], subs)).toMatchObject({ dayDays: ["d3"], waitDays: ["d1", "d2"], weekDays: [], bumps: [] });
  });

  it("a week takes the seat of an unpaid single-day hold", () => {
    const r = plan("week", WEEK1, [held("a", ["d2", "d6"])]);
    expect(r.weekDays).toEqual(WEEK1);
    expect(r.bumps).toEqual([{ subId: "a", dayId: "d2" }]);
    expect(r.downgradedWeeks).toEqual([]);
  });

  it("the newest unpaid hold loses the seat, and only as many as needed", () => {
    const subs = [held("old", ["d1"], { createdAtMs: NOW - 3 * DAY }), held("new", ["d1"], { createdAtMs: NOW - DAY })];
    expect(plan("week", WEEK1, subs, { cap: 2 }).bumps).toEqual([{ subId: "new", dayId: "d1" }]);
  });

  it("a paid day stops the week: booked as single days, the paid-full day on the waiting list", () => {
    const r = plan("week", WEEK1, [{ id: "p", status: "confirmed", selectedDays: ["d5"] }]);
    expect(r).toMatchObject({ weekDays: [], dayDays: ["d1", "d2", "d3", "d4"], waitDays: ["d5"], bumps: [], downgradedWeeks: ["2026-12-21"] });
  });

  it("booked as single days, it no longer takes anyone's held seat", () => {
    const subs = [{ id: "p", status: "confirmed", selectedDays: ["d5"] }, held("a", ["d1"])];
    expect(plan("week", WEEK1, subs)).toMatchObject({ dayDays: ["d2", "d3", "d4"], waitDays: ["d1", "d5"], bumps: [] });
  });

  it("another week's hold, or a hold with a payment in flight, also stops the week", () => {
    expect(plan("week", WEEK1, [held("wk", WEEK1, { subscriptionType: "week" })]).downgradedWeeks).toEqual(["2026-12-21"]);
    expect(plan("week", WEEK1, [held("a", ["d3"])], { unbumpable: new Set(["a"]) }).downgradedWeeks).toEqual(["2026-12-21"]);
  });

  it("each week is decided on its own", () => {
    const r = plan("week", [...WEEK1, "d6"], [{ id: "p", status: "confirmed", selectedDays: ["d6"] }]);
    expect(r).toMatchObject({ weekDays: WEEK1, dayDays: [], waitDays: ["d6"], downgradedWeeks: ["2026-12-28"] });
  });
});

describe("waitlistOfferChanges", () => {
  it("opens an offer when every day has a free seat, closes it when one fills up", () => {
    const subs = [
      { id: "w1", status: "waitlisted", selectedDays: ["d1"] },
      { id: "w2", status: "waitlisted", selectedDays: ["d1", "d2"] },
      { id: "w3", status: "waitlisted", selectedDays: ["d3"], offerOpen: true },
      { id: "w4", status: "waitlisted", selectedDays: ["d2"], offerOpen: true },
      { id: "c", status: "confirmed", selectedDays: ["d2"] },
    ];
    expect(waitlistOfferChanges(subs, campDays(), NOW)).toEqual({ open: ["w1"], close: ["w4"] });
  });
});
