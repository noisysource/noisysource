import { describe, it, expect } from "vitest";
import { REASON_CLOSED, Closure, ClosureSyncEvent, closureFor, closureLabelFor, closureSyncAction, isClosureAbsence, readClosures, validateClosures } from "./closureLogic";

const XMAS: Closure = { id: "x", from: "2026-12-16", to: "2026-12-31", label: "Férias de Natal" };
const OUTSIDE = { beforeStart: "before subscription start", afterEnd: "after subscription end" };

describe("validateClosures", () => {
  it("accepts a range with a label, trims it, and sorts by start day", () => {
    const r = validateClosures([
      { id: "b", from: "2027-04-01", to: "2027-04-02", label: " Páscoa " },
      { id: "a", from: "2026-12-16", to: "2026-12-31", label: "Férias de Natal" },
    ]);
    expect(r).toEqual({ closures: [{ id: "a", from: "2026-12-16", to: "2026-12-31", label: "Férias de Natal" }, { id: "b", from: "2027-04-01", to: "2027-04-02", label: "Páscoa" }] });
  });

  it("a single day is a range of one; a missing id gets one", () => {
    const r = validateClosures([{ from: "2026-12-24", to: "2026-12-24", label: "Véspera de Natal" }]) as { closures: Closure[] };
    expect(r.closures).toHaveLength(1);
    expect(r.closures[0].id).toBeTruthy();
  });

  it("an empty list is valid: it removes every closure", () => {
    expect(validateClosures([])).toEqual({ closures: [] });
  });

  it("an optional percentage: above 0, up to 100, kept as typed", () => {
    const ok = (percent: unknown) => validateClosures([{ from: "2026-12-16", to: "2026-12-31", label: "x", percent }]) as { closures: Closure[] };
    expect(ok(50).closures[0].percent).toBe(50);
    expect(ok(100).closures[0].percent).toBe(100);
    expect(ok(33.333).closures[0].percent).toBe(33.33);
    expect("percent" in ok(undefined).closures[0]).toBe(false);
    expect("percent" in ok(null).closures[0]).toBe(false);
    for (const bad of [0, -5, 100.5, "50", NaN]) expect("error" in validateClosures([{ from: "2026-12-16", to: "2026-12-31", label: "x", percent: bad }])).toBe(true);
  });

  it("a percentage is 'of the month': refused on a closure that crosses two months, allowed without one", () => {
    const across = { from: "2026-12-28", to: "2027-01-08", label: "Fim de ano" };
    expect(validateClosures([{ ...across, percent: 25 }])).toMatchObject({ error: expect.stringContaining("um só mês") });
    expect("closures" in validateClosures([across])).toBe(true);
  });

  it("closures may not overlap: a day belongs to one closure", () => {
    expect(validateClosures([
      { from: "2026-12-16", to: "2026-12-31", label: "Natal", percent: 50 },
      { from: "2026-12-24", to: "2026-12-24", label: "Véspera" },
    ])).toMatchObject({ error: expect.stringContaining("sobrepõem-se") });
    expect("closures" in validateClosures([
      { from: "2026-12-07", to: "2026-12-07", label: "Ponte" },
      { from: "2026-12-16", to: "2026-12-31", label: "Natal", percent: 50 },
    ])).toBe(true);
  });

  it("refuses what it can't apply", () => {
    const bad = (c: unknown) => "error" in validateClosures(c as any);
    expect(bad(null)).toBe(true);
    expect(bad([{ from: "2026-12-31", to: "2026-12-16", label: "x" }])).toBe(true);   // end before start
    expect(bad([{ from: "2026-02-30", to: "2026-03-01", label: "x" }])).toBe(true);   // not a real day
    expect(bad([{ from: "16/12/2026", to: "2026-12-31", label: "x" }])).toBe(true);
    expect(bad([{ from: "2026-12-16", to: "2026-12-31", label: "  " }])).toBe(true);  // no label
    expect(bad([{ from: "2026-12-16", to: "2026-12-31", label: "x".repeat(61) }])).toBe(true);
    expect(bad([{ from: "2026-01-01", to: "2026-12-31", label: "x" }])).toBe(true);   // a whole year is not a closure
  });
});

describe("readClosures / closureFor / closureLabelFor", () => {
  it("drops malformed stored entries instead of failing", () => {
    expect(readClosures(undefined)).toEqual([]);
    expect(readClosures([XMAS, { from: "nope", to: "2026-12-31" }, null])).toEqual([XMAS]);
    expect(readClosures([{ ...XMAS, percent: 50 }])[0].percent).toBe(50);
    expect("percent" in readClosures([{ ...XMAS, percent: 0 }])[0]).toBe(false);
  });

  it("both ends of a closure are closed days", () => {
    expect(closureFor("2026-12-15", [XMAS])).toBeUndefined();
    expect(closureFor("2026-12-16", [XMAS])).toBe(XMAS);
    expect(closureFor("2026-12-31", [XMAS])).toBe(XMAS);
    expect(closureFor("2027-01-01", [XMAS])).toBeUndefined();
    expect(closureFor("2026-12-20", undefined)).toBeUndefined();
  });

  it("labels the closures that cover a bill's closed days, once each", () => {
    const bridge: Closure = { id: "p", from: "2026-12-07", to: "2026-12-07", label: "Ponte" };
    expect(closureLabelFor(["2026-12-18", "2026-12-21"], [bridge, XMAS])).toBe("Férias de Natal");
    expect(closureLabelFor(["2026-12-07", "2026-12-18"], [bridge, XMAS])).toBe("Ponte, Férias de Natal");
    expect(closureLabelFor(["2026-11-02"], [XMAS])).toBe("");
  });
});

