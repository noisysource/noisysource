import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DEFAULT_TARIFF, SLOT_MS, addDays, billingPeriod, computeBill, computeScenarios, dayStart, derivedFlows,
  isVazio, lisbonDate, lisbonOffsetMs, parseEnergyDay, parseTariff, projectBill, slotsInDay, summarize,
  surplusOf, surplusWindow, batteryNotTaking, BATTERY_FULL_SOC, SURPLUS_MIN_W,
  zeroFlows, type EnergyDay, type EnergySlot, type Tariff,
} from "./energyBill";

const MARKER = "// ---- mirrored below:";
function mirroredPart(path: string): string {
  const src = readFileSync(path, "utf8");
  const at = src.indexOf(MARKER);
  if (at < 0) throw new Error(`${path} has no "${MARKER}" line`);
  return src.slice(at);
}

describe("energyBill.ts mirror", () => {
  it("is identical to packages/shared/lib/energyBill.ts below the marker", () => {
    const shared = mirroredPart(join(__dirname, "../../../packages/shared/lib/energyBill.ts"));
    expect(mirroredPart(join(__dirname, "energyBill.ts"))).toBe(shared);
  });
});

const HOUR = 3_600_000;
const T: Tariff = { ...DEFAULT_TARIFF };

/** A day of slots: `fill(i, t)` gives each slot's flows; null = no data. */
function day(date: string, fill: (i: number, t: number) => Partial<EnergySlot> | null): EnergyDay {
  const start = dayStart(date);
  const slots = Array.from({ length: slotsInDay(date) }, (_, i) => {
    const f = fill(i, start + i * SLOT_MS);
    return f ? { ...zeroFlows(), sec: 900, ...f } : null;
  });
  return { date, start, slots };
}
const hourOf = (t: number) => new Date(t + lisbonOffsetMs(t)).getUTCHours();

