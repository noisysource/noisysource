/**
 * Camp Models
 */

export interface Camp {
    id: string;
    name: string;
    type: 'october' | 'christmas' | 'easter' | 'summer' | 'other';
    startDate: string;   // YYYY-MM-DD
    endDate: string;     // YYYY-MM-DD
    description?: string;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export interface CampSubscription {
    id: string;
    campId: string;
    familyId: string;
    userId: string;
    childName: string;
    childAge?: number;
    parentName: string;
    parentEmail: string;
    parentPhone?: string;
    subscriptionType: 'day' | 'week' | 'full';
    selectedDays: string[];       // campDay document IDs
    totalAmount: number;
    depositAmount: number;
    balanceAmount: number;
    /**
     * pending: seats held while the deposit is unpaid, until holdExpiresAt.
     * confirmed: deposit paid (or confirmed by an admin). waitlisted: a day was
     * full at sign-up, or the deposit wasn't paid in time; holds no seat.
     */
    status: 'pending' | 'confirmed' | 'waitlisted' | 'cancelled';
    statusReason?: string;
    /** Firestore Timestamp. Missing on sign-ups made before holds existed. */
    holdExpiresAt?: any;
    waitlistReason?: 'full' | 'unpaid';
    /** A late payment confirmed it although a day was already full. */
    overCapacity?: boolean;
    depositBillingId?: string;
    balanceBillingId?: string;
    depositRefundPending?: boolean;
    notes?: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface CampDay {
    id: string;
    campId?: string;
    date: string; // YYYY-MM-DD
    name: string; // e.g., "Arco-Íris de Natal"

    // Activities
    morning: string;
    lunch: string;
    afternoon: string;

    // Capacity & Pricing
    capacity: number; // Max number of kids
    price: number; // Price per child

    // Status
    active: boolean; // Whether signups are open

    // Metadata
    createdAt: Date;
    updatedAt: Date;
}

export interface CampBooking {
    id: string;

    // Child information
    childName: string;
    childAge: number;
    childDateOfBirth?: string; // Optional for age verification

    // Parent/Guardian information
    parentName: string;
    email: string;
    phone: string;

    // Booking details
    selectedDays: string[]; // Array of CampDay IDs or dates
    totalPrice: number;

    // Optional: Link to family if user is logged in
    familyId?: string;
    childId?: string;

    // Status
    status: 'pending' | 'confirmed' | 'cancelled';
    statusReason?: string;

    // Special notes
    notes?: string; // Dietary restrictions, allergies, etc.

    // Metadata
    createdAt: Date;
    updatedAt: Date;
}

export interface CampConfig {
    // Camp-wide settings
    name: string; // "Actividades de natal 2025"
    startDate: string; // YYYY-MM-DD
    endDate: string; // YYYY-MM-DD
    description?: string;

    // Pricing options
    wholeWeekDiscount?: number; // Percentage discount for booking all days
    earlyBirdDiscount?: number; // Percentage discount if booked before date
    earlyBirdDeadline?: string; // YYYY-MM-DD

    // Contact info for camp
    contactEmail?: string;
    contactPhone?: string;

    // Terms & conditions
    termsAndConditions?: string;

    // Metadata
    updatedAt: Date;
}

