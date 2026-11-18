import {
  SLOT_MS, addDays, computeScenarios, dayStart, daysBetween, derivedFlows, lisbonDate, slotsInDay, summarize,
  type EnergyDay, type EnergyFlows, type Tariff,
} from "./energyBill";

/**
 * The Energia page's numbers for a range of days, as plain JSON, for the
 * `domoticsEnergyBill` callable (energyBillCallable.ts). No pricing of its
 * own: the kWh and the three bills come from energyBill.ts, called the way the
 * page calls it (apps/noisysource/domotics/src/components/energy/EnergyScreen.tsx).
 * Pure: no Firestore, no clock.
 */

export const MAX_RANGE_DAYS = 400;
const DAY_MS = 86_400_000;
/** The bridge uploads hourly: data this recent may still be on the Pi (the page's UPLOAD_LAG_MS). */
const UPLOAD_LAG_MS = 80 * 60_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !DATE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
};

/** The request's range, dates inclusive (Lisbon days), or why it's refused. */
export function parseBillRange(data: unknown): { from: string; to: string } | { error: string } {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  if (!isDate(d.from) || !isDate(d.to)) return { error: "from and to must be dates, YYYY-MM-DD" };
  if (d.from > d.to) return { error: "from must not be after to" };
  if (daysBetween(d.from, d.to) + 1 > MAX_RANGE_DAYS) return { error: `at most ${MAX_RANGE_DAYS} days` };
  return { from: d.from, to: d.to };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const kwh = (wh: number) => r2(wh / 1000);
const share = (v: number | undefined) => (v === undefined ? null : r3(v));

function periodKwh(f: EnergyFlows) {
  return { producedKwh: kwh(f.pv), consumedKwh: kwh(f.load), boughtKwh: kwh(f.imp), soldKwh: kwh(f.exp) };
}

export type EnergyBillReport = ReturnType<typeof buildEnergyBillReport>;

/**
 * `days`: the `domotics_energy` documents found in the range (a day with no
 * document counts as all slots missing). Euros include VAT, as on the page.
 */
export function buildEnergyBillReport(
  days: EnergyDay[],
  tariff: Tariff,
  range: { from: string; to: string },
  now: number,
) {
  // Every day of the range that has begun, so that a day the bridge never
  // wrote shows up as missing instead of vanishing.
  const byDate = new Map(days.map(d => [d.date, d]));
  const today = lisbonDate(now);
  const all: EnergyDay[] = [];
  for (let date = range.from; date <= range.to && date <= today; date = addDays(date, 1)) {
    all.push(byDate.get(date) ?? { date, start: dayStart(date), slots: new Array(slotsInDay(date)).fill(null) });
  }

  // As on the page: energy and coverage stop where the data can be by now;
  // the fixed charges (potência, taxes) run to now.
  let last: number | undefined;
  for (const day of all) {
    day.slots.forEach((slot, i) => {
      if (slot && slot.sec > 0) last = Math.max(last ?? 0, day.start + (i + 1) * SLOT_MS);
    });
  }
  const dataNow = Math.min(now, Math.max(last ?? 0, now - UPLOAD_LAG_MS));
  const from = dayStart(range.from);
  const to = dayStart(addDays(range.to, 1));
  const summary = summarize(all, tariff, { from, to, now: dataNow });
  const billedDays = Math.max(0, Math.min(to, now) - from) / DAY_MS;
  const s = computeScenarios(summary, billedDays, tariff);

  const end = Math.min(to, dataNow);
  let expected = 0;
  let missing = 0;
  for (const day of all) {
    day.slots.forEach((slot, i) => {
      const t = day.start + i * SLOT_MS;
      if (t < from || t >= end) return;
      expected++;
      if (!slot || slot.sec <= 0) missing++;
    });
  }

  const t = summary.total;
  const d = derivedFlows(t);
  const line = (key: "vazio" | "fora") => s.actual.lines.find(l => l.key === key)?.net ?? 0;
  return {
    from: range.from,
    to: range.to,
    /** Days billed so far: the whole range, or up to now when it hasn't ended. */
    billedDays: r2(billedDays),
    /** True while the tariff is the default one, not Renato's: the euros are an estimate. */
    estimate: !tariff.confirmed,
    kwh: {
      produced: kwh(t.pv),
      consumed: kwh(t.load),
      bought: kwh(t.imp),
      sold: kwh(t.exp),
      /** Consumption not bought from the grid: solar used as produced, plus the battery. */
      selfConsumed: kwh(t.pvLoad + t.batLoad),
      batteryCharged: kwh(t.chg),
      batteryDischarged: kwh(t.dis),
    },
    /** 0–1, or null without consumption / production. */
    selfSufficiency: share(d.selfSufficiency),
    selfConsumption: share(d.selfConsumption),
    /** € with VAT, potência and taxes included. */
    bills: {
      actual: s.actual.total,
      withoutPanels: s.withoutSystem.total,
      withoutBattery: s.pvOnly.total,
    },
    savings: { total: s.saving, panels: s.savingPv, battery: s.savingBattery },
    byPeriod: {
      vazio: { hours: `${tariff.vazioFrom}–${tariff.vazioTo}`, ...periodKwh(summary.vazio), boughtEurNoVat: line("vazio") },
      foraVazio: { hours: `${tariff.vazioTo}–${tariff.vazioFrom}`, ...periodKwh(summary.fora), boughtEurNoVat: line("fora") },
    },
    /** 15-minute slots of the range that have passed, and how many of them have no data (totals are then below the real ones). */
    slots: { expected, missing },
  };
}
