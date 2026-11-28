import { describe, it, expect } from "vitest";
import {
  capacityKwh, consumption, fullRangeByMonth, fullRangeKm, monthTotals, parseChargingHistory,
  type CarReading, type ChargingSession,
} from "./teslaCharging";

const session = (over: Record<string, unknown> = {}) => ({
  sessionId: 123,
  vin: "VINX",
  siteLocationName: "Coimbra, Portugal",
  chargeStartDateTime: "2026-11-27T23:30:00+00:00",
  chargeStopDateTime: "2026-11-28T00:20:00+00:00",
  fees: [
    { feeType: "CHARGING", currencyCode: "EUR", uom: "kwh", usageBase: 0, usageTier1: 40.5, usageTier2: 35.4, totalDue: 30.36 },
    { feeType: "CONGESTION", currencyCode: "EUR", uom: "min", usageBase: 3, totalDue: 1.5 },
  ],
  invoices: [{ fileName: "x.pdf", contentId: "abc", invoiceType: "IMMEDIATE" }],
  ...over,
});

describe("parseChargingHistory", () => {
  it("adds up kWh from the tiers and keeps energy and other fees apart", () => {
    const [s] = parseChargingHistory({ data: [session()] });
    expect(s).toMatchObject({
      id: "123", vin: "VINX", site: "Coimbra, Portugal", kwh: 75.9, energyCost: 30.36, otherFees: 1.5, cost: 31.86,
      currency: "EUR", invoiceIds: ["abc"],
    });
    expect(s.end! - s.start).toBe(50 * 60_000);
  });

  it("finds the list wherever Tesla puts it, skips broken items, newest first", () => {
    const older = session({ sessionId: 1, chargeStartDateTime: "2026-10-01T10:00:00Z" });
    expect(parseChargingHistory({ response: { data: [older, session()] } }).map(s => s.id)).toEqual(["123", "1"]);
    expect(parseChargingHistory({ data: [{ sessionId: 9 }, null] })).toEqual([]);
    expect(parseChargingHistory(undefined)).toEqual([]);
  });

  it("uses plain `usage` when there are no tiers, and ignores usage not in kWh", () => {
    const [s] = parseChargingHistory({ data: [session({ fees: [{ feeType: "CHARGING", uom: "kWh", usage: 20, totalDue: 8 }] })] });
    expect(s.kwh).toBe(20);
    const [m] = parseChargingHistory({ data: [session({ fees: [{ feeType: "CHARGING", uom: "min", usageBase: 30, totalDue: 9 }] })] });
    expect(m.kwh).toBe(0);
    expect(m.cost).toBe(9);
  });
});

const s = (id: string, vin: string, iso: string, kwh: number, cost: number): ChargingSession => ({
  id, vin, site: "S", start: Date.parse(iso), kwh, cost, energyCost: cost, otherFees: 0, currency: "EUR", invoiceIds: [],
});

describe("monthTotals", () => {
  it("groups by Lisbon month, per car, with €/kWh", () => {
    const list = [s("a", "X", "2026-11-02T10:00:00Z", 50, 20), s("b", "X", "2026-11-20T10:00:00Z", 30, 12),
      s("c", "Y", "2026-11-21T10:00:00Z", 40, 16), s("d", "X", "2026-10-31T23:30:00Z", 10, 4)];
    expect(monthTotals(list, "X")).toEqual([
      { month: "2026-11", sessions: 2, kwh: 80, cost: 32, perKwh: 0.4 },
      { month: "2026-10", sessions: 1, kwh: 10, cost: 4, perKwh: 0.4 },
    ]);
    expect(monthTotals(list).find(m => m.month === "2026-11")?.sessions).toBe(3);
  });
});

describe("battery", () => {
  it("projects the range at 100%, not from a nearly empty battery", () => {
    expect(fullRangeKm({ soc: 92, rangeKm: 485 })).toBe(527);
    expect(fullRangeKm({ soc: 10, rangeKm: 50 })).toBeUndefined();
    expect(fullRangeKm({ soc: 50 })).toBeUndefined();
  });

  it("works out the capacity from two readings in one charge (median of the good pairs)", () => {
    const t0 = Date.parse("2026-11-27T23:30:00Z");
    const r = (min: number, soc: number, added: number, state = "Charging"): CarReading =>
      ({ vin: "X", t: t0 + min * 60_000, soc, energyAddedKwh: added, chargingState: state });
    // 20% → 50% while 30 kWh went in: 100 kWh for 0→100%.
    expect(capacityKwh([r(0, 20, 0), r(20, 50, 30)])).toBe(100);
    // A pair across two charges, a tiny step and a parked car don't count.
    expect(capacityKwh([r(0, 20, 0), r(10, 22, 2), r(600, 60, 40, "Complete")])).toBeUndefined();
    expect(capacityKwh([r(0, 20, 0), r(20, 50, 30), r(40, 80, 60.6), r(60, 90, 72)])).toBe(102); // pairs give 100, 102, 114
  });

  it("gives the monthly trend of the range at 100%", () => {
    const rs: CarReading[] = [
      { vin: "X", t: Date.parse("2026-10-05T10:00:00Z"), soc: 80, rangeKm: 440 },
      { vin: "X", t: Date.parse("2026-11-05T10:00:00Z"), soc: 92, rangeKm: 485 },
      { vin: "Y", t: Date.parse("2026-11-05T10:00:00Z"), soc: 90, rangeKm: 400 },
    ];
    expect(fullRangeByMonth(rs, "X")).toEqual([{ month: "2026-10", km: 550 }, { month: "2026-11", km: 527 }]);
  });
});

describe("consumption", () => {
  it("is energy put back over distance driven between two charges with an odometer nearby", () => {
    const sessions = [s("1", "X", "2026-11-01T10:00:00Z", 60, 25), s("2", "X", "2026-11-10T10:00:00Z", 70, 28)];
    const reads: CarReading[] = [
      { vin: "X", t: Date.parse("2026-11-01T11:00:00Z"), odometerKm: 1000 },
      { vin: "X", t: Date.parse("2026-11-10T09:00:00Z"), odometerKm: 1350 },
    ];
    expect(consumption(sessions, reads, "X")).toMatchObject({ km: 350, kwh: 70, whPerKm: 200, cost: 28, per100Km: 8 });
  });

  it("says nothing without two odometer readings near a charge, or for a few km", () => {
    const sessions = [s("1", "X", "2026-11-01T10:00:00Z", 60, 25), s("2", "X", "2026-11-10T10:00:00Z", 70, 28)];
    expect(consumption(sessions, [{ vin: "X", t: Date.parse("2026-11-01T11:00:00Z"), odometerKm: 1000 }], "X")).toBeUndefined();
    expect(consumption(sessions, [
      { vin: "X", t: Date.parse("2026-11-01T11:00:00Z"), odometerKm: 1000 },
      { vin: "X", t: Date.parse("2026-11-10T09:00:00Z"), odometerKm: 1010 },
    ], "X")).toBeUndefined();
  });
});
