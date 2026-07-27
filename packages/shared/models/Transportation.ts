/**
 * Transportation Subscription - linked to Family and Child
 */

export interface TransportationConfig {
  flatRatePerTrip: number;
  pricePerTrip: number;
  vatRate: number;
  multiTripDiscountPercentage: number;
  minTripsForDiscount: number;
}

export interface Location {
  address: string;
  lat: number;
  lng: number;
}

export interface SubscriptionSchedule {
  dayOfWeek: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
  pickupTime: string; // HH:MM
  pickupLocation: string;
  dropoffLocation: string;
}

export type SubscriptionStatus = 'active' | 'inactive' | 'cancelled' | 'pending';

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

  // Subscription dates
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD

  // Status
  status: SubscriptionStatus;
  
  // Pricing
  monthlyFee: number;
  ridesRemaining?: number; // For limited ride subscriptions
  
  // Schedule
  schedule: SubscriptionSchedule[]; // Array of scheduled trips
  
  // Metadata
  createdAt: Date;
  updatedAt: Date;
}
