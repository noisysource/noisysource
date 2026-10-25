// functions/src/domotics/energyBill.ts
//
// A copy of packages/shared/lib/energyBill.ts (the domotics app's Energia page
// uses that one), for the domotics chat to price the house's electricity the
// same way. functions/ can't import @shared at runtime, so everything below the
// marker line is a byte-for-byte copy; energyBill.test.ts fails if they differ.
// Edit packages/shared/lib/energyBill.ts, then copy it here.
// ---- mirrored below: packages/shared/lib/energyBill.ts = functions/src/domotics/energyBill.ts ----

// --- Energy ------------------------------------------------------------------

/** Energy flows, Wh. One 15-minute slot as the bridge writes it (domotics-bridge/src/energy.ts), or any sum of slots. */
export interface EnergyFlows {
  /** PV produced. */
  pv: number;
  /** House consumption. */
  load: number;
  /** Bought from the grid. */
  imp: number;
  /** Sent to the grid. */
  exp: number;
  /** Into the battery. */
  chg: number;
  /** Out of the battery. */
  dis: number;
  /** PV used by the house as it was produced. */
  pvLoad: number;
  /** Battery used by the house. */
  batLoad: number;
  /** Grid energy that went into the battery. */
  gridBat: number;
}

export interface EnergySlot extends EnergyFlows {
  /** Seconds of the slot covered by readings, 0–900. */
  sec: number;
  /** Battery % at the end of the slot. */
  soc?: number;
}

/** One Lisbon day of `domotics_energy`. */
export interface EnergyDay {
  /** 'YYYY-MM-DD', Lisbon. */
  date: string;
  /** When the day began, ms. */
  start: number;
  /** Index i covers start + i×15 min. null: no data (bridge down, inverter silent, or not yet written). */
  slots: Array<EnergySlot | null>;
  updatedAt?: number;
}

export const SLOT_MS = 15 * 60_000;
export const SLOT_SEC = SLOT_MS / 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const FLOW_KEYS: readonly (keyof EnergyFlows)[] = [
  'pv', 'load', 'imp', 'exp', 'chg', 'dis', 'pvLoad', 'batLoad', 'gridBat',
];

export const zeroFlows = (): EnergyFlows => ({
  pv: 0, load: 0, imp: 0, exp: 0, chg: 0, dis: 0, pvLoad: 0, batLoad: 0, gridBat: 0,
});

export function addFlows(into: EnergyFlows, f: EnergyFlows): EnergyFlows {
  for (const k of FLOW_KEYS) into[k] += f[k];
  return into;
}

/** The flows the bridge doesn't store, derived from the ones it does. All Wh. */
export function derivedFlows(f: EnergyFlows) {
  const pvBat = Math.max(0, f.chg - f.gridBat);
  const batGrid = Math.max(0, f.dis - f.batLoad);
  const pvGrid = Math.max(0, f.exp - batGrid);
  const gridLoad = Math.max(0, f.load - f.pvLoad - f.batLoad);
  return {
    /** PV that went into the battery. */
    pvBat,
    /** PV sent to the grid. */
    pvGrid,
    /** Battery sent to the grid (rare). */
    batGrid,
    /** Grid energy used by the house. */
    gridLoad,
    /** Share of consumption not bought from the grid, 0–1 (autossuficiência). */
    selfSufficiency: f.load > 0 ? Math.min(1, (f.pvLoad + f.batLoad) / f.load) : undefined,
    /** Share of PV used in the house, directly or through the battery, 0–1 (autoconsumo). */
    selfConsumption: f.pv > 0 ? Math.min(1, Math.max(0, (f.pv - pvGrid) / f.pv)) : undefined,
  };
}

// --- Lisbon calendar ------------------------------------------------------------
// The EU rule (UTC+1 from 01:00 UTC on the last Sunday of March to 01:00 UTC on
// the last Sunday of October), the same as the bridge's, so both cut days and
// slots identically without depending on anyone's time-zone data.

function lastSunday0100(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay(), 1);
}

