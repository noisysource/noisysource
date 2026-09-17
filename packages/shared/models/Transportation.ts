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
  vatRate: number;
  // Discounts (fractions 0–1)
  multiTripDiscountPercentage: number;
  minTripsForDiscount: number;
  siblingDiscountPercentage: number;
  returningStudentDiscountPercentage: number;
  schoolDiscounts: SchoolDiscount[];
  // Operations (planner cost model)
  driverRatePerHour: number;
  weeksPerMonth: number;
  vanCapacity: number;
  vanMonthlyCost: number;
  consumptionPer100km: number;
  electricityPricePerKwh: number;
  driverMonthlyCostOverride?: number; // manual override shown in financial summary
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
