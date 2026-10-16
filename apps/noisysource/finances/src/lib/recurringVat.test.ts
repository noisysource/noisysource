import { describe, it, expect, vi } from "vitest";
import type { RecurringEntryDoc } from "@shared/models/RecurringEntry";
import { recurringMonthlyAmountCents, recurringVatCode } from "@shared/models/RecurringEntry";
import { recurringVatInMonths } from "./recurringSchedule";
import {
  generateEcEvents,
  generateKidclubEvents,
  generateRecurringEvents,
  kidclubVolumeByMonth,
} from "@shared/lib/eventGenerators";

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
    expect(s.recurringCostCents).toBe(7535);
    expect(s.recurringNetCents).toBe(1500 + 3000 + 2000);
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
    expect(s.recurringCostCents).toBe(0);
    expect(s.breakdown).toEqual([]);
  });
  it("groups recurring costs by top-level category; only the Software category is software", () => {
    const categories = [
      { id: "soft", name: "Software" },
      { id: "casa", name: "Instalações" },
      { id: "renda", name: "Renda", parentId: "casa" },
    ];
    const s = computeNoisyphocusCostSummary({
      yearMonth: "2026-10",
      contracts: [],
      categories,
      recurring: [
        { ...vendus, categoryId: "soft" },
        entry({ description: "Renda", amountCents: 50000, vatCode: "isento", categoryId: "renda" }),
        entry({ description: "Água", amountCents: 2000, vatCode: 6 }),
      ],
    });
    expect(s.softwareCostCents).toBe(1845);
    expect(s.recurringCostCents).toBe(1845 + 50000 + 2000);
    expect(s.groups?.map(g => [g.name, g.amountCents])).toEqual([
      ["Instalações", 50000], ["Sem categoria", 2000], ["Software", 1845],
    ]);
    expect(s.breakdown?.find(l => l.label === "Renda")?.group).toBe("Instalações");
  });
});

describe("forecast", () => {
  const kcEvents = generateKidclubEvents(
    [{
      id: "b1", status: "pending", total: 2000,
      dueDate: { toDate: () => new Date(2026, 10, 8) }, // November
    }],
    "2026-10", 3,
  );

  it("books KidClub volume per month", () => {
    expect(kidclubVolumeByMonth(kcEvents)).toEqual({ "2026-11": 200000 });
  });

  it("charges the commission on that month's volume, VAT included, else the estimate", () => {
    const evts = generateRecurringEvents(
      [{ entry: easypay, entityId: "noisyphocus" }], "2026-10", 3, kidclubVolumeByMonth(kcEvents),
    );
    expect(evts.map(e => [e.date.slice(0, 7), e.amountCents])).toEqual([
      ["2026-10", -3000], // no KidClub bills yet: typed estimate
      ["2026-11", -3690], // 1.5% of 2 000 € + 23%
      ["2026-12", -3000],
    ]);
  });

  it("keeps EC cash-in unchanged: EC invoices are isento", () => {
    const contract = {
      id: "ec1", clientName: "EC", dailyRateCents: 50000, totalDays: 40,
      expectedDaysPerMonth: 20, startDate: new Date(2026, 9, 1), active: true,
    };
    const pay = generateEcEvents(contract, new Date(2026, 9, 1)).filter(e => e.type === "ec_payment");
    expect(pay.length).toBeGreaterThan(0);
    for (const e of pay) {
      expect(e.amountCents).toBe(e.metadata?.netCents);
      expect(e.metadata?.vatCode).toBe("isento");
    }
  });
});