describe("Lisbon calendar", () => {
  it("matches Intl for every hour of 2026–2027", () => {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" });
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += HOUR) {
      expect(lisbonDate(t)).toBe(fmt.format(t));
    }
  });
  it("has 100 slots on 25/10/2026 and 92 on 28/03/2027", () => {
    expect(slotsInDay("2026-10-25")).toBe(100);
    expect(slotsInDay("2026-10-26")).toBe(96);
    expect(slotsInDay("2027-03-28")).toBe(92);
    expect(new Date(dayStart("2026-10-25")).toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(new Date(dayStart("2026-10-26")).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });
});

describe("isVazio (22:00–08:00)", () => {
  const at = (iso: string) => isVazio(Date.parse(iso), T);
  it("winter time", () => {
    expect(at("2026-11-10T21:59:00Z")).toBe(false);
    expect(at("2026-11-10T22:00:00Z")).toBe(true);
    expect(at("2026-11-11T07:59:00Z")).toBe(true);
    expect(at("2026-11-11T08:00:00Z")).toBe(false);
  });
  it("summer time: local hours, not UTC", () => {
    expect(at("2026-07-10T21:00:00Z")).toBe(true); // 22:00 local
    expect(at("2026-07-10T07:00:00Z")).toBe(false); // 08:00 local
  });
  it("a window that doesn't wrap midnight", () => {
    expect(isVazio(Date.parse("2026-11-10T03:00:00Z"), { vazioFrom: "02:00", vazioTo: "06:00" })).toBe(true);
    expect(isVazio(Date.parse("2026-11-10T07:00:00Z"), { vazioFrom: "02:00", vazioTo: "06:00" })).toBe(false);
  });
});

describe("parseEnergyDay", () => {
  it("reads q-fields, ignores the rest and anything out of range", () => {
    const d = parseEnergyDay("2026-11-10", {
      date: "2026-11-10", slots: 96, v: 1,
      q00: { pv: 0, load: 120, imp: 120, sec: 900, soc: 40 },
      q95: { load: 80, imp: 80, sec: 450 },
      q96: { load: 999, sec: 900 },
      q10: { load: 50, sec: 0 },
      qx: { load: 1 },
      updatedAt: { toMillis: () => 1234 },
    });
    expect(d.slots).toHaveLength(96);
    expect(d.slots[0]).toMatchObject({ load: 120, imp: 120, sec: 900, soc: 40, pv: 0, chg: 0 });
    expect(d.slots[95]?.sec).toBe(450);
    expect(d.slots[10]).toBeNull();
    expect(d.slots.filter(Boolean)).toHaveLength(2);
    expect(d.updatedAt).toBe(1234);
  });
});

describe("parseTariff", () => {
  it("fills defaults, clamps, and is unconfirmed until saved as such", () => {
    const t = parseTariff({ priceVazio: 0.09, billingDay: 31, vazioFrom: "25:00", confirmed: "yes" });
    expect(t.priceVazio).toBe(0.09);
    expect(t.priceForaVazio).toBe(DEFAULT_TARIFF.priceForaVazio);
    expect(t.billingDay).toBe(28);
    expect(t.vazioFrom).toBe("22:00");
    expect(t.confirmed).toBe(false);
    expect(parseTariff({ confirmed: true }).confirmed).toBe(true);
  });
});

describe("summarize", () => {
  const d = day("2026-11-10", (i) => (i === 50 ? null : { load: 100, imp: 100 }));
  const from = dayStart("2026-11-10");
  it("splits by tariff period and reports coverage", () => {
    const s = summarize([d], T, { from, to: from + 24 * HOUR, now: from + 30 * HOUR });
    expect(s.total.load).toBe(9500);
    // 22:00–08:00 = 40 slots, all with data.
    expect(s.vazio.load).toBe(4000);
    expect(s.fora.load).toBe(5500);
    expect(s.coveredSec).toBe(95 * 900);
    expect(s.expectedSec).toBe(96 * 900);
    expect(s.gaps).toEqual([]); // 15 min is not worth naming
  });
  it("doesn't count the future as missing, and names gaps of an hour or more", () => {
    const gappy = day("2026-11-10", (i) => (i >= 12 && i < 20 ? null : { load: 100, imp: 100 }));
    const s = summarize([gappy], T, { from, to: from + 24 * HOUR, now: from + 6 * HOUR });
    expect(s.expectedSec).toBe(24 * 900);
    expect(s.coveredSec).toBe(16 * 900);
    expect(s.gaps).toEqual([{ from: from + 3 * HOUR, to: from + 5 * HOUR }]);
  });
});

describe("computeBill", () => {
  it("prices a month by hand", () => {
    // 300 kWh fora, 200 vazio, 30 days, defaults: 200 kWh/30 days at 6 %.
    const b = computeBill({ kwhFora: 300, kwhVazio: 200, kwhExport: 0, days: 30 }, T);
    expect(b.lines.map((l) => l.net)).toEqual([60, 21, 10.8, 0.5, 2.81, 0.07]);
    expect(b.net).toBe(95.18);
    // 6 %: 200 of 500 kWh of the 81 € energy (32.40) + CAV 2.81; 23 %: the rest.
    expect(b.vat).toEqual([
      { rate: 6, base: 35.21, tax: 2.11 },
      { rate: 23, base: 59.97, tax: 13.79 },
    ]);
    expect(b.total).toBe(111.08);
  });
  it("puts all the energy at the reduced rate below the threshold, and credits exports", () => {
    const b = computeBill({ kwhFora: 60, kwhVazio: 40, kwhExport: 50, days: 30 }, { ...T, exportPrice: 0.05 });
    const energy = 60 * 0.2 + 40 * 0.105;
    expect(b.vat.find((v) => v.rate === 6)?.base).toBeCloseTo(energy + 2.81, 2);
    expect(b.exportCredit).toBe(2.5);
    expect(b.total).toBeCloseTo(b.net + b.vatTotal - 2.5, 2);
  });
  it("no reduced rate when the contract doesn't have one", () => {
    const b = computeBill({ kwhFora: 60, kwhVazio: 40, kwhExport: 0, days: 30 }, { ...T, vatReducedKwh: 0, vatCav: 23 });
    expect(b.vat.map((v) => v.rate)).toEqual([23]);
  });
});

describe("computeScenarios", () => {
  const date = "2026-11-10";
  const from = dayStart(date);
  const range = { from, to: from + 24 * HOUR, now: from + 25 * HOUR };
  const base = { load: 200, imp: 200 };

  it("no PV, no battery: nothing saved", () => {
    const s = summarize([day(date, () => base)], T, range);
    const r = computeScenarios(s, 1, T);
    expect(r.saving).toBe(0);
    expect(r.savingPv).toBe(0);
    expect(r.savingBattery).toBe(0);
  });

  it("panels only: the saving is all PV, and is what the direct use would have cost", () => {
    const d = day(date, (_i, t) => {
      const h = hourOf(t);
      return h >= 10 && h < 15 ? { pv: 1000, load: 500, pvLoad: 500, exp: 500 } : base;
    });
    const r = computeScenarios(summarize([d], T, range), 1, T);
    expect(r.savingBattery).toBe(0);
    // 20 slots × 0.5 kWh = 10 kWh fora not bought, at 0.20 € + IEC, with 23 % (above the 6 % kWh).
    expect(r.savingPv).toBeCloseTo(10 * (0.2 + 0.001) * 1.23, 1);
  });

  it("battery: solar stored at noon, used at 21:00, saves the evening price", () => {
    const d = day(date, (_i, t) => {
      const h = hourOf(t);
      if (h >= 10 && h < 12) return { pv: 1000, load: 200, pvLoad: 200, chg: 800 };
      if (h === 21) return { load: 1600, dis: 1600, batLoad: 1600 };
      return base;
    });
    const r = computeScenarios(summarize([d], T, range), 1, T);
    // 4 × 1.6 kWh fora covered by the battery.
    expect(r.savingBattery).toBeCloseTo(6.4 * (0.2 + 0.001) * 1.23, 1);
    expect(r.savingPv + r.savingBattery).toBeCloseTo(r.saving, 2);
    expect(derivedFlows(summarize([d], T, range).total).selfSufficiency).toBeGreaterThan(0);
  });

  it("battery charged from the grid in vazio pays only the price difference", () => {
    const d = day(date, (_i, t) => {
      const h = hourOf(t);
      if (h >= 0 && h < 2) return { load: 200, imp: 1200, chg: 1000, gridBat: 1000 };
      if (h === 21) return { load: 1800, dis: 1800, batLoad: 1800 };
      return base;
    });
    const r = computeScenarios(summarize([d], T, range), 1, T);
    // 8 kWh in at 0.105, 7.2 kWh out at 0.20 (losses included), plus the IEC on the difference.
    const expected = (7.2 * 0.2 - 8 * 0.105 + (7.2 - 8) * 0.001) * 1.23;
    expect(r.savingBattery).toBeCloseTo(expected, 1);
    expect(r.savingPv).toBe(0);
  });

  it("with an export price, solar the battery took is valued at what it could have sold for", () => {
    const t = { ...T, exportPrice: 0.05 };
    const d = day(date, (_i, tt) => {
      const h = hourOf(tt);
      if (h >= 10 && h < 12) return { pv: 1000, load: 200, pvLoad: 200, chg: 800 };
      if (h === 21) return { load: 1600, dis: 1600, batLoad: 1600 };
      return base;
    });
    const r = computeScenarios(summarize([d], t, range), 1, t);
    // 6.4 kWh stored (8 × 0.8) would have earned 0.32 € sold.
    expect(r.savingBattery).toBeCloseTo(6.4 * (0.2 + 0.001) * 1.23 - 6.4 * 0.05, 1);
    expect(r.savingPv + r.savingBattery).toBeCloseTo(r.saving, 2);
  });
});

describe("billingPeriod", () => {
  it("calendar months with day 1", () => {
    expect(billingPeriod("2026-10-25", 1)).toEqual({ from: "2026-10-01", to: "2026-10-31", days: 31 });
    expect(billingPeriod("2026-02-01", 1)).toEqual({ from: "2026-02-01", to: "2026-02-28", days: 28 });
  });
  it("any start day, across the year end", () => {
    expect(billingPeriod("2026-10-25", 15)).toEqual({ from: "2026-10-15", to: "2026-11-14", days: 31 });
    expect(billingPeriod("2026-10-10", 15)).toEqual({ from: "2026-09-15", to: "2026-10-14", days: 30 });
    expect(billingPeriod("2027-01-05", 20)).toEqual({ from: "2026-12-20", to: "2027-01-19", days: 31 });
  });
});

describe("projectBill", () => {
  it("a steady 10 kWh a day lands on 31 × 10 kWh for October", () => {
    const flat = (date: string) => day(date, () => ({ load: 10000 / slotsInDay(date), imp: 10000 / slotsInDay(date) }));
    const now = Date.parse("2026-10-25T12:00:00Z");
    const period: EnergyDay[] = [];
    for (let d = "2026-10-01"; d <= "2026-10-25"; d = addDays(d, 1)) period.push(flat(d));
    const recent = period.slice(-8, -1); // 18–24 Oct
    const p = projectBill(period, recent, T, now);
    expect(p.period).toEqual({ from: "2026-10-01", to: "2026-10-31", days: 31 });
    expect(p.elapsedDays).toBeCloseTo(24.5 + 1 / 24, 3); // 25/10 began at 23:00Z on the 24th
    expect(p.basisDays).toBeCloseTo(7, 5);
    expect(p.projectedEnergy.total.imp / 1000).toBeCloseTo(310, 0);
    expect(p.soFarEnergy.total.imp / 1000).toBeLessThan(250);
    expect(p.projected.actual.total).toBeGreaterThan(p.soFar.actual.total);
  });
  it("no recent data: no projection basis, and the projection is just what is known", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    const p = projectBill([], [], T, now);
    expect(p.basisDays).toBe(0);
    expect(p.projectedEnergy.total.imp).toBe(0);
  });
});

