import { describe, it, expect } from "vitest";
import {
  holdsSeat, takenPerDay, splitByAvailability, campAmounts, reminderDue, alreadySignedUpDays, holdExpiry, fmtDatePt, HOLD_DAYS,
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

describe("takenPerDay / splitByAvailability", () => {
  const subs = [
    { status: "confirmed", selectedDays: ["a", "b"] },
    { status: "pending", selectedDays: ["a"], holdExpiresAtMs: NOW + DAY },
    { status: "pending", selectedDays: ["b"], holdExpiresAtMs: NOW - DAY },
    { status: "waitlisted", selectedDays: ["a", "b"] },
  ];
  it("counts confirmed and held seats only", () => {
    expect(takenPerDay(subs, NOW)).toEqual({ a: 2, b: 1 });
  });
  it("full days go to the waiting list, the rest are available; unknown days count as full", () => {
    expect(splitByAvailability(["a", "b", "c", "x"], { a: 2, b: 2, c: 1 }, takenPerDay(subs, NOW)))
      .toEqual({ available: ["b", "c"], full: ["a", "x"] });
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
