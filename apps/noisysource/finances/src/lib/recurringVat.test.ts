import { describe, it, expect, vi } from "vitest";
import type { RecurringEntryDoc } from "@shared/models/RecurringEntry";
import { recurringMonthlyAmountCents, recurringVatCode } from "@shared/models/RecurringEntry";
import { recurringVatInMonths } from "./recurringSchedule";

vi.mock("./firebase", () => ({ db: {} }));
const { computeNoisyphocusCostSummary } = await import("./api/domains/costSummary");

const entry = (over: Partial<RecurringEntryDoc>): RecurringEntryDoc => ({
  id: over.description ?? "x",
  type: "expense",
  description: "x",
  amountCents: 0,
  frequency: "monthly",
  dayOfMonth: 1,
  active: true,
  ...over,
});

const vendus = entry({ description: "Vendus", amountCents: 1845, vatCode: 23 }); // 15.00 + 3.45
const easypay = entry({
  description: "EasyPay", amountCents: 3000, vatCode: 23,
  costModel: "commission", commissionPct: 1.5,
});
const legacy = entry({ description: "Antiga", amountCents: 1000, ivaRatePct: 23 });
const claude = entry({ description: "Claude", amountCents: 2000, vatCode: "autoliquidacao" });

describe("recurringVatCode", () => {
  it("reads the stored code, 0 included", () => {
    expect(recurringVatCode(vendus)).toBe(23);
    expect(recurringVatCode(entry({ vatCode: 0 }))).toBe(0);
  });
  it("flags entries saved before the convention, whatever their old rate", () => {
    expect(recurringVatCode(legacy)).toBe("por_confirmar");
    expect(recurringVatCode(entry({}))).toBe("por_confirmar");
  });
  it("has no VAT for transfers and synced pay", () => {
    expect(recurringVatCode(entry({ type: "transfer" }))).toBeNull();
    expect(recurringVatCode(entry({ sourceId: "emp:abc:ns" }))).toBeNull();
    expect(recurringVatCode(entry({ type: "income", sourceId: "inc:abc" }))).toBeNull();
  });
  it("treats synced EC income and insurance as exempt", () => {
    expect(recurringVatCode(entry({ type: "income", sourceId: "ec:abc" }))).toBe("isento");
    expect(recurringVatCode(entry({ sourceId: "insurance:abc" }))).toBe("isento");
  });
});

describe("recurringMonthlyAmountCents — commission", () => {
  it("is % of the volume before VAT, plus VAT", () => {
    // 1.5% of 2 000.00 € = 30.00 € + 23% = 36.90 €
    expect(recurringMonthlyAmountCents(easypay, 200000)).toBe(3690);
  });
  it("leaves the fee without VAT while the VAT is unconfirmed", () => {
    const { vatCode: _, ...old } = easypay;
    expect(recurringMonthlyAmountCents(old, 200000)).toBe(3000);
  });
  it("falls back to the estimate without a volume", () => {
    expect(recurringMonthlyAmountCents(easypay)).toBe(3000);
  });
});

describe("recurringVatInMonths", () => {
  it("splits the VAT out of the amount instead of adding it", () => {
    const { rows, unconfirmed } = recurringVatInMonths([vendus], ["2026-10"], "expense");
    expect(rows).toEqual([{ description: "Vendus", baseCents: 1500, ivaCents: 345, vatCode: 23 }]);
    expect(unconfirmed).toEqual([]);
  });
  it("sums per month over a quarter", () => {
    const { rows } = recurringVatInMonths([vendus], ["2026-10", "2026-11", "2026-12"], "expense");
    expect(rows[0]).toMatchObject({ baseCents: 4500, ivaCents: 1035 });
  });
  it("lists por_confirmar apart and leaves exempt/reverse-charge out", () => {
    const { rows, unconfirmed } = recurringVatInMonths([legacy, claude], ["2026-10"], "expense");
    expect(rows).toEqual([]);
    expect(unconfirmed).toEqual([{ description: "Antiga", amountCents: 1000 }]);
  });
  it("uses the volume for commission entries", () => {
    const { rows } = recurringVatInMonths([easypay], ["2026-10"], "expense", { "2026-10": 200000 });
    expect(rows[0]).toMatchObject({ baseCents: 3000, ivaCents: 690 });
  });
});

describe("computeNoisyphocusCostSummary", () => {
  it("shows com/sem IVA without adding the VAT twice", () => {
    const s = computeNoisyphocusCostSummary({
      yearMonth: "2026-10",
      contracts: [],
      recurring: [vendus, easypay, claude],
      kidclubVolumeCentsForMonth: 200000,
    });
    // Vendus 18.45 + EasyPay 36.90 + Claude 20.00
    expect(s.softwareCostCents).toBe(7535);
    expect(s.softwareNetCents).toBe(1500 + 3000 + 2000);
    expect(s.vatCents).toBe(345 + 690);
    expect(s.totalCostCents).toBe(7535);
    expect(s.totalNetCents).toBe(6500);
    expect(s.unconfirmedVatCount).toBe(0);
    expect(s.breakdown?.some(l => l.label.startsWith("IVA"))).toBe(false);
  });
  it("counts por_confirmar at face value and says so", () => {
    const s = computeNoisyphocusCostSummary({ yearMonth: "2026-10", contracts: [], recurring: [legacy] });
    expect(s.totalCostCents).toBe(1000);
    expect(s.totalNetCents).toBe(1000);
    expect(s.unconfirmedVatCount).toBe(1);
  });
  it("doesn't count a contract's synced payroll entry as a recurring cost", () => {
    const s = computeNoisyphocusCostSummary({
      yearMonth: "2026-10",
      contracts: [],
      recurring: [entry({ description: "Encargos Salariais — X", amountCents: 120000, sourceId: "emp:c1:ns" })],
    });
    expect(s.softwareCostCents).toBe(0);
    expect(s.breakdown).toEqual([]);
  });
});