/** Lisbon's offset from UTC at instant `t`, ms. */
export function lisbonOffsetMs(t: number): number {
  const y = new Date(t).getUTCFullYear();
  return t >= lastSunday0100(y, 2) && t < lastSunday0100(y, 9) ? HOUR : 0;
}

/** 'YYYY-MM-DD' in Lisbon at instant `t`. */
export function lisbonDate(t: number): string {
  return new Date(t + lisbonOffsetMs(t)).toISOString().slice(0, 10);
}

/** Minutes since local midnight at instant `t` (wall clock: 01:30 happens twice on the October day). */
export function lisbonMinutes(t: number): number {
  const d = new Date(t + lisbonOffsetMs(t));
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** The instant Lisbon's day `date` begins. */
export function dayStart(date: string): number {
  const midnightUtc = Date.parse(`${date}T00:00:00Z`);
  return midnightUtc - lisbonOffsetMs(midnightUtc - HOUR);
}

/** `date` plus `n` calendar days. */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** Calendar days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
}

/** 96 slots, or 92 / 100 on the days the clocks change. */
export function slotsInDay(date: string): number {
  return Math.round((dayStart(addDays(date, 1)) - dayStart(date)) / SLOT_MS);
}

// --- Reading the documents ------------------------------------------------------

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function toMs(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  // Firestore Timestamp (client and Admin SDK), without importing either.
  if (v && typeof (v as { toMillis?: unknown }).toMillis === 'function') return (v as { toMillis(): number }).toMillis();
  return undefined;
}

/** A `domotics_energy/{date}` document → EnergyDay. Unknown fields are ignored; a malformed slot reads as no data. */
export function parseEnergyDay(id: string, data: Record<string, unknown>): EnergyDay {
  const n = slotsInDay(id);
  const slots: Array<EnergySlot | null> = new Array(n).fill(null);
  for (const [key, value] of Object.entries(data)) {
    const m = /^q(\d{2})$/.exec(key);
    if (!m || !value || typeof value !== 'object') continue;
    const i = Number(m[1]);
    if (i >= n) continue;
    const v = value as Record<string, unknown>;
    const slot: EnergySlot = { ...zeroFlows(), sec: Math.min(SLOT_SEC, Math.max(0, num(v.sec))) };
    for (const k of FLOW_KEYS) slot[k] = Math.max(0, num(v[k]));
    if (typeof v.soc === 'number') slot.soc = v.soc;
    slots[i] = slot.sec > 0 ? slot : null;
  }
  return { date: id, start: dayStart(id), slots, updatedAt: toMs(data.updatedAt) };
}

// --- Tariff -------------------------------------------------------------------------

/**
 * `domotics_config/tariff`, edited in the app. Prices without VAT, as the
 * supplier's price list states them. Defaults are a plausible bi-horário
 * contract, not Renato's: `confirmed` stays false until he saves his own, and
 * every figure computed from an unconfirmed tariff is shown as an estimate.
 */
export interface Tariff {
  supplier: string;
  /** Vazio window, local 'HH:MM', may wrap midnight. Bi-horário daily cycle: 22:00–08:00. */
  vazioFrom: string;
  vazioTo: string;
  /** €/kWh, sem IVA. */
  priceVazio: number;
  priceForaVazio: number;
  /** Potência contratada, kVA (decides the VAT rules below). */
  powerKva: number;
  /** €/day, sem IVA. */
  powerPerDay: number;
  /**
   * €/kWh paid for what goes to the grid. 0 = no selling contract: the house
   * sends some (the inverter regulating, and surplus when the battery is
   * full), unpaid. That is Renato's case. No VAT if it were paid (a private seller).
   */
  exportPrice: number;
  /** Imposto especial sobre o consumo, €/kWh. */
  iecPerKwh: number;
  /** Contribuição audiovisual, €/month. */
  cavPerMonth: number;
  /** Taxa de exploração DGEG, €/month. */
  dgegPerMonth: number;
  /** IVA, percent. */
  vatStandard: number;
  vatReduced: number;
  /** kWh per 30 days charged at the reduced rate (contracts up to 6.9 kVA); 0 = none. */
  vatReducedKwh: number;
  /** IVA on the power term: 6 up to 3.45 kVA, 23 above. */
  vatPower: number;
  /** IVA on the CAV. */
  vatCav: number;
  /** Day of the month the billing period starts, 1–28. */
  billingDay: number;
  /** false until Renato has entered his own prices. */
  confirmed: boolean;
}

