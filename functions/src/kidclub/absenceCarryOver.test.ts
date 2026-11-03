import { describe, it, expect } from "vitest";
import {
  absenceCreditCents, outstandingCarryOver, createCarryApplier, notionalFor, periodLabelPt,
  LedgerBill, LedgerLine, MonthEvents,
} from "./absenceCarryOver";
import { reconcileService } from "./reconciliation";

// The worked example: study Mon/Fri, EUR 6/day, every week, so gross EUR 48 and
// 8 notional occurrences (one absence = EUR 6 once there are 3 or more).
// October 2026 has 9 occurrences (Fri 2, 9, 16, 23, 30; Mon 5, 12, 19, 26).
const S = "sub1";
const line = (o: Partial<LedgerLine> = {}): LedgerLine => ({
  subscriptionId: S, type: "study", amount: 48, grossAmount: 48,
  absenceCount: 0, absenceCreditAmount: 0, notionalOccurrences: 8, ...o,
});
const bill = (period: string, status: string, lines: LedgerLine[]): LedgerBill => ({ period, status, lines });
const events = (map: Record<string, number>): ((period: string, subId: string) => MonthEvents | undefined) =>
  (period, subId) => (subId === S && period in map ? { total: 9, cancelled: map[period], rateCents: 600 } : undefined);

/** One recompute: the ledger from the closed bills, applied to the open months in order. */
function recompute(bills: LedgerBill[], cancelled: Record<string, number>, open: [string, LedgerLine[]][]) {
  const { outstanding, skipped } = outstandingCarryOver(bills, events(cancelled));
  const carry = createCarryApplier(outstanding);
  const applied = open.map(([period, lines]) => ({ period, ...carry.apply(period, lines) }));
  return { outstanding, skipped, applied, unapplied: carry.unapplied() };
}

describe("absenceCreditCents matches reconcileService step 4", () => {
  it("for every absence count, on a flat EUR 48 / 8 notional line", () => {
    for (let n = 0; n <= 10; n++) {
      const events = Array.from({ length: 9 }, (_, i) => ({
        date: `2026-10-${String(i + 1).padStart(2, "0")}`, basePriceCents: 600,
        status: (i < n ? "CANCELLED" : "EXPECTED") as "CANCELLED" | "EXPECTED",
      }));
      const [r] = reconcileService(
        [{ id: S, childId: "c", manualDiscountPct: 0.15, enrollmentDate: new Date(2026, 8, 1),
          scheduleWeekdays: ["monday", "friday"], weekPattern: "all", ratePerOccurrenceCents: 600, coversPeriod: true }],
        new Map([[S, events]]),
        { multiTripDiscountPct: 0, minTripsPerDay: 2, siblingDiscountPct: 0, schoolDiscounts: [], returningStudentDiscountPct: 0 },
      );
      expect(absenceCreditCents(r.netBeforeAbsenceCents, r.notionalOccurrences, Math.min(n, 9))).toBe(r.absenceCreditCents);
    }
  });
});