describe("closureSyncAction (what a sync does to one event)", () => {
  const ev = (o: Partial<ClosureSyncEvent> = {}): ClosureSyncEvent => ({ id: "s1_2026-12-18", date: "2026-12-18", status: "EXPECTED", ...o });
  const closedEv = (o: Partial<ClosureSyncEvent> = {}) => ev({ status: "CANCELLED", changedByRole: "system", reason: REASON_CLOSED, ...o });
  const active = { active: true };

  it("a served day inside a closure becomes a closure absence", () => {
    expect(closureSyncAction(ev(), [XMAS], active, OUTSIDE)).toEqual({ kind: "close" });
    expect(isClosureAbsence({ status: "CANCELLED", changedByRole: "system", reason: REASON_CLOSED })).toBe(true);
    expect(isClosureAbsence({ status: "CANCELLED", changedByRole: "parent" })).toBe(false);
  });

  it("an absence a parent had already recorded becomes a closure day too, and is remembered", () => {
    const a = closureSyncAction(ev({ status: "CANCELLED", changedByRole: "parent", changedBy: "p1", reason: "viagem" }), [XMAS], active, OUTSIDE);
    expect(a).toEqual({ kind: "close", keep: { status: "CANCELLED", changedByRole: "parent", changedBy: "p1", reason: "viagem" } });
  });

  it("leaves alone: a day outside the closure, a voided day, a day outside the contract, a day already closed", () => {
    expect(closureSyncAction(ev({ date: "2026-12-15" }), [XMAS], active, OUTSIDE)).toEqual({ kind: "none" });
    expect(closureSyncAction(ev({ status: "VOIDED" }), [XMAS], active, OUTSIDE)).toEqual({ kind: "none" });
    expect(closureSyncAction(ev({ status: "CANCELLED", changedByRole: "system", reason: OUTSIDE.beforeStart }), [XMAS], active, OUTSIDE)).toEqual({ kind: "none" });
    expect(closureSyncAction(closedEv(), [XMAS], active, OUTSIDE)).toEqual({ kind: "none" });
  });

  it("closure removed or shortened: the day is served again", () => {
    expect(closureSyncAction(closedEv(), [], active, OUTSIDE)).toEqual({ kind: "reopen", status: "EXPECTED" });
    expect(closureSyncAction(closedEv(), [{ ...XMAS, from: "2026-12-21" }], active, OUTSIDE)).toEqual({ kind: "reopen", status: "EXPECTED" });
  });

  it("... or goes back to the absence the parent had recorded", () => {
    const keep = { status: "CANCELLED", changedByRole: "parent", changedBy: "p1", changedAt: "T1", reason: "viagem" };
    expect(closureSyncAction(closedEv({ preClosure: keep }), [], active, OUTSIDE))
      .toEqual({ kind: "reopen", status: "CANCELLED", changedByRole: "parent", changedBy: "p1", changedAt: "T1", reason: "viagem" });
  });

  it("... or to an out-of-contract absence when the subscription doesn't cover the day (any more)", () => {
    expect(closureSyncAction(closedEv(), [], { active: true, start: "2026-12-21" }, OUTSIDE))
      .toMatchObject({ kind: "reopen", status: "CANCELLED", changedByRole: "system", reason: OUTSIDE.beforeStart });
    expect(closureSyncAction(closedEv(), [], { active: false, end: "2026-12-17" }, OUTSIDE))
      .toMatchObject({ kind: "reopen", status: "CANCELLED", changedByRole: "system", reason: OUTSIDE.afterEnd });
    // Cancelled after this day: it was a served day.
    expect(closureSyncAction(closedEv(), [], { active: false, end: "2026-12-20" }, OUTSIDE)).toEqual({ kind: "reopen", status: "EXPECTED" });
    // Subscription gone, or cancelled with no date to go by: never a served day.
    expect(closureSyncAction(closedEv(), [], undefined, OUTSIDE)).toMatchObject({ status: "CANCELLED", reason: OUTSIDE.afterEnd });
    expect(closureSyncAction(closedEv(), [], { active: false }, OUTSIDE)).toMatchObject({ status: "CANCELLED", reason: OUTSIDE.afterEnd });
  });
});
