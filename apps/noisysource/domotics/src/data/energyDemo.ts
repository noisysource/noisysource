import {
  SLOT_MS, addDays, dayStart, isVazio, lisbonDate, lisbonMinutes, slotsInDay, DEFAULT_TARIFF, type EnergyDay, type EnergySlot,
} from '@shared/lib/energyBill';

/**
 * Made-up kWh history for `?demo` (data/demoData.ts): a year and a bit of a
 * house like this one — ~5 kWp of panels, a ~10 kWh battery, floor heating on
 * a heat pump in the cold months — simulated slot by slot with the same
 * priorities the bridge assumes (PV to the house, then the battery, then the
 * grid). Deterministic: the same period looks the same every time it's
 * opened. Three days ago has a gap (03:10–04:25), to show what missing data
 * looks like.
 */

const KWP = 5.2;
const BATTERY_WH = 9600;
const BATTERY_MAX_W = 3000;
const RESERVE = 0.1;
const EFFICIENCY = 0.95;

/** Small deterministic PRNG (mulberry32), seeded from the date. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (date: string) => Number(date.replace(/-/g, ''));

/** Sunrise and sunset in local minutes, roughly Coimbra's, by day of year. */
function daylight(date: string): [number, number] {
  const doy = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${date.slice(0, 4)}-01-01T00:00:00Z`)) / 86_400_000;
  const s = Math.cos(((doy - 172) / 365) * 2 * Math.PI); // 1 at the June solstice, −1 in December
  // Solar noon ~13:40 in summer time, ~12:40 in winter time.
  const summer = doy > 87 && doy < 300;
  const noon = summer ? 13 * 60 + 40 : 12 * 60 + 40;
  const half = (12 * 60 + 2.4 * 60 * s) / 2;
  return [noon - half, noon + half];
}

/** Heating need 0–1: winter high, summer none. */
function heatingNeed(date: string): number {
  const m = Number(date.slice(5, 7));
  return [0, 1, 0.85, 0.6, 0.3, 0.1, 0, 0, 0, 0.05, 0.4, 0.7, 0.9][m];
}

let soc = 0.6;
let socDate = '';

function simulateDay(date: string, now: number): EnergyDay {
  const r = rng(seedOf(date));
  const start = dayStart(date);
  const n = slotsInDay(date);
  const [rise, set] = daylight(date);
  const clouds = 0.25 + 0.75 * Math.pow(r(), 0.6);
  const need = heatingNeed(date);
  const season = 0.55 + 0.45 * Math.max(0, Math.cos(((Number(date.slice(5, 7)) - 6.5) / 12) * 2 * Math.PI));
  // The battery carries over from the previous day when days are generated in order.
  if (socDate !== addDays(date, -1)) soc = 0.4 + 0.3 * r();
  socDate = date;
  const gappy = date === addDays(lisbonDate(now), -3);

  const slots: Array<EnergySlot | null> = [];
  for (let i = 0; i < n; i++) {
    const t = start + i * SLOT_MS;
    if (t + SLOT_MS > now) { slots.push(null); continue; }
    const m = lisbonMinutes(t) + 7.5;
    if (gappy && m >= 3 * 60 + 10 && m < 4 * 60 + 25) { slots.push(null); continue; }

    const sun = m > rise && m < set ? Math.sin(((m - rise) / (set - rise)) * Math.PI) : 0;
    const pvW = KWP * 1000 * 0.85 * season * sun * clouds * (0.85 + 0.3 * r());
    // House: base + kitchen peaks + the heat pump (floor heating), more at night.
    let loadW = 250 + 150 * r();
    if (m > 7 * 60 && m < 9 * 60) loadW += 900 * r();
    if (m > 12 * 60 + 30 && m < 14 * 60) loadW += 1200 * r();
    if (m > 19 * 60 && m < 21 * 60 + 30) loadW += 1600 * r();
    const pumpChance = need * (isVazio(t, DEFAULT_TARIFF) ? 0.75 : 0.45);
    if (r() < pumpChance) loadW += 1800 + 1200 * r();

    // PV → house → battery → grid; battery → house; grid for the rest.
    const pvLoadW = Math.min(pvW, loadW);
    let surplus = pvW - pvLoadW;
    let deficit = loadW - pvLoadW;
    const room = ((1 - soc) * BATTERY_WH) / 0.25; // W that would fill it in this slot
    const chgW = Math.min(surplus, BATTERY_MAX_W, room);
    surplus -= chgW;
    const avail = (Math.max(0, soc - RESERVE) * BATTERY_WH) / 0.25;
    const disW = Math.min(deficit, BATTERY_MAX_W, avail);
    deficit -= disW;
    soc += (chgW * EFFICIENCY - disW / EFFICIENCY) * 0.25 / BATTERY_WH;
    soc = Math.min(1, Math.max(0, soc));

    const wh = (w: number) => Math.round(w * 0.25);
    slots.push({
      pv: wh(pvW),
      load: wh(loadW),
      imp: wh(deficit),
      exp: wh(surplus),
      chg: wh(chgW),
      dis: wh(disW),
      pvLoad: wh(pvLoadW),
      batLoad: wh(disW),
      gridBat: 0,
      sec: 900,
      soc: Math.round(soc * 100),
    });
  }
  return { date, start, slots, updatedAt: now };
}

export function demoEnergyDays(from: string, to: string, now: number): EnergyDay[] {
  const out: EnergyDay[] = [];
  // Start a few days early so the battery's state has settled into the range.
  for (let d = addDays(from, -3); d <= to; d = addDays(d, 1)) {
    const day = simulateDay(d, now);
    if (d >= from) out.push(day);
  }
  return out;
}
