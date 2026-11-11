// Transport fixed costs per vehicle, for the Resumo Financeiro. Pure: no Firestore, no React.
// The config's vehicles always come through vehiclesOf(), so an old single-van doc costs
// exactly what it did before the list existed.
import { TransportationConfig, TransportVehicle, vehiclesOf } from '@shared/models/Transportation';

export interface VehicleCost {
  vehicle: TransportVehicle;
  vehicleCost: number;
  driverCost: number;
  electricityCost: number;
  total: number;
}

export interface TransportCosts {
  perVehicle: VehicleCost[];
  vehicleCost: number;
  driverCost: number;
  electricityCost: number;
  /** Sum of every vehicle's three costs × months: the transport cost in the P&L. */
  total: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** Every vehicle's fixed monthly costs × the months in scope, and their sums. */
export function transportCosts(
  config: Partial<TransportationConfig> | null | undefined,
  months: number,
): TransportCosts {
  const m = Number.isFinite(months) && months > 0 ? months : 0;
  const perVehicle = vehiclesOf(config).map(vehicle => {
    const vehicleCost = cents(vehicle.vehicleMonthlyCost * m);
    const driverCost = cents(vehicle.driverMonthlyCost * m);
    const electricityCost = cents(vehicle.electricityMonthlyCost * m);
    return { vehicle, vehicleCost, driverCost, electricityCost, total: cents(vehicleCost + driverCost + electricityCost) };
  });
  const sum = (pick: (c: VehicleCost) => number) => cents(perVehicle.reduce((n, c) => n + pick(c), 0));
  return {
    perVehicle,
    vehicleCost: sum(c => c.vehicleCost),
    driverCost: sum(c => c.driverCost),
    electricityCost: sum(c => c.electricityCost),
    total: sum(c => c.total),
  };
}

// ── Editing the list ────────────────────────────────────────────────────────

export type VehicleNumberField = 'seats' | 'vehicleMonthlyCost' | 'driverMonthlyCost' | 'electricityMonthlyCost';
export type VehicleField = 'label' | VehicleNumberField;

/**
 * What an input's text saves as: a trimmed non-empty label, or a number ≥ 0 (blank → 0, as
 * the old cost inputs did; seats must be whole). null = invalid, keep the stored value.
 */
export function parseVehicleField(field: VehicleField, raw: string): string | number | null {
  const text = raw.trim();
  if (field === 'label') return text === '' ? null : text;
  if (text === '') return 0;
  const n = Number(text.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  if (field === 'seats' && !Number.isInteger(n)) return null;
  return n;
}

/** The list with one field of one vehicle replaced. Unknown id → the list unchanged. */
export function updateVehicle(
  vehicles: TransportVehicle[],
  id: string,
  field: VehicleField,
  value: string | number,
): TransportVehicle[] {
  return vehicles.map(v => (v.id === id ? { ...v, [field]: value } : v));
}

/** The list with a new vehicle at the end: costs and seats 0, until they're typed in. */
export function addVehicle(vehicles: TransportVehicle[], newId: string): TransportVehicle[] {
  let id = newId;
  for (let n = 2; vehicles.some(v => v.id === id); n++) id = `${newId}-${n}`;
  return [...vehicles, {
    id,
    label: `Viatura ${vehicles.length + 1}`,
    seats: 0,
    vehicleMonthlyCost: 0,
    driverMonthlyCost: 0,
    electricityMonthlyCost: 0,
  }];
}

/**
 * The list without that vehicle. The last one can't be removed: an empty list would make
 * vehiclesOf() fall back to the old single-van fields and bring the old van back.
 */
export function removeVehicle(vehicles: TransportVehicle[], id: string): TransportVehicle[] {
  if (vehicles.length <= 1) return vehicles;
  return vehicles.filter(v => v.id !== id);
}

// ── Hint for a driver paid by the hour ──────────────────────────────────────

/** The new (Model X) driver's pay, Renato 2026-11-09. Only used by the hint, never stored. */
export const HOURLY_DRIVER_RATE = 6;
/** Weeks per month in the hint, fixed on purpose (not the planner's `weeksPerMonth`). */
export const HINT_WEEKS_PER_MONTH = 4.33;

/** Hours a week × €6 × 4.33. null when the hours aren't a number ≥ 0. */
export function hourlyDriverMonthlyCost(hoursPerWeekRaw: string): number | null {
  const text = hoursPerWeekRaw.trim();
  if (text === '') return null;
  const h = Number(text.replace(',', '.'));
  if (!Number.isFinite(h) || h < 0) return null;
  return cents(h * HOURLY_DRIVER_RATE * HINT_WEEKS_PER_MONTH);
}
