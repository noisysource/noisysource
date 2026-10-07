/**
 * Represents a child/student that belongs to a family
 * Children can have multiple subscriptions (study room, transport, etc.)
 */
export interface Child {
  id: string;
  familyId: string; // Required - links to Family
  
  // Child information
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  age?: number; // Calculated field, can be computed from dateOfBirth
  
  // School information
  schoolName?: string;
  schoolYear?: string;
  schoolGrade?: string;

  // LEGACY — no longer collected or written (decision 2026-10-01): it duplicated
  // Family.billingAddress, insurance doesn't need it, and transport uses per-trip
  // pickup/dropoff locations. Kept optional only so existing docs still type-check.
  homeAddress?: {
    street: string;
    city: string;
    postalCode: string;
    country?: string;
  };
  // Set when homeAddress was backfilled from the family's billing address rather
  // than provided/confirmed directly for this child — a reasonable default, not a
  // guarantee the child actually lives there. Cleared once someone confirms/edits
  // the address directly (see the missing-child-details export/import).
  homeAddressSource?: 'family_billing_address';

  // Contact information (if different from family)
  contactPhone?: string;
  contactEmail?: string;
  
  // Medical/Allergy notes (optional, for safety)
  medicalNotes?: string;
  allergies?: string[];
  
  // Status
  status: 'active' | 'inactive' | 'graduated';
  
  // Metadata
  createdAt: Date;
  updatedAt: Date;
  notes?: string;
}
