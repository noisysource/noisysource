/**
 * Transportation Subscription - linked to Family and Child
 */

export interface SchoolDiscount {
  schoolName: string;
  discountPercentage: number; // 0–1
}

export interface TransportationConfig {
  // Pricing
  flatRatePerTrip: number;
  pricePerTrip: number;  // legacy alias
  /**
   * @deprecated Never used by billing. Transport prices are VAT-inclusive and Vendus applies its
   * Transporte product's rate (6%); pages take it from KIDCLUB_VAT (kidclubVat.ts). Old config
   * docs still carry this field (0.23 on prod and dev); nothing reads it.
   */
  vatRate?: number;
  // Discounts (fractions 0–1)
  multiTripDiscountPercentage: number;
  minTripsForDiscount: number;
  siblingDiscountPercentage: number;
  returningStudentDiscountPercentage: number;
  schoolDiscounts: SchoolDiscount[];
  // Operations (planner cost model) — per-route cost ESTIMATES used only by
  // the Transport Planner while planning, not read by the Financial Summary.
  driverRatePerHour: number;
  weeksPerMonth: number;
  vanCapacity: number;
  consumptionPer100km: number;
  electricityPricePerKwh: number;
  // Fixed monthly costs — direct inputs, edited on the Financial Summary
  // page itself. Deliberately NOT derived from a planned-route snapshot, so
  // the P&L stays correct even if no route has ever been planned/saved.
  /**
   * The vehicles and their fixed monthly costs, edited on the Resumo Financeiro. Absent on
   * docs saved before 2026-11-09: read through vehiclesOf(), never directly.
   */
  vehicles?: TransportVehicle[];
  /** @deprecated Single-van cost from before `vehicles`. Read through vehiclesOf(). */
  vanMonthlyCost?: number;
  /** @deprecated Single-van cost from before `vehicles`. Read through vehiclesOf(). */
  driverMonthlyCost?: number;
  /** @deprecated Single-van cost from before `vehicles`. Read through vehiclesOf(). */
  electricityMonthlyCost?: number;
}

/**
 * One vehicle and its fixed monthly costs, as entered on the Resumo Financeiro. Costs are
 * the euros per month as typed there (no VAT handling, same as the old single-van fields).
 */
export interface TransportVehicle {
  id: string;
  label: string;
  /** Children it carries, driver not counted. For the van from the old fields: `vanCapacity`. */
  seats: number;
  vehicleMonthlyCost: number;
  /** What the driver costs per month, fully loaded. Entered by hand, never derived. */
  driverMonthlyCost: number;
  electricityMonthlyCost: number;
}

/** Id of the vehicle vehiclesOf() builds from the old single-van fields. */
export const LEGACY_VAN_ID = 'van';

/** Seats of the van built from an old doc with no usable `vanCapacity` (the planner's default). */
const LEGACY_VAN_DEFAULT_SEATS = 8;

const nonNegative = (x: unknown): number =>
  typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0;

/**
 * The config's vehicles. A config with no `vehicles` (or an empty list) is one van built
 * from the old fields, so docs from before the list keep their numbers with no migration,
 * and the first save of the list writes that van exactly as it was. Values are sanitised
 * (missing or bad numbers → 0) but never invented, except a van's seats (see above).
 */
export function vehiclesOf(config: Partial<TransportationConfig> | null | undefined): TransportVehicle[] {
  const list = config?.vehicles;
  if (Array.isArray(list) && list.length > 0) {
    return list.map((v, i) => ({
      id: typeof v?.id === 'string' && v.id ? v.id : `vehicle-${i + 1}`,
      label: typeof v?.label === 'string' && v.label.trim() ? v.label : `Viatura ${i + 1}`,
      seats: nonNegative(v?.seats),
      vehicleMonthlyCost: nonNegative(v?.vehicleMonthlyCost),
      driverMonthlyCost: nonNegative(v?.driverMonthlyCost),
      electricityMonthlyCost: nonNegative(v?.electricityMonthlyCost),
    }));
  }
  const capacity = nonNegative(config?.vanCapacity);
  return [{
    id: LEGACY_VAN_ID,
    label: 'Carrinha',
    seats: capacity > 0 ? capacity : LEGACY_VAN_DEFAULT_SEATS,
    vehicleMonthlyCost: nonNegative(config?.vanMonthlyCost),
    driverMonthlyCost: nonNegative(config?.driverMonthlyCost),
    electricityMonthlyCost: nonNegative(config?.electricityMonthlyCost),
  }];
}

