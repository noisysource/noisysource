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
