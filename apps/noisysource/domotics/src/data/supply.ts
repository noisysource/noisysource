import type { EnergyReading } from './energy';

/**
 * The house's grid connection: single-phase, 6.9 kVA contracted (Renato,
 * 26/11/2026). The limiter trips on what comes FROM THE GRID, so whatever the
 * inverter supplies (sun or battery) is headroom on top of it.
 */
export const CONTRACTED_VA = 6900;
const NOMINAL_V = 230;
/** 6.9 kVA at the nominal 230 V: the current the limiter allows. */
export const GRID_LIMIT_A = CONTRACTED_VA / NOMINAL_V;

export type SupplyTone = 'ok' | 'warn' | 'high';

export interface SupplyNow {
  /** Current drawn from the grid now; 0 while exporting or idle. */
  gridA: number;
  /** The whole house's current, whoever supplies it. */
  houseA?: number;
  /** gridA as a share of the limit, 0–1 (can exceed 1 briefly). */
  share: number;
  tone: SupplyTone;
}

/** Reads the inverter's figures as amps against the contracted limit; undefined when it isn't answering. */
export function supplyNow(r: EnergyReading | null | undefined): SupplyNow | undefined {
  if (!r?.online || r.gridPowerW === undefined) return undefined;
  const v = r.acVoltageV && r.acVoltageV > 150 ? r.acVoltageV : NOMINAL_V;
  // gridPowerW is positive while exporting.
  const gridA = Math.max(0, -r.gridPowerW) / v;
  const houseA = r.consumptionW === undefined ? undefined : Math.max(0, r.consumptionW) / v;
  const share = gridA / GRID_LIMIT_A;
  return { gridA, houseA, share, tone: share >= 0.8 ? 'high' : share >= 0.6 ? 'warn' : 'ok' };
}

export function formatAmps(a: number | undefined): string {
  if (a === undefined || !Number.isFinite(a)) return '—';
  return `${a.toLocaleString('pt-PT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} A`;
}