describe("carry-over from a paid month", () => {
  it("positive: absences marked after October was paid come off November's line", () => {
    const { applied, outstanding } = recompute(
      [bill("2026-10", "paid", [line()])], { "2026-10": 4 },
      [["2026-11", [line()]]],
    );
    expect(outstanding).toEqual([{ subscriptionId: S, fromPeriod: "2026-10", cents: 2400 }]);
    expect(applied[0].lines[0].amount).toBe(24);
    expect(applied[0].lines[0].carriedAbsenceCredits).toEqual([{ fromPeriod: "2026-10", amount: 24 }]);
    expect(applied[0].deltaCents).toBe(-2400);
  });

  it("negative: days restored after a credited month was paid are charged back on the next line", () => {
    // October was billed with 4 absences (EUR 24 credit) and paid; 2 were then restored.
    const { applied } = recompute(
      [bill("2026-10", "paid", [line({ amount: 24, absenceCount: 4, absenceCreditAmount: 24 })])], { "2026-10": 2 },
      [["2026-11", [line()]]],
    );
    expect(applied[0].lines[0].amount).toBe(72);
    expect(applied[0].lines[0].carriedAbsenceCredits).toEqual([{ fromPeriod: "2026-10", amount: -24 }]);
    expect(applied[0].deltaCents).toBe(2400);
  });

  it("no change since payment: nothing carried", () => {
    const { applied } = recompute(
      [bill("2026-10", "invoiced", [line({ amount: 24, absenceCount: 4, absenceCreditAmount: 24 })])], { "2026-10": 4 },
      [["2026-11", [line()]]],
    );
    expect(applied[0].lines[0]).toEqual(line());
    expect(applied[0].deltaCents).toBe(0);
  });

  it("is idempotent: recomputing again, with November's stored carry, gives the same lines", () => {
    const closed = [bill("2026-10", "paid", [line()])];
    const first = recompute(closed, { "2026-10": 4 }, [["2026-11", [line()]], ["2026-12", [line()]]]);
    // November is still pending: its stored carry is recomputed, not counted as delivered.
    const stored = bill("2026-11", "pending", first.applied[0].lines);
    const second = recompute([...closed, stored], { "2026-10": 4 }, [["2026-11", [line()]], ["2026-12", [line()]]]);
    expect(second.applied.map(a => a.lines)).toEqual(first.applied.map(a => a.lines));
    expect(second.applied[1].lines[0].carriedAbsenceCredits).toBeUndefined();
  });

  it("November gets paid, then another October change carries to December only", () => {
    const novPaid = bill("2026-11", "paid", [line({ amount: 24, carriedAbsenceCredits: [{ fromPeriod: "2026-10", amount: 24 }] })]);
    const { applied } = recompute(
      [bill("2026-10", "paid", [line()]), novPaid], { "2026-10": 5, "2026-11": 0 },
      [["2026-12", [line()]]],
    );
    // should(Oct) = 5 x EUR 6 = 30; 24 already went out on November's paid bill.
    expect(applied[0].lines[0].amount).toBe(42);
    expect(applied[0].lines[0].carriedAbsenceCredits).toEqual([{ fromPeriod: "2026-10", amount: 6 }]);
  });

  it("a month that itself received carry is priced on its full net: November's own absences", () => {
    const novPaid = bill("2026-11", "paid", [line({ amount: 24, carriedAbsenceCredits: [{ fromPeriod: "2026-10", amount: 24 }] })]);
    const { outstanding } = recompute(
      [bill("2026-10", "paid", [line()]), novPaid],
      { "2026-10": 4, "2026-11": 3 },
      [],
    );
    // EUR 48 net before absences (24 paid + 24 carried in), 3 absences = EUR 18, not 3 x EUR 3.
    expect(outstanding.find(o => o.fromPeriod === "2026-11")!.cents).toBe(1800);
    // October's 4 absences (EUR 24) already went out on November's paid bill.
    expect(outstanding.find(o => o.fromPeriod === "2026-10")!.cents).toBe(0);
  });

  it("never takes a line below EUR 0: the remainder goes to the month after", () => {
    const { applied, unapplied } = recompute(
      [bill("2026-10", "paid", [line()])], { "2026-10": 9 }, // every day absent: EUR 48 owed
      [["2026-11", [line({ amount: 30 })]], ["2026-12", [line()]]],
    );
    expect(applied[0].lines[0].amount).toBe(0);
    expect(applied[0].lines[0].carriedAbsenceCredits).toEqual([{ fromPeriod: "2026-10", amount: 30 }]);
    expect(applied[1].lines[0].amount).toBe(30);
    expect(applied[1].lines[0].carriedAbsenceCredits).toEqual([{ fromPeriod: "2026-10", amount: 18 }]);
    expect(unapplied).toEqual([]);
  });

  it("only the same subscription's line takes it; with none open it's left unapplied", () => {
    const { applied, unapplied } = recompute(
      [bill("2026-10", "paid", [line()])], { "2026-10": 4 },
      [["2026-11", [line({ subscriptionId: "otherSub" }), { subscriptionId: "child1:registration", type: "enrollment", amount: 35 }]]],
    );
    expect(applied[0].deltaCents).toBe(0);
    expect(unapplied).toEqual([{ subscriptionId: S, fromPeriod: "2026-10", cents: 2400 }]);
  });

  it("never applies to a month before or equal to the source", () => {
    const { applied } = recompute([bill("2026-10", "paid", [line()])], { "2026-10": 4 }, [["2026-09", [line()]], ["2026-10", [line()]]]);
    expect(applied.every(a => a.deltaCents === 0)).toBe(true);
  });

  it("a pending month left as it is (past, skipped) keeps its carry and it counts as delivered", () => {
    const { outstanding } = outstandingCarryOver([bill("2026-10", "paid", [line()])], events({ "2026-10": 4 }));
    const carry = createCarryApplier(outstanding);
    carry.standing([line({ amount: 24, carriedAbsenceCredits: [{ fromPeriod: "2026-10", amount: 24 }] })]);
    expect(carry.apply("2026-12", [line()]).deltaCents).toBe(0);
    expect(carry.unapplied()).toEqual([]);
  });

  it("charges are applied before credits, so the EUR 0 floor leaves the most room", () => {
    const { applied } = recompute(
      [
        bill("2026-09", "paid", [line()]),                                                  // 9 absences now: +48
        bill("2026-10", "paid", [line({ amount: 24, absenceCount: 4, absenceCreditAmount: 24 })]), // restored to 0: -24
      ],
      { "2026-09": 9, "2026-10": 0 },
      [["2026-11", [line({ amount: 48 })]], ["2026-12", [line()]]],
    );
    // 48 + 24 (charge) = 72, then the 48 credit: 24 left, nothing carried to December.
    expect(applied[0].lines[0].amount).toBe(24);
    expect(applied[0].lines[0].carriedAbsenceCredits).toEqual([{ fromPeriod: "2026-09", amount: 48 }, { fromPeriod: "2026-10", amount: -24 }]);
    expect(applied[1].deltaCents).toBe(0);
  });
});

