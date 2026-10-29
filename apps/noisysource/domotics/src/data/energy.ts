/**
 * Live figures from the photovoltaic system, as served by the bridge.
 *
 * Mirrors the bridge's InverterReading. Kept as its own type rather than
 * imported, because the bridge is a separate deployable that will not always be
 * on the same version as the app — a shared type would imply a coupling that
 * the HTTP boundary does not actually have.
 */
export interface EnergyReading {
  online: boolean;
  acVoltageV?: number;
  /** Whole house. Derived by the inverter's own arithmetic, not a register. */
  consumptionW?: number;
  /** A real but partial load measurement, ~25% below the house total. */
  subLoadW?: number;
  pvPowerW?: number;
  pvStrings?: Array<{ voltageV: number; currentA: number; powerW: number }>;
  /** Negative while discharging. */
  batteryPowerW?: number;
  /** Positive while exporting. */
  gridPowerW?: number;
  soc?: number;
  readAt: number;
}

export type FlowDirection = 'idle' | 'in' | 'out';

/**
 * Which way the battery and grid are actually moving power.
 *
 * A small dead band because these hover around zero constantly — without it the
 * display flickers between "importing" and "exporting" on noise, which reads as
 * a fault rather than a system doing nothing much.
 */
const DEAD_BAND_W = 25;

export function batteryFlow(reading: EnergyReading): FlowDirection {
  const w = reading.batteryPowerW;
  if (w === undefined || Math.abs(w) < DEAD_BAND_W) return 'idle';
  return w > 0 ? 'in' : 'out';
}

export function gridFlow(reading: EnergyReading): FlowDirection {
  const w = reading.gridPowerW;
  if (w === undefined || Math.abs(w) < DEAD_BAND_W) return 'idle';
  return w > 0 ? 'out' : 'in';
}

/**
 * Solar going to the grid right now because the battery can't take it — the
 * same rule as the Energia page's history (packages/shared/lib/energyBill.ts):
 * at least 100 W out, the panels producing, and the battery full (SoC ≥ 97 %)
 * or not charging. Unpaid: Renato has no selling contract, so this is energy
 * worth using in the house. Undefined when it isn't happening.
 */
// The same thresholds as the history's (BATTERY_FULL_SOC, SURPLUS_MIN_W in
// packages/shared/lib/energyBill.ts), copied rather than imported: importing
// them pulls that whole module into the main bundle. functions/src/domotics/
// energyBill.test.ts fails if they drift apart.
const SURPLUS_MIN_W = 100;
const BATTERY_FULL_SOC = 97;

export function liveSurplus(reading: EnergyReading): { exportW: number; full: boolean } | undefined {
  if (!reading.online) return undefined;
  const exportW = reading.gridPowerW ?? 0;
  const pv = reading.pvPowerW ?? 0;
  const battery = reading.batteryPowerW ?? 0;
  // A discharging battery sending power out isn't solar surplus.
  if (exportW < SURPLUS_MIN_W || pv < SURPLUS_MIN_W || battery < -DEAD_BAND_W) return undefined;
  const full = (reading.soc ?? 0) >= BATTERY_FULL_SOC;
  if (!full && battery >= SURPLUS_MIN_W) return undefined;
  return { exportW: Math.min(exportW, pv), full };
}

/** Share of consumption currently coming from the sun, 0–1. */
export function solarShare(reading: EnergyReading): number | undefined {
  const { pvPowerW, consumptionW } = reading;
  if (pvPowerW === undefined || !consumptionW) return undefined;
  return Math.max(0, Math.min(1, pvPowerW / consumptionW));
}

/** Watts read better as kW past a thousand, and nobody needs milliwatts. */
export function formatWatts(w: number | undefined): string {
  if (w === undefined) return '—';
  const abs = Math.abs(w);
  if (abs >= 1000) return `${(w / 1000).toFixed(2)} kW`;
  return `${Math.round(w)} W`;
}
