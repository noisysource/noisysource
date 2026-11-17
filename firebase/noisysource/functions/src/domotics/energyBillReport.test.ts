import { describe, it, expect } from "vitest";
import {
  DEFAULT_TARIFF, SLOT_MS, computeBill, dayStart, parseEnergyDay, slotsInDay, zeroFlows,
  type EnergyDay, type EnergySlot, type Tariff,
} from "./energyBill";
import { buildEnergyBillReport, parseBillRange } from "./energyBillReport";

const T: Tariff = { ...DEFAULT_TARIFF, confirmed: true };

function day(date: string, fill: (i: number) => Partial<EnergySlot> | null): EnergyDay {
  const start = dayStart(date);
  const slots = Array.from({ length: slotsInDay(date) }, (_, i) => {
    const f = fill(i);
    return f ? { ...zeroFlows(), sec: 900, ...f } : null;
  });
  return { date, start, slots };
}

describe("parseBillRange", () => {
  it("takes two dates, inclusive", () => {
    expect(parseBillRange({ from: "2026-11-01", to: "2026-11-30" })).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(parseBillRange({ from: "2026-11-10", to: "2026-11-10" })).toEqual({ from: "2026-11-10", to: "2026-11-10" });
  });
  it("refuses anything that isn't a real date", () => {
    for (const bad of [undefined, null, {}, { from: "2026-11-01" }, { from: "2026-11-01", to: "30/11/2026" },
      { from: "2026-02-30", to: "2026-03-01" }, { from: 20261101, to: 20261130 }, { from: "2026-13-01", to: "2026-13-02" }]) {
      expect(parseBillRange(bad)).toEqual({ error: "from and to must be dates, YYYY-MM-DD" });
    }
  });
  it("refuses a range backwards or over 400 days", () => {
    expect(parseBillRange({ from: "2026-11-02", to: "2026-11-01" })).toEqual({ error: "from must not be after to" });
    expect(parseBillRange({ from: "2026-01-01", to: "2027-02-04" })).toEqual({ from: "2026-01-01", to: "2027-02-04" }); // 400 days
    expect(parseBillRange({ from: "2026-01-01", to: "2027-02-05" })).toEqual({ error: "at most 400 days" });
  });
});

describe("buildEnergyBillReport", () => {
  // Two winter days (Lisbon = UTC), long past. Every 15 minutes of day 1:
  // the house uses 250 Wh; from 10:00 to 16:00 the panels make 500 Wh, 250 to
  // the house, 150 into the battery, 100 to the grid; from 18:00 to 22:00 the
  // battery covers the house; the rest is bought. Day 2 has no document.
  const d1 = day("2026-11-10", i => {
    const h = i / 4;
    if (h >= 10 && h < 16) return { load: 250, pv: 500, pvLoad: 250, chg: 150, exp: 100 };
    if (h >= 18 && h < 22) return { load: 250, dis: 250, batLoad: 250 };
    return { load: 250, imp: 250 };
  });
  const now = Date.parse("2026-11-20T12:00:00Z");
  const r = buildEnergyBillReport([d1], T, { from: "2026-11-10", to: "2026-11-11" }, now);

  it("sums the kWh", () => {
    expect(r.kwh).toEqual({
      produced: 12,        // 24 slots × 0.5
      consumed: 24,        // 96 × 0.25
      bought: 14,          // 56 slots: 00–10 (40) + 16–18 (8) + 22–24 (8)
      sold: 2.4,
      selfConsumed: 10,    // 6 solar + 4 battery
      batteryCharged: 3.6,
      batteryDischarged: 4,
    });
    expect(r.selfSufficiency).toBe(0.417);
    expect(r.selfConsumption).toBe(0.8);
  });

  it("splits them by tariff period (vazio 22:00–08:00)", () => {
    expect(r.byPeriod.vazio).toEqual({
      hours: "22:00–08:00", producedKwh: 0, consumedKwh: 10, boughtKwh: 10, soldKwh: 0, boughtEurNoVat: 1.05,
    });
    expect(r.byPeriod.foraVazio).toEqual({
      hours: "08:00–22:00", producedKwh: 12, consumedKwh: 14, boughtKwh: 4, soldKwh: 2.4, boughtEurNoVat: 0.8,
    });
  });

  it("prices the three bills with energyBill.ts, over the range's two days", () => {
    expect(r.billedDays).toBe(2);
    expect(r.bills.actual).toBe(computeBill({ kwhVazio: 10, kwhFora: 4, kwhExport: 2.4, days: 2 }, T).total);
    expect(r.bills.withoutPanels).toBe(computeBill({ kwhVazio: 10, kwhFora: 14, kwhExport: 0, days: 2 }, T).total);
    expect(r.bills.withoutBattery).toBe(computeBill({ kwhVazio: 10, kwhFora: 8, kwhExport: 6, days: 2 }, T).total);
    expect(r.savings.total).toBeCloseTo(r.bills.withoutPanels - r.bills.actual, 2);
    expect(r.savings.panels).toBeCloseTo(r.bills.withoutPanels - r.bills.withoutBattery, 2);
    expect(r.savings.battery).toBeCloseTo(r.bills.withoutBattery - r.bills.actual, 2);
    expect(r.savings.total).toBeGreaterThan(0);
    expect(r.estimate).toBe(false);
  });

  it("counts the day without a document as missing slots", () => {
    expect(r.slots).toEqual({ expected: 192, missing: 96 });
  });

  it("is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it("stops at now for a range still running, and flags a default tariff", () => {
    // 10:00 on the 10th, data up to 09:00: the last hour may still be on the Pi.
    const early = day("2026-11-10", i => (i < 36 ? { load: 250, imp: 250 } : null));
    const live = buildEnergyBillReport([early], DEFAULT_TARIFF, { from: "2026-11-10", to: "2026-11-30" }, Date.parse("2026-11-10T10:00:00Z"));
    expect(live.billedDays).toBe(0.42);
    expect(live.kwh.bought).toBe(9);
    expect(live.slots).toEqual({ expected: 36, missing: 0 });
    expect(live.estimate).toBe(true);
  });

  it("reads the bridge's documents", () => {
    const doc = parseEnergyDay("2026-11-10", { q00: { sec: 900, load: 250, imp: 250 }, q01: { sec: 900, load: 250, imp: 250 } });
    const one = buildEnergyBillReport([doc], T, { from: "2026-11-10", to: "2026-11-10" }, now);
    expect(one.kwh.bought).toBe(0.5);
    expect(one.slots).toEqual({ expected: 96, missing: 94 });
  });

  it("an empty range that hasn't begun is all zeros", () => {
    const future = buildEnergyBillReport([], T, { from: "2026-12-01", to: "2026-12-31" }, now);
    expect(future.kwh.consumed).toBe(0);
    expect(future.billedDays).toBe(0);
    expect(future.slots).toEqual({ expected: 0, missing: 0 });
    expect(future.selfSufficiency).toBeNull();
  });
});
