/**
 * Charging sessions, costs, consumption and a battery estimate for the
 * Carros page. Pure: no Firestore, no Tesla. tesla.ts feeds it.
 *
 * Two sources, neither of them complete on its own:
 *   - Tesla's charging history (`/api/1/dx/charging/history`): every
 *     Supercharger (and other Tesla-billed) session, with kWh and the €
 *     Tesla charged. Home charging on the Schuko isn't in it.
 *   - Our own readings: one per car data read (never an extra call), with
 *     battery %, range, odometer and the energy added in the current charge.
 *     They give the range at 100% (a battery-health signal) and, when two
 *     land in the same charge, the battery's capacity.
 * So consumption (Wh/km) from these is only honest over stretches where
 * every charge was a Tesla-billed one; it is labelled as such in the app.
 */

export interface ChargingSession {
  id: string;
  vin: string;
  site: string;
  /** ms */
  start: number;
  /** ms; absent while charging */
  end?: number;
  kwh: number;
  /** Total billed: charging + congestion/idle + anything else Tesla charged. */
  cost: number;
  /** Of that, the energy itself. */
  energyCost: number;
  /** Congestion / idle / parking fees. */
  otherFees: number;
  currency: string;
  /** For invoices: GET /api/1/dx/charging/invoice/{id}. */
  invoiceIds: string[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const time = (v: unknown) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/** kWh in one fee line: the base usage plus any tiers, only when it's measured in kWh. */
function feeKwh(fee: Record<string, unknown>): number {
  const uom = String(fee.uom ?? "").toLowerCase();
  if (!uom.includes("kwh")) return 0;
  const tiers = ["usageBase", "usageTier1", "usageTier2", "usageTier3", "usageTier4"].map(k => num(fee[k]));
  const sum = tiers.reduce((a, b) => a + b, 0);
  return sum > 0 ? sum : num(fee.usage);
}

/**
 * Tesla's history answer, as tolerant as it can be: the sessions are in
 * `data` (sometimes under `response`), fees in `fees[]` with `feeType`
 * CHARGING / CONGESTION / PARKING…, and `totalDue` per fee.
 */
export function parseChargingHistory(raw: unknown): ChargingSession[] {
  const r = (raw ?? {}) as Record<string, any>;
  const list: unknown[] = Array.isArray(r.data) ? r.data
    : Array.isArray(r.response?.data) ? r.response.data
    : Array.isArray(r.response) ? r.response
    : Array.isArray(raw) ? (raw as unknown[]) : [];
  const out: ChargingSession[] = [];
  for (const item of list) {
    const s = (item ?? {}) as Record<string, any>;
    const start = time(s.chargeStartDateTime);
    const id = s.sessionId ?? s.id;
    if (start === undefined || id === undefined) continue;
    const fees = (Array.isArray(s.fees) ? s.fees : []) as Array<Record<string, unknown>>;
    let kwh = 0, energyCost = 0, otherFees = 0;
    let currency = "";
    for (const f of fees) {
      const due = num(f.totalDue);
      currency ||= String(f.currencyCode ?? "");
      if (String(f.feeType ?? "").toUpperCase() === "CHARGING") {
        kwh += feeKwh(f);
        energyCost += due;
      } else {
        otherFees += due;
      }
    }
    out.push({
      id: String(id),
      vin: String(s.vin ?? ""),
      site: String(s.siteLocationName ?? s.location ?? "Supercharger"),
      start,
      end: time(s.chargeStopDateTime) ?? time(s.unlatchDateTime),
      kwh: round(kwh, 2),
      cost: round(energyCost + otherFees, 2),
      energyCost: round(energyCost, 2),
      otherFees: round(otherFees, 2),
      currency: currency || "EUR",
      invoiceIds: (Array.isArray(s.invoices) ? s.invoices : [])
        .map((i: Record<string, unknown>) => i?.contentId).filter((x: unknown): x is string => typeof x === "string"),
    });
  }
  return out.sort((a, b) => b.start - a.start);
}

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

export interface MonthTotal {
  /** "YYYY-MM", Lisbon time. */
  month: string;
  sessions: number;
  kwh: number;
  cost: number;
  /** € per kWh over the month, energy and fees together. */
  perKwh?: number;
}

const lisbonMonth = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit" }).format(ms);

export function monthTotals(sessions: ChargingSession[], vin?: string): MonthTotal[] {
  const by = new Map<string, MonthTotal>();
  for (const s of sessions) {
    if (vin && s.vin && s.vin !== vin) continue;
    const m = lisbonMonth(s.start);
    const t = by.get(m) ?? { month: m, sessions: 0, kwh: 0, cost: 0 };
    t.sessions += 1;
    t.kwh += s.kwh;
    t.cost += s.cost;
    by.set(m, t);
  }
  return [...by.values()]
    .map(t => ({ ...t, kwh: round(t.kwh, 1), cost: round(t.cost, 2), perKwh: t.kwh > 0 ? round(t.cost / t.kwh, 3) : undefined }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

/** One of our own readings of a car (saved by teslaVehicles on every data read). */
export interface CarReading {
  vin: string;
  t: number;
  soc?: number;
  rangeKm?: number;
  odometerKm?: number;
  /** charge_energy_added: kWh added so far in the current (or last) charge. */
  energyAddedKwh?: number;
  chargingState?: string;
}

/** Range at 100%, from one reading. Below 20% the projection is too long a stretch to trust. */
export function fullRangeKm(r: Pick<CarReading, "soc" | "rangeKm">): number | undefined {
  if (!r.soc || r.rangeKm === undefined || r.soc < 20) return undefined;
  return Math.round(r.rangeKm / (r.soc / 100));
}

/**
 * The battery's capacity (kWh for 0→100%), from two readings in the same
 * charge: the energy added between them over the % gained. It includes the
 * charging losses (a few % on a Supercharger, more on a Schuko), so it reads
 * a little high; a median over several charges keeps one odd pair out.
 */
export function capacityKwh(readings: CarReading[]): number | undefined {
  const sorted = [...readings].sort((a, b) => a.t - b.t);
  const estimates: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (a.chargingState !== "Charging" || b.chargingState !== "Charging") continue;
    if (b.t - a.t > 3 * 3600_000) continue;
    if (a.soc === undefined || b.soc === undefined || a.energyAddedKwh === undefined || b.energyAddedKwh === undefined) continue;
    const dSoc = b.soc - a.soc;
    const dKwh = b.energyAddedKwh - a.energyAddedKwh;
    // Small steps are mostly rounding (the % is whole numbers).
    if (dSoc < 5 || dKwh <= 0) continue;
    const est = dKwh / (dSoc / 100);
    if (est > 30 && est < 150) estimates.push(est);
  }
  if (estimates.length === 0) return undefined;
  estimates.sort((x, y) => x - y);
  return round(estimates[Math.floor(estimates.length / 2)], 1);
}

/** The odometer closest in time to `at`, within a day: readings are only taken while someone looks. */
function odometerNear(readings: CarReading[], at: number): number | undefined {
  let best: CarReading | undefined;
  for (const r of readings) {
    if (r.odometerKm === undefined) continue;
    if (!best || Math.abs(r.t - at) < Math.abs(best.t - at)) best = r;
  }
  return best && Math.abs(best.t - at) <= 24 * 3600_000 ? best.odometerKm : undefined;
}

export interface Consumption {
  /** Over this stretch (ms). */
  from: number;
  to: number;
  km: number;
  kwh: number;
  whPerKm: number;
  cost: number;
  /** € per 100 km. */
  per100Km: number;
}

/**
 * Consumption between the first and the last charging session that have an
 * odometer reading nearby: the energy put back by the sessions in between
 * (the last one included) over the distance driven. Only valid if every
 * charge in the stretch is in Tesla's history, i.e. no home charging; the app
 * says so.
 */
export function consumption(sessions: ChargingSession[], readings: CarReading[], vin: string): Consumption | undefined {
  const mine = sessions.filter(s => !s.vin || s.vin === vin).sort((a, b) => a.start - b.start);
  const reads = readings.filter(r => r.vin === vin);
  const withOdo = mine.map(s => ({ s, odo: odometerNear(reads, s.start) })).filter(x => x.odo !== undefined);
  if (withOdo.length < 2) return undefined;
  const first = withOdo[0], last = withOdo[withOdo.length - 1];
  const km = (last.odo as number) - (first.odo as number);
  if (km < 50) return undefined;
  const between = mine.filter(s => s.start > first.s.start && s.start <= last.s.start);
  const kwh = between.reduce((a, s) => a + s.kwh, 0);
  const cost = between.reduce((a, s) => a + s.cost, 0);
  if (kwh <= 0) return undefined;
  return {
    from: first.s.start, to: last.s.start, km: Math.round(km), kwh: round(kwh, 1),
    whPerKm: Math.round((kwh * 1000) / km), cost: round(cost, 2), per100Km: round((cost / km) * 100, 2),
  };
}

/** Range at 100% per month (median of the month's readings): the battery's trend. */
export function fullRangeByMonth(readings: CarReading[], vin: string): Array<{ month: string; km: number }> {
  const by = new Map<string, number[]>();
  for (const r of readings) {
    if (r.vin !== vin) continue;
    const f = fullRangeKm(r);
    if (f === undefined) continue;
    const m = lisbonMonth(r.t);
    by.set(m, [...(by.get(m) ?? []), f]);
  }
  return [...by.entries()]
    .map(([month, v]) => { v.sort((a, b) => a - b); return { month, km: v[Math.floor(v.length / 2)] }; })
    .sort((a, b) => a.month.localeCompare(b.month));
}

/** How often the history is fetched from Tesla: it changes only when a car charges somewhere. */
export const CHARGING_MIN_INTERVAL_MS = 6 * 3600_000;
/** A manual refresh still waits this long since the last fetch. */
export const CHARGING_REFRESH_MIN_MS = 15 * 60_000;
/** Pages of 50 fetched at most per refresh: 200 sessions. */
export const CHARGING_MAX_PAGES = 4;
export const CHARGING_PAGE_SIZE = 50;
/** How far back a first fetch reaches. */
export const CHARGING_LOOKBACK_DAYS = 365;
