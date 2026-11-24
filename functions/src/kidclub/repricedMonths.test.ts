import { describe, it, expect } from "vitest";
import { isRecomputableBill, repricedMonths, MonthlyBillLite } from "./repricedMonths";

const bill = (period: string, status: string, o: Partial<MonthlyBillLite> = {}): MonthlyBillLite =>
  ({ period, status, serviceSubscriptionIds: ["t1"], ...o });

describe("isRecomputableBill", () => {
  it("pending, or cancelled by the billing sync itself", () => {
    expect(isRecomputableBill({ status: "pending" })).toBe(true);
    expect(isRecomputableBill({ status: "cancelled", autoCancelled: true })).toBe(true);
  });
  it("nothing else", () => {
    for (const status of ["paid", "invoiced", "processing", "failed", "cancelled", "dry-run"]) {
      expect(isRecomputableBill({ status })).toBe(false);
    }
    expect(isRecomputableBill(undefined)).toBe(false);
  });
});

describe("repricedMonths (which months' elapsed days follow a schedule edit)", () => {
  const run = (bills: MonthlyBillLite[], activeSubscriptionIds = ["t1"]) =>
    repricedMonths({ currentMonth: "2026-11", bills, activeSubscriptionIds });

  it("the current month while its bill is pending", () => {
    expect(run([bill("2026-11", "pending"), bill("2026-12", "pending")])).toEqual(["2026-11"]);
  });

  it("the current month with no bill yet: it gets one at the new schedule", () => {
    expect(run([])).toEqual(["2026-11"]);
  });

  it("not the current month once its bill is processing, paid, invoiced, failed or admin-cancelled", () => {
    for (const status of ["processing", "paid", "invoiced", "failed", "cancelled"]) {
      expect(run([bill("2026-11", status)])).toEqual([]);
    }
  });

  it("an earlier month only while its bill is still open", () => {
    expect(run([bill("2026-09", "pending"), bill("2026-10", "paid"), bill("2026-11", "pending")])).toEqual(["2026-09", "2026-11"]);
    expect(run([bill("2026-10", "cancelled", { autoCancelled: true }), bill("2026-11", "paid")])).toEqual(["2026-10"]);
  });

  it("an earlier month with no bill is never followed (past months are only updated, never created)", () => {
    expect(run([bill("2026-11", "pending")])).toEqual(["2026-11"]);
  });

  it("not an earlier open month the recompute leaves as it is: a subscription on it is no longer active", () => {
    const bills = [bill("2026-10", "pending", { serviceSubscriptionIds: ["t1", "gone"] }), bill("2026-11", "pending")];
    expect(run(bills)).toEqual(["2026-11"]);
    expect(run(bills, ["t1", "gone"])).toEqual(["2026-10", "2026-11"]);
  });
});