export interface Location {
  address: string;
  lat: number;
  lng: number;
}

export interface SubscriptionSchedule {
  dayOfWeek: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
  direction: 'pickup' | 'dropoff' | 'both'; // pickup = home→school (morning), dropoff = school→home (afternoon)
  pickupTime: string; // HH:MM
  pickupLocation: string;
  dropoffLocation: string;
}

// Infer direction from time for legacy records that lack the field
export const inferDirection = (s: Partial<SubscriptionSchedule>): 'pickup' | 'dropoff' | 'both' =>
  s.direction ?? ((s.pickupTime ?? '08:00') >= '12:00' ? 'dropoff' : 'pickup');

import { WeekPattern } from './weekPattern';
export type { WeekPattern };
// Collapsed to 3 states (pending / active / cancelled) — legacy Firestore docs
// may still hold "planned"/"offered"/"inactive"; normalizeSubStatus() in the
// app's lib/utils.ts maps them so every consumer only ever sees these three.
export type SubscriptionStatus = 'active' | 'cancelled' | 'pending';

export interface TransportationSubscription {
  id: string;
  familyId: string; // Required - links to Family
  childId: string; // Required - links to Child

  // Child information (denormalized)
  childName: string;
  childAge: number;

  // Contact information (from family, but can be overridden)
  contactMobile: string;
  contactEmail: string;
  schoolName?: string;

  // Subscription dates
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD

  // Status
  status: SubscriptionStatus;
  
  // Pricing
  monthlyFee: number;
  originalFee?: number;       // fee before returningStudent discount
  returningStudent?: boolean;
  ridesRemaining?: number; // For limited ride subscriptions
  appliedDiscounts?: import('./Discount').AppliedDiscount[];
  /** Admin overrides of automatic discounts, by rule id. See DiscountOverrides. */
  discountOverrides?: import('./Discount').DiscountOverrides;
  
  // Schedule
  weekPattern: WeekPattern;
  schedule: SubscriptionSchedule[]; // Array of scheduled trips

  // Operational tracking only — never gates status. Used to double as the old
  // "planned" status's real meaning ("awaiting route assignment"); now an
  // independent boolean instead of a hidden third status axis.
  routeAssigned?: boolean;

  // Two-way in-app review flags (no email). clientReviewPending: set whenever
  // admin changes this subscription while it's linked to a family — cleared
  // when the client views it. adminReviewPending: set whenever a client-
  // initiated change happens (e.g. a cancel request) — cleared when admin
  // views it. lastClientAction records *what* the client did, so the admin
  // badge can say what to do next instead of one generic "review needed".
  clientReviewPending?: boolean;
  clientReviewedAt?: Date;
  adminReviewPending?: boolean;
  adminReviewedAt?: Date;
  lastClientAction?: 'confirmed' | 'cancelRequested' | 'edited' | 'rejected';

  // Metadata
  createdAt: Date;
  updatedAt: Date;

  // Billing bookkeeping — set once by the billing function itself, never by
  // any client form, when the one-time registration+insurance fee has been
  // billed for this child (on this subscription or their study-room one,
  // whichever came first) — this is what makes a transport-only family pay
  // it too, not just study-room families. Deliberately lives on the
  // subscription, not a Child document, so it resets every school year:
  // next year's enrollment is a fresh subscription doc with no such flag.
  enrollmentFeeBilled?: boolean;
}
