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
export type SubscriptionStatus = 'active' | 'inactive' | 'cancelled' | 'pending' | 'planned' | 'offered';

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

  // Set when an admin edits a subscription already linked to a family/child — the
  // parent must confirm/edit/reject before it's considered reviewed.
  needsClientReview?: boolean;
  clientReviewedAt?: Date;
  clientReviewRejected?: boolean;
  clientReviewRejectedAt?: Date;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
}