describe("old and odd line shapes", () => {
  it("a pre-cutover paid line (no absenceCount, excludedDates model) is skipped, not read as 0 credit granted", () => {
    const old = { subscriptionId: S, type: "study", amount: 36, grossAmount: 48, excludedDates: ["2026-09-08", "2026-09-15"], frozenMidPeriodCancellation: true } as LedgerLine;
    const { outstanding, skipped } = outstandingCarryOver([bill("2026-09", "paid", [old])], events({ "2026-09": 4 }));
    expect(outstanding).toEqual([]);
    expect(skipped).toEqual([{ subscriptionId: S, fromPeriod: "2026-09", reason: expect.stringContaining("pre-cutover") }]);
  });

  it("an engine line with no absenceCreditAmount counts as 0 granted", () => {
    const l = line({ absenceCount: 0 });
    delete (l as any).absenceCreditAmount;
    const { outstanding } = outstandingCarryOver([bill("2026-10", "paid", [l])], events({ "2026-10": 3 }));
    expect(outstanding).toEqual([{ subscriptionId: S, fromPeriod: "2026-10", cents: 1800 }]);
  });

  it("a line from before notionalOccurrences was stored: derived from gross / the events' rate", () => {
    const l = line();
    delete l.notionalOccurrences;
    expect(notionalFor(l, { total: 9, cancelled: 0, rateCents: 600 })).toBe(8);
    const { outstanding } = outstandingCarryOver([bill("2026-10", "paid", [l])], events({ "2026-10": 4 }));
    expect(outstanding[0].cents).toBe(2400);
  });

  it("can't derive it (the rate changed since): skipped, nothing moves", () => {
    const l = line();
    delete l.notionalOccurrences;
    expect(notionalFor(l, { total: 9, cancelled: 0, rateCents: 700 })).toBeNull();
    const { outstanding, skipped } = outstandingCarryOver([bill("2026-10", "paid", [l])], () => ({ total: 9, cancelled: 4, rateCents: 700 }));
    expect(outstanding).toEqual([]);
    expect(skipped[0].reason).toContain("notional");
  });

  it("no events for a billed month is a data problem, not zero absences: no charge-back", () => {
    const { outstanding, skipped } = outstandingCarryOver(
      [bill("2026-10", "paid", [line({ amount: 24, absenceCount: 4, absenceCreditAmount: 24 })])], () => undefined);
    expect(outstanding).toEqual([]);
    expect(skipped[0].reason).toContain("no reservation events");
  });

  it("only closed bills are sources; pending and manually cancelled ones aren't", () => {
    for (const status of ["pending", "cancelled", "dry-run"]) {
      expect(outstandingCarryOver([bill("2026-10", status, [line()])], events({ "2026-10": 4 })).outstanding).toEqual([]);
    }
    for (const status of ["paid", "invoiced", "processing", "failed"]) {
      expect(outstandingCarryOver([bill("2026-10", status, [line()])], events({ "2026-10": 4 })).outstanding).toHaveLength(1);
    }
  });

  it("enrollment and event lines are never touched", () => {
    const fee = { subscriptionId: "child1:registration", type: "enrollment", amount: 35 };
    const { outstanding } = outstandingCarryOver([bill("2026-10", "paid", [fee as LedgerLine])], () => ({ total: 9, cancelled: 9, rateCents: 600 }));
    expect(outstanding).toEqual([]);
  });

  it("labels a period the way bills do", () => {
    expect(periodLabelPt("2026-10")).toBe("Outubro 2026");
    expect(periodLabelPt("2027-03")).toBe("Março 2027");
  });
});