export const DEFAULT_TARIFF: Tariff = {
  supplier: '',
  vazioFrom: '22:00',
  vazioTo: '08:00',
  priceVazio: 0.105,
  priceForaVazio: 0.2,
  powerKva: 6.9,
  powerPerDay: 0.36,
  exportPrice: 0,
  iecPerKwh: 0.001,
  cavPerMonth: 2.85,
  dgegPerMonth: 0.07,
  vatStandard: 23,
  vatReduced: 6,
  vatReducedKwh: 200,
  vatPower: 23,
  vatCav: 6,
  billingDay: 1,
  confirmed: false,
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
}

/** Whatever is stored → a usable tariff. Out-of-range values are clamped; missing ones take the default. */
export function parseTariff(raw: unknown): Tariff {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_TARIFF;
  const hhmm = (v: unknown, dflt: string) => (typeof v === 'string' && HHMM.test(v) ? v : dflt);
  return {
    supplier: typeof r.supplier === 'string' ? r.supplier.slice(0, 80) : d.supplier,
    vazioFrom: hhmm(r.vazioFrom, d.vazioFrom),
    vazioTo: hhmm(r.vazioTo, d.vazioTo),
    priceVazio: clampNum(r.priceVazio, 0, 2, d.priceVazio),
    priceForaVazio: clampNum(r.priceForaVazio, 0, 2, d.priceForaVazio),
    powerKva: clampNum(r.powerKva, 1, 50, d.powerKva),
    powerPerDay: clampNum(r.powerPerDay, 0, 10, d.powerPerDay),
    exportPrice: clampNum(r.exportPrice, 0, 2, d.exportPrice),
    iecPerKwh: clampNum(r.iecPerKwh, 0, 0.1, d.iecPerKwh),
    cavPerMonth: clampNum(r.cavPerMonth, 0, 20, d.cavPerMonth),
    dgegPerMonth: clampNum(r.dgegPerMonth, 0, 5, d.dgegPerMonth),
    vatStandard: clampNum(r.vatStandard, 0, 30, d.vatStandard),
    vatReduced: clampNum(r.vatReduced, 0, 30, d.vatReduced),
    vatReducedKwh: clampNum(r.vatReducedKwh, 0, 1000, d.vatReducedKwh),
    vatPower: clampNum(r.vatPower, 0, 30, d.vatPower),
    vatCav: clampNum(r.vatCav, 0, 30, d.vatCav),
    billingDay: Math.round(clampNum(r.billingDay, 1, 28, d.billingDay)),
    confirmed: r.confirmed === true,
  };
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Whether instant `t` is in vazio (local wall clock). */
export function isVazio(t: number, tariff: Pick<Tariff, 'vazioFrom' | 'vazioTo'>): boolean {
  const m = lisbonMinutes(t);
  const from = minutesOf(tariff.vazioFrom);
  const to = minutesOf(tariff.vazioTo);
  return from <= to ? m >= from && m < to : m >= from || m < to;
}

// --- Summing ---------------------------------------------------------------------------

export interface EnergySummary {
  /** Wh. */
  total: EnergyFlows;
  vazio: EnergyFlows;
  fora: EnergyFlows;
  /** Seconds with readings, and seconds the period has had so far (to `now`). */
  coveredSec: number;
  expectedSec: number;
  /** Stretches with no data of at least an hour, for the page to name. */
  gaps: Array<{ from: number; to: number }>;
}

/**
 * Sum the slots of `days` that start in [from, to). Slots after `now` count as
 * future, not as missing.
 */
export function summarize(
  days: EnergyDay[],
  tariff: Pick<Tariff, 'vazioFrom' | 'vazioTo'>,
  range: { from: number; to: number; now: number },
): EnergySummary {
  const out: EnergySummary = { total: zeroFlows(), vazio: zeroFlows(), fora: zeroFlows(), coveredSec: 0, expectedSec: 0, gaps: [] };
  const end = Math.min(range.to, range.now);
  let gapFrom: number | null = null;
  const closeGap = (at: number) => {
    if (gapFrom !== null && at - gapFrom >= HOUR) out.gaps.push({ from: gapFrom, to: at });
    gapFrom = null;
  };
  for (const day of [...days].sort((a, b) => a.start - b.start)) {
    day.slots.forEach((slot, i) => {
      const t = day.start + i * SLOT_MS;
      if (t < range.from || t >= end) return;
      // The slot in progress only counts for the part of it that has happened.
      out.expectedSec += Math.min(SLOT_SEC, (end - t) / 1000);
      if (!slot || slot.sec <= 0) {
        gapFrom ??= t;
        return;
      }
      closeGap(t);
      out.coveredSec += slot.sec;
      addFlows(out.total, slot);
      addFlows(isVazio(t, tariff) ? out.vazio : out.fora, slot);
    });
  }
  if (gapFrom !== null) closeGap(end);
  return out;
}

// --- Billing ----------------------------------------------------------------------------

export interface BillInput {
  /** kWh bought, by period. */
  kwhVazio: number;
  kwhFora: number;
  /** kWh sent to the grid (paid only if the tariff has an export price). */
  kwhExport: number;
  /** Days billed (may be fractional: a period so far). */
  days: number;
}

export interface BillLine {
  key: 'fora' | 'vazio' | 'power' | 'iec' | 'cav' | 'dgeg';
  label: string;
  /** e.g. '412,3 kWh × 0,2000 €'. */
  detail: string;
  /** €, sem IVA. */
  net: number;
}

export interface Bill {
  lines: BillLine[];
  /** € sem IVA. */
  net: number;
  /** IVA by rate: base and tax, €. */
  vat: Array<{ rate: number; base: number; tax: number }>;
  vatTotal: number;
  /** € paid for what was sent to the grid (not taxed); 0 without an export price. */
  exportCredit: number;
  /** € to pay: net + VAT − export credit. */
  total: number;
}

const DAYS_PER_MONTH = 365 / 12;
const r2 = (v: number) => Math.round(v * 100) / 100;
const fmt = (v: number, d: number) => v.toFixed(d).replace('.', ',');

/**
 * A Portuguese residential bill for the energy bought in a period. The
 * monthly charges (CAV, DGEG) are spread per day, the way suppliers prorate a
 * period that isn't a whole month; the reduced-VAT kWh likewise (per 30 days).
 * Amounts are rounded to the cent per line, as a bill is.
 */
export function computeBill(input: BillInput, tariff: Tariff): Bill {
  const days = Math.max(0, input.days);
  const kv = Math.max(0, input.kwhVazio);
  const kf = Math.max(0, input.kwhFora);
  const kwh = kv + kf;
  const months = days / DAYS_PER_MONTH;
  const lines: BillLine[] = [
    { key: 'fora', label: 'Energia fora de vazio', detail: `${fmt(kf, 1)} kWh × ${fmt(tariff.priceForaVazio, 4)} €`, net: r2(kf * tariff.priceForaVazio) },
    { key: 'vazio', label: 'Energia em vazio', detail: `${fmt(kv, 1)} kWh × ${fmt(tariff.priceVazio, 4)} €`, net: r2(kv * tariff.priceVazio) },
    { key: 'power', label: `Potência contratada (${fmt(tariff.powerKva, 2)} kVA)`, detail: `${fmt(days, 1)} dias × ${fmt(tariff.powerPerDay, 4)} €`, net: r2(days * tariff.powerPerDay) },
    { key: 'iec', label: 'Imposto especial de consumo', detail: `${fmt(kwh, 1)} kWh × ${fmt(tariff.iecPerKwh, 4)} €`, net: r2(kwh * tariff.iecPerKwh) },
    { key: 'cav', label: 'Contribuição audiovisual', detail: `${fmt(tariff.cavPerMonth, 2)} €/mês`, net: r2(months * tariff.cavPerMonth) },
    { key: 'dgeg', label: 'Taxa de exploração DGEG', detail: `${fmt(tariff.dgegPerMonth, 2)} €/mês`, net: r2(months * tariff.dgegPerMonth) },
  ];
  const energyNet = lines[0].net + lines[1].net;
  // The reduced rate covers the first kWh of the period, priced at the period's average.
  const reducedKwh = Math.min(kwh, (tariff.vatReducedKwh * days) / 30);
  const reducedBase = kwh > 0 ? r2((energyNet * reducedKwh) / kwh) : 0;
  const bases = new Map<number, number>();
  const add = (rate: number, base: number) => bases.set(rate, (bases.get(rate) ?? 0) + base);
  add(tariff.vatReduced, reducedBase);
  add(tariff.vatStandard, energyNet - reducedBase);
  add(tariff.vatPower, lines[2].net);
  add(tariff.vatStandard, lines[3].net + lines[5].net);
  add(tariff.vatCav, lines[4].net);
  const vat = [...bases]
    .filter(([, base]) => base > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([rate, base]) => ({ rate, base: r2(base), tax: r2((base * rate) / 100) }));
  const net = r2(lines.reduce((s, l) => s + l.net, 0));
  const vatTotal = r2(vat.reduce((s, v) => s + v.tax, 0));
  const exportCredit = r2(Math.max(0, input.kwhExport) * tariff.exportPrice);
  return { lines, net, vat, vatTotal, exportCredit, total: r2(net + vatTotal - exportCredit) };
}

export interface Scenarios {
  /** What was paid: the energy actually bought (minus any export payment). */
  actual: Bill;
  /** Every kWh the house used bought from the grid, at the price of its hour. */
  withoutSystem: Bill;
  /** Panels, no battery: what the panels covered as it was produced, the rest bought, the surplus sent to the grid. */
  pvOnly: Bill;
  /** withoutSystem − actual. */
  saving: number;
  /** withoutSystem − pvOnly: solar used as it was produced (plus any export payment for its surplus). */
  savingPv: number;
  /** pvOnly − actual: energy stored and used later, less what charging it cost. */
  savingBattery: number;
}

/** The three bills for one period, from its energy summary. */
export function computeScenarios(s: EnergySummary, days: number, tariff: Tariff): Scenarios {
  const kWh = (wh: number) => wh / 1000;
  const actual = computeBill({ kwhVazio: kWh(s.vazio.imp), kwhFora: kWh(s.fora.imp), kwhExport: kWh(s.total.exp), days }, tariff);
  const withoutSystem = computeBill({ kwhVazio: kWh(s.vazio.load), kwhFora: kWh(s.fora.load), kwhExport: 0, days }, tariff);
  // Without the battery, what it supplied is bought instead, and the PV it took goes to the grid.
  const d = derivedFlows(s.total);
  const pvOnly = computeBill({
    kwhVazio: kWh(s.vazio.load - s.vazio.pvLoad),
    kwhFora: kWh(s.fora.load - s.fora.pvLoad),
    kwhExport: kWh(d.pvGrid + d.pvBat),
    days,
  }, tariff);
  return {
    actual,
    withoutSystem,
    pvOnly,
    saving: r2(withoutSystem.total - actual.total),
    savingPv: r2(withoutSystem.total - pvOnly.total),
    savingBattery: r2(pvOnly.total - actual.total),
  };
}

// --- Billing period and projection ---------------------------------------------------------

/** The billing period containing `date`: [from, to] inclusive, starting on `billingDay`. */
export function billingPeriod(date: string, billingDay: number): { from: string; to: string; days: number } {
  const [y, m, d] = date.split('-').map(Number);
  const startMonth = d >= billingDay ? m - 1 : m - 2;
  const from = new Date(Date.UTC(y, startMonth, billingDay)).toISOString().slice(0, 10);
  const next = new Date(Date.UTC(y, startMonth + 1, billingDay)).toISOString().slice(0, 10);
  return { from, to: addDays(next, -1), days: daysBetween(from, next) };
}

export interface Projection {
  period: { from: string; to: string; days: number };
  /** Days of the period gone by at `now` (fractional). */
  elapsedDays: number;
  /** The period so far, as billed today. */
  soFar: Scenarios;
  /** The whole period: so far plus the recent daily average for the days left. */
  projected: Scenarios;
  /** The energy behind each (Wh). */
  soFarEnergy: EnergySummary;
  projectedEnergy: EnergySummary;
  /** Days of data behind the average (after gaps), 0 = no basis for a projection. */
  basisDays: number;
}

/**
 * The bill for the billing period in progress, and where it is heading. The
 * days left are filled with the daily average of `recent` (normally the last 7
 * whole days), corrected for its gaps: two days with half their readings
 * count as one day of data, not two days of half the energy.
 */
export function projectBill(
  periodDays: EnergyDay[],
  recentDays: EnergyDay[],
  tariff: Tariff,
  now: number,
): Projection {
  const period = billingPeriod(lisbonDate(now), tariff.billingDay);
  const from = dayStart(period.from);
  const to = dayStart(addDays(period.to, 1));
  const elapsedDays = Math.max(0, Math.min(period.days, (now - from) / DAY));
  const so = summarize(periodDays, tariff, { from, to, now });
  const soFar = computeScenarios(so, elapsedDays, tariff);

  const recentFrom = Math.min(...recentDays.map(d => d.start), now);
  const recent = summarize(recentDays, tariff, { from: recentFrom, to: now, now });
  const basisDays = recent.coveredSec / 86_400;
  const remaining = Math.max(0, (to - now) / DAY);
  const scale = basisDays >= 0.5 ? remaining / basisDays : 0;
  const scaled = (f: EnergyFlows, extra: EnergyFlows) => {
    const out = { ...f };
    for (const k of FLOW_KEYS) out[k] += extra[k] * scale;
    return out;
  };
  const projectedSummary: EnergySummary = {
    ...so,
    total: scaled(so.total, recent.total),
    vazio: scaled(so.vazio, recent.vazio),
    fora: scaled(so.fora, recent.fora),
  };
  return {
    period,
    elapsedDays,
    soFar,
    projected: computeScenarios(projectedSummary, period.days, tariff),
    soFarEnergy: so,
    projectedEnergy: projectedSummary,
    basisDays: scale > 0 ? basisDays : 0,
  };
}

// --- Solar surplus ------------------------------------------------------------------------
// Renato doesn't sell to the grid: what goes there is given away. Most of it is
// the inverter regulating around zero (tens of watts); the part worth pointing
// out is real surplus, above all with the battery full, because that energy
// could have been used in the house instead of bought later.

/** Below this average a slot's export is the inverter regulating, not surplus (W; 25 Wh in a 15-minute slot). */
export const SURPLUS_MIN_W = 100;
const SURPLUS_MIN_WH = SURPLUS_MIN_W * (SLOT_SEC / 3600);
/**
 * From this SoC (%) the battery counts as full. Integer readings, and an LFP
 * battery tapers its charge over the last few percent, so "100" would miss
 * most of the time it's effectively full.
 */
export const BATTERY_FULL_SOC = 97;

/**
 * Whether the battery wasn't taking the surplus: at least BATTERY_FULL_SOC at
 * the end of the slot, or charging less than SURPLUS_MIN_W on average while
 * solar was going to the grid. The second catches a battery whose ceiling is
 * set under 97 %, or one that has stopped charging for any other reason.
 */
export function batteryNotTaking(slot: Pick<EnergySlot, 'soc' | 'chg'>): boolean {
  return (slot.soc !== undefined && slot.soc >= BATTERY_FULL_SOC) || slot.chg < SURPLUS_MIN_WH;
}

/** One slot's solar surplus (Wh of PV to the grid) and whether the battery was full; null below SURPLUS_MIN_W. */
export function slotSurplus(slot: EnergySlot): { wh: number; full: boolean } | null {
  // Solar only: what the battery itself sent to the grid isn't surplus.
  const wh = derivedFlows(slot).pvGrid;
  return wh >= SURPLUS_MIN_WH ? { wh, full: batteryNotTaking(slot) } : null;
}

export interface SurplusSummary {
  /** Wh sent to the grid, all of it (unpaid without an export price). */
  exp: number;
  /** Of which solar surplus: slots averaging at least SURPLUS_MIN_W of PV to the grid. The rest is regulation. */
  surplus: number;
  /** Of the surplus, sent while the battery was full or not taking it. */
  full: number;
  /**
   * € the surplus would have saved had it been used in the house instead of
   * bought, at the price of its hour (energy + IEC, standard VAT), less any
   * export payment. An opportunity, not lost income.
   */
  value: number;
  valueFull: number;
  /** Surplus Wh by local hour of day, 0–23; all, and with the battery full. */
  byHour: number[];
  byHourFull: number[];
  /** Days with readings in the range, for per-day averages. */
  days: number;
  /** Slots with surplus and the battery full, by start (ms) — for the day view. */
  fullSlots: Array<{ t: number; wh: number }>;
}

/** The solar surplus in the slots of `days` that start in [from, to). */
export function surplusOf(
  days: EnergyDay[],
  tariff: Tariff,
  range: { from: number; to: number; now: number },
): SurplusSummary {
  const out: SurplusSummary = {
    exp: 0, surplus: 0, full: 0, value: 0, valueFull: 0,
    byHour: new Array(24).fill(0), byHourFull: new Array(24).fill(0), days: 0, fullSlots: [],
  };
  const vat = 1 + tariff.vatStandard / 100;
  const end = Math.min(range.to, range.now);
  for (const day of days) {
    let seen = false;
    day.slots.forEach((slot, i) => {
      const t = day.start + i * SLOT_MS;
      if (!slot || slot.sec <= 0 || t < range.from || t >= end) return;
      seen = true;
      out.exp += slot.exp;
      const sp = slotSurplus(slot);
      if (!sp) return;
      const pvGrid = sp.wh;
      const price = (isVazio(t, tariff) ? tariff.priceVazio : tariff.priceForaVazio) + tariff.iecPerKwh;
      const worth = (pvGrid / 1000) * Math.max(0, price * vat - tariff.exportPrice);
      const hour = Math.floor(lisbonMinutes(t) / 60);
      out.surplus += pvGrid;
      out.value += worth;
      out.byHour[hour] += pvGrid;
      if (sp.full) {
        out.full += pvGrid;
        out.valueFull += worth;
        out.byHourFull[hour] += pvGrid;
        out.fullSlots.push({ t, wh: pvGrid });
      }
    });
    if (seen) out.days++;
  }
  out.value = r2(out.value);
  out.valueFull = r2(out.valueFull);
  return out;
}

/**
 * The shortest run of whole hours holding at least `share` of `byHour`'s total
 * — "the surplus is mostly between 12:00 and 15:00". [from, to) in hours;
 * null when there is nothing.
 */
export function surplusWindow(byHour: number[], share = 0.75): { from: number; to: number; share: number } | null {
  const total = byHour.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let best: { from: number; to: number; sum: number } | null = null;
  for (let from = 0; from < 24; from++) {
    let sum = 0;
    for (let to = from + 1; to <= 24; to++) {
      sum += byHour[to - 1];
      if (sum >= share * total) {
        const len = to - from;
        if (!best || len < best.to - best.from || (len === best.to - best.from && sum > best.sum)) best = { from, to, sum };
        break;
      }
    }
  }
  return best && { from: best.from, to: best.to, share: best.sum / total };
}
