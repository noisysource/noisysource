/**
 * Christmas Camp Models
 */

export interface CampDay {
    id: string;
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