describe("solar surplus", () => {
  const date = "2026-11-10";
  const from = dayStart(date);
  const range = { from, to: from + 24 * HOUR, now: from + 25 * HOUR };
  // Renato's tariff shape: no export price.
  const t: Tariff = { ...T, exportPrice: 0, priceForaVazio: 0.164475, priceVazio: 0.095115 };

  it("separates regulation, surplus while charging, and surplus with the battery full", () => {
    const d = day(date, (_i, tt) => {
      const h = hourOf(tt);
      // 10–12: charging hard, a little surplus over the charge limit.
      if (h >= 10 && h < 12) return { pv: 1100, load: 200, pvLoad: 200, chg: 750, exp: 150, soc: 80 };
      // 12–15: battery full, everything spare goes to the grid.
      if (h >= 12 && h < 15) return { pv: 1100, load: 200, pvLoad: 200, chg: 0, exp: 900, soc: 100 };
      // Otherwise the inverter's regulation: a few Wh out now and then.
      return { load: 200, imp: 205, exp: 5, soc: 50 };
    });
    const s = surplusOf([d], t, range);
    expect(s.exp).toBe(8 * 150 + 12 * 900 + 76 * 5);
    expect(s.surplus).toBe(8 * 150 + 12 * 900); // the 5 Wh slots are regulation
    expect(s.full).toBe(12 * 900);
    expect(s.fullSlots).toHaveLength(12);
    expect(s.byHourFull.slice(12, 15)).toEqual([3600, 3600, 3600]);
    expect(s.byHour[10]).toBe(600);
    // 10.8 kWh fora de vazio at (0.164475 + 0.001) × 1.23.
    expect(s.valueFull).toBeCloseTo(10.8 * 0.165475 * 1.23, 2);
    expect(s.days).toBe(1);
    expect(surplusWindow(s.byHourFull)).toEqual({ from: 12, to: 15, share: 1 });
  });

  it("the battery's own export isn't solar surplus", () => {
    const d = day(date, () => ({ load: 300, dis: 800, batLoad: 300, exp: 500, soc: 60 }));
    const s = surplusOf([d], t, range);
    expect(s.exp).toBe(96 * 500);
    expect(s.surplus).toBe(0);
  });

  it("counts a battery that has stopped charging as full, whatever its SoC says", () => {
    expect(batteryNotTaking({ soc: BATTERY_FULL_SOC, chg: 400 })).toBe(true);
    expect(batteryNotTaking({ soc: 90, chg: 10 })).toBe(true);
    expect(batteryNotTaking({ soc: 90, chg: 400 })).toBe(false);
    expect(batteryNotTaking({ chg: 400 })).toBe(false);
  });

  it("the app's live hint uses the same thresholds (apps/noisysource/domotics/src/data/energy.ts)", () => {
    const app = readFileSync(join(__dirname, "../../../apps/noisysource/domotics/src/data/energy.ts"), "utf8");
    expect(Number(/const SURPLUS_MIN_W = (\d+);/.exec(app)?.[1])).toBe(SURPLUS_MIN_W);
    expect(Number(/const BATTERY_FULL_SOC = (\d+);/.exec(app)?.[1])).toBe(BATTERY_FULL_SOC);
  });

  it("finds the main window of the day", () => {
    const byHour = new Array(24).fill(0);
    byHour[11] = 100; byHour[12] = 400; byHour[13] = 500; byHour[14] = 300; byHour[15] = 50;
    expect(surplusWindow(byHour)).toEqual({ from: 12, to: 15, share: 1200 / 1350 });
    expect(surplusWindow(new Array(24).fill(0))).toBeNull();
  });
});
